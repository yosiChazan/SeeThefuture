// What a user did, read from app.audit_log (SPEC decision 90). Pure functions, tested.

export interface AuditRow {
  id: number; at: string; table_name: string; row_id: string | null; action: string;
  old_row: Record<string, unknown> | null; new_row: Record<string, unknown> | null;
}

export const TABLE_HE: Record<string, string> = {
  parties: 'לקוח / איש קשר', party_identity: 'תעודת זהות', party_roles: 'סוג רשומה', party_links: 'בני זוג', company_partners: 'שותף בחברה',
  properties: 'נכס', buildings: 'בניין', projects: 'פרויקט', cities: 'עיר', ownerships: 'בעלות', leases: 'חוזה שכירות',
  rent_schedule: 'שכירות צפויה', management_agreements: 'הסכם ניהול', accounts: 'חשבון', transactions: 'תנועה', entries: 'רישום בתנועה',
  documents: 'מסמך', deals: 'עסקת רכישה', installments: 'תשלום מתוכנן', purchase_payments: 'תשלום ברכישה', charges: 'חיוב',
  utility_contracts: 'שירות', import_batches: 'דוח', import_sources: 'מקור דוחות', external_refs: 'התאמת נכס בדוח',
  activities: 'פעולה בכרטיס', contact_assignments: 'שיוך איש קשר', completeness_dismissals: 'השלמת פרטים',
  profiles: 'משתמש', user_country_roles: 'הרשאה', integrations: 'חיבור (דרופבוקס)', sessions: 'כניסה', statements: 'דוח חודשי',
  tasks: 'משימה', messages: 'הודעה', conversations: 'שיחה', milestones: 'אבן דרך', site_updates: 'עדכון מהשטח', fx_rates: 'שער מטבע',
};

export const ACTION_HE: Record<string, string> = {
  INSERT: 'הוספה', UPDATE: 'עדכון', DELETE: 'מחיקה', VIEW: 'פתיחת מסמך', LOGIN: 'כניסה למערכת',
};

const FIELD_HE: Record<string, string> = {
  display_name: 'שם', first_name: 'שם פרטי', last_name: 'שם משפחה', legal_name: 'שם בדוחות', email: 'מייל', phone: 'טלפון', address: 'כתובת',
  status: 'סטטוס', unit_no: 'מספר דירה', floor: 'קומה', sqm: 'שטח', notes: 'הערות', rent_amount: 'שכירות', rent_currency: 'מטבע',
  start_date: 'התחלה', end_date: 'סיום', deposit_amount: 'פיקדון', valid_from: 'מתאריך', valid_to: 'עד תאריך', share_pct: 'חלק',
  doc_type: 'סוג מסמך', sensitive: 'רגיש', id_number: 'מספר ת"ז', level: 'רמת הרשאה', can_view_sensitive: 'מסמכים רגישים',
  is_admin: 'מנהל מערכת', is_management: 'הנהלה', must_change_password: 'החלפת סיסמה', total_price: 'מחיר', signed_on: 'תאריך רכישה',
  title: 'כותרת', body: 'תוכן', approved_by: 'אושר', approved_at: 'מועד אישור', description: 'תיאור', amount: 'סכום',
};
const IGNORED = new Set(['updated_at', 'created_at', 'uploaded_at', 'id']);

const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

// A short name for the record the row is about.
export function recordLabel(r: AuditRow): string {
  const d = r.new_row ?? r.old_row ?? {};
  if (r.table_name === 'properties') return d.unit_no ? `דירה ${str(d.unit_no)}` : '';
  if (r.table_name === 'transactions') return [str(d.description), d.status === 'posted' ? '(נרשמה)' : d.status === 'void' ? '(בוטלה)' : ''].filter(Boolean).join(' ');
  if (r.table_name === 'import_batches') {
    let notes: Record<string, unknown> = {};
    try { notes = typeof d.notes === 'string' ? JSON.parse(d.notes) : {}; } catch { /* free text */ }
    const st: Record<string, string> = { committed: 'נרשם', rejected: 'נדחה', in_review: 'ממתין', parsed: 'נקלט' };
    return [str(notes.file_name), st[str(d.status)] ? `(${st[str(d.status)]})` : ''].filter(Boolean).join(' ');
  }
  if (r.table_name === 'user_country_roles') return [str(d.country_code), str(d.level)].filter(Boolean).join(' · ');
  for (const k of ['display_name', 'file_name', 'title', 'name', 'id_number', 'description', 'kind', 'check_key']) if (d[k]) return str(d[k]);
  return '';
}

// The fields an update changed, in Hebrew where known.
export function changedFields(r: AuditRow): string[] {
  if (r.action !== 'UPDATE' || !r.old_row || !r.new_row) return [];
  return Object.keys(r.new_row).filter((k) => !IGNORED.has(k) && JSON.stringify(r.new_row![k]) !== JSON.stringify(r.old_row![k])).map((k) => FIELD_HE[k] ?? k);
}

// Where the record lives in the app, when it has a screen.
export function recordLink(r: AuditRow): string | null {
  const d = r.new_row ?? r.old_row ?? {};
  const id = r.row_id ?? str(d.id);
  if (r.action === 'DELETE') return null;
  switch (r.table_name) {
    case 'parties': return id ? `/clients/${id}` : null;
    case 'party_identity': case 'party_roles': return d.party_id ? `/clients/${str(d.party_id)}` : null;
    case 'properties': return id ? `/properties/${id}` : null;
    case 'ownerships': case 'deals': case 'charges': case 'utility_contracts': case 'purchase_payments': return d.property_id ? `/properties/${str(d.property_id)}` : null;
    case 'leases': return id ? `/leases/${id}` : null;
    case 'import_batches': return id ? `/intake/${id}` : null;
    case 'documents': case 'activities': {
      const t = str(d.entity_type), e = str(d.entity_id);
      return !e ? null : t === 'property' ? `/properties/${e}` : t === 'lease' ? `/leases/${e}` : t === 'party' ? `/clients/${e}` : null;
    }
    default: return null;
  }
}

export interface ActivityGroup { first: AuditRow; count: number; at: string; until: string }

// One approved report writes dozens of rows within seconds: consecutive rows of the same
// kind and action, less than two minutes apart, become one line with a count.
export function groupActivity(rows: AuditRow[]): ActivityGroup[] {
  const out: ActivityGroup[] = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    const close = last && Math.abs(new Date(last.until).getTime() - new Date(r.at).getTime()) < 120_000;
    if (last && close && last.first.table_name === r.table_name && last.first.action === r.action && r.action !== 'LOGIN') {
      last.count += 1; last.until = r.at;
    } else out.push({ first: r, count: 1, at: r.at, until: r.at });
  }
  return out;
}
