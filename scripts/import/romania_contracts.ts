// Romania's purchase contracts from Airtable into the property cards (SPEC decision 82).
//
//   node scripts/import/romania_contracts.ts          dry run: counts and size
//   node scripts/import/romania_contracts.ts --run    copy the files (sensitive, like decision 70)
//
// The PROPERTIES table's "Purchase contract" field; the property is found by the name the
// first import stored. Files go through the same queue and function as decision 70.

import { cleanName } from './lib/parse.ts';
import { baseIds, copyFiles, records, requireTokens, sql, type Attachment, type QueueItem } from './lib/remote.ts';

async function main() {
  requireTokens();
  const base = (await baseIds()).get('רומניה');
  if (!base) throw new Error('no Airtable base named רומניה');
  const refs = new Map((await sql<{ external_key: string; entity_id: string }>(
    `select external_key, entity_id from app.external_refs where source = 'airtable_ro' and entity_type = 'property'`)).map((r) => [cleanName(r.external_key), r.entity_id]));
  const files: QueueItem[] = [];
  let unmatched = 0, mb = 0;
  for (const r of await records(base, 'PROPERTIES')) {
    const atts = (r.fields['Purchase contract'] as Attachment[] | undefined) ?? [];
    if (!atts.length) continue;
    const id = refs.get(cleanName(String(r.fields.ID ?? '')));
    if (!id) { unmatched += 1; continue; }
    for (const a of atts) {
      files.push({ url: a.url, att_id: `${a.id}_p`, file_name: a.filename, content_type: a.type, country: 'RO', entity_type: 'property', entity_id: id, doc_type: 'purchase_contract' });
      mb += (a.size ?? 0) / 1e6;
    }
  }
  const seen = new Set<string>();
  const unique = files.filter((f) => !seen.has(f.att_id) && !!seen.add(f.att_id));
  console.log({ files: unique.length, properties: new Set(unique.map((f) => f.entity_id)).size, unmatched, mb: Math.round(mb) });
  if (process.argv.includes('--run')) await copyFiles(unique);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
