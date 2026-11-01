import { useQuery } from '@tanstack/react-query';
import { ADAPTERS } from '../intake/adapters';
import { bookFromXlsx } from '../intake/grid';
import { matchProperty, sameTenant, type PropertyForMatch } from '../intake/match';
import type { ParseResult, ParsedLease, ParsedRow, ProposedTransaction } from '../intake/types';
import { must, supabase } from './supabase';
import type { Country } from './types';

export interface Source { id: string; name: string; adapter: string; country_code: Country; active: boolean }
export type BatchStatus = 'parsed' | 'in_review' | 'committed' | 'rejected';
export type RowStatus = 'matched' | 'unmatched' | 'duplicate' | 'ignored';

// Stored in import_batches.notes: what the adapter found about the file as a whole.
export interface BatchNotes { period: string; file_name: string; warnings: string[]; checks?: string[] }

export interface Batch {
  id: string;
  country_code: Country;
  file_path: string | null;
  received_at: string;
  status: BatchStatus;
  reviewed_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  notes: string | null;
  source: Source;
  rows: { count: number }[];
}

export interface ImportRow {
  id: string;
  row_ref: string;
  raw: Record<string, unknown> & {
    row: number; property_ref: string; owner?: string; kind: string; match_note?: string; candidates?: string[];
    // Discrepancies a person must look at; approval waits until `checked` is set.
    errors?: string[]; checked?: boolean;
    // Updated reports: the transaction this row replaces, or voids because the row is gone.
    replaces?: string; voids?: string;
    // A lease to add, or to update when lease_id is set (SPEC decision 51).
    lease?: { tenant: string; start: string | null; end: string | null; rent: number | null; deposit: number | null; currency: string; notes: string; withholding?: number; lease_id?: string };
  };
  proposed: ProposedTransaction | null;
  match_status: RowStatus;
  issues: string[] | null;
  property_id: string | null;
  transaction_id: string | null;
}

export const batchNotes = (b: Pick<Batch, 'notes'>): BatchNotes | null => {
  try { return b.notes ? JSON.parse(b.notes) as BatchNotes : null; } catch { return null; }
};

export function useSources() {
  return useQuery({
    queryKey: ['import-sources'],
    queryFn: async () => must(await supabase.from('import_sources').select('id, name, adapter, country_code, active').eq('active', true).order('name')) as Source[],
  });
}

const BATCH_COLS = 'id, country_code, file_path, received_at, status, reviewed_at, voided_at, void_reason, notes, source:import_sources(id, name, adapter, country_code, active), rows:import_rows(count)';

export function useBatches() {
  return useQuery({
    queryKey: ['import-batches'],
    queryFn: async () => must(await supabase.from('import_batches').select(BATCH_COLS).order('received_at', { ascending: false }).limit(200)) as unknown as Batch[],
  });
}

export function useBatch(id: string) {
  return useQuery({
    queryKey: ['import-batch', id],
    queryFn: async () => {
      const batch = must(await supabase.from('import_batches').select(BATCH_COLS).eq('id', id).single()) as unknown as Batch;
      const rows = must(await supabase.from('import_rows')
        .select('id, row_ref, raw, proposed, match_status, issues, property_id, transaction_id').eq('batch_id', id)) as ImportRow[];
      rows.sort((a, b) => a.raw.row - b.raw.row || a.row_ref.localeCompare(b.row_ref));
      return { batch, rows };
    },
  });
}

async function propertiesForMatch(country: Country): Promise<PropertyForMatch[]> {
  const rows = must(await supabase.from('properties')
    .select('id, unit_no, country_code, building:buildings(name, project:projects(name)), ownerships(valid_to, party:parties(display_name, legal_name))')
    .eq('country_code', country)) as unknown as {
      id: string; unit_no: string; country_code: string;
      building: { name: string; project: { name: string } | null };
      ownerships: { valid_to: string | null; party: { display_name: string; legal_name: string | null } }[];
    }[];
  return rows.map((p) => ({
    id: p.id, unit_no: p.unit_no, country_code: p.country_code, building: p.building.name, project: p.building.project?.name ?? null,
    // Reports name owners in Latin letters: the name as in the reports counts too (SPEC decision 62).
    owners: p.ownerships.filter((o) => !o.valid_to).flatMap((o) => [o.party.display_name, o.party.legal_name ?? ''].filter(Boolean)),
  }));
}

const POSTED = 'row_ref, fingerprint, raw, proposed, property_id, batch:import_batches!inner(source_id, scope), transaction:transactions!import_rows_transaction_id_fkey!inner(id, status)';
type PostedRow = {
  row_ref: string; fingerprint: string | null; raw: { property_ref?: string; kind?: string }; proposed: ProposedTransaction;
  property_id: string | null; transaction: { id: string };
};

// What this source already posted. `exact`: fingerprints anywhere ("already imported").
// `earlier`: what was posted from the same scope (the owner's file, the month) and is
// not in this version as it is: these rows were either changed or removed since.
async function alreadyPosted(sourceId: string, result: ParseResult) {
  const fps = [...new Set(result.rows.map((r) => r.fingerprint).filter((f): f is string => !!f))];
  const exact = new Set<string>();
  for (let i = 0; i < fps.length; i += 40) {
    const rows = must(await supabase.from('import_rows').select(POSTED).eq('transaction.status', 'posted')
      .in('fingerprint', fps.slice(i, i + 40))) as unknown as PostedRow[];
    rows.forEach((r) => exact.add(r.fingerprint!));
  }
  const earlier: PostedRow[] = [];
  if (result.scope) {
    for (let from = 0; ; from += 1000) {
      const page = must(await supabase.from('import_rows').select(POSTED)
        .eq('batch.source_id', sourceId).eq('batch.scope', result.scope).eq('transaction.status', 'posted')
        .not('proposed', 'is', null).order('row_ref').range(from, from + 999)) as unknown as PostedRow[];
      earlier.push(...page);
      if (page.length < 1000) break;
    }
  }
  const inFile = new Set(fps);
  const byKey = new Map<string, PostedRow[]>();
  for (const r of earlier) {
    if (r.fingerprint && inFile.has(r.fingerprint)) continue;
    const k = identity(r.raw.property_ref ?? '', r.proposed, (r.raw as Record<string, unknown>).source_text);
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  return { exact, byKey };
}

// The source's own text when the adapter keeps it (Itai), so a translated description
// still matches the row it describes.
const identity = (ref: string, p: ProposedTransaction, source?: unknown) => [ref, p.category, p.occurred_on, p.period, typeof source === 'string' ? source : p.description].join('|');
const amountOf = (p: ProposedTransaction) => p.entries.map((e) => `${e.amount} ${e.currency}`).join(' / ');

export async function readReport(source: Source, file: File): Promise<ParseResult> {
  const adapter = ADAPTERS[source.adapter];
  if (!adapter) throw new Error('למקור הזה עוד אין קורא קבצים');
  return adapter.parse(await bookFromXlsx(await file.arrayBuffer()), file.name);
}

// Parses nothing itself: takes the adapter's result, matches properties, marks
// duplicates and changes, stores the original file and writes the batch for review.
export async function createBatch(source: Source, file: File, result: ParseResult): Promise<string> {
  const [properties, refs, posted] = await Promise.all([
    propertiesForMatch(source.country_code),
    supabase.from('external_refs').select('external_key, entity_id').eq('source', source.adapter).eq('entity_type', 'property'),
    alreadyPosted(source.id, result),
  ]);
  const known = new Map((must(refs) as { external_key: string; entity_id: string }[]).map((r) => [r.external_key, r.entity_id]));

  const id = crypto.randomUUID();
  must(await supabase.from('import_batches').insert({
    id, source_id: source.id, country_code: source.country_code, status: 'in_review', scope: result.scope ?? null,
    notes: JSON.stringify({ period: result.period, file_name: file.name, warnings: result.warnings, checks: result.checks ?? [] } satisfies BatchNotes),
  }));

  const safeName = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_');
  const path = `${source.country_code}/${id}/${safeName}`;
  const up = await supabase.storage.from('imports').upload(path, file, { contentType: file.type || undefined });
  if (up.error) throw new Error(`שמירת הקובץ נכשלה: ${up.error.message}`);
  must(await supabase.from('import_batches').update({ file_path: path }).eq('id', id));

  const matches = new Map<string, ReturnType<typeof matchProperty>>();
  // An opening balance is proposed by every report but posted once (Gershon, SPEC decision 43).
  const fresh = result.rows.filter((r) => !(r.proposed?.category === 'opening_balance' && r.fingerprint && posted.exact.has(r.fingerprint)));
  type NewRow = Omit<ImportRow, 'id' | 'transaction_id'> & { batch_id: string; fingerprint: string | null };
  const rows = fresh.map((r: ParsedRow): NewRow => {
    if (!matches.has(r.property.ref)) matches.set(r.property.ref, matchProperty(r.property, source.country_code, properties, known));
    const m = matches.get(r.property.ref)!;
    const issues = [...r.issues];
    let status: RowStatus = !r.proposed ? 'ignored' : m.propertyId ? 'matched' : 'unmatched';
    const errors = [...r.errors];
    let replaces: string | undefined;
    if (r.proposed && r.fingerprint && posted.exact.has(r.fingerprint)) status = 'duplicate';
    else if (r.proposed) {
      // The same row as in the earlier version, with a different amount: replace it.
      const before = posted.byKey.get(identity(r.property.ref, r.proposed, r.raw.source_text))?.shift();
      if (before) {
        replaces = before.transaction.id;
        errors.push(`השורה השתנתה מהגרסה הקודמת: היה ${amountOf(before.proposed)}, עכשיו ${amountOf(r.proposed)}. באישור, התנועה הקודמת תבוטל והחדשה תירשם`);
      }
    }
    return {
      batch_id: id, row_ref: r.ref, proposed: r.proposed, fingerprint: r.fingerprint, issues,
      property_id: m.propertyId, match_status: status,
      raw: {
        ...r.raw, row: Number(r.raw.row ?? 0), property_ref: String(r.raw.property_ref ?? r.property.ref),
        kind: r.kind, owner: r.property.owner, match_note: m.note, candidates: m.candidates, errors, ...(replaces ? { replaces } : {}),
      },
    };
  });
  // Posted from the earlier version and gone from this one: offered for voiding.
  for (const old of [...posted.byKey.values()].flat()) {
    rows.push({
      batch_id: id, row_ref: `removed:${old.row_ref}`, proposed: null, fingerprint: null, issues: [],
      property_id: old.property_id, match_status: 'matched',
      raw: {
        row: 1_000_000, property_ref: old.raw.property_ref ?? '', kind: 'נמחקה מהקובץ', voids: old.transaction.id,
        description: `${old.proposed.description} (${old.proposed.occurred_on.split('-').reverse().join('.')}, ${amountOf(old.proposed)})`,
        errors: ['השורה נמחקה מהגרסה החדשה של הקובץ. באישור, התנועה שנרשמה ממנה תבוטל'],
      },
    });
  }
  const leases = new Map<string, ExistingLease[]>();
  for (const l of result.leases ?? []) {
    if (!matches.has(l.property.ref)) matches.set(l.property.ref, matchProperty(l.property, source.country_code, properties, known));
    rows.push(await leaseRow(id, l, matches.get(l.property.ref)!, leases));
  }
  for (let i = 0; i < rows.length; i += 200) must(await supabase.from('import_rows').insert(rows.slice(i, i + 200)));
  return id;
}

type ExistingLease = { id: string; start_date: string | null; end_date: string | null; rent_amount: number | null; deposit_amount: number | null; tenant: { display_name: string } | null };
const days = (a: string, b: string) => Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
const d = (s: string | null) => (s ? s.split('-').reverse().join('.') : '—');

// Compares a lease from the report with the leases of the same tenant on the property.
// Same lease: the one starting within a month, or a later one (Airtable recorded each
// extension as its own lease). Identical terms: nothing to do. Otherwise the change is
// an error to check, so a person sees it before the lease is touched.
async function leaseRow(batchId: string, l: ParsedLease, m: ReturnType<typeof matchProperty>, leaseCache: Map<string, ExistingLease[]>) {
  const errors = [...l.errors];
  const issues = [l.contract, l.notes].filter(Boolean);
  let status: RowStatus = m.propertyId ? 'matched' : 'unmatched';
  let leaseId: string | undefined;
  if (m.propertyId) {
    if (!leaseCache.has(m.propertyId)) {
      leaseCache.set(m.propertyId, must(await supabase.from('leases')
        .select('id, start_date, end_date, rent_amount, deposit_amount, tenant:parties(display_name)').eq('property_id', m.propertyId)) as unknown as ExistingLease[]);
    }
    const mine = leaseCache.get(m.propertyId)!.filter((x) => x.tenant && sameTenant(x.tenant.display_name, l.tenant));
    const near = l.start ? mine.filter((x) => x.start_date && days(x.start_date, l.start!) <= 31) : [];
    const later = l.start ? mine.filter((x) => x.start_date && x.start_date > l.start!) : [];
    const target = (near.length ? near : later).sort((a, b) => (b.start_date ?? '').localeCompare(a.start_date ?? ''))[0];
    // A row Itai hid is his archive of past leases: added when missing, never used to change one.
    if (target && l.hidden) {
      status = 'duplicate';
      issues.push('חוזה קודם שאיתי הסתיר בקובץ. כבר קיים במערכת, ולא משנים אותו לפי השורה המוסתרת');
    } else if (target) {
      const changes = [
        l.end && l.end !== target.end_date ? `סיום ${d(target.end_date)} → ${d(l.end)}` : '',
        l.rent !== null && Number(target.rent_amount) !== l.rent ? `שכירות ${target.rent_amount ?? '—'} → ${l.rent} €` : '',
        l.deposit !== null && Number(target.deposit_amount) !== l.deposit ? `פיקדון ${target.deposit_amount ?? '—'} → ${l.deposit} €` : '',
      ].filter(Boolean);
      if (!changes.length) status = 'duplicate';
      else { leaseId = target.id; errors.push(`החוזה שבמערכת השתנה: ${changes.join('; ')}. באישור, החוזה יעודכן`); }
    }
  }
  const withholding = /\b(srl|sa|pfa|ii)\b/i.test(l.tenant) ? 8 : 0;   // Romania: 8% when the tenant is a company
  return {
    batch_id: batchId, row_ref: `lease:${l.ref}`, proposed: null, fingerprint: null, issues, property_id: m.propertyId, match_status: status,
    raw: {
      row: 0, property_ref: l.property.ref, kind: leaseId ? 'עדכון חוזה' : l.hidden ? 'חוזה קודם (מוסתר בקובץ)' : 'חוזה שכירות', owner: l.property.owner,
      match_note: m.note, candidates: m.candidates, errors,
      description: `${l.tenant} · ${d(l.start)}–${d(l.end)} · ${l.rent ?? '—'} € · פיקדון ${l.deposit ?? '—'} €`,
      lease: {
        tenant: l.tenant, start: l.start, end: l.end, rent: l.rent, deposit: l.deposit, currency: l.currency,
        notes: [l.contract, l.notes].filter(Boolean).join(' · '), withholding, ...(leaseId ? { lease_id: leaseId } : {}),
      },
    },
  } satisfies Omit<ImportRow, 'id' | 'transaction_id'> & { batch_id: string; fingerprint: string | null };
}
