// Finding a client's Israeli ID number in the text read from a scan (SPEC decision 66).
// Pure functions, tested in idnumber.test.ts. The reading itself (OCR) runs in the
// browser in idocr.ts, so a scan never leaves the user's computer.

// The Israeli ID check digit: digits weighted 1,2,1,2..., two-digit products summed
// as their digits, total divisible by 10. Shorter numbers are padded with zeros.
export function validIsraeliId(raw: string): boolean {
  const s = raw.replace(/\D/g, '');
  if (s.length < 5 || s.length > 9 || /^0+$/.test(s)) return false;
  const d = s.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    const x = Number(d[i]) * ((i % 2) + 1);
    sum += x > 9 ? x - 9 : x;
  }
  return sum % 10 === 0;
}

export interface IdCandidate {
  id: string;             // nine digits
  how: 'mrz' | 'label' | 'digits';
  score: number;          // higher is more likely
}

// OCR confuses a few letters with digits in number fields.
const toDigits = (s: string) => s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8');

// Passport machine-readable zone, second line (44 characters): the document number
// (positions 1-9) is not the ID; Israeli passports put the ID in the personal number
// field (positions 29-42).
function fromMrz(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const l = line.replace(/\s/g, '').toUpperCase().replace(/[«‹]/g, '<');
    if (l.length < 42 || l.length > 46 || !/^[A-Z0-9<]+$/.test(l) || !/^[A-Z0-9<]{9}[0-9<][A-Z<]{3}\d{6}/.test(l)) continue;
    const personal = toDigits(l.slice(28, 42).replace(/</g, ''));
    if (/^\d{5,9}$/.test(personal)) out.push(personal.padStart(9, '0'));
  }
  return out;
}

// Every ID-looking number in the text, valid by the check digit, best first. Numbers
// next to an ID label ("זהות", "Identity", "ID No") rank above bare nine-digit runs.
export function findIdNumbers(text: string): IdCandidate[] {
  const found = new Map<string, IdCandidate>();
  const add = (id: string, how: IdCandidate['how'], score: number) => {
    if (!validIsraeliId(id)) return;
    const prev = found.get(id);
    if (!prev || prev.score < score) found.set(id, { id, how, score: (prev?.score ?? 0) + score });
  };
  for (const id of fromMrz(text)) add(id, 'mrz', 100);

  // Nine digits, possibly split as "0 1234567 8" or "01234567-8" on the card.
  const re = /(?<![\d])(\d[\d\s-]{7,12}\d)(?![\d])/g;
  for (const m of text.matchAll(re)) {
    const digits = m[1].replace(/[\s-]/g, '');
    if (digits.length !== 9) continue;
    const before = text.slice(Math.max(0, (m.index ?? 0) - 40), m.index);
    const labelled = /(זהות|ת\.?\s?ז|identity|id\s*no|personal\s*no|מס['׳]?\s*זהות)/i.test(before);
    add(digits, labelled ? 'label' : 'digits', labelled ? 50 : 10);
  }
  return [...found.values()].sort((a, b) => b.score - a.score);
}
