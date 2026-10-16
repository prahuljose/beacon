-- Debt v4: text on scenes/board, private chat, dated GM session notes,
-- doubles on any two matching dice. Apply after v3.sql. Re-runnable.

alter table public.strokes add column if not exists text text;      -- set for text labels (points = [x, y])

alter table public.chat add column if not exists private boolean not null default false;
alter table public.chat add column if not exists to_sheet uuid references public.sheets(id) on delete cascade;

create table if not exists public.gm_sessions (
  id           bigint generated always as identity primary key,
  session_date date not null default current_date,
  body         text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default clock_timestamp()
);
alter table public.gm_sessions enable row level security;
revoke all on all tables in schema public from anon, authenticated;

-- The old single "session notes" text becomes Session #1.
insert into public.gm_sessions (session_date, body)
select current_date, session_body from public.gm_notes
 where id = 1 and length(trim(session_body)) > 0 and not exists (select 1 from public.gm_sessions);

drop function if exists public.add_stroke(text, uuid, text, real, jsonb);
drop function if exists public.chat_send(text, text);

create or replace function private.stroke_json(st public.strokes)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', st.id, 'scene_id', st.scene_id, 'who', st.who, 'color', st.color,
                            'width', st.width, 'points', st.points, 'text', st.text, 'deleted', st.deleted);
$$;

create or replace function private.can_see_chat(s private.sessions, m public.chat)
returns boolean language sql stable set search_path = '' as $$
  select s.role = 'gm' or not m.private
      or (m.sheet_id is not null and m.sheet_id = s.sheet_id)
      or (m.to_sheet is not null and m.to_sheet = s.sheet_id);
$$;

-- Doubles = exactly two dice showing the same face (any die type).
create or replace function private.is_doubles(d int[])
returns boolean language sql immutable set search_path = '' as $$
  select array_length(d, 1) = 2 and d[1] = d[2];
$$;

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
      select jsonb_agg(private.stroke_json(st))
      from public.strokes st join public.scenes sc on sc.id = st.scene_id
      where st.updated_at > since and (p_since is not null or not st.deleted)
        and (gm or sc.active or sc.kind = 'board')), '[]'::jsonb),
    'chat', coalesce((
      select jsonb_agg(to_jsonb(m) order by m.id)
      from (select * from public.chat m where m.created_at > since and private.can_see_chat(s, m)
            order by m.id desc limit 100) m), '[]'::jsonb),
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

create or replace function public.get_strokes(p_token text, p_scene uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  if s.role <> 'gm' and not private.scene_visible(p_scene) then raise exception 'not_shown' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(private.stroke_json(st) order by st.id)
                   from public.strokes st where st.scene_id = p_scene and not st.deleted), '[]'::jsonb);
end $$;

-- A pen stroke (points = flat [x0, y0, …]) or, with p_text, a text label at [x, y].
create or replace function public.add_stroke(p_token text, p_scene uuid, p_color text, p_width real, p_points jsonb, p_text text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); st public.strokes;
begin
  if s.role <> 'gm' and not private.scene_visible(p_scene) then raise exception 'not_shown' using errcode = '42501'; end if;
  if not exists (select 1 from public.scenes where id = p_scene and kind in ('image', 'board')) then raise exception 'not_found'; end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) < 2 or jsonb_array_length(p_points) > 4000 then
    raise exception 'bad_stroke';
  end if;
  if p_text is not null and length(trim(p_text)) = 0 then raise exception 'empty'; end if;
  insert into public.strokes (scene_id, who, color, width, points, text)
  values (p_scene, private.who(s), left(coalesce(p_color, '#c9a24b'), 20), greatest(1, least(40, coalesce(p_width, 3))),
          p_points, left(p_text, 300))
  returning * into st;
  return private.stroke_json(st);
end $$;

-- Chat. A player's private message goes to the GM; the GM's private message
-- goes to one character (p_to).
create or replace function public.chat_send(p_token text, p_body text, p_private boolean default false, p_to uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat; priv boolean := coalesce(p_private, false);
begin
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty'; end if;
  if priv and s.role = 'gm' and p_to is null then raise exception 'pick_player'; end if;
  insert into public.chat (sheet_id, who, body, private, to_sheet)
  values (s.sheet_id, private.who(s), left(trim(p_body), 1000), priv, case when priv and s.role = 'gm' then p_to end)
  returning * into m;
  delete from public.chat where id < m.id - 500;
  return to_jsonb(m);
end $$;

-- Rolls: doubles on any two matching dice bank Wear.
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
  if sheet is not null and p_kind <> 'grit_session' and private.is_doubles(r.dice) then
    r.wear_marked := private.bank_wear(sheet);
  end if;
  update public.rolls set total = r.total, wear_marked = r.wear_marked where id = r.id;

  if p_kind = 'grit_session' then
    update public.crew set grit = greatest(0, least(10, r.total)), grit_open = false, updated_at = clock_timestamp()
     where id = 1;
  end if;
  return to_jsonb(r);
end $$;

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
  if private.is_doubles(r.dice) then
    r.wear_marked := private.bank_wear(r.sheet_id);
  end if;
  update public.rolls
     set dice = r.dice, extras = r.extras, history = r.history, rerolls = r.rerolls, total = r.total,
         wear_marked = r.wear_marked, updated_at = clock_timestamp()
   where id = r.id;
  return to_jsonb(r);
end $$;

-- GM session notes: one per session, numbered by date.
create or replace function public.gm_sessions(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'date', session_date, 'body', body)
                                    order by session_date, id) from public.gm_sessions), '[]'::jsonb);
end $$;

create or replace function public.gm_session_save(p_token text, p_id bigint, p_date date, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare g public.gm_sessions;
begin
  perform private.me(p_token, 'gm');
  if p_id is null then
    insert into public.gm_sessions (session_date, body) values (coalesce(p_date, current_date), coalesce(p_body, ''))
    returning * into g;
  else
    update public.gm_sessions
       set session_date = coalesce(p_date, session_date), body = coalesce(p_body, body), updated_at = clock_timestamp()
     where id = p_id returning * into g;
    if g.id is null then raise exception 'not_found'; end if;
  end if;
  return jsonb_build_object('id', g.id, 'date', g.session_date, 'body', g.body);
end $$;

create or replace function public.gm_session_delete(p_token text, p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  delete from public.gm_sessions where id = p_id;
end $$;

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
  public.get_strokes(text, uuid), public.add_stroke(text, uuid, text, real, jsonb, text),
  public.erase_strokes(text, bigint[]), public.gm_clear_strokes(text, uuid),
  public.get_vault(text), public.vault_set(text, text, text), public.gm_vault_danger(text, text, boolean),
  public.gm_vault_reset(text),
  public.chat_send(text, text, boolean, uuid),
  public.gm_set_char_password(text, uuid, text), public.gm_set_gm_password(text, text),
  public.gm_get_notes(text), public.gm_set_notes(text, text, text),
  public.gm_sessions(text), public.gm_session_save(text, bigint, date, text), public.gm_session_delete(text, bigint),
  public.gm_clear_rolls(text), public.gm_deleted_sheets(text), public.gm_restore_sheet(text, uuid)
to anon, authenticated;
