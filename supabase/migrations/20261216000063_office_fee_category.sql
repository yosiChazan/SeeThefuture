-- Two management fees (SPEC decision 167): the local manager's ("דמי ניהול מנהל", mgmt_fee) and
-- the office's ("דמי ניהול משרד", office_fee). The new value is used from the next migration on
-- (a new enum value cannot be used in the transaction that adds it).
alter type app.txn_category add value if not exists 'office_fee';
