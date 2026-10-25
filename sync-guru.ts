// =========================================================
// EDGE FUNCTION: sync-guru  (project Supabase RPM / tujuan)
// Menarik daftar guru dan mata pelajaran yang diampu dari project
// Supabase E-RAPOR (raporwima), lalu menyimpannya ke tabel guru_rpm.
//
// Secret yang harus diset (Edge Functions > Secrets):
//   RAPOR_URL          = https://iejpwxmcqwecejsrezry.supabase.co
//   RAPOR_SERVICE_KEY  = service_role key project E-RAPOR
//   SYNC_TOKEN         = kata sandi bebas buatan Anda; diketik admin di Portal Admin
//
// Aksi (POST, JSON):
//   { token, action: "tahun_ajaran" }              -> baca tahun ajaran aktif + rentang tanggal semester dari
//                                                     E-Rapor, simpan ke pengaturan_rpm (kunci 'tahun_ajaran')
//   { token, action: "plan" }                      -> ringkasan, tidak menulis apa pun
//   { token, action: "apply", hapus: true|false }  -> simpan ke guru_rpm
//   (opsional pada apply: konfirmasi_hapus: true bila server meminta konfirmasi)
//
// Aturan:
//   - Guru diambil dari profiles (role = guru) di E-RAPOR.
//   - Mapel diambil dari penugasan_guru pada tahun ajaran aktif (nama mapel unik per guru).
//   - Mapel kosong di E-RAPOR tidak menimpa mapel yang sudah terisi di guru_rpm.
//   - Hanya baris bertanda sumber = 'erapor' yang boleh dihapus; guru tambahan manual tidak disentuh.
// =========================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAPOR_URL = Deno.env.get("RAPOR_URL") ?? "";
const RAPOR_SERVICE_KEY = Deno.env.get("RAPOR_SERVICE_KEY") ?? "";
const SYNC_TOKEN = Deno.env.get("SYNC_TOKEN") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// deno-lint-ignore no-explicit-any
async function fetchAll(build: (from: number, to: number) => any) {
  const out: any[] = [];
  const size = 1000;
  for (let from = 0; ; from += size) {
    const { data, error } = await build(from, from + size - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < size) break;
  }
  return out;
}

// Cari kolom tanggal pada baris tahun_ajaran E-Rapor tanpa bergantung pada nama kolom pasti.
// deno-lint-ignore no-explicit-any
function tglKolom(r: any, re: RegExp): string {
  for (const k of Object.keys(r)) {
    const v = String(r[k] ?? "");
    if (re.test(k) && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  }
  return "";
}

// Ambil semua baris tahun ajaran yang bernama sama dengan yang aktif (Ganjil & Genap),
// lalu simpan ke pengaturan_rpm agar bisa dibaca semua guru tanpa service key.
// deno-lint-ignore no-explicit-any
async function simpanTahunAjaran(rapor: any, db: any, ta: { nama: string }) {
  const { data, error } = await rapor.from("tahun_ajaran").select("*").eq("nama", ta.nama);
  if (error) throw new Error("E-Rapor: " + error.message);
  // deno-lint-ignore no-explicit-any
  const sems: Record<string, any> = {};
  // deno-lint-ignore no-explicit-any
  for (const r of (data ?? []) as any[]) {
    const sem = /genap|^\s*2\s*$/i.test(String(r.semester ?? "")) ? "Genap" : "Ganjil";
    let mulai = tglKolom(r, /mulai|awal|start|from/i);
    let selesai = tglKolom(r, /selesai|akhir|end|sampai|until/i);
    if (mulai && selesai && mulai > selesai) { mulai = ""; selesai = ""; }
    sems[sem] = { mulai, selesai };
  }
  const nilai = { nama: ta.nama, sems, diambil: new Date().toISOString() };
  const { error: e2 } = await db.from("pengaturan_rpm")
    .upsert({ kunci: "tahun_ajaran", nilai, updated_at: new Date().toISOString() }, { onConflict: "kunci" });
  if (e2) throw new Error("Simpan tahun_ajaran: " + e2.message);
  return nilai;
}

const norm = (s: unknown) => String(s ?? "").trim();
const nkey = (s: unknown) => norm(s).toLowerCase().replace(/\s+/g, " ");

function samaToken(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  if (!RAPOR_URL || !RAPOR_SERVICE_KEY) {
    return json({ error: "Secret RAPOR_URL dan RAPOR_SERVICE_KEY belum diset di Edge Functions." }, 500);
  }
  if (!SYNC_TOKEN) {
    return json({ error: "Secret SYNC_TOKEN belum diset di Edge Functions." }, 500);
  }

  const body = await req.json().catch(() => ({}));
  if (!samaToken(String(body.token ?? ""), SYNC_TOKEN)) {
    return json({ error: "Token sinkron salah." }, 401);
  }
  const action = body.action;
  if (action !== "plan" && action !== "apply" && action !== "tahun_ajaran") return json({ error: "Action tidak dikenal" }, 400);

  try {
    const rapor = createClient(RAPOR_URL, RAPOR_SERVICE_KEY);
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // ---------- baca E-RAPOR ----------
    const { data: taRows, error: taErr } = await rapor
      .from("tahun_ajaran").select("id,nama,semester").eq("is_aktif", true).limit(1);
    if (taErr) return json({ error: "E-Rapor: " + taErr.message }, 400);
    const ta = taRows?.[0];
    if (!ta) return json({ error: "Tidak ada tahun ajaran aktif di E-Rapor." }, 400);

    if (action === "tahun_ajaran") {
      return json({ ok: true, tahun_ajaran: await simpanTahunAjaran(rapor, db, ta) });
    }

    // deno-lint-ignore no-explicit-any
    const guruRows: any[] = await fetchAll((f, t) =>
      rapor.from("profiles").select("id,nama").eq("role", "guru").order("id").range(f, t)
    );
    // deno-lint-ignore no-explicit-any
    const pgRows: any[] = await fetchAll((f, t) =>
      rapor.from("penugasan_guru")
        .select("guru_id, mata_pelajaran(nama)")
        .eq("tahun_ajaran_id", ta.id).order("id").range(f, t)
    );

    const mapelByGuru = new Map<string, Set<string>>();
    for (const p of pgRows) {
      const m = norm(p.mata_pelajaran?.nama);
      if (!p.guru_id || !m) continue;
      if (!mapelByGuru.has(p.guru_id)) mapelByGuru.set(p.guru_id, new Set());
      mapelByGuru.get(p.guru_id)!.add(m);
    }

    const raporGuru: { nama: string; mapel: string[] }[] = [];
    const seen = new Set<string>();
    for (const g of guruRows) {
      const nama = norm(g.nama);
      const k = nkey(nama);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      raporGuru.push({ nama, mapel: [...(mapelByGuru.get(g.id) ?? [])].sort((a, b) => a.localeCompare(b, "id")) });
    }
    if (!raporGuru.length) {
      return json({ error: "E-Rapor terbaca tetapi daftar gurunya kosong (profiles dengan role guru)." }, 400);
    }

    // ---------- bandingkan dengan guru_rpm ----------
    // deno-lint-ignore no-explicit-any
    const ex: any[] = await fetchAll((f, t) =>
      db.from("guru_rpm").select("id,nama,mapel,sumber").order("id").range(f, t)
    );
    // deno-lint-ignore no-explicit-any
    const exMap = new Map<string, any>();
    for (const x of ex) { const k = nkey(x.nama); if (k && !exMap.has(k)) exMap.set(k, x); }

    const add: { nama: string; mapel: string }[] = [];
    const upd: { id: string; nama: string; mapel: string }[] = [];
    let same = 0;
    for (const g of raporGuru) {
      const e = exMap.get(nkey(g.nama));
      const mapel = g.mapel.length ? g.mapel.join(", ") : (e ? norm(e.mapel) : "");
      if (!e) add.push({ nama: g.nama, mapel });
      else if (norm(e.mapel) !== mapel || e.sumber !== "erapor") upd.push({ id: e.id, nama: e.nama, mapel });
      else same++;
    }
    const tagged = ex.filter((x) => x.sumber === "erapor");
    const del = body.hapus === true ? tagged.filter((x) => !seen.has(nkey(x.nama))) : [];

    const ringkasan = {
      tahun_ajaran: `${ta.nama} ${ta.semester ?? ""}`.trim(),
      total_erapor: raporGuru.length,
      baru: add.length,
      diperbarui: upd.length,
      sama: same,
      dihapus: del.length,
      daftar: {
        baru: add.slice(0, 40).map((x) => x.nama),
        diperbarui: upd.slice(0, 40).map((x) => x.nama),
        dihapus: del.slice(0, 40).map((x) => x.nama),
      },
    };

    if (action === "plan") return json({ mode: "plan", ...ringkasan });

    // ---------- tulis ----------
    if (del.length >= 5 && del.length > tagged.length / 2 && body.konfirmasi_hapus !== true) {
      return json({ needs_confirm: true, hapus: del.length, dari: tagged.length, ...ringkasan }, 409);
    }

    const now = new Date().toISOString();
    for (let i = 0; i < add.length; i += 200) {
      const { error } = await db.from("guru_rpm").insert(
        add.slice(i, i + 200).map((x) => ({ ...x, sumber: "erapor", synced_at: now })),
      );
      if (error) throw new Error("Gagal menambah guru: " + error.message);
    }
    for (let i = 0; i < upd.length; i += 10) {
      const res = await Promise.all(upd.slice(i, i + 10).map((x) =>
        db.from("guru_rpm").update({ mapel: x.mapel, sumber: "erapor", synced_at: now }).eq("id", x.id)
      ));
      const bad = res.find((r) => r.error);
      if (bad?.error) throw new Error("Gagal memperbarui guru: " + bad.error.message);
    }
    for (let i = 0; i < del.length; i += 50) {
      const { error } = await db.from("guru_rpm").delete().in("id", del.slice(i, i + 50).map((x) => x.id));
      if (error) throw new Error("Gagal menghapus guru: " + error.message);
    }

    // tahun ajaran aktif ikut diperbarui (tidak menggagalkan sinkron guru bila gagal)
    try { await simpanTahunAjaran(rapor, db, ta); } catch (_) { /* abaikan */ }
    return json({ mode: "apply", ...ringkasan });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
