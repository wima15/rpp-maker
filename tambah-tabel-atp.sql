-- Jalankan sekali di Supabase (SQL Editor) pada project tujuan (yang sama dengan rpm_hasil). Aman dijalankan ulang.
-- Menyimpan hasil menu Buat ATP. Pemakaian AI tetap dicatat di tabel api_key_usage yang sudah ada (aksi 'ATP').
create table if not exists public.atp_hasil (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  nama_guru text not null default '',
  kepala_sekolah text not null default '',
  satuan_pendidikan text not null default '',
  mata_pelajaran text not null default '',
  fase text not null default '',
  semester text not null default '',
  tahun_ajaran text not null default '',
  model text not null default '',
  atp_markdown text,
  atp_html text
);
create index if not exists atp_hasil_guru_idx on public.atp_hasil (nama_guru, created_at desc);

alter table public.atp_hasil enable row level security;
drop policy if exists "atp_hasil insert" on public.atp_hasil;
drop policy if exists "atp_hasil select" on public.atp_hasil;
drop policy if exists "atp_hasil update" on public.atp_hasil;
drop policy if exists "atp_hasil delete" on public.atp_hasil;
create policy "atp_hasil insert" on public.atp_hasil for insert to anon, authenticated with check (true);
create policy "atp_hasil select" on public.atp_hasil for select to anon, authenticated using (true);
create policy "atp_hasil update" on public.atp_hasil for update to anon, authenticated using (true) with check (true);
create policy "atp_hasil delete" on public.atp_hasil for delete to anon, authenticated using (true);
