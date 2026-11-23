// Meta's WhatsApp webhook (SPEC §6.5, decision 180). Deployed with verify_jwt off: Meta calls it.
//   GET  ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…  → the challenge, when the token
//        is WA_VERIFY_TOKEN (set in Meta: WhatsApp → Configuration → Webhook)
//   POST a change, signed by Meta (X-Hub-Signature-256, HMAC-SHA256 of the body with
//        META_APP_SECRET); anything not signed is refused. Answered at once; the work goes on after.
// Fields (subscribe to all five in Meta):
//   messages            a client's message, or the delivery status of one of ours
//   smb_message_echoes  a message we sent from the WhatsApp Business app on the phone
//   history             the last 6 months of chats, once, after the number is connected
//   smb_app_state_sync  the phone's contacts: their names go on the chats
//   account_update      the connection's life (kept as the last event)
// Pictures and files go to the private bucket "whatsapp" (<chat id>/<message id>.<ext>).
// Secrets (Edge Functions → Secrets): META_APP_SECRET, WA_VERIFY_TOKEN; optional WA_GRAPH_VERSION.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const GRAPH = () => `https://graph.facebook.com/${env('WA_GRAPH_VERSION') || 'v27.0'}`;

async function signed(body: string, header: string | null): Promise<boolean> {
  const secret = env('META_APP_SECRET');
  if (!secret || !header?.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7);
  if (got.length !== hex.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

type Json = Record<string, any>;   // Meta's payloads
const digits = (s: unknown) => String(s ?? '').replace(/\D/g, '');

// The text of a message, whatever its type.
function bodyOf(m: Json): { kind: string; body: string | null; media: Json | null; file: string | null } {
  const t = String(m.type ?? 'text');
  const media = ['image', 'document', 'audio', 'video', 'sticker'].includes(t) ? m[t] ?? null : null;
  let body: string | null = null;
  if (t === 'text') body = m.text?.body ?? null;
  else if (media) body = media.caption ?? null;
  else if (t === 'location') body = `📍 ${[m.location?.name, m.location?.address].filter(Boolean).join(', ') || ''} https://maps.google.com/?q=${m.location?.latitude},${m.location?.longitude}`;
  else if (t === 'contacts') body = (m.contacts ?? []).map((c: Json) => `👤 ${c.name?.formatted_name ?? ''} ${(c.phones ?? []).map((p: Json) => p.phone).join(', ')}`).join('\n');
  else if (t === 'button') body = m.button?.text ?? null;
  else if (t === 'interactive') body = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? null;
  else if (t === 'reaction') body = m.reaction?.emoji ? `${m.reaction.emoji} (תגובה להודעה)` : null;
  else if (t === 'template') body = m.template?.name ? `[תבנית: ${m.template.name}]` : null;
  else if (t === 'unsupported' || t === 'unknown') body = '[הודעה שוואטסאפ לא מעביר למערכת]';
  return { kind: t, body, media, file: media?.filename ?? null };
}

async function token(): Promise<string | null> {
  const { data } = await admin.from('whatsapp_secret').select('token').eq('id', 1).maybeSingle();
  return data?.token ?? null;
}

// The chat of this number: found, or opened (and given its client by the number).
async function chat(phoneDigits: string, name?: string | null): Promise<string> {
  const wa_phone = `+${phoneDigits}`;
  const { data: found } = await admin.from('conversations').select('id, contact_name, client_party_id').eq('wa_phone', wa_phone).maybeSingle();
  if (found) {
    if (name && !found.contact_name) await admin.from('conversations').update({ contact_name: name }).eq('id', found.id);
    return found.id;
  }
  const { data: party } = await admin.rpc('wa_party_for', { p_digits: phoneDigits });
  const { data, error } = await admin.from('conversations').upsert({ wa_phone, contact_name: name ?? null, client_party_id: party ?? null }, { onConflict: 'wa_phone' }).select('id').single();
  if (error) throw error;
  return data.id;
}

// A picture or file: from Meta to our bucket. Returns its path, or null.
async function keepMedia(conversation: string, wamid: string, media: Json): Promise<string | null> {
  const tk = await token();
  if (!tk || !media?.id) return null;
  try {
    const meta = await (await fetch(`${GRAPH()}/${media.id}`, { headers: { Authorization: `Bearer ${tk}` } })).json();
    if (!meta.url) return null;
    const file = await fetch(meta.url, { headers: { Authorization: `Bearer ${tk}` } });
    if (!file.ok) return null;
    const type = String(meta.mime_type ?? media.mime_type ?? 'application/octet-stream').split(';')[0];
    const ext = (media.filename?.split('.').pop() ?? type.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const path = `${conversation}/${wamid.replace(/[^A-Za-z0-9_-]/g, '_')}.${ext}`;
    const { error } = await admin.storage.from('whatsapp').upload(path, await file.arrayBuffer(), { contentType: type, upsert: true });
    return error ? null : path;
  } catch { return null; }
}

// One message into its chat (once: the WhatsApp id is unique).
async function save(m: Json, o: { direction: 'in' | 'out'; peer: string; name?: string | null; origin: 'api' | 'app' | 'history'; status?: string | null }) {
  if (!m.id || !o.peer) return;
  const conversation = await chat(o.peer, o.name);
  const { kind, body, media, file } = bodyOf(m);
  const at = m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : new Date().toISOString();
  const { data: added } = await admin.from('messages').upsert({
    conversation_id: conversation, direction: o.direction, body, kind, origin: o.origin, file_name: file,
    status: o.direction === 'out' ? (o.status ?? 'sent') : null, wa_message_id: m.id, wa_timestamp: at, created_at: at,
  }, { onConflict: 'wa_message_id', ignoreDuplicates: true }).select('id');
  if (!added?.length) return;   // already here
  if (media) {
    const path = await keepMedia(conversation, m.id, media);
    if (path) await admin.from('messages').update({ media_path: path }).eq('id', added[0].id);
  }
  // The chat's last time; a client's new message opens a closed or waiting chat again.
  const { data: c } = await admin.from('conversations').select('last_message_at, status').eq('id', conversation).single();
  const fields: Json = {};
  if (!c?.last_message_at || c.last_message_at < at) fields.last_message_at = at;
  if (o.direction === 'in' && o.origin !== 'history' && c?.status !== 'open') fields.status = 'open';
  if (Object.keys(fields).length) await admin.from('conversations').update(fields).eq('id', conversation);
}

async function handle(payload: Json) {
  const { data: acct } = await admin.from('whatsapp_account').select('display_phone').eq('id', 1).maybeSingle();
  const own = digits(acct?.display_phone);
  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v: Json = change.value ?? {};
      const own2 = own || digits(v.metadata?.display_phone_number);
      try {
        if (change.field === 'messages') {
          const names = new Map<string, string>((v.contacts ?? []).map((c: Json) => [digits(c.wa_id), c.profile?.name]));
          for (const m of v.messages ?? []) await save(m, { direction: 'in', peer: digits(m.from), name: names.get(digits(m.from)), origin: 'api' });
          for (const s of v.statuses ?? []) {
            const fields: Json = { status: s.status };
            if (s.errors?.length) fields.error = s.errors.map((e: Json) => `${e.code}: ${e.title ?? e.message ?? ''}`).join('; ');
            await admin.from('messages').update(fields).eq('wa_message_id', s.id);
          }
        } else if (change.field === 'smb_message_echoes') {
          for (const m of v.message_echoes ?? []) await save(m, { direction: 'out', peer: digits(m.to), origin: 'app' });
        } else if (change.field === 'history') {
          for (const h of v.history ?? []) {
            for (const thread of h.threads ?? []) {
              for (const m of thread.messages ?? []) {
                const mine = digits(m.from) === own2;
                const status = m.history_context?.status ? String(m.history_context.status).toLowerCase() : null;
                await save(m, { direction: mine ? 'out' : 'in', peer: mine ? digits(m.to ?? thread.id) : digits(m.from), origin: 'history', status });
              }
            }
          }
          await admin.from('whatsapp_account').update({ history_sync_at: new Date().toISOString() }).eq('id', 1);
        } else if (change.field === 'smb_app_state_sync') {
          for (const s of v.state_sync ?? []) {
            const c = s.contact ?? {};
            const n = digits(c.phone_number);
            const name = c.full_name ?? c.first_name ?? null;
            if (n && name && s.action !== 'remove') await admin.from('conversations').update({ contact_name: name }).eq('wa_phone', `+${n}`);
          }
          await admin.from('whatsapp_account').update({ contacts_sync_at: new Date().toISOString() }).eq('id', 1);
        }
      } catch (e) {
        await admin.from('whatsapp_account').update({ last_error: `${change.field}: ${(e as Error).message}`.slice(0, 500) }).eq('id', 1);
      }
    }
  }
  await admin.from('whatsapp_account').update({ last_webhook_at: new Date().toISOString() }).eq('id', 1);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const ok = url.searchParams.get('hub.mode') === 'subscribe' && env('WA_VERIFY_TOKEN') && url.searchParams.get('hub.verify_token') === env('WA_VERIFY_TOKEN');
    return ok ? new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 }) : new Response('forbidden', { status: 403 });
  }
  if (req.method !== 'POST') return new Response('POST only', { status: 405 });
  const raw = await req.text();
  if (!(await signed(raw, req.headers.get('X-Hub-Signature-256')))) return new Response('bad signature', { status: 401 });
  let payload: Json;
  try { payload = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }
  // Meta wants an answer within seconds; the work goes on after it.
  // @ts-ignore EdgeRuntime is Supabase's
  EdgeRuntime.waitUntil(handle(payload).catch(() => undefined));
  return new Response('ok', { status: 200 });
});
