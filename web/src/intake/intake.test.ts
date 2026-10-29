import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseGershon, parseGershonBalance } from './gershon.ts';
import { gridFromJson, gridFromXlsx, type GridJson } from './grid.ts';
import { matchProperty, sameOwner, type PropertyForMatch } from './match.ts';
import { FormatError } from './types.ts';
import { dayMonth, findPeriod, num } from './util.ts';
import { parseVitaly } from './vitaly.ts';

// Fixtures are the real January 2026 reports with every owner name replaced.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')) as GridJson;
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
  const r = parseVitaly(gridFromJson(fixture('vitaly_2026_01.json')), '2026_RENT_JANUARY_PLC.xlsx');
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
  assert.throws(() => parseVitaly(gridFromJson(j)), FormatError);
});

test('Gershon: FX from the dollar fund, then building and legal fees', () => {
  const r = parseGershon(gridFromJson(fixture('gershon_2026_01.json')), 'Utilities_PLC_January_2026.xlsx');
  assert.equal(r.period, '2026-01-01');
  assert.deepEqual(r.warnings, []);
  assert.equal(new Set(r.rows.map((x) => x.property.ref)).size, 8);

  const apt50 = r.rows.filter((x) => x.property.ref === '3(50)');
  assert.deepEqual(apt50.map((x) => x.proposed!.category), ['fx', 'building_fees', 'legal_fees']);
  const [usd, uah] = apt50[0].proposed!.entries;
  assert.deepEqual([usd.amount, usd.currency, uah.amount, uah.currency, usd.fx_rate], [-88.17, 'USD', 3791.14, 'UAH', 42.9981]);
  assert.equal(apt50[1].proposed!.entries[0].amount, -2823.64);
  assert.deepEqual(apt50[2].proposed!.entries.map((e) => e.amount), [-967.5, 967.5]);

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
  const g = await gridFromXlsx((await wb.xlsx.writeBuffer()) as ArrayBuffer);
  assert.equal(g.sheet, 'СІЧЕНЬ 2026');
  assert.deepEqual([g.value(3, 2), g.value(4, 2), g.value(6, 2)], ['3(29)', null, null]);
  assert.deepEqual([g.value(3, 7), g.formula(3, 7)], [20, '=E3*2']);
});
