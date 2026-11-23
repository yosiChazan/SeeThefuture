// Connects the company's WhatsApp number to the system (SPEC decision 180), right after Meta's
// signup window (Embedded Signup, "connect your WhatsApp Business app") closes in Settings:
//   { code, waba_id, phone_number_id? }
//   1. the code becomes the number's business token (kept in app.whatsapp_secret);
//   2. our app is subscribed to the account's webhooks;
//   3. the number's details are read (and its id, if the window did not give it);
//   4. the phone's contacts and the last 6 months of chats are asked for (Meta allows this once,
//      within 24 hours of the connection; they arrive at whatsapp-webhook).
//   { action: 'status' } → what Meta says about the number now.
// Only an admin who completed TOTP may call it. Every call is written to app.audit_log.
// Secrets (Edge Functions → Secrets): META_APP_ID, META_APP_SECRET; optional WA_GRAPH_VERSION.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const GRAPH = () => `https://graph.facebook.com/${env('WA_GRAPH_VERSION') || 'v27.0'}`;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// deno-lint-ignore no-explicit-any
async function graph(path: string, tk: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(`${GRAPH()}/${path}`, { ...init, headers: { Authorization: `Bearer ${tk}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`${path.split('?')[0]}: ${j.error?.message ?? r.status}`);
  return j;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  const caller = createClient(URL_, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false }, db: { schema: 'app' },
  });
  const { data: me } = await caller.auth.getUser();
  const [isAdmin, mfa] = await Promise.all([caller.rpc('is_admin'), caller.rpc('mfa_verified')]);
  if (!me?.user || isAdmin.data !== true || mfa.data !== true) return reply(403, { error: 'admins with TOTP only' });
  if (!env('META_APP_ID') || !env('META_APP_SECRET')) return reply(503, { error: 'META_APP_ID / META_APP_SECRET are not set' });

  // deno-lint-ignore no-explicit-any
  let b: any;
  try { b = await req.json(); } catch { return reply(400, { error: 'bad request' }); }
  const audit = (action: string, detail: unknown) => admin.from('audit_log').insert({ user_id: me.user!.id, table_name: 'whatsapp', action, new_row: detail }).then(() => undefined, () => undefined);

  if (b.action === 'status') {
    const { data: s } = await admin.from('whatsapp_secret').select('token').eq('id', 1).maybeSingle();
    const { data: a } = await admin.from('whatsapp_account').select('*').eq('id', 1).maybeSingle();
    if (!s?.token || !a?.phone_number_id) return reply(200, { connected: false });
    try {
      const n = await graph(`${a.phone_number_id}?fields=display_phone_number,verified_name,quality_rating,is_on_biz_app,platform_type,code_verification_status`, s.token);
      return reply(200, { connected: true, number: n });
    } catch (e) { return reply(200, { connected: true, error: (e as Error).message }); }
  }

  const code = String(b.code ?? ''), waba = String(b.waba_id ?? '').replace(/\D/g, '');
  let phoneId = String(b.phone_number_id ?? '').replace(/\D/g, '');
  if (!code || !waba) return reply(400, { error: 'code and waba_id are required' });
  const steps: string[] = [];
  try {
    // 1. The business token.
    const q = new URLSearchParams({ client_id: env('META_APP_ID'), client_secret: env('META_APP_SECRET'), code });
    const t = await (await fetch(`${GRAPH()}/oauth/access_token?${q}`)).json();
    if (!t.access_token) throw new Error(`token: ${t.error?.message ?? 'no token'}`);
    const tk = t.access_token as string;
    await admin.from('whatsapp_secret').upsert({ id: 1, token: tk, set_at: new Date().toISOString() });
    steps.push('token');
    // 2. Webhooks of the account to our app.
    await graph(`${waba}/subscribed_apps`, tk, { method: 'POST' });
    steps.push('subscribed');
    // 3. The number.
    if (!phoneId) {
      const list = await graph(`${waba}/phone_numbers?fields=id,display_phone_number`, tk);
      phoneId = list.data?.[0]?.id ?? '';
      if (!phoneId) throw new Error('no phone number on the account');
    }
    const n = await graph(`${phoneId}?fields=display_phone_number,verified_name,is_on_biz_app,platform_type`, tk);
    await admin.from('whatsapp_account').upsert({
      id: 1, waba_id: waba, phone_number_id: phoneId, display_phone: n.display_phone_number ?? null,
      connected_at: new Date().toISOString(), connected_by: me.user.id, last_error: null,
    });
    steps.push('number');
    // 4. Contacts, then the chats' history (once, within 24 hours).
    for (const sync_type of ['smb_app_state_sync', 'history']) {
      try { await graph(`${phoneId}/smb_app_data`, tk, { method: 'POST', body: JSON.stringify({ messaging_product: 'whatsapp', sync_type }) }); steps.push(sync_type); }
      catch (e) { steps.push(`${sync_type} failed: ${(e as Error).message}`); }
    }
    await audit('whatsapp_connect', { waba_id: waba, phone_number_id: phoneId, display_phone: n.display_phone_number, steps });
    return reply(200, { ok: true, steps, number: n });
  } catch (e) {
    const msg = (e as Error).message;
    await admin.from('whatsapp_account').upsert({ id: 1, last_error: msg.slice(0, 500) });
    await audit('whatsapp_connect_failed', { waba_id: waba, steps, error: msg });
    return reply(502, { error: msg, steps });
  }
});
