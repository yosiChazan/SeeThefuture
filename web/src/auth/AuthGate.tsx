import { Alert, Button, Center, Image, Loader, Paper, PasswordInput, PinInput, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessProvider, useAccessQuery } from '../lib/access';
import { supabase } from '../lib/supabase';

// The second step after the password (SPEC §3, decision 88): admins use an authenticator
// app (aal2); everyone else may instead get a code by e-mail, which the database counts for
// that session (app.mfa_verified()). Clients have no access to the office app at all.
type Second = { ok: boolean; admin: boolean; hasTotp: boolean };

// Staff sign in with email and password, then a second step (SPEC §3: 2FA for staff).
// A user without a profile row has no access, whatever they signed up with.
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [second, setSecond] = useState<Second | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const sessionId = session?.access_token ? session.user.id + ':' + (session.expires_at ?? '') : null;
  useEffect(() => {
    if (!session) { setSecond(null); return; }
    (async () => {
      const [aal, emailOk, admin, factors] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
        supabase.rpc('mfa_verified'),
        supabase.rpc('is_admin'),
        supabase.auth.mfa.listFactors(),
      ]);
      setSecond({
        ok: aal.data?.currentLevel === 'aal2' || emailOk.data === true,
        admin: admin.data === true,
        hasTotp: (factors.data?.totp ?? []).some((f) => f.status === 'verified'),
      });
    })();
  }, [sessionId]);

  if (session === undefined || (session && !second)) return <Center h="100vh"><Loader /></Center>;
  if (!session) return <Frame><SignIn /></Frame>;
  if (!second!.ok) {
    const done = () => setSecond({ ...second!, ok: true });
    const app = second!.hasTotp ? <Verify onDone={done} /> : <Enroll onDone={done} />;
    return <Frame>{second!.admin ? app : <SecondStep email={session.user.email ?? ''} app={app} onDone={done} />}</Frame>;
  }
  return <WithAccess userId={session.user.id}>{children}</WithAccess>;
}

// Not an admin: a code by e-mail, or the authenticator app for whoever prefers it.
function SecondStep({ email, app, onDone }: { email: string; app: ReactNode; onDone: () => void }) {
  const [useApp, setUseApp] = useState(false);
  if (useApp) return <Stack gap="xs">{app}<Button variant="subtle" size="xs" onClick={() => setUseApp(false)}>קבלת קוד במייל במקום</Button></Stack>;
  return <Stack gap="xs"><EmailCode email={email} onDone={onDone} /><Button variant="subtle" size="xs" onClick={() => setUseApp(true)}>יש לי אפליקציית אימות</Button></Stack>;
}

async function emailCode(body: Record<string, unknown>): Promise<string | null> {
  const { error } = await supabase.functions.invoke('email-code', { body });
  if (!error) return null;
  const ctx = (error as { context?: Response }).context;
  return (ctx && typeof ctx.json === 'function' ? (await ctx.json().catch(() => null))?.error : null) ?? error.message;
}

function EmailCode({ email, onDone }: { email: string; onDone: () => void }) {
  const [sent, setSent] = useState<'no' | 'sending' | 'yes'>('no');
  const [wait, setWait] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    setSent('sending'); setError(null);
    const err = await emailCode({ action: 'send' });
    if (err) { setSent('no'); setError(/second|seconds|rate/i.test(err) ? 'נשלח קוד ממש עכשיו. אפשר לבקש שוב בעוד דקה' : `השליחה נכשלה: ${err}`); return; }
    setSent('yes'); setWait(60);
  };
  useEffect(() => { if (wait <= 0) return; const t = setTimeout(() => setWait((w) => w - 1), 1000); return () => clearTimeout(t); }, [wait]);
  return (
    <Stack>
      <Title order={3}>אימות דו-שלבי</Title>
      {sent !== 'yes' ? <>
        <Text size="sm">נשלח קוד בן 6 ספרות אל <b dir="ltr">{email}</b>.</Text>
        {error && <Alert color="red">{error}</Alert>}
        <Button onClick={send} loading={sent === 'sending'}>שליחת קוד למייל</Button>
        <Button variant="subtle" size="xs" onClick={() => supabase.auth.signOut()}>יציאה</Button>
      </> : <>
        <Text size="sm">שלחנו קוד אל <b dir="ltr">{email}</b>. הקוד בתוקף לזמן קצר. אם הוא לא מגיע, כדאי לבדוק בספאם.</Text>
        <CodeForm busy={busy} error={error} onSubmit={async (code) => {
          setBusy(true); setError(null);
          const err = await emailCode({ action: 'verify', code });
          setBusy(false);
          if (err) setError('הקוד שגוי או שפג תוקפו'); else onDone();
        }} />
        <Button variant="subtle" size="xs" disabled={wait > 0} onClick={send}>{wait > 0 ? `שליחה שוב בעוד ${wait} שניות` : 'שליחת קוד חדש'}</Button>
      </>}
    </Stack>
  );
}

function WithAccess({ userId, children }: { userId: string; children: ReactNode }) {
  const access = useAccessQuery(userId);
  if (access.isLoading) return <Center h="100vh"><Loader /></Center>;
  if (access.error) return <Frame><Alert color="red" title="שגיאה">{String(access.error.message)}</Alert></Frame>;
  if (!access.data || access.data.isClient) {
    return (
      <Frame>
        <Stack>
          <Title order={3}>אין הרשאה</Title>
          <Text>המשתמש מחובר, אבל עוד לא הוגדרו לו הרשאות במשרד. פנו למנהל המערכת.</Text>
          <Button variant="default" onClick={() => supabase.auth.signOut()}>יציאה</Button>
        </Stack>
      </Frame>
    );
  }
  if (access.data.mustChangePassword) return <Frame><ChangePassword onDone={() => access.refetch()} /></Frame>;
  return <AccessProvider value={access.data}>{children}</AccessProvider>;
}

// The password an admin gave is replaced before the app opens (SPEC decision 87).
function ChangePassword({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = password.length < 10 ? 'לפחות 10 תווים' : password !== again ? 'שתי הסיסמאות לא זהות' : null;
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (problem) return;
      setBusy(true); setError(null);
      const { error } = await supabase.auth.updateUser({ password });
      if (error) { setError(/same|different/i.test(error.message) ? 'הסיסמה החדשה צריכה להיות שונה מהקודמת' : error.message); setBusy(false); return; }
      const done = await supabase.rpc('password_changed');
      setBusy(false);
      if (done.error) { setError(done.error.message); return; }
      onDone();
    }}>
      <Stack>
        <Title order={3}>בחירת סיסמה חדשה</Title>
        <Text size="sm" c="dimmed">הסיסמה שקיבלת היא זמנית. בוחרים סיסמה אישית, ורק אז המערכת נפתחת.</Text>
        <PasswordInput label="סיסמה חדשה" description="10 תווים לפחות" value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="new-password" required />
        <PasswordInput label="שוב, לאימות" value={again} onChange={(e) => setAgain(e.currentTarget.value)} autoComplete="new-password" required
          error={again && password !== again ? 'שתי הסיסמאות לא זהות' : undefined} />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} disabled={!!problem}>שמירה וכניסה</Button>
        <Button variant="subtle" onClick={() => supabase.auth.signOut()}>יציאה</Button>
      </Stack>
    </form>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <Center mih="100vh" bg="gray.0" p="md">
      <Paper withBorder shadow="sm" radius="md" w={400} maw="100%" style={{ overflow: 'hidden' }}>
        <Image src="/logo-full.jpg" alt="See the Future LTD" />
        <Stack p="xl" gap={0}>
          <Text c="dimmed" size="sm" mb="xs">משרד</Text>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}

function SignIn() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true); setError(null);
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError('המייל או הסיסמה שגויים');
      setBusy(false);
    }}>
      <Stack>
        <Title order={3}>כניסה</Title>
        <TextInput label="מייל" type="email" dir="ltr" required value={email} onChange={(e) => setEmail(e.currentTarget.value)} autoComplete="username" />
        <PasswordInput label="סיסמה" dir="ltr" required value={password} onChange={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" />
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy}>כניסה</Button>
      </Stack>
    </form>
  );
}

function CodeForm({ onSubmit, error, busy }: { onSubmit: (code: string) => void; error: string | null; busy: boolean }) {
  const [code, setCode] = useState('');
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(code); }}>
      <Stack align="center">
        <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} onComplete={onSubmit} dir="ltr" autoFocus />
        {error && <Alert color="red" w="100%">{error}</Alert>}
        <Button type="submit" loading={busy} fullWidth disabled={code.length !== 6}>אישור</Button>
        <Button variant="subtle" size="xs" onClick={() => supabase.auth.signOut()}>יציאה</Button>
      </Stack>
    </form>
  );
}

function Verify({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Stack>
      <Title order={3}>אימות דו-שלבי</Title>
      <Text size="sm">הזינו את הקוד בן 6 הספרות מאפליקציית האימות.</Text>
      <CodeForm busy={busy} error={error} onSubmit={async (code) => {
        setBusy(true); setError(null);
        const { data } = await supabase.auth.mfa.listFactors();
        const factor = data?.totp.find((f) => f.status === 'verified');
        const res = factor && await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
        setBusy(false);
        if (!res || res.error) setError('הקוד שגוי או שפג תוקפו'); else onDone();
      }} />
    </Stack>
  );
}

function Enroll({ onDone }: { onDone: () => void }) {
  const [factor, setFactor] = useState<{ id: string; qr: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      // A half-finished enrolment from an earlier visit blocks a new one with the same name.
      const { data: list } = await supabase.auth.mfa.listFactors();
      for (const f of list?.all ?? []) if (f.status === 'unverified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'office' });
      if (error) setError(error.message);
      else setFactor({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
    })();
  }, []);

  return (
    <Stack>
      <Title order={3}>הגדרת אימות דו-שלבי</Title>
      <Text size="sm">סרקו את הקוד באפליקציית אימות (Google Authenticator, Microsoft Authenticator או 1Password), והזינו את הקוד שמופיע בה.</Text>
      {factor ? <>
        <Center><Image src={factor.qr} w={180} h={180} alt="QR" /></Center>
        <Text size="xs" c="dimmed" ta="center" dir="ltr" style={{ wordBreak: 'break-all' }}>{factor.secret}</Text>
        <CodeForm busy={busy} error={error} onSubmit={async (code) => {
          setBusy(true); setError(null);
          const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
          setBusy(false);
          if (error) setError('הקוד שגוי, נסו שוב'); else onDone();
        }} />
      </> : error ? <Alert color="red">{error}</Alert> : <Center><Loader /></Center>}
    </Stack>
  );
}
