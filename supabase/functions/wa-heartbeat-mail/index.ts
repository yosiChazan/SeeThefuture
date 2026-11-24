// The WhatsApp reminder by e-mail (SPEC decision 188). Called each morning by pg_cron (and safe to
// call by anyone): when app.wa_heartbeat_due() says it is time, mails the admins from the no-reply
// address that the WhatsApp Business app on the company phone must be opened, then marks it sent.
// Deployed with verify_jwt off. Secrets: SMTP_USER, SMTP_PASS, MAIL_FROM, optional MAIL_FROM_NAME,
// SMTP_HOST, SMTP_PORT (the same as send-mail); APP_URL optional (the system's address).

import { createClient } from 'jsr:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.16';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false }, db: { schema: 'app' } });
const env = (k: string) => Deno.env.get(k) ?? '';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async () => {
  const { data, error } = await admin.rpc('wa_heartbeat_due');
  if (error) return json(500, { error: error.message });
  const due = (data ?? [])[0] as { days: number; emails: string[] | null } | undefined;
  if (!due) return json(200, { due: false });
  const to = (due.emails ?? []).filter(Boolean);
  if (!to.length) return json(200, { due: true, sent: false, why: 'no admin e-mail' });
  if (!env('SMTP_USER') || !env('SMTP_PASS') || !env('MAIL_FROM')) return json(503, { error: 'mail is not set up' });

  const left = Math.max(0, 14 - due.days);
  const url = env('APP_URL') || 'https://seethefuture-office.pages.dev/';
  const subject = `תזכורת: לפתוח את WhatsApp Business בטלפון של החברה (${due.days} ימים)`;
  const text = [
    'שלום,',
    '',
    `עברו ${due.days} ימים מאז שסומן במערכת שאפליקציית WhatsApp Business נפתחה בטלפון של החברה.`,
    `Meta מנתקת את הוואטסאפ מהמערכת אחרי כ-14 ימים בלי פתיחת האפליקציה בטלפון (WhatsApp Web לא נחשב). ${left > 0 ? `נשארו בערך ${left} ימים.` : 'הזמן כבר עבר: כדאי לפתוח מיד.'}`,
    '',
    'מה לעשות:',
    '1. לפתוח את WhatsApp Business בטלפון של החברה.',
    `2. במערכת (${url}) ללחוץ "פתחתי את האפליקציה בטלפון" בתזכורת שבראש הדף.`,
    '',
    'הודעה אוטומטית ממערכת See the Future. אין צורך להשיב.',
  ].join('\n');

  try {
    await nodemailer.createTransport({
      host: env('SMTP_HOST') || 'smtp.gmail.com', port: Number(env('SMTP_PORT') || 465), secure: true,
      auth: { user: env('SMTP_USER'), pass: env('SMTP_PASS') },
    }).sendMail({ from: { name: env('MAIL_FROM_NAME') || 'See the Future', address: env('MAIL_FROM') }, to, subject, text });
  } catch (e) {
    return json(502, { error: `send failed: ${(e as Error).message}` });
  }
  await admin.rpc('wa_heartbeat_mailed');
  return json(200, { due: true, sent: true, to: to.length });
});
