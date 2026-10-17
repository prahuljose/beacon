-- Debt v5: Turn Order scene (GM-controlled state) and moving text labels.
-- Apply after v4.sql. Re-runnable.

alter table public.scenes add column if not exists state jsonb not null default '{}'::jsonb;  -- turns: { entries, current, round }
alter table public.scenes drop constraint if exists scenes_kind_check;
alter table public.scenes add constraint scenes_kind_check check (kind in ('image', 'vault', 'board', 'turns'));
insert into public.scenes (kind, title, sort, state)
select 'turns', 'Turn Order', 1, '{"entries": [], "current": 0, "round": 1}'::jsonb
 where not exists (select 1 from public.scenes where kind = 'turns');

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
                                          'active', active, 'updated_at', updated_at,
                                          'state', case when kind = 'turns' then state end) order by sort, created_at)
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

create or replace function public.gm_scenes(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'title', title, 'caption', caption,
                                                       'thumb', thumb, 'active', active, 'state', state, 'updated_at', updated_at)
                                    order by sort, created_at), '[]'::jsonb) from public.scenes);
end $$;

-- The GM sets the whole Turn Order state at once.
create or replace function public.gm_scene_state(p_token text, p_id uuid, p_state jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare ts timestamptz := clock_timestamp();
begin
  perform private.me(p_token, 'gm');
  if jsonb_typeof(p_state) <> 'object' or pg_column_size(p_state) > 100000 then raise exception 'bad_state'; end if;
  update public.scenes set state = p_state, updated_at = ts where id = p_id and kind = 'turns';
  if not found then raise exception 'not_found'; end if;
  return ts;
end $$;

-- Select tool: move a text label. Anyone who can see the scene can move it.
create or replace function public.move_stroke(p_token text, p_id bigint, p_points jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); st public.strokes;
begin
  if jsonb_typeof(p_points) <> 'array' or jsonb_array_length(p_points) <> 2 then raise exception 'bad_stroke'; end if;
  update public.strokes x set points = p_points, updated_at = clock_timestamp()
   where x.id = p_id and x.text is not null and not x.deleted
     and (s.role = 'gm' or private.scene_visible(x.scene_id))
  returning * into st;
  if st.id is null then raise exception 'not_found'; end if;
  return private.stroke_json(st);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.gm_scene_state(text, uuid, jsonb), public.move_stroke(text, bigint, jsonb) from public;
grant execute on function public.sync(text, timestamptz), public.gm_scenes(text),
  public.gm_scene_state(text, uuid, jsonb), public.move_stroke(text, bigint, jsonb) to anon, authenticated;
