-- Jalankan sekali di Supabase (SQL Editor) pada project tujuan. Aman dijalankan ulang.
-- Bucket untuk gambar yang disisipkan di dokumen (RPM, LKPD, Asesmen, Lampiran, ATP, Prota/Prosem).
-- Gambar diperkecil di browser hingga maks 50 KB sebelum diunggah; bucket juga membatasi 50 KB (51200 byte).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('gambar-dokumen', 'gambar-dokumen', true, 51200, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = true, file_size_limit = 51200, allowed_mime_types = array['image/png','image/jpeg','image/webp'];

drop policy if exists "gambar-dokumen upload" on storage.objects;
create policy "gambar-dokumen upload" on storage.objects
  for insert to anon, authenticated
  with check (bucket_id = 'gambar-dokumen');

-- Bucket publik: gambar bisa dibuka lewat URL tanpa policy select tambahan.

-- Hapus gambar dari storage saat gambar dibuang dari dokumen dan dokumen disimpan.
drop policy if exists "gambar-dokumen baca" on storage.objects;
create policy "gambar-dokumen baca" on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'gambar-dokumen');

drop policy if exists "gambar-dokumen hapus" on storage.objects;
create policy "gambar-dokumen hapus" on storage.objects
  for delete to anon, authenticated
  using (bucket_id = 'gambar-dokumen');
