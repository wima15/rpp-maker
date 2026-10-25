-- Jalankan sekali di Supabase (SQL Editor) pada project tujuan (yang sama dengan atp_hasil). Aman dijalankan ulang.
-- Menyimpan hasil menu Prota & Prosem. Dokumen disusun dari ATP tersimpan (tabel atp_hasil), tanpa AI.
create table if not exists public.prota_prosem_hasil (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz,
  nama_guru text not null default '',
  kepala_sekolah text not null default '',
  satuan_pendidikan text not null default '',
  mata_pelajaran text not null default '',
  fase text not null default '',
  tahun_ajaran text not null default '',
  atp_id bigint,
  jp_per_minggu int,
  minggu_ganjil int,
  minggu_genap int,
  prota_html text,
  prosem_ganjil_html text,
  prosem_genap_html text
);

-- Bila tabel sudah ada dari versi lama, pastikan semua kolom ada.
alter table public.prota_prosem_hasil add column if not exists updated_at timestamptz;
alter table public.prota_prosem_hasil add column if not exists nama_guru text not null default '';
alter table public.prota_prosem_hasil add column if not exists kepala_sekolah text not null default '';
alter table public.prota_prosem_hasil add column if not exists satuan_pendidikan text not null default '';
alter table public.prota_prosem_hasil add column if not exists mata_pelajaran text not null default '';
alter table public.prota_prosem_hasil add column if not exists fase text not null default '';
alter table public.prota_prosem_hasil add column if not exists tahun_ajaran text not null default '';
alter table public.prota_prosem_hasil add column if not exists atp_id bigint;
alter table public.prota_prosem_hasil add column if not exists jp_per_minggu int;
alter table public.prota_prosem_hasil add column if not exists minggu_ganjil int;
alter table public.prota_prosem_hasil add column if not exists minggu_genap int;
alter table public.prota_prosem_hasil add column if not exists prota_html text;
alter table public.prota_prosem_hasil add column if not exists prosem_ganjil_html text;
alter table public.prota_prosem_hasil add column if not exists prosem_genap_html text;

create index if not exists prota_prosem_guru_idx on public.prota_prosem_hasil (nama_guru, created_at desc);

alter table public.prota_prosem_hasil enable row level security;
drop policy if exists "prota_prosem insert" on public.prota_prosem_hasil;
drop policy if exists "prota_prosem select" on public.prota_prosem_hasil;
drop policy if exists "prota_prosem update" on public.prota_prosem_hasil;
drop policy if exists "prota_prosem delete" on public.prota_prosem_hasil;
create policy "prota_prosem insert" on public.prota_prosem_hasil for insert to anon, authenticated with check (true);
create policy "prota_prosem select" on public.prota_prosem_hasil for select to anon, authenticated using (true);
create policy "prota_prosem update" on public.prota_prosem_hasil for update to anon, authenticated using (true) with check (true);
create policy "prota_prosem delete" on public.prota_prosem_hasil for delete to anon, authenticated using (true);

-- Muat ulang cache skema API agar tabel/kolom langsung dikenali.
notify pgrst, 'reload schema';
