-- More phone numbers for a client or a contact, each with what it is (SPEC decision 154): the
-- main number keeps its column and gets a label (phone_label, e.g. "נייד", "בעל הבית"); the others
-- are a list [{"phone": "+972…", "label": "…"}] in extra_phones. Same access as the party itself.
alter table app.parties
  add column phone_label text,
  add column extra_phones jsonb not null default '[]'::jsonb check (jsonb_typeof(extra_phones) = 'array');
