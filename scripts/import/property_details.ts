// Property details from Airtable, Ukraine and Georgia (SPEC decision 70).
//
//   node scripts/import/property_details.ts            dry run: counts of what would change
//   node scripts/import/property_details.ts --run      write the details, then copy the files
//   ... --run --no-files                               write the details only
//
// The first import (scripts/import/load.ts) brought the properties, owners and leases.
// This adds what it left out:
//   - floor, size and notes where the property has none yet (never overwrites);
//   - the purchase as a deal: price, purchase date, referrer, and in Georgia the payments
//     א/ב/ג as installments. Ukraine's payments are free text in mixed currencies, so they
//     are kept word for word in the deal notes instead of being parsed into numbers;
//   - the property's documents (purchase contract, land registry, powers of attorney,
//     payment proofs...), copied server-side like the people's documents, all sensitive.
// Logins, passwords, SIM and bank e-mail fields are never read. Re-running updates the
// same deal (deals.source) and copies only files not yet copied.
// Prints counts only: the data is clients' personal data.

import { cleanName } from './lib/parse.ts';
import { baseIds, copyFiles, lit, records, requireTokens, sql, type AirRecord, type Attachment, type QueueItem } from './lib/remote.ts';

type Country = 'UA' | 'GE';

interface Source {
  country: Country; base: string; table: string; key: string; unit: string;
  floor?: string; sqm?: string; notes: string[];
  price?: string; date?: string; done?: string;
  files: Record<string, string>;
}

const SOURCES: Source[] = [
  {
    country: 'UA', base: 'UKRAINE', table: 'Property', key: 'Name', unit: 'Apartment number', floor: 'floor', sqm: 'Sqm',
    notes: ['Notes'], price: 'סכום עסקה כללי', date: 'Purchase date',
    files: { 'Purchase contract': 'purchase_contract', 'Land book': 'land_book', 'נסח טאבו': 'land_registry', 'Bank documents': 'bank_document', POA: 'poa' },
  },
  {
    country: 'GE', base: 'גאורגיה', table: 'Property', key: 'ID', unit: 'מספר דירה', floor: 'קומה', sqm: 'גודל מ"ר',
    notes: ['Notes', 'Check list', 'Check list 2', 'Check list 3'], price: 'עלות הדירה', date: 'תאריך רכישה (ראשוני)', done: 'תאריך השלמת עסקה (משני)',
    files: {
      'חוזה': 'purchase_contract', 'נסח טאבו': 'land_registry', 'יפויי כוח': 'poa', 'חוזה ניהול שירותים ': 'management_contract', 'הערת אזהרה': 'caveat',
      'הוכחות תשלום': 'payment_proof', "מסמך מאשר העברת תשלום א'": 'payment_proof', "קבלה על תשלום א'": 'payment_proof',
      "מסמך מאשר העברת תשלום ב'": 'payment_proof', 'חשבונית לתשלום שני': 'payment_proof', "הוכחת תשלום ב'": 'payment_proof',
      'מסמך מאשר העברת תשלום ב': 'payment_proof', 'הוכחת תשלום ג': 'payment_proof', 'קבלה על תשלום ג': 'payment_proof',
    },
  },
];

const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)).trim();
const num = (v: unknown) => {
  const m = str(v).replace(/,/g, '').match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const money = (v: unknown) => (typeof v === 'number' ? `${v.toLocaleString('en-US')}$` : str(v));

// What the deal notes keep word for word, by country.
function dealNotes(c: Country, f: Record<string, unknown>, names: Map<string, string>): string[] {
  const line = (label: string, v: unknown) => (str(v) ? `${label}: ${typeof v === 'number' ? money(v) : str(v)}` : '');
  if (c === 'UA') {
    return [
      line('שולם ע"י הלקוח על העסקה', f['שולם ע"י הלקוח על העסקה']),
      line('רכישה + תשלום כללי', f['Purchase + general payment']),
      line('תשלום רכישה 1', f['purchase payment - 1']),
      line('תשלום רכישה 2', f['purchase payment - 2']),
      line('תשלום רכישה 3', f['purchase payment - 3']),
      line('דמי תיווך', f['Broker fee']), line('עו"ד', f['Lawyer']), line('מספר מס', f['Tax number']), line('שיפוץ', f['Renovation']),
    ].filter(Boolean);
  }
  const via = ((f['התכתבות עם החברה מהמייל של'] as string[] | undefined) ?? []).map((id) => names.get(id) ?? '').filter(Boolean).join(', ');
  return [
    line('עלות כוללת דמי ניהול', f['עלות כוללת דמי ניהול ']),
    f['האם הועבר תשלום א'] ? "תשלום א' הועבר" : '',
    via ? `התכתבות עם החברה מהמייל של: ${via}` : '',
  ].filter(Boolean);
}

// Georgia's payments א/ב/ג as installments: amount and due date when known.
function installments(f: Record<string, unknown>) {
  const out: { n: string; amount: number; due: string | null }[] = [];
  const a = num(f['תשלום א']);
  if (a) out.push({ n: "תשלום א'", amount: a, due: str(f['תאריך רכישה (ראשוני)']) || null });
  const b = num(f["סכום לתשלום ב'"]) ?? num(f['תשלום ב']);
  if (b) out.push({ n: "תשלום ב'", amount: b, due: str(f["תאריך תשלום ב'"]) || null });
  const c = num(f["סכום לתשלום ג'"]);
  if (c) out.push({ n: "תשלום ג'", amount: c, due: str(f["תאריך תשלום ג'"]) || null });
  return out;
}

interface Target { id: string; floor: string | null; sqm: number | null; notes: string | null; owner: string | null }

async function main() {
  requireTokens();
  const run = process.argv.includes('--run');
  const bases = await baseIds();
  const hani = (await sql<{ id: string }>(`select id from app.parties where display_name = 'חני שטיגליץ בעמ' limit 1`))[0]?.id ?? null;

  const statements: string[] = [];
  const files: QueueItem[] = [];
  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };

  for (const s of SOURCES) {
    const baseId = bases.get(s.base);
    if (!baseId) throw new Error(`no Airtable base named ${s.base}`);
    const people = new Map((await records(baseId, s.country === 'GE' ? 'person' : 'Person')).map((r) => [r.id, str(r.fields.Name)]));
    const refs = new Map((await sql<{ external_key: string; entity_id: string }>(
      `select external_key, entity_id from app.external_refs where source = ${lit(`airtable_${s.country.toLowerCase()}`)} and entity_type = 'property'`))
      .map((r) => [cleanName(r.external_key), r.entity_id]));
    const props = new Map((await sql<Target>(`select p.id, p.floor, p.sqm, p.notes,
        (select o.party_id from app.ownerships o where o.property_id = p.id and o.valid_to is null order by o.share_pct desc, o.party_id limit 1)::text as owner
      from app.properties p where p.country_code = ${lit(s.country)}`)).map((p) => [p.id, p]));

    for (const r of await records(baseId, s.table) as AirRecord[]) {
      const f = r.fields;
      // The first import stored the primary field cleaned (spaces, invisible marks), with the
      // unit appended where two records shared a name.
      const key = cleanName(str(f[s.key]));
      const id = refs.get(cleanName(`${key} [${str(f[s.unit])}]`)) ?? refs.get(key);
      const p = id ? props.get(id) : undefined;
      if (!p) { count(`${s.country}: not in the system`); continue; }
      count(`${s.country}: properties`);

      // Details the property does not have yet.
      const sets: string[] = [];
      if (!p.floor && s.floor && str(f[s.floor])) { sets.push(`floor = ${lit(str(f[s.floor]))}`); count(`${s.country}: floor added`); }
      const sqm = s.sqm ? num(f[s.sqm]) : null;
      if (p.sqm === null && sqm && sqm < 1000) { sets.push(`sqm = ${sqm}`); count(`${s.country}: size added`); }
      const notes = s.notes.map((n) => str(f[n])).filter(Boolean).join('\n');
      if (!p.notes && notes) { sets.push(`notes = ${lit(notes)}`); count(`${s.country}: notes added`); }
      if (sets.length) statements.push(`update app.properties set ${sets.join(', ')} where id = ${lit(p.id)};`);

      // The purchase.
      const price = s.price ? num(f[s.price]) : null;
      const date = s.date ? str(f[s.date]) || null : null;
      const done = s.done ? str(f[s.done]) || null : null;
      const dnotes = dealNotes(s.country, f, people);
      const inst = s.country === 'GE' ? installments(f) : [];
      const referrer = s.country === 'GE' && f['באה דרך חני'] ? hani : null;
      if ((price || date || dnotes.length || inst.length) && p.owner) {
        count(`${s.country}: deals`);
        if (inst.length) count(`${s.country}: installments`, inst.length);
        const source = `airtable:${r.id}`;
        const status = done || date ? 'completed' : 'in_progress';
        statements.push(`
with d as (
  insert into app.deals (property_id, client_party_id, country_code, signed_on, status, total_price, price_currency, referrer_party_id, notes, source)
  values (${lit(p.id)}, ${lit(p.owner)}, ${lit(s.country)}, ${lit(date)}, ${lit(status)}, ${price ?? 'null'}, ${price ? "'USD'" : 'null'}, ${lit(referrer)}, ${lit(dnotes.join('\n'))}, ${lit(source)})
  on conflict (source) where source is not null do update set signed_on = excluded.signed_on, status = excluded.status,
    total_price = excluded.total_price, price_currency = excluded.price_currency, referrer_party_id = excluded.referrer_party_id, notes = excluded.notes
  returning id
), gone as (
  delete from app.installments where deal_id in (select id from d) and paid_txn_id is null
)
insert into app.installments (deal_id, due_date, amount, currency, notes)
select d.id, x.due, x.amount, 'USD', x.n from d,
  (values ${inst.length ? inst.map((i) => `(${lit(i.due)}::date, ${i.amount}::numeric, ${lit(i.n)})`).join(', ') : '(null::date, null::numeric, null::text)'}) as x(due, amount, n)
where x.amount is not null;`);
      } else if (price || date) count(`${s.country}: deal skipped (no current owner)`);

      // The property's documents.
      for (const [field, docType] of Object.entries(s.files)) {
        for (const a of (f[field] as Attachment[] | undefined) ?? []) {
          files.push({ url: a.url, att_id: `${a.id}_p`, file_name: a.filename, content_type: a.type, country: s.country, entity_type: 'property', entity_id: p.id, doc_type: docType });
          count(`${s.country}: files (${docType})`);
          count('MB of files', Math.round((a.size ?? 0) / 1e4) / 100);
        }
      }
    }
  }

  console.log(tally);
  if (!run) { console.log('dry run: nothing written. Add --run to write the details and copy the files.'); return; }
  // One request per chunk; each runs as a transaction.
  for (let i = 0; i < statements.length; i += 20) await sql(statements.slice(i, i + 20).join('\n'));
  console.log(`details written (${statements.length} statements)`);
  if (process.argv.includes('--no-files')) { console.log(`files not copied (${files.length} waiting)`); return; }
  // The same Airtable file can sit in two fields of a property: copy it once.
  const seen = new Set<string>();
  await copyFiles(files.filter((f) => !seen.has(f.att_id) && !!seen.add(f.att_id)));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
