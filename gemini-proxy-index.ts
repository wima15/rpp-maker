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
// Mode pilih key (keySlot): hanya key itu yang dipakai. Bila gagal, pesan kesalahan
// langsung dikembalikan supaya pengguna bisa memilih key lain.
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
const LIMIT_PER_MENIT = 12;

function corsFor(origin: string | null) {
  const allow = ALLOWED_ORIGINS.length ? (origin ?? "") : "*";
  return {
    "Access-Control-Allow-Origin": allow,
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Expose-Headers": "x-key-used",
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
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(origin) });
  if (req.method !== "POST") return gagal("Method not allowed", 405, origin);

  if (!API_KEYS.length) return gagal("Secret GEMINI_API_KEY_1 (dst) belum diset di Edge Functions.", 500, origin);
  if (ALLOWED_ORIGINS.length && !(origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, "")))) {
    return gagal("Asal permintaan tidak diizinkan.", 403, origin);
  }

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return gagal("Permintaan terlalu besar.", 413, origin);
  let body: {
    action?: unknown;
    keySlot?: unknown;
    model?: unknown;
    stream?: unknown;
    contents?: unknown;
    generationConfig?: Record<string, unknown>;
  };
  try { body = JSON.parse(raw); } catch { return gagal("Isi permintaan bukan JSON.", 400, origin); }

  // info jumlah key (untuk dialog pilih API key); tidak membuka isi key dan tidak dihitung batas IP
  if (body.action === "info") return out({ keys: API_KEYS.length }, 200, origin);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  if (kebanyakan(ip)) return gagal("Terlalu banyak permintaan. Tunggu sebentar lalu coba lagi.", 429, origin);

  const model = String(body.model ?? "").trim();
  if (!/^gemini-[a-z0-9.\-]+$/i.test(model)) return gagal("Nama model tidak valid.", 400, origin);
  if (!Array.isArray(body.contents) || !body.contents.length) return gagal("contents wajib diisi.", 400, origin);

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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": API_KEYS[i] },
        body: payload,
      });

      // mode stream: bila key diterima, teruskan aliran apa adanya (isi tidak dibaca di sini)
      if (stream && res.ok && res.body) {
        return new Response(res.body, {
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
      alasan.push(`key ${i + 1}: tidak terhubung`);
      terakhir = { status: 502, text: JSON.stringify({ error: { message: String(e) } }) };
    }
  }

  if (slot) return gagal(`API KEY ${slot} gagal (${terakhir!.status}). ${pesanDari(terakhir!.text)} Coba pilih API KEY lain.`, terakhir!.status, origin);
  const pesan = API_KEYS.length > 1
    ? `Semua ${API_KEYS.length} API key gagal (${alasan.join("; ")}). Terakhir: ${pesanDari(terakhir!.text)}`
    : pesanDari(terakhir!.text);
  return gagal(pesan, terakhir!.status, origin);
});
