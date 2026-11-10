import { ActionIcon, Group, Text, Tooltip } from '@mantine/core';
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
