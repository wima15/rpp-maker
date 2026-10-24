-- Jalankan sekali di Supabase (SQL Editor) pada project tujuan.
-- Menambah kolom untuk menyimpan Lampiran (Glosarium dan Daftar Pustaka).
alter table public.rpm_hasil add column if not exists lampiran_html text;
