// Web addresses inside free text (a topic's details or reply), so they can be shown as
// links (SPEC decision 92). Pure, tested.

export type Piece = { text: string } | { url: string; label?: string };

// Either a named link, [text](address), or a bare web address. A named link may also point
// to a page of the app (/clients/…).
const URL_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)|(https?:\/\/[^\s<>"']+)/g;

export function splitLinks(text: string): Piece[] {
  const out: Piece[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    let piece: Piece, len: number;
    if (m[2]) { piece = { url: m[2], label: m[1].trim() }; len = m[0].length; }
    else {
      // A sentence's final punctuation is not part of the address.
      const url = m[3].replace(/[.,;:!?)\]]+$/, '');
      piece = { url }; len = url.length;
    }
    if (at > last) out.push({ text: text.slice(last, at) });
    out.push(piece);
    last = at + len;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

// The text to write for a named link. Brackets in the name would break it, so they go.
export function namedLink(label: string, url: string): string {
  const name = label.replace(/[[\]]/g, '').trim();
  return name ? `[${name}](${url.trim()})` : url.trim();
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
