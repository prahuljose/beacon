-- Debt crew portal: database schema (v2: per-character logins, scenes, vault).
--
-- This file can be re-run on an existing database (it drops and recreates the
-- functions and only adds what is missing).
--
-- Every table has RLS on and no policies, so the public (anon) key can't touch
-- them directly. The browser calls only the functions below. Apart from
-- login_options() and login(), each one takes a session token that login()
-- handed out.
--
--   GM      logs in with the GM password and can do everything.
--   Player  logs in as one character with the password the GM set for it, and
--           may edit only that character (minus locked areas).
--
-- The GM password lives as a bcrypt hash in private.secret. Set it in-app from
-- the GM page, or here: select private.set_secret('gm', '…');

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists private.secret (
  kind text primary key,
  hash text not null
);
alter table private.secret drop constraint if exists secret_kind_check;
delete from private.secret where kind = 'entry';   -- v1 shared password, retired

create table if not exists public.sheets (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null default '{}'::jsonb,
  sort       int not null default 0,
  locked     boolean not null default false,  -- GM lock on identity/appearance/backstory/gear
  pass_hash  text,                            -- this character's login password (bcrypt)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);
alter table public.sheets add column if not exists locked boolean not null default false;
alter table public.sheets add column if not exists pass_hash text;

create table if not exists private.sessions (
  token      text primary key,
  role       text not null check (role in ('gm', 'player')),
  sheet_id   uuid references public.sheets(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.crew (
  id          int primary key default 1 check (id = 1),
  grit        int not null default 0 check (grit between 0 and 10),
  grit_open   boolean not null default true,   -- session Grit roll allowed
  scene_id    uuid,
  scene_shown boolean not null default false,
  updated_at  timestamptz not null default clock_timestamp()
);
alter table public.crew add column if not exists grit_open boolean not null default true;
alter table public.crew add column if not exists scene_id uuid;
alter table public.crew add column if not exists scene_shown boolean not null default false;
insert into public.crew (id) values (1) on conflict do nothing;

create table if not exists public.rolls (
  id          bigint generated always as identity primary key,
  sheet_id    uuid references public.sheets(id) on delete set null,
  who         text not null default '',
  label       text not null default '',
  kind        text not null default 'free',
  sides       int not null,
  dice        int[] not null,
  modifier    int not null default 0,
  mult        int not null default 1,
  parts       jsonb not null default '[]'::jsonb,  -- [{label, value}] why each modifier was added
  extras      jsonb not null default '[]'::jsonb,  -- [{who, die}] Grit dice (max 1)
  history     jsonb not null default '[]'::jsonb,  -- [{dice, who}] dice replaced by Wear rerolls
  rerolls     int not null default 0,
  wear_marked int not null default 0,              -- 1 once someone took the Wear offered for doubles
  total       int not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default clock_timestamp()
);
alter table public.rolls add column if not exists parts jsonb not null default '[]'::jsonb;
alter table public.rolls add column if not exists history jsonb not null default '[]'::jsonb;
create index if not exists rolls_updated_idx on public.rolls (updated_at);
create index if not exists rolls_sheet_idx on public.rolls (sheet_id);

create table if not exists public.gm_notes (
  id         int primary key default 1 check (id = 1),
  body       text not null default '',
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.gm_notes (id) values (1) on conflict do nothing;

create table if not exists public.scenes (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null default 'image' check (kind in ('image', 'vault')),
  title      text not null default '',
  caption    text not null default '',
  image      text,   -- data URL, fetched on demand
  thumb      text,   -- small data URL for the GM's scene list
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.scenes (kind, title, sort)
select 'vault', 'The Vault', 0 where not exists (select 1 from public.scenes where kind = 'vault');

-- The Vault: 100 boxes, A1–Y4 (25 letters × 4).
create table if not exists public.vault_boxes (
  code       text primary key,
  state      text not null default '' check (state in ('', 'open', 'progress', 'complete')),
  updated_by text not null default '',
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.vault_boxes (code)
select chr(64 + l) || n from generate_series(1, 25) l, generate_series(1, 4) n
on conflict do nothing;

alter table public.sheets      enable row level security;
alter table public.crew        enable row level security;
alter table public.rolls       enable row level security;
alter table public.gm_notes    enable row level security;
alter table public.scenes      enable row level security;
alter table public.vault_boxes enable row level security;
alter table private.secret     enable row level security;
alter table private.sessions   enable row level security;

revoke all on all tables in schema public  from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated, public;
revoke all on schema private from anon, authenticated, public;

-- ── Drop v1 functions (shared-password API) ────────────────────────────────

drop function if exists public.check_pass(text);
drop function if exists public.sync(text, timestamptz);
drop function if exists public.create_sheet(text, jsonb);
drop function if exists public.patch_sheet(text, uuid, text[], jsonb);
drop function if exists public.delete_sheet(text, uuid);
drop function if exists public.set_grit(text, int);
drop function if exists public.adjust_grit(text, int);
drop function if exists public.roll(text, uuid, text, text, text, int, int, int, int);
drop function if exists public.spend_grit(text, bigint, text);
drop function if exists public.reroll(text, bigint);
drop function if exists public.gm_get_notes(text);
drop function if exists public.gm_set_notes(text, text);
drop function if exists public.gm_clear_rolls(text);
drop function if exists public.gm_deleted_sheets(text);
drop function if exists public.gm_restore_sheet(text, uuid);
drop function if exists private.guard(text, text);
drop function if exists private.mark_wear(uuid, int);

-- ── Private helpers (not reachable through the API) ────────────────────────

create or replace function private.set_secret(p_kind text, p_plain text)
returns void language sql security definer set search_path = '' as $$
  insert into private.secret (kind, hash)
  values (p_kind, extensions.crypt(p_plain, extensions.gen_salt('bf')))
  on conflict (kind) do update set hash = excluded.hash;
$$;

create or replace function private.ok(p_pass text, p_kind text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.secret s
    where s.kind = p_kind and s.hash = extensions.crypt(coalesce(p_pass, ''), s.hash)
  );
$$;

-- The caller's session, or an error. p_need = 'gm' also requires the GM.
create or replace function private.me(p_token text, p_need text default 'any')
returns private.sessions language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions;
begin
  select * into s from private.sessions where token = coalesce(p_token, '');
  if s.token is null or s.created_at < now() - interval '90 days' then
    raise exception 'bad_session' using errcode = '28P01';
  end if;
  if p_need = 'gm' and s.role <> 'gm' then
    raise exception 'gm_only' using errcode = '42501';
  end if;
  return s;
end $$;

create or replace function private.who(s private.sessions)
returns text language sql stable security definer set search_path = '' as $$
  select case when s.role = 'gm' then 'GM'
              else coalesce((select data->>'name' from public.sheets where id = s.sheet_id), 'Player') end;
$$;

create or replace function private.can_edit(s private.sessions, p_sheet uuid)
returns boolean language sql stable set search_path = '' as $$
  select s.role = 'gm' or s.sheet_id = p_sheet;
$$;

create or replace function private.roll_total(r public.rolls)
returns int language sql immutable set search_path = '' as $$
  select ((select coalesce(sum(d), 0) from unnest(r.dice) d)
        + (select coalesce(sum((e->>'die')::int), 0) from jsonb_array_elements(r.extras) e)
        + r.modifier) * r.mult;
$$;

create or replace function private.vault_visible()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.crew c join public.scenes sc on sc.id = c.scene_id
                 where c.id = 1 and c.scene_shown and sc.kind = 'vault');
$$;

create or replace function private.dice(n int, sides int)
returns int[] language sql volatile set search_path = '' as $$
  select array_agg(1 + floor(random() * sides)::int) from generate_series(1, n);
$$;

-- ── Login ──────────────────────────────────────────────────────────────────

-- Who can log in. Public on purpose: names and portraits only (fictional characters).
create or replace function public.login_options()
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', id, 'name', data->>'name', 'accent', coalesce(data->>'accent', ''),
           'portrait', coalesce(data->>'portrait', ''), 'ready', pass_hash is not null)
         order by sort, created_at), '[]'::jsonb)
  from public.sheets where deleted_at is null;
$$;

-- p_sheet null = log in as GM.
create or replace function public.login(p_sheet uuid, p_pass text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare good boolean; tok text; r text := case when p_sheet is null then 'gm' else 'player' end;
begin
  if p_sheet is null then
    good := private.ok(p_pass, 'gm');
  else
    select pass_hash is not null and pass_hash = extensions.crypt(coalesce(p_pass, ''), pass_hash)
      into good from public.sheets where id = p_sheet and deleted_at is null;
  end if;
  if not coalesce(good, false) then
    perform pg_sleep(0.4);
    raise exception 'bad_login' using errcode = '28000';
  end if;
  tok := encode(extensions.gen_random_bytes(24), 'hex');
  insert into private.sessions (token, role, sheet_id) values (tok, r, p_sheet);
  delete from private.sessions where created_at < now() - interval '90 days';
  return jsonb_build_object('token', tok, 'role', r, 'sheet_id', p_sheet);
end $$;

create or replace function public.logout(p_token text)
returns void language sql security definer set search_path = '' as $$
  delete from private.sessions where token = p_token;
$$;

-- ── Sync ───────────────────────────────────────────────────────────────────

-- Everything that changed since p_since (server clock). The client keeps the
-- returned `now` and asks again from there, with a few seconds of overlap.
create or replace function public.sync(p_token text, p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  s private.sessions := private.me(p_token);
  gm boolean := s.role = 'gm';
  since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
  c public.crew;
begin
  select * into c from public.crew where id = 1;
  return jsonb_build_object(
    'now', clock_timestamp(),
    'me', jsonb_build_object('role', s.role, 'sheet_id', s.sheet_id),
    'grit', c.grit,
    'grit_open', c.grit_open,
    'scene', (select jsonb_build_object('id', sc.id, 'kind', sc.kind, 'title', sc.title,
                                        'caption', sc.caption, 'updated_at', sc.updated_at)
              from public.scenes sc where sc.id = c.scene_id and (c.scene_shown or gm)),
    'scene_shown', c.scene_shown,
    'scenes_sig', case when gm then (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.scenes) end,
    'vault', case when gm or private.vault_visible() then (
      select coalesce(jsonb_agg(jsonb_build_object('code', code, 'state', state, 'by', updated_by)), '[]'::jsonb)
      from public.vault_boxes where updated_at > since) end,
    'roll_min', (select min(id) from public.rolls),
    'sheets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'data', sh.data, 'sort', sh.sort, 'locked', sh.locked,
               'has_pass', case when gm then sh.pass_hash is not null end,
               'updated_at', sh.updated_at, 'deleted', sh.deleted_at is not null)
             order by sh.sort, sh.created_at)
      from public.sheets sh
      where sh.updated_at > since and (p_since is not null or sh.deleted_at is null)
    ), '[]'::jsonb),
    'rolls', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id)
      from (select * from public.rolls r where r.updated_at > since order by r.id desc limit 150) r
    ), '[]'::jsonb)
  );
end $$;

-- ── Sheets ─────────────────────────────────────────────────────────────────

create or replace function public.create_sheet(p_token text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  perform private.me(p_token, 'gm');
  insert into public.sheets (data, sort)
  values (coalesce(p_data, '{}'::jsonb), (select coalesce(max(sort), 0) + 1 from public.sheets))
  returning id into new_id;
  return new_id;
end $$;

-- Sets one value inside a sheet's JSON (missing parent objects are created).
-- An empty path replaces the whole sheet (GM only).
create or replace function public.patch_sheet(p_token text, p_id uuid, p_path text[], p_value jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  s private.sessions := private.me(p_token);
  d jsonb; lk boolean; i int; ts timestamptz := clock_timestamp();
begin
  if not private.can_edit(s, p_id) then raise exception 'not_yours' using errcode = '42501'; end if;
  if pg_column_size(p_value) > 600000 then raise exception 'too_big'; end if;
  select data, locked into d, lk from public.sheets where id = p_id and deleted_at is null for update;
  if d is null then raise exception 'not_found'; end if;

  if s.role <> 'gm' then
    if coalesce(array_length(p_path, 1), 0) = 0 then raise exception 'not_allowed' using errcode = '42501'; end if;
    if lk and p_path[1] = any (array['name', 'player', 'job', 'specialty', 'vice', 'virtue',
                                     'portrait', 'look', 'backstory', 'gear']) then
      raise exception 'locked' using errcode = '42501';
    end if;
  end if;

  if coalesce(array_length(p_path, 1), 0) = 0 then
    d := p_value;
  else
    for i in 1 .. array_length(p_path, 1) - 1 loop
      if jsonb_typeof(d #> p_path[1:i]) is distinct from 'object'
         and jsonb_typeof(d #> p_path[1:i]) is distinct from 'array' then
        d := jsonb_set(d, p_path[1:i], '{}'::jsonb, true);
      end if;
    end loop;
    d := jsonb_set(d, p_path, coalesce(p_value, 'null'::jsonb), true);
  end if;

  update public.sheets set data = d, updated_at = ts where id = p_id;
  return ts;
end $$;

create or replace function public.delete_sheet(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.sheets set deleted_at = now(), updated_at = clock_timestamp()
   where id = p_id and deleted_at is null;
  delete from private.sessions where sheet_id = p_id;
end $$;

-- ── Grit ───────────────────────────────────────────────────────────────────

create or replace function public.set_grit(p_token text, p_value int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int := greatest(0, least(10, coalesce(p_value, 0)));
begin
  perform private.me(p_token, 'gm');
  update public.crew set grit = v, updated_at = clock_timestamp() where id = 1;
  return v;
end $$;

create or replace function public.adjust_grit(p_token text, p_delta int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform private.me(p_token, 'gm');
  update public.crew set grit = greatest(0, least(10, grit + coalesce(p_delta, 0))), updated_at = clock_timestamp()
   where id = 1 returning grit into v;
  return v;
end $$;

create or replace function public.gm_set_grit_open(p_token text, p_open boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.crew set grit_open = coalesce(p_open, false), updated_at = clock_timestamp() where id = 1;
end $$;

-- ── Dice ───────────────────────────────────────────────────────────────────

-- Rolls on the server so everyone sees the same result. Players always roll as
-- their own character. p_parts lists each modifier and why: [{label, value}].
-- kind 'grit_session' rolls 1d6, sets the Grit pool and closes the session roll.
create or replace function public.roll(
  p_token text, p_sheet uuid, p_label text, p_kind text, p_n int, p_sides int, p_parts jsonb default '[]'::jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s private.sessions := private.me(p_token);
  r public.rolls; sheet uuid := p_sheet; who text; parts jsonb := coalesce(p_parts, '[]'::jsonb);
  m int; n int := p_n; sides int := p_sides; open boolean;
begin
  if s.role = 'player' then sheet := s.sheet_id; end if;
  if sheet is not null then
    select data->>'name' into who from public.sheets where id = sheet and deleted_at is null;
    if who is null then raise exception 'not_found'; end if;
  else
    who := 'GM';
  end if;

  if jsonb_typeof(parts) <> 'array' or jsonb_array_length(parts) > 12 then raise exception 'bad_roll'; end if;
  select coalesce(sum((p->>'value')::int), 0) into m from jsonb_array_elements(parts) p;

  if p_kind = 'grit_session' then
    select grit_open into open from public.crew where id = 1 for update;
    if not open and s.role <> 'gm' then raise exception 'grit_closed'; end if;
    n := 1; sides := 6; m := 0; parts := '[]'::jsonb;
  end if;
  if n not between 1 and 30 or sides not between 2 and 1000 or m not between -99 and 99 then
    raise exception 'bad_roll';
  end if;

  insert into public.rolls (sheet_id, who, label, kind, sides, dice, modifier, parts, total)
  values (sheet, left(who, 60), left(coalesce(p_label, ''), 120), left(coalesce(p_kind, 'free'), 20),
          sides, private.dice(n, sides), m, parts, 0)
  returning * into r;
  r.total := private.roll_total(r);
  update public.rolls set total = r.total where id = r.id;

  if p_kind = 'grit_session' then
    update public.crew set grit = greatest(0, least(10, r.total)), grit_open = false, updated_at = clock_timestamp()
     where id = 1;
  end if;
  return to_jsonb(r);
end $$;

-- Spend 1 Grit to add 1d6 to any d6 roll, yours or anyone else's. Max 1 per roll.
create or replace function public.spend_grit(p_token text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); r public.rolls; g int;
begin
  select grit into g from public.crew where id = 1 for update;
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.sides <> 6 or r.kind = 'grit_session' then raise exception 'not_d6'; end if;
  if jsonb_array_length(r.extras) >= 1 then raise exception 'grit_max'; end if;
  if g < 1 then raise exception 'no_grit'; end if;

  r.extras := jsonb_build_array(jsonb_build_object('who', private.who(s), 'die', 1 + floor(random() * 6)::int));
  r.total := private.roll_total(r);
  update public.rolls set extras = r.extras, total = r.total, updated_at = clock_timestamp() where id = r.id;
  update public.crew set grit = g - 1, updated_at = clock_timestamp() where id = 1;
  return to_jsonb(r);
end $$;

-- Spend 1 Wear from the roll's character to reroll its dice.
create or replace function public.reroll(p_token text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); r public.rolls; w int;
begin
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.sheet_id is null or r.kind = 'grit_session' then raise exception 'cant_reroll'; end if;
  if not private.can_edit(s, r.sheet_id) then raise exception 'not_yours' using errcode = '42501'; end if;

  select coalesce((data->>'wear')::int, 0) into w from public.sheets where id = r.sheet_id for update;
  if w < 1 then raise exception 'no_wear'; end if;
  update public.sheets set data = jsonb_set(data, '{wear}', to_jsonb(w - 1)), updated_at = clock_timestamp()
   where id = r.sheet_id;

  r.history := r.history || jsonb_build_array(jsonb_build_object('dice', to_jsonb(r.dice), 'who', private.who(s)));
  r.dice := private.dice(array_length(r.dice, 1), r.sides);
  r.rerolls := r.rerolls + 1;
  r.total := private.roll_total(r);
  update public.rolls
     set dice = r.dice, history = r.history, rerolls = r.rerolls, total = r.total, updated_at = clock_timestamp()
   where id = r.id;
  return to_jsonb(r);
end $$;

-- Take the 1 Wear that doubles offer. Once per roll, max 3 Wear.
create or replace function public.mark_wear(p_token text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); r public.rolls; w int;
begin
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null or r.sheet_id is null then raise exception 'not_found'; end if;
  if not private.can_edit(s, r.sheet_id) then raise exception 'not_yours' using errcode = '42501'; end if;
  if not (array_length(r.dice, 1) = 2 and r.sides = 6 and r.dice[1] = r.dice[2]) then raise exception 'not_doubles'; end if;
  if r.wear_marked > 0 then raise exception 'already_marked'; end if;

  select coalesce((data->>'wear')::int, 0) into w from public.sheets where id = r.sheet_id for update;
  if w >= 3 then raise exception 'wear_full'; end if;
  update public.sheets set data = jsonb_set(data, '{wear}', to_jsonb(w + 1)), updated_at = clock_timestamp()
   where id = r.sheet_id;
  update public.rolls set wear_marked = 1, updated_at = clock_timestamp() where id = r.id returning * into r;
  return to_jsonb(r);
end $$;

-- ── Scenes & Vault ─────────────────────────────────────────────────────────

create or replace function public.get_scene_image(p_token text, p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not exists (select 1 from public.crew where id = 1 and scene_shown and scene_id = p_id) then
    raise exception 'not_shown' using errcode = '42501';
  end if;
  return (select image from public.scenes where id = p_id);
end $$;

create or replace function public.get_vault(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.vault_visible() then raise exception 'not_shown' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('code', code, 'state', state, 'by', updated_by)), '[]'::jsonb)
          from public.vault_boxes);
end $$;

-- Any player can mark a box while the Vault is shown. The GM always can.
create or replace function public.vault_set(p_token text, p_code text, p_state text)
returns void language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.vault_visible() then raise exception 'not_shown' using errcode = '42501'; end if;
  if coalesce(p_state, '') not in ('', 'open', 'progress', 'complete') then raise exception 'bad_state'; end if;
  update public.vault_boxes set state = coalesce(p_state, ''), updated_by = private.who(s), updated_at = clock_timestamp()
   where code = upper(p_code);
  if not found then raise exception 'not_found'; end if;
end $$;

create or replace function public.gm_scenes(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'caption', caption,
                                                       'thumb', thumb, 'updated_at', updated_at)
                                    order by sort, created_at), '[]'::jsonb) from public.scenes);
end $$;

-- Create (p_id null) or update a scene. A null p_image keeps the current image.
create or replace function public.gm_scene_save(p_token text, p_id uuid, p_title text, p_caption text, p_image text, p_thumb text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare sid uuid := p_id;
begin
  perform private.me(p_token, 'gm');
  if length(coalesce(p_image, '')) > 6000000 then raise exception 'too_big'; end if;
  if sid is null then
    insert into public.scenes (kind, title, caption, image, thumb, sort)
    values ('image', left(coalesce(p_title, ''), 120), left(coalesce(p_caption, ''), 2000), p_image, p_thumb,
            (select coalesce(max(sort), 0) + 1 from public.scenes))
    returning id into sid;
  else
    update public.scenes
       set title = left(coalesce(p_title, title), 120), caption = left(coalesce(p_caption, caption), 2000),
           image = coalesce(p_image, image), thumb = coalesce(p_thumb, thumb), updated_at = clock_timestamp()
     where id = sid;
  end if;
  update public.crew set updated_at = clock_timestamp() where id = 1 and scene_id = sid;
  return sid;
end $$;

create or replace function public.gm_scene_delete(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  delete from public.scenes where id = p_id and kind <> 'vault';
  update public.crew set scene_id = null, scene_shown = false, updated_at = clock_timestamp()
   where id = 1 and scene_id = p_id;
end $$;

-- Show a scene to everyone, or hide (p_id null).
create or replace function public.gm_scene_show(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  if p_id is null then
    update public.crew set scene_shown = false, updated_at = clock_timestamp() where id = 1;
  else
    update public.crew set scene_id = p_id, scene_shown = true, updated_at = clock_timestamp() where id = 1;
  end if;
end $$;

create or replace function public.gm_vault_reset(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token, 'gm');
begin
  update public.vault_boxes set state = '', updated_by = private.who(s), updated_at = clock_timestamp() where state <> '';
end $$;

-- ── GM admin ───────────────────────────────────────────────────────────────

create or replace function public.gm_set_lock(p_token text, p_id uuid, p_locked boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.sheets set locked = coalesce(p_locked, false), updated_at = clock_timestamp() where id = p_id;
end $$;

-- Set (or clear, with an empty password) a character's login. Signs that player out.
create or replace function public.gm_set_char_password(p_token text, p_id uuid, p_plain text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.sheets
     set pass_hash = case when coalesce(p_plain, '') = '' then null
                          else extensions.crypt(p_plain, extensions.gen_salt('bf')) end,
         updated_at = clock_timestamp()
   where id = p_id;
  delete from private.sessions where sheet_id = p_id;
end $$;

-- Change the GM password. Other GM sessions are signed out; this one stays.
create or replace function public.gm_set_gm_password(p_token text, p_plain text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  if length(coalesce(p_plain, '')) < 4 then raise exception 'too_short'; end if;
  perform private.set_secret('gm', p_plain);
  delete from private.sessions where role = 'gm' and token <> p_token;
end $$;

create or replace function public.gm_get_notes(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return (select jsonb_build_object('body', body, 'updated_at', updated_at) from public.gm_notes where id = 1);
end $$;

create or replace function public.gm_set_notes(p_token text, p_body text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare ts timestamptz := clock_timestamp();
begin
  perform private.me(p_token, 'gm');
  update public.gm_notes set body = coalesce(p_body, ''), updated_at = ts where id = 1;
  return ts;
end $$;

create or replace function public.gm_clear_rolls(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  delete from public.rolls where true;
end $$;

create or replace function public.gm_deleted_sheets(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', data->>'name', 'deleted_at', deleted_at)
                                    order by deleted_at desc)
                   from public.sheets where deleted_at is not null), '[]'::jsonb);
end $$;

create or replace function public.gm_restore_sheet(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.sheets set deleted_at = null, updated_at = clock_timestamp() where id = p_id;
end $$;

-- ── Grants: the API can call the public functions and nothing else ────────

revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.login_options(),
  public.login(uuid, text),
  public.logout(text),
  public.sync(text, timestamptz),
  public.create_sheet(text, jsonb),
  public.patch_sheet(text, uuid, text[], jsonb),
  public.delete_sheet(text, uuid),
  public.set_grit(text, int),
  public.adjust_grit(text, int),
  public.gm_set_grit_open(text, boolean),
  public.roll(text, uuid, text, text, int, int, jsonb),
  public.spend_grit(text, bigint),
  public.reroll(text, bigint),
  public.mark_wear(text, bigint),
  public.get_scene_image(text, uuid),
  public.get_vault(text),
  public.vault_set(text, text, text),
  public.gm_scenes(text),
  public.gm_scene_save(text, uuid, text, text, text, text),
  public.gm_scene_delete(text, uuid),
  public.gm_scene_show(text, uuid),
  public.gm_vault_reset(text),
  public.gm_set_lock(text, uuid, boolean),
  public.gm_set_char_password(text, uuid, text),
  public.gm_set_gm_password(text, text),
  public.gm_get_notes(text),
  public.gm_set_notes(text, text),
  public.gm_clear_rolls(text),
  public.gm_deleted_sheets(text),
  public.gm_restore_sheet(text, uuid)
to anon, authenticated;
