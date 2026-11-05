// The groups of a property's files (SPEC decisions 102, 104, 106), shared by the files section
// of the property card and the ZIP import. Every document type falls in exactly one group:
// a type not listed goes to "other".

export interface FileGroup { key: 'purchase' | 'receipts' | 'photos' | 'plans' | 'other'; label: string; types: string[]; uploadType: string; sensitive: boolean }

export const FILE_GROUPS: FileGroup[] = [
  { key: 'purchase', label: 'מסמכי רכישה ובעלות', types: ['purchase_contract', 'land_registry', 'land_book', 'caveat', 'poa', 'e9'], uploadType: 'purchase_contract', sensitive: true },
  { key: 'receipts', label: 'קבלות', types: ['receipt', 'payment_proof'], uploadType: 'receipt', sensitive: true },
  { key: 'photos', label: 'תמונות', types: ['photo'], uploadType: 'photo', sensitive: false },
  { key: 'plans', label: 'שרטוט', types: ['floor_plan'], uploadType: 'floor_plan', sensitive: false },
  { key: 'other', label: 'מסמכים נוספים', types: [], uploadType: 'attachment', sensitive: true },
];

export const DOC_TYPE_HE: Record<string, string> = {
  purchase_contract: 'חוזה רכישה', land_registry: 'נסח טאבו', land_book: 'Land book', caveat: 'הערת אזהרה', poa: 'ייפוי כוח',
  payment_proof: 'הוכחת תשלום', receipt: 'קבלה', e9: 'E9 (יוון)', photo: 'תמונה', floor_plan: 'שרטוט', management_contract: 'חוזה ניהול',
  lease_contract: 'חוזה שכירות', bank_document: 'מסמך בנק', passport: 'דרכון', attachment: 'מסמך אחר',
};
export const DOC_TYPE_OPTIONS = Object.entries(DOC_TYPE_HE).map(([value, label]) => ({ value, label }));

export function groupOf(docType: string): FileGroup['key'] {
  return FILE_GROUPS.find((g) => g.types.includes(docType))?.key ?? 'other';
}

// The type a file gets when a person puts it in a group: the type guessed from its name
// when that type belongs to the group, otherwise the group's own type.
export function typeInGroup(group: FileGroup['key'], guessed: string): string {
  const g = FILE_GROUPS.find((x) => x.key === group)!;
  return groupOf(guessed) === group ? guessed : g.uploadType;
}

export const isSensitive = (docType: string) => FILE_GROUPS.find((g) => g.key === groupOf(docType))!.sensitive;
