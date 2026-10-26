-- =========================================================
-- LOGIN GURU + DATA TERPISAH PER AKUN
-- Jalankan sekali di Supabase (SQL Editor) pada project tujuan (RPM). Aman dijalankan ulang.
--
-- Hasil:
--   * Setiap baris data milik satu akun (kolom owner_id = auth.uid()).
--   * Guru hanya bisa membaca/mengubah/menghapus datanya sendiri; admin bisa semuanya.
--   * Akses tanpa login (anon) ke data guru ditutup.
--   * Data lama (tersimpan atas nama guru) dikaitkan otomatis ke akun guru bernama sama
--     saat guru itu pertama kali login (fungsi klaim_data_guru, dipanggil Edge Function login-guru).
--
-- SEBELUM menjalankan: deploy Edge Function login-guru dan set secret-nya (lihat login-guru.ts),
-- lalu di Authentication > Sign In / Providers matikan "Allow new users to sign up".
-- =========================================================

-- ---------- penanda admin (dibaca dari JWT; app_metadata hanya bisa diubah server) ----------
create or replace function public.is_admin() returns boolean
language sql stable as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'is_admin')::boolean, false)
$$;

-- ---------- kolom pemilik + kebijakan baris untuk tabel data guru ----------
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['rpm_hasil','atp_hasil','prota_prosem_hasil','rpm_draft','identitas_guru','api_key_usage'] loop
    if to_regclass('public.' || t) is null then
      raise notice 'Tabel % belum ada, dilewati.', t;
      continue;
    end if;

    execute format('alter table public.%I add column if not exists owner_id uuid default auth.uid()', t);
    execute format('alter table public.%I alter column owner_id set default auth.uid()', t);
    execute format('create index if not exists %I on public.%I (owner_id)', t || '_owner_idx', t);
    execute format('alter table public.%I enable row level security', t);

    -- buang semua kebijakan lama (yang membuka akses ke anon)
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy if exists %I on public.%I', p.policyname, t);
    end loop;

    if t = 'api_key_usage' then
      -- rekap pemakaian API key dihitung dari semua guru (angka saja), jadi baca terbuka untuk yang login
      execute format('create policy %I on public.%I for select to authenticated using (true)', t || ' baca', t);
    else
      execute format('create policy %I on public.%I for select to authenticated using (owner_id = auth.uid() or public.is_admin())', t || ' baca', t);
    end if;
    execute format('create policy %I on public.%I for insert to authenticated with check (owner_id = auth.uid() or public.is_admin())', t || ' tambah', t);
    execute format('create policy %I on public.%I for update to authenticated using (owner_id = auth.uid() or public.is_admin()) with check (owner_id = auth.uid() or public.is_admin())', t || ' ubah', t);
    execute format('create policy %I on public.%I for delete to authenticated using (owner_id = auth.uid() or public.is_admin())', t || ' hapus', t);
  end loop;
end $$;

-- ---------- daftar guru: terhubung ke akun ----------
alter table public.guru_rpm add column if not exists user_id uuid;
create index if not exists guru_rpm_user_idx on public.guru_rpm (user_id);
alter table public.guru_rpm enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'guru_rpm' loop
    execute format('drop policy if exists %I on public.guru_rpm', p.policyname);
  end loop;
end $$;
-- guru hanya melihat barisnya sendiri; admin melihat semua dan boleh mengelola
create policy "guru_rpm baca"   on public.guru_rpm for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "guru_rpm tambah" on public.guru_rpm for insert to authenticated with check (public.is_admin());
create policy "guru_rpm ubah"   on public.guru_rpm for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "guru_rpm hapus"  on public.guru_rpm for delete to authenticated using (public.is_admin());

-- ---------- pengaturan: dibaca semua yang login; ditulis admin (kecuali pengaturan kertas proyek) ----------
alter table public.pengaturan_rpm enable row level security;
do $$
declare p record;
begin
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'pengaturan_rpm' loop
    execute format('drop policy if exists %I on public.pengaturan_rpm', p.policyname);
  end loop;
end $$;
create policy "pengaturan baca"   on public.pengaturan_rpm for select to authenticated using (true);
create policy "pengaturan tambah" on public.pengaturan_rpm for insert to authenticated with check (public.is_admin() or kunci like 'kertas:%');
create policy "pengaturan ubah"   on public.pengaturan_rpm for update to authenticated using (public.is_admin() or kunci like 'kertas:%') with check (public.is_admin() or kunci like 'kertas:%');
create policy "pengaturan hapus"  on public.pengaturan_rpm for delete to authenticated using (public.is_admin());

-- ---------- storage: gambar dokumen & tanda tangan hanya untuk yang login ----------
do $$
declare b text;
begin
  foreach b in array array['gambar-dokumen','tanda-tangan'] loop
    execute format('drop policy if exists %I on storage.objects', b || ' upload');
    execute format('drop policy if exists %I on storage.objects', b || ' baca');
    execute format('drop policy if exists %I on storage.objects', b || ' ubah');
    execute format('drop policy if exists %I on storage.objects', b || ' hapus');
    execute format('create policy %I on storage.objects for insert to authenticated with check (bucket_id = %L)', b || ' upload', b);
    execute format('create policy %I on storage.objects for select to authenticated using (bucket_id = %L)', b || ' baca', b);
    execute format('create policy %I on storage.objects for update to authenticated using (bucket_id = %L) with check (bucket_id = %L)', b || ' ubah', b, b);
    execute format('create policy %I on storage.objects for delete to authenticated using (bucket_id = %L)', b || ' hapus', b);
  end loop;
end $$;

-- ---------- klaim data lama berdasarkan nama guru ----------
-- Hanya boleh dipanggil server (service_role) dari Edge Function login-guru.
create or replace function public.klaim_data_guru(p_uid uuid, p_nama text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  t text; n integer; total integer := 0;
  kunci text := lower(regexp_replace(trim(coalesce(p_nama, '')), '\s+', ' ', 'g'));
begin
  if kunci = '' then return 0; end if;
  foreach t in array array['rpm_hasil','atp_hasil','prota_prosem_hasil','rpm_draft','identitas_guru','api_key_usage'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format(
      'update public.%I set owner_id = $1 where owner_id is null and lower(regexp_replace(trim(coalesce(nama_guru, '''')), ''\s+'', '' '', ''g'')) = $2', t)
      using p_uid, kunci;
    get diagnostics n = row_count;
    total := total + n;
  end loop;
  return total;
end $$;
revoke all on function public.klaim_data_guru(uuid, text) from public, anon, authenticated;
grant execute on function public.klaim_data_guru(uuid, text) to service_role;

notify pgrst, 'reload schema';
