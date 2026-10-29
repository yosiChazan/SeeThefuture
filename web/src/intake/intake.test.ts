import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseGershon, parseGershonBalance } from './gershon.ts';
import { bookFromJson, bookFromXlsx, type GridJson } from './grid.ts';
import { itaiHint, parseItai } from './itai.ts';
import { matchProperty, sameOwner, type PropertyForMatch } from './match.ts';
import { FormatError } from './types.ts';
import { dayMonth, findPeriod, num } from './util.ts';
import { parseVitaly } from './vitaly.ts';

// Fixtures are the real January 2026 reports with every owner name replaced.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as GridJson;
const fixtureBook = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as GridJson[];
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

test('numbers, months and day.month dates', () => {
  assert.equal(num('47 024,34'), 47024.34);
  assert.equal(num('1,348.68'), 1348.68);
  assert.equal(num('$38,05'), 38.05);
  assert.equal(findPeriod('СІЧЕНЬ 2026'), '2026-01-01');
  assert.equal(findPeriod('Utilities for January 2026 (may include past debts)'), '2026-01-01');
  assert.equal(findPeriod('x', '2026_RENT_JULY_PLC.xlsx'), '2026-07-01');
  assert.equal(dayMonth('27.01.', '2026-01-01'), '2026-01-27');
  assert.equal(dayMonth('25.12.', '2026-01-01'), '2025-12-25');
});

test('Vitaly: every apartment, rent, fees and expenses, and the file totals agree', () => {
  const r = parseVitaly(bookFromJson(fixture('vitaly_2026_01.json')), '2026_RENT_JANUARY_PLC.xlsx');
  assert.equal(r.period, '2026-01-01');
  assert.deepEqual(r.warnings, []);
  assert.equal(new Set(r.rows.map((x) => x.property.ref)).size, 10);
  const of = (cat: string) => r.rows.filter((x) => x.proposed?.category === cat);
  assert.equal(sum(of('rent').map((x) => x.proposed!.entries[0].amount)), 216887);
  assert.equal(sum(of('mgmt_fee').map((x) => x.proposed!.entries[1].amount)), 21688);
  assert.equal(sum(r.rows.filter((x) => x.kind === 'הוצאה').map((x) => -x.proposed!.entries[0].amount)), 37709);

  const apt25 = r.rows.filter((x) => x.property.ref === 'PLC 17(2), APT. 25');
  assert.deepEqual(apt25.map((x) => [x.proposed?.category ?? 'info', x.proposed?.occurred_on]), [
    ['rent', '2026-01-22'], ['mgmt_fee', '2026-01-31'], ['utilities', '2026-01-15'], ['brokerage', '2026-01-22'], ['info', undefined],
  ]);
  assert.match(apt25[4].issues[0], /6561/);
  assert.deepEqual(apt25[0].property, { ref: 'PLC 17(2), APT. 25', building: '2', unit: '25', project: 'Lake city', owner: 'Katz Ruth' });
  const fps = r.rows.map((x) => x.fingerprint).filter(Boolean);
  assert.equal(new Set(fps).size, fps.length, 'fingerprints are unique');
});

test('Vitaly: a changed header stops the import', () => {
  const j = fixture('vitaly_2026_01.json');
  j.cells['1,4'] = 'CASH UAH';
  assert.throws(() => parseVitaly(bookFromJson(j)), FormatError);
});

test('Gershon: FX from the dollar fund, then building and legal fees', () => {
  const r = parseGershon(bookFromJson(fixture('gershon_2026_01.json')), 'Utilities_PLC_January_2026.xlsx');
  assert.equal(r.period, '2026-01-01');
  assert.deepEqual(r.warnings, []);
  assert.equal(new Set(r.rows.map((x) => x.property.ref)).size, 8);

  const apt50 = r.rows.filter((x) => x.property.ref === '3(50)');
  assert.deepEqual(apt50.map((x) => x.proposed!.category), ['opening_balance', 'fx', 'building_fees', 'legal_fees']);
  assert.deepEqual([apt50[0].proposed!.entries[0].amount, apt50[0].fingerprint], [126.22, 'gershon|3(50)|opening'], 'purchase money left, before January');
  assert.equal(apt50[0].errors.length, 1, 'the opening balance must be confirmed by a person');
  const [usd, uah] = apt50[1].proposed!.entries;
  assert.deepEqual([usd.amount, usd.currency, uah.amount, uah.currency, usd.fx_rate], [-88.17, 'USD', 3791.14, 'UAH', 42.9981]);
  assert.equal(apt50[2].proposed!.entries[0].amount, -2823.64);
  assert.deepEqual(apt50[3].proposed!.entries.map((e) => e.amount), [-967.5, 967.5]);
  assert.deepEqual(apt50.slice(1).map((x) => x.errors), [[], [], []]);

  // "Need to pay 3707,06" while the rows add up to 3710.06 (3 UAH water): an error to check.
  const apt32 = r.rows.filter((x) => x.property.ref === '4(32)');
  assert.ok(apt32.every((x) => x.errors.some((e) => /3707\.06/.test(e) && /3710\.06/.test(e))));

  const apt29 = r.rows.filter((x) => x.property.ref === '3(29)');
  assert.deepEqual(apt29.map((x) => x.proposed!.category), ['building_fees', 'legal_fees'], 'no dollars: no FX');
  assert.ok(apt29[0].issues.some((i) => /3692\.78/.test(i)));
  assert.equal(apt29[0].property.owner, 'Adler Maya, Segal Ido');
});

test('Gershon balance text', () => {
  assert.deepEqual(parseGershonBalance('47 024,34 - 87,95 = $46 936,39'), { before: 47024.34, usd: 87.95, after: 46936.39 });
  assert.deepEqual(parseGershonBalance(' Need to pay  3707,06'), { owes: 3707.06 });
  assert.equal(parseGershonBalance('--++'), null);
});

test('owner names across transliterations', () => {
  assert.ok(sameOwner('Yoel Emanuel Tzwigel', 'Zwiegel Joel Emmanuel'));
  assert.ok(sameOwner('Yaakov Weisberg', 'Vaisberg Yaacov'));
  assert.ok(sameOwner('Reizy Kapolnik', 'Kopilnik Rayzel'));
  assert.ok(!sameOwner('Dana Levin', 'Ruth Katz'));
});

test('matching: remembered name, owner, building', () => {
  const props: PropertyForMatch[] = [
    { id: 'a', unit_no: '42', country_code: 'UA', building: '2.4', project: 'Lake city', owners: ['Yoel Emanuel Tzwigel'] },
    { id: 'b', unit_no: '30', country_code: 'UA', building: '2', project: 'Lake city', owners: ['Yaakov Kreisler'] },
    { id: 'c', unit_no: '30', country_code: 'UA', building: '4', project: 'Lake city', owners: ['Tamarsky David'] },
  ];
  const none = new Map<string, string>();
  const tz = matchProperty({ ref: 'PLC 11(4), APT. 42', building: '4', unit: '42', project: 'Lake city', owner: 'Zwiegel Joel Emmanuel' }, 'UA', props, none);
  assert.equal(tz.propertyId, 'a');
  assert.match(tz.note!, /בניין 4 בדוח, 2.4 במערכת/);
  assert.equal(matchProperty({ ref: '4(30)', building: '4', unit: '30', project: 'Lake city', owner: 'Tamarski David' }, 'UA', props, none).propertyId, 'c');
  const unknown = matchProperty({ ref: '4(30)', building: '4', unit: '30', project: 'Lake city', owner: 'Someone Else' }, 'UA', props, none);
  assert.deepEqual([unknown.propertyId, unknown.candidates], [null, ['b', 'c']]);
  assert.equal(matchProperty({ ref: 'X', unit: '1' }, 'UA', props, new Map([['X', 'b']])).propertyId, 'b');
});

test('xlsx reader: merged cells appear once, formulas keep their cached result', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('СІЧЕНЬ 2026');
  ws.getCell('B3').value = '3(29)';
  ws.mergeCells('B3:B6');
  ws.getCell('E3').value = 10;
  ws.getCell('G3').value = { formula: 'E3*2', result: 20 };
  wb.addWorksheet('Expenses').getCell('A1').value = 'amount paid (RON)';
  const book = await bookFromXlsx((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  const g = book.sheets[0];
  assert.equal(g.sheet, 'СІЧЕНЬ 2026');
  assert.equal(book.sheet(/^expenses$/i)?.value(1, 1), 'amount paid (RON)');
  assert.deepEqual([g.value(3, 2), g.value(4, 2), g.value(6, 2)], ['3(29)', null, null]);
  assert.deepEqual([g.value(3, 7), g.formula(3, 7)], [20, '=E3*2']);
});

test('Itai: names of apartments', () => {
  assert.deepEqual(itaiHint('Vasile_Lascar6_ap.6-L1'), { ref: 'Vasile_Lascar6_ap.6-L1', street: 'Vasile Lascar 6', unit: '6', lot: '1', owner: undefined });
  assert.deepEqual(itaiHint('Balcescu32-34_ap.17-L2'), { ref: 'Balcescu32-34_ap.17-L2', street: 'Balcescu 32 34', unit: '17', lot: '2', owner: undefined });
  assert.deepEqual(itaiHint('Vulcanescu_10'), { ref: 'Vulcanescu_10', street: 'Vulcanescu', unit: '10', lot: undefined, owner: undefined });
  assert.deepEqual(itaiHint('Covaci10_L1'), { ref: 'Covaci10_L1', street: 'Covaci 10', unit: '', lot: '1', owner: undefined });
  assert.deepEqual(itaiHint('Covaci10_L1+L2')?.lot, '1+2');
  assert.equal(itaiHint('all'), null);
  assert.equal(itaiHint('none'), null);
});

test('Itai: 2026 receipts to the owner, expenses and reimbursements through Itai', () => {
  const r = parseItai(bookFromJson(fixtureBook('itai_client.json')));
  assert.equal(r.period, '2026-10-01');
  assert.match(r.warnings[0], /לפני 01.01.2026 לא נקלטו/);
  assert.ok(r.rows.every((x) => x.proposed!.occurred_on >= '2026-01-01'));
  const by = (cat: string) => r.rows.filter((x) => x.proposed!.category === cat);
  assert.ok(by('rent').length > 10);
  assert.ok(by('rent').every((x) => x.proposed!.entries[0].account?.kind === 'client_bank' && x.proposed!.entries[0].amount > 0));
  assert.ok(by('mgmt_fee').every((x) => x.proposed!.entries[0].account?.kind === 'manager_cash' && x.proposed!.entries[0].amount < 0));
  const back = by('transfer');
  assert.ok(back.length >= 1);
  assert.ok(back.every((x) => x.proposed!.entries.reduce((s, e) => s + e.amount, 0) === 0), 'a reimbursement only moves money');
  assert.ok(r.rows.filter((x) => x.raw.sheet === 'Incomes').every((x) => x.property.owner === 'Owner Demo'));
  const fps = r.rows.map((x) => x.fingerprint);
  assert.equal(new Set(fps).size, fps.length, 'fingerprints are unique');
});

test('Itai: a file without the expected sheets stops the import', () => {
  assert.throws(() => parseItai(bookFromJson(fixtureBook('itai_client.json').slice(0, 1))), FormatError);
});

test('matching in Romania: street, apartment and lot among the owner\'s properties', () => {
  const p = (id: string, building: string, unit_no: string, owner = 'Owner Demo'): PropertyForMatch =>
    ({ id, unit_no, country_code: 'RO', building, project: null, owners: [owner] });
  const props = [
    p('v1', 'Vasile Lascar 6', '6-1'), p('v2', 'Vasile Lascar 6', '6-2'),
    p('b1', 'Nicolae Balcescu 32-34', '17-LOT1-BIG'), p('b2', 'Nicolae Balcescu 32-34', '17-LOT2-SMALL'),
    p('c1', 'Covaci 10', '8-LOT1-SMALL', 'Yom Tov SRL'), p('m', 'Mircea Vulcanescu', '10', 'Yom Tov SRL'),
  ];
  const m = (ref: string, owner: string) => matchProperty(itaiHint(ref, owner)!, 'RO', props, new Map()).propertyId;
  assert.equal(m('Vasile_Lascar6_ap.6-L2', 'Demo Owner'), 'v2');
  assert.equal(m('Balcescu32-34_ap.17-L1', 'Owner Demo'), 'b1');
  assert.equal(m('Covaci10_L1', 'Yom Tov SRL'), 'c1');
  assert.equal(m('Covaci10_L1+L2', 'Yom Tov SRL'), 'c1', 'lots rented together go on the first');
  assert.equal(m('Vulcanescu_10', 'Yom Tov SRL'), 'm');
  assert.equal(m('Vasile_Lascar6_ap.6-L1', 'Yom Tov SRL'), null, 'not this owner\'s property');
});

test('Vitaly June: "EXPENSES JUNE" header, totals agree, an old date is an error to check', () => {
  const r = parseVitaly(bookFromJson(fixture('vitaly_2026_06.json')), '2026_RENT_JUNE_PLC.xlsx');
  assert.equal(r.period, '2026-06-01');
  assert.deepEqual(r.warnings, []);
  assert.equal(new Set(r.rows.map((x) => x.property.ref)).size, 10);
  const of = (cat: string) => r.rows.filter((x) => x.proposed?.category === cat);
  assert.equal(sum(of('rent').map((x) => x.proposed!.entries[0].amount)), 242300);
  assert.equal(sum(of('mgmt_fee').map((x) => x.proposed!.entries[1].amount)), 24230);
  assert.equal(sum(r.rows.filter((x) => x.kind === 'הוצאה').map((x) => -x.proposed!.entries[0].amount)), 11990);

  const stale = r.rows.filter((x) => x.errors.length);
  assert.deepEqual(stale.map((x) => [x.property.ref, x.proposed!.occurred_on]), [['PLC 11(4), APT. 42', '2026-01-22']]);
  assert.equal(r.rows.find((x) => x.property.ref === 'PLC 11(4), APT. 36')?.property.unit, '36', '"  PLC 11(4), APT.36 " with spaces');
  const apt35 = r.rows.filter((x) => x.property.ref === 'PLC 17(2), APT. 35');
  assert.equal(apt35.filter((x) => !x.proposed).length, 3, 'three debts shown for information');
});
