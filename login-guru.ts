// =========================================================
// EDGE FUNCTION: login-guru  (project Supabase RPM / tujuan)
// Login memakai akun E-Rapor (email + kata sandi yang sama).
//
// Alur:
//   1. Email + sandi diperiksa ke Supabase Auth milik E-Rapor.
//   2. Profil (nama, role) dibaca dari tabel profiles E-Rapor.
//   3. Akun cermin dibuat/diperbarui di Auth project ini (sandi disamakan, nama & status admin
//      disimpan di app_metadata, yang hanya bisa diubah server).
//   4. Baris guru_rpm bernama sama ditautkan ke akun, dan data lama atas nama guru itu
//      diklaim (fungsi SQL klaim_data_guru).
//   5. Browser lalu login biasa ke Auth project ini dengan email + sandi yang sama untuk
//      mendapat sesi (access token + refresh token). Semua RLS memakai sesi itu.
//
// Deploy: matikan "Verify JWT" (browser memanggil ini sebelum punya sesi, hanya membawa apikey).
//
// Secret (Edge Functions > Secrets):
//   RAPOR_URL          = https://iejpwxmcqwecejsrezry.supabase.co      (sudah ada untuk sync-guru)
//   RAPOR_SERVICE_KEY  = service_role E-Rapor                          (sudah ada untuk sync-guru)
//   RAPOR_ANON_KEY     = anon / publishable key E-Rapor                (BARU)
//   ROLES_BOLEH        = (opsional) role E-Rapor yang boleh masuk, pisah koma. Bawaan: guru,admin
//   ROLES_ADMIN        = (opsional) role E-Rapor yang menjadi admin aplikasi ini. Bawaan: admin
//   ADMIN_EMAILS       = (opsional) email tambahan yang menjadi admin, pisah koma
//   ALLOWED_ORIGINS    = (disarankan) alamat situs yang boleh memanggil, pisah koma
//
// Permintaan (POST, JSON): { email, password }
// Respons sukses: { ok: true, nama, is_admin, diklaim }   Gagal: { ok:false, error }
// =========================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const RAPOR_URL = (Deno.env.get("RAPOR_URL") ?? "").replace(/\/+$/, "");
const RAPOR_SERVICE_KEY = Deno.env.get("RAPOR_SERVICE_KEY") ?? "";
const RAPOR_ANON_KEY = Deno.env.get("RAPOR_ANON_KEY") ?? "";
const list = (v: string | undefined, d: string) =>
  (v ?? d).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ROLES_BOLEH = list(Deno.env.get("ROLES_BOLEH"), "guru,admin");
const ROLES_ADMIN = list(Deno.env.get("ROLES_ADMIN"), "admin");
const ADMIN_EMAILS = list(Deno.env.get("ADMIN_EMAILS"), "");
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);

function corsFor(origin: string | null) {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.length ? (origin ?? "") : "*",
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function out(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsFor(origin) },
  });
}
const gagal = (msg: string, status: number, origin: string | null) => out({ ok: false, error: msg }, status, origin);

const norm = (s: unknown) => String(s ?? "").trim();
const nkey = (s: unknown) => norm(s).toLowerCase().replace(/\s+/g, " ");

// pembatas percobaan: 8 kali gagal per 10 menit untuk pasangan IP + email
const gagalCatat = new Map<string, number[]>();
const JENDELA = 10 * 60_000, BATAS = 8;
function terlaluBanyak(k: string) {
  const now = Date.now();
  return (gagalCatat.get(k) ?? []).filter((t) => now - t < JENDELA).length >= BATAS;
}
function catatGagal(k: string) {
  const now = Date.now();
  const a = (gagalCatat.get(k) ?? []).filter((t) => now - t < JENDELA);
  a.push(now); gagalCatat.set(k, a);
  if (gagalCatat.size > 5000) gagalCatat.clear();
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsFor(origin) });
  if (req.method !== "POST") return gagal("Method not allowed", 405, origin);
  if (ALLOWED_ORIGINS.length && !(origin && ALLOWED_ORIGINS.includes(origin.replace(/\/+$/, "")))) {
    return gagal("Asal permintaan tidak diizinkan.", 403, origin);
  }
  if (!RAPOR_URL || !RAPOR_SERVICE_KEY || !RAPOR_ANON_KEY) {
    return gagal("Secret RAPOR_URL, RAPOR_SERVICE_KEY, dan RAPOR_ANON_KEY belum lengkap di Edge Functions.", 500, origin);
  }

  const body = await req.json().catch(() => ({}));
  const email = norm(body.email).toLowerCase();
  const password = String(body.password ?? "");
  if (!email || !password) return gagal("Isi email dan kata sandi.", 400, origin);
  if (email.length > 200 || password.length > 200) return gagal("Email atau kata sandi tidak valid.", 400, origin);

  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "anon";
  const kunciBatas = ip + "|" + email;
  if (terlaluBanyak(kunciBatas)) return gagal("Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.", 429, origin);

  try {
    // 1. verifikasi ke Auth E-Rapor
    const v = await fetch(`${RAPOR_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: RAPOR_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
    const vd = await v.json().catch(() => ({}));
    if (!v.ok || !vd?.user?.id) {
      catatGagal(kunciBatas);
      return gagal("Email atau kata sandi salah.", 401, origin);
    }
    const raporId = String(vd.user.id);

    // 2. profil di E-Rapor
    const rapor = createClient(RAPOR_URL, RAPOR_SERVICE_KEY);
    const { data: prof, error: pe } = await rapor.from("profiles").select("id,nama,role").eq("id", raporId).maybeSingle();
    if (pe) return gagal("E-Rapor: " + pe.message, 502, origin);
    const role = nkey(prof?.role);
    const nama = norm(prof?.nama);
    if (!prof || !nama) return gagal("Akun ini belum punya profil guru di E-Rapor.", 403, origin);
    if (!ROLES_BOLEH.includes(role)) return gagal("Akun ini tidak diizinkan memakai aplikasi (role: " + (prof.role ?? "-") + ").", 403, origin);
    const isAdmin = ROLES_ADMIN.includes(role) || ADMIN_EMAILS.includes(email);

    // 3. akun cermin di Auth project ini
    const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const meta = { nama_guru: nama, is_admin: isAdmin, rapor_id: raporId, role };
    let uid = "";
    const baru = await db.auth.admin.createUser({ email, password, email_confirm: true, app_metadata: meta });
    if (baru.data?.user?.id) {
      uid = baru.data.user.id;
    } else {
      // sudah ada: cari lewat email, samakan sandi dan metadata
      for (let page = 1; page <= 20 && !uid; page++) {
        const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return gagal("Auth: " + error.message, 502, origin);
        const u = data.users.find((x) => (x.email ?? "").toLowerCase() === email);
        if (u) uid = u.id;
        if (data.users.length < 1000) break;
      }
      if (!uid) return gagal("Gagal membuat akun: " + (baru.error?.message ?? "tidak diketahui"), 500, origin);
      const up = await db.auth.admin.updateUserById(uid, { password, email_confirm: true, app_metadata: meta });
      if (up.error) return gagal("Gagal memperbarui akun: " + up.error.message, 500, origin);
    }

    // 4. tautkan ke guru_rpm dan klaim data lama
    let diklaim = 0;
    try {
      const { data: rows } = await db.from("guru_rpm").select("id,nama,user_id").limit(5000);
      const hit = (rows ?? []).find((r: { nama: string }) => nkey(r.nama) === nkey(nama));
      if (hit && hit.user_id !== uid) await db.from("guru_rpm").update({ user_id: uid }).eq("id", hit.id);
      const { data: n } = await db.rpc("klaim_data_guru", { p_uid: uid, p_nama: nama });
      diklaim = Number(n ?? 0);
    } catch (_) { /* tidak menggagalkan login */ }

    return out({ ok: true, nama, is_admin: isAdmin, diklaim }, 200, origin);
  } catch (e) {
    return gagal("Kesalahan server: " + String(e).slice(0, 200), 500, origin);
  }
});
