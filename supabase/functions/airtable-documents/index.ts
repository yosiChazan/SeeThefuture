// Copies people's documents from Airtable into the private "documents" bucket and
// records each one in app.documents (SPEC decision 64).
//
// Called by scripts/import/documents.ts (through pg_net, since the sandbox cannot reach
// *.supabase.co) with the attachment URLs it read from the Airtable API. The URLs are
// short-lived signed links: the Airtable token never reaches this function.
// Protected by the IMPORT_SECRET function secret; runs with the service role.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface Item {
  url: string;           // Airtable's signed attachment URL
  att_id: string;        // Airtable attachment id: makes the file path stable
  file_name: string;
  content_type?: string;
  country: string;       // UA, RO, GE
  party_id: string;
  doc_type: string;      // id_card, passport, poa, attachment
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'app' } });
const safe = (s: string) => s.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);

async function copy(it: Item): Promise<string> {
  if (!/^[A-Z]{2}$/.test(it.country) || !/^[0-9a-f-]{36}$/.test(it.party_id) || !/^att\w+$/.test(it.att_id)) return 'bad item';
  const path = `${it.country}/party/${it.party_id}/${it.att_id}_${safe(it.file_name)}`;
  const seen = await db.from('documents').select('id').eq('storage_path', path).maybeSingle();
  if (seen.error) return `error: ${seen.error.message}`;
  if (seen.data) return 'exists';
  const host = new URL(it.url).hostname;
  if (!/(^|\.)airtable(usercontent)?\.com$/.test(host)) return 'bad url';
  const res = await fetch(it.url);
  if (!res.ok) return `download ${res.status}`;
  const body = new Uint8Array(await res.arrayBuffer());
  const up = await db.storage.from('documents').upload(path, body, { contentType: it.content_type || res.headers.get('content-type') || undefined, upsert: true });
  if (up.error) return `upload: ${up.error.message}`;
  const ins = await db.from('documents').insert({
    entity_type: 'party', entity_id: it.party_id, country_code: it.country, doc_type: it.doc_type,
    storage_path: path, sensitive: true, file_name: it.file_name, source: `airtable:${it.att_id}`,
  });
  return ins.error ? `record: ${ins.error.message}` : 'copied';
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('IMPORT_SECRET');
  if (!secret || req.headers.get('x-import-secret') !== secret) return new Response('forbidden', { status: 403 });
  const { items } = await req.json() as { items: Item[] };
  const results: Record<string, string> = {};
  for (const it of items.slice(0, 10)) {
    try { results[it.att_id] = await copy(it); } catch (e) { results[it.att_id] = `error: ${(e as Error).message}`; }
  }
  return Response.json(results);
});
