import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { changedFields, groupActivity, recordLabel, recordLink, type AuditRow } from './activity.ts';

const row = (p: Partial<AuditRow>): AuditRow => ({ id: 1, at: '2026-11-04T10:00:00Z', table_name: 'parties', row_id: 'p1', action: 'INSERT', old_row: null, new_row: null, ...p });

test('an update lists the fields it changed, in Hebrew', () => {
  const r = row({ action: 'UPDATE', old_row: { display_name: 'א', phone: '1', updated_at: 'x' }, new_row: { display_name: 'א', phone: '2', updated_at: 'y' } });
  assert.deepEqual(changedFields(r), ['טלפון']);
});

test('labels and links per kind of record', () => {
  assert.equal(recordLabel(row({ table_name: 'properties', new_row: { unit_no: '12' } })), 'דירה 12');
  assert.equal(recordLabel(row({ table_name: 'import_batches', new_row: { status: 'committed', notes: '{"file_name":"a.xlsx"}' } })), 'a.xlsx (נרשם)');
  assert.equal(recordLink(row({ table_name: 'documents', new_row: { entity_type: 'property', entity_id: 'x1' } })), '/properties/x1');
  assert.equal(recordLink(row({ table_name: 'parties', action: 'DELETE' })), null);
});

test('a report approval of many rows is one line', () => {
  const rows = [0, 1, 2].map((i) => row({ id: i, table_name: 'transactions', action: 'UPDATE', at: `2026-11-04T10:00:0${i}Z` }));
  rows.push(row({ id: 9, table_name: 'sessions', action: 'LOGIN', at: '2026-11-04T09:00:00Z' }));
  const g = groupActivity(rows);
  assert.equal(g.length, 2);
  assert.equal(g[0].count, 3);
});
