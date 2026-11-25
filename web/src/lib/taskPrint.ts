// A task as a PDF (SPEC decision 175): the card as it is on the screen - its details, what it is
// linked to, who handles it, the replies as a tree with "טופל" and their pictures, and the
// history - as a page for printing, right to left. The browser saves it as PDF ("שמירה כ-PDF"
// in the print window), so Hebrew, pictures and links come out as on the screen. Pure, tested.
import { splitLinks } from './links.ts';

export interface PrintReply { who: string; at: string; body: string | null; edited: boolean; files: number; images?: string[]; open: boolean; resolved: { who: string; at: string; body: string | null } | null; children: PrintReply[] }
export interface PrintTask {
  subject: string; status: string; priority: string; trigger: string | null; category: string | null; series: string | null;
  author: string; created: string; body: string | null; links: string[]; assignees: string[];
  replies: PrintReply[]; openBranches: number; history: { who: string; what: string; at: string; body: string | null }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Text with its links clickable; an address inside the system opens on the site.
export function linked(text: string, origin: string): string {
  return splitLinks(text).map((p) => ('url' in p
    ? `<a href="${esc(p.url.startsWith('/') ? origin + p.url : p.url)}">${esc(p.label ?? p.url)}</a>`
    : esc(p.text))).join('').replace(/\n/g, '<br>');
}

function reply(r: PrintReply, origin: string): string {
  const missing = r.files - (r.images?.length ?? 0);
  return `<div class="reply${r.children.length || r.resolved ? '' : ' leaf'}">
<div class="head"><b>${esc(r.who)}</b> <span class="muted">${esc(r.at)}${r.edited ? ' · נערך' : ''}</span>${r.open ? ' <span class="open">· בטיפול</span>' : ''}</div>
${r.body ? `<div>${linked(r.body, origin)}</div>` : ''}${(r.images ?? []).map((src) => `<img src="${esc(src)}">`).join('')}${missing > 0 ? `<div class="muted">${missing} תמונות לא נטענו (במערכת)</div>` : ''}
<div class="kids">${r.children.map((c) => reply(c, origin)).join('')}
${r.resolved ? `<div class="reply done"><div class="head"><b>✓ טופל</b> · ${esc(r.resolved.who)} · ${esc(r.resolved.at)}</div>${r.resolved.body ? `<div>${linked(r.resolved.body, origin)}</div>` : ''}</div>` : ''}</div>
</div>`;
}

export function taskPrint(t: PrintTask, origin: string): string {
  const tags = [`מצב: ${t.status}`, `עדיפות: ${t.priority}`, t.trigger, t.series, t.category].filter(Boolean).map((x) => esc(x!)).join(' · ');
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>${esc(t.subject)}</title>
<style>
@page{size:A4;margin:15mm}
body{font-family:Arial,"Segoe UI",sans-serif;font-size:11pt;color:#111;margin:0;padding:16px;direction:rtl}
h1{font-size:18pt;margin:0 0 4pt} h2{font-size:13pt;margin:16pt 0 6pt;border-bottom:1pt solid #ccc;padding-bottom:2pt}
.muted{color:#777} .open{color:#d9480f} a{color:#1c7ed6}
.box{border:1pt solid #ccc;padding:6pt;margin:6pt 0;white-space:normal}
table{border-collapse:collapse;margin:6pt 0} td{padding:2pt 6pt 2pt 0;vertical-align:top}
.reply{border-right:2pt solid #999;padding-right:8pt;margin:6pt 0}
.reply .reply{border-right-color:#ccc} .kids{margin-right:10pt}
.reply.done{border-right-color:#2b8a3e} .reply.done .head{color:#2b8a3e}
.head{margin-bottom:2pt}
img{display:block;max-width:12.5cm;max-height:11cm;margin-left:auto;margin:4pt 0;break-inside:avoid}
.history p{margin:3pt 0}
@media print{a{text-decoration:none}}
</style></head><body>
<h1>${esc(t.subject)}</h1>
<div>${tags}</div>
<div class="muted">נפתחה ע"י ${esc(t.author)}, ${esc(t.created)}</div>
${t.body ? `<div class="box">${linked(t.body, origin)}</div>` : ''}
<table><tr><td><b>קשור ל:</b></td><td>${t.links.length ? t.links.map(esc).join(', ') : '—'}</td></tr>
<tr><td><b>בטיפול של:</b></td><td>${t.assignees.length ? t.assignees.map(esc).join(', ') : '—'}</td></tr></table>
${t.replies.length ? `<h2>תגובות${t.openBranches ? ` (${t.openBranches} ${t.openBranches === 1 ? 'ענף' : 'ענפים'} בטיפול)` : ' (כל הענפים טופלו)'}</h2>${t.replies.map((r) => reply(r, origin)).join('')}` : ''}
${t.history.length ? `<h2>היסטוריה</h2><div class="history">${t.history.map((h) => `<p><b>${esc(h.who)}</b> ${esc(h.what)} <span class="muted">· ${esc(h.at)}</span>${h.body ? `<br>${linked(h.body, origin)}` : ''}</p>`).join('')}</div>` : ''}
</body></html>`;
}
