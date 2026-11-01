// Copies people's documents from Airtable into the private "documents" bucket and
// records each one in app.documents (SPEC decisions 64, 70): people's and properties'.
//
// Works from the queue app.document_imports, which scripts/import/documents.ts fills
// with Airtable's short-lived signed links (the Airtable token never reaches here).
// The function takes no input: a call only copies the next few queued files, so it
// needs no secret. It runs with the service role. Answers with counts only.

import { createClient } from 'jsr:@supabase/supabase-js@2';

interface Row {
  att_id: string; url: string | null; file_name: string; content_type: string | null; country_code: string; doc_type: string;
  // A property's document names it here; a row with only party_id is a person's (decision 70).
  entity_type: string | null; entity_id: string | null; party_id: string | null; sensitive: boolean | null;
}

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { db: { schema: 'app' } });
const safe = (s: string) => s.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-120);

async function copy(r: Row): Promise<string> {
  const type = r.entity_type ?? 'party';
  const id = r.entity_id ?? r.party_id;
  if (!id || !['party', 'property'].includes(type)) throw new Error('bad target');
  const path = `${r.country_code}/${type}/${id}/${r.att_id}_${safe(r.file_name)}`;
  const seen = await db.from('documents').select('id').eq('storage_path', path).maybeSingle();
  if (seen.error) throw new Error(seen.error.message);
  if (seen.data) return 'done';
  if (!r.url || !/(^|\.)airtable(usercontent)?\.com$/.test(new URL(r.url).hostname)) throw new Error('bad url');
  const res = await fetch(r.url);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const body = new Uint8Array(await res.arrayBuffer());
  const up = await db.storage.from('documents').upload(path, body, { contentType: r.content_type || res.headers.get('content-type') || undefined, upsert: true });
  if (up.error) throw new Error(`upload: ${up.error.message}`);
  const ins = await db.from('documents').insert({
    entity_type: type, entity_id: id, country_code: r.country_code, doc_type: r.doc_type,
    storage_path: path, sensitive: r.sensitive ?? true, file_name: r.file_name, source: `airtable:${r.att_id}`,
  });
  if (ins.error) throw new Error(`record: ${ins.error.message}`);
  return 'done';
}

Deno.serve(async () => {
  const claimed = await db.rpc('claim_document_imports', { n: 4 });
  if (claimed.error) return Response.json({ error: claimed.error.message }, { status: 500 });
  const tally: Record<string, number> = {};
  for (const r of claimed.data as Row[]) {
    let status = 'done'; let result: string | null = null;
    try { await copy(r); } catch (e) { status = 'failed'; result = (e as Error).message.slice(0, 300); }
    await db.from('document_imports').update({ status, result, url: null, updated_at: new Date().toISOString() }).eq('att_id', r.att_id);
    tally[status] = (tally[status] ?? 0) + 1;
  }
  return Response.json(tally);
});
