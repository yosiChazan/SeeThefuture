import { Alert, Badge, Button, Group, Paper, Stack, Text, TextInput, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconBrandDropbox } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { QueryState } from '../components/common';
import { useAccess } from '../lib/access';
import { listSharedFiles, loadDropbox, saveSettings, startConnect } from '../lib/dropbox';

// Admin settings. For now: the connection to Itai's Dropbox folder (SPEC decision 53).
export function Settings() {
  const access = useAccess();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['dropbox'], queryFn: loadDropbox, enabled: access.isAdmin });
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { setLink(q.data?.settings.shared_link ?? ''); }, [q.data]);

  if (!access.isAdmin) return <Alert color="gray">ההגדרות פתוחות למנהל מערכת בלבד.</Alert>;

  async function save() {
    setBusy(true);
    try {
      await saveSettings({ ...(q.data?.settings ?? {}), shared_link: link.trim() });
      notifications.show({ color: 'teal', message: 'הקישור נשמר' });
      await qc.invalidateQueries({ queryKey: ['dropbox'] });
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); }
    setBusy(false);
  }

  async function check() {
    setBusy(true);
    try {
      const files = await listSharedFiles(q.data!);
      notifications.show({ color: 'teal', message: `החיבור עובד: ${files.length} קבצים בתיקייה` });
    } catch (e) { notifications.show({ color: 'red', title: 'החיבור לא עובד', message: (e as Error).message }); }
    setBusy(false);
  }

  return (
    <Stack>
      <Title order={2}>הגדרות</Title>
      <QueryState q={q}>{(d) => (
        <Paper withBorder p="md">
          <Group justify="space-between" mb="sm">
            <Group gap="xs"><IconBrandDropbox size={22} /><Title order={4}>הדרופבוקס של איתי</Title></Group>
            {d?.refresh_token ? <Badge color="teal" variant="light">מחובר מ-{dayjs(d.connected_at).format('DD.MM.YYYY')}</Badge> : <Badge color="gray" variant="light">לא מחובר</Badge>}
          </Group>
          <Stack>
            <Text size="sm">1. חיבור: הרשאת קריאה בלבד לדרופבוקס שלכם. אחרי הלחיצה תעברו לדרופבוקס, תאשרו, ותחזרו לכאן.</Text>
            <Group><Button leftSection={<IconBrandDropbox size={16} />} onClick={() => startConnect()} variant={d?.refresh_token ? 'default' : 'filled'}>
              {d?.refresh_token ? 'חיבור מחדש' : 'חיבור לדרופבוקס'}</Button></Group>
            <Text size="sm">2. הקישור לתיקייה של איתי (Yom-Tov_shared), כמו שהוא מופיע בשורת הכתובת. הקישור הוא כמו סיסמה: הוא נשמר כאן, ורק מנהל מערכת רואה אותו.</Text>
            <TextInput dir="ltr" placeholder="https://www.dropbox.com/scl/fo/…" value={link} onChange={(e) => setLink(e.currentTarget.value)} />
            <Group>
              <Button onClick={save} loading={busy} disabled={!/^https:\/\/(www\.)?dropbox\.com\//.test(link.trim())}>שמירת הקישור</Button>
              <Button variant="default" onClick={check} loading={busy} disabled={!d?.refresh_token || !d?.settings.shared_link}>בדיקת חיבור</Button>
            </Group>
          </Stack>
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
