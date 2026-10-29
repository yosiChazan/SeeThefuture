import { AppShell, Badge, Burger, Group, NavLink, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBuildingCommunity, IconCrane, IconFileImport, IconFileText, IconHome, IconLogout, IconMessages, IconSignature, IconUsers,
} from '@tabler/icons-react';
import { NavLink as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { COUNTRY_HE } from '../lib/format';
import { supabase } from '../lib/supabase';

const NAV = [
  { to: '/', label: 'לוח ראשי', icon: IconHome },
  { to: '/properties', label: 'נכסים', icon: IconBuildingCommunity },
  { to: '/clients', label: 'לקוחות', icon: IconUsers },
  { to: '/leases', label: 'חוזי שכירות', icon: IconSignature },
];

// Screens from SPEC §6.1 that wait for later stages (§9).
const LATER = [
  { label: 'קליטה', icon: IconFileImport },
  { label: 'רכישה ובנייה', icon: IconCrane },
  { label: 'הודעות', icon: IconMessages },
  { label: 'דוחות חודשיים', icon: IconFileText },
];

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const access = useAccess();
  const { pathname } = useLocation();
  const role = access.isAdmin ? 'מנהל מערכת' : access.isManagement ? 'הנהלה' : access.countries.map((c) => COUNTRY_HE[c]).join(', ');

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Text fw={700}>See the Future</Text>
            <Text c="dimmed" size="sm" visibleFrom="xs">משרד</Text>
          </Group>
          <Group gap="xs">
            <Text size="sm">{access.displayName}</Text>
            <Badge variant="light" visibleFrom="xs">{role}</Badge>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>
            {NAV.map((n) => (
              <NavLink key={n.to} component={RouterLink} to={n.to} label={n.label} onClick={close}
                leftSection={<n.icon size={18} />} active={n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)} />
            ))}
            <Text size="xs" c="dimmed" mt="md" mb={4} px="sm">בשלבים הבאים</Text>
            {LATER.map((n) => (
              <Tooltip key={n.label} label="ייבנה בשלב הבא" position="left">
                <NavLink label={n.label} leftSection={<n.icon size={18} />} disabled />
              </Tooltip>
            ))}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          <NavLink label="יציאה" leftSection={<IconLogout size={18} />} onClick={() => supabase.auth.signOut()} />
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main bg="gray.0">
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
