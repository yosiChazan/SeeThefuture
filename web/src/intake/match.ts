import type { PropertyHint } from './types.ts';

export interface PropertyForMatch {
  id: string;
  unit_no: string;
  country_code: string;
  building: string;
  project: string | null;
  owners: string[];
}

export interface Match {
  propertyId: string | null;
  note?: string;                 // shown to the reviewer next to the match
  candidates: string[];          // property ids worth offering when unmatched
}

const tokens = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((t) => t.length >= 3);

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Names are transliterated differently by every source: Weisberg / Vaisberg,
// Tzwigel / Zwiegel, Kapolnik / Kopilnik. One close token is enough.
export function sameOwner(a: string, b: string): boolean {
  return tokens(a).some((x) => tokens(b).some((y) => distance(x, y) <= Math.max(1, Math.floor(Math.max(x.length, y.length) * 0.3))));
}

// 1. a name the source used before (external_refs) wins;
// 2. otherwise same apartment number (and project), then the owner's name decides,
//    preferring the same building. A building that differs is matched with a note.
export function matchProperty(hint: PropertyHint, country: string, properties: PropertyForMatch[], known: Map<string, string>): Match {
  const remembered = known.get(hint.ref);
  if (remembered) return { propertyId: remembered, candidates: [] };

  const inProject = properties.filter((p) => p.country_code === country && p.unit_no === hint.unit
    && (!hint.project || (p.project ?? '').toLowerCase() === hint.project.toLowerCase()));
  const byOwner = hint.owner ? inProject.filter((p) => p.owners.some((o) => sameOwner(o, hint.owner!))) : [];
  const pick = (list: PropertyForMatch[]) => {
    const sameBuilding = list.filter((p) => p.building === hint.building);
    return sameBuilding.length === 1 ? sameBuilding[0] : list.length === 1 ? list[0] : null;
  };

  const found = pick(byOwner) ?? (hint.owner ? null : pick(inProject));
  if (found) {
    return {
      propertyId: found.id, candidates: [],
      note: hint.building && found.building !== hint.building ? `בניין ${hint.building} בדוח, ${found.building} במערכת` : undefined,
    };
  }
  return { propertyId: null, candidates: (byOwner.length ? byOwner : inProject).map((p) => p.id) };
}
