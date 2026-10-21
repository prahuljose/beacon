-- Debt v10: the Shop. The GM keeps a catalogue (categories of items with
-- prices, short effects the GM can reveal, private notes, optional stock)
-- and opens or closes the shop. Players put items in a cart and request a
-- purchase; the GM approves or declines. Approval takes the money off the
-- player's sheet, adds the items to Gear (items, weapons) or Kit (armor,
-- apparel), and posts "X bought …" in the chat. The GM can refund an
-- approved order or give an item. Players can't sell.
-- One shop row per room ('live' / 'dev') so local tests never touch the
-- real shop; the chat announcement is only posted from the live room.
-- Apply after v9.sql. Re-runnable.

create table if not exists public.shop (
  room       text primary key check (room in ('live', 'dev')),
  open       boolean not null default false,
  catalog    jsonb not null default '[]'::jsonb,  -- [{ id, name, color, note, hidden, items: [{ id, name, price, effect, shown, notes, hidden, stock, type, dice, die, bonus, stat, wfx, reduction, durability }] }]
  sold       jsonb not null default '{}'::jsonb,  -- { item id: units sold }  (kept apart so catalogue edits never reset it)
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.shop_orders (
  id         bigint generated always as identity primary key,
  room       text not null check (room in ('live', 'dev')),
  sheet_id   uuid not null references public.sheets(id) on delete cascade,
  who        text not null default '',
  items      jsonb not null,                      -- snapshot taken when ordered
  total      int not null check (total >= 0),
  status     text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled', 'refunded')),
  gift       boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  decided_at timestamptz,
  updated_at timestamptz not null default clock_timestamp()
);
create index if not exists shop_orders_room_idx on public.shop_orders (room, id desc);
create index if not exists shop_orders_sheet_idx on public.shop_orders (sheet_id, status);
alter table public.shop enable row level security;
alter table public.shop_orders enable row level security;
revoke all on public.shop, public.shop_orders from anon, authenticated;
insert into public.shop (room) values ('live'), ('dev') on conflict do nothing;

-- Chat lines can now be shop announcements.
alter table public.chat add column if not exists kind text not null default 'msg';

-- Helpers ----------------------------------------------------------------

create or replace function private.shop_int(v text, dflt int default 0)
returns int language sql immutable set search_path = '' as $$
  select case when v ~ '^-?\d{1,7}$' then v::int else dflt end;
$$;

-- One catalogue item, with its category's name and visibility.
create or replace function private.shop_find(cat jsonb, item_id text)
returns jsonb language sql immutable set search_path = '' as $$
  select i || jsonb_build_object('cat', c->>'name', 'cat_hidden', coalesce((c->>'hidden')::boolean, false))
    from jsonb_array_elements(cat) c, jsonb_array_elements(coalesce(c->'items', '[]'::jsonb)) i
   where i->>'id' = item_id
   limit 1;
$$;

-- What players see: open categories, visible items, effects only once
-- revealed, units left when stock is limited. Never the GM's notes.
create or replace function private.shop_public(cat jsonb, sold jsonb)
returns jsonb language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c->>'id', 'name', c->>'name', 'color', c->>'color', 'note', c->>'note',
           'items', (select coalesce(jsonb_agg(jsonb_build_object(
                        'id', i->>'id', 'name', i->>'name', 'price', private.shop_int(i->>'price'),
                        'type', coalesce(i->>'type', 'item'),
                        'effect', case when coalesce((i->>'shown')::boolean, false) then i->>'effect' end,
                        'left', case when jsonb_typeof(i->'stock') = 'number'
                                     then greatest(0, private.shop_int(i->>'stock') - private.shop_int(sold->>(i->>'id'))) end)
                      order by n), '[]'::jsonb)
                       from jsonb_array_elements(coalesce(c->'items', '[]'::jsonb)) with ordinality t(i, n)
                      where not coalesce((i->>'hidden')::boolean, false)))
         order by cn), '[]'::jsonb)
    from jsonb_array_elements(cat) with ordinality x(c, cn)
   where not coalesce((c->>'hidden')::boolean, false);
$$;

-- The Gear or Kit entry for one bought line (oid ties it to the order for refunds).
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
    else jsonb_build_object('name', (it->>'name') || case when qty > 1 then ' ×' || qty else '' end, 'kind', 'item',
           'dice', 1, 'die', 6, 'stat', 'strength', 'bonus', 0, 'effect', '', 'from', 'shop', 'oid', p_oid)
  end;
$$;

create or replace function private.sheet_money(d jsonb)
returns numeric language sql immutable set search_path = '' as $$
  select case when (d->'money'->>'left') ~ '^-?\d{1,9}(\.\d+)?$' then (d->'money'->>'left')::numeric else 0 end;
$$;

-- Carry out an order: check money and stock, take the money, add the items,
-- count them as sold, announce it. Caller holds the locks.
create or replace function private.shop_apply(o public.shop_orders)
returns void language plpgsql security definer set search_path = '' as $$
declare sh public.shop; d jsonb; it jsonb; f jsonb; q int; k int; money numeric; v_sold jsonb; gear jsonb; kit jsonb; label text;
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
      gear := gear || jsonb_build_array(private.shop_entry(it, o.id, q) || stamp);
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

-- API ---------------------------------------------------------------------

create or replace function public.shop_get(p_token text, p_room text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); gm boolean := s.role = 'gm'; sh public.shop;
begin
  select * into sh from public.shop where room = p_room;
  if sh.room is null then raise exception 'not_found'; end if;
  return jsonb_build_object(
    'open', sh.open, 'updated_at', sh.updated_at,
    'catalog', case when gm then sh.catalog when sh.open then private.shop_public(sh.catalog, sh.sold) else '[]'::jsonb end,
    'sold', case when gm then sh.sold end,
    'orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'sheet_id', o.sheet_id, 'who', o.who, 'total', o.total, 'status', o.status, 'gift', o.gift,
               'created_at', o.created_at, 'decided_at', o.decided_at,
               -- players only see names, prices and amounts of their own orders
               'items', case when gm then o.items else (
                 select coalesce(jsonb_agg(jsonb_build_object('name', x->>'name', 'price', x->'price', 'qty', x->'qty')), '[]'::jsonb)
                   from jsonb_array_elements(o.items) x) end)
             order by o.id desc)
        from (select * from public.shop_orders o
               where o.room = p_room and (gm or o.sheet_id = s.sheet_id)
               order by o.id desc limit 200) o), '[]'::jsonb));
end $$;

create or replace function public.gm_shop_save(p_token text, p_room text, p_open boolean default null, p_catalog jsonb default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare sh public.shop;
begin
  perform private.me(p_token, 'gm');
  if p_catalog is not null and (jsonb_typeof(p_catalog) <> 'array' or length(p_catalog::text) > 300000
     or exists (select 1 from jsonb_array_elements(p_catalog) c where jsonb_typeof(c) <> 'object' or jsonb_typeof(coalesce(c->'items', '[]'::jsonb)) <> 'array')) then
    raise exception 'bad_shop';
  end if;
  update public.shop set open = coalesce(p_open, open), catalog = coalesce(p_catalog, catalog), updated_at = clock_timestamp()
   where room = p_room returning * into sh;
  if sh.room is null then raise exception 'not_found'; end if;
  return jsonb_build_object('open', sh.open, 'updated_at', sh.updated_at);
end $$;

-- Player: request a purchase. Prices come from the catalogue, never the client.
create or replace function public.shop_order(p_token text, p_room text, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token); sh public.shop; it jsonb; f jsonb; q int; price int;
  total int := 0; snap jsonb := '[]'::jsonb; money numeric; pend int; npend int; o public.shop_orders;
begin
  if s.role <> 'player' or s.sheet_id is null then raise exception 'players_only'; end if;
  select * into sh from public.shop where room = p_room for update;
  if sh.room is null then raise exception 'not_found'; end if;
  if not sh.open then raise exception 'shop_closed'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 30 then raise exception 'bad_order'; end if;
  for it in select * from jsonb_array_elements(p_items) loop
    q := private.shop_int(it->>'qty', 0);
    if q < 1 or q > 20 then raise exception 'bad_order'; end if;
    f := private.shop_find(sh.catalog, it->>'id');
    if f is null or coalesce((f->>'hidden')::boolean, false) or (f->>'cat_hidden')::boolean then raise exception 'not_for_sale'; end if;
    if jsonb_typeof(f->'stock') = 'number' and private.shop_int(f->>'stock') - private.shop_int(sh.sold->>(f->>'id')) < q then raise exception 'out_of_stock'; end if;
    price := greatest(0, private.shop_int(f->>'price'));
    total := total + price * q;
    snap := snap || jsonb_build_array(jsonb_build_object(
      'id', f->>'id', 'name', f->>'name', 'price', price, 'qty', q, 'cat', f->>'cat', 'type', coalesce(f->>'type', 'item'),
      'dice', f->'dice', 'die', f->'die', 'bonus', f->'bonus', 'stat', f->'stat', 'wfx', f->'wfx',
      'reduction', f->'reduction', 'durability', f->'durability'));
  end loop;
  select private.sheet_money(data) into money from public.sheets where id = s.sheet_id;
  select coalesce(sum(o2.total), 0), count(*) into pend, npend from public.shop_orders o2 where o2.sheet_id = s.sheet_id and o2.status = 'pending';
  if npend >= 5 then raise exception 'too_many_orders'; end if;
  if total > coalesce(money, 0) - pend then raise exception 'not_enough_money'; end if;
  insert into public.shop_orders (room, sheet_id, who, items, total) values (p_room, s.sheet_id, private.who(s), snap, total) returning * into o;
  return jsonb_build_object('id', o.id, 'total', o.total, 'status', o.status);
end $$;

-- Player: withdraw a request the GM hasn't decided yet.
create or replace function public.shop_cancel(p_token text, p_order bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare s private.sessions := private.me(p_token);
begin
  update public.shop_orders set status = 'cancelled', decided_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = p_order and sheet_id = s.sheet_id and status = 'pending';
  if not found then raise exception 'already_decided'; end if;
end $$;

-- GM: approve (carry out) or decline a request.
create or replace function public.gm_shop_decide(p_token text, p_order bigint, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.shop_orders;
begin
  perform private.me(p_token, 'gm');
  select * into o from public.shop_orders where id = p_order for update;
  if o.id is null then raise exception 'not_found'; end if;
  if o.status <> 'pending' then raise exception 'already_decided'; end if;
  if p_approve then perform private.shop_apply(o); end if;
  update public.shop_orders set status = case when p_approve then 'approved' else 'declined' end,
         decided_at = clock_timestamp(), updated_at = clock_timestamp()
   where id = o.id returning * into o;
  return jsonb_build_object('id', o.id, 'status', o.status);
end $$;

-- GM: undo an approved order. Money back, its items taken off the sheet, stock returned.
create or replace function public.gm_shop_refund(p_token text, p_order bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare o public.shop_orders; d jsonb; v_sold jsonb; it jsonb; q int; gone int := 0;
begin
  perform private.me(p_token, 'gm');
  select * into o from public.shop_orders where id = p_order for update;
  if o.id is null then raise exception 'not_found'; end if;
  if o.status <> 'approved' then raise exception 'already_decided'; end if;
  select sold into v_sold from public.shop where room = o.room for update;   -- same lock order as approving: shop, then sheet
  select data into d from public.sheets where id = o.sheet_id for update;
  if d is not null then
    select count(*) into gone from jsonb_array_elements(coalesce(d->'gear', '[]'::jsonb)) g where g->>'oid' = o.id::text;
    d := jsonb_set(d, '{gear}', coalesce((select jsonb_agg(g) from jsonb_array_elements(coalesce(d->'gear', '[]'::jsonb)) g where coalesce(g->>'oid', '') <> o.id::text), '[]'::jsonb));
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

-- GM: give a catalogue item to a player, free or at a price the GM sets.
create or replace function public.gm_shop_give(p_token text, p_room text, p_sheet uuid, p_item text, p_qty int default 1, p_price int default 0)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare sh public.shop; f jsonb; q int := greatest(1, least(20, coalesce(p_qty, 1))); price int := greatest(0, coalesce(p_price, 0));
  o public.shop_orders; who text;
begin
  perform private.me(p_token, 'gm');
  select * into sh from public.shop where room = p_room;
  if sh.room is null then raise exception 'not_found'; end if;
  f := private.shop_find(sh.catalog, p_item);
  if f is null then raise exception 'not_found'; end if;
  select coalesce(data->>'name', 'Player') into who from public.sheets where id = p_sheet and deleted_at is null;
  if who is null then raise exception 'not_found'; end if;
  insert into public.shop_orders (room, sheet_id, who, items, total, gift)
  values (p_room, p_sheet, who, jsonb_build_array(jsonb_build_object(
            'id', f->>'id', 'name', f->>'name', 'price', price, 'qty', q, 'cat', f->>'cat', 'type', coalesce(f->>'type', 'item'),
            'dice', f->'dice', 'die', f->'die', 'bonus', f->'bonus', 'stat', f->'stat', 'wfx', f->'wfx',
            'reduction', f->'reduction', 'durability', f->'durability')), price * q, true)
  returning * into o;
  perform private.shop_apply(o);
  update public.shop_orders set status = 'approved', decided_at = clock_timestamp(), updated_at = clock_timestamp() where id = o.id returning * into o;
  return jsonb_build_object('id', o.id, 'status', o.status);
end $$;

revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.shop_get(text, text), public.gm_shop_save(text, text, boolean, jsonb), public.shop_order(text, text, jsonb),
  public.shop_cancel(text, bigint), public.gm_shop_decide(text, bigint, boolean), public.gm_shop_refund(text, bigint),
  public.gm_shop_give(text, text, uuid, text, int, int) from public;
grant execute on function public.shop_get(text, text), public.gm_shop_save(text, text, boolean, jsonb), public.shop_order(text, text, jsonb),
  public.shop_cancel(text, bigint), public.gm_shop_decide(text, bigint, boolean), public.gm_shop_refund(text, bigint),
  public.gm_shop_give(text, text, uuid, text, int, int) to anon, authenticated;

-- Guard: a browser that hadn't seen a purchase yet may save an older Gear/Kit
-- list a moment later. Items the shop added in the last 20 seconds that are
-- missing from such a save are kept. (Shop items carry `at`, epoch seconds.)
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
         and (x->>'at')::bigint > extract(epoch from clock_timestamp())::bigint - 20
         and not exists (select 1 from jsonb_array_elements(p_value) y where y->>'oid' = x->>'oid' and y->>'name' = x->>'name');
      if jsonb_array_length(fresh) > 0 then d := jsonb_set(d, p_path, p_value || fresh, true); end if;
    end if;
  end if;

  update public.sheets set data = d, updated_at = ts where id = p_id;
  return ts;
end $$;
