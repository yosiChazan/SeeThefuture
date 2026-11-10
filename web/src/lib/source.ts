// Where a transaction came from (SPEC decision 136), in words and with a link: the report at
// intake, the row in Airtable, the office's spreadsheet, or entered by hand. Pure, tested.

export interface SourceInfo { kind: 'report' | 'airtable' | 'excel' | 'manual' | 'unknown'; label: string; href?: string; detail?: string }

export function sourceInfo(source: string | null | undefined, importBatchId?: string | null): SourceInfo {
  const s = source ?? (importBatchId ? `report:${importBatchId}` : null);
  if (!s) return { kind: 'unknown', label: 'לא ידוע' };
  if (s.startsWith('report:')) return { kind: 'report', label: 'דוח', href: `/intake/${s.slice(7)}`, detail: 'נקלט מדוח במסך הקליטה' };
  if (s.startsWith('airtable:')) {
    const [path, part] = s.slice(9).split('#');
    const [base, table, rec] = path.split('/');
    return { kind: 'airtable', label: 'Airtable', href: rec ? `https://airtable.com/${base}/${table}/${rec}` : base && table ? `https://airtable.com/${base}/${table}` : undefined,
      detail: rec ? (part === 'fee' ? 'דמי הניהול שבשורה ב-Airtable' : 'שורה ב-Airtable') : 'מטבלה ב-Airtable (השורה המדויקת לא זוהתה)' };
  }
  if (s.startsWith('excel:')) return { kind: 'excel', label: 'אקסל', detail: s.slice(6) };
  if (s === 'manual') return { kind: 'manual', label: 'ידני', detail: 'הוזן ביד במערכת' };
  return { kind: 'unknown', label: s };
}
