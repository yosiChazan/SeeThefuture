import {
  Alert, Badge, Button, Checkbox, CopyButton, Group, Modal, Paper, PasswordInput, Radio, Select, Stack, Table, Text, TextInput, Title, Tooltip,
} from '@mantine/core';
import { SendMailButton } from '../components/SendMailButton';
import { notifications } from '@mantine/notifications';
import { IconHistory, IconKey, IconMail, IconPlus, IconShieldOff, IconTrash, IconUserCog } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { QueryState } from '../components/common';
import { useAccess } from '../lib/access';
import { COUNTRY_HE, date } from '../lib/format';
import { useClients } from '../lib/queries';
import { UserActivity } from '../components/UserActivity';
import { must, supabase } from '../lib/supabase';
import type { Country } from '../lib/types';

// The users screen (SPEC decision 86). Admins only; the database enforces the same.
type Level = 'viewer' | 'editor' | 'finance';
const LEVEL_HE: Record<Level, string> = { viewer: 'צפייה', editor: 'עריכה', finance: 'כספים (אישור תנועות)' };
const COUNTRIES: Country[] = ['UA', 'RO', 'GE', 'GR'];
type Kind = 'none' | 'staff' | 'management' | 'admin' | 'client';
const KIND_HE: Record<Kind, string> = { none: 'ללא גישה', staff: 'עובד/ת', management: 'הנהלה', admin: 'מנהל/ת מערכת', client: 'לקוח' };
const KIND_COLOR: Record<Kind, string> = { none: 'gray', staff: 'blue', management: 'grape', admin: 'red', client: 'teal' };

interface Role { country_code: Country; level: Level; can_view_sensitive: boolean }
interface UserRow {
  user_id: string; email: string; created_at: string; last_sign_in_at: string | null; has_totp: boolean;
  profile: { display_name: string; is_admin: boolean; is_management: boolean; client_party_id: string | null; must_change_password: boolean } | null;
  roles: Role[];
}
const kindOf = (u: UserRow): Kind => !u.profile ? 'none' : u.profile.is_admin ? 'admin' : u.profile.is_management ? 'management'
  : u.profile.client_party_id ? 'client' : 'staff';

function useUsers() {
  return useQuery({
    queryKey: ['admin-users'],
    queryFn: async (): Promise<UserRow[]> => {
      const [users, profiles, roles] = await Promise.all([
        supabase.rpc('admin_users'),
        supabase.from('profiles').select('user_id, display_name, is_admin, is_management, client_party_id, must_change_password'),
        supabase.from('user_country_roles').select('user_id, country_code, level, can_view_sensitive'),
      ]);
      const us = must(users) as Omit<UserRow, 'profile' | 'roles'>[];
      const ps = new Map((must(profiles) as (UserRow['profile'] & { user_id: string })[]).map((p) => [p.user_id, p]));
      const rs = must(roles) as (Role & { user_id: string })[];
      return us.map((u) => ({ ...u, profile: ps.get(u.user_id) ?? null, roles: rs.filter((r) => r.user_id === u.user_id) }));
    },
  });
}

// The function's error text, not just "non-2xx".
async function call(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.functions.invoke('admin-users', { body });
  if (error) {
    const ctx = (error as { context?: Response }).context;
    const msg = ctx && typeof ctx.json === 'function' ? (await ctx.json().catch(() => null))?.error : null;
    throw new Error(msg ?? error.message);
  }
  return data as Record<string, unknown>;
}

// The user replaces a password an admin gave at the next sign-in (SPEC decision 87).
// Checked: an update that reaches no row is not an error by itself, and a user created
// without the flag would then sign in without being asked for a new password.
async function requireChange(userId: string, on: boolean) {
  const rows = must(await supabase.from('profiles').update({ must_change_password: on }).eq('user_id', userId).select('user_id')) as unknown[];
  if (!rows.length) throw new Error('דרישת החלפת הסיסמה לא נשמרה. נסו שוב מכרטיס ההרשאות ("שליחת פרטי כניסה").');
}

function newPassword(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const v = crypto.getRandomValues(new Uint32Array(14));
  return [...v].map((n) => abc[n % abc.length]).join('');
}

function PasswordField({ value, onChange, readOnly = false }: { value: string; onChange: (v: string) => void; readOnly?: boolean }) {
  return (
    <Group align="flex-end" gap="xs">
      <PasswordInput label="סיסמה" description="10 תווים לפחות. סיסמה זמנית: המשתמש מחליף אותה בכניסה הראשונה" value={value}
        onChange={(e) => onChange(e.currentTarget.value)} style={{ flex: 1 }} visible readOnly={readOnly} />
      {!readOnly && <Button variant="light" onClick={() => onChange(newPassword())}>צור סיסמה</Button>}
      <CopyButton value={value}>{({ copied, copy }) => <Button variant="subtle" onClick={copy} disabled={!value}>{copied ? 'הועתק' : 'העתק'}</Button>}</CopyButton>
    </Group>
  );
}


// A welcome e-mail sent by the admin from their own mailbox: Supabase's built-in mail
// sends only to the project's team and 2 an hour. Three ways to send it, because a mailto
// link does nothing on a computer with no mail app set up: Gmail in a new tab, the
// computer's mail app, or copying the text into any mail or WhatsApp.
// A temporary password (replaced at the next sign-in) goes in by default; the admin can
// leave it out and pass it on separately.
function mailSubject(reset: boolean) { return reset ? 'שחזור סיסמה במערכת See the Future' : 'משתמש חדש במערכת See the Future'; }
function welcomeText(name: string, email: string, password: string | null, admin: boolean, temporary: boolean, reset: boolean): string {
  return [
    `שלום ${name},`, '',
    reset ? 'הסיסמה שלך במערכת של See the Future אופסה.' : 'נפתח לך משתמש במערכת של See the Future.', '',
    `כניסה: ${window.location.origin}`,
    `מייל: ${email}`,
    password ? `סיסמה${temporary ? ' זמנית' : ''}: ${password}` : `את הסיסמה${temporary ? ' הזמנית' : ''} אשלח לך בנפרד.`, '',
    admin
      ? (reset ? 'אחרי הסיסמה מקלידים את הקוד מאפליקציית האימות.' : 'אחרי הסיסמה המערכת תבקש להגדיר אפליקציית אימות (Google Authenticator או דומה): סורקים את הקוד שעל המסך ומקלידים את 6 הספרות.')
      : 'אחרי הסיסמה לוחצים "שליחת קוד למייל", ומקלידים את הקוד בן 6 הספרות שיגיע לכתובת הזאת.',
    ...(temporary ? [`${reset ? 'בכניסה הבאה' : 'בכניסה הראשונה'} המערכת תבקש לבחור סיסמה אישית חדשה.`] : []),
  ].join('\n');
}

function MailButton({ name, email, password, admin = false, temporary = false, reset = false }: { name: string; email: string; password: string | null; admin?: boolean; temporary?: boolean; reset?: boolean }) {
  const [withPassword, setWithPassword] = useState(temporary);
  const subject = mailSubject(reset);
  const body = welcomeText(name, email, password && withPassword ? password : null, admin, temporary, reset);
  const gmail = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return (
    <Stack gap={6}>
      <Text size="sm" fw={600}>{reset ? 'מייל למשתמש עם הסיסמה החדשה' : 'מייל למשתמש עם פרטי הכניסה'}</Text>
      {password && <Checkbox label="לכלול את הסיסמה במייל" checked={withPassword} onChange={(e) => setWithPassword(e.currentTarget.checked)} />}
      <Group gap="xs">
        <SendMailButton to={email} subject={subject} text={body} />
        <Button component="a" href={gmail} target="_blank" rel="noopener" leftSection={<IconMail size={16} />} variant="light">פתיחה ב-Gmail</Button>
        <Button component="a" href={mailto} variant="default">תוכנת מייל במחשב</Button>
        <CopyButton value={`${subject}\n\n${body}`}>{({ copied, copy }) => <Button variant="subtle" onClick={copy}>{copied ? 'הועתק' : 'העתקת ההודעה'}</Button>}</CopyButton>
      </Group>
      <Text size="xs" c="dimmed">"שליחת מייל" שולח מכתובת המערכת אל {email}, והתשובות יגיעו אליך. או טיוטה מוכנה שאתה שולח מהתיבה שלך. אם לא נפתח כלום, מעתיקים את ההודעה ומדביקים במייל או בוואטסאפ. {password && !withPassword && 'בלי הסיסמה, מעבירים אותה בנפרד (וואטסאפ או SMS).'}</Text>
    </Stack>
  );
}

function AddUser({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState(''), [email, setEmail] = useState(''), [password, setPassword] = useState(newPassword());
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [mustChange, setMustChange] = useState(true);
  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await call({ action: 'create', email: email.trim(), password, display_name: name.trim() });
      if (mustChange) await requireChange(String(r.user_id), true);
      notifications.show({ color: 'teal', message: `${name} נוסף/ה` });
      setCreated(String(r.user_id));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (created) return (
    <Modal opened onClose={() => onCreated(created)} title="המשתמש נוצר" size="lg">
      <Stack>
        <Text>{name.trim()} ({email.trim()}) יכול/ה להיכנס. עכשיו שולחים לו/לה את פרטי הכניסה, ואז נותנים הרשאות.</Text>
        <MailButton name={name.trim()} email={email.trim()} password={password} temporary={mustChange} />
        <Group justify="flex-end"><Button onClick={() => onCreated(created)}>המשך להרשאות</Button></Group>
      </Stack>
    </Modal>
  );
  return (
    <Modal opened onClose={onClose} title="משתמש חדש" size="lg">
      <Stack>
        <TextInput label="שם" value={name} onChange={(e) => setName(e.currentTarget.value)} required />
        <TextInput label="מייל" dir="ltr" value={email} onChange={(e) => setEmail(e.currentTarget.value)} required />
        <PasswordField value={password} onChange={setPassword} />
        <Checkbox label="לדרוש החלפת סיסמה בכניסה הראשונה" checked={mustChange} onChange={(e) => setMustChange(e.currentTarget.checked)} />
        <Text size="xs" c="dimmed">בכניסה הראשונה עובד/ת יתבקש/ו להגדיר אפליקציית אימות (TOTP). אחרי היצירה אפשר לשלוח לו/לה מייל עם פרטי הכניסה, ואז נפתח מסך ההרשאות, כי בלי הרשאות המשתמש לא רואה כלום.</Text>
        {err && <Alert color="red">{err}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button>
          <Button onClick={save} loading={busy} disabled={!name.trim() || !email.trim() || password.length < 10}>יצירה</Button></Group>
      </Stack>
    </Modal>
  );
}

function EditUser({ user, me, onClose }: { user: UserRow; me: string; onClose: () => void }) {
  const qc = useQueryClient();
  const clients = useClients();
  const [name, setName] = useState(user.profile?.display_name ?? user.email.split('@')[0]);
  const [kind, setKind] = useState<Kind>(kindOf(user));
  const [client, setClient] = useState<string | null>(user.profile?.client_party_id ?? null);
  const [roles, setRoles] = useState<Partial<Record<Country, Role>>>(Object.fromEntries(user.roles.map((r) => [r.country_code, r])));
  const [busy, setBusy] = useState<string | null>(null), [err, setErr] = useState<string | null>(null);
  const [sentPw, setSentPw] = useState<string | null>(null);
  const firstLogin = !user.last_sign_in_at;
  const clientOptions = useMemo(() => (clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name })).sort((a, b) => a.label.localeCompare(b.label, 'he')), [clients.data]);
  const self = user.user_id === me;
  const done = (msg: string) => { notifications.show({ color: 'teal', message: msg }); qc.invalidateQueries({ queryKey: ['admin-users'] }); };
  const run = async (key: string, f: () => Promise<void>) => { setBusy(key); setErr(null); try { await f(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); } };

  const save = () => run('save', async () => {
    if (kind === 'none') {
      if (user.profile) must(await supabase.from('profiles').delete().eq('user_id', user.user_id));
    } else {
      if (kind === 'client' && !client) throw new Error('בוחרים את הלקוח שהמשתמש יראה');
      must(await supabase.from('profiles').upsert({
        user_id: user.user_id, display_name: name.trim(), is_admin: kind === 'admin', is_management: kind === 'management',
        client_party_id: kind === 'client' ? client : null,
      }));
      const keep = kind === 'staff' || kind === 'management' ? Object.values(roles).filter((r): r is Role => !!r) : [];
      must(await supabase.from('user_country_roles').delete().eq('user_id', user.user_id));
      if (keep.length) must(await supabase.from('user_country_roles').insert(keep.map((r) => ({ ...r, user_id: user.user_id }))));
    }
    done('ההרשאות נשמרו'); onClose();
  });
  const setLevel = (c: Country, level: string | null) => setRoles((r) => ({ ...r, [c]: level ? { country_code: c, level: level as Level, can_view_sensitive: r[c]?.can_view_sensitive ?? false } : undefined }));
  const setSensitive = (c: Country, v: boolean) => setRoles((r) => (r[c] ? { ...r, [c]: { ...r[c]!, can_view_sensitive: v } } : r));

  return (
    <Modal opened onClose={onClose} title={`הרשאות: ${user.email}`} size="lg">
      <Stack>
        <TextInput label="שם" value={name} onChange={(e) => setName(e.currentTarget.value)} disabled={kind === 'none'} />
        <Radio.Group label="סוג גישה" value={kind} onChange={(v) => setKind(v as Kind)}>
          <Stack gap={6} mt={6}>
            <Radio value="staff" label="עובד/ת: רואה ועורך רק את המדינות שנבחרו למטה" />
            <Radio value="management" label="הנהלה: רואה את כל המדינות; עריכה רק במדינות שנבחרו למטה" />
            <Radio value="admin" label="מנהל/ת מערכת: הכול, כולל הגדרות ומשתמשים" disabled={self && kind === 'admin'} />
            <Radio value="client" label="לקוח: רואה רק את הנכסים והיתרות של לקוח אחד" disabled={self} />
            <Radio value="none" label="ללא גישה: יכול להיכנס אבל לא רואה כלום" disabled={self} />
          </Stack>
        </Radio.Group>
        {self && <Text size="xs" c="dimmed">את ההרשאות של עצמך אי אפשר להוריד מכאן, כדי לא לנעול את המערכת.</Text>}
        {kind === 'client' && (
          <Select label="הלקוח" data={clientOptions} value={client} onChange={setClient} searchable nothingFoundMessage="לא נמצא" />
        )}
        {(kind === 'staff' || kind === 'management') && (
          <Table verticalSpacing={4}>
            <Table.Thead><Table.Tr><Table.Th>מדינה</Table.Th><Table.Th>הרשאה</Table.Th><Table.Th>מסמכים רגישים</Table.Th></Table.Tr></Table.Thead>
            <Table.Tbody>{COUNTRIES.map((c) => (
              <Table.Tr key={c}>
                <Table.Td>{COUNTRY_HE[c]}</Table.Td>
                <Table.Td><Select size="xs" w={190} placeholder={kind === 'management' ? 'צפייה (הנהלה)' : 'אין'} clearable value={roles[c]?.level ?? null}
                  data={Object.entries(LEVEL_HE).map(([value, label]) => ({ value, label }))} onChange={(v) => setLevel(c, v)} /></Table.Td>
                <Table.Td><Checkbox checked={roles[c]?.can_view_sensitive ?? false} disabled={!roles[c]} onChange={(e) => setSensitive(c, e.currentTarget.checked)} /></Table.Td>
              </Table.Tr>
            ))}</Table.Tbody>
          </Table>
        )}
        {kind === 'staff' && !Object.values(roles).some(Boolean) && <Text size="xs" c="orange">עובד/ת בלי אף מדינה לא רואה כלום.</Text>}
        {err && <Alert color="red">{err}</Alert>}
        <Group justify="flex-end"><Button variant="default" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy === 'save'}>שמירה</Button></Group>

        <Paper withBorder p="sm" mt="sm">
          <Text fw={600} size="sm" mb="xs">כניסה למערכת</Text>
          {/* Until the first sign-in: send the sign-in details again. After it: recover the password.
              Either way a new temporary password is set (the old one is not kept anywhere). */}
          <Text size="xs" c="dimmed" mb="xs">{firstLogin
            ? 'המשתמש עוד לא נכנס. "שליחת פרטי כניסה" יוצרת סיסמה זמנית חדשה (הקודמת מפסיקה לעבוד) ופותחת מייל מוכן.'
            : `נכנס לאחרונה ב-${date(user.last_sign_in_at)}. "שחזור סיסמה" יוצר סיסמה זמנית חדשה, שהמשתמש יחליף בכניסה הבאה.`}</Text>
          <Group gap="xs">
            <Button size="xs" variant="light" leftSection={<IconKey size={14} />} disabled={self || !user.profile} loading={busy === 'pw'}
              onClick={() => window.confirm(firstLogin ? 'ליצור סיסמה זמנית חדשה ולשלוח פרטי כניסה?' : 'לאפס את הסיסמה של המשתמש? הסיסמה הנוכחית תפסיק לעבוד.') && run('pw', async () => {
                const p = newPassword();
                await call({ action: 'set_password', user_id: user.user_id, password: p });
                await requireChange(user.user_id, true);
                done(firstLogin ? 'נוצרה סיסמה זמנית חדשה' : 'הסיסמה אופסה'); setSentPw(p);
              })}>{firstLogin ? 'שליחת פרטי כניסה' : 'שחזור סיסמה'}</Button>
            <Button size="xs" variant="light" color="orange" leftSection={<IconShieldOff size={14} />} disabled={!user.has_totp || self} loading={busy === 'mfa'}
              onClick={() => window.confirm('להסיר את אפליקציית האימות? בכניסה הבאה המשתמש יגדיר חדשה.') && run('mfa', async () => { await call({ action: 'reset_mfa', user_id: user.user_id }); done('אפליקציית האימות הוסרה'); })}>
              איפוס אפליקציית אימות</Button>
            <Button size="xs" variant="light" color="red" leftSection={<IconTrash size={14} />} disabled={self} loading={busy === 'delete'}
              onClick={() => window.confirm(`למחוק את ${user.email}? הכניסה וההרשאות יימחקו. מה שהמשתמש עשה נשאר ביומן השינויים.`) && run('delete', async () => { await call({ action: 'delete', user_id: user.user_id }); done('המשתמש נמחק'); onClose(); })}>
              מחיקת המשתמש</Button>
          </Group>
          {!user.profile && <Text size="xs" c="orange" mt={4}>קודם נותנים הרשאות ושומרים, ואז שולחים פרטי כניסה.</Text>}
          {sentPw && (
            <Stack mt="sm" gap="xs">
              <PasswordField value={sentPw} onChange={() => {}} readOnly />
              <MailButton key={sentPw} name={user.profile?.display_name ?? name} email={user.email} password={sentPw}
                admin={!!user.profile?.is_admin} temporary reset={!firstLogin} />
            </Stack>
          )}
        </Paper>
      </Stack>
    </Modal>
  );
}

export function Users() {
  const access = useAccess();
  const q = useUsers();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [watching, setWatching] = useState<{ id: string; name: string } | null>(null);
  const [meId, setMeId] = useState('');
  useEffect(() => { supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? '')); }, []);
  if (!access.isAdmin) return <Navigate to="/" replace />;
  const editUser = q.data?.find((u) => u.user_id === editing);
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>משתמשים</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>משתמש חדש</Button>
      </Group>
      <Text size="sm" c="dimmed">מי יכול להיכנס לאפליקציה ומה כל אחד רואה. כל שינוי נרשם ביומן השינויים.</Text>
      {adding && <AddUser onClose={() => setAdding(false)} onCreated={(id) => { setAdding(false); q.refetch().then(() => setEditing(id)); }} />}
      {watching && <UserActivity userId={watching.id} name={watching.name} onClose={() => setWatching(null)} />}
      {editUser && <EditUser user={editUser} me={meId} onClose={() => setEditing(null)} />}
      <QueryState q={q}>{(users) => (
        <Paper withBorder p="sm">
          <Table.ScrollContainer minWidth={900}>
            <Table striped highlightOnHover verticalSpacing="xs">
              <Table.Thead><Table.Tr>
                <Table.Th>שם</Table.Th><Table.Th>מייל</Table.Th><Table.Th>סוג</Table.Th><Table.Th>מדינות</Table.Th>
                <Table.Th>אימות דו-שלבי</Table.Th><Table.Th>כניסה אחרונה</Table.Th><Table.Th />
              </Table.Tr></Table.Thead>
              <Table.Tbody>
                {[...users].sort((a, b) => kindOf(a).localeCompare(kindOf(b)) || (a.profile?.display_name ?? a.email).localeCompare(b.profile?.display_name ?? b.email, 'he')).map((u) => {
                  const k = kindOf(u);
                  return (
                    <Table.Tr key={u.user_id}>
                      <Table.Td fw={500}>{u.profile?.display_name ?? '—'}</Table.Td>
                      <Table.Td dir="ltr" style={{ textAlign: 'right' }}>{u.email}</Table.Td>
                      <Table.Td><Badge variant="light" color={KIND_COLOR[k]}>{KIND_HE[k]}</Badge></Table.Td>
                      <Table.Td>
                        <Group gap={4}>
                          {k === 'admin' && <Text size="sm">כולן</Text>}
                          {k === 'management' && <Text size="sm">כולן (צפייה)</Text>}
                          {u.roles.map((r) => (
                            <Tooltip key={r.country_code} label={r.can_view_sensitive ? 'כולל מסמכים רגישים (דרכונים, צילומי ת"ז, ייפויי כוח, חוזי רכישה)' : 'בלי מסמכים רגישים'}>
                              <Badge variant="outline" size="sm">{COUNTRY_HE[r.country_code]}: {LEVEL_HE[r.level].split(' ')[0]}{r.can_view_sensitive ? ' 🔒' : ''}</Badge>
                            </Tooltip>
                          ))}
                        </Group>
                      </Table.Td>
                      <Table.Td>{u.has_totp ? <Badge color="teal" variant="light" size="sm">מוגדר</Badge> : <Text size="sm" c="dimmed">עוד לא</Text>}
                        {u.profile?.must_change_password && <Badge color="orange" variant="light" size="sm" mt={4}>סיסמה זמנית</Badge>}</Table.Td>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>{u.last_sign_in_at ? date(u.last_sign_in_at) : 'אף פעם'}</Table.Td>
                      <Table.Td><Group gap={4} wrap="nowrap">
                        <Button size="xs" variant="subtle" leftSection={<IconUserCog size={14} />} onClick={() => setEditing(u.user_id)}>הרשאות</Button>
                        <Button size="xs" variant="subtle" color="gray" leftSection={<IconHistory size={14} />} onClick={() => setWatching({ id: u.user_id, name: u.profile?.display_name ?? u.email })}>פעילות</Button>
                      </Group></Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}</QueryState>
    </Stack>
  );
}
