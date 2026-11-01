// Data for the manual forms (Yarach, Liana): which apartments each manager handles,
// their expected rent and fee, kept in management_agreements and rent_schedule.
// Both are time-bound: a change closes the current row with valid_to and opens a new
// one from the form's month. Nothing is deleted (CLAUDE.md).

import { lastDay, prevMonth } from '../intake/util';
import type { ManagedUnit } from '../intake/manual';
import { propertyTitle } from './format';
import { must, supabase } from './supabase';
import type { Country } from './types';

export interface ManualConfig {
  kind: 'yarach' | 'liana';
  manager: string;                 // Hebrew name for labels
  area: string;                    // where its apartments are, for the list
  country: Country;
  inArea: (p: { city: string; building: string }) => boolean;
  feeModel: 'none' | 'pct_of_gross';
  defaultFee: number;
}

export const MANUAL: Record<string, ManualConfig> = {
  manual_yarach: {
    kind: 'yarach', manager: 'ירח', area: 'אודסה', country: 'UA', inArea: (p) => p.city === 'Odessa',
    feeModel: 'none', defaultFee: 0,
  },
  manual_liana: {
    kind: 'liana', manager: 'ליאנה', area: 'Alliance, בטומי', country: 'GE', inArea: (p) => /^alliance/i.test(p.building),
    feeModel: 'pct_of_gross', defaultFee: 10,
  },
};

interface Versioned { id: string; valid_from: string; valid_to: string | null }
interface Agreement extends Versioned { manager_party_id: string; fee_pct: number | null }
interface Schedule extends Versioned { amount: number; currency: string }

export interface AreaUnit extends ManagedUnit {
  title: string;
  agreement: Agreement | null;     // this manager's agreement covering the month
  otherManager: string | null;     // someone else manages it in the month
  schedule: Schedule | null;       // expected rent covering the month (UAH)
}

const covers = (v: Pick<Versioned, 'valid_from' | 'valid_to'>, period: string) => v.valid_from <= lastDay(period) && (!v.valid_to || v.valid_to >= period);

export async function loadUnits(cfg: ManualConfig, managerId: string, period: string): Promise<AreaUnit[]> {
  const rows = must(await supabase.from('properties')
    .select(`id, unit_no, building:buildings(name, project:projects(name), city:cities(name_en)),
      ownerships(valid_from, valid_to, party:parties(display_name)),
      management_agreements(id, manager_party_id, fee_pct, valid_from, valid_to, manager:parties(display_name)),
      rent_schedule(id, amount, currency, valid_from, valid_to)`)
    .eq('country_code', cfg.country)) as unknown as {
      id: string; unit_no: string;
      building: { name: string; project: { name: string } | null; city: { name_en: string } };
      ownerships: { valid_from: string; valid_to: string | null; party: { display_name: string } }[];
      management_agreements: (Agreement & { manager: { display_name: string } })[];
      rent_schedule: Schedule[];
    }[];
  return rows
    .filter((p) => cfg.inArea({ city: p.building.city.name_en, building: p.building.name }))
    .map((p) => {
      const current = p.management_agreements.filter((a) => covers(a, period));
      const agreement = current.find((a) => a.manager_party_id === managerId) ?? null;
      const other = current.find((a) => a.manager_party_id !== managerId);
      const schedule = p.rent_schedule.find((s) => s.currency === 'UAH' && covers(s, period)) ?? null;
      const title = propertyTitle(p);
      return {
        id: p.id, title, ref: title,
        owner: p.ownerships.filter((o) => covers(o, period)).map((o) => o.party.display_name).join(', ') || undefined,
        agreement, otherManager: other ? other.manager.display_name : null, schedule,
        expected: schedule ? Number(schedule.amount) : undefined,
        feePct: agreement?.fee_pct != null ? Number(agreement.fee_pct) : cfg.defaultFee,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'he', { numeric: true }));
}

// Ledger opening date (SPEC decision 29): an apartment marked as managed today is
// managed from then, unless the form is for an earlier month.
const OPENING = '2026-01-01';

// Ends `row` before `period`. A row that started in this month is corrected instead,
// since closing it would leave a row that ends before it starts.
async function close(table: 'management_agreements' | 'rent_schedule', row: Versioned, period: string): Promise<'closed' | 'same-month'> {
  const end = lastDay(prevMonth(period));
  if (end < row.valid_from) return 'same-month';
  must(await supabase.from(table).update({ valid_to: end }).eq('id', row.id));
  return 'closed';
}

export interface UnitChange { managed: boolean; expected?: number | null; feePct?: number | null }

export async function saveUnit(cfg: ManualConfig, managerId: string, period: string, u: AreaUnit, c: UnitChange) {
  const from = period < OPENING ? period : OPENING;
  // The manager.
  if (c.managed && !u.agreement) {
    must(await supabase.from('management_agreements').insert({
      property_id: u.id, manager_party_id: managerId, fee_model: cfg.feeModel, fee_pct: c.feePct ?? cfg.defaultFee, valid_from: from,
    }));
  } else if (!c.managed && u.agreement) {
    if (await close('management_agreements', u.agreement, period) === 'same-month') {
      throw new Error(`${u.title}: הניהול התחיל בחודש הזה. כדי לבטל אותו, פנו למנהל המערכת`);
    }
  } else if (c.managed && u.agreement && c.feePct != null && c.feePct !== Number(u.agreement.fee_pct)) {
    if (await close('management_agreements', u.agreement, period) === 'same-month') {
      must(await supabase.from('management_agreements').update({ fee_pct: c.feePct }).eq('id', u.agreement.id));
    } else {
      must(await supabase.from('management_agreements').insert({
        property_id: u.id, manager_party_id: managerId, fee_model: cfg.feeModel, fee_pct: c.feePct, valid_from: period,
      }));
    }
  }
  // Expected rent (Yarach): a new amount from this month on.
  if (c.expected !== undefined && (c.expected ?? 0) !== (u.expected ?? 0)) {
    const amount = c.expected ?? 0;
    if (u.schedule && await close('rent_schedule', u.schedule, period) === 'same-month') {
      must(await supabase.from('rent_schedule').update({ amount }).eq('id', u.schedule.id));
    } else if (amount > 0) {
      must(await supabase.from('rent_schedule').insert({ property_id: u.id, amount, currency: 'UAH', valid_from: u.schedule ? period : from }));
    }
  }
}

// Who holds Yarach's transfers: Gershon, the holder of his own report's source.
export async function gershonId(): Promise<string> {
  const rows = must(await supabase.from('import_sources').select('holder_party_id').eq('adapter', 'gershon_utilities_xlsx').limit(1)) as { holder_party_id: string | null }[];
  if (!rows[0]?.holder_party_id) throw new Error('לא נמצא גרשון כמחזיק הכספים במקורות הדוחות');
  return rows[0].holder_party_id;
}

// A version of this month still waiting for approval: a new one would post twice.
export async function pendingVersion(sourceId: string, scope: string): Promise<string | null> {
  const rows = must(await supabase.from('import_batches').select('id').eq('source_id', sourceId).eq('scope', scope)
    .in('status', ['parsed', 'in_review']).limit(1)) as { id: string }[];
  return rows[0]?.id ?? null;
}
