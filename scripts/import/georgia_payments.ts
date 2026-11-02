// Georgia's purchase payments from Airtable `payments` into the property cards (SPEC decision 83).
//
//   node scripts/import/georgia_payments.ts            dry run: counts only
//   node scripts/import/georgia_payments.ts --run      write the payments, then copy the proofs
//   ... --run --no-files                               write the payments only
//
// One row per Airtable record in app.purchase_payments (source = airtable:<record id>), so a
// re-run updates the same rows. Payer and payee keep the Airtable name; the party is linked
// when the name matches one in the system. The attachments become the property's
// payment_proof documents, sensitive, through the same queue as decision 70.
// Prints counts only: the data is clients' personal data.

import { cleanName, nameKey } from './lib/parse.ts';
import { baseIds, copyFiles, lit, records, requireTokens, sql, type Attachment, type QueueItem } from './lib/remote.ts';

const CURRENCY: Record<string, string> = { 'ש"ח': 'ILS', 'דולר': 'USD', 'לארי': 'GEL', 'אירו': 'EUR', 'דו': 'USD' };
const KIND: Record<string, string> = { 'הוצאה': 'expense', 'הוצאה שטרם שולמה': 'expense', 'הכנסה': 'income', 'הכנסה שטרם התקבלה': 'income', 'הלוואה': 'loan', 'העברה בין חשבונות זהים': 'transfer' };
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v)).trim();

async function main() {
  requireTokens();
  const run = process.argv.includes('--run');
  const base = (await baseIds()).get('גאורגיה');
  if (!base) throw new Error('no Airtable base named גאורגיה');

  const refs = new Map((await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable_ge' and entity_type = 'property'`)).map((r) => [cleanName(r.external_key), r.entity_id]));
  const props = new Map((await records(base, 'Property')).map((r) => {
    const key = cleanName(str(r.fields.ID));
    const unit = str(r.fields['מספר דירה']);
    // Where one owner has two flats, Airtable keeps only the last digits ("05" for 1505).
    const tail = [...refs.keys()].filter((k) => k.startsWith(`${key} [`) && unit && k.slice(0, -1).endsWith(unit));
    return [r.id, refs.get(cleanName(`${key} [${unit}]`)) ?? refs.get(key) ?? (tail.length === 1 ? refs.get(tail[0]) : undefined)];
  }));
  const people = new Map((await records(base, 'person')).map((r) => [r.id, cleanName(str(r.fields.Name))]));

  // Parties by order-insensitive name: display name, first+last, and the first import's key.
  const parties = new Map<string, string>();
  for (const p of await sql<{ id: string; display_name: string; first_name: string | null; last_name: string | null }>(
    `select id, display_name, first_name, last_name from app.parties`)) {
    for (const n of [p.display_name, `${p.first_name ?? ''} ${p.last_name ?? ''}`]) if (nameKey(n)) parties.set(nameKey(n), p.id);
  }
  for (const r of await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable' and entity_type = 'party'`)) {
    if (!parties.has(nameKey(r.external_key))) parties.set(nameKey(r.external_key), r.entity_id);
  }

  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const rows: string[] = [];
  const files: QueueItem[] = [];

  for (const r of await records(base, 'payments')) {
    const f = r.fields;
    const propertyId = ((f.Property as string[] | undefined) ?? []).map((id) => props.get(id)).find(Boolean);
    if (!propertyId) { count('skipped: no property in the system'); continue; }
    const amount = typeof f['סכום'] === 'number' ? f['סכום'] : null;
    const currency = CURRENCY[str(f['מטבע'])] ?? null;
    const notes = str(f.Notes);
    if (amount === null && !notes && !(f.Attachments as unknown[] | undefined)?.length) { count('skipped: empty'); continue; }
    if (amount !== null && !currency) { count('skipped: amount without currency'); continue; }
    const kind = KIND[str(f.Select)] ?? 'expense';
    const who = (field: string) => {
      const name = ((f[field] as string[] | undefined) ?? []).map((id) => people.get(id)).filter(Boolean).join(', ');
      const id = name ? parties.get(nameKey(name)) ?? null : null;
      count(`${field}: ${!name ? 'empty' : id ? 'linked' : 'name only'}`);
      return { name: name || null, id };
    };
    const payer = who('משלם'), payee = who('מקבל');
    count('payments');
    count(`currency ${currency ?? 'none'}`);
    rows.push(`(${lit(propertyId)}::uuid, ${lit(str(f['תאריך']) || null)}::date, ${lit(kind)}, ${amount ?? 'null'}::numeric, ${lit(currency)}::app.currency,
      ${lit(payer.id)}::uuid, ${lit(payer.name)}, ${lit(payee.id)}::uuid, ${lit(payee.name)}, ${lit(notes || null)}, ${lit(`airtable:${r.id}`)})`);
    for (const a of (f.Attachments as Attachment[] | undefined) ?? []) {
      files.push({ url: a.url, att_id: `${a.id}_p`, file_name: a.filename, content_type: a.type, country: 'GE', entity_type: 'property', entity_id: propertyId, doc_type: 'payment_proof' });
      count('files');
      count('MB of files', Math.round((a.size ?? 0) / 1e4) / 100);
    }
  }

  console.log(tally);
  if (!run) { console.log('dry run: nothing written. Add --run to write.'); return; }
  for (let i = 0; i < rows.length; i += 100) {
    await sql(`insert into app.purchase_payments (property_id, country_code, paid_on, kind, amount, currency, payer_party_id, payer_name, payee_party_id, payee_name, notes, source)
select x.p, 'GE', x.d, x.k, x.a, x.c, x.pp, x.pn, x.qp, x.qn, x.n, x.s from (values ${rows.slice(i, i + 100).join(',\n')}) as x(p, d, k, a, c, pp, pn, qp, qn, n, s)
on conflict (source) where source is not null do update set paid_on = excluded.paid_on, kind = excluded.kind, amount = excluded.amount,
  currency = excluded.currency, payer_party_id = excluded.payer_party_id, payer_name = excluded.payer_name,
  payee_party_id = excluded.payee_party_id, payee_name = excluded.payee_name, notes = excluded.notes, property_id = excluded.property_id;`);
  }
  console.log(`payments written (${rows.length})`);
  if (process.argv.includes('--no-files')) { console.log(`files not copied (${files.length} waiting)`); return; }
  const seen = new Set<string>();
  await copyFiles(files.filter((x) => !seen.has(x.att_id) && !!seen.add(x.att_id)));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
