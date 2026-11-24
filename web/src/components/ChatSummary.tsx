import { ActionIcon, Anchor, Badge, Group, Loader, Paper, Text, Tooltip } from '@mantine/core';
import { IconRefresh, IconSparkles } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// Where a WhatsApp chat stands, summarized by AI (SPEC decision 186): what the client wants, what
// was done, what is open and whose turn it is. Written again when the chat is shown after new
// messages, only when the page asks for it (auto: the inbox after an hour away), or on request
// (the refresh button). The client's card never writes it by itself.

export interface SummaryChat {
  id: string; last_message_at: string | null;
  ai_summary?: string | null; ai_summary_at?: string | null; ai_waiting_on?: 'us' | 'client' | 'none' | null;
}

const WAITING = { us: { label: 'ממתין לנו', color: 'orange' }, client: { label: 'ממתין ללקוח', color: 'blue' }, none: { label: 'אין משהו פתוח', color: 'gray' } } as const;

export function ChatSummary({ chat, link = false, auto = false }: { chat: SummaryChat; link?: boolean; auto?: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const stale = !!chat.last_message_at && (!chat.ai_summary_at || chat.ai_summary_at < chat.last_message_at);

  async function refresh() {
    setBusy(true); setError(null);
    const { error: e } = await supabase.functions.invoke('whatsapp-ai', { body: { action: 'summary', conversation_id: chat.id } });
    if (e) {
      let msg = e.message;
      try { msg = (await (e as { context?: Response }).context?.json())?.error ?? msg; } catch { /* keep */ }
      setError(msg);
    }
    await qc.invalidateQueries({ queryKey: ['conversations'] });
    await qc.invalidateQueries({ queryKey: ['client-chats'] });
    setBusy(false);
  }
  // New messages since the last summary: summarize again, once per chat and change.
  useEffect(() => {
    const key = `${chat.id}:${chat.last_message_at}`;
    if (auto && stale && asked.current !== key) { asked.current = key; refresh(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, chat.last_message_at, stale, auto]);

  if (!chat.last_message_at) return null;
  const w = chat.ai_waiting_on ? WAITING[chat.ai_waiting_on] : null;
  return (
    <Paper px="sm" py={6} radius={0} style={{ background: '#f8f9fa', borderBottom: '1px solid #e9ecef' }}>
      <Group gap={6} wrap="nowrap" align="flex-start">
        <IconSparkles size={16} color="#7048e8" style={{ flexShrink: 0, marginTop: 3 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} mb={2}>
            <Text size="xs" fw={600} c="#5f3dc4">סיכום AI של ההתכתבות</Text>
            {w && <Badge size="xs" variant="light" color={w.color}>{w.label}</Badge>}
            {chat.ai_summary_at && <Text size="xs" c="dimmed">{new Date(chat.ai_summary_at).toLocaleString('he-IL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</Text>}
            {link && <Anchor component={Link} to={`/messages?c=${chat.id}`} size="xs">לשיחה</Anchor>}
          </Group>
          {busy && !chat.ai_summary ? <Group gap={6}><Loader size="xs" /><Text size="sm" c="dimmed">מסכם…</Text></Group>
            : error ? <Text size="sm" c="red">{error}</Text>
            : <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{chat.ai_summary ?? 'עוד אין סיכום (↻ לסיכום)'}{chat.ai_summary && stale ? ' · יש הודעות חדשות מאז הסיכום' : ''}</Text>}
        </div>
        <Tooltip label="סיכום מחדש"><ActionIcon size="sm" variant="subtle" color="violet" loading={busy} onClick={refresh} aria-label="סיכום מחדש"><IconRefresh size={14} /></ActionIcon></Tooltip>
      </Group>
    </Paper>
  );
}
