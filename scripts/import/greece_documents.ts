// Greece's documents from its Airtable base (SPEC decision 94), after its data (decision 93).
//
//   node scripts/import/greece_documents.ts          dry run: counts only
//   node scripts/import/greece_documents.ts --run    queue the files, copy them, link the proofs
//
// What goes where:
//   people: Passport                        the person's card, "passport"
//   Property: E9 attachment                 the apartment, "e9" (Greek property tax statement)
//   Property: rent contract                 the apartment, "lease_contract"
//   Property: PICTURES                      the apartment, "photo" (not sensitive)
//   Lease agreement: Attachment             the apartment, "management_contract" (the KEROS agreements)
//   Bills payments: הוכחה                   the apartment, "payment_proof", and the bill's charge
//                                           points to it (charges.document_id)
// Only apartments and people that were imported; nothing from Bank Account (cards,
// passwords) and nothing from Tasks or Action. Files are copied server side, through the
// queue and the airtable-documents function, as for the other countries (decision 64).
// Prints counts only, never names or files.

import { cleanName, nameKey } from './lib/parse.ts';
import { baseIds, copyFiles, records, requireTokens, sql, type Attachment, type QueueItem } from './lib/remote.ts';
import { splitOwner } from './greece.ts';

const str = (v: unknown) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v)).trim();
const ids = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
const atts = (v: unknown) => (Array.isArray(v) ? (v as Attachment[]) : []);

async function main() {
  requireTokens();
  const run = process.argv.includes('--run');
  const base = (await baseIds()).get('Greece');
  if (!base) throw new Error('no Airtable base named Greece');
  const [people, props, leases, bills] = await Promise.all(['אנשים', 'Property', 'Lease agreement', 'Bills payments'].map((t) => records(base, t)));

  const propRefs = new Map((await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable_gr' and entity_type = 'property'`)).map((r) => [r.external_key, r.entity_id]));
  const partyRefs = await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable' and entity_type = 'party'`);
  const partyExact = new Map(partyRefs.map((r) => [r.external_key, r.entity_id]));
  const partyByKey = new Map(partyRefs.map((r) => [nameKey(r.external_key), r.entity_id]));
  const knownNames = people.map((p) => cleanName(str(p.fields.Name))).filter(Boolean);
  const apt = new Map(props.map((p) => [p.id, propRefs.get(cleanName(str(p.fields.ID)))]));

  const files: QueueItem[] = [];
  const links: { charge: string; source: string }[] = [];
  const tally: Record<string, number> = {};
  const count = (k: string, n = 1) => { tally[k] = (tally[k] ?? 0) + n; };
  const add = (a: Attachment, suffix: string, entity_type: 'party' | 'property', entity_id: string, doc_type: string, sensitive = true) => {
    files.push({ url: a.url, att_id: `${a.id}_gr${suffix}`, file_name: a.filename, content_type: a.type, country: 'GR', entity_type, entity_id, doc_type, sensitive });
    count(`files: ${doc_type}`);
    count('MB', Math.round((a.size ?? 0) / 1e4) / 100);
    return `airtable:${a.id}_gr${suffix}`;
  };

  // Passports: on each person the record names (a record naming two co-owners: on both).
  for (const p of people) {
    const files0 = atts(p.fields.Passport);
    if (!files0.length) continue;
    const names = splitOwner(cleanName(str(p.fields.Name)), knownNames);
    const parties = names.map((n) => partyExact.get(n) ?? partyByKey.get(nameKey(n))).filter((x): x is string => !!x);
    if (!parties.length) { count('people not imported (files skipped)', files0.length); continue; }
    for (const party of parties) for (const a of files0) add(a, `p${parties.indexOf(party)}`, 'party', party, 'passport');
  }

  // The apartment's own files.
  for (const p of props) {
    const id = apt.get(p.id);
    const f = p.fields;
    const all = [...atts(f['E9 attachment']), ...atts(f['rent contract']), ...atts(f.PICTURES)];
    if (!id) { if (all.length) count('apartments not imported (files skipped)', all.length); continue; }
    for (const a of atts(f['E9 attachment'])) add(a, 'e9', 'property', id, 'e9');
    for (const a of atts(f['rent contract'])) add(a, 'rc', 'property', id, 'lease_contract');
    for (const a of atts(f.PICTURES)) add(a, 'ph', 'property', id, 'photo', false);
  }

  // The KEROS agreements, on the apartment they cover.
  for (const l of leases) {
    const id = apt.get(ids(l.fields.Property)[0]);
    const all = atts(l.fields.Attachment);
    if (!id) { if (all.length) count('agreements of apartments not imported (skipped)', all.length); continue; }
    for (const a of all) add(a, 'mc', 'property', id, 'management_contract');
  }

  // Payment proofs: on every apartment the bill was split over; its charge points to the
  // first proof. Bills that were not imported (decision 93) bring no files.
  const imported = new Set((await sql<{ source: string }>(`select source from app.charges where source like 'airtable_gr:%'`)).map((r) => r.source));
  for (const b of bills) {
    const proofs = atts(b.fields['הוכחה']);
    if (!proofs.length) continue;
    const apts = ids(b.fields['דירה']);
    const charged = apts.map((_, i) => `airtable_gr:${b.id}:${i}`).filter((s) => imported.has(s));
    if (!charged.length) { count('proofs of bills not imported (skipped)', proofs.length); continue; }
    charged.forEach((charge) => {
      const i = Number(charge.split(':')[2]);
      const sources = proofs.map((a, k) => add(a, `b${i}`, 'property', apt.get(apts[i])!, 'payment_proof'));
      links.push({ charge, source: sources[0] });
    });
  }

  tally.MB = Math.round(tally.MB ?? 0);
  console.log(tally, `charges to link: ${links.length}`);
  if (!run) { console.log('dry run: nothing written. Add --run to copy the files.'); return; }
  // One Airtable file can back two bills of the same apartment: copy it once.
  const seen = new Set<string>();
  await copyFiles(files.filter((f) => !seen.has(f.att_id) && !!seen.add(f.att_id)));
  for (let i = 0; i < links.length; i += 300) {
    const values = links.slice(i, i + 300).map((l) => `('${l.charge}', '${l.source}')`).join(',\n');
    await sql(`update app.charges c set document_id = d.id from (values ${values}) v(charge, source)
      join app.documents d on d.source = v.source where c.source = v.charge and c.document_id is null`);
  }
  const [linked] = await sql<{ n: number }>(`select count(*)::int as n from app.charges where source like 'airtable_gr:%' and document_id is not null`);
  console.log(`charges with a proof: ${linked.n}`);
}

if (import.meta.main) await main();
