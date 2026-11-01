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

const REF = process.env.SUPABASE_PROJECT_REF ?? 'oqvanprfxsdonzldgtnq';
const AIRTABLE = process.env.AIRTABLE_TOKEN;
const SUPABASE = process.env.SUPABASE_ACCESS_TOKEN;
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/airtable-documents`;

// Base, people table and the attachment fields to copy, with their document type.
// Greece is left out until its base is imported (decision 64).
const SOURCES = [
  { base: 'UKRAINE', country: 'UA', table: 'Person', fields: { passport: 'passport', POA: 'poa' } },
  { base: 'רומניה', country: 'RO', table: 'Persons', fields: { 'תעודת זהות וספח': 'id_card', POA: 'poa', Attachments: 'attachment' } },
  { base: 'גאורגיה', country: 'GE', table: 'person', fields: { 'יפויי כוח': 'poa', Attachments: 'attachment' } },
] as const;

interface Attachment { id: string; url: string; filename: string; size?: number; type?: string }
interface Item { url: string; att_id: string; file_name: string; content_type?: string; country: string; party_id: string; doc_type: string }

async function airtable(path: string): Promise<any> {
  const res = await fetch(`https://api.airtable.com/v0/${path}`, { headers: { Authorization: `Bearer ${AIRTABLE}` } });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${SUPABASE}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`SQL ${res.status}: ${body.slice(0, 500)}`);
  return body ? JSON.parse(body) : [];
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

async function records(baseId: string, table: string) {
  const out: { fields: Record<string, unknown> }[] = [];
  let offset = '';
  do {
    const page = await airtable(`${baseId}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ''}`);
    out.push(...page.records);
    offset = page.offset ?? '';
  } while (offset);
  return out;
}

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
        items.push({ url: a.url, att_id: a.id, file_name: a.filename, content_type: a.type, country: s.country, party_id: party, doc_type: type });
      }
    }
  }
  return { items, unmatched, people };
}

// Queues the files, then has the database call the function until the queue is empty.
async function run(items: Item[]) {
  for (let i = 0; i < items.length; i += 50) {
    const values = items.slice(i, i + 50).map((it) =>
      `(${[it.att_id, it.url, it.file_name, it.content_type ?? '', it.country, it.party_id, it.doc_type].map(lit).join(', ')})`).join(',\n');
    await sql(`insert into app.document_imports (att_id, url, file_name, content_type, country_code, party_id, doc_type)
      values ${values}
      on conflict (att_id) do update set url = excluded.url, status = 'pending', result = null, updated_at = now()
      where app.document_imports.status <> 'done'`);
  }
  await sql('create extension if not exists pg_net');
  for (let round = 0; round < 200; round++) {
    const [left] = await sql<{ n: number }>(`select count(*)::int as n from app.document_imports where status in ('pending', 'working')`);
    if (!left.n) break;
    // Four calls at a time; each copies up to four files.
    const ids = (await sql<{ id: number }>(`select net.http_post(url := ${lit(FUNCTION_URL)}, body := '{}'::jsonb,
      headers := '{"Content-Type": "application/json"}'::jsonb, timeout_milliseconds := 140000) as id
      from generate_series(1, 4)`)).map((r) => r.id);
    for (let tries = 0; tries < 60; tries++) {
      await new Promise((r) => setTimeout(r, 3000));
      const [d] = await sql<{ n: number; bad: string | null }>(`select count(*)::int as n,
        string_agg(distinct coalesce(status_code::text, error_msg), ', ') filter (where status_code is distinct from 200) as bad
        from net._http_response where id in (${ids.join(',')})`);
      if (d.n === ids.length) { if (d.bad) console.log(`calls not ok: ${d.bad}`); break; }
    }
    const counts = await sql<{ status: string; n: number }>(`select status, count(*)::int as n from app.document_imports group by 1 order by 1`);
    console.log(Object.fromEntries(counts.map((c) => [c.status, c.n])));
  }
  const failed = await sql<{ result: string; n: number }>(`select result, count(*)::int as n from app.document_imports where status = 'failed' group by 1`);
  if (failed.length) console.log('failed:', failed);
}

async function main() {
  if (!AIRTABLE || !SUPABASE) throw new Error('AIRTABLE_TOKEN and SUPABASE_ACCESS_TOKEN must be set');
  const { items, unmatched, people } = await collect();
  const byType = new Map<string, number>();
  for (const it of items) byType.set(`${it.country} ${it.doc_type}`, (byType.get(`${it.country} ${it.doc_type}`) ?? 0) + 1);
  console.log(`${items.length} files of ${people} people`, Object.fromEntries(byType));
  console.log(`${unmatched} people with files in Airtable were not found in the system`);
  if (process.argv.includes('--run')) await run(items);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
