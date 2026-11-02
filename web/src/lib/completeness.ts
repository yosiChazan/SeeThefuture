// The completeness page (SPEC decision 78): what is missing for clients, properties,
// leases, money and documents, each item with the information the system already has
// that helps fill it in. Pure: the page loads the data, this decides what to show.

export type Group = 'clients' | 'properties' | 'leases' | 'money' | 'documents';
export const GROUP_HE: Record<Group, string> = { clients: 'לקוחות', properties: 'נכסים', leases: 'חוזים', money: 'כסף וקליטה', documents: 'מסמכים' };

export interface Doc { id: string; entity_type: string; entity_id: string; doc_type: string; file_name: string | null; storage_path: string }
export interface Lease {
  id: string; property_id: string; start_date: string | null; end_date: string | null; rent_amount: number | null; rent_currency: string | null;
  deposit_amount: number | null; collect_day: number | null; notes: string | null; tenant: { id: string; display_name: string; phone?: string | null } | null;
}
export interface Ownership { party: { id: string; display_name: string }; share_pct: number; valid_from: string; valid_to: string | null }
export interface Property {
  id: string; title: string; country: string; building_id: string; status: string; sqm: number | null; floor: string | null;
  ownerships: Ownership[]; leases: Lease[];
}
export interface Client {
  id: string; name: string; last_name: string | null; kind: string; phone: string | null; email: string | null; address: string | null;
  id_number: string | null; referred_by: string | null; property_ids: string[];
}
export interface Deal { property_id: string; client_party_id: string; total_price: number | null; price_currency: string | null; signed_on: string | null }
export interface Manager { property_id: string; manager: string; manager_id: string }
export interface Rent { property_id: string; occurred_on: string; amount: number; currency: string }
export interface Batch { id: string; source: string; received_at: string; rows: number; status: string }

export interface Data {
  today: string;
  clients: Client[];
  members: Map<string, string>;          // member party → main party (decision 77)
  docs: Doc[];
  properties: Property[];
  deals: Deal[];
  managers: Manager[];
  rents: Rent[];
  batches: Batch[];
}

// One line of context: text, documents to open, or a link.
export interface Context { label: string; text?: string; docs?: Doc[]; to?: string; toText?: string; docTypes?: boolean }
export type Fix =
  | { kind: 'status'; propertyId: string; status: 'rented' | 'vacant' }
  | { kind: 'contact'; partyId: string }
  | { kind: 'link'; mainId: string; memberId: string }
  | { kind: 'scan-id'; partyId: string }
  | { kind: 'close-lease'; leaseId: string; endDate: string };

export interface Item {
  key: string;                 // the check, e.g. "client_no_phone"
  group: Group;
  entityId: string;            // what an "ignore" is recorded on
  label: string;               // the check, in Hebrew
  title: string;               // the record
  to: string;                  // its card
  priority: number;            // lower first: money first, documents last
  context: Context[];
  fixes: Fix[];
}

const PASSPORT = ['passport', 'id_card'];
const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const fmt = (d: string | null) => (d ? d.split('-').reverse().join('.') : '—');
const money = (n: number | null | undefined, c?: string | null) => (n === null || n === undefined ? '—' : `${Number(n).toLocaleString('en-US')} ${c ?? ''}`.trim());
const active = (l: Lease, today: string) => !!l.start_date && l.start_date <= today && (!l.end_date || l.end_date >= today);
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function findItems(d: Data): Item[] {
  const items: Item[] = [];
  const add = (i: Item) => items.push(i);
  const docsOf = (type: string, id: string) => d.docs.filter((x) => x.entity_type === type && x.entity_id === id);
  const propById = new Map(d.properties.map((p) => [p.id, p]));
  const rentBy = new Map(d.rents.map((r) => [r.property_id, r]));
  const dealsBy = new Map<string, Deal[]>(); for (const x of d.deals) dealsBy.set(x.property_id, [...(dealsBy.get(x.property_id) ?? []), x]);
  const managerBy = new Map(d.managers.map((m) => [m.property_id, m]));
  const clientById = new Map(d.clients.map((c) => [c.id, c]));
  // A client and its partners are one client: their properties count together.
  const household = (c: Client) => [c.id, ...[...d.members].filter(([, main]) => main === c.id).map(([m]) => m)];
  const propsOf = (c: Client) => [...new Set(household(c).flatMap((id) => clientById.get(id)?.property_ids ?? []))].map((id) => propById.get(id)).filter((p): p is Property => !!p);
  const card = (c: Client) => `/clients/${c.id}`;

  // ---- Clients ---------------------------------------------------------------
  for (const c of d.clients) {
    const mine = docsOf('party', c.id);
    const passports = mine.filter((x) => PASSPORT.includes(x.doc_type));
    const others = mine.filter((x) => !PASSPORT.includes(x.doc_type) && x.doc_type !== 'poa');
    const isMember = d.members.has(c.id);
    const base = { group: 'clients' as const, entityId: c.id, title: c.name, to: card(c) };
    if (!c.id_number) add({ ...base, key: 'client_no_id', label: 'אין מספר זהות', priority: 30,
      context: [{ label: 'צילומי דרכון / ת"ז', docs: passports, text: passports.length ? undefined : 'אין' }, ...(others.length ? [{ label: 'מסמכים אחרים', docs: others }] : [])],
      fixes: mine.length ? [{ kind: 'scan-id', partyId: c.id }] : [] });
    if (!c.phone) add({ ...base, key: 'client_no_phone', label: 'אין טלפון', priority: 35,
      context: [{ label: 'מייל', text: c.email ?? '—' }, ...(c.referred_by ? [{ label: 'הגיע דרך', text: c.referred_by }] : [])], fixes: [] });
    if (!c.email) add({ ...base, key: 'client_no_email', label: 'אין מייל', priority: 36, context: [{ label: 'טלפון', text: c.phone ?? '—' }], fixes: [] });
    if (!passports.length) add({ ...base, key: 'client_no_id_doc', label: 'אין צילום דרכון או ת"ז', priority: 60,
      context: [{ label: 'מספר זהות', text: c.id_number ?? '—' }, ...(others.length ? [{ label: 'מסמכים אחרים (אולי אחד מהם דרכון)', docs: others, docTypes: true }] : [])], fixes: [] });
    const props = propsOf(c);
    const poa = [...mine, ...props.flatMap((p) => docsOf('property', p.id))].some((x) => x.doc_type === 'poa');
    if (!poa && props.length) add({ ...base, key: 'client_no_poa', label: 'אין ייפוי כוח', priority: 65,
      context: [{ label: 'נכסים', text: props.map((p) => p.title).join(' · ') }, ...(others.length ? [{ label: 'מסמכים אחרים', docs: others, docTypes: true }] : [])], fixes: [] });
    if (!props.length && !isMember) {
      const deals = d.deals.filter((x) => x.client_party_id === c.id);
      add({ ...base, key: 'client_no_property', label: 'לקוח בלי נכס', priority: 40,
        context: [{ label: 'עסקאות', text: deals.length ? `${deals.length}` : 'אין' }, { label: 'מסמכים', text: `${mine.length}` }],
        fixes: [{ kind: 'contact', partyId: c.id }] });
    }
  }
  // Possibly the same client, or a couple: same ID, same family name, or same address.
  const seen = new Set<string>();
  const people = d.clients.filter((c) => c.kind === 'person' && !d.members.has(c.id));
  for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
    const a = people[i], b = people[j];
    const why = a.id_number && a.id_number === b.id_number ? 'אותו מספר זהות'
      : a.last_name && b.last_name && norm(a.last_name) === norm(b.last_name) ? 'אותו שם משפחה'
      : a.address && b.address && norm(a.address).length > 6 && norm(a.address) === norm(b.address) ? 'אותה כתובת' : null;
    if (!why || d.members.get(a.id) === b.id || d.members.get(b.id) === a.id) continue;
    const pair = [a.id, b.id].sort().join(':');
    if (seen.has(pair)) continue; seen.add(pair);
    const line = (c: Client) => `${c.name} · ת"ז ${c.id_number ?? '—'} · ${c.phone ?? 'אין טלפון'} · ${propsOf(c).length} נכסים`;
    add({ group: 'clients', key: 'client_duplicate', entityId: a.id < b.id ? a.id : b.id, label: `אולי לקוח אחד (${why})`, title: `${a.name} / ${b.name}`, to: card(a), priority: 45,
      context: [{ label: 'ראשון', text: line(a), to: card(a), toText: 'לכרטיס' }, { label: 'שני', text: line(b), to: card(b), toText: 'לכרטיס' }],
      fixes: [{ kind: 'link', mainId: a.id, memberId: b.id }, { kind: 'link', mainId: b.id, memberId: a.id }] });
  }

  // ---- Properties ------------------------------------------------------------
  for (const p of d.properties) {
    const base = { group: 'properties' as const, entityId: p.id, title: p.title, to: `/properties/${p.id}` };
    const now = p.leases.filter((l) => active(l, d.today));
    const pdocs = docsOf('property', p.id);
    const owners = p.ownerships.filter((o) => !o.valid_to || o.valid_to >= d.today);
    const leaseLine = (l: Lease) => `${l.tenant?.display_name ?? 'ללא שוכר'} · ${fmt(l.start_date)}–${fmt(l.end_date)} · ${money(l.rent_amount, l.rent_currency)}`;
    if (p.status === 'sold') {
      if (now.length) add({ ...base, key: 'property_sold_active_lease', label: 'מסומן "נמכר" ויש חוזה פעיל', priority: 20,
        context: [{ label: 'חוזה', text: leaseLine(now[0]), to: `/leases/${now[0].id}`, toText: 'לחוזה' }, { label: 'שכירות אחרונה', text: rentBy.get(p.id) ? `${fmt(rentBy.get(p.id)!.occurred_on)} · ${money(rentBy.get(p.id)!.amount, rentBy.get(p.id)!.currency)}` : '—' }], fixes: [] });
      continue;
    }
    if (now.length && !['rented', 'short_term'].includes(p.status)) add({ ...base, key: 'property_lease_not_rented', label: 'יש חוזה פעיל, הסטטוס לא "מושכר"', priority: 15,
      context: [{ label: 'חוזה', text: leaseLine(now[0]), to: `/leases/${now[0].id}`, toText: 'לחוזה' }], fixes: [{ kind: 'status', propertyId: p.id, status: 'rented' }] });
    if (p.status === 'rented' && !now.length) {
      const last = [...p.leases].sort((a, b) => (b.end_date ?? '').localeCompare(a.end_date ?? ''))[0];
      add({ ...base, key: 'property_rented_no_lease', label: '"מושכר" בלי חוזה פעיל', priority: 15,
        context: [{ label: 'החוזה האחרון', text: last ? leaseLine(last) : 'אין חוזים', ...(last ? { to: `/leases/${last.id}`, toText: 'לחוזה' } : {}) }],
        fixes: [{ kind: 'status', propertyId: p.id, status: 'vacant' }] });
    }
    const purchase = pdocs.filter((x) => x.doc_type === 'purchase_contract');
    const land = pdocs.filter((x) => ['land_registry', 'land_book'].includes(x.doc_type));
    const other = pdocs.filter((x) => !['purchase_contract', 'land_registry', 'land_book'].includes(x.doc_type));
    const deals = dealsBy.get(p.id) ?? [];
    if (owners.some((o) => o.valid_from === '2000-01-01')) add({ ...base, key: 'property_unknown_start', label: 'תאריך רכישה לא ידוע', priority: 55,
      context: [{ label: 'תאריך העסקה', text: fmt(deals[0]?.signed_on ?? null) }, { label: 'חוזה רכישה', docs: purchase, text: purchase.length ? undefined : 'אין' }], fixes: [] });
    if (p.sqm === null) add({ ...base, key: 'property_no_sqm', label: 'אין מ"ר', priority: 58, context: [{ label: 'חוזה רכישה / נסח', docs: [...purchase, ...land], text: purchase.length + land.length ? undefined : 'אין' }], fixes: [] });
    if (!p.floor) add({ ...base, key: 'property_no_floor', label: 'אין קומה', priority: 59, context: [{ label: 'חוזה רכישה / נסח', docs: [...purchase, ...land], text: purchase.length + land.length ? undefined : 'אין' }], fixes: [] });
    if (!purchase.length) add({ ...base, key: 'property_no_purchase_contract', label: 'אין חוזה רכישה', priority: 70,
      context: other.length ? [{ label: 'מסמכים אחרים של הנכס (אולי אחד מהם החוזה)', docs: other, docTypes: true }] : [{ label: 'מסמכי הנכס', text: 'אין' }], fixes: [] });
    if (!land.length) add({ ...base, key: 'property_no_land_registry', label: 'אין נסח טאבו / Land book', priority: 71,
      context: other.length ? [{ label: 'מסמכים אחרים של הנכס', docs: other, docTypes: true }] : [{ label: 'מסמכי הנכס', text: 'אין' }], fixes: [] });
    const ownersLine = owners.map((o) => `${o.party.display_name} ${Number(o.share_pct)}% מ-${o.valid_from === '2000-01-01' ? 'לא ידוע' : fmt(o.valid_from)}`).join(' · ') || '—';
    if (!deals.length) add({ ...base, key: 'property_no_deal', label: 'אין עסקת רכישה', priority: 57,
      context: [{ label: 'בעלים', text: ownersLine }, { label: 'חוזה רכישה', docs: purchase, text: purchase.length ? undefined : 'אין' }], fixes: [] });
    else if (deals.every((x) => x.total_price === null)) add({ ...base, key: 'property_deal_no_price', label: 'עסקה בלי מחיר', priority: 57,
      context: [{ label: 'בעלים', text: ownersLine }, { label: 'חוזה רכישה', docs: purchase, text: purchase.length ? undefined : 'אין' }], fixes: [] });
    if (['rented', 'short_term'].includes(p.status) && !managerBy.has(p.id)) {
      const near = [...new Set(d.properties.filter((x) => x.building_id === p.building_id && managerBy.has(x.id)).map((x) => managerBy.get(x.id)!.manager))];
      add({ ...base, key: 'property_no_manager', label: 'נכס מושכר בלי מנהל מקומי', priority: 50,
        context: [{ label: 'מנהלים של דירות באותו בניין', text: near.join(', ') || 'אין' }], fixes: [] });
    }
    const shares = owners.reduce((a, o) => a + Number(o.share_pct), 0);
    if (!owners.length || Math.abs(shares - 100) > 0.01) add({ ...base, key: 'property_owner_shares', label: owners.length ? `סך חלקי הבעלות ${shares}%` : 'נכס בלי בעלים', priority: 10,
      context: [{ label: 'בעלים', text: ownersLine }], fixes: [] });

    // ---- Leases of the property ----------------------------------------------
    const prev = (l: Lease) => p.leases.filter((x) => x.id !== l.id && (x.start_date ?? '') < (l.start_date ?? '')).sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0];
    for (const l of now) {
      const lb = { group: 'leases' as const, entityId: l.id, title: `${l.tenant?.display_name ?? 'ללא שוכר'} · ${p.title}`, to: `/leases/${l.id}` };
      const ldocs = docsOf('lease', l.id);
      const before = prev(l);
      if (!l.tenant) add({ ...lb, key: 'lease_no_tenant', label: 'חוזה פעיל בלי שוכר', priority: 25,
        context: [{ label: 'קובצי החוזה', docs: ldocs, text: ldocs.length ? undefined : 'אין' }, ...(l.notes ? [{ label: 'הערות', text: l.notes }] : []),
          { label: 'שוכרים קודמים בנכס', text: [...new Set(p.leases.filter((x) => x.id !== l.id && x.tenant).map((x) => x.tenant!.display_name))].join(', ') || '—' }], fixes: [] });
      if (!l.rent_amount) add({ ...lb, key: 'lease_no_rent', label: 'חוזה פעיל בלי סכום שכירות', priority: 12,
        context: [{ label: 'החוזה הקודם', text: before ? money(before.rent_amount, before.rent_currency) : '—' },
          { label: 'שכירות אחרונה שנרשמה', text: rentBy.get(p.id) ? `${fmt(rentBy.get(p.id)!.occurred_on)} · ${money(rentBy.get(p.id)!.amount, rentBy.get(p.id)!.currency)}` : '—' }], fixes: [] });
      if (!l.end_date) add({ ...lb, key: 'lease_no_end', label: 'חוזה פעיל בלי תאריך סיום', priority: 32,
        context: [{ label: 'התחלה', text: fmt(l.start_date) }, { label: 'קובצי החוזה', docs: ldocs, text: ldocs.length ? undefined : 'אין' }], fixes: [] });
      if (l.deposit_amount === null) add({ ...lb, key: 'lease_no_deposit', label: 'בלי פיקדון', priority: 52,
        context: [{ label: 'בחוזה הקודם', text: before ? money(before.deposit_amount, before.rent_currency) : '—' }], fixes: [] });
      if (l.collect_day === null) add({ ...lb, key: 'lease_no_collect_day', label: 'בלי יום גבייה', priority: 53,
        context: [{ label: 'בחוזה הקודם', text: before?.collect_day ? `${before.collect_day} בחודש` : '—' },
          { label: 'שכירות אחרונה שנרשמה', text: rentBy.get(p.id) ? fmt(rentBy.get(p.id)!.occurred_on) : '—' }], fixes: [] });
      if (!ldocs.some((x) => x.doc_type === 'lease_contract')) add({ ...lb, key: 'lease_no_contract_doc', label: 'חוזה פעיל בלי "חוזה חתום"', priority: 72,
        context: [{ label: 'מסמכי החוזה', docs: ldocs, text: ldocs.length ? undefined : 'אין', docTypes: true }], fixes: [] });
      if (l.end_date && l.end_date <= addDays(d.today, 60)) add({ ...lb, key: 'lease_ending', label: `החוזה מסתיים ב-${fmt(l.end_date)}`, priority: 5,
        context: [{ label: 'שוכר', text: `${l.tenant?.display_name ?? '—'}${l.tenant?.phone ? ` · ${l.tenant.phone}` : ''}` }, { label: 'שכירות', text: money(l.rent_amount, l.rent_currency) }], fixes: [] });
      const rent = rentBy.get(p.id);
      if ((l.start_date ?? '') <= addDays(d.today, -60) && (!rent || rent.occurred_on < addDays(d.today, -60))) add({ group: 'money', key: 'money_rent_missing', entityId: l.id,
        label: 'לא נרשמה שכירות בחודשיים האחרונים', title: lb.title, to: `/properties/${p.id}`, priority: 1,
        context: [{ label: 'שכירות אחרונה', text: rent ? `${fmt(rent.occurred_on)} · ${money(rent.amount, rent.currency)}` : 'אף פעם' },
          { label: 'מנהל', text: managerBy.get(p.id)?.manager ?? '—' }, { label: 'שכירות בחוזה', text: money(l.rent_amount, l.rent_currency) }], fixes: [] });
    }
    // A lease ended in the last 90 days and nothing replaced it.
    const ended = p.leases.filter((l) => l.end_date && l.end_date < d.today && l.end_date >= addDays(d.today, -90));
    if (ended.length && !now.length) {
      const l = ended.sort((a, b) => b.end_date!.localeCompare(a.end_date!))[0];
      const rent = rentBy.get(p.id);
      add({ group: 'leases', key: 'lease_ended_no_new', entityId: l.id, label: `חוזה הסתיים ב-${fmt(l.end_date)} ואין חוזה חדש`, title: `${l.tenant?.display_name ?? 'ללא שוכר'} · ${p.title}`, to: `/properties/${p.id}`, priority: 8,
        context: [{ label: 'החוזה שהסתיים', text: leaseLine(l), to: `/leases/${l.id}`, toText: 'לחוזה' }, { label: 'שכירות אחרונה', text: rent ? `${fmt(rent.occurred_on)} · ${money(rent.amount, rent.currency)}` : '—' }],
        fixes: p.status === 'rented' ? [{ kind: 'status', propertyId: p.id, status: 'vacant' }] : [] });
    }
    // Overlapping leases (often an extension recorded as a new lease).
    const recent = p.leases.filter((l) => l.start_date && (!l.end_date || l.end_date >= addDays(d.today, -365))).sort((a, b) => a.start_date!.localeCompare(b.start_date!));
    for (let i = 0; i < recent.length; i++) for (let j = i + 1; j < recent.length; j++) {
      const a = recent[i], b = recent[j];
      if (!(b.start_date! <= (a.end_date ?? '9999-12-31'))) continue;
      add({ group: 'leases', key: 'lease_overlap', entityId: b.id, label: 'חוזים חופפים', title: p.title, to: `/properties/${p.id}`, priority: 54,
        context: [{ label: 'הקודם', text: leaseLine(a), to: `/leases/${a.id}`, toText: 'לחוזה' }, { label: 'החדש', text: leaseLine(b), to: `/leases/${b.id}`, toText: 'לחוזה' }],
        fixes: [{ kind: 'close-lease', leaseId: a.id, endDate: addDays(b.start_date!, -1) }] });
    }
  }

  // ---- Money and intake --------------------------------------------------------
  for (const b of d.batches) if (['parsed', 'in_review'].includes(b.status) && b.received_at.slice(0, 10) < addDays(d.today, -14)) {
    add({ group: 'money', key: 'money_batch_pending', entityId: b.id, label: 'דוח ממתין לאישור מעל 14 יום', title: b.source, to: `/intake/${b.id}`, priority: 3,
      context: [{ label: 'התקבל', text: fmt(b.received_at.slice(0, 10)) }, { label: 'שורות', text: `${b.rows}` }], fixes: [] });
  }

  // ---- Documents -----------------------------------------------------------------
  for (const doc of d.docs) if (doc.entity_type === 'party' && doc.doc_type === 'attachment' && clientById.has(doc.entity_id)) {
    const c = clientById.get(doc.entity_id)!;
    add({ group: 'documents', key: 'document_unclassified', entityId: doc.id, label: 'מסמך מסוג "אחר", אולי דרכון או ת"ז', title: c.name, to: card(c), priority: 80,
      context: [{ label: 'הקובץ', docs: [doc], docTypes: true }], fixes: [] });
  }

  return items.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title, 'he'));
}
