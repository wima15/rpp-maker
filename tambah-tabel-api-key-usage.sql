-- Jalankan di Supabase (SQL Editor) pada project tujuan. Aman dijalankan ulang.
-- Mencatat setiap klik yang memakai AI (Buat RPM, LKPD, Asesmen, Lampiran).
create table if not exists public.api_key_usage (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  tanggal date not null,
  key_slot text not null default 'auto',
  aksi text not null default '',
  model text not null default '',
  nama_guru text not null default ''
);
-- nomor API KEY yang benar-benar dipakai server (diisi dari header x-key-used), mis. '2' atau '1,3'
alter table public.api_key_usage add column if not exists key_dipakai text not null default '';
create index if not exists api_key_usage_tanggal_idx on public.api_key_usage (tanggal);

alter table public.api_key_usage enable row level security;
drop policy if exists "api_key_usage insert" on public.api_key_usage;
drop policy if exists "api_key_usage select" on public.api_key_usage;
drop policy if exists "api_key_usage update" on public.api_key_usage;
create policy "api_key_usage insert" on public.api_key_usage for insert to anon, authenticated with check (true);
create policy "api_key_usage select" on public.api_key_usage for select to anon, authenticated using (true);
create policy "api_key_usage update" on public.api_key_usage for update to anon, authenticated using (true) with check (true);
