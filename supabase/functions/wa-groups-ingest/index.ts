// What the WhatsApp Web extension read from the groups (SPEC decision 212), read only.
//   POST { groups: [{ title, jid? }], messages: [{ group, jid?, wa_id?, preview_key?, sender?, body?,
//          sent_at_text?, kind?, file_name?, image? (base64 jpeg/png) }] }
//   Authorization: Bearer <the extension's key, made in Settings ← WhatsApp>
// Deployed with verify_jwt off: the key is the check. A message already here adds nothing.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

// "[13:05, 26.11.2026] " or "[1:05 PM, 11/26/2026] " → a time (Israel time when no zone is given).
function when(t: string | undefined): string | null {
  const m = /\[?(\d{1,2}):(\d{2})(?:\s*([AP]M))?,\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})\]?/i.exec(t ?? '');
  if (!m) return null;
  let [h, mi, ap, a, b, y] = [Number(m[1]), Number(m[2]), m[3], Number(m[4]), Number(m[5]), Number(m[6])];
  if (y < 100) y += 2000;
  if (ap) { if (/pm/i.test(ap) && h < 12) h += 12; if (/am/i.test(ap) && h === 12) h = 0; }
  // Day first unless the second number cannot be a month, or the page writes month first (AM/PM).
  let [d, mo] = t!.includes('.') ? [a, b] : b > 12 || (ap && a <= 12) ? [b, a] : [a, b];
  if (mo > 12) [d, mo] = [mo, d];
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:00+02:00`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const key = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!key) return reply(401, { error: 'no key' });
  const { data: tok } = await admin.from('ext_tokens').select('id').eq('token_hash', await sha256(key)).is('revoked_at', null).maybeSingle();
  if (!tok) return reply(401, { error: 'bad key' });
  await admin.from('ext_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', tok.id);

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return reply(400, { error: 'bad json' }); }
  const groups = new Map<string, string>();   // title → id
  const group = async (title: string, jid?: string | null) => {
    title = String(title).trim().slice(0, 300);
    if (groups.has(title)) return groups.get(title)!;
    let { data: g } = await admin.from('wa_groups').select('id, jid').eq('title', title).maybeSingle();
    if (!g && jid) ({ data: g } = await admin.from('wa_groups').select('id, jid').eq('jid', jid).maybeSingle());
    if (!g) ({ data: g } = await admin.from('wa_groups').insert({ title, jid: jid ?? null }).select('id, jid').single());
    else if (jid && !g.jid) await admin.from('wa_groups').update({ jid }).eq('id', g.id);
    groups.set(title, g!.id);
    return g!.id as string;
  };
  for (const g of b.groups ?? []) if (g?.title) await group(g.title, g.jid);

  let added = 0;
  for (const m of (b.messages ?? []).slice(0, 500)) {
    if (!m?.group || (!m.wa_id && !m.preview_key)) continue;
    const gid = await group(m.group, m.jid);
    const at = when(m.sent_at_text);
    const row = {
      group_id: gid, wa_id: m.wa_id ? String(m.wa_id).slice(0, 300) : null, preview_key: m.wa_id ? null : String(m.preview_key).slice(0, 300),
      sender: m.sender ? String(m.sender).slice(0, 200) : null, body: m.body ? String(m.body).slice(0, 10000) : null,
      sent_at: at, sent_at_text: m.sent_at_text ? String(m.sent_at_text).slice(0, 60) : null,
      kind: ['text', 'image', 'document', 'other'].includes(m.kind) ? m.kind : 'text', file_name: m.file_name ? String(m.file_name).slice(0, 300) : null,
      origin: m.wa_id ? 'open' : 'preview',
    };
    const { data: ins, error } = await admin.from('wa_group_messages').upsert(row, { onConflict: m.wa_id ? 'wa_id' : 'preview_key', ignoreDuplicates: true }).select('id');
    if (error) return reply(500, { error: error.message });
    if (!ins?.length) continue;
    added++;
    if (m.image && String(m.image).length < 8_000_000) {
      const bytes = Uint8Array.from(atob(String(m.image)), (c) => c.charCodeAt(0));
      const path = `groups/${gid}/${ins[0].id}.jpg`;
      const up = await admin.storage.from('whatsapp').upload(path, bytes, { contentType: 'image/jpeg', upsert: true });
      if (!up.error) await admin.from('wa_group_messages').update({ media_path: path }).eq('id', ins[0].id);
    }
    await admin.from('wa_groups').update({ last_message_at: at ?? new Date().toISOString() }).eq('id', gid);
  }
  return reply(200, { ok: true, added });
});
