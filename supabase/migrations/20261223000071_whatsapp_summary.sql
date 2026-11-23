-- An AI summary of where each WhatsApp chat stands (SPEC decision 186): what the client wants,
-- what was done, what is still open and who should act next. Written by whatsapp-ai on request
-- (and when a chat is opened after new messages), shown at the top of the chat and on the
-- client's card.
alter table app.conversations
  add column ai_summary      text,
  add column ai_summary_at   timestamptz,
  add column ai_waiting_on   text check (ai_waiting_on in ('us', 'client', 'none'));
