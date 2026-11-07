import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { cleanNote, periodOf } from './ukraine_rent.ts';

test('the month a rent payment is for, across the turn of the year', () => {
  assert.equal(periodOf('מאי ', '2024-06-26'), '2024-05-01');
  assert.equal(periodOf('דצמבר', '2025-01-08'), '2024-12-01');
  assert.equal(periodOf('ינואר', '2024-12-28'), '2025-01-01');
  assert.equal(periodOf('דמי ניהול', '2024-06-26'), null);
  assert.equal(periodOf('מאי', undefined), null);
});

test('note lines about money going to Gershon or offsets are not copied', () => {
  assert.equal(cleanNote('השכרנו את הדירה\nהועבר לגרשון\nהופקד לכרטיס של גרשון\nיקוזז מהשכירות של מאי\nחוזה חדש'), 'השכרנו את הדירה\nחוזה חדש');
  assert.equal(cleanNote(undefined), '');
});
