import { Alert, Anchor, Badge, Button, Checkbox, Group, Loader, Modal, Stack, Table, Text } from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { downloadShared, listSharedFiles, loadDropbox, saveSettings, type DropboxFile, type Integration } from '../lib/dropbox';
import { createBatch, readReport, type Source } from '../lib/intake';

type Result = { batchId?: string; error?: string };

// Lists the client files in Itai's folder, marks what changed since the last pull,
// and turns each chosen file into a report for review, exactly like an upload.
export function DropboxPull({ source, onClose }: { source: Source; onClose: () => void }) {
  const qc = useQueryClient();
  const [integration, setIntegration] = useState<Integration | null>(null);
  const [files, setFiles] = useState<DropboxFile[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, Result>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const i = await loadDropbox();
        if (!i?.refresh_token || !i.settings.shared_link) throw new Error('צריך קודם לחבר את Dropbox ולשמור את הקישור לתיקייה, במסך ההגדרות');
        // Client files only: the central 1-Incomes.xlsx is out of date (SPEC decision 44).
        const all = (await listSharedFiles(i)).filter((f) => /\.xlsx$/i.test(f.name) && !/^1-incomes/i.test(f.name));
        all.sort((a, b) => b.server_modified.localeCompare(a.server_modified));
        setIntegration(i); setFiles(all);
        setChosen(new Set(all.filter((f) => i.settings.files?.[f.name] !== f.content_hash).map((f) => f.name)));
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  async function pull() {
    let settings = { ...integration!.settings, files: { ...(integration!.settings.files ?? {}) } };
    for (const f of files!.filter((x) => chosen.has(x.name))) {
      setBusy(f.name);
      try {
        const file = await downloadShared(integration!, f.name);
        const batchId = await createBatch(source, file, await readReport(source, file));
        settings = { ...settings, files: { ...settings.files, [f.name]: f.content_hash } };
        await saveSettings(settings);   // a file is marked pulled only once its report exists
        setResults((r) => ({ ...r, [f.name]: { batchId } }));
      } catch (e) { setResults((r) => ({ ...r, [f.name]: { error: (e as Error).message } })); }
    }
    setBusy(null);
    setIntegration((i) => ({ ...i!, settings }));
    await qc.invalidateQueries({ queryKey: ['import-batches'] });
  }

  const state = (f: DropboxFile) => {
    const seen = integration?.settings.files?.[f.name];
    return !seen ? { label: 'חדש', color: 'blue' } : seen !== f.content_hash ? { label: 'השתנה', color: 'orange' } : { label: 'ללא שינוי', color: 'gray' };
  };

  return (
    <Modal opened onClose={onClose} title="משיכה מהדרופבוקס של איתי" size="xl">
      {error ? <Alert color="red">{error}{/הגדרות/.test(error) && <> <Anchor component={Link} to="/settings">למסך ההגדרות</Anchor></>}</Alert>
        : !files ? <Group><Loader size="sm" /><Text size="sm">קורא את רשימת הקבצים…</Text></Group> : (
          <Stack>
            <Text size="sm">מסומנים הקבצים החדשים ואלה שהשתנו מאז המשיכה הקודמת. כל קובץ נפתח כדוח לבדיקה, כמו העלאה ידנית.</Text>
            <Table.ScrollContainer minWidth={600}>
              <Table verticalSpacing={6}>
                <Table.Thead><Table.Tr><Table.Th w={40} /><Table.Th>קובץ</Table.Th><Table.Th>עודכן</Table.Th><Table.Th>מצב</Table.Th><Table.Th>תוצאה</Table.Th></Table.Tr></Table.Thead>
                <Table.Tbody>
                  {files.map((f) => {
                    const r = results[f.name];
                    return (
                      <Table.Tr key={f.name}>
                        <Table.Td><Checkbox checked={chosen.has(f.name)} disabled={!!busy} aria-label={f.name}
                          onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.currentTarget.checked) n.add(f.name); else n.delete(f.name); return n; })} /></Table.Td>
                        <Table.Td dir="ltr" style={{ textAlign: 'right' }}><Text size="sm">{f.name}</Text></Table.Td>
                        <Table.Td>{dayjs(f.server_modified).format('DD.MM.YYYY')}</Table.Td>
                        <Table.Td><Badge variant="light" color={state(f).color}>{state(f).label}</Badge></Table.Td>
                        <Table.Td>
                          {busy === f.name ? <Loader size="xs" />
                            : r?.batchId ? <Anchor component={Link} to={`/intake/${r.batchId}`} size="sm" onClick={onClose}>לדוח</Anchor>
                            : r?.error ? <Text size="xs" c="red">{r.error}</Text> : null}
                        </Table.Td>
                      </Table.Tr>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>סגירה</Button>
              <Button onClick={pull} loading={!!busy} disabled={!chosen.size}>קליטת {chosen.size} קבצים</Button>
            </Group>
          </Stack>
        )}
    </Modal>
  );
}
