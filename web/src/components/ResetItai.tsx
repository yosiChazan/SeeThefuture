import { Alert, Badge, Button, Group, List, Modal, Paper, Stack, Text, Textarea, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconRefreshAlert } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { loadDropbox, saveSettings } from '../lib/dropbox';
import { must, supabase } from '../lib/supabase';

// Resetting Itai's imported reports (SPEC decision 58). Three locks, all checked
// again by app.reset_itai_imports in the database:
//   1. a written reason (kept in the audit log),
//   2. a one-time code sent to the admin's email, entered in the last 15 minutes,
//   3. the admin's TOTP code (signing in with the email code starts a new session,
//      so the app asks for the authenticator code again).
// Only Itai's reports and what they posted are removed; nothing else.

const REASON_KEY = 'reset-itai-reason';
const WINDOW = 15 * 60;
const WORD = 'איפוס';

type Amr = { method: string; timestamp: number };

// Seconds left on a fresh email code in the current session, or 0.
async function otpSecondsLeft(): Promise<number> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return 0;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const otp = (payload.amr as Amr[] ?? []).filter((a) => ['otp', 'magiclink', 'email/otp'].includes(a.method));
    const newest = Math.max(0, ...otp.map((a) => a.timestamp));
    return Math.max(0, newest + WINDOW - Math.floor(Date.now() / 1000));
  } catch { return 0; }
}

export function ResetItai() {
  const qc = useQueryClient();
  const [reason, setReason] = useState(() => sessionStorage.getItem(REASON_KEY) ?? '');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [left, setLeft] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { sessionStorage.setItem(REASON_KEY, reason); }, [reason]);
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? ''));
    const tick = () => otpSecondsLeft().then(setLeft);
    tick();
    const t = setInterval(tick, 5000);
    return () => clearInterval(t);
  }, []);

  const reasonOk = reason.trim().length >= 10;
  const fail = (e: unknown) => notifications.show({ color: 'red', message: (e as Error).message });

  async function sendCode() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    setBusy(false);
    if (error) return fail(new Error(/rate|seconds/i.test(error.message) ? 'נשלחו יותר מדי מיילים. נסו שוב בעוד כמה דקות' : error.message));
    setSent(true);
    notifications.show({ color: 'teal', message: `נשלח קוד אל ${email}` });
  }

  async function verifyCode() {
    setBusy(true);
    // A new session: the app now asks for the authenticator code, then comes back here.
    const { error } = await supabase.auth.verifyOtp({ email, token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) fail(new Error('הקוד מהמייל שגוי או שפג תוקפו'));
  }

  async function reset() {
    setBusy(true);
    try {
      // The files of Itai's reports, before their rows are gone.
      const batches = must(await supabase.from('import_batches')
        .select('file_path, notes, source:import_sources!inner(adapter)').eq('source.adapter', 'itai_client_xlsx')) as
        { file_path: string | null; notes: { file_name?: string } | null }[];
      const res = must(await supabase.rpc('reset_itai_imports', { p_reason: reason.trim() })) as
        { batches: number; rows: number; transactions: number; accounts: number };
      const paths = batches.map((b) => b.file_path).filter((p): p is string => !!p);
      if (paths.length) await supabase.storage.from('imports').remove(paths);
      // The next Dropbox pull offers every file again.
      try {
        const d = await loadDropbox();
        if (d) await saveSettings({ ...d.settings, files: {} });
      } catch { /* not connected to Dropbox */ }
      sessionStorage.removeItem(REASON_KEY);
      setReason(''); setConfirm(false); setTyped(''); setSent(false); setCode('');
      notifications.show({ color: 'teal', autoClose: false, title: 'דוחות איתי אופסו',
        message: `נמחקו ${res.batches} דוחות, ${res.transactions} תנועות ו-${res.accounts} חשבונות ריקים. אפשר למשוך מחדש מהדרופבוקס.` });
      await qc.invalidateQueries();
    } catch (e) { fail(e); }
    setBusy(false);
  }

  return (
    <Paper withBorder p="md" style={{ borderColor: 'var(--mantine-color-red-4)' }}>
      <Group gap="xs" mb="sm"><IconRefreshAlert size={22} color="var(--mantine-color-red-7)" /><Title order={4}>איפוס הדוחות של איתי</Title></Group>
      <Stack>
        <Text size="sm">מוחק את כל הדוחות של איתי שנקלטו (גם שאושרו), ואת כל התנועות שהם רשמו, כדי לקלוט אותם מחדש מאפס.</Text>
        <List size="sm" spacing={2}>
          <List.Item>לא נוגע בשום דבר אחר: חוזי שכירות, נכסים, לקוחות, דוחות של ויטאלי וגרשון, ותנועות שנרשמו ידנית נשארים.</List.Item>
          <List.Item>אי אפשר לבטל את האיפוס. הסיבה, השעה והמשתמש נשמרים ביומן.</List.Item>
          <List.Item>צריך: סיבה, קוד שנשלח למייל, וקוד מאפליקציית האימות.</List.Item>
        </List>

        <Textarea label="1. למה מאפסים?" description="לפחות 10 תווים" autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />

        {left > 0 ? (
          <Group><Badge color="teal" variant="light">2. הקוד מהמייל אומת</Badge><Text size="xs" c="dimmed">תקף עוד {Math.ceil(left / 60)} דקות</Text></Group>
        ) : (
          <Stack gap="xs">
            <Text size="sm" fw={500}>2. קוד במייל</Text>
            <Group>
              <Button variant="default" onClick={sendCode} loading={busy} disabled={!reasonOk || !email}>{sent ? 'שליחה חוזרת' : 'שליחת קוד'} אל {email}</Button>
            </Group>
            {sent && (
              <Group align="flex-end">
                <TextInput label="הקוד מהמייל" dir="ltr" w={180} value={code} onChange={(e) => setCode(e.currentTarget.value)} autoComplete="one-time-code" />
                <Button onClick={verifyCode} loading={busy} disabled={code.trim().length < 6}>אימות</Button>
              </Group>
            )}
            {sent && <Text size="xs" c="dimmed">אחרי האימות האפליקציה תבקש את הקוד מאפליקציית האימות, ותחזיר אתכם לכאן.</Text>}
          </Stack>
        )}

        <Group><Button color="red" disabled={!reasonOk || left <= 0} onClick={() => setConfirm(true)}>3. איפוס הדוחות של איתי</Button></Group>
      </Stack>

      <Modal opened={confirm} onClose={() => setConfirm(false)} title="אישור אחרון">
        <Stack>
          <Alert color="red">כל הדוחות של איתי והתנועות שלהם יימחקו. אי אפשר לבטל.</Alert>
          <Text size="sm">הסיבה: {reason.trim()}</Text>
          <TextInput label={`הקלידו "${WORD}" לאישור`} value={typed} onChange={(e) => setTyped(e.currentTarget.value)} />
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirm(false)}>ביטול</Button>
            <Button color="red" loading={busy} disabled={typed.trim() !== WORD} onClick={reset}>איפוס</Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
}
