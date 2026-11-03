// Ukraine's purchases from the Kyiv Drive files, by the office's choices (SPEC decision 84).
//
//   node scripts/import/ukraine_kyiv.ts <choices.json>         dry run: counts only
//   node scripts/import/ukraine_kyiv.ts <choices.json> --run   write
//   ... --sql <file>                                          also save the statements (to check them first)
//
// <choices.json> comes from the selection page (ukraine-kyiv-choices.html, built outside the
// repo from "סיכומי עסקאות PLC לקוחות קייב" and "סיכום תשלומי דירות"). Every chosen item
// carries its value, so this script writes only what the office approved, as structured data:
//   unit                 → the property's number;
//   price / signed_on    → the property's purchase deal (created when there is none);
//   payments             → app.purchase_payments rows: date, kind, amount, currency and the
//                          dollar value only where the sheet states it;
//   installments         → the deal's payments not paid yet;
//   note                 → one short line in the deal notes.
// A re-run replaces what an earlier run wrote from these files (by source), nothing else.
// Prints counts only: the data is clients' personal data.

import { readFileSync, writeFileSync } from 'node:fs';
import { lit, requireTokens, sql } from './lib/remote.ts';

type Chosen = { kind: string; data: unknown };
type Item = Chosen | boolean | null;
interface Choices { source: string; version?: number; properties: Record<string, { title: string; import: Record<string, Item> }> }
export interface Payment { date: string | null; amount: number; currency: string; usd: number | null; kind: string; label: string }
interface Planned { amount: number; due: string | null; label: string }

const SECTION = '— מהקבצים של קייב (Drive) —';
const TAG = '(קייב)';
const KINDS = new Set(['payment', 'fee', 'expense', 'transfer']);

export function mergeNotes(old: string | null, section: string[]): string | null {
  const kept = (old ?? '').split(SECTION)[0].trimEnd();
  if (!section.length) return kept || null;
  return [kept, `${SECTION}\n${section.join('\n\n')}`].filter(Boolean).join('\n\n');
}

// The rows for app.purchase_payments, checked: a dollar value only beside another currency.
export function paymentValues(propertyId: string, pays: Payment[]): string[] {
  return pays.map((x, i) => {
    if (!KINDS.has(x.kind)) throw new Error(`unknown kind ${x.kind}`);
    if (!(x.amount > 0)) throw new Error('a payment without an amount');
    const usd = x.currency === 'USD' ? null : x.usd;
    return `(${lit(propertyId)}::uuid, ${lit(x.date)}::date, ${lit(x.kind)}, ${x.amount}::numeric, ${lit(x.currency)}::app.currency, ${usd ?? 'null'}::numeric, ${lit(x.label || null)}, ${lit(`drive_kyiv:${propertyId}:${i + 1}`)})`;
  });
}

async function main() {
  requireTokens();
  const path = process.argv[2];
  if (!path || path.startsWith('--')) throw new Error('usage: ukraine_kyiv.ts <choices.json> [--run]');
  const run = process.argv.includes('--run');
  const choices = JSON.parse(readFileSync(path, 'utf8')) as Choices;
  if (choices.source !== 'drive_kyiv' || choices.version !== 2) throw new Error('not a choices file from the current Kyiv selection page');

  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const statements: string[] = [];

  for (const [propertyId, p] of Object.entries(choices.properties)) {
    const chosen = Object.values(p.import).filter((i): i is Chosen => !!i && typeof i === 'object');
    if (!chosen.length) continue;
    const prop = (await sql<{ id: string; owner: string | null; deal: string | null; notes: string | null }>(`
      select p.id,
        (select o.party_id from app.ownerships o where o.property_id = p.id and o.valid_to is null order by o.share_pct desc, o.party_id limit 1)::text as owner,
        (select d.id from app.deals d where d.property_id = p.id order by d.signed_on nulls last, d.id limit 1)::text as deal,
        (select d.notes from app.deals d where d.property_id = p.id order by d.signed_on nulls last, d.id limit 1) as notes
      from app.properties p where p.id = ${lit(propertyId)} and p.country_code = 'UA'`))[0];
    if (!prop) { count('property not in the system'); continue; }
    count('properties');
    const one = (k: string) => chosen.find((i) => i.kind === k)?.data;

    const unit = one('unit');
    if (unit !== undefined) { statements.push(`update app.properties set unit_no = ${lit(String(unit))} where id = ${lit(prop.id)};`); count('unit'); }

    const pays = (one('payments') as Payment[] | undefined) ?? [];
    if (pays.length) {
      count('payments', pays.length);
      statements.push(`delete from app.purchase_payments where property_id = ${lit(prop.id)} and source like ${lit(`drive_kyiv:${prop.id}:%`)};
insert into app.purchase_payments (property_id, country_code, paid_on, kind, amount, currency, amount_usd, notes, source)
select x.p, 'UA', x.d, x.k, x.a, x.c, x.u, x.n, x.s from (values ${paymentValues(prop.id, pays).join(',\n  ')}) as x(p, d, k, a, c, u, n, s);`);
    }

    const signed = one('signed_on'), price = one('price'), note = one('note');
    const inst = (one('installments') as Planned[] | undefined) ?? [];
    if (signed === undefined && price === undefined && note === undefined && !inst.length) continue;
    if (!prop.deal && !prop.owner) { count('skipped: no deal and no current owner'); continue; }

    const upd = [`notes = ${lit(mergeNotes(prop.notes, note === undefined ? [] : [String(note)]))}`];
    if (signed !== undefined) { upd.push(`signed_on = ${lit(String(signed))}`); count('purchase date'); }
    if (price !== undefined) { upd.push(`total_price = ${Number(price)}`, `price_currency = 'USD'`); count('price'); }
    if (note !== undefined) count('notes');
    if (inst.length) count('installments', inst.length);
    // One statement's parts share a snapshot: a deal created here cannot be updated by a
    // sibling part, so the new deal gets its values in the insert itself.
    const cols = upd.map((u) => u.split(' = ')[0]), vals = upd.map((u) => u.split(' = ').slice(1).join(' = '));
    const deal = prop.deal
      ? `update app.deals set ${upd.join(', ')} where id = ${lit(prop.deal)} returning id`
      : `insert into app.deals (property_id, client_party_id, country_code, status, source, ${cols.join(', ')})
         values (${lit(prop.id)}, ${lit(prop.owner)}, 'UA', 'in_progress', ${lit(`drive_kyiv:${prop.id}`)}, ${vals.join(', ')})
         on conflict (source) where source is not null do update set ${cols.map((c) => `${c} = excluded.${c}`).join(', ')} returning id`;
    if (!prop.deal) count('deals created');
    statements.push(`
with d as (${deal}),
gone as (delete from app.installments where deal_id in (select id from d) and paid_txn_id is null and notes like ${lit(`%${TAG}`)})
insert into app.installments (deal_id, due_date, amount, currency, notes)
select d.id, x.due, x.amount, 'USD', x.n from d,
  (values ${inst.length ? inst.map((i) => `(${lit(i.due)}::date, ${Number(i.amount)}::numeric, ${lit(`${i.label || 'תשלום'} ${TAG}`)})`).join(', ') : '(null::date, null::numeric, null::text)'}) as x(due, amount, n)
where x.amount is not null;`);
  }

  console.log(tally);
  const dump = process.argv.indexOf('--sql');
  if (dump > 0) { writeFileSync(process.argv[dump + 1], statements.join('\n')); console.log(`SQL written to ${process.argv[dump + 1]}`); }
  if (!run) { console.log('dry run: nothing written. Add --run to write.'); return; }
  for (const s of statements) await sql(s);
  console.log(`written (${statements.length} statements)`);
}

if (import.meta.main ?? process.argv[1]?.endsWith('ukraine_kyiv.ts')) main().catch((e) => { console.error(e.message); process.exit(1); });
