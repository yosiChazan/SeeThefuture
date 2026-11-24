import { Alert, Button, FileInput, Group, Modal, Select, Stack, Table, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileZip } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { unzipSync } from 'fflate';
import { useEffect, useState } from 'react';
import { toE164 } from '../lib/phone';
import { useClients } from '../lib/queries';
import { supabase } from '../lib/supabase';
import { importId, matchExisting, parseWaExport, senders, type Existing, type WaExportMessage } from '../lib/waExport';

// Importing a chat exported from WhatsApp ("ייצוא צ'אט" on the phone: a ZIP with the text and, "with
// media", the pictures) into the inbox (SPEC decision 191, a temporary button). The export names
// people, not numbers, so the client (or the number) is chosen here, and who of the senders is the
// office. Messages from the connection on are skipped: they came in by themselves. Importing the
// same file again adds nothing, nor another export of the same chat (with or without media): a
// message already there is skipped, and a file the earlier export left out is filled in. The ZIP can also be one sent in a chat (exported on the phone and
// shared to the company's number): its message has a button that opens this with the file.

interface Parsed { name: string; text: string; msgs: WaExportMessage[]; files: Record<string, Uint8Array> }

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', opus: 'audio/ogg', ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf' };
const kindOf = (f: string) => { const e = f.split('.').pop()!.toLowerCase(); return /^(jpe?g|png|webp|gif)$/.test(e) ? 'image' : /^(mp4|3gp|mov)$/.test(e) ? 'video' : /^(opus|ogg|mp3|m4a|aac)$/.test(e) ? 'audio' : 'document'; };

export function WaImport({ onClose, from }: { onClose: () => void; from?: { path: string; name: string | null } }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [office, setOffice] = useState<string | null>(null);
  const [clientId, setClientId] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A ZIP sent in a chat: fetched from storage and read as if uploaded.
  useEffect(() => {
    if (!from || !clients.data) return;
    (async () => {
      const { data, error: e } = await supabase.storage.from('whatsapp').download(from.path);
      if (e || !data) { setError(e?.message ?? 'הקובץ לא נמצא'); return; }
      read(new File([data], from.name ?? 'chat.zip'));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from?.path, !!clients.data]);

  async function read(file: File | null) {
    setError(null); setParsed(null);
    if (!file) return;
    try {
      const all = unzipSync(new Uint8Array(await file.arrayBuffer()));
      const txt = Object.keys(all).find((k) => k.toLowerCase().endsWith('.txt'));
      if (!txt) throw new Error('בקובץ אין את קובץ הטקסט של השיחה');
      const text = new TextDecoder().decode(all[txt]);
      const msgs = parseWaExport(text);
      if (!msgs.length) throw new Error('לא נמצאו הודעות בקובץ');
      const files: Record<string, Uint8Array> = {};
      for (const [k, v] of Object.entries(all)) if (k !== txt) files[k.split('/').pop()!] = v;
      // iOS names the text "_chat.txt": the chat's name is then the ZIP's.
      const base = /^_?chat\.txt$/i.test(txt.replace(/^.*\//, '')) ? file.name.replace(/\.zip$/i, '') : txt.replace(/^.*\//, '');
      const name = base.replace(/[\u200e\u200f\u202a-\u202e]/g, '').replace(/\.txt$/i, '').replace(/^(WhatsApp Chat with|צ'אט WhatsApp עם|WhatsApp Chat -)\s*/i, '');
      setParsed({ name, text, msgs, files });
      const ss = senders(msgs);
      setOffice(ss.find((s) => /העתיד|future|STF/i.test(s.name))?.name ?? ss[1]?.name ?? null);
      // The client by the chat's name, if it matches one.
      const match = (clients.data ?? []).find((c) => c.display_name.trim() === name.trim());
      if (match) { setClientId(match.id); setPhone(match.phone ?? ''); }
      else if (toE164(name)) setPhone(name);
    } catch (e) { setError((e as Error).message); }
  }

  const e164 = toE164(phone);
  // Day and month the other way round (an export from a phone in English writes the month first).
  const swap = () => setParsed((p) => {
    if (!p) return p;
    const first = p.msgs[0];
    const asMonth = parseWaExport(p.text, 'month');
    const msgs = asMonth[0] && first && asMonth[0].at.getTime() !== first.at.getTime() ? asMonth : parseWaExport(p.text, 'day');
    return { ...p, msgs };
  });
  const client = clients.data?.find((c) => c.id === clientId);

  async function run() {
    if (!parsed || !e164 || !office) return;
    setBusy(true); setError(null);
    try {
      const { data: acct } = await supabase.from('whatsapp_account').select('connected_at').eq('id', 1).maybeSingle();
      const until = acct?.connected_at ? new Date(acct.connected_at).getTime() : Infinity;
      // The chat of this number: found or opened.
      let { data: conv } = await supabase.from('conversations').select('id, client_party_id, last_message_at').eq('wa_phone', e164).maybeSingle();
      if (!conv) {
        const ins = await supabase.from('conversations').insert({ wa_phone: e164, client_party_id: clientId, contact_name: parsed.name }).select('id, client_party_id, last_message_at').single();
        if (ins.error) throw new Error(ins.error.message);
        conv = ins.data;
      } else if (!conv.client_party_id && clientId) {
        await supabase.from('conversations').update({ client_party_id: clientId }).eq('id', conv.id);
      }
      // What the chat already holds, to match against.
      const had = await supabase.from('messages').select('id, created_at, direction, body, file_name, media_path').eq('conversation_id', conv!.id);
      if (had.error) throw new Error(had.error.message);
      const existing: Existing[] = (had.data ?? []).map((x) => ({ id: x.id, at: new Date(x.created_at).getTime(), direction: x.direction, body: x.body, file: x.file_name, media: !!x.media_path }));
      const rows = [];
      let n = 0, skipped = 0, pics = 0, there = 0, filled = 0;
      for (const m of parsed.msgs) {
        n++;
        if (m.at.getTime() >= until) { skipped++; continue; }
        const direction = m.sender === office ? 'out' : 'in';
        const kind = m.file ? kindOf(m.file) : 'text';
        const match = matchExisting({ at: m.at.getTime(), direction, text: m.text, file: m.file && parsed.files[m.file] ? m.file : null, kind }, existing);
        if (match?.kind === 'skip') { there++; continue; }
        const id = await importId(e164, m, n);
        let media_path: string | null = null;
        if (m.file && parsed.files[m.file]) {
          const ext = m.file.split('.').pop()!.toLowerCase();
          const path = `import/${conv!.id}/${id.slice(7)}.${ext}`;
          const up = await supabase.storage.from('whatsapp').upload(path, parsed.files[m.file], { contentType: MIME[ext] ?? 'application/octet-stream', upsert: true });
          if (!up.error) { media_path = path; pics++; }
        }
        if (match?.kind === 'fill') {
          if (media_path) {
            const u = await supabase.from('messages').update({ kind, file_name: m.file, media_path, body: m.text || null }).eq('id', match.id);
            if (u.error) throw new Error(u.error.message);
            filled++;
          }
          continue;
        }
        rows.push({
          conversation_id: conv!.id, direction, body: m.text || null,
          kind, file_name: m.file, media_path, origin: 'history',
          wa_message_id: id, created_at: m.at.toISOString(), wa_timestamp: m.at.toISOString(),
        });
      }
      for (let i = 0; i < rows.length; i += 300) {
        const r = await supabase.from('messages').upsert(rows.slice(i, i + 300), { onConflict: 'wa_message_id', ignoreDuplicates: true });
        if (r.error) throw new Error(r.error.message);
      }
      const last = rows.reduce((a, r) => (r.created_at > a ? r.created_at : a), '');
      if (last && (!conv!.last_message_at || conv!.last_message_at < last)) await supabase.from('conversations').update({ last_message_at: last }).eq('id', conv!.id);
      notifications.show({ color: 'teal', autoClose: false, message: `יובאו ${rows.length} הודעות${pics ? `, ${pics} קבצים` : ''}${filled ? `. ${filled} קבצים הושלמו בהודעות שכבר היו` : ''}${there ? `. ${there} הודעות כבר היו בשיחה` : ''}${skipped ? `. ${skipped} הודעות מאז החיבור דולגו (הן כבר במערכת)` : ''}.` });
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      await qc.invalidateQueries({ queryKey: ['messages-recent'] });
      onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }

  const ss = parsed ? senders(parsed.msgs) : [];
  const withFiles = parsed?.msgs.filter((m) => m.file).length ?? 0;
  const missing = parsed?.msgs.filter((m) => m.file && !parsed.files[m.file]).length ?? 0;
  return (
    <Modal opened onClose={onClose} title="ייבוא שיחה מוואטסאפ (זמני)" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">בטלפון: פותחים את הצ'אט ← ⋮ ← עוד ← ייצוא צ'אט ← "עם מדיה" (או בלי) ← שומרים את קובץ ה-ZIP ומעלים אותו כאן, שיחה אחת בכל פעם.</Text>
        {!from && <FileInput label="קובץ ה-ZIP" accept=".zip,application/zip" leftSection={<IconFileZip size={16} />} placeholder="בחירת קובץ" onChange={read} clearable />}
        {error && <Alert color="red">{error}</Alert>}
        {parsed && <>
          <Table fz="sm" withRowBorders={false}>
            <Table.Tbody>
              <Table.Tr><Table.Td c="dimmed">שיחה</Table.Td><Table.Td>{parsed.name}</Table.Td></Table.Tr>
              <Table.Tr><Table.Td c="dimmed">הודעות</Table.Td><Table.Td>{parsed.msgs.length} · {parsed.msgs[0].at.toLocaleDateString('he-IL')} עד {parsed.msgs.at(-1)!.at.toLocaleDateString('he-IL')}
                <Button size="compact-xs" variant="subtle" ml="xs" onClick={swap}>התאריכים לא נכונים? החלפת יום וחודש</Button></Table.Td></Table.Tr>
              <Table.Tr><Table.Td c="dimmed">קבצים</Table.Td><Table.Td>{withFiles}{missing ? ` (${missing} לא בקובץ: יוצאו בלי מדיה)` : ''}</Table.Td></Table.Tr>
            </Table.Tbody>
          </Table>
          <Select label="מי מהם המשרד" data={ss.map((s) => ({ value: s.name, label: `${s.name} (${s.count})` }))} value={office} onChange={setOffice} allowDeselect={false} />
          <Select label="הלקוח" searchable clearable placeholder="בחירת לקוח (או מספר למטה)" value={clientId}
            data={(clients.data ?? []).map((c) => ({ value: c.id, label: `${c.display_name}${c.phone ? ` · ${c.phone}` : ''}` }))}
            onChange={(x) => { setClientId(x); const c = clients.data?.find((y) => y.id === x); if (c?.phone) setPhone(c.phone); }} />
          <TextInput label="מספר הוואטסאפ של השיחה" value={phone} onChange={(e) => setPhone(e.currentTarget.value)} placeholder="+972…" dir="ltr"
            error={phone && !e164 ? 'מספר לא תקין' : undefined} description={client && !client.phone ? 'ללקוח אין טלפון בכרטיס: מקלידים את המספר' : undefined} />
        </>}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={run} loading={busy} disabled={!parsed || !e164 || !office}>ייבוא</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
