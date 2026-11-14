-- Debt v14: quantities on Gear items.
--  * A bought item (not a weapon) is one Gear entry with a "qty", instead of a
--    name like "Crowbar ×5".
--  * A bundle name splits into its parts: "Cordless drill + 2 batteries" becomes
--    "Cordless drill" (qty 1) and "Battery" (qty 2). Buying 3 of it gives 3 and 6.
--  * Parts with the same name in one order are added together.
-- Weapons, armor and apparel are unchanged (one entry each). Refunds are
-- unchanged: they still remove every entry the order added.
-- Apply after v13.sql. Re-runnable.

-- "A + 2 things + other" -> [{name, qty}, ...]. Only parts after a " + " are
-- read as "<count> <plural>"; the first part keeps its name as written.
create or replace function private.shop_parts(p_name text, p_qty int)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare parts text[] := regexp_split_to_array(coalesce(p_name, ''), '\s+\+\s+');
  res jsonb := '[]'::jsonb; p text; m text[]; i int; n int; label text; q int := greatest(1, coalesce(p_qty, 1));
begin
  for i in 1 .. coalesce(array_length(parts, 1), 0) loop
    p := trim(parts[i]);
    if p = '' then continue; end if;
    n := 1; label := p;
    if i > 1 then
      m := regexp_match(p, '^(\d{1,3})\s+(\S.*)$');
      if m is not null and m[1]::int > 0 then
        n := m[1]::int; label := m[2];
        if n > 1 then
          label := case when label ~* '[^aeiou]ies$' then regexp_replace(label, 'ies$', 'y', 'i')
                        when label ~* '(ch|sh|x|ss|z)es$' then regexp_replace(label, 'es$', '', 'i')
                        when label ~* '[^s]s$' then regexp_replace(label, 's$', '', 'i')
                        else label end;
        end if;
      end if;
      label := upper(left(label, 1)) || substr(label, 2);
    end if;
    res := res || jsonb_build_array(jsonb_build_object('name', label, 'qty', least(999, n * q)));
  end loop;
  if jsonb_array_length(res) = 0 then
    res := jsonb_build_array(jsonb_build_object('name', coalesce(p_name, ''), 'qty', least(999, q)));
  end if;
  return res;
end $$;

-- As v10, but an item carries its count in "qty" instead of in its name.
create or replace function private.shop_entry(it jsonb, p_oid bigint, qty int)
returns jsonb language sql immutable set search_path = '' as $$
  select case coalesce(it->>'type', 'item')
    when 'weapon' then jsonb_build_object('name', it->>'name', 'kind', 'weapon',
           'dice', greatest(1, least(20, private.shop_int(it->>'dice', 1))),
           'die', greatest(2, least(10, private.shop_int(it->>'die', 6))),
           'stat', coalesce(it->>'stat', ''), 'bonus', private.shop_int(it->>'bonus', 0),
           'effect', coalesce(it->>'wfx', ''), 'from', 'shop', 'oid', p_oid)
    when 'armor' then jsonb_build_object('name', it->>'name', 'kind', 'armor',
           'durability', greatest(0, private.shop_int(it->>'durability', 0)), 'reduction', greatest(0, private.shop_int(it->>'reduction', 0)),
           'from', 'shop', 'oid', p_oid)
    when 'apparel' then jsonb_build_object('name', it->>'name', 'kind', 'apparel', 'durability', 0, 'reduction', 0, 'from', 'shop', 'oid', p_oid)
    else jsonb_build_object('name', it->>'name', 'kind', 'item', 'qty', greatest(1, least(999, coalesce(qty, 1))),
           'dice', 1, 'die', 6, 'stat', 'strength', 'bonus', 0, 'effect', '', 'from', 'shop', 'oid', p_oid)
  end;
$$;

-- As v10, except how plain items are added to Gear (see the top of this file).
create or replace function private.shop_apply(o public.shop_orders)
returns void language plpgsql security definer set search_path = '' as $$
declare sh public.shop; d jsonb; it jsonb; f jsonb; q int; k int; money numeric; v_sold jsonb; gear jsonb; kit jsonb; label text;
  part jsonb; idx int;
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
        -- Same name already added by this order (a bundle part plus the item itself): add to it.
        select g.i - 1 into idx
          from jsonb_array_elements(gear) with ordinality as g(x, i)
         where g.x->>'oid' = o.id::text and coalesce(g.x->>'kind', 'item') = 'item'
           and lower(g.x->>'name') = lower(part->>'name') and (g.x->>'qty') ~ '^\d{1,4}$'
         limit 1;
        if idx is not null then
          gear := jsonb_set(gear, array[idx::text, 'qty'],
                            to_jsonb(least(999, (gear->idx->>'qty')::int + (part->>'qty')::int)));
        else
          gear := gear || jsonb_build_array(
            private.shop_entry(it || jsonb_build_object('name', part->>'name'), o.id, (part->>'qty')::int) || stamp);
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

revoke execute on all functions in schema private from public, anon, authenticated;
