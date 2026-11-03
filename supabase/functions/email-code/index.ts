// Second factor by e-mail for users who are not admins (SPEC decision 88).
//   send     {}          → Supabase e-mails the signed-in user a 6-digit code (the sign-in
//                          e-mail template, which shows {{ .Token }})
//   verify   { code }    → when the code is right, the caller's own session counts as
//                          verified for 12 hours (app.email_mfa_sessions; app.mfa_verified())
// Called after the password, with the caller's token. Admins are refused: they use the
// authenticator app. The code is checked by Supabase itself; the short-lived session that
// check creates is signed out at once, so only the caller's session gains anything.
// Needs no secret of its own.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// The caller's session id, from their token (the token itself was checked by getUser).
function sessionId(token: string): string | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.session_id === 'string' ? payload.session_id : null;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false }, db: { schema: 'app' } });
  const { data: me } = await caller.auth.getUser(token);
  const sid = sessionId(token);
  const email = me?.user?.email;
  if (!me?.user || !sid || !email) return reply(401, { error: 'sign in first' });
  const isAdmin = await caller.rpc('is_admin');
  if (isAdmin.data !== false) return reply(403, { error: 'admins use the authenticator app' });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* send has no body */ }
  const otp = createClient(URL_, ANON, { auth: { persistSession: false, autoRefreshToken: false } });

  if (body.action === 'send') {
    const r = await otp.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    return r.error ? reply(429, { error: r.error.message }) : reply(200, { sent_to: email });
  }
  if (body.action === 'verify') {
    const code = String(body.code ?? '').replace(/\s/g, '');
    if (!/^\d{6,10}$/.test(code)) return reply(400, { error: 'bad code' });
    const v = await otp.auth.verifyOtp({ email, token: code, type: 'email' });
    if (v.error || !v.data.session) return reply(400, { error: 'wrong or expired code' });
    await admin.auth.admin.signOut(v.data.session.access_token, 'local').catch(() => {}); // only that new session
    const ins = await admin.schema('app').from('email_mfa_sessions')
      .upsert({ session_id: sid, user_id: me.user.id, verified_at: new Date().toISOString() });
    return ins.error ? reply(500, { error: ins.error.message }) : reply(200, { ok: true });
  }
  return reply(400, { error: 'unknown action' });
});
