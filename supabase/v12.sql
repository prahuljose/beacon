-- Debt v12: chat extras. Emoji reactions on messages and pictures in chat.
-- (@mentions need nothing here: they're plain text the app highlights.)
--  * chat.reactions  { "👍": ["gm", "<sheet id>"], ... } and chat.reacted_at, so
--    sync can send reaction changes on messages a client already has.
--  * chat.image      { "w": 1280, "h": 720 } when the message has a picture. The
--    picture itself lives in chat_images and is fetched on its own, so syncs stay
--    small. Only the newest 50 pictures are kept.
--  * chat_send is untouched; pictures go through chat_send_image.
-- Apply after v11.sql. Re-runnable.

alter table public.chat add column if not exists reactions jsonb not null default '{}'::jsonb;
alter table public.chat add column if not exists reacted_at timestamptz;
alter table public.chat add column if not exists image jsonb;
create index if not exists chat_reacted_idx on public.chat (reacted_at) where reacted_at is not null;

create table if not exists public.chat_images (
  chat_id    bigint primary key references public.chat(id) on delete cascade,
  data       text not null,                                   -- data:image/…;base64,…
  created_at timestamptz not null default clock_timestamp()
);
alter table public.chat_images enable row level security;
revoke all on public.chat_images from anon, authenticated;

-- Toggle one reaction for the caller. Returns the message's reactions.
create or replace function public.chat_react(p_token text, p_id bigint, p_emoji text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat;
  me text := case when s.role = 'gm' then 'gm' else s.sheet_id::text end; list jsonb; cur jsonb;
begin
  if p_emoji is null or p_emoji not in ('👍', '❤️', '😂', '😮', '💀', '🎲') then raise exception 'bad_emoji'; end if;
  select * into m from public.chat where id = p_id and deleted_at is null for update;
  if m.id is null or not private.can_see_chat(s, m) then raise exception 'not_found'; end if;
  list := coalesce(m.reactions -> p_emoji, '[]'::jsonb);
  list := case when list ? me then list - me else list || to_jsonb(me) end;
  cur := case when jsonb_array_length(list) = 0 then m.reactions - p_emoji
              else jsonb_set(m.reactions, array[p_emoji], list) end;
  update public.chat set reactions = cur, reacted_at = clock_timestamp() where id = m.id;
  return jsonb_build_object('id', m.id, 'reactions', cur);
end $$;

-- A message with a picture (and an optional caption). Same rules and rate limit
-- as chat_send.
create or replace function public.chat_send_image(p_token text, p_image text, p_w int, p_h int,
  p_body text default '', p_private boolean default false, p_to uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat; priv boolean := coalesce(p_private, false);
  sender text := coalesce(s.sheet_id::text, 'gm'); recent int; minute int;
begin
  if p_image is null or length(p_image) > 600000
     or p_image !~ '^data:image/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$' then raise exception 'bad_image'; end if;
  if p_w is null or p_h is null or p_w not between 1 and 10000 or p_h not between 1 and 10000 then raise exception 'bad_image'; end if;
  if priv and s.role = 'gm' and p_to is null then raise exception 'pick_player'; end if;
  perform pg_advisory_xact_lock(hashtext('chat:' || sender));
  select count(*) filter (where created_at > clock_timestamp() - interval '10 seconds'),
         count(*) filter (where created_at > clock_timestamp() - interval '60 seconds')
    into recent, minute
    from public.chat
   where created_at > clock_timestamp() - interval '60 seconds'
     and (case when s.sheet_id is null then sheet_id is null else sheet_id = s.sheet_id end);
  if recent >= 5 or minute >= 20 then raise exception 'slow_down'; end if;
  insert into public.chat (sheet_id, who, body, private, to_sheet, image)
  values (s.sheet_id, private.who(s), left(trim(coalesce(p_body, '')), 1000), priv,
          case when priv and s.role = 'gm' then p_to end, jsonb_build_object('w', p_w, 'h', p_h))
  returning * into m;
  insert into public.chat_images (chat_id, data) values (m.id, p_image);
  delete from public.chat_images where chat_id < (select min(chat_id) from (select chat_id from public.chat_images order by chat_id desc limit 50) k);
  delete from public.chat where id < m.id - 500;
  return to_jsonb(m);
end $$;

-- The picture for one message, if the caller can see that message.
create or replace function public.chat_image(p_token text, p_id bigint)
returns text language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.chat;
begin
  select * into m from public.chat where id = p_id and deleted_at is null;
  if m.id is null or not private.can_see_chat(s, m) then raise exception 'not_found'; end if;
  return (select data from public.chat_images where chat_id = m.id);
end $$;

-- sync: as v8, plus 'chat_react' (reaction changes on messages the client already has).
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
    'chat_deleted', case when p_since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(m.id) from public.chat m where m.deleted_at > since), '[]'::jsonb) end,
    'chat_react', case when p_since is null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'reactions', m.reactions))
      from public.chat m
      where m.reacted_at > since and m.created_at <= since and m.deleted_at is null and private.can_see_chat(s, m)), '[]'::jsonb) end,
    'roll_min', (select min(id) from public.rolls),
    'sheets', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sh.id, 'data', sh.data, 'sort', sh.sort,
               'has_pass', sh.pass_hash is not null,
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

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.chat_react(text, bigint, text), public.chat_send_image(text, text, int, int, text, boolean, uuid),
  public.chat_image(text, bigint) from public;
grant execute on function public.chat_react(text, bigint, text), public.chat_send_image(text, text, int, int, text, boolean, uuid),
  public.chat_image(text, bigint) to anon, authenticated;
