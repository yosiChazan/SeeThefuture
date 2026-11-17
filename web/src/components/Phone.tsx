import { ActionIcon, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconBrandWhatsapp } from '@tabler/icons-react';
import { toE164 } from '../lib/phone';

// A phone number with a button that opens a WhatsApp chat with it (SPEC decision 135): in
// the WhatsApp Business app on the phone or in WhatsApp Web on the computer, from the
// company's number. Until WhatsApp is connected to the system, this is how to write to a client.
export function waLink(phone: string | null | undefined): string | null {
  const e = phone ? toE164(phone) : null;
  return e ? `https://wa.me/${e.slice(1)}` : null;
}

export function Phone({ phone, size = 'sm' }: { phone: string | null | undefined; size?: string }) {
  const link = waLink(phone);
  if (!phone) return <Text size={size}>—</Text>;
  return (
    <Group gap={4} wrap="nowrap" justify="flex-end">
      <Text size={size} dir="ltr">{phone}</Text>
      {link && (
        <Tooltip label="שיחה בוואטסאפ">
          <ActionIcon size="sm" variant="subtle" color="green" component="a" href={link} target="_blank" rel="noopener noreferrer" aria-label="וואטסאפ"
            onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <IconBrandWhatsapp size={16} />
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );
}

// All of a party's numbers with what each one is (decision 154): the main one, then the others.
// `compact`: the main one and "+N", the rest on hover (for lists).
export function Phones({ phone, label, extra = [], compact = false }: { phone: string | null | undefined; label?: string | null; extra?: { phone: string; label: string | null }[]; compact?: boolean }) {
  const all = [...(phone ? [{ phone, label: label ?? null }] : []), ...extra.filter((x) => x.phone)];
  if (!all.length) return <Text size="sm">—</Text>;
  const line = (x: { phone: string; label: string | null }, i: number) => (
    <Group key={i} gap={6} wrap="nowrap" justify="flex-end">
      {x.label && <Text size="xs" c="dimmed">{x.label}</Text>}
      <Phone phone={x.phone} />
    </Group>
  );
  if (compact && all.length > 1) {
    return (
      <Tooltip label={<Stack gap={2}>{all.map((x, i) => <Text key={i} size="xs" dir="ltr">{x.phone}{x.label ? ` · ${x.label}` : ''}</Text>)}</Stack>}>
        <Group gap={4} wrap="nowrap" justify="flex-end"><Phone phone={all[0].phone} /><Text size="xs" c="dimmed">+{all.length - 1}</Text></Group>
      </Tooltip>
    );
  }
  return <Stack gap={2}>{all.map(line)}</Stack>;
}
