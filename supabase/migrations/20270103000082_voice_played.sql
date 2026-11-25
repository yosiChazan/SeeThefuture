-- Voice messages (SPEC decision 206): when the office first played a client's voice message, and
-- who. Its microphone is green until then and blue after, as in WhatsApp.
alter table app.messages add column played_at timestamptz, add column played_by uuid;
