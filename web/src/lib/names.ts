// Suggesting a split of a stored full name into first and last name (SPEC decision 72).
// The office confirms every suggestion before it is saved; `sure` says which ones to look at.

export interface NameSplit { first: string; last: string; sure: boolean; why?: string }

// Words that belong to the family name that follows them: "אסף בן יוסף" → "בן יוסף".
const PARTICLES = new Set(['בן', 'בר', 'אבו', 'אבן', 'די', 'דה', 'לה', 'ואן', 'פון', 'אל', 'ben', 'bar', 'de', 'di', 'la', 'van', 'von', 'der', 'del', 'du', 'le', 'el', 'abu']);

export function suggestSplit(full: string): NameSplit {
  const words = full.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean);
  if (words.length === 0) return { first: '', last: '', sure: false, why: 'שם ריק' };
  if (words.length === 1) return { first: '', last: words[0], sure: false, why: 'מילה אחת' };
  let cut = words.length - 1;
  while (cut > 1 && PARTICLES.has(words[cut - 1].toLowerCase())) cut -= 1;
  const first = words.slice(0, cut).join(' ');
  const last = words.slice(cut).join(' ');
  // "יעל ורבקה גוטליב", "Yael & Rivka": two people in one name.
  const couple = words.slice(1).some((w) => /^ו[א-ת]/.test(w) && w.length > 2 && !PARTICLES.has(w)) || /[&+]|\band\b/i.test(full);
  if (couple) return { first, last, sure: false, why: 'נראה כמו שני אנשים' };
  if (cut >= 3) return { first, last, sure: false, why: 'שם ארוך' };   // three or more first names
  if (/["'״׳()]|\d/.test(full)) return { first, last, sure: false, why: 'תווים מיוחדים' };
  return { first, last, sure: true };
}

// The name shown everywhere once both parts are set (decision 72: first, then last).
export const fullName = (first: string, last: string) => [first.trim(), last.trim()].filter(Boolean).join(' ');
