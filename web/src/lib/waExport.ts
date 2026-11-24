// A chat exported from WhatsApp ("ייצוא צ'אט", SPEC decision 191): the text file inside the ZIP,
// as Android writes it ("23.11.2026, 14:05 - שם: טקסט") or iOS ("[23.11.2026, 14:05:12] שם: טקסט"),
// with "." or "/" and a 2- or 4-digit year. Day first or month first, as the phone's language
// writes it: the file decides (a first number above 12 means day first, a second one above 12
// means month first; with neither, day first, as in Israel, and the import screen can swap them). A line that does not start with a
// date continues the message before it. Lines without "name:" (encryption notice, "X joined")
// are not messages. Attachments are named in the text ("<attached: file>" or "file (file attached)").
// Pure, tested.

export interface WaExportMessage { at: Date; sender: string; text: string; file: string | null }

const MARKS = /[‎‏‪-‮⁦-⁩﻿]/g;
const ANDROID = /^(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?\s+-\s+(.*)$/;
const IOS = /^\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?\]\s+(.*)$/;
const ATTACHED = [/^<(?:attached|מצורף):\s*([^>]+)>$/i, /^(.+?\.\w{2,5})\s+\((?:file attached|קובץ מצורף|הקובץ מצורף)\)$/i];

function date(d: string, m: string, y: string, h: string, mi: string, s: string | undefined, ampm: string | undefined, monthFirst = false): Date {
  if (monthFirst) [d, m] = [m, d];
  let year = Number(y); if (year < 100) year += 2000;
  let hour = Number(h);
  if (ampm) { const pm = ampm.toLowerCase() === 'pm'; if (pm && hour < 12) hour += 12; if (!pm && hour === 12) hour = 0; }
  return new Date(year, Number(m) - 1, Number(d), hour, Number(mi), Number(s ?? 0));
}

// Day first or month first, from the whole file.
function monthFirst(lines: string[]): boolean {
  let dayFirst = false, monthFirstSeen = false;
  for (const line of lines) {
    const m = IOS.exec(line) ?? ANDROID.exec(line);
    if (!m) continue;
    if (Number(m[1]) > 12) dayFirst = true;
    if (Number(m[2]) > 12) monthFirstSeen = true;
  }
  return monthFirstSeen && !dayFirst;
}

export function parseWaExport(raw: string, order: 'auto' | 'day' | 'month' = 'auto'): WaExportMessage[] {
  const out: WaExportMessage[] = [];
  let open: WaExportMessage | null = null;
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(MARKS, ''));
  const mf = order === 'auto' ? monthFirst(lines) : order === 'month';
  for (const line0 of lines) {
    const line = line0.replace(MARKS, '');
    const m = IOS.exec(line) ?? ANDROID.exec(line);
    if (!m) { if (open && line.trim()) open.text += `\n${line}`; continue; }
    const rest = m[8];
    const colon = rest.indexOf(': ');
    if (colon < 1) { open = null; continue; }   // a system line, not a message
    const sender = rest.slice(0, colon).trim();
    let text = rest.slice(colon + 2);
    let file: string | null = null;
    for (const re of ATTACHED) {
      const a = re.exec(text.trim());
      if (a) { file = a[1].trim(); text = ''; break; }
    }
    open = { at: date(m[1], m[2], m[3], m[4], m[5], m[6], m[7], mf), sender, text, file };
    out.push(open);
  }
  for (const msg of out) msg.text = msg.text.trim();
  return out;
}

// The people in the chat, most messages first.
export function senders(msgs: WaExportMessage[]): { name: string; count: number }[] {
  const m = new Map<string, number>();
  for (const x of msgs) m.set(x.sender, (m.get(x.sender) ?? 0) + 1);
  return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
}

// A stable id for a message, so importing the same file twice adds nothing.
export async function importId(phone: string, msg: WaExportMessage, n: number): Promise<string> {
  const data = new TextEncoder().encode(`${phone}|${msg.at.getTime()}|${msg.sender}|${msg.text}|${msg.file ?? ''}|${n}`);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return 'import:' + [...hash.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
