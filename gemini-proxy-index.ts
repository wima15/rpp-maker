// =========================================================
// EDGE FUNCTION: gemini-proxy  (project Supabase RPM / tujuan)
// Meneruskan permintaan dari penyusun-rpm.html ke Google Gemini.
// API key Gemini disimpan sebagai secret, tidak pernah sampai ke browser.
//
// Secret yang harus diset (Edge Functions > Secrets):
//   GEMINI_API_KEY_1, GEMINI_API_KEY_2, ... GEMINI_API_KEY_5 (dst sampai _20)
//                    = satu secret per key. Cara ini yang disarankan.
//                      GEMINI_API_KEY_1 = API KEY 1, GEMINI_API_KEY_2 = API KEY 2, dst.
//   GEMINI_API_KEYS  = (opsional) beberapa key dalam satu secret, dipisah koma; dipakai setelah key bernomor
//   GEMINI_API_KEY   = (opsional, cara lama) satu key; tetap dibaca dan digabung
//   ALLOWED_ORIGINS  = (disarankan) alamat situs yang boleh memanggil,
//                      pisah koma, mis. https://rpm.sekolah.sch.id,https://user.github.io
//
// Permintaan (POST, JSON):
//   { action: "info" }                          -> { keys: <jumlah key> }  (tanpa membuka key)
//   { model, contents, generationConfig }       -> mode Otomatis: key bergiliran + cadangan
//   { model, contents, generationConfig, keySlot: n }
//                                               -> hanya memakai API KEY n (tanpa pindah key)
//   tambahan: stream: true                      -> hasil dikirim bertahap (SSE) apa adanya dari Gemini,
//                                                  supaya teks yang sudah jadi tidak hilang bila koneksi putus
// Respons: isi respons Gemini apa adanya (candidates, error, dst).
//   Header x-key-used = nomor API KEY yang benar-benar dipakai (untuk riwayat pemakaian).
// Kesalahan dari function ini memakai bentuk { error: { message } }.
//
// Mode Otomatis: permintaan dibagi bergiliran ke semua key. Bila sebuah key gagal karena
// kuota habis (429), ditolak/tidak valid (401/403, "API key not valid"), atau tidak bisa
// dihubungi, function mencoba key berikutnya. Key yang kena kuota diistirahatkan 60 detik.
// Kesalahan lain (mis. isi permintaan salah) langsung dikembalikan, tidak diulang.
// Pada mode stream, pindah key hanya terjadi SEBELUM aliran dimulai; setelah aliran berjalan,
// bila terputus, browser menyimpan teks sebagian dan pengguna melanjutkannya dengan key lain.
//
// CADANGAN GROQ (opsional): bila semua key Gemini gagal (kuota habis / server Gemini sibuk 5xx),
// permintaan Mode Otomatis diteruskan ke Groq, lalu hasilnya diubah ke bentuk Gemini supaya
// browser tidak perlu berubah. Tidak dipakai bila guru memilih API KEY tertentu (keySlot), dan
// tidak dipakai bila permintaan memuat gambar/berkas (Groq di sini hanya untuk teks).
//   GEMINI_GROQ_API_KEY_1 ... GEMINI_GROQ_API_KEY_10  = key Groq (atau GEMINI_GROQ_API_KEY, boleh dipisah koma)
//   GEMINI_GROQ_MODEL       = (opsional) nama model Groq, bawaan openai/gpt-oss-120b
//   GEMINI_GROQ_MAX_TOKENS  = (opsional) batas token keluaran Groq, bawaan 16384
//   GEMINI_GROQ_REASONING   = (opsional) low | medium | high, bawaan medium (high = paling teliti, paling lambat)
//   Header x-provider: groq menandai bahwa jawaban datang dari cadangan.
//
//   Guru juga bisa memilih Groq langsung: { ..., groqSlot: n } -> hanya key Groq n, Gemini tidak dicoba.
//   action "info" mengembalikan juga { groq: <jumlah key Groq> }. x-key-used berisi "g1", "g2", dst untuk Groq.
//
// Mode pilih key (keySlot): hanya key itu yang dipakai. Bila gagal, pesan kesalahan
// langsung dikembalikan supaya pengguna bisa memilih key lain.
//
// Login: setiap permintaan wajib membawa sesi login guru (header Authorization: Bearer <access token>
// dari Auth project ini). Tanpa sesi yang sah -> 401. Pengecekan memakai /auth/v1/user dan di-cache 5 menit.
//
// Model: daftar model yang boleh dipakai + model default diatur admin di Portal Admin > Model AI
// (tabel pengaturan_rpm, kunci "model_ai"). Server MEMERIKSA ULANG setiap permintaan terhadap daftar itu,
// jadi guru tidak bisa memakai model di luar daftar walau mengubah isi permintaan dari browser.
//   - model kosong            -> memakai model default
//   - model tidak ada di daftar / dinonaktifkan -> ditolak (403)
//   - pengaturan belum ada, rusak, atau default-nya tidak aktif -> memakai DAFTAR BAWAAN di bawah (aman)
//   - hanya admin yang boleh menguji model yang belum ada di daftar (permintaan dengan uji: true)
//   Perubahan dari admin berlaku paling lama 5 menit kemudian (cache).
//
// Pembatasan: nama model harus berawalan "gemini-", maxOutputTokens dibatasi,
// hanya contents + generationConfig yang diteruskan, ukuran permintaan dibatasi,
// dan ada batas permintaan per menit per alamat IP.
// =========================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Key dibaca dari secret terpisah GEMINI_API_KEY_1 ... GEMINI_API_KEY_20 (urutan angka),
// lalu GEMINI_API_KEYS (dipisah koma), lalu GEMINI_API_KEY (cara lama). Duplikat dibuang.
const numbered = Array.from({ length: 20 }, (_, i) => Deno.env.get(`GEMINI_API_KEY_${i + 1}`) ?? "");
const API_KEYS = [...new Set(
  [...numbered, ...`${Deno.env.get("GEMINI_API_KEYS") ?? ""},${Deno.env.get("GEMINI_API_KEY") ?? ""}`.split(",")]
    .map((k) => k.replace(/["'\s]/g, "")).filter(Boolean),
)];
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

const MAX_BODY_BYTES = 300_000;
const MAX_OUTPUT_TOKENS = 16384;
const BATAS_TOTAL_MS = 120_000;   // Supabase mematikan fungsi di 150 dtk (kode 546); sisakan ruang untuk cadangan Groq
const LIMIT_PER_MENIT = 60;   // sekolah biasanya berbagi satu IP; 12/menit membuat guru saling menghalangi

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
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(origin) },
  });
}
const gagal = (msg: string, status: number, origin: string | null) =>
  out({ error: { message: msg } }, status, origin);

// ---- rotasi & cadangan key ----
let giliran = 0;
const istirahat = new Map<number, number>(); // indeks key -> waktu boleh dipakai lagi
const KUOTA_ISTIRAHAT_MS = 60_000;

function urutanKey() {
  const n = API_KEYS.length, now = Date.now();
  const mulai = giliran++ % n;
  const semua = Array.from({ length: n }, (_, i) => (mulai + i) % n);
  const siap = semua.filter((i) => (istirahat.get(i) ?? 0) <= now);
  const lelah = semua.filter((i) => (istirahat.get(i) ?? 0) > now);
  return [...siap, ...lelah]; // key yang sedang istirahat dicoba paling akhir
}

// true = kegagalan milik key ini, coba key lain
function gagalKarenaKey(status: number, teks: string) {
  if (status === 429 || status === 401 || status === 403) return true;
  if (status === 400 && /api[_ ]key.*(invalid|not valid|expired)|API_KEY_INVALID/i.test(teks)) return true;
  return false;
}

function pesanDari(teks: string) {
  try { return String(JSON.parse(teks)?.error?.message ?? teks).slice(0, 200); } catch { return teks.slice(0, 200); }
}


// ---- cadangan: Groq (format OpenAI, diubah dari/ke format Gemini) ----
const GROQ_KEYS = [...new Set(
  [
    ...Array.from({ length: 10 }, (_, i) => Deno.env.get(`GEMINI_GROQ_API_KEY_${i + 1}`) ?? ""),
    ...(Deno.env.get("GEMINI_GROQ_API_KEY") ?? "").split(","),
  ].map((k) => k.replace(/["'\s]/g, "")).filter(Boolean),
)];
const GEMINI_GROQ_MODEL = (Deno.env.get("GEMINI_GROQ_MODEL") ?? "").trim() || "openai/gpt-oss-120b";
const GEMINI_GROQ_MAX_TOKENS = Number(Deno.env.get("GEMINI_GROQ_MAX_TOKENS")) || 16384;
// tingkat berpikir model gpt-oss: low | medium | high (medium = lebih teliti & rinci, sedikit lebih lambat)
const GROQ_REASONING = ((Deno.env.get("GEMINI_GROQ_REASONING") ?? "").trim().toLowerCase());
const GROQ_REASONING_OK = ["low", "medium", "high"].includes(GROQ_REASONING) ? GROQ_REASONING : "medium";
// Model Groq tidak sepintar Gemini dalam mengikuti format panjang & cenderung meringkas.
// Pesan sistem ini memaksa jawaban lengkap, rinci, dan sesuai format yang diminta pengguna.
const GROQ_SISTEM =
  "Anda adalah penyusun perangkat ajar (RPM/RPP, ATP, LKPD, asesmen, modul) yang sangat teliti untuk guru di Indonesia. " +
  "Tulis dalam bahasa Indonesia baku. Ikuti PERSIS struktur, urutan bagian, judul, tabel, dan format yang diminta pengguna; " +
  "jangan melewatkan satu bagian pun dan jangan mengubah nama bagian. " +
  "Tulis selengkap dan serinci mungkin: jangan meringkas, jangan menulis 'dan seterusnya', 'dst', atau placeholder; " +
  "isi setiap bagian dengan konten konkret dan spesifik (langkah kegiatan berurutan beserta alokasi waktu, contoh, pertanyaan pemantik, " +
  "indikator, rubrik, soal beserta kunci/pembahasan bila diminta), sesuai mata pelajaran, fase/kelas, dan topik yang diberikan. " +
  "Gunakan seluruh data (identitas, tujuan, alokasi waktu) persis seperti yang diberikan, jangan mengarang data identitas. " +
  "Bila ada asesmen/penilaian sumatif, tes, atau ulangan, WAJIB menyebut cakupannya: unit, materi, dan kode TP/indikator mana saja yang diujikan serta bentuknya; jangan menulis asesmen yang hanya berjudul tanpa cakupan. " +
  "Bila diminta membaca atau memuat Capaian Pembelajaran (CP), tulis bunyi CP per elemen selengkapnya tanpa meringkas, analisis tiap kompetensi dan kontennya, dan pastikan setiap bagian CP terwakili oleh tujuan pembelajaran. " +
  "Jangan memberi kalimat pembuka, penutup, atau komentar di luar dokumen. Bila diminta melanjutkan, teruskan tepat dari titik terakhir tanpa mengulang.";
let groqGiliran = 0;

// contents Gemini -> messages OpenAI. null bila ada bagian non-teks (gambar/berkas).
function keGroqMessages(contents: unknown): { role: string; content: string }[] | null {
  const msgs: { role: string; content: string }[] = [];
  for (const c of contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>) {
    const parts = Array.isArray(c?.parts) ? c.parts : [];
    if (parts.some((p) => !p || typeof p.text !== "string")) return null;
    msgs.push({ role: c?.role === "model" ? "assistant" : "user", content: parts.map((p) => String(p.text)).join("") });
  }
  return msgs.length ? msgs : null;
}

function akhiranGemini(f: unknown) {
  if (f === "length") return "MAX_TOKENS";
  if (f === "content_filter") return "SAFETY";
  return "STOP";
}

// aliran SSE Groq -> aliran SSE berbentuk Gemini (yang dibaca readStream di browser)
function sseKeGemini(src: ReadableStream<Uint8Array>) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const proses = (blk: string, c: TransformStreamDefaultController<Uint8Array>) => {
    const m = blk.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
    if (!m || m === "[DONE]") return;
    let o: { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }> };
    try { o = JSON.parse(m); } catch { return; }
    const ch = o?.choices?.[0];
    if (!ch) return;
    const t = ch.delta?.content ?? "";
    const f = ch.finish_reason ? akhiranGemini(ch.finish_reason) : "";
    if (!t && !f) return;
    const cand: Record<string, unknown> = { content: { role: "model", parts: [{ text: t }] } };
    if (f) cand.finishReason = f;
    c.enqueue(enc.encode(`data: ${JSON.stringify({ candidates: [cand] })}\r\n\r\n`));
  };
  return src.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, c) {
      buf += dec.decode(chunk, { stream: true });
      const parts = buf.split(/\r?\n\r?\n/);
      buf = parts.pop() ?? "";
      parts.forEach((p) => proses(p, c));
    },
    flush(c) { buf += dec.decode(); if (buf.trim()) proses(buf, c); },
  }));
}

// Mencoba Groq. slot > 0 = hanya key Groq itu (pilihan guru); slot 0 = bergiliran sebagai cadangan.
// res = jawaban berbentuk Gemini bila berhasil; bila gagal, status + pesan untuk ditampilkan.
async function cobaGroq(
  contents: unknown, gc: Record<string, unknown>, stream: boolean, origin: string | null, slot = 0,
): Promise<{ res?: Response; status: number; pesan: string }> {
  console.log(JSON.stringify({ ev: "groq_try", keys: GROQ_KEYS.length, slot, model: GEMINI_GROQ_MODEL }));
  if (!GROQ_KEYS.length) return { status: 400, pesan: "Key Groq belum diset di server." };
  const messages = keGroqMessages(contents);
  if (!messages) return { status: 400, pesan: "Groq hanya untuk teks; permintaan ini memuat gambar/berkas." };
  const mot = Number(gc.maxOutputTokens);
  const dasar = Number.isFinite(mot) && mot > 0 ? mot : GEMINI_GROQ_MAX_TOKENS;
  const payload: Record<string, unknown> = {
    model: GEMINI_GROQ_MODEL,
    messages: [{ role: "system", content: GROQ_SISTEM }, ...messages],
    // + ruang untuk token berpikir model; bila tetap terpotong, browser melanjutkan otomatis
    max_tokens: Math.min(dasar + 4096, GEMINI_GROQ_MAX_TOKENS),
    stream,
  };
  // model gpt-oss berpikir dulu; tingkat berpikir diatur lewat GEMINI_GROQ_REASONING (bawaan medium)
  if (/^openai\/gpt-oss/i.test(GEMINI_GROQ_MODEL)) payload.reasoning_effort = GROQ_REASONING_OK;
  const temp = Number(gc.temperature);
  if (gc.temperature !== undefined && Number.isFinite(temp)) payload.temperature = Math.min(Math.max(temp, 0), 2);
  const body = JSON.stringify(payload);
  const n = GROQ_KEYS.length;
  const urutan = slot ? [slot - 1] : Array.from({ length: n }, (_, k) => (groqGiliran++ % n));
  let status = 502, pesan = "Tidak bisa terhubung ke Groq.";
  for (const i of urutan) {
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GROQ_KEYS[i]}` },
        body,
      });
      if (!res.ok) { status = res.status; pesan = pesanDari(await res.text()); console.log(JSON.stringify({ ev: "groq_error", status, key: i + 1, model: GEMINI_GROQ_MODEL, msg: pesan })); continue; } // 429/5xx/401: key Groq berikutnya
      const hdr = { "x-provider": "groq", "x-key-used": `g${i + 1}`, ...corsFor(origin) };
      if (stream && res.body) {
        return {
          status: 200, pesan: "",
          res: new Response(sseKeGemini(res.body), {
            status: 200,
            headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", ...hdr },
          }),
        };
      }
      const j = await res.json();
      const ch = j?.choices?.[0];
      const text = String(ch?.message?.content ?? "");
      if (!text) { status = 502; pesan = "Groq tidak mengembalikan teks."; continue; }
      return {
        status: 200, pesan: "",
        res: new Response(
          JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: akhiranGemini(ch?.finish_reason) }] }),
          { status: 200, headers: { "Content-Type": "application/json", ...hdr } },
        ),
      };
    } catch (e) { status = 502; pesan = "Tidak bisa terhubung ke Groq."; }
  }
  return { status, pesan };
}

// ---- daftar model yang diizinkan ----
const MODEL_RE = /^gemini-[a-z0-9.\-]{1,60}$/;
// Daftar bawaan: dipakai bila pengaturan admin belum ada / tidak valid. Harus sama dengan MODEL_SEED di index.html.
const CFG_BAWAAN = {
  default: "gemini-3.8-flash",
  ids: ["gemini-3.8-flash", "gemini-3.8-pro", "gemini-flash-latest", "gemini-pro-latest"],
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

  if (!API_KEYS.length) return gagal("Secret GEMINI_API_KEY_1 (dst) belum diset di Edge Functions.", 500, origin);
  if (ALLOWED_ORIGINS.length && !(origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, "")))) {
    return gagal("Asal permintaan tidak diizinkan.", 403, origin);
  }

  const sesi = await sesiSah(req);
  if (!sesi) return gagal("Belum login atau sesi berakhir. Masuk lagi lalu coba kembali.", 401, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return gagal("Permintaan terlalu besar.", 413, origin);
  let body: {
    action?: unknown;
    keySlot?: unknown;
    groqSlot?: unknown;
    model?: unknown;
    uji?: unknown;
    stream?: unknown;
    contents?: unknown;
    generationConfig?: Record<string, unknown>;
  };
  try { body = JSON.parse(raw); } catch { return gagal("Isi permintaan bukan JSON.", 400, origin); }

  // info jumlah key (untuk dialog pilih API key); tidak membuka isi key dan tidak dihitung batas IP
  if (body.action === "info") return out({ keys: API_KEYS.length, groq: GROQ_KEYS.length }, 200, origin);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  if (kebanyakan(ip)) return gagal("Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.", 429, origin);

  // model: kosong -> default admin; selain itu harus ada di daftar yang diaktifkan admin.
  // Admin boleh menguji model baru (uji: true) sebelum menambahkannya ke daftar.
  const cfg = await muatCfgModel(sesi.apikey, sesi.tok);
  const model = (String(body.model ?? "").trim() || cfg.default).toLowerCase();
  if (!MODEL_RE.test(model)) return gagal("Nama model tidak valid.", 400, origin);
  const ujiAdmin = body.uji === true && sesi.admin;
  if (!ujiAdmin && !cfg.ids.includes(model)) {
    return gagal(`Model "${model.slice(0, 60)}" tidak tersedia. Pilih model dari daftar (default: ${cfg.default}) atau hubungi admin.`, 403, origin);
  }
  if (!Array.isArray(body.contents) || !body.contents.length) return gagal("contents wajib diisi.", 400, origin);

  // pilihan Groq langsung (groqSlot: 1..jumlah key Groq): tidak mencoba Gemini sama sekali
  if (body.groqSlot !== undefined && body.groqSlot !== null) {
    const gs = Number(body.groqSlot);
    if (!Number.isInteger(gs) || gs < 1 || gs > GROQ_KEYS.length) {
      return gagal(`Groq ${String(body.groqSlot).slice(0, 10)} tidak tersedia. ` +
        (GROQ_KEYS.length ? `Tersedia Groq 1 sampai ${GROQ_KEYS.length}.` : "Key Groq belum diset di server."), 400, origin);
    }
    const gcg = { ...(body.generationConfig ?? {}) } as Record<string, unknown>;
    const r = await cobaGroq(body.contents, gcg, body.stream === true, origin, gs);
    return r.res ?? gagal(`Groq ${gs} gagal (${r.status}). ${r.pesan} Coba pilih API KEY lain.`, r.status, origin);
  }

  // pilihan key: tidak diisi = Otomatis; angka 1..jumlah key = hanya key itu
  let slot = 0;
  if (body.keySlot !== undefined && body.keySlot !== null) {
    slot = Number(body.keySlot);
    if (!Number.isInteger(slot) || slot < 1 || slot > API_KEYS.length) {
      return gagal(`API KEY ${String(body.keySlot).slice(0, 10)} tidak tersedia. Tersedia API KEY 1 sampai ${API_KEYS.length}.`, 400, origin);
    }
  }

  const gc = { ...(body.generationConfig ?? {}) } as Record<string, unknown>;
  const mot = Number(gc.maxOutputTokens);
  gc.maxOutputTokens = Number.isFinite(mot) && mot > 0 ? Math.min(mot, MAX_OUTPUT_TOKENS) : MAX_OUTPUT_TOKENS;

  const stream = body.stream === true;
  const payload = JSON.stringify({ contents: body.contents, generationConfig: gc });
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:` +
    (stream ? "streamGenerateContent?alt=sse" : "generateContent");
  const alasan: string[] = [];
  let terakhir: { status: number; text: string } | null = null;

  const urutan = slot ? [slot - 1] : urutanKey();
  for (const i of urutan) {
    try {
      // Batas waktu sendiri (di bawah 150 dtk milik Supabase): lebih baik gagal rapi daripada dimatikan paksa (546)
      const sisa = BATAS_TOTAL_MS - (Date.now() - t0);
      if (!stream && sisa < 15_000) { alasan.push(`key ${i + 1}: waktu habis`); terakhir = { status: 504, text: JSON.stringify({ error: { message: "Gemini terlalu lama menjawab." } }) }; break; }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEYS[i] },
        body: payload,
        signal: stream ? undefined : AbortSignal.timeout(Math.max(10_000, Math.min(sisa, BATAS_TOTAL_MS))),
      });

      // mode stream: bila key diterima, teruskan aliran apa adanya (isi tidak dibaca di sini)
      if (stream && res.ok && res.body) {
        // DIAGNOSTIK: catat jalannya aliran di Logs. Bila ada "stream_start" tanpa "stream_end",
        // fungsi dimatikan platform di tengah aliran (lihat "sec" pada "stream_progress" terakhir).
        const t1 = Date.now();
        let bytes = 0, lastLog = t1;
        console.log(JSON.stringify({ ev: "stream_start", model, key: i + 1, wait_ms: t1 - t0, req_kb: Math.round(raw.length / 1024) }));
        const diag = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, c) {
            bytes += chunk.length;
            c.enqueue(chunk);
            const now = Date.now();
            if (now - lastLog >= 20_000) {
              lastLog = now;
              console.log(JSON.stringify({ ev: "stream_progress", sec: Math.round((now - t1) / 1000), kb: Math.round(bytes / 1024) }));
            }
          },
          flush() { console.log(JSON.stringify({ ev: "stream_end", sec: Math.round((Date.now() - t1) / 1000), kb: Math.round(bytes / 1024) })); },
        }));
        return new Response(diag, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            "x-key-used": String(i + 1),
            ...corsFor(origin),
          },
        });
      }

      const text = await res.text();
      if (!res.ok) console.log(JSON.stringify({ ev: "gemini_error", status: res.status, model, key: i + 1, msg: pesanDari(text) }));
      // server Gemini sibuk/error (5xx): bila ada cadangan Groq, berhenti memutar key Gemini
      // 503 = model Gemini kelebihan beban (bukan salah key): jangan teruskan mentah, coba model lain / cadangan di bawah
      if (res.status >= 500 && (res.status === 503 || (!slot && GROQ_KEYS.length))) {
        alasan.push(`key ${i + 1}: ${res.status}`);
        terakhir = { status: res.status, text };
        break;
      }
      if (!gagalKarenaKey(res.status, text)) {
        return new Response(text, {
          status: res.status,
          headers: { "Content-Type": "application/json", "x-key-used": String(i + 1), ...corsFor(origin) },
        });
      }
      if (res.status === 429) istirahat.set(i, Date.now() + KUOTA_ISTIRAHAT_MS);
      alasan.push(`key ${i + 1}: ${res.status}`);
      terakhir = { status: res.status, text };
    } catch (e) {
      const habis = (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError";
      alasan.push(`key ${i + 1}: ${habis ? "waktu habis" : "tidak terhubung"}`);
      terakhir = habis
        ? { status: 504, text: JSON.stringify({ error: { message: "Gemini terlalu lama menjawab (potongan terlalu besar atau model sedang lambat)." } }) }
        : { status: 502, text: JSON.stringify({ error: { message: String(e) } }) };
      if (habis) break;   // sisa waktu tidak cukup untuk key lain; langsung ke cadangan Groq / minta browser mengulang dengan potongan lebih kecil
    }
  }

  // model kelebihan beban (503): coba model Gemini lain yang diizinkan admin (flash dulu) sebelum cadangan Groq
  if (!stream && terakhir && terakhir.status === 503) {
    const alt = cfg.ids.filter((m) => m !== model)
      .sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a))).slice(0, 2);
    for (const m of alt) {
      const sisa = BATAS_TOTAL_MS - (Date.now() - t0);
      if (sisa < 20_000) break;
      let lanjutModel = false;
      for (const i of urutan.slice(0, 2)) {
        try {
          const r2 = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEYS[i] },
            body: payload,
            signal: AbortSignal.timeout(sisa),
          });
          const tx = await r2.text();
          if (r2.ok) {
            console.log(JSON.stringify({ ev: "model_fallback", dari: model, ke: m, key: i + 1 }));
            return new Response(tx, { status: 200, headers: { "Content-Type": "application/json", "x-key-used": String(i + 1), "x-model-used": m, ...corsFor(origin) } });
          }
          if (r2.status === 503 || r2.status >= 500) { lanjutModel = true; break; }   // model ini juga sibuk: model berikutnya
          if (!gagalKarenaKey(r2.status, tx)) { lanjutModel = true; break; }            // mis. 400 (parameter tak cocok di model ini)
        } catch { lanjutModel = true; break; }
      }
      if (lanjutModel) continue;
    }
  }

  // semua key Gemini gagal (kuota / server sibuk): coba cadangan Groq (hanya Mode Otomatis, hanya teks)
  if (!slot) {
    const g = await cobaGroq(body.contents, gc, stream, origin);
    if (g.res) return g.res;
  }

  if (slot) return gagal(`API KEY ${slot} gagal (${terakhir!.status}). ${pesanDari(terakhir!.text)} Coba pilih API KEY lain.`, terakhir!.status, origin);
  const pesan = API_KEYS.length > 1
    ? `Semua ${API_KEYS.length} API key gagal (${alasan.join("; ")}). Terakhir: ${pesanDari(terakhir!.text)}`
    : pesanDari(terakhir!.text);
  return gagal(pesan, terakhir!.status, origin);
});
