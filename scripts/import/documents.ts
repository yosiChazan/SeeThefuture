// Copies people's documents from Airtable into the system (SPEC decision 64).
//
//   node scripts/import/documents.ts          dry run: what would be copied, who is not matched
//   node scripts/import/documents.ts --run    queue the files and copy them
//
// Needs AIRTABLE_TOKEN (read-only) and SUPABASE_ACCESS_TOKEN; run with NODE_USE_ENV_PROXY=1.
// The sandbox reaches neither Airtable's file links nor *.supabase.co, so the copying
// happens server-side: the short-lived attachment links read here go into the queue
// app.document_imports, and the database (pg_net) calls the airtable-documents Edge
// Function, which copies them. Re-running copies only what is missing.
// Prints counts only, never names or files: they are client personal data.

import { cleanName, nameKey } from './lib/parse.ts';
import { airtable, copyFiles, records, requireTokens, sql, type Attachment } from './lib/remote.ts';


// Base, people table and the attachment fields to copy, with their document type.
// Greece is left out until its base is imported (decision 64).
const SOURCES = [
  { base: 'UKRAINE', country: 'UA', table: 'Person', fields: { passport: 'passport', POA: 'poa' } },
  { base: 'רומניה', country: 'RO', table: 'Persons', fields: { 'תעודת זהות וספח': 'id_card', POA: 'poa', Attachments: 'attachment' } },
  { base: 'גאורגיה', country: 'GE', table: 'person', fields: { 'יפויי כוח': 'poa', Attachments: 'attachment' } },
] as const;

export const PASSPORT_NAME = /(passport|pasport|pasaport|паспорт|דרכון)/i;

interface Item { url: string; att_id: string; file_name: string; content_type?: string; country: string; party_id: string; doc_type: string }

async function collect(): Promise<{ items: Item[]; unmatched: number; people: number }> {
  const bases = new Map<string, string>((await airtable('meta/bases')).bases.map((b: { name: string; id: string }) => [b.name, b.id]));
  // Every name a person appeared under in Airtable, as the first import stored it.
  const refs = await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable' and entity_type = 'party'`);
  const exact = new Map(refs.map((r) => [r.external_key, r.entity_id]));
  const byKey = new Map(refs.map((r) => [nameKey(r.external_key), r.entity_id]));

  const items: Item[] = [];
  let unmatched = 0; let people = 0;
  for (const s of SOURCES) {
    const id = bases.get(s.base);
    if (!id) throw new Error(`no Airtable base named ${s.base}`);
    for (const r of await records(id, s.table)) {
      const files = Object.entries(s.fields).flatMap(([field, type]) =>
        ((r.fields[field] as Attachment[] | undefined) ?? []).map((a) => ({ a, type })));
      if (!files.length) continue;
      const name = cleanName(String(r.fields.Name ?? ''));
      const party = exact.get(name) ?? byKey.get(nameKey(name));
      if (!party) { unmatched += 1; continue; }
      people += 1;
      for (const { a, type } of files) {
        // An attachment named as a passport is filed with the passports (decision 64).
        const docType = type === 'attachment' && PASSPORT_NAME.test(a.filename) ? 'passport' : type;
        items.push({ url: a.url, att_id: a.id, file_name: a.filename, content_type: a.type, country: s.country, party_id: party, doc_type: docType });
      }
    }
  }
  // One Airtable file can sit in two fields or under two people; it is copied once per
  // person, under the person's own path, so the queue key adds the person.
  const seen = new Set<string>();
  const unique = items.filter((it) => { const k = `${it.att_id}|${it.party_id}`; if (seen.has(k)) return false; seen.add(k); return true; });
  // The queue is keyed by attachment id: the second person's copy gets its own key.
  const first = new Map<string, string>();
  for (const it of unique) {
    if (!first.has(it.att_id)) first.set(it.att_id, it.party_id);
    else if (first.get(it.att_id) !== it.party_id) it.att_id = `${it.att_id}_${it.party_id.slice(0, 8)}`;
  }
  return { items: unique, unmatched, people };
}

const run = (items: Item[]) => copyFiles(items.map(({ party_id, country, ...it }) => ({ ...it, country, entity_type: 'party' as const, entity_id: party_id })));

async function main() {
  requireTokens();
  const { items, unmatched, people } = await collect();
  const byType = new Map<string, number>();
  for (const it of items) byType.set(`${it.country} ${it.doc_type}`, (byType.get(`${it.country} ${it.doc_type}`) ?? 0) + 1);
  console.log(`${items.length} files of ${people} people`, Object.fromEntries(byType));
  console.log(`${unmatched} people with files in Airtable were not found in the system`);
  const shared = items.filter((it) => it.att_id.includes('_')).length;
  if (shared) console.log(`${shared} files also belong to another person: copied for each`);
  if (process.argv.includes('--run')) await run(items);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
