// Ukraine's purchase details from the Kyiv Drive files, by the office's choices (SPEC decision 84).
//
//   node scripts/import/ukraine_kyiv.ts <choices.json>         dry run: counts only
//   node scripts/import/ukraine_kyiv.ts <choices.json> --run   write
//   ... --sql <file>                                          also save the statements (to check them first)
//
// <choices.json> comes from the selection page (ukraine-kyiv-choices.html, built outside the
// repo from "סיכומי עסקאות PLC לקוחות קייב" and "סיכום תשלומי דירות"). Every chosen item
// carries its value, so this script only writes what the office approved:
//   unit / floor / sqm      → the property;
//   signed_on / price       → the property's purchase deal (created when there is none);
//   detail / balance        → a section of the deal notes, kept word for word, replaced on re-run;
//   installments            → planned payments of the deal, replaced on re-run (paid ones kept).
// Prints counts only: the data is clients' personal data.

import { readFileSync, writeFileSync } from 'node:fs';
import { lit, requireTokens, sql } from './lib/remote.ts';

type Item = { kind: string; data: unknown } | boolean | null;
interface Choices { source: string; properties: Record<string, { title: string; import: Record<string, Item> }> }

const SECTION = '— מהקבצים של קייב (Drive) —';
const INST_TAG = '(סיכום תשלומי דירות)';

export function mergeNotes(old: string | null, section: string[]): string | null {
  const kept = (old ?? '').split(SECTION)[0].trimEnd();
  if (!section.length) return kept || null;
  return [kept, `${SECTION}\n${section.join('\n\n')}`].filter(Boolean).join('\n\n');
}

async function main() {
  requireTokens();
  const path = process.argv[2];
  if (!path || path.startsWith('--')) throw new Error('usage: ukraine_kyiv.ts <choices.json> [--run]');
  const run = process.argv.includes('--run');
  const choices = JSON.parse(readFileSync(path, 'utf8')) as Choices;
  if (choices.source !== 'drive_kyiv') throw new Error('not a choices file from the Kyiv selection page');

  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const statements: string[] = [];

  for (const [propertyId, p] of Object.entries(choices.properties)) {
    const chosen = Object.values(p.import).filter((i): i is { kind: string; data: unknown } => !!i && typeof i === 'object');
    if (!chosen.length) continue;
    const prop = (await sql<{ id: string; owner: string | null; deal: string | null; notes: string | null }>(`
      select p.id,
        (select o.party_id from app.ownerships o where o.property_id = p.id and o.valid_to is null order by o.share_pct desc, o.party_id limit 1)::text as owner,
        (select d.id from app.deals d where d.property_id = p.id order by d.signed_on nulls last, d.id limit 1)::text as deal,
        (select d.notes from app.deals d where d.property_id = p.id order by d.signed_on nulls last, d.id limit 1) as notes
      from app.properties p where p.id = ${lit(propertyId)} and p.country_code = 'UA'`))[0];
    if (!prop) { count('property not in the system'); continue; }
    count('properties');
    const of = (k: string) => chosen.filter((i) => i.kind === k).map((i) => i.data);

    const sets: string[] = [];
    const [unit] = of('unit'), [floor] = of('floor'), [sqm] = of('sqm');
    if (unit !== undefined) { sets.push(`unit_no = ${lit(String(unit))}`); count('unit'); }
    if (floor !== undefined) { sets.push(`floor = ${lit(String(floor))}`); count('floor'); }
    if (sqm !== undefined) { sets.push(`sqm = ${Number(sqm)}`); count('size'); }
    if (sets.length) statements.push(`update app.properties set ${sets.join(', ')} where id = ${lit(prop.id)};`);

    const [signed] = of('signed_on'), [price] = of('price');
    const section = [...of('balance'), ...of('detail')].map(String);
    const inst = (of('installments')[0] as { n: number; amount: number; paid: boolean }[] | undefined) ?? [];
    if (signed === undefined && price === undefined && !section.length && !inst.length) continue;
    if (!prop.deal && !prop.owner) { count('skipped: no deal and no current owner'); continue; }

    const notes = mergeNotes(prop.notes, section);
    const upd = [`notes = ${lit(notes)}`];
    if (signed !== undefined) { upd.push(`signed_on = ${lit(String(signed))}`); count('purchase date'); }
    if (price !== undefined) { upd.push(`total_price = ${Number(price)}`, `price_currency = 'USD'`); count('price'); }
    if (section.length) count('notes sections', section.length);
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
gone as (delete from app.installments where deal_id in (select id from d) and paid_txn_id is null and notes like ${lit(`%${INST_TAG}`)})
insert into app.installments (deal_id, amount, currency, notes)
select d.id, x.amount, 'USD', x.n from d,
  (values ${inst.length ? inst.map((i) => `(${Number(i.amount)}::numeric, ${lit(`תשלום ${i.n} ${i.paid ? '(שולם)' : '(טרם שולם)'} ${INST_TAG}`)})`).join(', ') : '(null::numeric, null::text)'}) as x(amount, n)
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
