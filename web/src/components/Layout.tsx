import { AppShell, Badge, Burger, Button, Group, Image, NavLink, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconAddressBook, IconBuildingCommunity, IconChecklist, IconFileImport, IconFileText, IconHome, IconLogout, IconMessages, IconSettings, IconSignature, IconUserShield, IconUsers, IconChartBar, IconCash } from '@tabler/icons-react';
import { useState } from 'react';
import { Navigate, NavLink as RouterLink, Outlet, useLocation } from 'react-router-dom';
import { useAccess } from '../lib/access';
import { COUNTRY_HE } from '../lib/format';
import { supabase } from '../lib/supabase';

const NAV = [
  { to: '/', label: 'לוח ראשי', icon: IconHome },
  { to: '/properties', label: 'נכסים', icon: IconBuildingCommunity },
  { to: '/clients', label: 'לקוחות', icon: IconUsers },
  { to: '/contacts', label: 'אנשי קשר', icon: IconAddressBook },
  { to: '/leases', label: 'חוזי שכירות', icon: IconSignature },
  { to: '/intake', label: 'קליטת דוחות', icon: IconFileImport },
  { to: '/completeness', label: 'השלמת פרטים', icon: IconChecklist },
  { to: '/stats', label: 'סטטיסטיקות', icon: IconChartBar },
  { to: '/cash', label: 'קופות', icon: IconCash },
];

// Screens from SPEC §6.1 that wait for later stages (§9).
const LATER = [
  { label: 'הודעות', icon: IconMessages },
  { label: 'דוחות חודשיים', icon: IconFileText },
];

// Management sees only the statistics page, with a switch to the whole office site at
// their own (read) access, and back (SPEC decision 98). The choice is kept per browser.
const VIEW_KEY = 'management-view';
const readView = () => { try { return localStorage.getItem(VIEW_KEY) === 'full' ? 'full' : 'stats'; } catch { return 'stats'; } };

export function Layout() {
  const [opened, { toggle, close }] = useDisclosure();
  const access = useAccess();
  const { pathname } = useLocation();
  const [view, setView] = useState<'stats' | 'full'>(readView);
  const statsOnly = access.isManagement && !access.isAdmin && view === 'stats';
  const switchView = (v: 'stats' | 'full') => { setView(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ } };
  if (statsOnly && pathname !== '/stats') return <Navigate to="/stats" replace />;
  const role = access.isAdmin ? 'מנהל מערכת' : access.isManagement ? 'הנהלה' : access.countries.map((c) => COUNTRY_HE[c]).join(', ');

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 230, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="sm">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <Image src="/logo-mark.png" w={32} h={32} alt="" />
            <Text fw={700}>See the Future</Text>
            <Text c="dimmed" size="sm" visibleFrom="xs">משרד</Text>
          </Group>
          <Group gap="xs">
            {access.isManagement && !access.isAdmin && (statsOnly
              ? <Button size="xs" variant="light" onClick={() => switchView('full')}>לאתר המלא</Button>
              : <Button size="xs" variant="light" component={RouterLink} to="/stats" onClick={() => switchView('stats')}>לסטטיסטיקות בלבד</Button>)}
            <Text size="sm">{access.displayName}</Text>
            <Badge variant="light" visibleFrom="xs">{role}</Badge>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs">
        <AppShell.Section grow component={ScrollArea}>
          <Stack gap={2}>
            {(statsOnly ? NAV.filter((n) => n.to === '/stats') : NAV).map((n) => (
              <NavLink key={n.to} component={RouterLink} to={n.to} label={n.label} onClick={close}
                leftSection={<n.icon size={18} />} active={n.to === '/' ? pathname === '/' : pathname.startsWith(n.to)} />
            ))}
            {!statsOnly && <Text size="xs" c="dimmed" mt="md" mb={4} px="sm">בשלבים הבאים</Text>}
            {!statsOnly && LATER.map((n) => (
              <Tooltip key={n.label} label="ייבנה בשלב הבא" position="left">
                <NavLink label={n.label} leftSection={<n.icon size={18} />} disabled />
              </Tooltip>
            ))}
          </Stack>
        </AppShell.Section>
        <AppShell.Section>
          {access.isAdmin && (
            <NavLink component={RouterLink} to="/users" label="משתמשים" leftSection={<IconUserShield size={18} />} onClick={close} active={pathname.startsWith('/users')} />
          )}
          {access.isAdmin && (
            <NavLink component={RouterLink} to="/settings" label="הגדרות" leftSection={<IconSettings size={18} />} onClick={close} active={pathname.startsWith('/settings')} />
          )}
          <NavLink label="יציאה" leftSection={<IconLogout size={18} />} onClick={() => supabase.auth.signOut()} />
        </AppShell.Section>
      </AppShell.Navbar>
      <AppShell.Main bg="gray.0">
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
