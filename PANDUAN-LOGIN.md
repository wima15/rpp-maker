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

## Model AI (diatur admin)
Admin menentukan model apa saja yang boleh dipakai guru dan model **default**-nya di **Portal Admin > Model AI**.
- Tidak perlu SQL baru: pengaturan disimpan di `pengaturan_rpm` (kunci `model_ai`), yang sudah hanya bisa ditulis admin.
- Pasang ulang **gemini-proxy** (`gemini-proxy-index.ts`) dan ganti `index.html`. Server menolak model di luar daftar (403), jadi daftar ini bukan sekadar tampilan.
- Tombol **Uji model** mengirim satu permintaan kecil untuk memastikan nama model benar sebelum ditambahkan.
- Aturan aman: model default harus aktif, tidak bisa dihapus/dinonaktifkan sebelum default dipindah, dan hanya ID berawalan `gemini-` yang diterima.
- Bila pengaturan belum ada, rusak, atau database tidak terjangkau, server memakai daftar bawaan (`gemini-3.8-flash` sebagai default; sama dengan `CFG_BAWAAN` di proxy dan `MODEL_SEED` di `index.html`; ubah keduanya bersamaan bila ingin mengganti bawaan).
- Perubahan dari admin berlaku di server paling lama 30 detik kemudian.

## ATP bertahap (3 langkah) atau sekaligus
Di menu Buat ATP ada pilihan **Cara menyusun**:
- **Bertahap, 3 langkah (bawaan, disarankan)**: langkah 1 = identitas, CP, dan kerangka unit + JP (bagian A–B); langkah 2 = tujuan pembelajaran semester pertama (atau separuh pertama unit bila cakupan satu semester); langkah 3 = semester kedua (atau sisa unit) dan catatan pelaksanaan (bagian C lanjutan + D). Setiap langkah menerima hasil langkah sebelumnya sebagai acuan, sehingga nomor unit, JP, dan kode TP tetap konsisten. Setelah tiap langkah guru bisa memeriksa hasilnya, lanjut satu per satu, atau menekan **Selesaikan semua langkah sisanya** (API key dipilih sekali).
- **Sekaligus**: perilaku lama, seluruh ATP dalam satu proses.
- Dokumen baru bisa diunduh, dicetak, disunting, dan disimpan setelah langkah 3 selesai. Tidak perlu perubahan SQL atau Edge Function.
- Bila isian formulir (mapel, fase, cakupan, JP, CP) diubah di tengah langkah, langkah berikutnya ditolak dengan pesan; kembalikan isian atau mulai dari awal.
