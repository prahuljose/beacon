-- Debt v13: Vault lock. The GM can freeze the Vault: while crew.settings.vault_locked
-- is true, players can still see the Vault (when it's live) but can't change any
-- box. The GM always can. The switch itself is a setting (gm_set_settings), so
-- there is no new table or column.
-- Apply after v12.sql. Re-runnable.

create or replace function public.vault_set(p_token text, p_code text, p_state text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); b public.vault_boxes;
begin
  if s.role <> 'gm' and not private.vault_visible() then raise exception 'not_shown' using errcode = '42501'; end if;
  if s.role <> 'gm' and coalesce((select settings -> 'vault_locked' from public.crew where id = 1), 'false'::jsonb) = 'true'::jsonb then
    raise exception 'vault_locked' using errcode = '42501';
  end if;
  if coalesce(p_state, '') not in ('', 'open', 'progress', 'complete') then raise exception 'bad_state'; end if;
  update public.vault_boxes set state = coalesce(p_state, ''), updated_by = private.who(s), updated_at = clock_timestamp()
   where code = upper(p_code) returning * into b;
  if b.code is null then raise exception 'not_found'; end if;
  return jsonb_build_object('code', b.code, 'state', b.state, 'by', b.updated_by,
                            'danger', case when s.role = 'gm' or b.state <> '' then b.danger else false end);
end $$;
