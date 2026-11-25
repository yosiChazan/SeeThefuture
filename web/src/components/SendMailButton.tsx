import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconSend } from '@tabler/icons-react';
import { useState } from 'react';
import { supabase } from '../lib/supabase';

// Sends a ready-made mail from the system's address (the send-mail function), on a press
// only. Replies go to the sender. Pressed once, it says "sent" and stays off, so a second
// press does not send the same mail twice.
export function SendMailButton({ to, subject, text, html, size = 'sm' }: { to: string; subject: string; text: string; html?: string; size?: 'xs' | 'sm' }) {
  const [state, setState] = useState<'idle' | 'busy' | 'sent'>('idle');
  async function send() {
    setState('busy');
    const { data, error } = await supabase.functions.invoke('send-mail', { body: { to, subject, text, html } });
    if (error || !data?.ok) {
      setState('idle');
      let msg = error?.message ?? 'השליחה נכשלה';
      try { const j = await (error as { context?: Response })?.context?.json(); if (j?.error) msg = j.error; } catch { /* keep msg */ }
      if (/not set up/.test(msg)) msg = 'שליחת מיילים עוד לא הוגדרה בשרת';
      else if (/unknown address/.test(msg)) msg = `הכתובת ${to} לא שמורה במערכת`;
      notifications.show({ color: 'red', title: 'המייל לא נשלח', message: msg });
      return;
    }
    setState('sent');
    notifications.show({ color: 'teal', message: `המייל נשלח אל ${to}` });
  }
  return (
    <Button size={size} leftSection={<IconSend size={16} />} onClick={send} loading={state === 'busy'} disabled={state === 'sent'} color={state === 'sent' ? 'teal' : undefined}>
      {state === 'sent' ? 'נשלח ✓' : 'שליחת מייל'}
    </Button>
  );
}
