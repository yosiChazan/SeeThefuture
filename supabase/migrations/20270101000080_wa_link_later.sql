-- A chat finds its person later too (SPEC decision 199): a chat opened before the number was on
-- anyone's card is linked once a card gets that number (a new person, a changed or added phone).
-- Only chats not linked yet; a chat linked by hand stays as it is.

create function app.wa_link_party() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update app.conversations c set client_party_id = app.wa_party_for(c.wa_phone)
   where c.client_party_id is null and app.wa_party_for(c.wa_phone) = new.id;
  return null;
end $$;

create trigger wa_link_party after insert or update of phone, extra_phones on app.parties
  for each row execute function app.wa_link_party();

-- The chats that already have their person on a card.
update app.conversations c set client_party_id = app.wa_party_for(c.wa_phone)
 where c.client_party_id is null and app.wa_party_for(c.wa_phone) is not null;
