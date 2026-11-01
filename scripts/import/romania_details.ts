// Romania's property details and bills history from Airtable, by the office's choices
// (SPEC decision 71).
//
//   node scripts/import/romania_details.ts <choices.json>         dry run: counts only
//   node scripts/import/romania_details.ts <choices.json> --run   write
//
// <choices.json> comes from the selection page (romania-import-choices.html): for every
// property and field, true = import, false or null = leave alone. It holds clients'
// personal data: keep it outside the repo. Fields already in the system (owners,
// building, address, purchase date, leases, tenant) are never touched here.
//
// What a chosen field becomes:
//   SQM                                   properties.sqm
//   Sector, LAND 1% YOM TOV, Previous apt tenants   a block in the property notes
//   Purchase price, total price           a deal (decision 70); total price in USD when it
//                                         is a plain number, otherwise kept as text
//   electricity / gas / internet / building committee fields   app.utility_contracts
//   Bills                                 app.charges, all marked paid, as history. Bills
//                                         dated on or after the first posting from Itai's
//                                         file for that property are skipped (his file
//                                         covers that period), and so are undated ones.
// Re-running updates the same rows (source columns, migration 23).

import { readFileSync } from 'node:fs';
import { cleanName } from './lib/parse.ts';
import { baseIds, lit, records, requireTokens, sql, type AirRecord } from './lib/remote.ts';

interface Choices { properties: Record<string, { title: string; import: Record<string, boolean | null> }> }

const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)).trim();
const firstNumber = (v: unknown) => { const m = str(v).replace(/,/g, '').match(/\d+(\.\d+)?/); return m ? Number(m[0]) : null; };
// "85,000" or "120000": a price we can trust as a number. Anything with words stays text.
const plainNumber = (v: unknown) => (/^\s*\d{1,3}(,\d{3})*(\.\d+)?\s*$|^\s*\d+(\.\d+)?\s*$/.test(str(v)) ? Number(str(v).replace(/,/g, '')) : null);

const KIND: Record<string, string> = {
  electric: 'electricity', water: 'water', gas: 'gas', 'common building': 'building_assoc', internet: 'internet', rent: 'rent',
};
const NOTES_MARK = '— מ-Airtable (רומניה) —';

// A bill's amount, from the first field that has one: the euro amount, the lei amount,
// the amount typed as text ("123,45 lei" is lei with a decimal comma; a bare number is
// euro, as the field's name says), the lei actually paid, and for rent the lease's
// monthly price. Most rows are monthly placeholders with no amount at all: skipped.
export function billAmount(g: Record<string, unknown>): [number, string] | [null, null] {
  const n = (v: unknown) => (typeof v === 'number' && v !== 0 ? v : null);
  if (n(g['Amount Euro'])) return [n(g['Amount Euro'])!, 'EUR'];
  if (n(g['Amount ron'])) return [n(g['Amount ron'])!, 'RON'];
  const text = str(g['monthly anount- EURO']);
  const lei = text.match(/^(\d[\d.]*)(,(\d{1,2}))?\s*lei$/i);
  if (lei) return [Number(`${lei[1].replace(/\./g, '')}.${lei[3] ?? '0'}`), 'RON'];
  if (/^\d+(\.\d+)?$/.test(text)) return [Number(text), 'EUR'];
  if (n(g['what amount paid ron'])) return [n(g['what amount paid ron'])!, 'RON'];
  const lease = g['Monthly Price - Euro (from Lease Agreement)'];
  if (str(g.Type) === 'rent' && Array.isArray(lease) && typeof lease[0] === 'number' && lease[0]) return [lease[0], 'EUR'];
  return [null, null];
}

async function main() {
  requireTokens();
  const path = process.argv[2];
  if (!path || path.startsWith('--')) throw new Error('usage: romania_details.ts <choices.json> [--run]');
  const choices = JSON.parse(readFileSync(path, 'utf8')) as Choices;
  const run = process.argv.includes('--run');
  const yes = (rec: string, field: string) => choices.properties[rec]?.import[field] === true;

  const base = (await baseIds()).get('רומניה');
  if (!base) throw new Error('no Airtable base named רומניה');
  const [props, bills, persons] = await Promise.all([records(base, 'PROPERTIES'), records(base, 'BILLS'), records(base, 'Persons')]);
  const personName = new Map(persons.map((p) => [p.id, str(p.fields.Name)]));
  const refs = new Map((await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable_ro' and entity_type = 'property'`)).map((r) => [cleanName(r.external_key), r.entity_id]));
  const current = new Map((await sql<{ id: string; notes: string | null; owner: string | null }>(`select p.id, p.notes,
      (select o.party_id from app.ownerships o where o.property_id = p.id and o.valid_to is null order by o.share_pct desc, o.party_id limit 1)::text as owner
    from app.properties p where p.country_code = 'RO'`)).map((p) => [p.id, p]));
  // Where Itai's file starts, per property: bills from then on are already in the ledger.
  const itaiStart = new Map((await sql<{ property_id: string; first: string }>(`select e.property_id, min(t.occurred_on)::text as first
    from app.entries e join app.transactions t on t.id = e.transaction_id join app.import_batches b on b.id = t.import_batch_id
    join app.import_sources s on s.id = b.source_id where s.adapter = 'itai_client_xlsx' and t.status = 'posted' group by 1`)).map((r) => [r.property_id, r.first]));

  const statements: string[] = [];
  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const billsOf = new Map<string, AirRecord[]>();
  for (const b of bills) for (const p of (b.fields.Properties as string[] | undefined) ?? []) billsOf.set(p, [...(billsOf.get(p) ?? []), b]);

  for (const r of props) {
    const f = r.fields;
    const id = refs.get(cleanName(str(f.ID)));
    const p = id ? current.get(id) : undefined;
    if (!p || !choices.properties[r.id]) { if (choices.properties[r.id] && Object.values(choices.properties[r.id].import).some((v) => v === true)) count('chosen but not in the system'); continue; }

    // Size.
    const sqm = firstNumber(f.SQM);
    if (yes(r.id, 'SQM') && sqm && sqm < 1000) { statements.push(`update app.properties set sqm = ${sqm} where id = ${lit(p.id)};`); count('size'); }

    // A notes block, replaced on every run, under the existing notes.
    const lines = [
      yes(r.id, 'Sector') && str(f.Sector) ? `סקטור: ${str(f.Sector)}` : '',
      yes(r.id, 'LAND 1% YOM TOV') && f['LAND 1% YOM TOV'] ? 'רשום 1% אדמה ל-Yom Tov' : '',
      yes(r.id, 'Previous apt tenants') && f['Previous apt tenants']
        ? `שוכרים קודמים: ${((f['Previous apt tenants'] as string[]) ?? []).map((x) => personName.get(x) ?? '').filter(Boolean).join(', ')}` : '',
    ].filter(Boolean);
    if (lines.length) {
      const kept = (p.notes ?? '').split(NOTES_MARK)[0].trimEnd();
      statements.push(`update app.properties set notes = ${lit([kept, NOTES_MARK, ...lines].filter(Boolean).join('\n'))} where id = ${lit(p.id)};`);
      count('notes');
    }

    // The purchase.
    const total = yes(r.id, 'total price') ? str(f['total price']) : '';
    const purchase = yes(r.id, 'Purchase price') ? str(f['Purchase price']) : '';
    const price = plainNumber(total) ?? plainNumber(purchase);
    const dealNotes = [total && plainNumber(total) === null ? `מחיר כולל: ${total}` : '', purchase && plainNumber(purchase) === null ? `מחיר רכישה: ${purchase}` : ''].filter(Boolean).join('\n');
    if ((price || dealNotes) && p.owner) {
      const date = str(f['Purchase Date']) || null;
      statements.push(`insert into app.deals (property_id, client_party_id, country_code, signed_on, status, total_price, price_currency, notes, source)
        values (${lit(p.id)}, ${lit(p.owner)}, 'RO', ${lit(date)}, ${lit(date ? 'completed' : 'in_progress')}, ${price ?? 'null'}, ${price ? "'USD'" : 'null'}, ${lit(dealNotes)}, ${lit(`airtable:${r.id}`)})
        on conflict (source) where source is not null do update set signed_on = excluded.signed_on, status = excluded.status,
          total_price = excluded.total_price, price_currency = excluded.price_currency, notes = excluded.notes;`);
      count(price ? 'deals with a price' : 'deals with the price as text');
    }

    // Services: one row per kind, with only the chosen fields.
    const pick = (field: string) => (yes(r.id, field) ? str(f[field]) : '');
    const services: { kind: string; provider?: string; code?: string; status?: string; notes: string[] }[] = [
      { kind: 'electricity', code: pick('ELECTRICITY client code'), status: pick('Electric status'), notes: [pick('ELECTRICITY status') && `מצב החוזה: ${pick('ELECTRICITY status')}`] },
      { kind: 'gas', code: pick('GAS client code'), status: pick('Gas status'), notes: [pick('GAS contract status') && `מצב החוזה: ${pick('GAS contract status')}`, pick('Gas Description')] },
      { kind: 'internet', code: [pick('internet client code'), pick('Internet client cod')].filter(Boolean).join(' / '), status: pick('Internet status'),
        notes: [pick('INTERNET contract status') && `מצב החוזה: ${pick('INTERNET contract status')}`] },
      { kind: 'building_assoc', provider: pick('Building manager'), status: pick('Common building status'),
        notes: [pick('Common building payment method') && `דרך תשלום: ${pick('Common building payment method')}`, pick('Common Building Description')] },
    ];
    for (const s of services) {
      const notes = s.notes.filter(Boolean).join('\n');
      if (!s.code && !s.status && !s.provider && !notes) continue;
      statements.push(`insert into app.utility_contracts (property_id, kind, provider, client_code, status, notes, source)
        values (${lit(p.id)}, ${lit(s.kind)}, ${lit(s.provider)}, ${lit(s.code)}, ${lit(s.status)}, ${lit(notes)}, ${lit(`airtable:${r.id}:${s.kind}`)})
        on conflict (source) where source is not null do update set provider = excluded.provider, client_code = excluded.client_code,
          status = excluded.status, notes = excluded.notes;`);
      count(`service: ${s.kind}`);
    }

    // Bills history, all paid.
    if (yes(r.id, 'Bills')) {
      const start = itaiStart.get(p.id);
      const values: string[] = [];
      for (const b of billsOf.get(r.id) ?? []) {
        const g = b.fields;
        const date = str(g.Date);
        if (!date) { count('bills skipped: no date'); continue; }
        if (start && date >= start) { count("bills skipped: in Itai's period"); continue; }
        const [amount, currency] = billAmount(g);
        if (amount === null) { count('bills skipped: no amount'); continue; }
        const payer = g['PAID BY'] === 'OWNER' || g['.Paid by'] === 'Owner' || g['.Paid by'] === 'Yom Tov' ? 'owner' : 'tenant';
        const notes = [str(g.Details), str(g['Rent Month']) && `חודש שכירות: ${str(g['Rent Month'])}`, str(g['Received by']) && `התקבל אצל: ${str(g['Received by'])}`,
          !KIND[str(g.Type)] && str(g.Type) ? `סוג: ${str(g.Type)}` : ''].filter(Boolean).join('\n');
        values.push(`(${lit(p.id)}, ${lit(`${date.slice(0, 7)}-01`)}, ${lit(KIND[str(g.Type)] ?? 'other')}, ${Math.round(amount * 100) / 100}, ${lit(currency)}, ${lit(date)}, ${lit(payer)}, 'paid', ${lit(notes)}, ${lit(`airtable:${b.id}`)})`);
      }
      count('bills', values.length);
      for (let i = 0; i < values.length; i += 200) {
        statements.push(`insert into app.charges (property_id, period, kind, amount, currency, due_date, payer, status, notes, source)
          values ${values.slice(i, i + 200).join(',\n')}
          on conflict (source) where source is not null do update set period = excluded.period, kind = excluded.kind, amount = excluded.amount,
            currency = excluded.currency, due_date = excluded.due_date, payer = excluded.payer, notes = excluded.notes;`);
      }
    }
  }

  console.log(tally);
  if (!run) { console.log('dry run: nothing written. Add --run to write.'); return; }
  for (let i = 0; i < statements.length; i += 15) await sql(statements.slice(i, i + 15).join('\n'));
  console.log(`written (${statements.length} statements)`);
}

if (import.meta.main ?? process.argv[1]?.endsWith('romania_details.ts')) main().catch((e) => { console.error(e.message); process.exit(1); });
