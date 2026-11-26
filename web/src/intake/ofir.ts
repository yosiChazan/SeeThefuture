// Ofir's owner statement for one apartment in Bucharest (SPEC decision 207): a Word document he
// keeps adding lines to, one per event, with every amount highlighted in the colour of what it is:
//   green: an expense in lei · cyan: an expense in euro · dark yellow: income in lei ·
//   magenta: income in euro · red: his totals and balances · other colours: notes, not counted.
// Every few months a block "סיכום עד לתאריך <date>" sums the lines above it, and "הועברו לחשבונך"
// says what was handed to the owner. The last block is an empty template ("סיכום עד לתאריך--").
//
// Rent (decision 207, item 1): the rent arrives in euro, Ofir's fee is taken in euro, and the rest
// is changed to lei: three transactions. Rent in lei ("2488 -300 טיפול = 2188"): rent and fee.
// A line without a date takes the date of the block's summary, marked for a decision at intake.
// Ofir's own totals are checked against the lines; a total that differs is a warning to look at,
// not a refusal, since his totals carry balances from the blocks above.

import { round2 } from './util.ts';
import type { Doc, DocParagraph } from './docx.ts';
import { FormatError, type ParseResult, type ParsedRow, type PropertyHint, type ProposedEntry } from './types.ts';

const ADAPTER = 'ofir';
const KNOWN = new Set(['green', 'cyan', 'darkYellow', 'magenta']);
const HEADER = /הוצאות\s*ותשלומים/;
const SUMMARY = /סיכום\s*עד\s*לתאריך\s*(.*)$/;
const SEPARATOR = /^[=\-_]{5,}/;
const RON = 'RON' as const;
const EUR = 'EUR' as const;

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const month = (on: string) => `${on.slice(0, 7)}-01`;
const he = (on: string) => on.split('-').reverse().join('.');

// "15.6.2024", "2.9.24", or a month alone ("5.2024" → the 1st). The first date in the text.
export function firstDate(t: string): string | null {
  const full = /(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})(?![\d])/.exec(t);
  const monthOnly = /(?<![\d.,-])(\d{1,2})\.(20\d\d)(?![\d.])/.exec(t);
  const pick = full && (!monthOnly || full.index <= monthOnly.index) ? full : null;
  if (pick) {
    const y = Number(pick[3].length === 2 ? `20${pick[3]}` : pick[3]); const m = Number(pick[2]); const d = Number(pick[1]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return iso(y, m, d);
  }
  if (monthOnly && Number(monthOnly[1]) >= 1 && Number(monthOnly[1]) <= 12) return iso(Number(monthOnly[2]), Number(monthOnly[1]), 1);
  return null;
}
const lastDate = (t: string) => {
  const all = [...t.matchAll(/(?<![\d.,])(\d{1,2})\.(\d{1,2})\.(\d{4})(?!\d)/g)];
  const m = all[all.length - 1];
  return m ? iso(Number(m[3]), Number(m[2]), Number(m[1])) : null;
};

// The numbers of a highlighted run: "1232.77 Ron", "61,61 Ron" (comma for decimals), "- 10535.19".
const numbers = (t: string) => [...t.replace(/(\d)\s+(?=\d)/g, '$1').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
// The amount a run stands for: its last number ("23.4.2026 150 רון" → 150, "-531.95 centrala =338.7 Ron" → 338.7).
const amountOf = (t: string) => { const n = numbers(t.replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, ' ')); return n.length ? n[n.length - 1] : null; };
const euros = (t: string) => [...t.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:יורו|euro|eur|€)/gi)].map((m) => Number(m[1].replace(',', '.')));

function expenseCategory(t: string): string {
  if (/impozit|ipozit|מיס|ANAF|ארנונה/i.test(t)) return 'other';
  if (/Enel|PPC|INTR|חשמל|מיים|מים|גז|Caldura|חימום|aqua|apa\b/i.test(t)) return 'utilities';
  if (/וועד|ועד|בלוק|בניין|אדמינ|debite|נשיאה|Asociatia/i.test(t)) return 'building_fees';
  if (/עמלת? (איכלוס|תיווך|מתווך)/.test(t)) return 'brokerage';
  if (/תיקון|החלפ|קניית|קניתי|התקנ|מזגן|מקרר|רדיאטור|ברז|חשמלאי|אינסטל|צבע|מנעול|סיפון|נזיל|ארון|שיפוץ|חומרים|calorifer/i.test(t)) return 'repair';
  return 'other';
}

// The apartment, from the lines above the first table title: the first Latin address with an
// apartment number ("Calea Mosilor, nr. 96, ap. 2", "Alexandru Beldiman 1, Et.6, Apt.60").
export function ofirHint(head: string[]): PropertyHint | null {
  for (const line of head) {
    const m = /^(?:URI|Uri)?\s*(\d+\s+)?(?:URI\s+)?(.*?[A-Za-z]{4,}.*?)[,\s]+(?:nr\.?\s*\d+\w*[,\s]+)?(?:Sc\.?\s*\w+[,\s]+)?(?:Et\.?\s*\d+[,\s]+|et\.?\s*\d+[,\s]+)?(?:ap|apt)\.?\s*(\d+\w?)/i.exec(line);
    if (!m) continue;
    const street = m[2].replace(/\b(Bulevardul|Strada|Str\.?|Calea|General|URI)\b/gi, ' ').replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();
    const after = line.slice((m.index ?? 0) + m[0].length).replace(/\b(ENEL|Client)\b.*$/i, '');
    const named = /,\s*(?:Bucuresti,\s*)?([A-Z][A-Z]+(?:\s+[A-Z][A-Z]+){1,3})\s*$/.exec(after)?.[1];
    // "COHEN ORLY" on its own line, or after "URI YOM-TOV - ".
    const caps = head.map((l) => l.trim().replace(/^URI\b.*?\s-\s/, '')).find((l) => /^[A-Z][A-Z-]+(\s+[A-Z][A-Z-]+){1,3}$/.test(l) && !/^URI\b/.test(l));
    const owner = named ?? caps ?? (/([A-Z]{3,}\s+[A-Z]{3,})\s*$/.exec(line)?.[1]);
    return { ref: `${street} ap ${m[3]}`, street, unit: m[3], owner };
  }
  return null;
}

interface Totals { expRon: number; expEur: number; incRon: number; incEur: number }
const zero = (): Totals => ({ expRon: 0, expEur: 0, incRon: 0, incEur: 0 });

export function parseOfir(doc: Doc, fileName = ''): ParseResult {
  const ps = doc.paragraphs;
  const first = ps.findIndex((p) => HEADER.test(p.text));
  if (first < 0) throw new FormatError('לא נמצאה שורת הכותרת "הוצאות ותשלומים ברון…" של הדוח');
  const hint = ofirHint(ps.slice(0, first).map((p) => p.text)) ?? ofirHint([fileName.replace(/_/g, ' ')]);
  if (!hint) throw new FormatError('לא נמצאה כתובת הדירה (רחוב ומספר דירה) בראש הדוח');

  // The blocks: each ends with its summary. The empty template at the end, and what comes after
  // it (bank details, stray lines), is not read.
  const summaries: { at: number; date: string | null; template: boolean }[] = [];
  for (let i = first; i < ps.length; i++) {
    const m = SUMMARY.exec(ps[i].text);
    if (m) summaries.push({ at: i, date: firstDate(m[1]), template: !firstDate(m[1]) });
  }
  const template = summaries.find((s) => s.template);
  const end = template ? template.at : ps.length;

  const rows: ParsedRow[] = [];
  const warnings: string[] = [];
  const checks: string[] = [];
  const seen = new Map<string, number>();
  let latest = '';

  const add = (i: number, part: string, kind: string, category: string | null, on: string, amount: number, description: string,
    entries: ProposedEntry[], errors: string[] = [], issues: string[] = []) => {
    const key = [ADAPTER, hint.ref, category, on, amount, description.slice(0, 40)].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    rows.push({
      ref: `P${i + 1}${part}`, property: hint, kind, issues, errors,
      proposed: category ? { occurred_on: on, period: month(on), category, description, entries } : null,
      fingerprint: category ? `${key}#${n}` : null,
      // date_guess: the line has no date of its own; the review screen lets the date be chosen.
      raw: { row: i + 1, property_ref: hint.ref, owner: hint.owner, amount, description, text: ps[i].text, date_guess: errors.some((e) => e.startsWith('אין תאריך')) },
    });
  };
  const cash = (amount: number, currency: typeof RON | typeof EUR, memo?: string): ProposedEntry =>
    ({ amount: round2(amount), currency, ...(memo ? { memo } : {}), account: { kind: 'manager_cash', holder: 'source' } });

  // One block: the lines from `from` to the summary at `to` (or the end).
  const block = (from: number, to: number, summary: { date: string | null } | null, tail = false) => {
    const read = zero();
    const guess = summary?.date ?? null;
    let inSummary = false; let toOwner = false;
    for (let i = from; i < to; i++) {
      const p = ps[i];
      const t = p.text;
      if (HEADER.test(t) || SEPARATOR.test(t)) { if (SEPARATOR.test(t)) { inSummary = false; toOwner = false; } continue; }
      if (inSummary) {
        // After a summary, before its separator: what was handed to the owner, or paid out of the balance.
        if (/^(הוצאות|הכנסות)\s|^סיכום/.test(t)) continue;   // Ofir's totals: checked by verify()
        if (/^הועבר(ו)?\s*לחשבונך|^הועבר/.test(t)) toOwner = true;
        // The first amount with its currency ("7000 euro = 23027 Nis" → 7000 €).
        const m = /(\d+(?:[.,]\d+)?)\s*(יורו|euro|eur\b|€|רון|ron\b|lei\b)/i.exec(t.replace(/^.*?לחשבונך\s*:?/, ''));
        const amount = m ? Number(m[1].replace(',', '.')) : null;
        const currency = m && /יורו|euro|eur|€/i.test(m[2]) ? EUR : RON;
        const credit = /נשאר|הפרש|כרדיט|יתרה|זכות/.test(t);
        if (amount && credit) add(i, '', 'לידיעה', null, guess ?? latest, amount, t.slice(0, 300), [], [], ['יתרה או זכות שנשארה אצל אופיר: לא נרשמת']);
        else if (amount) {
          const on = lastDate(t) ?? firstDate(t) ?? guess ?? latest;
          if (toOwner) {
            add(i, '', 'העברה לבעלים', 'transfer', on, amount, `אופיר העביר לבעלים: ${t}`.slice(0, 300), [
              { ...cash(-amount, currency) },
              { amount: round2(amount), currency, account: { kind: 'client_bank', holder: 'beneficiary' } },
            ], ['העברה לבעלים: לוודא שהגיעה לבעלים',
              ...(currency === EUR ? ['העברה ביורו: אם אופיר המיר לשם כך רון ליורו, צריך לרשום גם את ההמרה'] : [])]);
          } else {
            add(i, '', 'תשלום מהיתרה', /בלוק|וועד|בניין|debite/i.test(t + ps[i - 1]?.text) ? 'building_fees' : 'other', on, amount, t.slice(0, 300),
              [cash(-amount, currency, t.slice(0, 200))], ['תשלום מתוך היתרה שאינו העברה לבעלים: לבדוק מה זה']);
          }
        }
        continue;
      }
      if (SUMMARY.test(t)) { inSummary = true; continue; }
      const marked = p.runs.filter((r) => r.mark && numbers(r.text).length);
      const known = marked.filter((r) => KNOWN.has(r.mark!));
      if (!marked.length) continue;
      const date = firstDate(t);
      if (date && date > latest && date <= new Date().toISOString().slice(0, 10)) latest = date;
      const on = date ?? guess ?? latest;
      const noDate = date ? [] : [guess ? `אין תאריך בשורה: נקבע תאריך הסיכום (${he(guess)}). לבדוק או לשנות` : 'אין תאריך בשורה ואין סיכום אחריה: לבחור תאריך'];
      const late = date && guess && date > guess ? [`התאריך ${he(date)} אחרי תאריך הסיכום (${he(guess)}): אולי טעות הקלדה`] : [];
      const errs = [...noDate, ...late];

      // Not counted by Ofir (grey, red, a name in yellow…): shown, never posted.
      if (!known.length) {
        const n = amountOf(marked[0].text) ?? 0;
        add(i, '', 'לידיעה', null, on, n, t.slice(0, 300), [], [], [`סכום בצבע שאינו נספר (${marked.map((r) => r.mark).join(', ')}): לא נרשם`]);
        continue;
      }
      const sum = (mark: string) => round2(known.filter((r) => r.mark === mark).reduce((a, r) => a + (amountOf(r.text) ?? 0), 0));
      const netRon = sum('darkYellow'); const netEur = sum('magenta');
      const expRon = sum('green'); const expEur = sum('cyan');
      read.expRon += expRon; read.expEur += expEur; read.incRon += netRon; read.incEur += netEur;

      const rent = (netRon || netEur) && /שכירות|שוכר|נשאר|עמלה|טיפול|ניהול/.test(t);
      if (rent) rentRows(i, t, on, netRon, netEur, errs);
      else {
        if (netRon) {
          const carry = /מהסיכום|מסיכום|סגירת חשבון|למעלה/.test(t);
          add(i, 'i', carry ? 'יתרה מהסיכום הקודם' : 'הכנסה', carry ? null : 'other', on, netRon, t.slice(0, 300),
            carry ? [] : [cash(netRon, RON)], carry ? [] : [...errs, 'הכנסה שאינה שכירות: לבדוק מה זו'], carry ? ['יתרה שהועברה מהסיכום הקודם: לא נרשמת שוב'] : []);
        }
        if (netEur) add(i, 'j', 'הכנסה ביורו', 'other', on, netEur, t.slice(0, 300), [cash(netEur, EUR)], [...errs, 'הכנסה ביורו שאינה שכירות: לבדוק מה זו']);
      }
      // Ofir's own work in lei ("180 רון על העבודה שלי"): his fee, like the one taken from the rent.
      // Money sent to the owner, written as an expense ("נשלח לבעלים … 1055.6 יורו"): a transfer.
      if ((expRon || expEur) && /נשלח לבעלים|הועבר לבעלים|העברתי לבעלים/.test(t)) {
        const [amount, currency] = expEur ? [expEur, EUR] as const : [expRon, RON] as const;
        add(i, 'e', 'העברה לבעלים', 'transfer', on, amount, `אופיר העביר לבעלים: ${t}`.slice(0, 300), [
          cash(-amount, currency), { amount: round2(amount), currency, account: { kind: 'client_bank', holder: 'beneficiary' } },
        ], [...errs, 'העברה לבעלים: לוודא שהגיעה לבעלים']);
        continue;
      }
      if (expRon && /על העבודה שלי|עמלת (טיפול|ניהול)/.test(t)) {
        add(i, 'e', 'עמלה לאופיר', 'mgmt_fee', on, expRon, t.slice(0, 300), [cash(-expRon, RON), { amount: expRon, currency: RON, external: 'source' }], errs);
      } else if (expRon) add(i, 'e', 'הוצאה', expenseCategory(t), on, expRon, t.slice(0, 300), [cash(-expRon, RON, t.slice(0, 200))], errs);
      if (expEur) {
        const fee = /עמלה|עמלת|טיפול|ניהול|על העבודה שלי|חוזה/.test(t) && !/רואת חשבון|ANAF|לבעלי דירה/.test(t);
        add(i, 'u', fee ? 'עמלה לאופיר (יורו)' : 'הוצאה ביורו', fee ? 'mgmt_fee' : expenseCategory(t), on, expEur, t.slice(0, 300),
          fee ? [cash(-expEur, EUR), { amount: round2(expEur), currency: EUR, external: 'source' }] : [cash(-expEur, EUR, t.slice(0, 200))], errs);
      }
    }
    // A cost written only inside the summary line ("🛑 התקנה של המזגן …: 2793.44 רון"): an expense on the summary's date.
    if (summary && tail) {
      const line = ps.slice(from, to).find((p) => /^סיכום\s*:/.test(p.text) && p.text.includes('🛑'));
      const m = line && /🛑\s*([^:]+):\s*([\d.,]+)\s*רון/.exec(line.text);
      if (m && summary.date) {
        const amount = Number(m[2].replace(',', '.'));
        add(ps.indexOf(line!), 's', 'הוצאה מתוך הסיכום', expenseCategory(m[1]), summary.date, amount, m[1].trim(), [cash(-amount, RON, m[1].trim())]);
      }
    }
    return read;
  };

  // A rent line: the euros paid, Ofir's fee, and what was changed to lei (or rent in lei).
  const rentRows = (i: number, t: string, on: string, netRon: number, netEur: number, errs: string[]) => {
    const what = `שכירות ${he(on)}`;
    const ronRent = /(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)\s*טיפול/.exec(t);
    const eur = euros(t);
    if (!eur.length && ronRent) {
      const gross = Number(ronRent[1].replace(',', '.')); const fee = Number(ronRent[2].replace(',', '.'));
      const e = Math.abs(gross - fee - netRon) > 0.5 ? [`${gross} − ${fee} אינו ${netRon}`] : [];
      add(i, 'a', 'שכירות', 'rent', on, gross, what, [cash(gross, RON)], [...errs, ...e]);
      add(i, 'b', 'עמלה לאופיר', 'mgmt_fee', on, fee, `עמלת ניהול לאופיר ${he(on)}`, [cash(-fee, RON), { amount: fee, currency: RON, external: 'source' }], errs);
      return;
    }
    if (!eur.length) { add(i, 'a', 'שכירות', 'rent', on, netRon, what, [cash(netRon, RON)], [...errs, 'שורת שכירות בלי סכום ביורו: נרשם רק הסכום ברון']); return; }
    const gross = eur[0];
    const explicitFee = /(?:עמלת טיפול|ניהול|[–-]\s*טיפול)\s+(\d+(?:[.,]\d+)?)\s*יורו/.exec(t);
    const tax = /פחות מיסים\s*(\d+(?:[.,]\d+)?)\s*רון/.exec(t);
    if (tax) {
      // "300 יורו = 1511 רון …, פחות מיסים 1360 רון, פחות עמלת טיפול 60 יורו נשאר 1058 רון"
      const lei = Number(/יורו\s*=\s*(\d+(?:[.,]\d+)?)\s*רון/.exec(t)?.[1]?.replace(',', '.') ?? NaN);
      const afterTax = Number(tax[1].replace(',', '.'));
      if (!Number.isFinite(lei)) { add(i, 'a', 'שכירות', 'rent', on, netRon, what, [cash(netRon, RON)], [...errs, 'לא זוהה מבנה השורה: נרשם רק הסכום נטו ברון']); return; }
      add(i, 'a', 'שכירות', 'rent', on, gross, what, [cash(gross, EUR)], errs);
      add(i, 'c', 'המרה', 'fx', on, lei, `המרה ${gross} € → ${lei} רון`, [{ ...cash(-gross, EUR), fx_rate: round2(lei / gross) }, { ...cash(lei, RON), fx_rate: round2(lei / gross) }], errs);
      add(i, 't', 'מס', 'tax_withheld', on, round2(lei - afterTax), `מס על השכירות ${he(on)}`, [cash(-(lei - afterTax), RON)], errs);
      const fee = round2(afterTax - netRon);
      add(i, 'b', 'עמלה לאופיר', 'mgmt_fee', on, fee, `עמלת ניהול לאופיר ${he(on)}${explicitFee ? ` (${explicitFee[1]} €)` : ''}`, [cash(-fee, RON), { amount: fee, currency: RON, external: 'source' }], errs);
      return;
    }
    const fee = explicitFee ? Number(explicitFee[1].replace(',', '.')) : eur.length > 1 ? round2(gross - eur[1]) : 0;
    const net = round2(gross - fee);
    const e: string[] = [];
    if (eur.length > 1 && !explicitFee && fee < 0) e.push(`הסכום אחרי העמלה (${eur[1]} €) גדול מהשכירות (${gross} €)`);
    if (netEur && Math.abs(netEur - net) > 0.5) e.push(`${gross} € פחות עמלה ${fee} € אינו ${netEur} €`);
    add(i, 'a', 'שכירות', 'rent', on, gross, what, [cash(gross, EUR)], [...errs, ...e]);
    if (fee) add(i, 'b', 'עמלה לאופיר', 'mgmt_fee', on, fee, `עמלת ניהול לאופיר ${he(on)}`, [cash(-fee, EUR), { amount: fee, currency: EUR, external: 'source' }], errs);
    if (netRon) {
      const rate = round2(netRon / net);
      add(i, 'c', 'המרה', 'fx', on, netRon, `המרה ${net} € → ${netRon} רון`, [{ ...cash(-net, EUR), fx_rate: rate }, { ...cash(netRon, RON), fx_rate: rate }],
        rate < 4.5 || rate > 5.5 ? [...errs, `שער ההמרה ${rate} רון ליורו חריג`] : errs);
    }
  };

  // Ofir's totals: a total holds when one of the numbers on its line is what the lines add up to.
  const verify = (s: { at: number; date: string | null }, read: Totals) => {
    const lines = ps.slice(s.at, s.at + 7).map((p) => p.text);
    const test = (label: RegExp, name: string, value: number) => {
      const line = lines.find((l) => label.test(l));
      if (!line) return;
      const ns = numbers(line.replace(/\d{1,2}\.\d{1,2}\.\d{2,4}/g, ' '));
      const ok = ns.some((n) => Math.abs(n - value) <= 0.5) || (value === 0 && ns.every((n) => n === 0));
      (ok ? checks : warnings).push(`סיכום ${s.date ? he(s.date) : ''} · ${name}: ${ok ? `${round2(value)} כמו בדוח` : `בדוח ${ns.join(' / ')}, מהשורות ${round2(value)}`}`);
    };
    test(/^הוצאות ברון/, 'הוצאות ברון', read.expRon);
    test(/^הכנסות ברון/, 'הכנסות ברון', read.incRon);
    test(/^הכנסות יורו/, 'הכנסות ביורו', read.incEur);
    test(/^הוצאות יורו/, 'הוצאות ביורו', read.expEur);
  };

  let from = first;
  for (const s of summaries.filter((x) => !x.template && x.at < end)) {
    // A block runs to the next block's first line: the summary's own lines (and the transfer)
    // up to its separator are read in the same pass.
    const next = ps.findIndex((p, j) => j > s.at && SEPARATOR.test(p.text));
    const stop = next < 0 || next > end ? end : next;
    verify(s, block(from, s.at, s));
    block(s.at, stop, s, true);
    from = stop;
  }
  // Lines after the last summary: the months not summed up yet.
  if (from < end) block(from, end, null);
  if (template && ps.slice(template.at + 1).some((p) => p.runs.some((r) => r.mark === 'darkYellow' || r.mark === 'green'))) {
    warnings.push('יש שורות עם סכומים אחרי טופס הסיכום הריק בסוף הדוח: לא נקראו. לבדוק מול אופיר');
  }
  if (!rows.length) throw new FormatError('לא נמצאו שורות עם סכומים בדוח');
  // The report's month: its latest date, leaving out dates in the future ("24.5.2028" for 2024).
  const today = new Date().toISOString().slice(0, 10);
  const dates = rows.map((r) => r.proposed?.occurred_on).filter((d): d is string => !!d && d <= today).sort();
  return { period: month(dates[dates.length - 1] ?? new Date().toISOString().slice(0, 10)), rows, warnings, checks, scope: hint.ref };
}

export type { DocParagraph };
