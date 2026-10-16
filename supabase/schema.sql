-- Beacon crew portal — database schema.
--
-- Every table has RLS on and no policies, so the public (anon) key can't touch
-- them directly. The browser only calls the functions below, and each one
-- checks the entry password (or the GM password) before doing anything.
--
-- Passwords are stored as bcrypt hashes and are NOT in this file. Set or
-- change them in the Supabase SQL editor:
--
--   select private.set_secret('entry', 'new-password');
--   select private.set_secret('gm',    'new-gm-password');

create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

-- ── Tables ─────────────────────────────────────────────────────────────────

create table if not exists private.secret (
  kind text primary key check (kind in ('entry', 'gm')),
  hash text not null
);

create table if not exists public.sheets (
  id         uuid primary key default gen_random_uuid(),
  data       jsonb not null default '{}'::jsonb,
  sort       int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp(),
  deleted_at timestamptz
);

create table if not exists public.crew (
  id         int primary key default 1 check (id = 1),
  grit       int not null default 0 check (grit between 0 and 10),
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.crew (id) values (1) on conflict do nothing;

create table if not exists public.rolls (
  id         bigint generated always as identity primary key,
  sheet_id   uuid references public.sheets(id) on delete set null,
  who        text not null default '',
  label      text not null default '',
  kind       text not null default 'free',
  sides      int not null,
  dice       int[] not null,
  modifier   int not null default 0,
  mult       int not null default 1,
  extras     jsonb not null default '[]'::jsonb,  -- [{who, die}] grit dice
  rerolls    int not null default 0,
  wear_marked int not null default 0,             -- wear marked by doubles/rerolls
  total      int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists rolls_updated_idx on public.rolls (updated_at);
create index if not exists rolls_sheet_idx on public.rolls (sheet_id);

create table if not exists public.gm_notes (
  id         int primary key default 1 check (id = 1),
  body       text not null default '',
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.gm_notes (id) values (1) on conflict do nothing;

alter table public.sheets   enable row level security;
alter table public.crew     enable row level security;
alter table public.rolls    enable row level security;
alter table public.gm_notes enable row level security;
alter table private.secret  enable row level security;

revoke all on public.sheets, public.crew, public.rolls, public.gm_notes from anon, authenticated;
revoke all on all tables in schema private from anon, authenticated, public;
revoke all on schema private from anon, authenticated, public;

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

create or replace function private.guard(p_pass text, p_kind text default 'entry')
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  -- The GM password also opens everything the entry password does.
  if not (private.ok(p_pass, p_kind) or (p_kind = 'entry' and private.ok(p_pass, 'gm'))) then
    raise exception 'bad_password' using errcode = '28P01';
  end if;
end $$;

create or replace function private.roll_total(r public.rolls)
returns int language sql immutable set search_path = '' as $$
  select ((select coalesce(sum(d), 0) from unnest(r.dice) d)
        + (select coalesce(sum((e->>'die')::int), 0) from jsonb_array_elements(r.extras) e)
        + r.modifier) * r.mult;
$$;

-- Adds `n` Wear to a sheet, capped at 3. Returns how much was actually added.
create or replace function private.mark_wear(p_sheet uuid, n int)
returns int language plpgsql security definer set search_path = '' as $$
declare cur int; added int;
begin
  select coalesce((data->>'wear')::int, 0) into cur from public.sheets where id = p_sheet for update;
  if cur is null then return 0; end if;
  added := greatest(0, least(3, cur + n) - cur);
  if added > 0 then
    update public.sheets
       set data = jsonb_set(data, '{wear}', to_jsonb(cur + added)), updated_at = clock_timestamp()
     where id = p_sheet;
  end if;
  return added;
end $$;

-- ── Public API ─────────────────────────────────────────────────────────────

create or replace function public.check_pass(p_pass text)
returns text language sql stable security definer set search_path = '' as $$
  select case when private.ok(p_pass, 'gm') then 'gm'
              when private.ok(p_pass, 'entry') then 'player' end;
$$;

-- Everything that changed since p_since (server clock). The client keeps the
-- returned `now` and asks again from there, with a few seconds of overlap.
create or replace function public.sync(p_pass text, p_since timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare since timestamptz := coalesce(p_since, '-infinity'::timestamptz);
begin
  perform private.guard(p_pass);
  return jsonb_build_object(
    'now',  clock_timestamp(),
    'grit', (select grit from public.crew where id = 1),
    'roll_min', (select min(id) from public.rolls),  -- lets clients drop rolls the GM cleared
    'sheets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', s.id, 'data', s.data, 'sort', s.sort,
               'updated_at', s.updated_at, 'deleted', s.deleted_at is not null)
             order by s.sort, s.created_at)
      from public.sheets s
      where s.updated_at > since and (p_since is not null or s.deleted_at is null)
    ), '[]'::jsonb),
    'rolls', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id)
      from (select * from public.rolls r
            where r.updated_at > since
            order by r.id desc limit 150) r
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.create_sheet(p_pass text, p_data jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare new_id uuid;
begin
  perform private.guard(p_pass);
  insert into public.sheets (data, sort)
  values (coalesce(p_data, '{}'::jsonb),
          (select coalesce(max(sort), 0) + 1 from public.sheets))
  returning id into new_id;
  return new_id;
end $$;

-- Sets one value inside a sheet's JSON (missing parent objects are created).
-- An empty path replaces the whole sheet.
create or replace function public.patch_sheet(p_pass text, p_id uuid, p_path text[], p_value jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare d jsonb; i int; ts timestamptz := clock_timestamp();
begin
  perform private.guard(p_pass);
  if pg_column_size(p_value) > 600000 then
    raise exception 'too_big';
  end if;
  select data into d from public.sheets where id = p_id and deleted_at is null for update;
  if d is null then raise exception 'not_found'; end if;

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

create or replace function public.delete_sheet(p_pass text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.guard(p_pass);
  update public.sheets set deleted_at = now(), updated_at = clock_timestamp()
   where id = p_id and deleted_at is null;
end $$;

create or replace function public.set_grit(p_pass text, p_value int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int := greatest(0, least(10, coalesce(p_value, 0)));
begin
  perform private.guard(p_pass);
  update public.crew set grit = v, updated_at = clock_timestamp() where id = 1;
  return v;
end $$;

create or replace function public.adjust_grit(p_pass text, p_delta int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform private.guard(p_pass);
  update public.crew set grit = greatest(0, least(10, grit + coalesce(p_delta, 0))),
         updated_at = clock_timestamp()
   where id = 1 returning grit into v;
  return v;
end $$;

-- Rolls dice on the server so everyone sees the same result.
--   kind 'check' | 'death' | 'free' : doubles on 2d6 from a sheet mark 1 Wear
--   kind 'grit_session'              : sets the crew Grit pool to the result
--   kind 'hp' | 'money'              : character-creation rolls, no Wear
create or replace function public.roll(
  p_pass text, p_sheet uuid, p_who text, p_label text, p_kind text,
  p_n int, p_sides int, p_mod int default 0, p_mult int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rolls; ds int[];
begin
  perform private.guard(p_pass);
  if p_n not between 1 and 30 or p_sides not between 2 and 1000
     or p_mod not between -999 and 999 or p_mult not between 1 and 1000 then
    raise exception 'bad_roll';
  end if;

  select array_agg(1 + floor(random() * p_sides)::int) into ds from generate_series(1, p_n);

  insert into public.rolls (sheet_id, who, label, kind, sides, dice, modifier, mult, total)
  values (p_sheet, left(coalesce(p_who, ''), 60), left(coalesce(p_label, ''), 120),
          coalesce(p_kind, 'free'), p_sides, ds, coalesce(p_mod, 0), coalesce(p_mult, 1), 0)
  returning * into r;

  if p_sheet is not null and p_kind in ('check', 'death', 'free')
     and p_n = 2 and p_sides = 6 and ds[1] = ds[2] then
    r.wear_marked := private.mark_wear(p_sheet, 1);
  end if;

  r.total := private.roll_total(r);
  update public.rolls set total = r.total, wear_marked = r.wear_marked where id = r.id;

  if p_kind = 'grit_session' then
    update public.crew set grit = greatest(0, least(10, r.total)), updated_at = clock_timestamp() where id = 1;
  end if;

  return to_jsonb(r);
end $$;

-- Spend 1 Grit to add 1d6 to any d6 roll, yours or anyone else's.
create or replace function public.spend_grit(p_pass text, p_roll bigint, p_who text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rolls; g int;
begin
  perform private.guard(p_pass);
  select grit into g from public.crew where id = 1 for update;
  if g < 1 then raise exception 'no_grit'; end if;
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.sides <> 6 then raise exception 'not_d6'; end if;

  r.extras := r.extras || jsonb_build_array(jsonb_build_object(
    'who', left(coalesce(p_who, ''), 60), 'die', 1 + floor(random() * 6)::int));
  r.total := private.roll_total(r);
  update public.rolls set extras = r.extras, total = r.total, updated_at = clock_timestamp() where id = r.id;
  update public.crew set grit = g - 1, updated_at = clock_timestamp() where id = 1;
  return to_jsonb(r);
end $$;

-- Push: mark 1 Wear to reroll a sheet's roll. Not allowed at 3 Wear.
create or replace function public.reroll(p_pass text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.rolls; ds int[]; added int;
begin
  perform private.guard(p_pass);
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.sheet_id is null or r.kind not in ('check', 'death', 'free') then raise exception 'cant_reroll'; end if;

  added := private.mark_wear(r.sheet_id, 1);
  if added = 0 then raise exception 'worn_out'; end if;

  select array_agg(1 + floor(random() * r.sides)::int) into ds from generate_series(1, array_length(r.dice, 1));
  r.dice := ds;
  r.rerolls := r.rerolls + 1;
  r.wear_marked := r.wear_marked + added;
  if array_length(ds, 1) = 2 and r.sides = 6 and ds[1] = ds[2] then
    r.wear_marked := r.wear_marked + private.mark_wear(r.sheet_id, 1);
  end if;
  r.total := private.roll_total(r);
  update public.rolls
     set dice = r.dice, rerolls = r.rerolls, wear_marked = r.wear_marked,
         total = r.total, updated_at = clock_timestamp()
   where id = r.id;
  return to_jsonb(r);
end $$;

-- ── GM only ────────────────────────────────────────────────────────────────

create or replace function public.gm_get_notes(p_gm text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.guard(p_gm, 'gm');
  return (select jsonb_build_object('body', body, 'updated_at', updated_at) from public.gm_notes where id = 1);
end $$;

create or replace function public.gm_set_notes(p_gm text, p_body text)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare ts timestamptz := clock_timestamp();
begin
  perform private.guard(p_gm, 'gm');
  update public.gm_notes set body = coalesce(p_body, ''), updated_at = ts where id = 1;
  return ts;
end $$;

create or replace function public.gm_clear_rolls(p_gm text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.guard(p_gm, 'gm');
  delete from public.rolls where true;
end $$;

create or replace function public.gm_deleted_sheets(p_gm text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.guard(p_gm, 'gm');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', data->>'name', 'deleted_at', deleted_at)
                                    order by deleted_at desc)
                   from public.sheets where deleted_at is not null), '[]'::jsonb);
end $$;

create or replace function public.gm_restore_sheet(p_gm text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.guard(p_gm, 'gm');
  update public.sheets set deleted_at = null, updated_at = clock_timestamp() where id = p_id;
end $$;

-- ── Grants: the API can call the public functions and nothing else ────────

revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.check_pass(text),
  public.sync(text, timestamptz),
  public.create_sheet(text, jsonb),
  public.patch_sheet(text, uuid, text[], jsonb),
  public.delete_sheet(text, uuid),
  public.set_grit(text, int),
  public.adjust_grit(text, int),
  public.roll(text, uuid, text, text, text, int, int, int, int),
  public.spend_grit(text, bigint, text),
  public.reroll(text, bigint),
  public.gm_get_notes(text),
  public.gm_set_notes(text, text),
  public.gm_clear_rolls(text),
  public.gm_deleted_sheets(text),
  public.gm_restore_sheet(text, uuid)
to anon, authenticated;
