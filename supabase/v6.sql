-- Debt v6: everyone gets each character's "has a login" flag (for the
-- players-online list). It was already public through login_options().
-- Apply after v5.sql. Re-runnable.

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
               'has_pass', sh.pass_hash is not null,   -- public anyway via login_options; drives "No login yet"
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

