# Panduan Pasang Login Guru (akun E-Rapor)

Setelah ini guru masuk dengan **email + kata sandi E-Rapor**. Data RPM, LKPD, asesmen, ATP, Prota/Prosem,
draf, dan tanda tangan tersimpan per akun; guru lain tidak bisa melihatnya. Admin melihat semua.

Kerjakan **berurutan** di project Supabase tujuan (RPM), kecuali disebut lain.

## 1. Auth: matikan pendaftaran bebas
Authentication → Sign In / Providers → matikan **Allow new users to sign up**.
(Akun dibuat otomatis oleh Edge Function, bukan pendaftaran dari browser.)

## 2. Secret baru
Edge Functions → Secrets. `RAPOR_URL` dan `RAPOR_SERVICE_KEY` sudah ada dari sync-guru. Tambahkan:

| Secret | Isi |
|---|---|
| `RAPOR_ANON_KEY` | anon / publishable key project **E-Rapor** (wajib) |
| `ROLES_BOLEH` | opsional, role E-Rapor yang boleh masuk. Bawaan `guru,admin` |
| `ROLES_ADMIN` | opsional, role yang jadi admin aplikasi. Bawaan `admin` |
| `ADMIN_EMAILS` | opsional, email tambahan yang jadi admin (pisah koma) |
| `ALLOWED_ORIGINS` | disarankan, alamat situs aplikasi (pisah koma) |

Cek isi kolom `role` di tabel `profiles` E-Rapor. Kalau wali kelas / kepala sekolah / admin memakai nama role
lain, masukkan ke `ROLES_BOLEH` / `ROLES_ADMIN`.

## 3. Deploy Edge Function
- **login-guru** → isi dari `login-guru.ts`. **Matikan "Verify JWT"** (dipanggil sebelum ada sesi).
- **gemini-proxy** → isi baru dari `gemini-proxy-index.ts` (sekarang menolak permintaan tanpa login).

## 4. Jalankan SQL
SQL Editor → tempel `tambah-login-guru.sql` → Run. Aman diulang. Isinya:
- kolom `owner_id` + RLS per akun pada `rpm_hasil`, `atp_hasil`, `prota_prosem_hasil`, `rpm_draft`, `identitas_guru`, `api_key_usage`;
- `guru_rpm` ditautkan ke akun (`user_id`), `pengaturan_rpm` hanya ditulis admin;
- storage `gambar-dokumen` dan `tanda-tangan` hanya untuk yang login;
- fungsi `klaim_data_guru` untuk mengaitkan data lama.

> Setelah SQL dijalankan, aplikasi versi lama (tanpa login) tidak bisa lagi membaca data. Pasang `index.html` baru segera.

## 5. Ganti `index.html`
Ganti file di hosting dengan `index.html` baru.

## Cara kerja data lama
Saat guru **pertama kali login**, semua baris lama yang `nama_guru`-nya sama dengan nama di profil E-Rapor
(tanpa membedakan huruf besar/kecil dan spasi ganda) otomatis menjadi miliknya. Jika nama di E-Rapor berbeda
dari nama yang dulu dipilih, data lama tidak ikut; admin masih bisa melihatnya.

## Catatan
- Kata sandi E-Rapor minimal harus memenuhi batas Auth project ini (bawaan 6 karakter).
- Ganti sandi di E-Rapor? Cukup login lagi, sandi cermin ikut diperbarui otomatis.
- Guru baru di E-Rapor otomatis bisa login; jalankan Sinkron E-Rapor agar mata pelajarannya terisi.
- Admin yang login lewat E-Rapor langsung masuk Portal Admin tanpa kata sandi lokal.
- 8 kali salah dalam 10 menit (per IP + email) dikunci sementara.
