// The users screen's actions that need the service role (SPEC decision 86):
//   create        { email, password, display_name }  → a sign-in and its app.profiles row
//   set_password  { user_id, password }               → a new password, e.g. a forgotten one
//   reset_mfa     { user_id }                         → removes the authenticator app; the user
//                                                       sets a new one at the next sign-in
//   delete        { user_id }                         → removes the sign-in (and its profile)
// Only an admin who completed TOTP (aal2) may call it: the caller's own token is checked
// against app.is_admin() and app.mfa_verified(). Access itself (countries, levels, admin,
// management, client) is written by the screen under the admin-only policies, not here.
// Needs no secret of its own: Supabase provides the URL and keys to every function.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const isUuid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const goodPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 10 && p.length <= 72;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  // Who is calling: their own token, checked by the database's own rules.
  const auth = req.headers.get('Authorization') ?? '';
  const caller = createClient(URL_, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: auth } }, auth: { persistSession: false }, db: { schema: 'app' },
  });
  const { data: me } = await caller.auth.getUser();
  const [isAdmin, mfa] = await Promise.all([caller.rpc('is_admin'), caller.rpc('mfa_verified')]);
  if (!me?.user || isAdmin.data !== true || mfa.data !== true) return reply(403, { error: 'admins with TOTP only' });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply(400, { error: 'bad request' }); }

  switch (body.action) {
    case 'create': {
      const email = String(body.email ?? '').trim().toLowerCase();
      const name = String(body.display_name ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) return reply(400, { error: 'email and name are required' });
      if (!goodPassword(body.password)) return reply(400, { error: 'password: 10 to 72 characters' });
      const created = await admin.auth.admin.createUser({ email, password: body.password, email_confirm: true });
      if (created.error || !created.data.user) return reply(400, { error: created.error?.message ?? 'not created' });
      const id = created.data.user.id;
      const prof = await admin.schema('app').from('profiles').insert({ user_id: id, display_name: name });
      if (prof.error) {
        await admin.auth.admin.deleteUser(id);
        return reply(400, { error: prof.error.message });
      }
      return reply(200, { user_id: id });
    }
    case 'set_password': {
      if (!isUuid(body.user_id) || !goodPassword(body.password)) return reply(400, { error: 'user and a password of 10 to 72 characters' });
      const r = await admin.auth.admin.updateUserById(body.user_id, { password: body.password });
      return r.error ? reply(400, { error: r.error.message }) : reply(200, { ok: true });
    }
    case 'reset_mfa': {
      if (!isUuid(body.user_id)) return reply(400, { error: 'user required' });
      const list = await admin.auth.admin.mfa.listFactors({ userId: body.user_id });
      if (list.error) return reply(400, { error: list.error.message });
      for (const f of list.data.factors) {
        const d = await admin.auth.admin.mfa.deleteFactor({ userId: body.user_id, id: f.id });
        if (d.error) return reply(400, { error: d.error.message });
      }
      return reply(200, { removed: list.data.factors.length });
    }
    case 'delete': {
      if (!isUuid(body.user_id)) return reply(400, { error: 'user required' });
      if (body.user_id === me.user.id) return reply(400, { error: 'you cannot delete yourself' });
      // The profile goes with the sign-in; the database refuses if it is the last admin.
      const prof = await admin.schema('app').from('profiles').delete().eq('user_id', body.user_id);
      if (prof.error) return reply(400, { error: prof.error.message });
      const r = await admin.auth.admin.deleteUser(body.user_id);
      return r.error ? reply(400, { error: r.error.message }) : reply(200, { ok: true });
    }
    default:
      return reply(400, { error: 'unknown action' });
  }
});
