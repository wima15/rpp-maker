// =========================================================
// EDGE FUNCTION: gemini-proxy  (project Supabase RPM / tujuan)
// Nama function TETAP "gemini-proxy" supaya index.html tidak perlu diubah alamatnya,
// tetapi sekarang meneruskan permintaan ke OPENROUTER (https://openrouter.ai).
// Browser tetap mengirim bentuk Gemini (contents, generationConfig); function ini mengubahnya
// ke format OpenAI/OpenRouter lalu mengubah jawabannya kembali ke bentuk Gemini.
//
// Secret (Edge Functions > Secrets):
//   OPENROUTER_API_KEY_1, OPENROUTER_API_KEY_2, ... _20  = satu secret per key (disarankan)
//   OPENROUTER_API_KEYS  = (opsional) beberapa key dipisah koma
//   OPENROUTER_API_KEY   = (opsional) satu key
//   OPENROUTER_REFERER   = (opsional) alamat situs Anda, untuk statistik di OpenRouter
//   ALLOWED_ORIGINS      = (disarankan) alamat situs yang boleh memanggil, pisah koma
//
// Permintaan: { action:"info" } | { model, contents, generationConfig, keySlot?, stream?, uji? }
// Respons: bentuk Gemini (candidates[0].content.parts[].text, finishReason). Header x-key-used = nomor key.
// Model: ID OpenRouter berbentuk penyedia/model, mis. google/gemini-2.5-flash. Daftar diatur admin
// (Portal Admin > Model AI), server memeriksa ulang setiap permintaan (lihat bagian cfg di bawah).
// =========================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Penyedia AI: isi AI_BASE_URL untuk memakai RelayRouter (atau gateway OpenAI-compatible lain),
// mis. https://www.relayrouter.app/v1  (cek alamat persisnya di dokumentasi/console RelayRouter).
// Kosong = tetap OpenRouter. Key dibaca dari RELAYROUTER_API_KEY_1.._20 lebih dulu, lalu OPENROUTER_API_KEY_*.
const BASE = (Deno.env.get("AI_BASE_URL") ?? "").trim().replace(/\/+$/, "");
const fromEnv = (pref: string) => Array.from({ length: 20 }, (_, i) => Deno.env.get(`${pref}_${i + 1}`) ?? "");
const numbered = [...fromEnv("RELAYROUTER_API_KEY"), ...fromEnv("OPENROUTER_API_KEY")];
const API_KEYS = [...new Set(
  [...numbered, ...`${Deno.env.get("RELAYROUTER_API_KEYS") ?? ""},${Deno.env.get("RELAYROUTER_API_KEY") ?? ""},${Deno.env.get("OPENROUTER_API_KEYS") ?? ""},${Deno.env.get("OPENROUTER_API_KEY") ?? ""}`.split(",")]
    .map((k) => k.replace(/["'\s]/g, "")).filter(Boolean),
)];
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
const REFERER = (Deno.env.get("OPENROUTER_REFERER") ?? "").trim();
const OR_URL = (BASE || "https://openrouter.ai/api/v1") + "/chat/completions";

const MAX_BODY_BYTES = 300_000;
const MAX_OUTPUT_TOKENS = 16384;
const BATAS_TOTAL_MS = 120_000;   // Supabase mematikan fungsi di 150 dtk (kode 546)
const LIMIT_PER_MENIT = 60;

function corsFor(origin: string | null) {
  const allow = ALLOWED_ORIGINS.length ? (origin ?? "") : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-key-used, x-provider, x-model-used",
  };
}
function out(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsFor(origin) } });
}
const gagal = (msg: string, status: number, origin: string | null) => out({ error: { message: msg } }, status, origin);

// ---- rotasi key ----
let giliran = 0;
const istirahat = new Map<number, number>();
function urutanKey() {
  const n = API_KEYS.length, now = Date.now(), mulai = giliran++ % n;
  const semua = Array.from({ length: n }, (_, i) => (mulai + i) % n);
  return [...semua.filter((i) => (istirahat.get(i) ?? 0) <= now), ...semua.filter((i) => (istirahat.get(i) ?? 0) > now)];
}
// kegagalan milik key: 401 (key salah), 402 (saldo/kredit habis), 403, 429 (batas laju)
const gagalKarenaKey = (s: number) => s === 401 || s === 402 || s === 403 || s === 429;
function pesanDari(teks: string) {
  try { const e = JSON.parse(teks)?.error; return String(e?.message ?? teks).slice(0, 200); } catch { return teks.slice(0, 200); }
}

// ---- Gemini -> OpenRouter ----
type Part = Record<string, unknown>;
function keMessages(contents: unknown) {
  const msgs: { role: string; content: unknown }[] = [];
  for (const c of contents as Array<{ role?: string; parts?: Part[] }>) {
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    const isi: unknown[] = [];
    for (const p of parts) {
      if (typeof p?.text === "string") isi.push({ type: "text", text: p.text });
      else if (p?.inlineData) {
        const d = p.inlineData as { mimeType?: string; data?: string };
        const url = `data:${d.mimeType ?? "application/octet-stream"};base64,${d.data ?? ""}`;
        isi.push(String(d.mimeType).startsWith("image/")
          ? { type: "image_url", image_url: { url } }
          : { type: "file", file: { filename: "berkas", file_data: url } });
      }
    }
    if (!isi.length) continue;
    const teksSaja = isi.every((x) => (x as { type: string }).type === "text");
    msgs.push({ role: c?.role === "model" ? "assistant" : "user",
      content: teksSaja ? isi.map((x) => (x as { text: string }).text).join("") : isi });
  }
  return msgs;
}
const akhiranGemini = (f: unknown) => f === "length" ? "MAX_TOKENS" : f === "content_filter" ? "SAFETY" : "STOP";

// aliran SSE OpenRouter -> aliran SSE berbentuk Gemini (dibaca readStream di browser)
function sseKeGemini(src: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const proses = (blk: string, c: TransformStreamDefaultController<Uint8Array>) => {
    const m = blk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!m || m === "[DONE]") return;   // baris ": OPENROUTER PROCESSING" bukan data, terlewati
    let o: { error?: { message?: string }; choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
    try { o = JSON.parse(m); } catch { return; }
    if (o.error) { c.enqueue(enc.encode(`data: ${JSON.stringify({ error: { message: o.error.message ?? "Kesalahan dari OpenRouter." } })}\r\n\r\n`)); return; }
    const ch = o?.choices?.[0];
    if (!ch) return;
    const t = ch.delta?.content ?? "", f = ch.finish_reason ? akhiranGemini(ch.finish_reason) : "";
    if (!t && !f) return;
    const cand: Record<string, unknown> = { content: { role: "model", parts: [{ text: t }] } };
    if (f) cand.finishReason = f;
    c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [cand] })}\r\n\r\n`));
  };
  return src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) { buf += dec.decode(chunk, { stream: true }); const p = buf.split(/\r?\n\r?\n/); buf = p.pop() ?? ""; p.forEach((x) => proses(x, c)); },
    flush(c) { buf += dec.decode(); if (buf.trim()) proses(buf, c); },
  }));
}

// ---- daftar model yang diizinkan ----
const MODEL_RE = /^(?:[a-z0-9][a-z0-9._\-]*\/)?[a-z0-9][a-z0-9._:\-]{0,80}$/;   // nama model: gpt-4.1-mini (OpenAI/RelayRouter) atau penyedia/model (OpenRouter)
// Daftar bawaan: dipakai bila pengaturan admin belum ada / tidak valid. Harus sama dengan MODEL_SEED di index.html.
const CFG_BAWAAN = {
  default: "google/gemini-2.5-flash",
  ids: ["google/gemini-2.5-flash", "google/gemini-2.5-pro", "openai/gpt-oss-120b", "openrouter/auto"],
};
type CfgModel = { default: string; ids: string[] };

// Mengembalikan null bila bentuknya tidak valid atau default-nya tidak ada di antara model yang aktif.
function bersihkanCfg(raw: unknown): CfgModel | null {
  const o = raw as { default?: unknown; models?: unknown } | null;
  if (!o || !Array.isArray(o.models)) return null;
  const ids: string[] = [];
  for (const m of o.models as Array<Record<string, unknown>>) {
    const id = String(m?.id ?? "").trim().toLowerCase();
    if (!MODEL_RE.test(id) || m?.aktif === false || ids.includes(id)) continue;
    ids.push(id);
  }
  const def = String(o.default ?? "").trim().toLowerCase();
  if (!ids.length || !ids.includes(def)) return null;
  return { default: def, ids };
}

let cfgCache: { exp: number; cfg: CfgModel } | null = null;
async function muatCfgModel(apikey: string, tok: string): Promise<CfgModel> {
  const now = Date.now();
  if (cfgCache && cfgCache.exp > now) return cfgCache.cfg;
  try {
    // dibaca dengan sesi guru sendiri; RLS pengaturan_rpm mengizinkan baca untuk yang login
    const r = await fetch(`${SUPABASE_URL}/rest/v1/pengaturan_rpm?kunci=eq.model_ai&select=nilai&limit=1`, {
      headers: { apikey, Authorization: `Bearer ${tok}` },
    });
    if (r.ok) {
      const rows = await r.json();
      const cfg = bersihkanCfg(Array.isArray(rows) ? rows[0]?.nilai : null) ?? CFG_BAWAAN;
      cfgCache = { exp: now + 5 * 60_000, cfg };   // 5 menit: hemat pembacaan pengaturan_rpm
      return cfg;
    }
  } catch { /* jatuh ke cadangan di bawah */ }
  return cfgCache?.cfg ?? CFG_BAWAAN;
}

// ---- cek sesi login ----
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
type Sesi = { admin: boolean; tok: string; apikey: string };
const sesiOk = new Map<string, { exp: number; admin: boolean }>(); // token -> cache
async function sesiSah(req: Request): Promise<Sesi | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get("Authorization") ?? "");
  if (!m) return null;
  const tok = m[1].trim(), now = Date.now();
  const apikey = req.headers.get("apikey") || SUPABASE_ANON;
  const c = sesiOk.get(tok);
  if (c && c.exp > now) return { admin: c.admin, tok, apikey };
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey, Authorization: `Bearer ${tok}` } });
    if (!r.ok) return null;
    const u = await r.json();
    // app_metadata hanya bisa diubah server, jadi aman dipercaya (sama dengan public.is_admin() di SQL)
    const admin = u?.app_metadata?.is_admin === true;
    sesiOk.set(tok, { exp: now + 5 * 60_000, admin });   // 5 menit: hemat satu panggilan Auth per permintaan
    if (sesiOk.size > 2000) sesiOk.clear();
    return { admin, tok, apikey };
  } catch { return null; }
}

// pembatas sederhana per instance (cukup untuk menahan penyalahgunaan ringan)
const hits = new Map<string, number[]>();
function kebanyakan(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > LIMIT_PER_MENIT;
}

Deno.serve(async (req: Request) => {
  const t0 = Date.now();
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(origin) });
  if (req.method !== "POST") return gagal("Method not allowed", 405, origin);
  if (!API_KEYS.length) return gagal("Secret OPENROUTER_API_KEY_1 (dst) belum diset di Edge Functions.", 500, origin);
  if (ALLOWED_ORIGINS.length && !(origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, "")))) return gagal("Asal permintaan tidak diizinkan.", 403, origin);

  const sesi = await sesiSah(req);
  if (!sesi) return gagal("Belum login atau sesi berakhir. Masuk lagi lalu coba kembali.", 401, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return gagal("Permintaan terlalu besar.", 413, origin);
  let body: { action?: unknown; keySlot?: unknown; model?: unknown; uji?: unknown; stream?: unknown; contents?: unknown; generationConfig?: Record<string, unknown> };
  try { body = JSON.parse(raw); } catch { return gagal("Isi permintaan bukan JSON.", 400, origin); }

  if (body.action === "info") return out({ keys: API_KEYS.length, groq: 0 }, 200, origin);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  if (kebanyakan(ip)) return gagal("Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.", 429, origin);

  const cfg = await muatCfgModel(sesi.apikey, sesi.tok);
  const model = (String(body.model ?? "").trim() || cfg.default).toLowerCase();
  if (!MODEL_RE.test(model)) return gagal("Nama model tidak valid. Gunakan nama model persis seperti di penyedia, mis. gpt-4.1-mini (RelayRouter/OpenAI) atau google/gemini-2.5-flash (OpenRouter).", 400, origin);
  const ujiAdmin = body.uji === true && sesi.admin;
  if (!ujiAdmin && !cfg.ids.includes(model)) return gagal(`Model "${model.slice(0, 60)}" tidak tersedia. Pilih model dari daftar (default: ${cfg.default}) atau hubungi admin.`, 403, origin);
  if (!Array.isArray(body.contents) || !body.contents.length) return gagal("contents wajib diisi.", 400, origin);
  const messages = keMessages(body.contents);
  if (!messages.length) return gagal("contents tidak berisi teks atau berkas yang bisa diproses.", 400, origin);

  let slot = 0;
  if (body.keySlot !== undefined && body.keySlot !== null) {
    slot = Number(body.keySlot);
    if (!Number.isInteger(slot) || slot < 1 || slot > API_KEYS.length) return gagal(`API KEY ${String(body.keySlot).slice(0, 10)} tidak tersedia. Tersedia API KEY 1 sampai ${API_KEYS.length}.`, 400, origin);
  }

  const gc = (body.generationConfig ?? {}) as Record<string, unknown>;
  const mot = Number(gc.maxOutputTokens);
  const stream = body.stream === true;
  const payload: Record<string, unknown> = {
    model, messages, stream,
    max_tokens: Number.isFinite(mot) && mot > 0 ? Math.min(mot, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS,
  };
  // Model penalaran OpenAI (o1/o3/o4, gpt-5): tidak menerima temperature & max_tokens, memakai max_completion_tokens + reasoning_effort
  const penalaran = !!BASE && /^(?:openai\/)?(o\d|gpt-5)/.test(model);
  if (penalaran) { payload.max_completion_tokens = payload.max_tokens; delete payload.max_tokens; }
  const temp = Number(gc.temperature);
  if (!penalaran && gc.temperature !== undefined && Number.isFinite(temp)) payload.temperature = Math.min(Math.max(temp, 0), 2);
  // tingkat berpikir: thinkingLevel (low/medium/high) atau thinkingBudget (token) -> parameter reasoning OpenRouter
  const th = gc.thinkingConfig as { thinkingLevel?: string; thinkingBudget?: number } | undefined;
  if (BASE) {   // gateway gaya OpenAI: hanya reasoning_effort, dan hanya untuk model penalaran
    if (penalaran) payload.reasoning_effort = ["low", "medium", "high"].includes(th?.thinkingLevel ?? "") ? th!.thinkingLevel : "low";
  } else if (th?.thinkingLevel && ["low", "medium", "high"].includes(th.thinkingLevel)) payload.reasoning = { effort: th.thinkingLevel };
  else if (Number(th?.thinkingBudget) > 0) payload.reasoning = { max_tokens: Math.max(1024, Number(th!.thinkingBudget)) };
  // bila model utama sibuk/gagal, OpenRouter otomatis mencoba model lain yang diizinkan admin (flash dulu)
  const alt = cfg.ids.filter((m) => m !== model).sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a))).slice(0, 2);
  if (!BASE && !ujiAdmin && alt.length) payload.models = [model, ...alt];
  if (stream) payload.stream_options = { include_usage: false };
  const bodyStr = JSON.stringify(payload);

  const alasan: string[] = [];
  let terakhir: { status: number; text: string } | null = null;
  for (const i of (slot ? [slot - 1] : urutanKey())) {
    try {
      const sisa = BATAS_TOTAL_MS - (Date.now() - t0);
      if (!stream && sisa < 15_000) { terakhir = { status: 504, text: JSON.stringify({ error: { message: "Server AI terlalu lama menjawab." } }) }; break; }
      const res = await fetch(OR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${API_KEYS[i]}`, "X-Title": "RPP Maker", ...(REFERER ? { "HTTP-Referer": REFERER } : {}) },
        body: bodyStr,
        signal: stream ? undefined : AbortSignal.timeout(Math.max(10_000, Math.min(sisa, BATAS_TOTAL_MS))),
      });
      const hdr = { "x-provider": BASE ? "relayrouter" : "openrouter", "x-key-used": String(i + 1), ...corsFor(origin) };
      if (res.ok && stream && res.body) {
        return new Response(sseKeGemini(res.body), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", ...hdr } });
      }
      const text = await res.text();
      let j: { error?: { code?: number; message?: string }; model?: string; choices?: Array<{ message?: { content?: string }; finish_reason?: string; error?: { code?: number; message?: string } }> } | null = null;
      try { j = JSON.parse(text); } catch { /* bukan JSON */ }
      const errBody = j?.error ?? j?.choices?.[0]?.error;
      if (res.ok && !errBody) {
        const ch = j?.choices?.[0], t = String(ch?.message?.content ?? "");
        if (t) {
          return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: t }] }, finishReason: akhiranGemini(ch?.finish_reason) }] }),
            { status: 200, headers: { "Content-Type": "application/json", ...(j?.model ? { "x-model-used": j.model } : {}), ...hdr } });
        }
        terakhir = { status: 502, text: JSON.stringify({ error: { message: "OpenRouter tidak mengembalikan teks." } }) };
        alasan.push(`key ${i + 1}: kosong`);
        continue;
      }
      const status = res.ok ? Number(errBody?.code) || 502 : res.status;
      console.log(JSON.stringify({ ev: "openrouter_error", status, model, key: i + 1, msg: pesanDari(text) }));
      terakhir = { status, text };
      alasan.push(`key ${i + 1}: ${status}`);
      if (status === 429) istirahat.set(i, Date.now() + 60_000);
      if (!gagalKarenaKey(status)) break;   // mis. 400 isi permintaan salah / 5xx: tidak membantu ganti key
    } catch (e) {
      const habis = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      terakhir = habis
        ? { status: 504, text: JSON.stringify({ error: { message: "Server AI terlalu lama menjawab (potongan terlalu besar atau model sedang lambat)." } }) }
        : { status: 502, text: JSON.stringify({ error: { message: "Tidak bisa terhubung ke OpenRouter." } }) };
      alasan.push(`key ${i + 1}: ${habis ? "waktu habis" : "tidak terhubung"}`);
      if (habis) break;
    }
  }

  const pesan = pesanDari(terakhir!.text);
  const tambah = terakhir!.status === 402 ? " (saldo/kredit OpenRouter pada key ini habis)" : "";
  if (slot) return gagal(`API KEY ${slot} gagal (${terakhir!.status}). ${pesan}${tambah} Coba pilih API KEY lain.`, terakhir!.status, origin);
  return gagal(API_KEYS.length > 1 ? `Semua ${API_KEYS.length} API key gagal (${alasan.join("; ")}). Terakhir: ${pesan}${tambah}` : pesan + tambah, terakhir!.status, origin);
});
