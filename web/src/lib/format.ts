import dayjs from 'dayjs';
import type { Country, Currency, Lease, Ownership, Property, PropertyStatus } from './types';

export const COUNTRY_HE: Record<Country, string> = { UA: 'אוקראינה', RO: 'רומניה', GE: 'גאורגיה', GR: 'יוון' };
export const COUNTRIES: Country[] = ['UA', 'RO', 'GE', 'GR'];

export const STATUS_HE: Record<PropertyStatus, string> = {
  under_construction: 'בבנייה',
  vacant: 'פנוי',
  rented: 'מושכר',
  short_term: 'השכרה קצרה',
  owner_use: 'בשימוש הבעלים',
  sold: 'נמכר',
};
export const STATUS_COLOR: Record<PropertyStatus, string> = {
  under_construction: 'orange', vacant: 'gray', rented: 'teal', short_term: 'blue', owner_use: 'grape', sold: 'dark',
};

// Every currency is shown on its own (SPEC §6.2); amounts are never converted.
export const CURRENCY_SIGN: Record<Currency, string> = { ILS: '₪', USD: '$', EUR: '€', UAH: '₴', RON: 'lei', GEL: '₾' };
export const CURRENCIES = Object.keys(CURRENCY_SIGN) as Currency[];

export const ACCOUNT_KIND_HE: Record<string, string> = {
  rent_pool: 'קופת שכירות', expense_pool: 'קופת הוצאות', manager_cash: 'מזומן אצל מנהל',
  hotel_balance: 'יתרה במלון', client_bank: 'חשבון בנק של הלקוח', company: 'חשבון חברה', legacy_card: 'כרטיס ישן',
};

export function money(amount: number | null | undefined, currency: Currency | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(amount);
  return currency ? `${n} ${CURRENCY_SIGN[currency]}` : n;
}

export function date(d: string | null | undefined): string {
  return d ? dayjs(d).format('DD.MM.YYYY') : '—';
}

export const today = () => dayjs().format('YYYY-MM-DD');

export function isActiveLease(l: Lease, on = today()): boolean {
  return !!l.start_date && l.start_date <= on && (!l.end_date || l.end_date >= on);
}

export function isIncompleteLease(l: Lease): boolean {
  return !l.start_date || l.rent_amount === null || !l.rent_currency;
}

export function isCurrentOwnership(o: Ownership, on = today()): boolean {
  return o.valid_from <= on && (!o.valid_to || o.valid_to >= on);
}

export function currentLease(p: Property): Lease | undefined {
  return p.leases.filter((l) => isActiveLease(l)).sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0];
}

// Names mix Latin, digits and Hebrew ("32-LOT1-BIG", "Balcescu 32-34"). Each one
// is wrapped in a Unicode isolate so the bidi algorithm keeps it in one piece.
const iso = (s: string) => `\u2068${s}\u2069`;

// Ukrainian buildings are numbered inside a project ("Lake city", building 2.4).
export function buildingLabel(b: { name: string; project?: { name: string } | null }): string {
  if (!/^[\d.]+$/.test(b.name)) return iso(b.name);
  return b.project ? `${iso(b.project.name)} · בניין ${iso(b.name)}` : `בניין ${iso(b.name)}`;
}

export function propertyTitle(p: { unit_no: string; building: { name: string; project?: { name: string } | null } }): string {
  return `דירה ${iso(p.unit_no)} · ${buildingLabel(p.building)}`;
}

export function owners(p: Property): string {
  return p.ownerships.filter((o) => isCurrentOwnership(o)).map((o) => o.party.display_name).join(', ');
}
