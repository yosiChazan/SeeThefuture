-- "Alliance special" apartments (SPEC decision 197): something about them the office keeps to
-- itself. Their clients get no automatic message, the AI included, without an admin's approval,
-- and every chat with them says so in plain sight.

alter table app.properties add column special_alliance boolean not null default false;

update app.properties set special_alliance = true where id in (
  'efbadd99-26de-5c19-8d08-5c28bcb42b94',  -- 3023
  'c06b8b5e-153d-5cb8-b1fd-208e9d8a60e8',  -- 3505
  '0eb1a97f-1728-51ff-8cf9-058b87de9458',  -- 3519
  'abf951e5-3062-5ba9-a152-600d617ced2b',  -- 2908
  'a79bd54c-ed65-5a16-88fb-393788aa2db9',  -- 2906
  '0d78a7f5-ec76-50ab-aac5-5ff000129c07'); -- 1305

-- Only an admin marks an apartment, or unmarks it.
create function app.special_alliance_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.special_alliance is distinct from old.special_alliance and not app.is_admin() and auth.uid() is not null then
    raise exception 'רק מנהל המערכת מסמן דירה כ"אליאנס מיוחד"' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger special_alliance_guard before update of special_alliance on app.properties
  for each row execute function app.special_alliance_guard();

-- The clients who own such an apartment now (staff only).
create function app.special_alliance_parties() returns table (party_id uuid)
language sql stable security definer set search_path = '' as $$
  select distinct o.party_id from app.ownerships o join app.properties p on p.id = o.property_id
   where p.special_alliance and (o.valid_to is null or o.valid_to > current_date) and app.is_staff()
$$;
revoke all on function app.special_alliance_parties() from public;
grant execute on function app.special_alliance_parties() to authenticated;

-- Is this chat with such a client (for the functions, with the service role).
create function app.wa_special(p_conversation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.conversations c join app.ownerships o on o.party_id = c.client_party_id
                   join app.properties p on p.id = o.property_id
                  where c.id = p_conversation and p.special_alliance and (o.valid_to is null or o.valid_to > current_date))
$$;
revoke all on function app.wa_special(uuid) from public;
grant execute on function app.wa_special(uuid) to service_role;

-- The AI in such a chat only with an admin's approval, kept on the chat.
alter table app.conversations add column ai_special_ok boolean not null default false;
