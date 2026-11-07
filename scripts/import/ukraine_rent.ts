// Ukraine's rent history from Airtable ("rent payment"), as approved by the office
// (SPEC decision 120): one charge per apartment and month, before 2026, as history
// (app.charges, paid), received in Gershon's box. Balances are not touched.
//
//   node scripts/import/ukraine_rent.ts           dry run: counts only
//   node scripts/import/ukraine_rent.ts --run     write
//
// Rules:
//   - rows whose "for month" is a month name; the year comes from the payment date (a payment
//     in January for December is the previous year's); rows with no date are left out;
//   - a row linked to several apartments counts for the first, as in the approved table;
//   - several payments of one month are one row (summed, notes joined);
//   - a month the apartment already has (a rent charge, or rent in the ledger, entered by
//     hand or from a report) is skipped: never two rows for one month;
//   - UAH is the amount; a dollar amount alongside is noted as the source's equivalent, and
//     a dollar-only payment is in dollars;
//   - note lines about money moving to Gershon or offsetting ("הועבר לגרשון", "הופקד לכרטיס
//     של גרשון", "יקוזז מהשכירות") are not copied.
// Prints counts only, never names.

import { cleanName } from './lib/parse.ts';
import { baseIds, lit, records, requireTokens, sql } from './lib/remote.ts';

const MONTH: Record<string, number> = { 'ינואר': 1, 'פברואר': 2, 'מרץ': 3, 'אפריל': 4, 'מאי': 5, 'יוני': 6, 'יולי': 7, 'אוגוסט': 8, 'ספטמבר': 9, 'אוקטובר': 10, 'נובמבר': 11, 'דצמבר': 12 };
const NOT_COPIED = /(הועבר\s+לגרשון|הופקד\s+לכרטיס\s+של\s+גרשון|יקוזז\s+מהשכירות)/;

// The month a payment is for: its month name, in the year of the payment date, moved a year
// back or forward when the payment is more than half a year away from that month.
export function periodOf(forMonth: string, paidOn: string | undefined): string | null {
  const m = MONTH[forMonth.trim()];
  if (!m || !paidOn) return null;
  let y = Number(paidOn.slice(0, 4));
  const pm = Number(paidOn.slice(5, 7));
  if (m - pm > 6) y -= 1; else if (pm - m > 6) y += 1;
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

// The note without the lines that must not be copied.
export function cleanNote(note: string | undefined): string {
  return (note ?? '').split('\n').map((l) => l.trim()).filter((l) => l && !NOT_COPIED.test(l)).join('\n');
}

async function main() {
  requireTokens();
  const run = process.argv.includes('--run');
  const base = (await baseIds()).get('UKRAINE');
  if (!base) throw new Error('no Airtable base named UKRAINE');
  const [rows, props] = await Promise.all([records(base, 'rent payment'), records(base, 'Property')]);
  const propName = new Map(props.map((p) => [p.id, cleanName(String(p.fields.Name ?? ''))]));
  const refs = new Map((await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable_ua' and entity_type = 'property'`)).map((r) => [cleanName(r.external_key), r.entity_id]));
  // Months that already have rent: a rent charge, or rent in the ledger (draft or posted).
  const taken = new Set((await sql<{ k: string }>(`
    select property_id::text || '|' || period::text as k from app.charges where kind = 'rent'
    union select e.property_id::text || '|' || t.period::text from app.entries e join app.transactions t on t.id = e.transaction_id
      where t.category = 'rent' and t.status <> 'void' and e.property_id is not null`)).map((r) => r.k));

  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const months = new Map<string, { property: string; period: string; currency: 'UAH' | 'USD'; amount: number; usd: number; paid: string; notes: string[]; ids: string[] }>();
  for (const r of rows) {
    const f = r.fields as Record<string, unknown>;
    const forMonth = String(f['תשלום עבור חודש'] ?? '').trim();
    if (!MONTH[forMonth]) { count('not a monthly rent (left out)'); continue; }
    const paid = f['תאריך '] as string | undefined;
    const period = periodOf(forMonth, paid);
    if (!period) { count('no date (left out)'); continue; }
    if (period >= '2026-01-01') { count('2026 (left out: not history)'); continue; }
    const pid = (f.Property as string[] | undefined)?.[0];
    const property = pid ? refs.get(propName.get(pid) ?? '') : undefined;
    if (!property) { count('apartment not in the system (left out)'); continue; }
    const uah = Number(f['סכום גריבנה'] ?? 0), usd = Number(f['סכום דולר'] ?? 0);
    if (!uah && !usd) { count('no amount (left out)'); continue; }
    if (taken.has(`${property}|${period}`)) { count('month already has rent (skipped)'); continue; }
    const k = `${property}|${period}`;
    const currency = uah ? 'UAH' : 'USD';
    const m = months.get(k) ?? months.set(k, { property, period, currency, amount: 0, usd: 0, paid: paid!, notes: [], ids: [] }).get(k)!;
    if (m.currency !== currency) { count('mixed currencies in one month (left out, check)'); continue; }
    m.amount += currency === 'UAH' ? uah : usd;
    if (currency === 'UAH' && usd) m.usd += usd;
    if (paid! > m.paid) m.paid = paid!;
    const note = cleanNote(f['הערות'] as string | undefined);
    if (note) m.notes.push(note);
    m.ids.push(r.id);
    count('payments');
  }

  const values = [...months.values()].map((m) => {
    const notes = ['שכירות בקופת גרשון (היסטוריה מ-Airtable)', m.usd ? `שווה ערך לפי המקור: $${m.usd}` : '', m.ids.length > 1 ? `${m.ids.length} תשלומים בחודש` : '', ...m.notes].filter(Boolean).join('\n');
    return `(${lit(m.property)}, ${lit(m.period)}, 'rent', ${Math.round(m.amount * 100) / 100}, ${lit(m.currency)}, ${lit(m.paid)}, 'tenant', 'paid', ${lit(notes)}, ${lit(`airtable_ua_rent:${m.property}:${m.period}`)})`;
  });
  tally['rows to write (apartment × month)'] = values.length;
  tally['UAH total'] = Math.round([...months.values()].filter((m) => m.currency === 'UAH').reduce((a, m) => a + m.amount, 0));
  tally['USD total'] = Math.round([...months.values()].filter((m) => m.currency === 'USD').reduce((a, m) => a + m.amount, 0));
  console.log(tally);
  if (!run) { console.log('dry run: nothing written. Add --run to write.'); return; }
  for (let i = 0; i < values.length; i += 200) {
    await sql(`insert into app.charges (property_id, period, kind, amount, currency, due_date, payer, status, notes, source) values ${values.slice(i, i + 200).join(',\n')}
      on conflict (source) where source is not null do nothing`);
  }
  console.log(`written: ${values.length}`);
}

if (import.meta.main) await main();
