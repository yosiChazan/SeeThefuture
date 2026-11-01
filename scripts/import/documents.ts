// Copies people's documents from Airtable into the system (SPEC decision 64).
//
//   node scripts/import/documents.ts          dry run: what would be copied, who is not matched
//   node scripts/import/documents.ts --run    copy (needs IMPORT_SECRET, the function's secret)
//
// Needs AIRTABLE_TOKEN (read-only) and SUPABASE_ACCESS_TOKEN; run with NODE_USE_ENV_PROXY=1.
// The sandbox reaches neither Airtable's file links nor *.supabase.co, so the copying
// happens server-side: the database (pg_net) calls the airtable-documents Edge Function
// with the short-lived attachment links read here. Re-running copies only what is missing.
// Prints counts only, never names or files: they are client personal data.

import { cleanName, nameKey } from './lib/parse.ts';

const REF = process.env.SUPABASE_PROJECT_REF ?? 'oqvanprfxsdonzldgtnq';
const AIRTABLE = process.env.AIRTABLE_TOKEN;
const SUPABASE = process.env.SUPABASE_ACCESS_TOKEN;
const SECRET = process.env.IMPORT_SECRET;
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

// Sends the items through pg_net, a few requests at a time, and waits for each answer.
async function run(items: Item[]) {
  if (!SECRET) throw new Error('IMPORT_SECRET is not set');
  await sql('create extension if not exists pg_net');
  const tally = new Map<string, number>();
  const chunks: Item[][] = [];
  for (let i = 0; i < items.length; i += 4) chunks.push(items.slice(i, i + 4));
  for (let i = 0; i < chunks.length; i += 4) {
    const wave = chunks.slice(i, i + 4);
    const ids: number[] = [];
    for (const c of wave) {
      const [row] = await sql<{ id: number }>(`select net.http_post(
        url := ${lit(FUNCTION_URL)},
        body := ${lit(JSON.stringify({ items: c }))}::jsonb,
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-import-secret', ${lit(SECRET)}),
        timeout_milliseconds := 140000) as id`);
      ids.push(row.id);
    }
    for (let tries = 0; ; tries++) {
      await new Promise((r) => setTimeout(r, 3000));
      const done = await sql<{ id: number; status_code: number | null; content: string | null; error_msg: string | null }>(
        `select id, status_code, content, error_msg from net._http_response where id in (${ids.join(',')})`);
      if (done.length === ids.length || tries > 60) {
        for (const d of done) {
          if (d.status_code === 200 && d.content) {
            for (const v of Object.values(JSON.parse(d.content) as Record<string, string>)) {
              const k = v.startsWith('error') || v.startsWith('upload') || v.startsWith('record') || v.startsWith('download') ? `failed (${v.slice(0, 60)})` : v;
              tally.set(k, (tally.get(k) ?? 0) + 1);
            }
          } else tally.set(`request failed (${d.status_code ?? d.error_msg})`, (tally.get(`request failed (${d.status_code ?? d.error_msg})`) ?? 0) + 4);
        }
        if (done.length < ids.length) tally.set('no answer', (tally.get('no answer') ?? 0) + (ids.length - done.length) * 4);
        break;
      }
    }
    console.log(`${Math.min((i + 4) * 4, items.length)}/${items.length}`, Object.fromEntries(tally));
  }
  return tally;
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
