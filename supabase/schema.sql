begin;

create schema if not exists auraboost_private;
revoke all on schema auraboost_private from public, anon, authenticated;
grant usage on schema auraboost_private to authenticated;

create table if not exists auraboost_private.owner (
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users(id) on delete cascade
);

alter table auraboost_private.owner enable row level security;
revoke all on auraboost_private.owner from public, anon, authenticated, service_role;

create or replace function auraboost_private.is_owner()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auraboost_private.owner o
    where o.user_id = (select auth.uid())
  );
$$;

revoke all on function auraboost_private.is_owner() from public, anon, authenticated;
grant execute on function auraboost_private.is_owner() to authenticated;

create table if not exists public.auraboost_steam_accounts (
  user_id uuid not null references auth.users(id) on delete cascade,
  steam_id text not null check (steam_id ~ '^[0-9]{17}$'),
  name text not null check (char_length(name) between 1 and 160),
  avatar text check (char_length(avatar) <= 2048),
  presence text check (char_length(presence) <= 100),
  online boolean,
  synced_at timestamptz,
  library_status text not null default 'pending'
    check (library_status in ('pending', 'available', 'unavailable', 'unconfigured')),
  config jsonb not null default '{"title":"","description":"","reply":"","selected":[],"favorites":[],"profiles":[]}'::jsonb
    check (jsonb_typeof(config) = 'object'),
  games jsonb not null default '[]'::jsonb check (jsonb_typeof(games) = 'array'),
  created_at timestamptz not null default current_timestamp,
  primary key (user_id, steam_id)
);

create table if not exists public.auraboost_user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  selected_account_id text,
  foreign key (user_id, selected_account_id)
    references public.auraboost_steam_accounts(user_id, steam_id) on delete set null (selected_account_id)
);

create table if not exists public.auraboost_history (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  steam_id text not null,
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default current_timestamp,
  foreign key (user_id, steam_id) references public.auraboost_steam_accounts(user_id, steam_id) on delete cascade
);

create index if not exists auraboost_history_by_account
  on public.auraboost_history (user_id, steam_id, created_at desc, id desc);

alter table public.auraboost_steam_accounts enable row level security;
alter table public.auraboost_steam_accounts force row level security;
alter table public.auraboost_user_settings enable row level security;
alter table public.auraboost_user_settings force row level security;
alter table public.auraboost_history enable row level security;
alter table public.auraboost_history force row level security;

revoke all on public.auraboost_steam_accounts, public.auraboost_user_settings, public.auraboost_history
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.auraboost_steam_accounts to authenticated;
grant select, insert, update on public.auraboost_user_settings to authenticated;
grant select, insert on public.auraboost_history to authenticated;

drop policy if exists auraboost_owner on public.auraboost_steam_accounts;
create policy auraboost_owner on public.auraboost_steam_accounts for all to authenticated
using (user_id = (select auth.uid()) and (select auraboost_private.is_owner()))
with check (user_id = (select auth.uid()) and (select auraboost_private.is_owner()));

drop policy if exists auraboost_owner on public.auraboost_user_settings;
create policy auraboost_owner on public.auraboost_user_settings for all to authenticated
using (user_id = (select auth.uid()) and (select auraboost_private.is_owner()))
with check (user_id = (select auth.uid()) and (select auraboost_private.is_owner()));

drop policy if exists auraboost_owner on public.auraboost_history;
create policy auraboost_owner on public.auraboost_history for all to authenticated
using (user_id = (select auth.uid()) and (select auraboost_private.is_owner()))
with check (user_id = (select auth.uid()) and (select auraboost_private.is_owner()));

create or replace function auraboost_private.record_steam_activity()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  history_text text;
begin
  if tg_op = 'INSERT' then
    history_text := 'Cuenta de Steam vinculada.';
  elsif new.synced_at is not null and new.synced_at is distinct from old.synced_at then
    history_text := case new.library_status
      when 'available' then pg_catalog.format('Biblioteca sincronizada. %s juegos recibidos.', pg_catalog.jsonb_array_length(new.games))
      when 'unavailable' then 'Steam no devolvió una biblioteca visible.'
      when 'unconfigured' then 'La consulta a Steam requiere una clave Web API.'
    end;
  end if;

  if history_text is not null then
    insert into public.auraboost_history (user_id, steam_id, text) values (new.user_id, new.steam_id, history_text);
  end if;
  return null;
end;
$$;

revoke all on function auraboost_private.record_steam_activity() from public, anon, authenticated, service_role;
drop trigger if exists auraboost_steam_activity on public.auraboost_steam_accounts;
create trigger auraboost_steam_activity
after insert or update of synced_at on public.auraboost_steam_accounts
for each row execute function auraboost_private.record_steam_activity();

create or replace function public.auraboost_update_account_config(account_id text, config_patch jsonb)
returns setof public.auraboost_steam_accounts
language sql
security invoker
set search_path = ''
as $$
  update public.auraboost_steam_accounts a
  set config = a.config || config_patch
  where a.user_id = (select auth.uid()) and a.steam_id = account_id
    and jsonb_typeof(config_patch) = 'object'
  returning a.*;
$$;

revoke all on function public.auraboost_update_account_config(text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.auraboost_update_account_config(text, jsonb) to authenticated;

-- Only the server accesses these rows. The cookie ID is hashed and the session payload is encrypted in Node.js.
create table if not exists public.auraboost_sessions (
  id_hash text primary key check (id_hash ~ '^[a-f0-9]{64}$'),
  encrypted_value text not null check (
    char_length(encrypted_value) <= 65536 and
    encrypted_value ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]*$'
  ),
  expires_at timestamptz not null
);

create index if not exists auraboost_sessions_by_expiry on public.auraboost_sessions (expires_at);

alter table public.auraboost_sessions enable row level security;
alter table public.auraboost_sessions force row level security;
revoke all on public.auraboost_sessions from public, anon, authenticated, service_role;
grant select, insert, update, delete on public.auraboost_sessions to service_role;

commit;

-- After creating the only authorized user in Supabase Auth, run the following statement
-- separately in the SQL Editor with the real UUID from Authentication > Users:
-- insert into auraboost_private.owner (user_id) values ('REPLACE_WITH_AUTH_USER_UUID');
