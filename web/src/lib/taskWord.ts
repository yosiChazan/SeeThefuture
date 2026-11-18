// A task as a Word document (SPEC decision 171): the card as it is on the screen - its details,
// what it is linked to, who handles it, the replies as a tree with "טופל", and the history -
// right to left. A web page in one file (MHTML, decision 173) saved as .doc: Word opens it as a
// document, with the replies' pictures inside it. Pure, tested.
import { splitLinks } from './links.ts';

export interface WordReply { who: string; at: string; body: string | null; edited: boolean; files: number; images?: string[]; open: boolean; resolved: { who: string; at: string; body: string | null } | null; children: WordReply[] }
export interface WordTask {
  subject: string; status: string; priority: string; trigger: string | null; category: string | null; series: string | null;
  author: string; created: string; body: string | null; links: string[]; assignees: string[];
  replies: WordReply[]; openBranches: number; history: { who: string; what: string; at: string; body: string | null }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Text with its links clickable; an address inside the system opens on the site.
export function linked(text: string, origin: string): string {
  return splitLinks(text).map((p) => ('url' in p
    ? `<a href="${esc(p.url.startsWith('/') ? origin + p.url : p.url)}">${esc(p.label ?? p.url)}</a>`
    : esc(p.text))).join('').replace(/\n/g, '<br>');
}

function reply(r: WordReply, depth: number, origin: string): string {
  const pad = depth * 18;
  return `<div style="margin-right:${pad}pt;border-right:2pt solid ${depth ? '#ccc' : '#999'};padding-right:6pt;margin-bottom:6pt">
<p style="margin:0"><b>${esc(r.who)}</b> <span style="color:#777">${esc(r.at)}${r.edited ? ' · נערך' : ''}</span>${r.open ? ' <span style="color:#d9480f">· בטיפול</span>' : ''}</p>
${r.body ? `<p style="margin:2pt 0">${linked(r.body, origin)}</p>` : ''}${(r.images ?? []).map((src) => `<p style="margin:2pt 0"><img src="${esc(src)}" width="360"></p>`).join('')}${r.files > (r.images?.length ?? 0) ? `<p style="margin:0;color:#777">${r.files - (r.images?.length ?? 0)} תמונות לא נטענו (במערכת)</p>` : ''}
</div>
${r.children.map((c) => reply(c, depth + 1, origin)).join('')}
${r.resolved ? `<div style="margin-right:${pad + 18}pt;border-right:2pt solid #2b8a3e;padding-right:6pt;margin-bottom:6pt"><p style="margin:0;color:#2b8a3e"><b>✓ טופל</b> · ${esc(r.resolved.who)} · ${esc(r.resolved.at)}</p>${r.resolved.body ? `<p style="margin:2pt 0">${linked(r.resolved.body, origin)}</p>` : ''}</div>` : ''}`;
}

export function taskWord(t: WordTask, origin: string): string {
  const tags = [`מצב: ${t.status}`, `עדיפות: ${t.priority}`, t.trigger, t.series, t.category].filter(Boolean).map((x) => esc(x!)).join(' · ');
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" lang="he" dir="rtl">
<head><meta charset="utf-8"><title>${esc(t.subject)}</title>
<style>body{font-family:Arial,sans-serif;font-size:11pt;direction:rtl;text-align:right} h1{font-size:18pt;margin:0 0 4pt} h2{font-size:13pt;margin:14pt 0 4pt;border-bottom:1pt solid #ccc} p{margin:3pt 0} .muted{color:#777} table{border-collapse:collapse} td{padding:2pt 6pt;vertical-align:top}</style></head>
<body dir="rtl">
<h1>${esc(t.subject)}</h1>
<p>${tags}</p>
<p class="muted">נפתחה ע"י ${esc(t.author)}, ${esc(t.created)}</p>
${t.body ? `<p style="border:1pt solid #ccc;padding:6pt">${linked(t.body, origin)}</p>` : ''}
<table><tr><td><b>קשור ל:</b></td><td>${t.links.length ? t.links.map(esc).join(', ') : '—'}</td></tr>
<tr><td><b>בטיפול של:</b></td><td>${t.assignees.length ? t.assignees.map(esc).join(', ') : '—'}</td></tr></table>
${t.replies.length ? `<h2>תגובות${t.openBranches ? ` (${t.openBranches} ${t.openBranches === 1 ? 'ענף' : 'ענפים'} בטיפול)` : ' (כל הענפים טופלו)'}</h2>${t.replies.map((r) => reply(r, 0, origin)).join('')}` : ''}
${t.history.length ? `<h2>היסטוריה</h2>${t.history.map((h) => `<p><b>${esc(h.who)}</b> ${esc(h.what)} <span class="muted">· ${esc(h.at)}</span>${h.body ? `<br>${linked(h.body, origin)}` : ''}</p>`).join('')}` : ''}
</body></html>`;
}

// The document with its pictures, as one MHTML file. `images`: each picture's name in the
// document (as in <img src>), its type and its bytes in base64.
export function mhtml(html: string, images: { name: string; type: string; base64: string }[]): string {
  const b = '----=_task_word_boundary';
  const wrap = (x: string) => x.replace(/.{1,76}/g, '$&\r\n');
  const utf8 = (x: string) => { const bytes = new TextEncoder().encode(x); let bin = ''; for (const c of bytes) bin += String.fromCharCode(c); return btoa(bin); };
  return [
    'MIME-Version: 1.0', `Content-Type: multipart/related; boundary="${b}"; type="text/html"`, '',
    `--${b}`, 'Content-Type: text/html; charset="utf-8"', 'Content-Transfer-Encoding: base64', 'Content-Location: file:///C:/task.htm', '', wrap(utf8(html)),
    ...images.flatMap((i) => [`--${b}`, `Content-Type: ${i.type}`, 'Content-Transfer-Encoding: base64', `Content-Location: file:///C:/${i.name}`, '', wrap(i.base64)]),
    `--${b}--`, '',
  ].join('\r\n');
}
