// Documents from a Drive folder downloaded as ZIP (SPEC decision 100): one folder per
// apartment ("דירה בודיק 19 בנין 2.2 LAKE CITY"), files in it and in its subfolders. Pure,
// tested; the screen (DriveZipImport) does the reading and the uploading.

export interface ZipFile { path: string; size: number }
export interface Target { id: string; building: string; unit: string; owners: string[] }

// Folders and files that are never copied: bank account details, passwords and cards (they
// belong in Bitwarden, CLAUDE.md), and videos (too large, not documents).
const SECRET = /(פרטי\s*חשבון|סיסמ|כרטיס\s*אשראי|password|passw|card|\bpin\b|ukrgasbank|privatbank|monobank|iban)/i;
const VIDEO = /\.(mp4|mov|avi|mkv|m4v|3gp|webm)$/i;
export const MAX_BYTES = 50 * 1024 * 1024;

export function skipReason(f: ZipFile): string | null {
  if (SECRET.test(f.path)) return 'פרטי חשבון בנק / סיסמאות / כרטיסים';
  if (VIDEO.test(f.path)) return 'סרטון';
  if (f.size > MAX_BYTES) return 'קובץ גדול מ-50MB';
  if (/(^|\/)(\.|__MACOSX|desktop\.ini|thumbs\.db)/i.test(f.path)) return 'קובץ מערכת';
  return null;
}

// The apartment folder of each file: the first folder under a common root, if the ZIP has
// one ("פארק LAKE CITY/דירה .../x.pdf" and "דירה .../x.pdf" give the same folder).
export function groupByFolder(files: ZipFile[]): Map<string, ZipFile[]> {
  const parts = files.map((f) => f.path.split('/').filter(Boolean));
  const roots = new Set(parts.map((p) => p[0]));
  const strip = roots.size === 1 && parts.every((p) => p.length > 2) ? 1 : 0;
  const out = new Map<string, ZipFile[]>();
  files.forEach((f, i) => {
    const p = parts[i];
    const folder = p.length - strip > 1 ? p[strip] : '(בלי תיקייה)';
    out.set(folder, [...(out.get(folder) ?? []), { ...f, path: p.slice(strip).join('/') }]);
  });
  return out;
}

// "דירה בודיק 19 בנין2.2 LAKE CITY" → building 2.2, apartment 19; "בנין 2 דירה 25" → 2, 25.
export function parseFolder(name: string): { building?: string; unit?: string } {
  const b = name.match(/בני?ין\s*(\d+(?:\.\d+)?)/);
  const rest = b ? name.replace(b[0], ' ') : name;
  const afterDira = rest.match(/דירה\s*(\d{1,4})\b/);
  const any = rest.match(/(?:^|[^\d.])(\d{1,4})(?![\d.])/);
  return { building: b?.[1], unit: afterDira?.[1] ?? any?.[1] };
}

// The apartment a folder is about: same building and apartment number. "sure" when an
// owner's name is also in the folder's name; several candidates or none: no proposal.
export function matchFolder(name: string, targets: Target[]): { id: string | null; sure: boolean } {
  const { building, unit } = parseFolder(name);
  if (!building || !unit) return { id: null, sure: false };
  const hits = targets.filter((t) => t.building === building && t.unit === unit);
  if (hits.length !== 1) return { id: null, sure: false };
  const words = (s: string) => s.split(/[\s,&]+/).filter((w) => w.length > 2);
  const sure = hits[0].owners.some((o) => words(o).some((w) => name.includes(w)));
  return { id: hits[0].id, sure };
}

// The kind of document, from its subfolder and name.
export function docTypeFor(path: string): string {
  const p = path.toLowerCase();
  if (/\.(jpe?g|png|heic|webp)$/.test(p) && /(תמונ|photo|img_|whatsapp image)/.test(p)) return 'photo';
  if (/(ייפו?יי? כוח|יפוי כוח|довіреніст|доверенност|\bpoa\b)/.test(p)) return 'poa';
  if (/(דרכון|passport|паспорт)/.test(p)) return 'passport';
  if (/(תשלומ|קבלה|אסמכתא|receipt|квитанц|платіж|payment)/.test(p)) return 'payment_proof';
  if (/(נסח|טאבו|витяг|выписк|extract)/.test(p)) return 'land_registry';
  if (/(חוזה|הסכם|договір|договор|contract|agreement)/.test(p)) return 'purchase_contract';
  if (/(בנק|bank)/.test(p)) return 'bank_document';
  return 'attachment';
}

// A stable short id for a path, so importing the same ZIP again finds the same files.
export function pathKey(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) { h ^= path.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
