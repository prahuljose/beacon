-- Debt v8: GM can delete chat messages or erase the whole chat (soft delete:
-- rows stay in the table with deleted_at set, hidden from everyone), and
-- chat_send is rate limited (5 messages per 10 s, 20 per minute per sender).
-- Apply after v7.sql. Re-runnable.

alter table public.chat add column if not exists deleted_at timestamptz;
create index if not exists chat_deleted_idx on public.chat (deleted_at) where deleted_at is not null;

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
      from (select * from public.chat m where m.created_at > since and m.deleted_at is null and private.can_see_chat(s, m)
            order by m.id desc limit 100) m), '[]'::jsonb),
    -- Ids the GM deleted since the last sync, so every client drops them.
    'chat_deleted', case when p_since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(m.id) from public.chat m where m.deleted_at > since), '[]'::jsonb) end,
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

create or replace function public.chat_send(p_token text, p_body text, p_private boolean default false, p_to uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat; priv boolean := coalesce(p_private, false);
  sender text := coalesce(s.sheet_id::text, 'gm'); recent int; minute int;
begin
  if length(trim(coalesce(p_body, ''))) = 0 then raise exception 'empty'; end if;
  if priv and s.role = 'gm' and p_to is null then raise exception 'pick_player'; end if;
  -- One sender at a time, so a burst can't slip past the count.
  perform pg_advisory_xact_lock(hashtext('chat:' || sender));
  select count(*) filter (where created_at > clock_timestamp() - interval '10 seconds'),
         count(*) filter (where created_at > clock_timestamp() - interval '60 seconds')
    into recent, minute
    from public.chat
   where created_at > clock_timestamp() - interval '60 seconds'
     and (case when s.sheet_id is null then sheet_id is null else sheet_id = s.sheet_id end);
  if recent >= 5 or minute >= 20 then raise exception 'slow_down'; end if;
  insert into public.chat (sheet_id, who, body, private, to_sheet)
  values (s.sheet_id, private.who(s), left(trim(p_body), 1000), priv, case when priv and s.role = 'gm' then p_to end)
  returning * into m;
  delete from public.chat where id < m.id - 500;
  return to_jsonb(m);
end $$;

-- GM: hide one message for everyone.
create or replace function public.gm_chat_delete(p_token text, p_id bigint)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.me(p_token, 'gm');
  update public.chat set deleted_at = clock_timestamp() where id = p_id and deleted_at is null;
end $$;

-- GM: hide every message for everyone. Returns how many were hidden.
create or replace function public.gm_chat_clear(p_token text)
returns int language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  perform private.me(p_token, 'gm');
  update public.chat set deleted_at = clock_timestamp() where deleted_at is null;
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.gm_chat_delete(text, bigint), public.gm_chat_clear(text) from public;
grant execute on function public.sync(text, timestamptz), public.chat_send(text, text, boolean, uuid),
  public.gm_chat_delete(text, bigint), public.gm_chat_clear(text) to anon, authenticated;
