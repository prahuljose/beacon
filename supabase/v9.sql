-- Debt v9: shared background music. The GM picks a YouTube video or playlist
-- (saved as "moods") and controls playback; every client plays it in sync.
-- One row per room: 'live' for the real site, 'dev' for local testing, so
-- tests never reach real players. Separate from sync() on purpose.
-- Apply after v8.sql. Re-runnable.

create table if not exists public.music (
  room       text primary key check (room in ('live', 'dev')),
  state      jsonb not null default '{}'::jsonb,   -- { mood, title, vid, list, index, playing, pos, at, loop }
  moods      jsonb not null default '[]'::jsonb,   -- [{ id, name, url, vid, list }]
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.music enable row level security;
revoke all on public.music from anon, authenticated;
insert into public.music (room) values ('live'), ('dev') on conflict do nothing;

-- Anyone logged in reads the current state; only the GM gets the mood list.
create or replace function public.music_get(p_token text, p_room text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); m public.music;
begin
  select * into m from public.music where room = p_room;
  if m.room is null then raise exception 'not_found'; end if;
  return jsonb_build_object('state', m.state, 'updated_at', m.updated_at, 'server_now', clock_timestamp(),
                            'moods', case when s.role = 'gm' then m.moods end);
end $$;

-- GM only. The server stamps `at` (when `pos` was true) so clocks don't matter.
create or replace function public.gm_music_set(p_token text, p_room text, p_state jsonb default null, p_moods jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare m public.music;
begin
  perform private.me(p_token, 'gm');
  if p_state is not null and (jsonb_typeof(p_state) <> 'object' or length(p_state::text) > 4000) then raise exception 'bad_music'; end if;
  if p_moods is not null and (jsonb_typeof(p_moods) <> 'array' or jsonb_array_length(p_moods) > 60 or length(p_moods::text) > 30000) then raise exception 'bad_music'; end if;
  update public.music
     set state = case when p_state is null then state else p_state || jsonb_build_object('at', clock_timestamp()) end,
         moods = coalesce(p_moods, moods),
         updated_at = clock_timestamp()
   where room = p_room
  returning * into m;
  if m.room is null then raise exception 'not_found'; end if;
  return jsonb_build_object('state', m.state, 'updated_at', m.updated_at, 'server_now', clock_timestamp(), 'moods', m.moods);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.music_get(text, text), public.gm_music_set(text, text, jsonb, jsonb) from public;
grant execute on function public.music_get(text, text), public.gm_music_set(text, text, jsonb, jsonb) to anon, authenticated;
