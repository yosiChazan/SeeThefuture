// The AI that answers a client in WhatsApp on one topic, on a staff member's request (SPEC
// decision 183). Deployed with verify_jwt on.
//   { action: 'start', conversation_id, guide_id }  staff: hand the chat to the AI (24 hours at
//                                                   most); it answers the client's last message now
//   { action: 'stop', conversation_id }             staff: take the chat back
//   { action: 'summary', conversation_id }          staff: a short summary of where the chat stands
//                                                   (decision 186), saved on the chat
//   { action: 'reply', conversation_id }            whatsapp-webhook, after a client's message in
//                                                   a chat the AI holds (service-role key)
// The AI sees only the guide and this chat (its text and the client's pictures), never the
// client's card or money. It answers in the client's language, and hands the chat back to the
// office when the topic is done, when asked something the guide does not cover, when the client
// wants a person, or when it is unsure. Its messages are saved with origin 'ai'.
// Secrets: ANTHROPIC_API_KEY; and, as whatsapp-send, WA_API_BASE + WA_API_KEY (or the token).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(URL_, SERVICE, { auth: { persistSession: false }, db: { schema: 'app' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const GRAPH = () => env('WA_API_BASE') || `https://graph.facebook.com/${env('WA_GRAPH_VERSION') || 'v27.0'}`;
const MODEL = 'claude-opus-5-5';
const HOURS = 24;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
type Json = Record<string, any>;

const SYSTEM = `You answer clients of See the Future LTD on WhatsApp, in place of an office worker who handed you this chat.
See the Future manages apartments abroad for Israeli owners. You help with ONE topic only: the guide below.

How to answer:
- Write in the client's language (usually Hebrew), short and warm, like a person on WhatsApp: a few lines, one step at a time. No markdown headings or tables; plain text, numbered steps are fine.
- Follow the guide. Do not invent steps, screens, fees or rules that are not in it. If a screenshot shows something the guide does not explain, say what you see and what you are not sure about.
- When the client sends a screenshot, look at it and tell them exactly what to tap next.
- Never ask for or repeat passwords, card numbers, CVV, one-time codes or full ID numbers. If the client sends one, tell them not to share it and that it was not needed.
- Do not discuss money the office holds for them, balances, rent, contracts, fees of See the Future or anything about their apartments: that is for the office.

Hand the chat back to the office (handback = true) when:
- the topic is done (the client finished the steps, or says thanks and nothing else is left),
- the client asks about anything outside the guide, or asks for a person,
- you are unsure, the client is upset, or the same problem repeats twice.
When handing back, still write a short reply to the client (e.g. that a staff member will continue shortly), and give the office a one-line reason in Hebrew.
handback and reply must agree: if your reply tells the client that a person, the office or a named staff member will continue or that you are passing the chat on, handback MUST be true. Once you have said that, do not keep guiding in the same reply.

Return JSON only: {"reply": "...", "handback": true|false, "reason": "..."} (reason: empty when not handing back).`;

const SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string' },
    handback: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['reply', 'handback', 'reason'],
  additionalProperties: false,
};

async function sendText(conversation: Json, text: string): Promise<void> {
  const [{ data: acct }, { data: sec }] = await Promise.all([
    admin.from('whatsapp_account').select('phone_number_id').eq('id', 1).maybeSingle(),
    admin.from('whatsapp_secret').select('token').eq('id', 1).maybeSingle(),
  ]);
  const key = env('WA_API_KEY') || sec?.token;
  if (!acct?.phone_number_id || !key) throw new Error('WhatsApp is not connected');
  const r = await fetch(`${GRAPH()}/${acct.phone_number_id}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: conversation.wa_phone.replace(/\D/g, ''), type: 'text', text: { body: text, preview_url: true } }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.messages?.[0]?.id) throw new Error(`send: ${j.error?.message ?? r.status}`);
  const now = new Date().toISOString();
  const { error } = await admin.from('messages').insert({
    conversation_id: conversation.id, direction: 'out', body: text, kind: 'text', origin: 'ai', status: 'sent',
    wa_message_id: j.messages[0].id, created_at: now, wa_timestamp: now,
  });
  if (error) throw error;
  await admin.from('conversations').update({ last_message_at: now }).eq('id', conversation.id);
}

async function handBack(id: string, reason: string) {
  await admin.from('conversations').update({
    ai_guide_id: null, ai_until: null, ai_handback_reason: reason.slice(0, 500), ai_handback_at: new Date().toISOString(), status: 'open',
  }).eq('id', id);
}

// One answer of the AI to the chat as it is now.
async function answer(conversationId: string): Promise<Json> {
  const { data: c } = await admin.from('conversations').select('*').eq('id', conversationId).maybeSingle();
  if (!c?.ai_guide_id) return { skipped: 'not with the AI' };
  if (c.ai_until && new Date(c.ai_until) < new Date()) { await handBack(c.id, 'עבר הזמן שהוקצב ל-AI'); return { skipped: 'expired' }; }
  const { data: guide } = await admin.from('ai_guides').select('title, content, active').eq('id', c.ai_guide_id).maybeSingle();
  if (!guide?.active) { await handBack(c.id, 'המדריך לא פעיל'); return { skipped: 'guide off' }; }

  // The chat: the last messages before the hand-off for context, and everything since.
  const { data: rows } = await admin.from('messages').select('direction, origin, kind, body, media_path, created_at')
    .eq('conversation_id', c.id).order('created_at', { ascending: false }).limit(40);
  const msgs = (rows ?? []).reverse();
  const last = msgs.at(-1);
  if (!last || last.direction !== 'in') return { skipped: 'nothing to answer' };

  // Pictures of the client's last messages (the 3 latest).
  const pics = new Map<string, { data: string; type: string }>();
  for (const m of [...msgs].reverse().filter((m) => m.direction === 'in' && m.media_path && (m.kind === 'image' || m.kind === 'sticker')).slice(0, 3)) {
    const { data } = await admin.storage.from('whatsapp').download(m.media_path);
    if (!data) continue;
    const type = data.type || 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(type)) continue;
    const bytes = new Uint8Array(await data.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    pics.set(m.media_path, { data: btoa(bin), type });
  }

  // As alternating turns: the client is "user", we (office, phone or AI) are "assistant".
  const turns: { role: 'user' | 'assistant'; content: Json[] }[] = [];
  for (const m of msgs) {
    const role: 'user' | 'assistant' = m.direction === 'in' ? 'user' : 'assistant';
    const content: Json[] = [];
    const pic = m.media_path ? pics.get(m.media_path) : undefined;
    if (pic && role === 'user') content.push({ type: 'image', source: { type: 'base64', media_type: pic.type, data: pic.data } });
    const text = (m.body ?? '').trim() || (m.media_path ? `[${m.kind}]` : '');
    const who = role === 'assistant' ? (m.origin === 'ai' ? '' : '[office] ') : '';
    if (text) content.push({ type: 'text', text: who + text });
    if (!content.length) continue;
    const prev = turns.at(-1);
    if (prev && prev.role === role) prev.content.push(...content);
    else turns.push({ role, content });
  }
  while (turns.length && turns[0].role !== 'user') turns.shift();
  if (!turns.length) return { skipped: 'no client message' };

  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: [{ type: 'text', text: `${SYSTEM}\n\n<guide title="${guide.title}">\n${guide.content}\n</guide>`, cache_control: { type: 'ephemeral' } }],
    messages: turns,
    // deno-lint-ignore no-explicit-any
  } as any);

  if (res.stop_reason === 'refusal') { await handBack(c.id, 'ה-AI לא ענה על ההודעה הזו'); return { handback: true }; }
  // deno-lint-ignore no-explicit-any
  const textBlock = res.content.find((b: any) => b.type === 'text') as { text: string } | undefined;
  let out: { reply: string; handback: boolean; reason: string };
  try { out = JSON.parse(textBlock?.text ?? ''); } catch { await handBack(c.id, 'תשובת ה-AI לא הייתה תקינה'); return { handback: true }; }
  if (out.reply?.trim()) await sendText(c, out.reply.trim());
  if (out.handback) await handBack(c.id, out.reason?.trim() || 'ה-AI סיים');
  return { sent: !!out.reply?.trim(), handback: out.handback };
}

// Where a chat stands (decision 186), for the office: in Hebrew, from its last messages.
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    waiting_on: { type: 'string', enum: ['us', 'client', 'none'] },
  },
  required: ['summary', 'waiting_on'],
  additionalProperties: false,
};
async function summarize(conversationId: string): Promise<Json> {
  const { data: rows } = await admin.from('messages').select('direction, origin, kind, body, created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: false }).limit(80);
  const msgs = (rows ?? []).reverse();
  if (!msgs.length) return { summary: null };
  const who = (m: Json) => m.direction === 'in' ? 'לקוח' : m.origin === 'ai' ? 'AI' : m.origin === 'app' ? 'משרד (טלפון)' : 'משרד';
  const transcript = msgs.map((m) => `[${new Date(m.created_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}] ${who(m)}: ${(m.body ?? '').trim() || `[${m.kind}]`}`).join('\n');
  const client = new Anthropic();
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SUMMARY_SCHEMA } },
    system: 'You summarize a WhatsApp chat between See the Future (an office that manages apartments abroad for Israeli owners) and one client, for the office staff. Write in Hebrew, 2-4 short sentences: what the client wants or asked, what was already done or answered, what is still open, and what the next step is and whose it is. Concrete (names of topics, dates if relevant), no greetings, no filler. waiting_on: "us" if the office should act next, "client" if we wait for the client, "none" if nothing is open.',
    messages: [{ role: 'user', content: `<chat>\n${transcript}\n</chat>` }],
    // deno-lint-ignore no-explicit-any
  } as any);
  if (res.stop_reason === 'refusal') return { summary: null };
  // deno-lint-ignore no-explicit-any
  const t = res.content.find((b: any) => b.type === 'text') as { text: string } | undefined;
  const out = JSON.parse(t?.text ?? '{}');
  const now = new Date().toISOString();
  await admin.from('conversations').update({ ai_summary: out.summary ?? null, ai_summary_at: now, ai_waiting_on: out.waiting_on ?? null }).eq('id', conversationId);
  return { summary: out.summary, waiting_on: out.waiting_on, at: now };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  if (!env('ANTHROPIC_API_KEY')) return reply(503, { error: 'ANTHROPIC_API_KEY is not set' });
  let b: Json;
  try { b = await req.json(); } catch { return reply(400, { error: 'bad request' }); }
  const id = String(b.conversation_id ?? '');

  // From the webhook, with the service-role key.
  if (b.action === 'reply') {
    if (req.headers.get('Authorization') !== `Bearer ${SERVICE}`) return reply(403, { error: 'internal only' });
    try { return reply(200, await answer(id)); } catch (e) {
      await handBack(id, `תקלה ב-AI: ${(e as Error).message}`.slice(0, 300));
      return reply(500, { error: (e as Error).message });
    }
  }

  // From the inbox: staff who completed their second step.
  const caller = createClient(URL_, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false }, db: { schema: 'app' },
  });
  const { data: me } = await caller.auth.getUser();
  const [staff, mfa] = await Promise.all([caller.rpc('is_staff'), caller.rpc('mfa_verified')]);
  if (!me?.user || staff.data !== true || mfa.data !== true) return reply(403, { error: 'staff only' });

  if (b.action === 'summary') {
    try { return reply(200, await summarize(id)); } catch (e) { return reply(500, { error: (e as Error).message }); }
  }
  if (b.action === 'stop') {
    await admin.from('conversations').update({ ai_guide_id: null, ai_until: null, ai_handback_reason: 'נעצר ע"י עובד', ai_handback_at: new Date().toISOString() }).eq('id', id);
    return reply(200, { ok: true });
  }
  if (b.action === 'start') {
    const { data: g } = await admin.from('ai_guides').select('id, active').eq('id', String(b.guide_id ?? '')).maybeSingle();
    if (!g?.active) return reply(400, { error: 'המדריך לא קיים או לא אושר לשימוש' });
    const now = new Date();
    const { error } = await admin.from('conversations').update({
      ai_guide_id: g.id, ai_started_at: now.toISOString(), ai_started_by: me.user.id,
      ai_until: new Date(now.getTime() + HOURS * 3600_000).toISOString(), ai_handback_reason: null, ai_handback_at: null,
    }).eq('id', id);
    if (error) return reply(500, { error: error.message });
    await admin.from('audit_log').insert({ user_id: me.user.id, table_name: 'conversations', row_id: id, action: 'ai_start', new_row: { guide_id: g.id } });
    try { return reply(200, { ok: true, ...(await answer(id)) }); } catch (e) {
      await handBack(id, `תקלה ב-AI: ${(e as Error).message}`.slice(0, 300));
      return reply(500, { error: (e as Error).message });
    }
  }
  return reply(400, { error: 'unknown action' });
});
