import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { docFromXml, type Doc } from './docx.ts';
import { firstDate, ofirHint, parseOfir } from './ofir.ts';
import { FormatError } from './types.ts';

// Ofir's owner statements (decision 207): real reports with every person's name, phone and
// account replaced.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as Doc;
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

test('Word XML: runs of one highlight are one, colours kept', () => {
  const xml = '<w:body><w:p><w:r><w:t>שכירות 550 יורו = </w:t></w:r><w:r><w:rPr><w:highlight w:val="darkYellow"/></w:rPr><w:t>240</w:t></w:r>'
    + '<w:r><w:rPr><w:highlight w:val="darkYellow"/></w:rPr><w:t>1 רון</w:t></w:r></w:p></w:body>';
  const d = docFromXml(xml);
  assert.equal(d.paragraphs.length, 1);
  assert.deepEqual(d.paragraphs[0].runs.map((r) => [r.mark, r.text]), [[null, 'שכירות 550 יורו = '], ['darkYellow', '2401 רון']]);
});

test('dates: full, two-digit year, month alone', () => {
  assert.equal(firstDate('15.6.2024 שכירות'), '2024-06-15');
  assert.equal(firstDate('2.9.24 שיפוץ'), '2024-09-02');
  assert.equal(firstDate('5.2024 שכירות דירה'), '2024-05-01');
  assert.equal(firstDate('INTR 155.02 TOTAL'), null);
});

test('the apartment from the head of the report', () => {
  assert.deepEqual(ofirHint(['Calea Mosilor, nr. 96, ap. 2, sector 2, Bucuresti,', 'COHEN ORLY']),
    { ref: 'Mosilor ap 2', street: 'Mosilor', unit: '2', owner: 'COHEN ORLY' });
  assert.equal(ofirHint(['Uri Alexandru Beldiman 1, Et.6, Apt.60,', 'SARA GENZLER'])?.unit, '60');
  assert.equal(ofirHint(['URI YOM-TOV - OWNER SAMPLE', 'Bulevardul Gheorghe Magheru,General, nr. 29,Sc.A, et. 6, ap. 44, sector 1, ENEL- Client SOMEONE ELSE'])?.owner, 'OWNER SAMPLE');
});

test('Mosilor: rent in euro, fee in euro, change to lei; his totals hold', () => {
  const r = parseOfir(fixture('ofir_mosilor.json'));
  assert.equal(r.rows[0].property.ref, 'Mosilor ap 2');
  const rent = r.rows.filter((x) => x.proposed?.category === 'rent');
  const fx = r.rows.filter((x) => x.proposed?.category === 'fx');
  // 15.6.2024: 550 € rent, 60 € fee, 490 € → 2401 lei.
  const june = r.rows.filter((x) => x.proposed?.occurred_on === '2024-06-15');
  assert.deepEqual(june.map((x) => x.proposed!.category).sort(), ['fx', 'mgmt_fee', 'rent']);
  assert.equal(june.find((x) => x.proposed!.category === 'rent')!.proposed!.entries[0].amount, 550);
  assert.deepEqual(june.find((x) => x.proposed!.category === 'fx')!.proposed!.entries.map((e) => [e.amount, e.currency]), [[-490, 'EUR'], [2401, 'RON']]);
  assert.equal(rent.length, fx.length);
  // His totals: every block's lei income and expenses are what the lines add up to.
  assert.ok(r.checks!.some((c) => c.includes('27209')));
  assert.ok(r.checks!.some((c) => c.includes('2125')));
  // The cost written only inside a summary line, on the summary's date.
  const ac = r.rows.find((x) => x.proposed?.entries[0].amount === -2793.44)!;
  assert.equal(ac.proposed!.occurred_on, '2025-05-05');
  // The cash handed over, to be confirmed.
  const t = r.rows.filter((x) => x.proposed?.category === 'transfer');
  assert.equal(t.length, 1);
  assert.equal(t[0].proposed!.occurred_on, '2025-11-28');
  assert.equal(t[0].proposed!.entries[1].amount, 38150);
  // A line without a date takes its block's summary date, for a decision at intake.
  const undated = r.rows.find((x) => /טיפול בסידור כל החובות/.test(String(x.raw.text)))!;
  assert.equal(undated.proposed!.occurred_on, '2025-05-05');
  assert.equal(undated.raw.date_guess, true);
  // From July 2026 the same 490 € are 2500 lei.
  assert.equal(r.rows.find((x) => x.proposed?.category === 'fx' && x.proposed.occurred_on === '2026-07-15')!.proposed!.entries[1].amount, 2500);
});

test('Regina Maria: rent with tax in lei, fee in lei', () => {
  const r = parseOfir(fixture('ofir_regina.json'));
  const feb = r.rows.filter((x) => x.proposed?.occurred_on === '2024-02-15');
  const amount = (c: string) => feb.find((x) => x.proposed!.category === c)!.proposed!.entries[0].amount;
  assert.equal(amount('rent'), 300);
  assert.equal(amount('tax_withheld'), -151);
  assert.equal(amount('mgmt_fee'), -302);
  // What remains is the 1058 lei of the line.
  assert.equal(sum(feb.flatMap((x) => x.proposed!.entries).filter((e) => e.currency === 'RON' && !e.external).map((e) => e.amount)), 1058);
  // A struck-out line (grey) is shown, not posted.
  assert.ok(r.rows.some((x) => !x.proposed && /1058/.test(String(x.raw.text))));
  // "24.5.2028" for 2024: flagged, and not the report's month.
  assert.ok(r.rows.some((x) => x.proposed?.occurred_on === '2028-05-24' && x.errors.some((e) => e.includes('אחרי תאריך הסיכום'))));
  assert.notEqual(r.period, '2028-05-01');
});

test('Ghica: rent in lei with a fee, money sent to the owner, credits not posted', () => {
  const r = parseOfir(fixture('ofir_ghica.json'));
  const rent = r.rows.filter((x) => x.proposed?.category === 'rent');
  assert.ok(rent.every((x) => x.proposed!.entries[0].amount === 2488 && x.proposed!.entries[0].currency === 'RON'));
  // "5.2024 … עדיין לא שילם" is red: not counted.
  assert.ok(!rent.some((x) => x.proposed!.occurred_on === '2024-05-01'));
  const t = r.rows.filter((x) => x.proposed?.category === 'transfer');
  assert.deepEqual(t.map((x) => [x.proposed!.entries[1].amount, x.proposed!.entries[1].currency]).sort(), [[1055.6, 'EUR'], [7000, 'EUR']]);
  assert.ok(r.rows.some((x) => !x.proposed && /235 יורו/.test(String(x.raw.text))));
  assert.equal(r.warnings.length, 0);
});

test('not Ofir\'s report: refused', () => {
  assert.throws(() => parseOfir({ paragraphs: [{ text: 'hello', runs: [{ text: 'hello', mark: null }] }] }), FormatError);
});
