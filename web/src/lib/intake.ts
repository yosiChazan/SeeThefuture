import { useQuery } from '@tanstack/react-query';
import { ADAPTERS } from '../intake/adapters';
import { bookFromXlsx } from '../intake/grid';
import { matchProperty, type PropertyForMatch } from '../intake/match';
import type { ParseResult, ParsedRow, ProposedTransaction } from '../intake/types';
import { must, supabase } from './supabase';
import type { Country } from './types';

export interface Source { id: string; name: string; adapter: string; country_code: Country; active: boolean }
export type BatchStatus = 'parsed' | 'in_review' | 'committed' | 'rejected';
export type RowStatus = 'matched' | 'unmatched' | 'duplicate' | 'ignored';

// Stored in import_batches.notes: what the adapter found about the file as a whole.
export interface BatchNotes { period: string; file_name: string; warnings: string[] }

export interface Batch {
  id: string;
  country_code: Country;
  file_path: string | null;
  received_at: string;
  status: BatchStatus;
  reviewed_at: string | null;
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

const BATCH_COLS = 'id, country_code, file_path, received_at, status, reviewed_at, notes, source:import_sources(id, name, adapter, country_code, active), rows:import_rows(count)';

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
    .select('id, unit_no, country_code, building:buildings(name, project:projects(name)), ownerships(valid_to, party:parties(display_name))')
    .eq('country_code', country)) as unknown as {
      id: string; unit_no: string; country_code: string;
      building: { name: string; project: { name: string } | null };
      ownerships: { valid_to: string | null; party: { display_name: string } }[];
    }[];
  return rows.map((p) => ({
    id: p.id, unit_no: p.unit_no, country_code: p.country_code, building: p.building.name, project: p.building.project?.name ?? null,
    owners: p.ownerships.filter((o) => !o.valid_to).map((o) => o.party.display_name),
  }));
}

const POSTED = 'fingerprint, raw, proposed, batch:import_batches!inner(source_id), transaction:transactions!import_rows_transaction_id_fkey!inner(status)';
type PostedRow = { fingerprint: string | null; raw: { property_ref?: string }; proposed: ProposedTransaction };

// What this source already posted: exact fingerprints ("already imported"), and the
// same rows of the same months without the amount ("changed since").
async function alreadyPosted(sourceId: string, result: ParseResult) {
  const fps = [...new Set(result.rows.map((r) => r.fingerprint).filter((f): f is string => !!f))];
  const periods = [...new Set(result.rows.map((r) => r.proposed?.period).filter((p): p is string => !!p))];
  const exact = new Set<string>();
  for (let i = 0; i < fps.length; i += 40) {
    const rows = must(await supabase.from('import_rows').select(POSTED).eq('transaction.status', 'posted')
      .in('fingerprint', fps.slice(i, i + 40))) as unknown as PostedRow[];
    rows.forEach((r) => exact.add(r.fingerprint!));
  }
  const sameMonths = periods.length ? must(await supabase.from('import_rows').select(POSTED)
    .eq('batch.source_id', sourceId).eq('transaction.status', 'posted').in('proposed->>period', periods)) as unknown as PostedRow[] : [];
  const byKey = new Map(sameMonths.map((r) => [identity(r.raw.property_ref ?? '', r.proposed), r.proposed]));
  return { exact, byKey };
}

const identity = (ref: string, p: ProposedTransaction) => [ref, p.category, p.occurred_on, p.period, p.description].join('|');
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
    id, source_id: source.id, country_code: source.country_code, status: 'in_review',
    notes: JSON.stringify({ period: result.period, file_name: file.name, warnings: result.warnings } satisfies BatchNotes),
  }));

  const safeName = file.name.normalize('NFKD').replace(/[^\w.-]+/g, '_');
  const path = `${source.country_code}/${id}/${safeName}`;
  const up = await supabase.storage.from('imports').upload(path, file, { contentType: file.type || undefined });
  if (up.error) throw new Error(`שמירת הקובץ נכשלה: ${up.error.message}`);
  must(await supabase.from('import_batches').update({ file_path: path }).eq('id', id));

  const matches = new Map<string, ReturnType<typeof matchProperty>>();
  // An opening balance is proposed by every report but posted once (Gershon, SPEC decision 43).
  const fresh = result.rows.filter((r) => !(r.proposed?.category === 'opening_balance' && r.fingerprint && posted.exact.has(r.fingerprint)));
  const rows = fresh.map((r: ParsedRow) => {
    if (!matches.has(r.property.ref)) matches.set(r.property.ref, matchProperty(r.property, source.country_code, properties, known));
    const m = matches.get(r.property.ref)!;
    const issues = [...r.issues];
    let status: RowStatus = !r.proposed ? 'ignored' : m.propertyId ? 'matched' : 'unmatched';
    if (r.proposed && r.fingerprint && posted.exact.has(r.fingerprint)) status = 'duplicate';
    else if (r.proposed) {
      const before = posted.byKey.get(identity(r.property.ref, r.proposed));
      if (before) {
        status = 'ignored';
        issues.push(`כבר נרשם מדוח קודם לאותו חודש בסכום אחר (${amountOf(before)}). אם זה תיקון, צריך לבטל קודם את התנועה הקודמת`);
      }
    }
    return {
      batch_id: id, row_ref: r.ref, proposed: r.proposed, fingerprint: r.fingerprint, issues,
      property_id: m.propertyId, match_status: status,
      raw: { ...r.raw, kind: r.kind, owner: r.property.owner, match_note: m.note, candidates: m.candidates, errors: r.errors },
    };
  });
  for (let i = 0; i < rows.length; i += 200) must(await supabase.from('import_rows').insert(rows.slice(i, i + 200)));
  return id;
}
