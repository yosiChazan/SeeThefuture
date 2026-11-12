// Sends one e-mail from the system's address, when a staff member presses "send" on a
// ready-made mail (welcome / password reset, a task, a topic). Nothing is sent on its own.
//   { to, subject, text, html? }  → sent from MAIL_FROM over SMTP; Reply-To is the sender,
//                                   so an answer reaches a person and not the no-reply box
// Only staff who completed their second step may call it (app.is_staff, app.mfa_verified),
// and only to an address the system knows: a party's e-mail or a sign-in's e-mail. Every
// mail sent is written to app.audit_log (who, to whom, subject; not the body).
// Secrets (Edge Functions → Secrets): SMTP_USER, SMTP_PASS (a Google app password),
// MAIL_FROM (e.g. no-reply@…), optional MAIL_FROM_NAME, SMTP_HOST (smtp.gmail.com), SMTP_PORT (465).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const admin = createClient(URL_, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

const env = (k: string) => Deno.env.get(k) ?? '';
const transport = () => nodemailer.createTransport({
  host: env('SMTP_HOST') || 'smtp.gmail.com',
  port: Number(env('SMTP_PORT') || 465),
  secure: true, // 465; Supabase functions may not open port 25 or 587
  auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
});

async function knownAddress(email: string): Promise<boolean> {
  const { data } = await admin.from('parties').select('id').ilike('email', email).limit(1);
  if (data?.length) return true;
  for (let page = 1; page <= 20; page++) {
    const { data: u } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (u.users.some((x) => x.email?.toLowerCase() === email)) return true;
    if (u.users.length < 200) break;
  }
  return false;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });
  if (!env('SMTP_USER') || !env('SMTP_PASS') || !env('MAIL_FROM')) return reply(503, { error: 'mail is not set up (SMTP_USER, SMTP_PASS, MAIL_FROM)' });

  const caller = createClient(URL_, env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } }, auth: { persistSession: false }, db: { schema: 'app' },
  });
  const { data: me } = await caller.auth.getUser();
  const [staff, mfa] = await Promise.all([caller.rpc('is_staff'), caller.rpc('mfa_verified')]);
  if (!me?.user || staff.data !== true || mfa.data !== true) return reply(403, { error: 'staff only' });

  let b: Record<string, unknown>;
  try { b = await req.json(); } catch { return reply(400, { error: 'bad request' }); }
  const to = String(b.to ?? '').trim().toLowerCase();
  const subject = String(b.subject ?? '').trim();
  const text = String(b.text ?? '');
  const html = typeof b.html === 'string' && b.html ? b.html : undefined;
  if (!EMAIL.test(to) || !subject || subject.length > 300 || !text || text.length > 50_000 || (html?.length ?? 0) > 100_000) return reply(400, { error: 'to, subject and text are required' });
  if (!(await knownAddress(to))) return reply(400, { error: 'unknown address' });

  const { data: prof } = await admin.from('profiles').select('display_name').eq('user_id', me.user.id).maybeSingle();
  const fromName = env('MAIL_FROM_NAME') || 'See the Future';
  try {
    await transport().sendMail({
      from: { name: fromName, address: env('MAIL_FROM') }, to, subject, text, html,
      replyTo: me.user.email ? { name: prof?.display_name ?? me.user.email, address: me.user.email } : undefined,
    });
  } catch (e) {
    return reply(502, { error: `send failed: ${(e as Error).message}` });
  }
  await admin.from('audit_log').insert({ user_id: me.user.id, table_name: 'mail', action: 'send', new_row: { to, subject } });
  return reply(200, { ok: true });
});
