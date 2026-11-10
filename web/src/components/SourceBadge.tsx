import { Anchor, Badge, Button, FileInput, Group, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconUpload } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { sourceInfo } from '../lib/source';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';

const COLOR = { report: 'blue', airtable: 'orange', excel: 'green', manual: 'gray', unknown: 'red' } as const;

interface SourceFile { source: string; country_code: Country; storage_path: string; file_name: string | null }
// The spreadsheets transactions came from (decision 137), loaded once for every row.
function useSourceFiles() {
  return useQuery({ queryKey: ['source-files'], staleTime: 5 * 60 * 1000,
    queryFn: async () => new Map((must(await supabase.from('source_files').select('source, country_code, storage_path, file_name')) as SourceFile[]).map((f) => [f.source, f])) });
}

// Uploading the spreadsheet once; every transaction from it then links to it.
function UploadSource({ source, country, onClose }: { source: string; country: Country; onClose: () => void }) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    if (!file) return;
    setBusy(true);
    const path = `${country}/sources/${crypto.randomUUID()}_${file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_').slice(-100)}`;
    const up = await supabase.storage.from('imports').upload(path, file, { contentType: file.type || undefined });
    const row = up.error ? up : await supabase.from('source_files').upsert({ source, country_code: country, storage_path: path, file_name: file.name });
    setBusy(false);
    if (row.error) { notifications.show({ color: 'red', message: row.error.message }); return; }
    notifications.show({ color: 'teal', message: 'הקובץ הועלה, וכל התנועות ממנו מקושרות אליו' });
    await qc.invalidateQueries({ queryKey: ['source-files'] });
    onClose();
  }
  return (
    <Modal opened onClose={onClose} title="העלאת קובץ המקור">
      <Stack>
        <Text size="sm">{source.slice(6)}</Text>
        <FileInput label="הקובץ" placeholder="בחירת קובץ" leftSection={<IconUpload size={16} />} value={file} onChange={setFile} />
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!file}>העלאה</Button></Group>
      </Stack>
    </Modal>
  );
}

// A small mark on a ledger row: where the transaction came from (SPEC decisions 136, 137). Every
// source but "by hand" is a link: a report opens at intake, a row in Airtable opens there, a
// spreadsheet opens the file (once uploaded; finance uploads it from here).
export function SourceBadge({ source, importBatchId, country }: { source?: string | null; importBatchId?: string | null; country?: string | null }) {
  const s = sourceInfo(source, importBatchId);
  const files = useSourceFiles();
  const access = useAccess();
  const [uploading, setUploading] = useState(false);
  const badge = (clickable: boolean) => <Badge size="xs" variant="light" color={COLOR[s.kind]} style={clickable ? { cursor: 'pointer' } : undefined}>{s.label}</Badge>;
  if (s.kind === 'excel') {
    const f = files.data?.get(source!);
    const canUpload = !!country && access.canApprove(country as Country);
    const open = async () => {
      if (!f) { if (canUpload) setUploading(true); return; }
      const { data, error } = await supabase.storage.from('imports').createSignedUrl(f.storage_path, 600, { download: f.file_name ?? undefined });
      if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
    };
    return (
      <>
        <Tooltip label={f ? `${s.detail} · לחיצה פותחת את הקובץ` : canUpload ? `${s.detail} · הקובץ עוד לא הועלה: לחיצה להעלאה` : `${s.detail} · הקובץ עוד לא הועלה`} withinPortal>
          <span onClick={open}>{badge(!!f || canUpload)}</span>
        </Tooltip>
        {uploading && <UploadSource source={source!} country={country as Country} onClose={() => setUploading(false)} />}
      </>
    );
  }
  const inner = !s.href ? badge(false) : s.href.startsWith('/')
    ? <Anchor component={Link} to={s.href} underline="never">{badge(true)}</Anchor>
    : <Anchor href={s.href} target="_blank" rel="noopener noreferrer" underline="never">{badge(true)}</Anchor>;
  return <Tooltip label={s.detail ?? s.label} withinPortal>{inner}</Tooltip>;
}
