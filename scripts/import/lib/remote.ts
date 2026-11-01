// Talking to Airtable and to the production database from the import scripts, and the
// document copy queue (SPEC decisions 64, 70). Needs AIRTABLE_TOKEN (read-only) and
// SUPABASE_ACCESS_TOKEN; run with NODE_USE_ENV_PROXY=1 in the sandbox.

const REF = process.env.SUPABASE_PROJECT_REF ?? 'oqvanprfxsdonzldgtnq';
const FUNCTION_URL = `https://${REF}.supabase.co/functions/v1/airtable-documents`;

export interface Attachment { id: string; url: string; filename: string; size?: number; type?: string }
export interface AirRecord { id: string; fields: Record<string, unknown> }

export function requireTokens() {
  if (!process.env.AIRTABLE_TOKEN || !process.env.SUPABASE_ACCESS_TOKEN) throw new Error('AIRTABLE_TOKEN and SUPABASE_ACCESS_TOKEN must be set');
}

export async function airtable(path: string): Promise<any> {
  const res = await fetch(`https://api.airtable.com/v0/${path}`, { headers: { Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}` } });
  if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

export async function baseIds(): Promise<Map<string, string>> {
  return new Map((await airtable('meta/bases')).bases.map((b: { name: string; id: string }) => [b.name, b.id]));
}

export async function records(baseId: string, table: string): Promise<AirRecord[]> {
  const out: AirRecord[] = [];
  let offset = '';
  do {
    const page = await airtable(`${baseId}/${encodeURIComponent(table)}?pageSize=100${offset ? `&offset=${offset}` : ''}`);
    out.push(...page.records);
    offset = page.offset ?? '';
  } while (offset);
  return out;
}

export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
    });
    const body = await res.text();
    // The Management API answers 502 now and then; the query did not run, so try again.
    if (res.status === 502 && attempt < 4) { await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(`SQL ${res.status}: ${body.slice(0, 500)}`);
    return body ? JSON.parse(body) : [];
  }
}

export const lit = (s: string | number | null | undefined) =>
  s === null || s === undefined || s === '' ? 'null' : typeof s === 'number' ? String(s) : `'${s.replace(/'/g, "''")}'`;

// One file to copy: a person's (entity "party") or a property's document.
export interface QueueItem {
  url: string; att_id: string; file_name: string; content_type?: string; country: string;
  entity_type: 'party' | 'property'; entity_id: string; doc_type: string; sensitive?: boolean;
}

// Queues the files, then has the database call the function until the queue is empty.
export async function copyFiles(items: QueueItem[]) {
  for (let i = 0; i < items.length; i += 50) {
    const values = items.slice(i, i + 50).map((it) => `(${[
      lit(it.att_id), lit(it.url), lit(it.file_name), lit(it.content_type), lit(it.country), lit(it.entity_type), lit(it.entity_id),
      it.entity_type === 'party' ? lit(it.entity_id) : 'null', lit(it.doc_type), String(it.sensitive ?? true),
    ].join(', ')})`).join(',\n');
    await sql(`insert into app.document_imports (att_id, url, file_name, content_type, country_code, entity_type, entity_id, party_id, doc_type, sensitive)
      values ${values}
      on conflict (att_id) do update set url = excluded.url, status = 'pending', result = null, updated_at = now()
      where app.document_imports.status <> 'done'`);
  }
  await sql('create extension if not exists pg_net');
  for (let round = 0; round < 300; round++) {
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
