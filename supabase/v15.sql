-- Debt v15: buying an item you already have adds to that Gear row.
--  * shop_apply: a bought item (or bundle part) is added to the first Gear item
--    row with the same name (any capitals), whether it was bought or typed in.
--    No such row: a new one, as in v14. Weapons, armor and apparel never merge.
--  * Each row remembers what each order added: "lots": { "<order id>": [qty, at] }.
--  * gm_shop_refund takes back only that order's share of a row.
--  * patch_sheet: a Gear list saved by a browser that hadn't seen a purchase yet
--    (last 20 s) gets that purchase's lots put back, so the save can't undo it.
-- Apply after v14.sql. Re-runnable.

-- A Gear row's count. Rows from before quantities count as 1.
create or replace function private.gear_qty(g jsonb)
returns int language sql immutable set search_path = '' as $$
  select case when (g->>'qty') ~ '^\d{1,4}$' then least(999, (g->>'qty')::int) else 1 end;
$$;

-- A row's name and count, reading old shop rows named like "Padlock ×3".
create or replace function private.gear_base(g jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select case
    when g ? 'oid' and (g->>'qty') is null and (g->>'name') ~ '^.*\S\s*×\s*\d{1,3}$'
      then jsonb_build_object('name', (regexp_match(g->>'name', '^(.*\S)\s*×\s*(\d{1,3})$'))[1],
                              'qty', greatest(1, (regexp_match(g->>'name', '^(.*\S)\s*×\s*(\d{1,3})$'))[2]::int))
    else jsonb_build_object('name', coalesce(g->>'name', ''), 'qty', private.gear_qty(g))
  end;
$$;

-- Put back shop lots (last 20 s) that a saved Gear list doesn't know about.
create or replace function private.gear_keep_lots(old_list jsonb, new_list jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare res jsonb := new_list; x jsonb; k text; v jsonb; idx int;
  now_s bigint := extract(epoch from clock_timestamp())::bigint;
begin
  if jsonb_typeof(old_list) is distinct from 'array' or jsonb_typeof(new_list) is distinct from 'array' then return new_list; end if;
  for x in select * from jsonb_array_elements(old_list) loop
    continue when jsonb_typeof(x->'lots') is distinct from 'object';
    for k, v in select * from jsonb_each(x->'lots') loop
      continue when jsonb_typeof(v) is distinct from 'array' or k !~ '^\d{1,15}$'
                 or coalesce(v->>0, '') !~ '^\d{1,4}$' or coalesce(v->>1, '') !~ '^\d{9,11}$'
                 or (v->>1)::bigint <= now_s - 20;
      -- A list that carries any lot of this order has seen the whole order.
      continue when exists (select 1 from jsonb_array_elements(new_list) y
                             where jsonb_typeof(y->'lots') = 'object' and y->'lots' ? k);
      select g.i - 1 into idx
        from jsonb_array_elements(res) with ordinality as g(y, i)
       where jsonb_typeof(g.y) = 'object' and coalesce(g.y->>'kind', 'item') <> 'weapon'
         and btrim(coalesce(x->>'name', '')) <> ''
         and lower(btrim(coalesce(g.y->>'name', ''))) = lower(btrim(x->>'name'))
       order by g.i limit 1;
      if idx is not null then
        res := jsonb_set(res, array[idx::text], (res->idx) || jsonb_build_object(
                 'qty', least(999, private.gear_qty(res->idx) + (v->>0)::int),
                 'lots', (case when jsonb_typeof(res->idx->'lots') = 'object' then res->idx->'lots' else '{}'::jsonb end)
                         || jsonb_build_object(k, v)));
      else
        res := res || jsonb_build_array(x || jsonb_build_object(
                 'qty', (v->>0)::int, 'lots', jsonb_build_object(k, v), 'oid', k::bigint, 'from', 'shop', 'at', (v->>1)::bigint));
      end if;
    end loop;
  end loop;
  return res;
end $$;

-- As v14, except a plain item joins an existing row with the same name.
create or replace function private.shop_apply(o public.shop_orders)
returns void language plpgsql security definer set search_path = '' as $$
declare sh public.shop; d jsonb; it jsonb; f jsonb; q int; k int; money numeric; v_sold jsonb; gear jsonb; kit jsonb; label text;
  part jsonb; idx int; base jsonb; lot jsonb;
  at_s bigint := extract(epoch from clock_timestamp())::bigint;
  stamp jsonb := jsonb_build_object('at', extract(epoch from clock_timestamp())::bigint);
begin
  select * into sh from public.shop where room = o.room for update;
  select data into d from public.sheets where id = o.sheet_id and deleted_at is null for update;
  if d is null then raise exception 'not_found'; end if;
  money := private.sheet_money(d);
  if o.total > 0 and money < o.total then raise exception 'not_enough_money'; end if;
  v_sold := coalesce(sh.sold, '{}'::jsonb);
  gear := case when jsonb_typeof(d->'gear') = 'array' then d->'gear' else '[]'::jsonb end;
  kit  := case when jsonb_typeof(d->'kit')  = 'array' then d->'kit'  else '[]'::jsonb end;
  for it in select * from jsonb_array_elements(o.items) loop
    q := greatest(1, private.shop_int(it->>'qty', 1));
    f := private.shop_find(sh.catalog, it->>'id');
    if f is not null and jsonb_typeof(f->'stock') = 'number'
       and private.shop_int(f->>'stock') - private.shop_int(v_sold->>(it->>'id')) < q then
      raise exception 'out_of_stock';
    end if;
    v_sold := jsonb_set(v_sold, array[it->>'id'], to_jsonb(private.shop_int(v_sold->>(it->>'id')) + q));
    if coalesce(it->>'type', 'item') in ('armor', 'apparel') then
      for k in 1..q loop kit := kit || jsonb_build_array(private.shop_entry(it, o.id, 1) || stamp); end loop;
    elsif it->>'type' = 'weapon' then
      for k in 1..q loop gear := gear || jsonb_build_array(private.shop_entry(it, o.id, 1) || stamp); end loop;
    else
      for part in select * from jsonb_array_elements(private.shop_parts(it->>'name', q)) loop
        lot := jsonb_build_array((part->>'qty')::int, at_s);
        select g.i - 1 into idx
          from jsonb_array_elements(gear) with ordinality as g(x, i)
         where jsonb_typeof(g.x) = 'object' and coalesce(g.x->>'kind', 'item') <> 'weapon'
           and btrim(coalesce(part->>'name', '')) <> ''
           and lower(btrim(private.gear_base(g.x)->>'name')) = lower(btrim(part->>'name'))
         order by g.i limit 1;
        if idx is not null then
          base := private.gear_base(gear->idx);
          -- A row that already holds a lot of this same order (bundle part + the item itself) just grows that lot.
          if jsonb_typeof(gear->idx->'lots') = 'object' and gear->idx->'lots' ? o.id::text then
            lot := jsonb_build_array(private.shop_int(gear->idx->'lots'->o.id::text->>0) + (part->>'qty')::int, at_s);
          end if;
          gear := jsonb_set(gear, array[idx::text], (gear->idx) || jsonb_build_object(
                    'name', base->>'name',
                    'qty', least(999, (base->>'qty')::int + (part->>'qty')::int),
                    'lots', (case when jsonb_typeof(gear->idx->'lots') = 'object' then gear->idx->'lots' else '{}'::jsonb end)
                            || jsonb_build_object(o.id::text, lot)));
        else
          gear := gear || jsonb_build_array(
            private.shop_entry(it || jsonb_build_object('name', part->>'name'), o.id, (part->>'qty')::int) || stamp
              || jsonb_build_object('lots', jsonb_build_object(o.id::text, lot)));
        end if;
      end loop;
    end if;
  end loop;
  d := jsonb_set(d, '{gear}', gear);
  d := jsonb_set(d, '{kit}', kit);
  d := d || jsonb_build_object('money', (case when jsonb_typeof(d->'money') = 'object' then d->'money' else '{}'::jsonb end)
                                        || jsonb_build_object('left', money - o.total));
  update public.sheets set data = d, updated_at = clock_timestamp() where id = o.sheet_id;
  update public.shop set sold = v_sold, updated_at = clock_timestamp() where room = o.room;
  if o.room = 'live' then
    select string_agg((x->>'name') || case when private.shop_int(x->>'qty', 1) > 1 then ' ×' || (x->>'qty') else '' end, ', ')
      into label from jsonb_array_elements(o.items) x;
    insert into public.chat (sheet_id, who, body, kind)
    values (o.sheet_id, o.who,
            case when o.gift then 'got ' || label || ' from the GM' else 'bought ' || label end
              || case when o.total > 0 then ' ($' || o.total || ')' else '' end,
            'shop');
  end if;
end $$;

-- One Gear row after order p_oid is refunded: null = remove the row.
create or replace function private.gear_refund_row(g jsonb, p_oid text)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare lots jsonb := case when jsonb_typeof(g->'lots') = 'object' then g->'lots' else '{}'::jsonb end;
  qty int := private.gear_qty(g); own int; rest jsonb; other int; nk text; res jsonb;
begin
  if jsonb_typeof(g) is distinct from 'object' then return g; end if;
  select coalesce(sum(private.shop_int(e.value->>0)), 0) into other from jsonb_each(lots) e where e.key <> p_oid;
  if lots ? p_oid then own := greatest(0, private.shop_int(lots->p_oid->>0));
  elsif g->>'oid' = p_oid then own := greatest(0, qty - other);          -- made by this order before lots existed
    if own = 0 and other = 0 then own := qty; end if;
  else return g;
  end if;
  if g->>'oid' = p_oid and other = 0 then return null; end if;             -- nothing else in the row: it goes
  if qty - own <= 0 then return null; end if;
  rest := lots - p_oid;
  res := (g - 'lots') || jsonb_build_object('qty', qty - own);
  if rest <> '{}'::jsonb then res := res || jsonb_build_object('lots', rest); end if;
  if g->>'oid' = p_oid then
    select e.key into nk from jsonb_each(rest) e order by e.key limit 1;
    res := res || jsonb_build_object('oid', nk::bigint);
  end if;
  return res;
end $$;

-- As v10, except Gear rows give back only this order's share.
create or replace function public.gm_shop_refund(p_token text, p_order bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.shop_orders; d jsonb; v_sold jsonb; it jsonb; q int;
begin
  perform private.me(p_token, 'gm');
  select * into o from public.shop_orders where id = p_order for update;
  if o.id is null then raise exception 'not_found'; end if;
  if o.status <> 'approved' then raise exception 'already_decided'; end if;
  select sold into v_sold from public.shop where room = o.room for update;   -- same lock order as approving: shop, then sheet
  select data into d from public.sheets where id = o.sheet_id for update;
  if d is not null then
    d := jsonb_set(d, '{gear}', coalesce((
           select jsonb_agg(z.ng order by z.i)
             from (select t.i, private.gear_refund_row(t.g, o.id::text) as ng
                     from jsonb_array_elements(coalesce(d->'gear', '[]'::jsonb)) with ordinality as t(g, i)) z
            where z.ng is not null), '[]'::jsonb));
    d := jsonb_set(d, '{kit}',  coalesce((select jsonb_agg(k) from jsonb_array_elements(coalesce(d->'kit', '[]'::jsonb)) k where coalesce(k->>'oid', '') <> o.id::text), '[]'::jsonb));
    d := d || jsonb_build_object('money', (case when jsonb_typeof(d->'money') = 'object' then d->'money' else '{}'::jsonb end)
                                          || jsonb_build_object('left', private.sheet_money(d) + o.total));
    update public.sheets set data = d, updated_at = clock_timestamp() where id = o.sheet_id;
  end if;
  for it in select * from jsonb_array_elements(o.items) loop
    q := greatest(1, private.shop_int(it->>'qty', 1));
    v_sold := jsonb_set(coalesce(v_sold, '{}'::jsonb), array[it->>'id'], to_jsonb(greatest(0, private.shop_int(v_sold->>(it->>'id')) - q)));
  end loop;
  update public.shop set sold = v_sold, updated_at = clock_timestamp() where room = o.room;
  update public.shop_orders set status = 'refunded', updated_at = clock_timestamp() where id = o.id returning * into o;
  return jsonb_build_object('id', o.id, 'status', o.status);
end $$;

-- As before, plus the lot guard on Gear (rows with lots are handled by it, not by the oid+name guard).
create or replace function public.patch_sheet(p_token text, p_id uuid, p_path text[], p_value jsonb)
returns timestamptz language plpgsql security definer set search_path = '' as $$
declare
  s private.sessions := private.me(p_token);
  d jsonb; i int; ts timestamptz := clock_timestamp(); old_list jsonb; fresh jsonb;
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
    old_list := d #> p_path;
    for i in 1 .. array_length(p_path, 1) - 1 loop
      if jsonb_typeof(d #> p_path[1:i]) is distinct from 'object'
         and jsonb_typeof(d #> p_path[1:i]) is distinct from 'array' then
        d := jsonb_set(d, p_path[1:i], '{}'::jsonb, true);
      end if;
    end loop;
    d := jsonb_set(d, p_path, coalesce(p_value, 'null'::jsonb), true);
    if array_length(p_path, 1) = 1 and p_path[1] in ('gear', 'kit')
       and jsonb_typeof(p_value) = 'array' and jsonb_typeof(old_list) = 'array' then
      select coalesce(jsonb_agg(x), '[]'::jsonb) into fresh
        from jsonb_array_elements(old_list) x
       where x ? 'oid' and (x->>'at') ~ '^\d{9,11}$'
         and jsonb_typeof(x->'lots') is distinct from 'object'
         and (x->>'at')::bigint > extract(epoch from clock_timestamp())::bigint - 20
         and not exists (select 1 from jsonb_array_elements(p_value) y where y->>'oid' = x->>'oid' and y->>'name' = x->>'name');
      if jsonb_array_length(fresh) > 0 then d := jsonb_set(d, p_path, p_value || fresh, true); end if;
      if p_path[1] = 'gear' then
        d := jsonb_set(d, p_path, private.gear_keep_lots(old_list, d #> p_path), true);
      end if;
    end if;
  end if;

  update public.sheets set data = d, updated_at = ts where id = p_id;
  return ts;
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
