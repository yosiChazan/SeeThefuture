// The groups of a property's files (SPEC decisions 102, 104, 106, 107), shared by the files
// section of the property card and the ZIP imports. Built-in groups, then the categories the
// office added in Settings (app.file_categories, doc_type 'cat:<id>'), then "other". Every
// document type falls in exactly one group: a type not listed goes to "other".

export interface FileGroup { key: string; label: string; types: string[]; uploadType: string; sensitive: boolean; custom?: boolean }
export interface FileCategory { id: string; label: string; sensitive: boolean; position: number }

const BUILT_IN: FileGroup[] = [
  { key: 'purchase', label: 'מסמכי רכישה ובעלות', types: ['purchase_contract', 'land_registry', 'land_book', 'caveat', 'poa', 'e9'], uploadType: 'purchase_contract', sensitive: true },
  { key: 'receipts', label: 'קבלות', types: ['receipt', 'payment_proof'], uploadType: 'receipt', sensitive: true },
  { key: 'photos', label: 'תמונות וסרטונים', types: ['photo'], uploadType: 'photo', sensitive: false },
  { key: 'plans', label: 'שרטוט', types: ['floor_plan'], uploadType: 'floor_plan', sensitive: false },
];
const OTHER: FileGroup = { key: 'other', label: 'מסמכים נוספים', types: [], uploadType: 'attachment', sensitive: true };

export const categoryType = (id: string) => `cat:${id}`;
export function buildGroups(custom: FileCategory[]): FileGroup[] {
  return [...BUILT_IN,
    ...[...custom].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label))
      .map((c) => ({ key: categoryType(c.id), label: c.label, types: [categoryType(c.id)], uploadType: categoryType(c.id), sensitive: c.sensitive, custom: true })),
    OTHER];
}
export const FILE_GROUPS = buildGroups([]);
export const BUILT_IN_LABELS = [...BUILT_IN, OTHER].map((g) => g.label);

export const DOC_TYPE_HE: Record<string, string> = {
  purchase_contract: 'חוזה רכישה', land_registry: 'נסח טאבו', land_book: 'Land book', caveat: 'הערת אזהרה', poa: 'ייפוי כוח',
  payment_proof: 'הוכחת תשלום', receipt: 'קבלה', e9: 'E9 (יוון)', photo: 'תמונה', floor_plan: 'שרטוט', management_contract: 'חוזה ניהול',
  lease_contract: 'חוזה שכירות', bank_document: 'מסמך בנק', passport: 'דרכון', attachment: 'מסמך אחר',
};

export const typeLabel = (docType: string, groups: FileGroup[] = FILE_GROUPS) =>
  DOC_TYPE_HE[docType] ?? groups.find((g) => g.custom && g.uploadType === docType)?.label ?? docType;
export const docTypeOptions = (groups: FileGroup[] = FILE_GROUPS) => [
  ...Object.entries(DOC_TYPE_HE).map(([value, label]) => ({ value, label })),
  ...groups.filter((g) => g.custom).map((g) => ({ value: g.uploadType, label: g.label })),
];

export function groupOf(docType: string, groups: FileGroup[] = FILE_GROUPS): string {
  return groups.find((g) => g.types.includes(docType))?.key ?? 'other';
}

// The type a file gets when a person puts it in a group: the type guessed from its name
// when that type belongs to the group, otherwise the group's own type.
export function typeInGroup(group: string, guessed: string, groups: FileGroup[] = FILE_GROUPS): string {
  const g = groups.find((x) => x.key === group) ?? OTHER;
  return groupOf(guessed, groups) === g.key ? guessed : g.uploadType;
}

export const isSensitive = (docType: string, groups: FileGroup[] = FILE_GROUPS) =>
  (groups.find((g) => g.key === groupOf(docType, groups)) ?? OTHER).sensitive;
