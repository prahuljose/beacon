-- Debt v7: tokens on scenes and the Drawing Board, and GM dice stats.
-- Apply after v6.sql. Re-runnable.

-- Tokens are strokes with a `piece`: 'gm', 'sheet:<uuid>' or 'npc:<label>'.
-- points = [x, y] (the token's centre). A character (or the GM) has at most
-- one token per scene; NPC tokens can repeat.
alter table public.strokes add column if not exists piece text;

create or replace function private.stroke_json(st public.strokes)
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object('id', st.id, 'scene_id', st.scene_id, 'who', st.who, 'color', st.color,
                            'width', st.width, 'points', st.points, 'text', st.text, 'piece', st.piece,
                            'deleted', st.deleted);
$$;

-- Put a token down. For a character or the GM, an existing token on that
-- scene moves instead of a second one appearing.
create or replace function public.place_token(p_token text, p_scene uuid, p_piece text, p_points jsonb, p_color text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); st public.strokes; v_piece text := trim(coalesce(p_piece, ''));
begin
  if s.role <> 'gm' and not private.scene_visible(p_scene) then raise exception 'not_shown' using errcode = '42501'; end if;
  if not exists (select 1 from public.scenes where id = p_scene and kind in ('image', 'board')) then raise exception 'not_found'; end if;
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) <> 2 then raise exception 'bad_stroke'; end if;
  if v_piece like 'npc:%' then
    v_piece := 'npc:' || left(trim(substr(v_piece, 5)), 16);
    if v_piece = 'npc:' then raise exception 'empty'; end if;
  elsif v_piece like 'sheet:%' then
    if not exists (select 1 from public.sheets where id::text = substr(v_piece, 7) and deleted_at is null) then raise exception 'not_found'; end if;
  elsif v_piece <> 'gm' then
    raise exception 'bad_stroke';
  end if;

  if v_piece not like 'npc:%' then
    update public.strokes x set points = p_points, updated_at = clock_timestamp()
     where x.scene_id = p_scene and x.piece = v_piece and not x.deleted
    returning * into st;
    if st.id is not null then return private.stroke_json(st); end if;
  end if;

  insert into public.strokes (scene_id, who, color, width, points, piece)
  values (p_scene, private.who(s), left(coalesce(p_color, '#c9a24b'), 20), 1, p_points, v_piece)
  returning * into st;
  return private.stroke_json(st);
end $$;

-- Move tool: text labels and tokens. Anyone who can see the scene can move them.
create or replace function public.move_stroke(p_token text, p_id bigint, p_points jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); st public.strokes;
begin
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) <> 2 then raise exception 'bad_stroke'; end if;
  update public.strokes x set points = p_points, updated_at = clock_timestamp()
   where x.id = p_id and (x.text is not null or x.piece is not null) and not x.deleted
     and (s.role = 'gm' or private.scene_visible(x.scene_id))
  returning * into st;
  if st.id is null then raise exception 'not_found'; end if;
  return private.stroke_json(st);
end $$;

-- Dice stats keep counting after the GM clears the dice log: cleared rolls
-- move to an archive instead of disappearing.
create table if not exists private.roll_archive (like public.rolls);
create index if not exists roll_archive_sheet_idx on private.roll_archive (sheet_id);

create or replace function public.gm_clear_rolls(p_token text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  insert into private.roll_archive select * from public.rolls;
  delete from public.rolls where true;
end $$;

-- Every roll ever made (log + archive), compact, for the GM's dice stats.
create or replace function public.gm_roll_history(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return coalesce((
    select jsonb_agg(jsonb_build_array(r.id, r.sheet_id, r.who, r.kind, r.sides, r.dice, r.total, r.created_at,
                                       r.private, r.label, r.history, r.extras, r.wear_marked) order by r.id)
    from (select * from public.rolls union all select * from private.roll_archive) r
  ), '[]'::jsonb);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.place_token(text, uuid, text, jsonb, text), public.move_stroke(text, bigint, jsonb),
  public.gm_clear_rolls(text), public.gm_roll_history(text) from public;
grant execute on function public.place_token(text, uuid, text, jsonb, text), public.move_stroke(text, bigint, jsonb),
  public.gm_clear_rolls(text), public.gm_roll_history(text) to anon, authenticated;
