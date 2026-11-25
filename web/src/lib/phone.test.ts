import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parsePhoneField, toE164 } from './phone.ts';

test('phone numbers in one international form', () => {
  assert.equal(toE164('‎+972504111005'), '+972504111005');
  assert.equal(toE164('052-768-8436⁩'), '+972527688436');
  assert.equal(toE164('⁦+972 52-838-5550⁩'), '+972528385550');
  assert.equal(toE164('972527128887'), '+972527128887');
  assert.equal(toE164('02-6543210'), '+97226543210');
  assert.equal(toE164('0040 723 456 789'), '+40723456789');
  assert.equal(toE164('40723456789'), '+40723456789');
  assert.equal(toE164('⁦+1 (845) 837-9723⁩'), '+18458379723');
  assert.equal(toE164('11111'), null);
  assert.deepEqual(parsePhoneField('0587880836   0583238008'), { e164: '+972587880836', extra: ['+972583238008'] });
  assert.equal(parsePhoneField('713').e164, null);
});
