-- Debt v3: private rolls, auto-banked Wear, per-player Wear max, Grit for
-- everyone, several live scenes, drawing on scenes + a shared Drawing Board,
-- Vault danger boxes, chat, two GM notes, GM rules note, lock removed.
-- Apply after schema.sql (v2). Re-runnable.

-- ── Tables ─────────────────────────────────────────────────────────────────

alter table public.crew add column if not exists settings jsonb not null default '{}'::jsonb;  -- { reroll_grit }
alter table public.crew add column if not exists rules_note text not null default '';

alter table public.rolls add column if not exists private boolean not null default false;

alter table public.vault_boxes add column if not exists danger boolean not null default false;

alter table public.gm_notes add column if not exists session_body text not null default '';

alter table public.scenes add column if not exists active boolean not null default false;
alter table public.scenes drop constraint if exists scenes_kind_check;
alter table public.scenes add constraint scenes_kind_check check (kind in ('image', 'vault', 'board'));
insert into public.scenes (kind, title, sort)
select 'board', 'Drawing Board', -1 where not exists (select 1 from public.scenes where kind = 'board');
-- v2 had one shown scene in crew; carry it over.
update public.scenes set active = true
 where id = (select scene_id from public.crew where id = 1 and scene_shown);

create table if not exists public.strokes (
  id         bigint generated always as identity primary key,
  scene_id   uuid not null references public.scenes(id) on delete cascade,
  who        text not null default '',
  color      text not null default '#c9a24b',
  width      real not null default 3,
  points     jsonb not null,   -- flat [x0, y0, x1, y1, …] in 0..1 of the scene
  deleted    boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists strokes_scene_idx on public.strokes (scene_id, updated_at);

create table if not exists public.chat (
  id         bigint generated always as identity primary key,
  sheet_id   uuid references public.sheets(id) on delete set null,
  who        text not null default '',
  body       text not null,
  created_at timestamptz not null default clock_timestamp()
);
create index if not exists chat_created_idx on public.chat (created_at);

alter table public.strokes enable row level security;
alter table public.chat    enable row level security;
revoke all on all tables in schema public from anon, authenticated;

-- The lock feature is gone; nothing stays locked.
update public.sheets set locked = false where locked;

-- Repair sheets whose gear became an object ({"0": "…"}) instead of a list.
update public.sheets
   set data = jsonb_set(data, '{gear}', (
         select coalesce(jsonb_agg(v order by (k)::int), '[]'::jsonb)
         from jsonb_each(data->'gear') e(k, v) where k ~ '^\d+$')),
       updated_at = clock_timestamp()
 where jsonb_typeof(data->'gear') = 'object';

-- ── Drop functions that change shape or go away ────────────────────────────

drop function if exists public.sync(text, timestamptz);
drop function if exists public.patch_sheet(text, uuid, text[], jsonb);
drop function if exists public.roll(text, uuid, text, text, int, int, jsonb);
drop function if exists public.spend_grit(text, bigint);
drop function if exists public.reroll(text, bigint);
drop function if exists public.mark_wear(text, bigint);
drop function if exists public.gm_set_lock(text, uuid, boolean);
drop function if exists public.gm_scene_show(text, uuid);
drop function if exists public.gm_scenes(text);
drop function if exists public.gm_scene_delete(text, uuid);
drop function if exists public.get_scene_image(text, uuid);
drop function if exists public.get_vault(text);
drop function if exists public.vault_set(text, text, text);
drop function if exists public.gm_get_notes(text);
drop function if exists public.gm_set_notes(text, text);
drop function if exists public.set_grit(text, int);
drop function if exists public.adjust_grit(text, int);

-- ── Helpers ────────────────────────────────────────────────────────────────

create or replace function private.vault_visible()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.scenes where kind = 'vault' and active);
$$;

-- Scenes a player may see: live ones and the Drawing Board.
create or replace function private.scene_visible(p_scene uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.scenes where id = p_scene and (active or kind = 'board'));
$$;

create or replace function private.wear_max(d jsonb)
returns int language sql immutable set search_path = '' as $$
  select greatest(1, least(10, coalesce((d->>'wear_max')::int, 3)));
$$;

-- Bank 1 Wear for doubles if there's room. Returns 1 if banked, -1 if full.
create or replace function private.bank_wear(p_sheet uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare d jsonb; w int;
begin
  select data into d from public.sheets where id = p_sheet for update;
  if d is null then return 0; end if;
  w := coalesce((d->>'wear')::int, 0);
  if w >= private.wear_max(d) then return -1; end if;
  update public.sheets set data = jsonb_set(d, '{wear}', to_jsonb(w + 1)), updated_at = clock_timestamp()
   where id = p_sheet;
  return 1;
end $$;

create or replace function private.can_see_roll(s private.sessions, r public.rolls)
returns boolean language sql stable set search_path = '' as $$
  select s.role = 'gm' or not r.private or (r.sheet_id is not null and r.sheet_id = s.sheet_id);
$$;

create or replace function private.vault_rows(gm boolean, since timestamptz)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'code', code, 'state', state, 'by', updated_by,
           'danger', case when gm or state <> '' then danger else false end)), '[]'::jsonb)
  from public.vault_boxes where updated_at > since;
$$;

-- ── Sync ───────────────────────────────────────────────────────────────────

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
    'settings', c.settings,
    'rules_note', c.rules_note,
    'scenes_live', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'caption', caption,
                                          'active', active, 'updated_at', updated_at) order by sort, created_at)
      from public.scenes where active or kind = 'board'), '[]'::jsonb),
    'scenes_sig', case when gm then (select count(*) || '|' || coalesce(max(updated_at)::text, '') from public.scenes) end,
    'vault', case when gm or private.vault_visible() then private.vault_rows(gm, since) end,
    'strokes', coalesce((
      select jsonb_agg(jsonb_build_object('id', st.id, 'scene_id', st.scene_id, 'who', st.who, 'color', st.color,
                                          'width', st.width, 'points', st.points, 'deleted', st.deleted))
      from public.strokes st join public.scenes sc on sc.id = st.scene_id
      where st.updated_at > since and (p_since is not null or not st.deleted)
        and (gm or sc.active or sc.kind = 'board')), '[]'::jsonb),
    'chat', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.id)
      from (select * from public.chat where created_at > since order by id desc limit 100) m), '[]'::jsonb),
    'roll_min', (select min(id) from public.rolls),
    'sheets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'data', sh.data, 'sort', sh.sort,
               'has_pass', case when gm then sh.pass_hash is not null end,
               'updated_at', sh.updated_at, 'deleted', sh.deleted_at is not null)
             order by sh.sort, sh.created_at)
      from public.sheets sh
      where sh.updated_at > since and (p_since is not null or sh.deleted_at is null)
    ), '[]'::jsonb),
    'rolls', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.id)
      from (select * from public.rolls r
            where r.updated_at > since and private.can_see_roll(s, r)
            order by r.id desc limit 150) r
    ), '[]'::jsonb)
  );
end $$;

-- ── Sheets ─────────────────────────────────────────────────────────────────

-- Sets one value inside a sheet's JSON (missing parent objects are created).
-- An empty path replaces the whole sheet (GM only). Players can't change
-- their own Wear max.
create or replace function public.patch_sheet(p_token text, p_id uuid, p_path text[], p_value jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  s private.sessions := private.me(p_token);
  d jsonb; i int; ts timestamptz := clock_timestamp();
begin
  if not private.can_edit(s, p_id) then raise exception 'not_yours' using errcode = '42501'; end if;
  if pg_column_size(p_value) > 600000 then raise exception 'too_big'; end if;
  select data into d from public.sheets where id = p_id and deleted_at is null for update;
  if d is null then raise exception 'not_found'; end if;

  if s.role <> 'gm' then
    if coalesce(array_length(p_path, 1), 0) = 0 then raise exception 'not_allowed' using errcode = '42501'; end if;
    if p_path[1] = 'wear_max' then raise exception 'gm_only' using errcode = '42501'; end if;
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

create or replace function public.gm_set_wear_max(p_token text, p_id uuid, p_max int)
returns int language plpgsql security definer set search_path = '' as $$
declare m int := greatest(1, least(10, coalesce(p_max, 3)));
begin
  perform private.me(p_token, 'gm');
  update public.sheets
     set data = jsonb_set(jsonb_set(data, '{wear_max}', to_jsonb(m)), '{wear}',
                          to_jsonb(least(m, coalesce((data->>'wear')::int, 0)))),
         updated_at = clock_timestamp()
   where id = p_id;
  return m;
end $$;

-- Permanently remove a character the GM already deleted.
create or replace function public.gm_purge_sheet(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  delete from public.sheets where id = p_id and deleted_at is not null;
  if not found then raise exception 'not_found'; end if;
end $$;

-- ── Grit (anyone) ──────────────────────────────────────────────────────────

create or replace function public.set_grit(p_token text, p_value int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int := greatest(0, least(10, coalesce(p_value, 0)));
begin
  perform private.me(p_token);
  update public.crew set grit = v, updated_at = clock_timestamp() where id = 1;
  return v;
end $$;

create or replace function public.adjust_grit(p_token text, p_delta int)
returns int language plpgsql security definer set search_path = '' as $$
declare v int;
begin
  perform private.me(p_token);
  update public.crew set grit = greatest(0, least(10, grit + coalesce(p_delta, 0))), updated_at = clock_timestamp()
   where id = 1 returning grit into v;
  return v;
end $$;

create or replace function public.gm_set_settings(p_token text, p_settings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  perform private.me(p_token, 'gm');
  update public.crew set settings = settings || coalesce(p_settings, '{}'::jsonb), updated_at = clock_timestamp()
   where id = 1 returning settings into v;
  return v;
end $$;

create or replace function public.gm_set_rules_note(p_token text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.crew set rules_note = left(coalesce(p_body, ''), 20000), updated_at = clock_timestamp() where id = 1;
end $$;

-- ── Dice ───────────────────────────────────────────────────────────────────

-- Rolls on the server. Players always roll as their own character.
-- p_parts lists each modifier and why: [{label, value}]. p_private hides the
-- roll from everyone but the roller and the GM (a GM's private roll is GM-only).
-- Doubles on 2d6 from a sheet bank 1 Wear automatically if there's room.
create or replace function public.roll(
  p_token text, p_sheet uuid, p_label text, p_kind text, p_n int, p_sides int,
  p_parts jsonb default '[]'::jsonb, p_private boolean default false)
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

  insert into public.rolls (sheet_id, who, label, kind, sides, dice, modifier, parts, total, private)
  values (sheet, left(who, 60), left(coalesce(p_label, ''), 120), left(coalesce(p_kind, 'free'), 20),
          sides, private.dice(n, sides), m, parts, 0, coalesce(p_private, false) and p_kind <> 'grit_session')
  returning * into r;
  r.total := private.roll_total(r);
  if sheet is not null and p_kind <> 'grit_session' and n = 2 and sides = 6 and r.dice[1] = r.dice[2] then
    r.wear_marked := private.bank_wear(sheet);
  end if;
  update public.rolls set total = r.total, wear_marked = r.wear_marked where id = r.id;

  if p_kind = 'grit_session' then
    update public.crew set grit = greatest(0, least(10, r.total)), grit_open = false, updated_at = clock_timestamp()
     where id = 1;
  end if;
  return to_jsonb(r);
end $$;

-- Spend 1 Grit to add 1d6 to any d6 roll you can see. Max 1 per roll.
create or replace function public.spend_grit(p_token text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); r public.rolls; g int;
begin
  select grit into g from public.crew where id = 1 for update;
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null or not private.can_see_roll(s, r) then raise exception 'not_found'; end if;
  if r.sides <> 6 or r.kind = 'grit_session' then raise exception 'not_d6'; end if;
  if jsonb_array_length(r.extras) >= 1 then raise exception 'grit_max'; end if;
  if g < 1 then raise exception 'no_grit'; end if;

  r.extras := jsonb_build_array(jsonb_build_object('who', private.who(s), 'die', 1 + floor(random() * 6)::int));
  r.total := private.roll_total(r);
  update public.rolls set extras = r.extras, total = r.total, updated_at = clock_timestamp() where id = r.id;
  update public.crew set grit = g - 1, updated_at = clock_timestamp() where id = 1;
  return to_jsonb(r);
end $$;

-- Spend 1 Wear from the roll's character to reroll its dice (and the Grit
-- die too when the GM turns that setting on). New doubles bank Wear again.
create or replace function public.reroll(p_token text, p_roll bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); r public.rolls; w int; grit_too boolean;
begin
  select * into r from public.rolls where id = p_roll for update;
  if r.id is null then raise exception 'not_found'; end if;
  if r.sheet_id is null or r.kind = 'grit_session' then raise exception 'cant_reroll'; end if;
  if not private.can_edit(s, r.sheet_id) then raise exception 'not_yours' using errcode = '42501'; end if;

  select coalesce((data->>'wear')::int, 0) into w from public.sheets where id = r.sheet_id for update;
  if w < 1 then raise exception 'no_wear'; end if;
  update public.sheets set data = jsonb_set(data, '{wear}', to_jsonb(w - 1)), updated_at = clock_timestamp()
   where id = r.sheet_id;

  select coalesce((settings->>'reroll_grit')::boolean, false) into grit_too from public.crew where id = 1;
  r.history := r.history || jsonb_build_array(jsonb_build_object(
    'dice', to_jsonb(r.dice), 'who', private.who(s),
    'grit', case when grit_too and jsonb_array_length(r.extras) > 0 then r.extras->0->'die' end));
  r.dice := private.dice(array_length(r.dice, 1), r.sides);
  if grit_too and jsonb_array_length(r.extras) > 0 then
    r.extras := jsonb_build_array(jsonb_set(r.extras->0, '{die}', to_jsonb(1 + floor(random() * 6)::int)));
  end if;
  r.rerolls := r.rerolls + 1;
  r.total := private.roll_total(r);
  if array_length(r.dice, 1) = 2 and r.sides = 6 and r.dice[1] = r.dice[2] then
    r.wear_marked := private.bank_wear(r.sheet_id);
  end if;
  update public.rolls
     set dice = r.dice, extras = r.extras, history = r.history, rerolls = r.rerolls, total = r.total,
         wear_marked = r.wear_marked, updated_at = clock_timestamp()
   where id = r.id;
  return to_jsonb(r);
end $$;

-- ── Scenes ─────────────────────────────────────────────────────────────────

create or replace function public.get_scene_image(p_token text, p_id uuid)
returns text language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.scene_visible(p_id) then raise exception 'not_shown' using errcode = '42501'; end if;
  return (select image from public.scenes where id = p_id);
end $$;

create or replace function public.gm_scenes(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'caption', caption,
                                                       'thumb', thumb, 'active', active, 'updated_at', updated_at)
                                    order by sort, created_at), '[]'::jsonb) from public.scenes);
end $$;

create or replace function public.gm_scene_active(p_token text, p_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.scenes set active = coalesce(p_active, false), updated_at = clock_timestamp()
   where id = p_id and kind <> 'board';
end $$;

create or replace function public.gm_scene_delete(p_token text, p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  delete from public.scenes where id = p_id and kind = 'image';
end $$;

-- Every non-deleted stroke on one scene (when it first becomes visible).
create or replace function public.get_strokes(p_token text, p_scene uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.scene_visible(p_scene) then raise exception 'not_shown' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'scene_id', scene_id, 'who', who, 'color', color,
                                                       'width', width, 'points', points, 'deleted', false) order by id)
                   from public.strokes where scene_id = p_scene and not deleted), '[]'::jsonb);
end $$;

create or replace function public.add_stroke(p_token text, p_scene uuid, p_color text, p_width real, p_points jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); st public.strokes;
begin
  if s.role <> 'gm' and not private.scene_visible(p_scene) then raise exception 'not_shown' using errcode = '42501'; end if;
  if not exists (select 1 from public.scenes where id = p_scene and kind in ('image', 'board')) then raise exception 'not_found'; end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) < 2 or jsonb_array_length(p_points) > 4000 then
    raise exception 'bad_stroke';
  end if;
  insert into public.strokes (scene_id, who, color, width, points)
  values (p_scene, private.who(s), left(coalesce(p_color, '#c9a24b'), 20), greatest(1, least(40, coalesce(p_width, 3))), p_points)
  returning * into st;
  return jsonb_build_object('id', st.id, 'scene_id', st.scene_id, 'who', st.who, 'color', st.color,
                            'width', st.width, 'points', st.points, 'deleted', false);
end $$;

-- Eraser: anyone can rub out any stroke on a scene they can see.
create or replace function public.erase_strokes(p_token text, p_ids bigint[])
returns void language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  update public.strokes st set deleted = true, updated_at = clock_timestamp()
   where st.id = any (p_ids) and not st.deleted
     and (s.role = 'gm' or private.scene_visible(st.scene_id));
end $$;

create or replace function public.gm_clear_strokes(p_token text, p_scene uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.strokes set deleted = true, updated_at = clock_timestamp() where scene_id = p_scene and not deleted;
end $$;

-- ── Vault ──────────────────────────────────────────────────────────────────

create or replace function public.get_vault(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.vault_visible() then raise exception 'not_shown' using errcode = '42501'; end if;
  return private.vault_rows(s.role = 'gm', '-infinity'::timestamptz);
end $$;

create or replace function public.vault_set(p_token text, p_code text, p_state text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); b public.vault_boxes;
begin
  if s.role <> 'gm' and not private.vault_visible() then raise exception 'not_shown' using errcode = '42501'; end if;
  if coalesce(p_state, '') not in ('', 'open', 'progress', 'complete') then raise exception 'bad_state'; end if;
  update public.vault_boxes set state = coalesce(p_state, ''), updated_by = private.who(s), updated_at = clock_timestamp()
   where code = upper(p_code) returning * into b;
  if b.code is null then raise exception 'not_found'; end if;
  return jsonb_build_object('code', b.code, 'state', b.state, 'by', b.updated_by,
                            'danger', case when s.role = 'gm' or b.state <> '' then b.danger else false end);
end $$;

create or replace function public.gm_vault_danger(p_token text, p_code text, p_danger boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.vault_boxes set danger = coalesce(p_danger, false), updated_at = clock_timestamp() where code = upper(p_code);
end $$;

-- ── Chat ───────────────────────────────────────────────────────────────────

create or replace function public.chat_send(p_token text, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat;
begin
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty'; end if;
  insert into public.chat (sheet_id, who, body) values (s.sheet_id, private.who(s), left(trim(p_body), 1000))
  returning * into m;
  delete from public.chat where id < m.id - 500;
  return to_jsonb(m);
end $$;

-- ── GM notes (two) ─────────────────────────────────────────────────────────

create or replace function public.gm_get_notes(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return (select jsonb_build_object('body', body, 'session', session_body) from public.gm_notes where id = 1);
end $$;

create or replace function public.gm_set_notes(p_token text, p_which text, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  if p_which = 'session' then
    update public.gm_notes set session_body = coalesce(p_body, ''), updated_at = clock_timestamp() where id = 1;
  else
    update public.gm_notes set body = coalesce(p_body, ''), updated_at = clock_timestamp() where id = 1;
  end if;
end $$;

-- ── Grants ─────────────────────────────────────────────────────────────────

revoke execute on all functions in schema public  from public, anon, authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;

grant execute on function
  public.login_options(), public.login(uuid, text), public.logout(text),
  public.sync(text, timestamptz),
  public.create_sheet(text, jsonb), public.patch_sheet(text, uuid, text[], jsonb), public.delete_sheet(text, uuid),
  public.gm_set_wear_max(text, uuid, int), public.gm_purge_sheet(text, uuid),
  public.set_grit(text, int), public.adjust_grit(text, int), public.gm_set_grit_open(text, boolean),
  public.gm_set_settings(text, jsonb), public.gm_set_rules_note(text, text),
  public.roll(text, uuid, text, text, int, int, jsonb, boolean), public.spend_grit(text, bigint), public.reroll(text, bigint),
  public.get_scene_image(text, uuid), public.gm_scenes(text), public.gm_scene_save(text, uuid, text, text, text, text),
  public.gm_scene_active(text, uuid, boolean), public.gm_scene_delete(text, uuid),
  public.get_strokes(text, uuid), public.add_stroke(text, uuid, text, real, jsonb),
  public.erase_strokes(text, bigint[]), public.gm_clear_strokes(text, uuid),
  public.get_vault(text), public.vault_set(text, text, text), public.gm_vault_danger(text, text, boolean),
  public.gm_vault_reset(text),
  public.chat_send(text, text),
  public.gm_set_char_password(text, uuid, text), public.gm_set_gm_password(text, text),
  public.gm_get_notes(text), public.gm_set_notes(text, text, text),
  public.gm_clear_rolls(text), public.gm_deleted_sheets(text), public.gm_restore_sheet(text, uuid)
to anon, authenticated;
