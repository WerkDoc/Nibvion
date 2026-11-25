-- Nibvion-Cloud: einmal im Supabase-Projekt ausführen (SQL Editor → New query → Run)
-- Alles ist Ende-zu-Ende verschlüsselt: Supabase sieht nur Schlüsselnamen, Zeitstempel und verschlüsselte Dateien.

-- 1) Liste der Einträge (je Gerät-übergreifendem Objekt eine Zeile)
create table if not exists public.nib_items (
  user_id   uuid not null references auth.users on delete cascade,
  k         text not null,
  updated   bigint not null,
  deleted   boolean not null default false,
  size      integer not null default 0,
  server_ts timestamptz not null default clock_timestamp(),
  primary key (user_id, k)
);
create index if not exists nib_items_ts on public.nib_items (user_id, server_ts);

create or replace function public.nib_touch() returns trigger language plpgsql as $$
begin new.server_ts := clock_timestamp(); return new; end $$;
drop trigger if exists nib_touch on public.nib_items;
create trigger nib_touch before insert or update on public.nib_items for each row execute function public.nib_touch();

alter table public.nib_items enable row level security;
drop policy if exists "nib items own" on public.nib_items;
create policy "nib items own" on public.nib_items for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 2) Verpackter Datenschlüssel (nur mit deinem Passwort zu öffnen)
create table if not exists public.nib_keys (
  user_id uuid primary key references auth.users on delete cascade,
  wrapped text not null,
  iv      text not null default '',
  created timestamptz not null default now()
);
alter table public.nib_keys enable row level security;
drop policy if exists "nib keys own" on public.nib_keys;
create policy "nib keys own" on public.nib_keys for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- 3) Privater Speicher für die verschlüsselten Dateien (Ordner = Benutzer-ID)
insert into storage.buckets (id, name, public, file_size_limit)
values ('nibvion', 'nibvion', false, 52428800)
on conflict (id) do nothing;

drop policy if exists "nib files select" on storage.objects;
drop policy if exists "nib files insert" on storage.objects;
drop policy if exists "nib files update" on storage.objects;
drop policy if exists "nib files delete" on storage.objects;
create policy "nib files select" on storage.objects for select to authenticated
  using (bucket_id = 'nibvion' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "nib files insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'nibvion' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "nib files update" on storage.objects for update to authenticated
  using (bucket_id = 'nibvion' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "nib files delete" on storage.objects for delete to authenticated
  using (bucket_id = 'nibvion' and (storage.foldername(name))[1] = auth.uid()::text);
