// Web addresses inside free text (a topic's details or reply), so they can be shown as
// links (SPEC decision 92). Pure, tested.

export type Piece = { text: string } | { url: string };

const URL_RE = /(https?:\/\/[^\s<>"']+)/g;

export function splitLinks(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    // A sentence's final punctuation is not part of the address.
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    const at = m.index ?? 0;
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push({ url });
    last = at + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// A link "to fix it": a web address, or a page of the app (/clients/…). Anything else is
// refused, so a stored link can never run code.
export function fixLinkOk(s: string): boolean {
  return /^(https?:\/\/\S+|\/\S*)$/.test(s.trim());
}

// Pasting a full address of the app itself keeps only its page, so it opens in place.
export function appPath(s: string, origin: string): string {
  const t = s.trim();
  return t.startsWith(origin + '/') ? t.slice(origin.length) : t;
}
