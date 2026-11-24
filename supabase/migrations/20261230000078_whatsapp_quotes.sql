-- Quoted replies in WhatsApp (SPEC decision 196): a message that answers another one keeps the
-- WhatsApp id of the one it quotes, from the client, from the company's phone, or from the inbox.
alter table app.messages add column reply_to text;
