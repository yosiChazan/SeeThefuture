import { Alert, Button, Group, Text } from '@mantine/core';
import { IconBrandWhatsapp } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';

// The reminder to open the WhatsApp Business app (SPEC decision 188): Meta disconnects the number
// from the system after about 14 days without the app. Shown on every page once 10 days passed
// since the last message sent from the app or WhatsApp Web, or since "פתחתי את האפליקציה".
const DAYS = 10, LIMIT = 14;

export function WhatsAppHeartbeat() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['wa-heartbeat'], refetchInterval: 30 * 60_000, staleTime: 10 * 60_000,
    queryFn: async () => {
      const { data: acct } = await supabase.from('whatsapp_account').select('connected_at, app_checked_at').eq('id', 1).maybeSingle();
      if (!acct?.connected_at) return null;
      const { data: last } = await supabase.from('messages').select('created_at').eq('origin', 'app').order('created_at', { ascending: false }).limit(1).maybeSingle();
      const times = [acct.connected_at, acct.app_checked_at, last?.created_at].filter(Boolean).map((t) => new Date(t as string).getTime());
      return Math.floor((Date.now() - Math.max(...times)) / 86_400_000);
    },
  });
  const days = q.data;
  if (days == null || days < DAYS) return null;
  const left = Math.max(0, LIMIT - days);
  async function checked() {
    await supabase.rpc('wa_app_checked');
    await qc.invalidateQueries({ queryKey: ['wa-heartbeat'] });
  }
  return (
    <Alert color={left <= 2 ? 'red' : 'orange'} icon={<IconBrandWhatsapp size={18} />} mb="md" title="תזכורת: לפתוח את WhatsApp Business בטלפון של החברה">
      <Group justify="space-between" wrap="wrap" gap="xs">
        <Text size="sm">עברו {days} ימים בלי שימוש באפליקציה בטלפון. {left > 0 ? `בעוד כ-${left} ימים` : 'בכל רגע'} Meta עלולה לנתק את הוואטסאפ מהמערכת. מספיק לפתוח את האפליקציה בטלפון (או לשלוח ממנה הודעה).</Text>
        <Group gap="xs">
          <Button size="xs" color="green" component="a" href="https://web.whatsapp.com/" target="_blank" rel="noopener noreferrer" leftSection={<IconBrandWhatsapp size={14} />}>פתיחת WhatsApp Web</Button>
          <Button size="xs" variant="white" color="dark" onClick={checked}>פתחתי את האפליקציה</Button>
        </Group>
      </Group>
    </Alert>
  );
}
