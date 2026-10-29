import { Alert, Button, Center, Image, Loader, Paper, PasswordInput, PinInput, Stack, Text, TextInput, Title } from '@mantine/core';
import type { Session } from '@supabase/supabase-js';
import { useEffect, useState, type ReactNode } from 'react';
import { AccessProvider, useAccessQuery } from '../lib/access';
import { supabase } from '../lib/supabase';

type Aal = { current: string | null; next: string | null };

// Staff sign in with email and password, then a TOTP code (SPEC §3: 2FA for staff).
// A user without a profile row has no access, whatever they signed up with.
export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [aal, setAal] = useState<Aal | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setAal(null); return; }
    supabase.auth.mfa.getAuthenticatorAssuranceLevel().then(({ data }) =>
      setAal({ current: data?.currentLevel ?? null, next: data?.nextLevel ?? null }));
  }, [session]);

  if (session === undefined || (session && !aal)) return <Center h="100vh"><Loader /></Center>;
  if (!session) return <Frame><SignIn /></Frame>;
  if (aal!.current !== 'aal2') {
    return <Frame>{aal!.next === 'aal2' ? <Verify onDone={() => setAal({ current: 'aal2', next: 'aal2' })} />
      : <Enroll onDone={() => setAal({ current: 'aal2', next: 'aal2' })} />}</Frame>;
  }
  return <WithAccess userId={session.user.id}>{children}</WithAccess>;
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
  return <AccessProvider value={access.data}>{children}</AccessProvider>;
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <Center mih="100vh" bg="gray.0" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={400} maw="100%">
        <Text c="dimmed" size="sm" mb="xs">See the Future · משרד</Text>
        {children}
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
