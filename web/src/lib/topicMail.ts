// The e-mail draft that tells an employee about a topic assigned to them (SPEC decision 92).
// The topic stays visible to every staff member; the mail is only a heads-up, sent by the
// sender from their own mailbox. Pure, tested.

import { splitLinks } from './links.ts';

const NAMED = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|\/[^\s)]*)\)/g;
const full = (url: string, origin: string) => (url.startsWith('/') ? origin + url : url);

export interface TopicMailInput { title: string; notes: string | null; fixUrl: string | null; to: string; from: string; origin: string }

export function topicMail({ title, notes, fixUrl, to, from, origin }: TopicMailInput): { subject: string; body: string } {
  // A mail is plain text: a named link becomes "name: address".
  const text = (notes ?? '').trim().replace(NAMED, (_, name: string, url: string) => `${name}: ${full(url, origin)}`);
  const open = `${origin}/completeness?g=manual&q=${encodeURIComponent(title)}`;
  const lines = [
    `שלום ${to},`, '',
    `${from} שלח/ה אליך נושא במערכת: ${title}`,
    ...(text ? ['', text] : []),
    ...(fixUrl ? ['', `קישור לתיקון: ${full(fixUrl, origin)}`] : []),
    '', `לצפייה, לתשובה ולסימון "בוצע": ${open}`, '', 'תודה',
  ];
  return { subject: `נושא חדש: ${title}`, body: lines.join('\n') };
}

// The same mail with real links, for pasting into Gmail or Outlook (a compose link carries
// plain text only). A named link shows its name; a bare address shows a short name of its
// site; the fix link and the topic itself are words, not addresses.
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const a = (url: string, text: string) => `<a href="${esc(url)}">${esc(text)}</a>`;

export function siteName(url: string, origin: string): string {
  if (url.startsWith('/') || url.startsWith(origin + '/') || url === origin) return 'קישור במערכת';
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  if (host === 'drive.google.com') return 'Google Drive';
  if (host === 'docs.google.com') return 'Google Docs';
  if (host.endsWith('airtable.com')) return 'Airtable';
  return host;
}

export function topicMailHtml({ title, notes, fixUrl, to, from, origin }: TopicMailInput): string {
  const text = splitLinks((notes ?? '').trim())
    .map((p) => ('url' in p ? a(full(p.url, origin), p.label ?? siteName(p.url, origin)) : esc(p.text)))
    .join('').replace(/\n/g, '<br>');
  const open = `${origin}/completeness?g=manual&q=${encodeURIComponent(title)}`;
  return [
    `<p>שלום ${esc(to)},</p>`,
    `<p>${esc(from)} שלח/ה אליך נושא במערכת: <b>${esc(title)}</b></p>`,
    ...(text ? [`<p>${text}</p>`] : []),
    ...(fixUrl ? [`<p>${a(full(fixUrl, origin), 'קישור לתיקון')}</p>`] : []),
    `<p>${a(open, 'לצפייה, לתשובה ולסימון "בוצע"')}</p>`,
    '<p>תודה</p>',
  ].join('\n').replace(/^/, '<div dir="rtl">') + '</div>';
}

export const gmailLink = (email: string, subject: string, body?: string) =>
  `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}${body ? `&body=${encodeURIComponent(body)}` : ''}`;
export const mailtoLink = (email: string, subject: string, body: string) =>
  `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
