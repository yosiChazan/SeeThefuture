// Dry run: reads the Airtable export, builds the staging model and writes a
// cleanup report. Writes nothing to the database.
//
// Usage: node scripts/import/report.ts <airtable-dir> <out-dir>
// <airtable-dir> holds ukraine/, romania/, georgia/ with the CSV exports.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { importGeorgia } from './countries/georgia.ts';
import { importRomania } from './countries/romania.ts';
import { importUkraine } from './countries/ukraine.ts';
import { Staging } from './staging.ts';

function main() {
  const [dir, outDir] = process.argv.slice(2);
  if (!dir || !outDir) {
    console.error('usage: node scripts/import/report.ts <airtable-dir> <out-dir>');
    process.exit(1);
  }

  const s = new Staging();
  importUkraine(join(dir, 'ukraine'), s);
  importGeorgia(join(dir, 'georgia'), s);
  importRomania(join(dir, 'romania'), s);
  s.finalizeOwnerships();

  // A property is rented when a lease covers today, unless it is sold, hotel-run or unbuilt.
  const today = new Date().toISOString().slice(0, 10);
  for (const lease of s.leases) {
    const p = s.properties.get(lease.propertyKey)!;
    if (p.status === 'vacant' && lease.start <= today && (!lease.end || lease.end >= today)) p.status = 'rented';
  }

  const owned = new Set(s.ownerships.map((o) => o.partyKey));
  for (const p of s.parties.values()) {
    if (p.roles.has('client') && !owned.has(p.key)) {
      s.issue([...p.countries][0], 'info', 'client-without-property', `"${p.name}" is marked as owner but owns no imported property`);
    }
  }
  s.findPossibleDuplicates();

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'staging.json'), JSON.stringify(s.toJSON(), null, 2));
  writeFileSync(join(outDir, 'import-report.html'), renderReport(s));

  const bySeverity = Object.groupBy(s.issues, (i) => i.severity);
  console.log(`parties ${s.parties.size}, buildings ${s.buildings.size}, properties ${s.properties.size}, ` +
    `ownerships ${s.ownerships.length}, leases ${s.leases.length}, accounts ${s.accounts.length}`);
  console.log(`issues: ${bySeverity.error?.length ?? 0} errors, ${bySeverity.warning?.length ?? 0} warnings, ${bySeverity.info?.length ?? 0} info`);
}

// ---------------------------------------------------------------------------

function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

const ISSUE_TITLES: Record<string, string> = {
  'possible-duplicate': 'שמות שנראים כמו אותו אדם',
  'tenant-in-owners': 'שוכרים שהופיעו בשדה הבעלים (לא ייובאו כבעלים)',
  'shares-assumed': 'נכסים משותפים: אחוזי הבעלות חולקו שווה בשווה',
  'client-without-property': 'לקוחות בלי נכס מיובא',
  'missing-unit': 'נכסים בלי מספר דירה',
  'no-owner': 'נכסים בלי בעלים',
  'duplicate-property': 'נכסים כפולים (אותו בניין ואותה דירה)',
  'owner-is-group': 'בעלים שנראה כמו קבוצה או שותפות',
  'lease-unmatched': 'חוזים שהנכס שלהם לא נמצא',
  'lease-incomplete': 'חוזים חסרים (תאריך, סכום או מטבע)',
  'lease-amount': 'חוזים עם סכום חשוד',
  'not-purchased': 'נכסים שמסומנים "טרם נקנה"',
  'yomtov-share': 'חלק של 1% ליום-טוב ברומניה',
  'missing-building': 'נכסים בלי בניין או כתובת',
  'unknown-area': 'אזור לא מוכר',
  'unknown-project': 'פרויקט לא מוכר',
  'empty-row': 'שורות ריקות שדולגו',
};

const COUNTRY_NAMES: Record<string, string> = { UA: 'אוקראינה', GE: 'גאורגיה', RO: 'רומניה', ALL: 'כל המדינות' };

function renderReport(st: Staging): string {
  const severityOrder = { error: 0, warning: 1, info: 2 } as const;
  const groups = Object.entries(Object.groupBy(st.issues, (i) => `${i.severity}|${i.code}`))
    .sort(([a], [b]) => severityOrder[a.split('|')[0] as keyof typeof severityOrder] - severityOrder[b.split('|')[0] as keyof typeof severityOrder]);

  const issueBlocks = groups.map(([k, list]) => {
    const [severity, code] = k.split('|');
    const items = list!.map((i) => `<li><span class="c">${esc(COUNTRY_NAMES[i.country])}</span> ${esc(i.message)}</li>`).join('');
    return `<details${severity === 'error' ? ' open' : ''}><summary><span class="sev ${severity}">${severity === 'error' ? 'חוסם' : severity === 'warning' ? 'לבדיקה' : 'מידע'}</span>
      ${esc(ISSUE_TITLES[code] ?? code)} <b>${list!.length}</b></summary><ul>${items}</ul></details>`;
  }).join('\n');

  const countRows = Object.entries(st.counts).map(([c, m]) =>
    `<tr><th>${esc(COUNTRY_NAMES[c])}</th>${['persons', 'properties (rows)', 'properties', 'leases (rows)', 'leases', 'bank accounts']
      .map((k) => `<td>${m[k] ?? '–'}</td>`).join('')}</tr>`).join('');

  const ownersOf = (key: string) => st.ownerships.filter((o) => o.propertyKey === key)
    .map((o) => `${esc(st.parties.get(o.partyKey)?.name)}${o.shareAssumed ? ` (${o.sharePct}%)` : ''}`).join('<br>');

  const propertyRows = [...st.properties.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((p) => {
      const b = st.buildings.get(p.buildingKey)!;
      return `<tr><td>${esc(COUNTRY_NAMES[p.country])}</td><td>${esc(b.city)}</td><td>${esc(b.project ?? '')}</td><td>${esc(b.name)}</td>
        <td>${esc(p.unitNo)}</td><td>${esc(p.status)}</td><td>${ownersOf(p.key)}</td><td class="src">${esc(p.sourceId)}</td></tr>`;
    }).join('');

  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>דוח ניקוי ייבוא Airtable</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1d2a2e;--muted:#617075;--line:#dde2e0;--err:#b3261e;--warn:#a86a00;--info:#2f6f8f}
@media (prefers-color-scheme:dark){:root{--bg:#111819;--panel:#1a2325;--ink:#e3eae8;--muted:#9aa9a7;--line:#2c393b;--err:#f2938c;--warn:#e8b55c;--info:#7fbfdc}}
body{background:var(--bg);color:var(--ink);font:15px/1.6 "Assistant","Segoe UI",Arial,sans-serif;margin:0;padding:24px max(16px,4vw)}
h1{margin:0 0 4px;font-size:26px}h2{margin:32px 0 8px;font-size:19px}
p.lead{color:var(--muted);margin:0 0 16px;max-width:70ch}
table{border-collapse:collapse;width:100%;background:var(--panel);font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:right;vertical-align:top}
thead th{color:var(--muted);font-weight:600;position:sticky;top:0;background:var(--panel)}
.wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
details{background:var(--panel);border:1px solid var(--line);border-radius:8px;margin:6px 0;padding:6px 12px}
summary{cursor:pointer}ul{margin:8px 0;padding-inline-start:20px}li{margin:2px 0}
.sev{display:inline-block;font-size:12px;font-weight:700;border-radius:999px;padding:0 8px;margin-inline-end:6px;border:1px solid currentColor}
.sev.error{color:var(--err)}.sev.warning{color:var(--warn)}.sev.info{color:var(--info)}
.c{color:var(--muted);font-size:12px;margin-inline-end:6px}.src{color:var(--muted);font-size:12px}
input{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);width:min(360px,100%)}
</style></head><body>
<h1>דוח ניקוי: ייבוא מ-Airtable</h1>
<p class="lead">הרצת ניסיון. לא נכתב כלום לבסיס הנתונים. כל שורה כאן היא מה שהמערכת הבינה מהייצוא, או משהו שצריך את ההחלטה שלך לפני הייבוא. נוצר ב-${esc(new Date().toISOString().slice(0, 16).replace('T', ' '))}.</p>

<h2>סיכום</h2>
<div class="wrap"><table><thead><tr><th></th><th>אנשים</th><th>נכסים (שורות)</th><th>נכסים שזוהו</th><th>חוזים (שורות)</th><th>חוזים שזוהו</th><th>חשבונות בנק</th></tr></thead>
<tbody>${countRows}</tbody></table></div>
<p class="lead">סה"כ: ${st.parties.size} אנשים וגופים (אחרי איחוד שמות זהים בין מדינות), ${st.buildings.size} בניינים, ${st.properties.size} נכסים, ${st.ownerships.length} שורות בעלות, ${st.leases.length} חוזים.</p>

<h2>מה צריך בדיקה</h2>
${issueBlocks}

<h2>נכסים כפי שזוהו</h2>
<input id="f" placeholder="סינון לפי שם, בניין או מספר דירה" oninput="for(const r of document.querySelectorAll('#p tbody tr'))r.hidden=!r.textContent.toLowerCase().includes(this.value.toLowerCase())">
<div class="wrap" style="margin-top:8px"><table id="p"><thead><tr><th>מדינה</th><th>עיר</th><th>פרויקט</th><th>בניין</th><th>דירה</th><th>סטטוס</th><th>בעלים</th><th>שם ב-Airtable</th></tr></thead>
<tbody>${propertyRows}</tbody></table></div>
</body></html>`;
}

main();
