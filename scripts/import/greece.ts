// Greece from its Airtable base (SPEC decision 93): buildings, apartments, owners and the
// bills history 2019–2023. Insert-only and idempotent: rows get stable ids and existing
// rows are never overwritten, so a re-run adds only what is missing.
//
//   node scripts/import/greece.ts <out-dir>          dry run: writes <out-dir>/choices.json
//                                                    (first run only) and review.html
//   node scripts/import/greece.ts <out-dir> --run    writes to the database
//
// <out-dir> holds clients' personal data: keep it outside the repo. choices.json says
// which Airtable person is which existing party ("match": party id, or null for a new
// party); the first run proposes matches by name, a person checks them.
//
// Decided (decision 93): apartments marked NOT ACTIVE are not imported, nor their bills;
// the KEROS agreement (40% of income, 2023–2025) is not imported; bank accounts, user
// names and passwords are never read. Bills become app.charges as history, like Romania
// (decision 71). KEROS reports from 2023 on come later through intake.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stableId } from './load.ts';
import { cleanName, nameKey, similarity } from './lib/parse.ts';
import { baseIds, lit, records, requireTokens, sql, type AirRecord } from './lib/remote.ts';

const C = 'GR';
const CITY = 'Athens';
const MISSING = 'ללא מספר';
const NOTES_MARK = '— מ-Airtable (יוון) —';

const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)).trim();
const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const title = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, a: string, b: string) => a + b.toUpperCase());

// Where an apartment is, from its Airtable "Address" and building.
//   BODA:      "BODA 1A" → 1A (floor 1), "BODA gf1" → GF1 (floor 0), "BODA BASEMENTS" → floor -1
//   AKADIMOS:  "2TH FLOOR FRONT" → "2 FRONT" (floor 2), "BASMENT" → "B" (floor -1), "GROUND FLOOR" → "G"
//   no building: the street is the building; a trailing number joins the street ("Feron 13"),
//              a trailing letter is the apartment ("SONERIOU A" → building Soneriou, apartment A)
export function greekUnit(address: string, building: string | null): { building: string; unit: string; floor?: string } {
  const a = cleanName(address);
  if (building && /^boda$/i.test(building)) {
    const u = a.replace(/^boda\s*/i, '').toUpperCase();
    const floor = /^GF/.test(u) ? '0' : /^BASE/.test(u) ? '-1' : u.match(/^(\d+)/)?.[1];
    return { building: 'Boda', unit: u || MISSING, floor };
  }
  if (building) {
    const m = a.toUpperCase().match(/^(BASE?MENT|GROUND FLOOR|(\d+)\s*(?:ST|ND|RD|TH)\s+FLOOR)\s*(FRONT)?$/);
    if (!m) return { building: title(building), unit: a || MISSING };
    const [label, floor] = m[2] ? [m[2], m[2]] : /^BASE?MENT/.test(m[1]) ? ['B', '-1'] : ['G', '0'];
    return { building: title(building), unit: m[3] ? `${label} FRONT` : label, floor };
  }
  const m = a.match(/^(.*?)\s+(\d+[A-Za-z]?|[A-Za-z])$/);
  if (m && /^\d/.test(m[2])) return { building: title(`${m[1]} ${m[2]}`), unit: MISSING };
  if (m) return { building: title(m[1]), unit: m[2].toUpperCase() };
  return { building: title(a), unit: MISSING };
}

const KIND: Record<string, string> = { 'אינטרנט': 'internet', 'חשמל': 'electricity', 'מים': 'water', 'וועד בית': 'building_assoc', 'הכנסה': 'rent', 'השכרה': 'rent' };

// Names to match against existing parties, one spelling at a time: two shared words make a
// proposal (a word matches a close misspelling, "Shteinbreg"), and a spelling with exactly
// the same words beats one that only contains them ("Dana Levi" over "Moshe Katz & Dana
// Levi"). An e-mail alone does not: families share one.
const words = (s: string) => [...new Set(nameKey(s).split(' ').filter((w) => w.length > 1))];
const near = (a: string, b: string) => a === b || (a.length > 4 && b.length > 4 && similarity(a, b) >= 0.8);
export function proposeMatch(name: string, parties: { id: string; display_name: string; spellings: string[] }[]): string | null {
  const mine = words(name);
  let best: { id: string; score: number } | null = null;
  let tie = false;
  for (const p of parties) {
    let score = 0;
    for (const spelling of [p.display_name, ...p.spellings]) {
      const theirs = words(spelling);
      const shared = mine.filter((w) => theirs.some((t) => near(w, t))).length;
      if (shared >= 2) score = Math.max(score, shared * 10 + (shared === mine.length && shared === theirs.length ? 5 : 0));
    }
    if (!score || best?.id === p.id) continue;
    if (!best || score > best.score) { best = { id: p.id, score }; tie = false; } else if (score === best.score) tie = true;
  }
  return best && !tie ? best.id : null;
}

// One Airtable person that is really two co-owners, "A B +C D": two owners. A part that is
// another Airtable person under a misspelling ("BIYAMIN" for "BINYAMIN") becomes that person.
export function splitOwner(name: string, known: string[]): string[] {
  if (!name.includes('+')) return [name];
  return name.split('+').map(cleanName).filter(Boolean).map((part) => {
    const mine = words(part);
    return known.find((k) => {
      const theirs = words(k);
      return k !== name && theirs.length === mine.length && mine.every((w) => theirs.some((t) => near(w, t)));
    }) ?? part;
  });
}

interface Choices { matches: Record<string, string | null> }

async function main() {
  const out = process.argv[2];
  if (!out || out.startsWith('--')) throw new Error('usage: greece.ts <out-dir> [--run]');
  const run = process.argv.includes('--run');
  requireTokens();
  mkdirSync(out, { recursive: true });

  const base = (await baseIds()).get('Greece');
  if (!base) throw new Error('no Airtable base named Greece');
  const [props, people, buildings, leases, bills] = await Promise.all(
    ['Property', 'אנשים', 'Building', 'Lease agreement', 'Bills payments'].map((t) => records(base, t)));
  const person = new Map(people.map((p) => [p.id, p]));
  const buildingName = new Map(buildings.map((b) => [b.id, str(b.fields.Name)]));
  const existing = await sql<{ id: string; display_name: string; spellings: string[] }>(`select p.id, p.display_name,
      coalesce((select array_agg(r.external_key) from app.external_refs r where r.entity_type = 'party' and r.entity_id = p.id), '{}') as spellings
    from app.parties p`);
  const partyName = new Map(existing.map((p) => [p.id, p.display_name]));
  const knownNames = people.map((p) => cleanName(str(p.fields.Name))).filter(Boolean);

  // Apartments ------------------------------------------------------------------------
  const skipped: string[] = [];
  const apartments: { rec: AirRecord; id: string; building: string; unit: string; floor?: string; owners: string[] }[] = [];
  const used = new Set<string>();
  for (const r of props) {
    const f = r.fields;
    const name = cleanName(str(f.ID));
    if (!name || !ids(f.Owners).length || /\bgeneral\b/i.test(name)) { if (name) skipped.push(`${name}: רשומה כללית של הבניין, לא דירה; לא יובאה`); continue; }
    if (f['NOT ACTIVE']) { skipped.push(`${name}: מסומנת NOT ACTIVE, לא יובאה (החלטה)`); continue; }
    const owners = [...new Set(ids(f.Owners).flatMap((id) => splitOwner(cleanName(str(person.get(id)?.fields.Name)), knownNames)))].filter(Boolean);
    const { building, unit: parsed, floor } = greekUnit(str(f.Address) || name, buildingName.get(ids(f.Building)[0]) ?? null);
    let unit = parsed;
    for (let n = 2; used.has(`${building}|${unit}`); n++) unit = `${parsed} ${n}`;
    used.add(`${building}|${unit}`);
    apartments.push({ rec: r, id: stableId('property', `${C}|${building}|${unit}`), building, unit, floor, owners });
  }

  // Who is who ------------------------------------------------------------------------
  const choicesPath = join(out, 'choices.json');
  const roleOf = new Map<string, string>();
  for (const a of apartments) for (const o of a.owners) roleOf.set(o, 'client');
  for (const p of people) {
    const n = cleanName(str(p.fields.Name));
    if (!ids(p.fields.TYPE).length && !str(p.fields.TYPE)) continue;
    if (str(p.fields.TYPE).includes('SUPPLIER') && n !== 'STF') roleOf.set(n, /keros/i.test(n) ? 'contact' : /^ira$/i.test(n) ? 'manager' : 'supplier');
  }
  if (!existsSync(choicesPath)) {
    const matches = Object.fromEntries([...roleOf.keys()].sort().map((n) => [n, proposeMatch(n, existing)]));
    writeFileSync(choicesPath, JSON.stringify({ matches }, null, 2));
    console.log(`wrote ${choicesPath}: check the matches, then run again`);
  }
  const choices = JSON.parse(readFileSync(choicesPath, 'utf8')) as Choices;
  const personByName = new Map(people.map((p) => [cleanName(str(p.fields.Name)), p]));
  const partyId = (n: string) => choices.matches[n] ?? stableId('party', `${C}|${nameKey(n)}`);
  for (const n of roleOf.keys()) if (!(n in choices.matches)) throw new Error(`choices.json has no entry for ${n}`);

  // SQL ---------------------------------------------------------------------------------
  const st: string[] = [];
  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const cityId = stableId('city', `${C}|${CITY}`);
  st.push(`insert into app.cities (id, country_code, name_he, name_en) values (${lit(cityId)}, 'GR', 'אתונה', 'Athens') on conflict do nothing;`);
  for (const b of new Set(apartments.map((a) => a.building))) {
    st.push(`insert into app.buildings (id, city_id, name) values (${lit(stableId('building', `${C}|${b}`))}, ${lit(cityId)}, ${lit(b)}) on conflict do nothing;`);
    count('buildings');
  }
  for (const [n, role] of roleOf) {
    const id = partyId(n);
    const f = personByName.get(n)?.fields ?? {};
    if (!choices.matches[n]) {
      st.push(`insert into app.parties (id, kind, display_name, email, phone, address) values (${lit(id)}, ${lit(role === 'client' ? 'person' : 'company')}, ${lit(title(n))},
        ${lit(str(f.email).toLowerCase().split(/[\s,;]+/)[0])}, ${lit(str(f['Phone number']).split('\n')[0])}, ${lit(str(f['Address Israel']))}) on conflict do nothing;`);
      count('new parties');
    } else count('matched parties');
    st.push(`insert into app.party_roles (party_id, role) values (${lit(id)}, ${lit(role)}) on conflict do nothing;`);
    st.push(`insert into app.external_refs (id, entity_type, entity_id, source, external_key) values (${lit(stableId('ref', `airtable|party|${n}`))}, 'party', ${lit(id)}, 'airtable', ${lit(n)}) on conflict do nothing;`);
  }
  const review: string[][] = [];
  for (const a of apartments) {
    const f = a.rec.fields;
    const sold = /^sale?d/i.test(str(f['Status ']));
    const sqm = typeof f['APARTMENT SQM'] === 'string' && /^\d+(\.\d+)?$/.test(f['APARTMENT SQM']) ? Number(f['APARTMENT SQM'])
      : /^\d+(\.\d+)?$/.test(str(f['גודל דירה'])) ? Number(str(f['גודל דירה'])) : null;
    const notes = [NOTES_MARK,
      /for sale/i.test(str(f['Status '])) && 'מסומנת למכירה (for sale)',
      sqm === null && str(f['גודל דירה']) && `גודל: ${str(f['גודל דירה'])}`,
      str(f['BALCONY SQM']) && `מרפסת: ${str(f['BALCONY SQM'])} מ"ר`,
      str(f['Property address']) && `כתובת: ${str(f['Property address'])}`,
      str(f['AIRBNB NAME']) && `שם ב-Airbnb: ${str(f['AIRBNB NAME'])}`,
      str(f['rent amount']) && `שכירות (Airtable): ${str(f['rent amount'])}`,
      str(f.Notes)].filter(Boolean).join('\n');
    st.push(`insert into app.properties (id, building_id, unit_no, floor, sqm, status, notes) values (${lit(a.id)}, ${lit(stableId('building', `${C}|${a.building}`))},
      ${lit(a.unit)}, ${lit(a.floor)}, ${sqm ?? 'null'}, ${lit(sold ? 'sold' : 'short_term')}, ${lit(notes)}) on conflict do nothing;`);
    st.push(`insert into app.external_refs (id, entity_type, entity_id, source, external_key) values (${lit(stableId('ref', `airtable_gr|property|${a.rec.id}`))}, 'property', ${lit(a.id)}, 'airtable_gr', ${lit(cleanName(str(f.ID)))}) on conflict do nothing;`);
    count('apartments');
    const from = str(f['Purchase Date']) || '2000-01-01';
    const share = Math.round((100 / a.owners.length) * 10000) / 10000;
    for (const o of a.owners) {
      st.push(`insert into app.ownerships (id, property_id, party_id, share_pct, valid_from, notes) values (${lit(stableId('ownership', `${a.id}|${partyId(o)}`))}, ${lit(a.id)}, ${lit(partyId(o))},
        ${share}, ${lit(from)}, ${lit([a.owners.length > 1 ? 'Share assumed equal (Airtable has no split).' : '', str(f['Purchase Date']) ? '' : 'Start date unknown.'].filter(Boolean).join(' '))}) on conflict do nothing;`);
      count('ownerships');
    }
    const price = Number(str(f['Purchase price']).replace(/,/g, ''));
    if (price) {
      st.push(`insert into app.deals (property_id, client_party_id, country_code, signed_on, status, total_price, price_currency, source)
        values (${lit(a.id)}, ${lit(partyId(a.owners[0]))}, 'GR', ${lit(str(f['Purchase Date']))}, 'completed', ${price}, 'EUR', ${lit(`airtable_gr:${a.rec.id}`)}) on conflict do nothing;`);
      count('deals');
    }
    review.push([cleanName(str(f.ID)), a.building, a.unit, a.floor ?? '', sold ? 'נמכרה' : 'השכרה קצרה', a.owners.map((o) => choices.matches[o] ? `${o} → ${partyName.get(choices.matches[o]!)}` : `${o} (חדש)`).join('<br>'), sqm ? String(sqm) : '', price ? `${price} EUR` : '']);
  }

  // The one ordinary lease (not the KEROS agreement): a tenant, a rent, dates.
  const aptByRec = new Map(apartments.map((a) => [a.rec.id, a]));
  for (const l of leases) {
    const f = l.fields;
    const apt = aptByRec.get(ids(f.Property)[0]);
    if (!apt || ids(f['rent to']).length || !f['Start date']) continue;
    const rent = Number(str(f['Monthly rebt']).match(/\d+(\.\d+)?/)?.[0] ?? '');
    st.push(`insert into app.leases (id, property_id, start_date, end_date, rent_amount, rent_currency, notes) values (${lit(stableId('lease', `${apt.id}|${str(f['Start date'])}|`))}, ${lit(apt.id)},
      ${lit(str(f['Start date']))}, ${lit(str(f['End date ']))}, ${rent || 'null'}, ${rent ? "'EUR'" : 'null'}, ${lit(`Airtable: ${str(f['Monthly rebt'])}`)}) on conflict do nothing;`);
    count('leases');
  }

  // Bills: history, one charge per apartment; a bill on several apartments is split equally.
  const billsOut: Record<string, number> = {};
  const values: string[] = [];
  for (const b of bills) {
    const f = b.fields;
    const amount = typeof f['סכום'] === 'number' ? f['סכום'] : null;
    const date = str(f['תאריך']);
    const apts = ids(f['דירה']);
    const missing = apts.filter((id) => !aptByRec.has(id));
    const onInactive = missing.some((id) => props.find((p) => p.id === id)?.fields['NOT ACTIVE']);
    const why = !amount ? 'בלי סכום' : !date ? 'בלי תאריך' : !apts.length ? 'בלי דירה'
      : onInactive ? 'על דירה שלא יובאה (NOT ACTIVE)' : missing.length ? 'על רשומה כללית של בניין' : null;
    if (why) { billsOut[why] = (billsOut[why] ?? 0) + 1; continue; }
    const type = str(f['סוג']);
    const kind = KIND[type] ?? 'other';
    const income = kind === 'rent' || str(f['הכנסה/ הוצאה']) === 'הכנסה';
    const notes = [kind === 'other' && type, str(f['הערה']).replace(/\*\*/g, ''), str(f['שולם מחשבון']) && `שולם מ: ${str(f['שולם מחשבון'])}`,
      str(f['הכנסה/ הוצאה']), f['האם החוב נסגר'] ? 'החוב נסגר' : '', apts.length > 1 ? `חולק שווה בשווה בין ${apts.length} דירות (סך ${amount})` : ''].filter(Boolean).join('\n');
    apts.forEach((id, i) => {
      const apt = aptByRec.get(id)!;
      values.push(`(${lit(apt.id)}, ${lit(`${date.slice(0, 7)}-01`)}, ${lit(kind)}, ${Math.round((amount! / apts.length) * 100) / 100}, 'EUR', ${lit(date)},
        ${lit(income ? 'tenant' : 'owner')}, ${lit(/טרם/.test(str(f['סטטוס'])) ? 'due' : 'paid')}, ${lit(notes)}, ${lit(`airtable_gr:${b.id}:${i}`)})`);
    });
    count('bills');
  }
  for (let i = 0; i < values.length; i += 200) {
    st.push(`insert into app.charges (property_id, period, kind, amount, currency, due_date, payer, status, notes, source) values ${values.slice(i, i + 200).join(',\n')}
      on conflict (source) where source is not null do nothing;`);
  }
  count('charges', values.length);

  // The same statements as one file, to try on a local database first (scripts/test-db.sh).
  writeFileSync(join(out, 'greece.sql'), ['begin;', ...st, 'commit;'].join('\n'));
  writeFileSync(join(out, 'review.html'), page(review, choices, partyName, skipped, billsOut, tally));
  console.log(tally, billsOut);
  if (!run) { console.log(`dry run: nothing written. Review ${join(out, 'review.html')}, then add --run.`); return; }
  for (let i = 0; i < st.length; i += 40) await sql(['begin;', ...st.slice(i, i + 40), 'commit;'].join('\n'));
  console.log(`written (${st.length} statements)`);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
function page(rows: string[][], choices: Choices, partyName: Map<string, string>, skipped: string[], billsOut: Record<string, number>, tally: Record<string, number>) {
  const table = (head: string[], body: string[][], raw = false) => `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${body.map((r) => `<tr>${r.map((c) => `<td>${raw ? c : esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  const people = Object.entries(choices.matches).map(([n, id]) => [n, id ? partyName.get(id) ?? `?? ${id}` : 'חדש']);
  return `<!doctype html><meta charset="utf-8"><title>יוון: ייבוא</title><style>body{font-family:system-ui;direction:rtl;margin:24px;max-width:1200px}table{border-collapse:collapse;margin:8px 0 24px}td,th{border:1px solid #ccc;padding:4px 8px;text-align:right;vertical-align:top;font-size:14px}th{background:#f3f3f3}</style>
<h1>יוון: מה ייובא</h1><p>${Object.entries(tally).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>
<h2>אנשים: התאמה ללקוחות קיימים</h2><p>"חדש" = ייווצר לקוח חדש. התאמה שגויה מתקנים ב-choices.json.</p>${table(['ב-Airtable', 'במערכת'], people)}
<h2>דירות</h2>${table(['ב-Airtable', 'בניין', 'דירה', 'קומה', 'סטטוס', 'בעלים', 'מ"ר', 'מחיר רכישה'], rows.map((r) => r.map((c, i) => (i === 5 ? c.split('<br>').map(esc).join('<br>') : esc(c)))), true)}
<h2>לא ייובא</h2><ul>${skipped.map((s) => `<li>${esc(s)}</li>`).join('')}
${Object.entries(billsOut).map(([k, v]) => `<li>תשלומים ${esc(k)}: ${v}</li>`).join('')}
<li>ההסכם עם KEROS (40% מההכנסה, 2023–2025): לא יובא (החלטה)</li>
<li>חשבונות בנק, שמות משתמש, סיסמאות, כרטיסים: לעולם לא נקראים</li>
<li>משימות ו-Action מ-Airtable: לא יובאו</li></ul>`;
}

if (import.meta.main) await main();
