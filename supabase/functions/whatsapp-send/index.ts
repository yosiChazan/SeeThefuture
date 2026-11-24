// Sends a WhatsApp message from the inbox (SPEC decision 180), through the connected number.
//   { conversation_id, text, reply_to? }              → a text, quoting reply_to (a WhatsApp id) if given; WhatsApp takes it only within 24
//                                                       hours of the client's last message
//   { conversation_id, template, language, params? }  → an approved template (outside the 24 hours);
//                                                       params fill {{1}}, {{2}}… of its body
//   { action: 'templates' }                            → the approved templates, for the picker
// Staff who completed their second step only. The message is written to app.messages with who
// sent it; its delivery (sent, delivered, read, failed) arrives later at whatsapp-webhook.
// Secrets: directly, none of its own (the token is in app.whatsapp_secret); through Dualhook
// (decision 182), WA_API_BASE (https://api.dualhook.com/v25.0) and WA_API_KEY; optional WA_GRAPH_VERSION.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const GRAPH = () => env('WA_API_BASE') || `https://graph.facebook.com/${env('WA_GRAPH_VERSION') || 'v27.0'}`;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Meta's answer to "outside the 24 hours" and other common refusals, in Hebrew.
function hebrew(code: number | undefined, message: string): string {
  if (code === 131047) return 'עברו יותר מ-24 שעות מההודעה האחרונה של הלקוח: אפשר לשלוח רק תבנית מאושרת';
  if (code === 131026) return 'ההודעה לא נמסרה: למספר הזה אין וואטסאפ, או שהוא חסם אותנו';
  if (code === 131056) return 'נשלחו יותר מדי הודעות למספר הזה בזמן קצר. כדאי לחכות כמה דקות';
  if (code === 132001) return 'התבנית לא קיימת או לא אושרה בשפה הזו';
  return message;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const caller = createClient(URL_, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false }, db: { schema: 'app' },
  });
  const { data: me } = await caller.auth.getUser();
  const [staff, mfa] = await Promise.all([caller.rpc('is_staff'), caller.rpc('mfa_verified')]);
  if (!me?.user || staff.data !== true || mfa.data !== true) return reply(403, { error: 'staff only' });

  const [{ data: acct }, { data: sec }] = await Promise.all([
    admin.from('whatsapp_account').select('waba_id, phone_number_id').eq('id', 1).maybeSingle(),
    admin.from('whatsapp_secret').select('token').eq('id', 1).maybeSingle(),
  ]);
  const key = env('WA_API_KEY') || sec?.token;
  if (!acct?.phone_number_id || !key) return reply(503, { error: 'הוואטסאפ עוד לא מחובר למערכת' });
  const auth = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return reply(400, { error: 'bad request' }); }

  if (b.action === 'templates') {
    const r = await fetch(`${GRAPH()}/${acct.waba_id}/message_templates?fields=name,language,status,category,components&status=APPROVED&limit=100`, { headers: auth });
    const j = await r.json();
    if (!r.ok) return reply(502, { error: j.error?.message ?? 'templates' });
    // deno-lint-ignore no-explicit-any
    return reply(200, { templates: (j.data ?? []).filter((t: any) => t.status === 'APPROVED').map((t: any) => ({
      name: t.name, language: t.language, category: t.category,
      // deno-lint-ignore no-explicit-any
      body: (t.components ?? []).find((c: any) => c.type === 'BODY')?.text ?? '',
    })) });
  }

  const { data: conv } = await admin.from('conversations').select('id, wa_phone').eq('id', String(b.conversation_id ?? '')).maybeSingle();
  if (!conv) return reply(404, { error: 'no such chat' });
  const to = conv.wa_phone.replace(/\D/g, '');

  let payload: Record<string, unknown>, body: string, kind: string;
  if (b.template) {
    const params: string[] = Array.isArray(b.params) ? b.params.map(String) : [];
    payload = { type: 'template', template: { name: String(b.template), language: { code: String(b.language ?? 'he') },
      ...(params.length ? { components: [{ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) }] } : {}) } };
    body = String(b.preview ?? `[תבנית: ${b.template}]`);
    kind = 'template';
  } else {
    const text = String(b.text ?? '').trim();
    if (!text) return reply(400, { error: 'empty message' });
    if (text.length > 4096) return reply(400, { error: 'ההודעה ארוכה מ-4096 תווים' });
    payload = { type: 'text', text: { body: text, preview_url: true } };
    body = text;
    kind = 'text';
  }

  // A quoted reply (decision 196).
  const replyTo = !b.template && b.reply_to ? String(b.reply_to) : null;
  const r = await fetch(`${GRAPH()}/${acct.phone_number_id}/messages`, {
    method: 'POST', headers: auth, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, ...payload, ...(replyTo ? { context: { message_id: replyTo } } : {}) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.messages?.[0]?.id) {
    const err = j.error ?? {};
    return reply(422, { error: hebrew(err.code ?? err.error_data?.code, err.error_data?.details ?? err.message ?? 'השליחה נכשלה') });
  }
  const now = new Date().toISOString();
  const { data: msg, error } = await admin.from('messages').insert({
    conversation_id: conv.id, direction: 'out', body, kind, origin: 'api', status: 'sent', wa_message_id: j.messages[0].id,
    sent_by: me.user.id, created_at: now, wa_timestamp: now, reply_to: replyTo,
  }).select('id').single();
  // A person answered from the inbox: the chat is theirs again, not the AI's (decision 183).
  await admin.from('conversations').update({ last_message_at: now, ai_guide_id: null, ai_until: null }).eq('id', conv.id);
  return reply(200, { ok: true, id: msg?.id, error: error?.message });
});
