import { Alert, Badge, Button, Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconBrandWhatsapp } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useAccess } from '../lib/access';
import { must, supabase } from '../lib/supabase';

// Connecting the company's WhatsApp number (SPEC decision 180): Meta's signup window (Embedded
// Signup, with "connect your WhatsApp Business app") opens from here; when it closes, the
// function whatsapp-connect takes the code, subscribes the webhooks and asks for the contacts and
// the last 6 months of chats. The app's id and the signup configuration's id are public values,
// set as VITE_META_APP_ID and VITE_META_CONFIG_ID on Cloudflare Pages. Without them the number is
// connected through Dualhook (decision 182), on its site, and shows here once its first webhook arrives.

const APP_ID = import.meta.env.VITE_META_APP_ID as string | undefined;
const CONFIG_ID = import.meta.env.VITE_META_CONFIG_ID as string | undefined;
const SDK_VERSION = 'v27.0';

interface Account { waba_id: string | null; phone_number_id: string | null; display_phone: string | null; connected_at: string | null; contacts_sync_at: string | null; history_sync_at: string | null; last_webhook_at: string | null; last_error: string | null }

declare global {
  interface Window {
    FB?: { init: (o: object) => void; login: (cb: (r: { authResponse?: { code?: string } }) => void, o: object) => void };
    fbAsyncInit?: () => void;
  }
}

// Meta's JavaScript SDK, loaded only when connecting.
function loadSdk(): Promise<void> {
  if (window.FB) return Promise.resolve();
  return new Promise((ok, fail) => {
    window.fbAsyncInit = () => { window.FB!.init({ appId: APP_ID, autoLogAppEvents: true, xfbml: false, version: SDK_VERSION }); ok(); };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true; s.defer = true; s.crossOrigin = 'anonymous';
    s.onerror = () => fail(new Error('לא ניתן לטעון את חלון ההרשמה של Meta'));
    document.body.appendChild(s);
  });
}

const when = (s: string | null) => (s ? new Date(s).toLocaleString('he-IL') : '—');

export function WhatsAppSettings() {
  const access = useAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['whatsapp-account'], queryFn: async () => (must(await supabase.from('whatsapp_account').select('*').eq('id', 1).maybeSingle()) as Account | null), refetchInterval: 30_000 });
  const [busy, setBusy] = useState(false);
  const a = q.data;
  const connected = !!a?.phone_number_id && !!a.connected_at;

  async function connect() {
    setBusy(true);
    try {
      await loadSdk();
      // The window's own message: the account's ids (and, for the app's number, a special event).
      let ids: { waba_id?: string; phone_number_id?: string } = {};
      const listen = (e: MessageEvent) => {
        if (!String(e.origin).endsWith('facebook.com')) return;
        try {
          const d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
          if (d?.type === 'WA_EMBEDDED_SIGNUP' && String(d.event).startsWith('FINISH')) ids = { ...ids, ...d.data };
          if (d?.type === 'WA_EMBEDDED_SIGNUP' && (d.event === 'CANCEL' || d.event === 'ERROR')) notifications.show({ color: 'orange', message: `ההרשמה לא הושלמה${d.data?.current_step ? ` (בשלב ${d.data.current_step})` : ''}` });
        } catch { /* not ours */ }
      };
      window.addEventListener('message', listen);
      const code = await new Promise<string | null>((ok) => window.FB!.login((r) => ok(r.authResponse?.code ?? null), {
        config_id: CONFIG_ID, response_type: 'code', override_default_response_type: true,
        extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
      }));
      // The ids arrive as a message, a moment around the callback.
      for (let i = 0; i < 20 && !ids.waba_id; i++) await new Promise((r) => setTimeout(r, 250));
      window.removeEventListener('message', listen);
      if (!code) { notifications.show({ color: 'orange', message: 'החלון נסגר בלי חיבור' }); return; }
      if (!ids.waba_id) throw new Error('Meta לא החזירה את מספר החשבון (waba_id). כדאי לנסות שוב');
      const { data, error } = await supabase.functions.invoke('whatsapp-connect', { body: { code, ...ids } });
      if (error) {
        let msg = error.message;
        try { msg = (await (error as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
        throw new Error(msg);
      }
      notifications.show({ color: 'teal', autoClose: false, message: `הוואטסאפ חובר (${data.number?.display_phone_number ?? ''}). הסנכרון של אנשי הקשר וההיסטוריה התחיל: להשאיר את האפליקציה בטלפון פתוחה עד שיופיע כאן "ההיסטוריה התקבלה".` });
    } catch (e) {
      notifications.show({ color: 'red', autoClose: false, message: (e as Error).message });
    } finally {
      setBusy(false);
      await qc.invalidateQueries({ queryKey: ['whatsapp-account'] });
    }
  }

  const ask = () => modals.openConfirmModal({
    title: 'חיבור הוואטסאפ של החברה',
    children: (
      <Stack gap="xs">
        <Text size="sm">לפני שממשיכים:</Text>
        <List size="sm" spacing={4}>
          <List.Item>הטלפון של החברה ליד, עם WhatsApp Business בגרסה 2.24.17 ומעלה, פתוח ומחובר לאינטרנט.</List.Item>
          <List.Item>בחלון של Meta בוחרים לחבר את חשבון ה-WhatsApp Business הקיים, ומקלידים את המספר.</List.Item>
          <List.Item>בטלפון: "Connect to the Business Platform", מאשרים שיתוף היסטוריה, ומדביקים את הקוד.</List.Item>
          <List.Item>אחרי החיבור יש 24 שעות לסנכרן את ההיסטוריה. המערכת מתחילה לבד; לא סוגרים את האפליקציה בטלפון.</List.Item>
        </List>
      </Stack>
    ),
    labels: { confirm: 'פתיחת החלון של Meta', cancel: 'לא עכשיו' },
    onConfirm: connect,
  });

  return (
    <Paper withBorder p="md">
      <Group justify="space-between" mb="xs">
        <Group gap="xs"><IconBrandWhatsapp size={22} color="#25d366" /><Title order={4}>וואטסאפ</Title></Group>
        {connected ? <Badge color="teal">מחובר · {a!.display_phone}</Badge> : <Badge color="gray">לא מחובר</Badge>}
      </Group>
      {connected ? (
        <Stack gap={4}>
          <Text size="sm">חובר: {when(a!.connected_at)}</Text>
          <Text size="sm">אנשי קשר התקבלו: {when(a!.contacts_sync_at)} · ההיסטוריה התקבלה: {when(a!.history_sync_at)}</Text>
          <Text size="sm" c="dimmed">הודעה אחרונה מ-Meta: {when(a!.last_webhook_at)}</Text>
          {a!.last_error && <Alert color="orange" mt="xs" title="שגיאה אחרונה">{a!.last_error}</Alert>}
        </Stack>
      ) : (
        <Stack gap="xs">
          <Text size="sm" c="dimmed">מחבר את המספר של החברה למערכת, כשהאפליקציה בטלפון ממשיכה לעבוד: הודעות של לקוחות, וגם מה שעונים מהטלפון, יופיעו בדף ההודעות.</Text>
          {a?.last_error && <Alert color="red" title="הניסיון האחרון נכשל">{a.last_error}</Alert>}
          {!APP_ID || !CONFIG_ID
            ? <Alert color="blue" title="חיבור דרך Dualhook">המספר מתחבר באתר של Dualhook (Connect WhatsApp), עם כתובת ה-webhook של המערכת. המערכת מזהה את החיבור לבד עם ההודעה הראשונה שמגיעה, ואז יופיע כאן "מחובר".</Alert>
            : access.isAdmin && <Button w="fit-content" color="green" leftSection={<IconBrandWhatsapp size={18} />} loading={busy} onClick={ask}>חיבור וואטסאפ</Button>}
        </Stack>
      )}
    </Paper>
  );
}
