import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Paper, Select, Stack, Switch, Text, TextInput, Textarea, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconEyeOff, IconPlus, IconSearch } from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { IdFromScans } from '../components/IdFromScans';
import { ManualTopics, NewTopic, useTopics } from '../components/ManualTopics';
import { linkPartners } from '../components/Partners';
import { useAccess } from '../lib/access';
import { findItems, GROUP_HE, type Doc, type Fix, type Group as G, type Item } from '../lib/completeness';
import { propertyTitle } from '../lib/format';
import { useBatches } from '../lib/intake';
import { idNumberOf, setClientRole, useClients, useContacts, usePartyLinks, useProperties } from '../lib/queries';
import { must, supabase } from '../lib/supabase';

const DOC_TYPES = [
  { value: 'passport', label: 'דרכון' }, { value: 'id_card', label: 'תעודת זהות וספח' }, { value: 'poa', label: 'ייפוי כוח' },
  { value: 'purchase_contract', label: 'חוזה רכישה' }, { value: 'land_registry', label: 'נסח טאבו' }, { value: 'land_book', label: 'Land book' },
  { value: 'lease_contract', label: 'חוזה שכירות חתום' }, { value: 'lease_appendix', label: 'נספח / הארכה' }, { value: 'payment_proof', label: 'הוכחת תשלום / קבלה' },
  { value: 'bank_document', label: 'מסמך בנק' }, { value: 'e9', label: 'E9 (יוון)' }, { value: 'photo', label: 'תמונה' }, { value: 'management_contract', label: 'חוזה ניהול' }, { value: 'caveat', label: 'הערת אזהרה' },
  { value: 'attachment', label: 'מסמך אחר' },
];
const PAGE = 60;

async function readAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const page = must(await build(from, from + 999) as { data: T[] | null; error: null }) as T[];
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

// The data the checks need beyond the lists other pages already load.
function useExtra() {
  return useQuery({
    queryKey: ['completeness-extra'],
    queryFn: async () => {
      const [docs, deals, managers, rents, dismissed] = await Promise.all([
        readAll<Doc>((a, b) => supabase.from('documents').select('id, entity_type, entity_id, doc_type, file_name, storage_path').order('id').range(a, b)),
        readAll<{ property_id: string; client_party_id: string; total_price: number | null; price_currency: string | null; signed_on: string | null }>((a, b) =>
          supabase.from('deals').select('property_id, client_party_id, total_price, price_currency, signed_on').order('id').range(a, b)),
        readAll<{ property_id: string; manager: { id: string; display_name: string } }>((a, b) =>
          supabase.from('management_agreements').select('property_id, manager:parties(id, display_name)').is('valid_to', null).order('id').range(a, b)),
        supabase.rpc('last_rent_by_property').then((r) => must(r) as { property_id: string; occurred_on: string; amount: number; currency: string }[]),
        readAll<{ check_key: string; entity_id: string; reason: string | null }>((a, b) => supabase.from('completeness_dismissals').select('check_key, entity_id, reason').range(a, b)),
      ]);
      return { docs, deals, managers, rents, dismissed };
    },
  });
}

function DocLink({ d }: { d: Doc }) {
  async function open() {
    await supabase.rpc('log_document_access', { doc: d.id });
    const { data, error } = await supabase.storage.from('documents').createSignedUrl(d.storage_path, 60);
    if (error) notifications.show({ color: 'red', message: error.message }); else window.open(data.signedUrl, '_blank');
  }
  return <Anchor size="sm" dir="ltr" onClick={open}>{d.file_name ?? d.storage_path.split('/').pop()}</Anchor>;
}

// A document's type, changed in place (decisions 64, 69).
function DocType({ d, onChanged }: { d: Doc; onChanged: () => void }) {
  return (
    <Select size="xs" w={170} allowDeselect={false} value={d.doc_type} aria-label="סוג המסמך"
      data={DOC_TYPES.some((t) => t.value === d.doc_type) ? DOC_TYPES : [...DOC_TYPES, { value: d.doc_type, label: d.doc_type }]}
      onChange={async (v) => {
        if (!v || v === d.doc_type) return;
        const { error } = await supabase.from('documents').update({ doc_type: v }).eq('id', d.id);
        if (error) notifications.show({ color: 'red', message: error.message }); else onChanged();
      }} />
  );
}

export function Completeness() {
  const access = useAccess();
  const qc = useQueryClient();
  const clients = useClients();
  const links = usePartyLinks();
  const properties = useProperties();
  const contacts = useContacts();
  const lists = useMemo(() => ({
    clients: (clients.data ?? []).map((c) => ({ value: c.id, label: c.display_name })),
    contacts: (contacts.data ?? []).map((c) => ({ value: c.id, label: c.display_name })),
    properties: (properties.data ?? []).map((p) => ({ value: p.id, label: propertyTitle(p) })),
  }), [clients.data, contacts.data, properties.data]);
  const batches = useBatches();
  const extra = useExtra();
  const [params, setParams] = useSearchParams();
  const group = (params.get('g') ?? 'all') as G | 'all' | 'manual';
  const topics = useTopics();
  const [adding, setAdding] = useState(false);
  const check = params.get('check');
  const search = params.get('q') ?? '';
  const [showIgnored, setShowIgnored] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [ignoring, setIgnoring] = useState<Item | null>(null);
  const [reason, setReason] = useState('');
  const [scanning, setScanning] = useState<{ partyId: string; current: string | null } | null>(null);
  const canEdit = access.isAdmin || access.countries.some((c) => access.canEdit(c));
  // One call per change: two calls in a row would each start from the same address.
  const setMany = (changes: Record<string, string | null>) => { setLimit(PAGE); setParams((prev) => { const p = new URLSearchParams(prev); for (const [k, v] of Object.entries(changes)) { if (v) p.set(k, v); else p.delete(k); } return p; }, { replace: true }); };
  const set = (k: string, v: string | null) => setMany({ [k]: v });
  const refresh = () => qc.invalidateQueries();

  const ready = clients.data && links.data && properties.data && batches.data && extra.data;
  const all = useMemo(() => {
    if (!ready) return [];
    return findItems({
      today: dayjs().format('YYYY-MM-DD'),
      clients: clients.data!.map((c) => ({
        id: c.id, name: c.display_name, last_name: c.last_name, kind: c.kind, phone: c.phone, email: c.email, address: c.address,
        id_number: idNumberOf(c), referred_by: c.referred_by?.display_name ?? null,
        property_ids: c.ownerships.filter((o) => !o.valid_to && o.property).map((o) => o.property!.id),
      })),
      members: new Map(links.data!.map((l) => [l.member_party_id, l.main_party_id])),
      docs: extra.data!.docs,
      properties: properties.data!.map((p) => ({
        id: p.id, title: propertyTitle(p), country: p.country_code, building_id: p.building.id, status: p.status, sqm: p.sqm, floor: p.floor,
        ownerships: p.ownerships, leases: p.leases.map((l) => ({ ...l, property_id: p.id })),
      })),
      deals: extra.data!.deals,
      managers: extra.data!.managers.map((m) => ({ property_id: m.property_id, manager: m.manager.display_name, manager_id: m.manager.id })),
      rents: extra.data!.rents,
      batches: batches.data!.map((b) => ({ id: b.id, source: b.source.name, received_at: b.received_at, rows: b.rows[0]?.count ?? 0, status: b.status })),
    });
  }, [ready, clients.data, links.data, properties.data, batches.data, extra.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const ignored = useMemo(() => new Map((extra.data?.dismissed ?? []).map((x) => [`${x.check_key}:${x.entity_id}`, x.reason])), [extra.data]);
  const open = all.filter((i) => showIgnored ? ignored.has(`${i.key}:${i.entityId}`) : !ignored.has(`${i.key}:${i.entityId}`));
  const s = search.trim().toLowerCase();
  const shown = open.filter((i) => (group === 'all' || i.group === group) && (!check || i.key === check) && (!s || i.title.toLowerCase().includes(s)));
  const checks = [...new Map(open.filter((i) => group === 'all' || i.group === group).map((i) => [i.key, i.label.replace(/ב-\d.*$/, '').replace(/\(.*\)/, '').trim()])).entries()];

  async function ignore() {
    if (!ignoring) return;
    const { error } = await supabase.from('completeness_dismissals').upsert({ check_key: ignoring.key, entity_id: ignoring.entityId, reason: reason.trim() || null });
    if (error) { notifications.show({ color: 'red', message: error.message }); return; }
    setIgnoring(null); setReason(''); await refresh();
  }
  async function restore(i: Item) {
    const { error } = await supabase.from('completeness_dismissals').delete().eq('check_key', i.key).eq('entity_id', i.entityId);
    if (error) notifications.show({ color: 'red', message: error.message }); else await refresh();
  }

  async function run(f: Fix, i: Item) {
    try {
      if (f.kind === 'status') must(await supabase.from('properties').update({ status: f.status }).eq('id', f.propertyId));
      else if (f.kind === 'contact') await setClientRole(f.partyId, false);
      else if (f.kind === 'link') await linkPartners(f.mainId, f.memberId, 'spouse');
      else if (f.kind === 'close-lease') must(await supabase.from('leases').update({ end_date: f.endDate }).eq('id', f.leaseId));
      else if (f.kind === 'scan-id') { setScanning({ partyId: f.partyId, current: null }); return; }
      notifications.show({ color: 'teal', message: `${i.title}: עודכן` });
      await refresh();
    } catch (e) { notifications.show({ color: 'red', message: (e as Error).message }); }
  }
  const fixLabel = (f: Fix, i: Item) => {
    const names = i.title.split(' / ');
    if (f.kind === 'status') return f.status === 'rented' ? 'סימון "מושכר"' : 'סימון "פנוי"';
    if (f.kind === 'contact') return 'הגדרה כאיש קשר';
    if (f.kind === 'scan-id') return 'זיהוי ת.ז. מהמסמכים';
    if (f.kind === 'close-lease') return `סגירת הקודם ב-${f.endDate.split('-').reverse().join('.')}`;
    const main = i.context[0].to?.endsWith(f.mainId) ? names[0] : names[1];
    return `לקוח אחד: ${main} ראשי`;
  };
  const confirm = (f: Fix, i: Item) => (f.kind === 'link' || f.kind === 'contact' || f.kind === 'close-lease'
    ? modals.openConfirmModal({ title: fixLabel(f, i), children: <Text size="sm">{f.kind === 'link' ? 'השניים ייחשבו לקוח אחד: השני יוצג בתוך הכרטיס של הראשי. שום דבר לא עובר ולא נמחק, ואפשר להפריד.' : f.kind === 'contact' ? 'יועבר מרשימת הלקוחות לאנשי הקשר. אפשר להחזיר מהכרטיס.' : 'תאריך הסיום של החוזה הקודם יעודכן ליום שלפני תחילת החדש.'}</Text>,
      labels: { confirm: 'אישור', cancel: 'ביטול' }, onConfirm: () => run(f, i) })
    : run(f, i));

  const counts = (g: G | 'all') => open.filter((i) => g === 'all' || i.group === g).length;
  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>השלמת פרטים</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setAdding(true)}>נושא חדש</Button>
      </Group>
      {adding && (
        <NewTopic onClose={() => { setAdding(false); setMany({ g: 'manual', check: null }); }} lists={lists} />
      )}
      <Text size="sm" c="dimmed">מה חסר אצל לקוחות, נכסים וחוזים, ומה כבר יש במערכת שיכול לעזור להשלים. "להתעלם" מסתיר פריט עם סיבה, ואפשר להחזיר אותו. דירות שנמכרו לא נבדקות.</Text>
      {!ready ? <Group><Loader size="sm" /><Text size="sm">בודק…</Text></Group> : (
        <>
          <Group gap={6}>
            {(['all', 'money', 'leases', 'properties', 'clients', 'documents'] as const).map((g) => (
              <Badge key={g} size="lg" variant={group === g ? 'filled' : 'light'} style={{ cursor: 'pointer' }} onClick={() => setMany({ g: g === 'all' ? null : g, check: null })}>
                {g === 'all' ? 'הכול' : GROUP_HE[g]} · {counts(g)}
              </Badge>
            ))}
            <Badge size="lg" color="violet" variant={group === 'manual' ? 'filled' : 'light'} style={{ cursor: 'pointer' }} onClick={() => setMany({ g: 'manual', check: null })}>
              ידני · {(topics.data ?? []).filter((t) => t.status !== 'done').length}
            </Badge>
          </Group>
          {group === 'manual' ? (
            <>
              <TextInput placeholder="חיפוש בנושאים" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => set('q', e.currentTarget.value)} w={240} />
              <ManualTopics search={search} lists={lists} />
            </>
          ) : <>
          <Group>
            <Select placeholder="כל הבדיקות" data={checks.map(([value, label]) => ({ value, label: `${label} (${open.filter((i) => i.key === value).length})` }))} value={check} onChange={(v) => set('check', v)} clearable w={320} />
            <TextInput placeholder="חיפוש לקוח או נכס" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => set('q', e.currentTarget.value)} w={240} />
            <Switch label={`פריטים שהוסתרו (${ignored.size})`} checked={showIgnored} onChange={(e) => { setShowIgnored(e.currentTarget.checked); setLimit(PAGE); }} />
          </Group>
          {!access.canViewSensitive && <Alert color="gray">אין לך הרשאה למסמכים רגישים, ולכן חלק מהמסמכים לא נספרים כאן, ותראה פריטים "חסר מסמך" שאולי כבר קיים.</Alert>}
          <Text size="sm" c="dimmed">{shown.length} פריטים</Text>
          {shown.slice(0, limit).map((i) => (
            <Paper key={`${i.key}:${i.entityId}`} withBorder p="sm">
              <Group justify="space-between" align="flex-start" wrap="nowrap">
                <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap="xs">
                    <Badge variant="light" color={i.group === 'money' ? 'red' : i.group === 'leases' ? 'orange' : i.group === 'documents' ? 'gray' : 'blue'}>{i.label}</Badge>
                    <Anchor component={Link} to={i.to} fw={600} size="sm">{i.title}</Anchor>
                  </Group>
                  {i.context.map((c, n) => (
                    <Group key={n} gap={6} wrap="wrap" align="center">
                      <Text size="xs" c="dimmed">{c.label}:</Text>
                      {c.text && <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{c.text}</Text>}
                      {c.docs?.map((d) => (
                        <Group key={d.id} gap={4} wrap="nowrap"><DocLink d={d} />{c.docTypes && canEdit && <DocType d={d} onChanged={refresh} />}</Group>
                      ))}
                      {c.to && <Anchor component={Link} to={c.to} size="xs">{c.toText ?? 'פתיחה'}</Anchor>}
                    </Group>
                  ))}
                  {showIgnored && ignored.get(`${i.key}:${i.entityId}`) && <Text size="xs" c="dimmed">הוסתר: {ignored.get(`${i.key}:${i.entityId}`)}</Text>}
                </Stack>
                <Stack gap={6} align="flex-end">
                  {canEdit && !showIgnored && i.fixes.map((f, n) => <Button key={n} size="xs" variant="light" onClick={() => confirm(f, i)}>{fixLabel(f, i)}</Button>)}
                  <Button size="xs" variant="default" component={Link} to={i.to}>לתיקון</Button>
                  {canEdit && (showIgnored
                    ? <Button size="xs" variant="subtle" onClick={() => restore(i)}>להחזיר</Button>
                    : <Button size="xs" variant="subtle" color="gray" leftSection={<IconEyeOff size={14} />} onClick={() => setIgnoring(i)}>להתעלם</Button>)}
                </Stack>
              </Group>
            </Paper>
          ))}
          {shown.length > limit && <Button variant="default" onClick={() => setLimit((l) => l + PAGE)}>עוד {Math.min(PAGE, shown.length - limit)} פריטים</Button>}
          </>}
        </>
      )}
      {ignoring && (
        <Modal opened onClose={() => setIgnoring(null)} title={`להתעלם: ${ignoring.label}`}>
          <Stack>
            <Text size="sm">{ignoring.title}</Text>
            <Textarea label="סיבה (לא חובה)" autosize minRows={2} value={reason} onChange={(e) => setReason(e.currentTarget.value)} />
            <Group justify="flex-end"><Button variant="default" onClick={() => setIgnoring(null)}>ביטול</Button><Button onClick={ignore}>להסתיר</Button></Group>
          </Stack>
        </Modal>
      )}
      {scanning && extra.data && (
        <IdFromScans partyId={scanning.partyId} current={scanning.current} onClose={() => { setScanning(null); refresh(); }}
          primary={extra.data.docs.filter((d) => d.entity_type === 'party' && d.entity_id === scanning.partyId && ['passport', 'id_card'].includes(d.doc_type))}
          others={extra.data.docs.filter((d) => d.entity_type === 'party' && d.entity_id === scanning.partyId && !['passport', 'id_card'].includes(d.doc_type))} />
      )}
    </Stack>
  );
}
