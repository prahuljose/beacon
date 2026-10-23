-- Debt v11: "last seen" for the Who's here list. Each open app checks in about
-- once a minute; the reply is everyone's last check-in, so offline players can
-- show "last seen 12 min ago". Kept out of sheets on purpose: touching a sheet
-- row would make every client re-sync it.
-- Apply after v10.sql. Re-runnable.

create table if not exists public.last_seen (
  who text primary key,                              -- sheet id, or 'gm'
  at  timestamptz not null default clock_timestamp()
);
alter table public.last_seen enable row level security;
revoke all on public.last_seen from anon, authenticated;

create or replace function public.seen(p_token text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  insert into public.last_seen (who, at)
  values (case when s.role = 'gm' then 'gm' else s.sheet_id::text end, clock_timestamp())
  on conflict (who) do update set at = excluded.at;
  return coalesce((select jsonb_object_agg(who, at) from public.last_seen), '{}'::jsonb);
end $$;

revoke execute on function public.seen(text) from public;
grant execute on function public.seen(text) to anon, authenticated;
