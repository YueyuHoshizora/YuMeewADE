import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MutationGate } from './mutations.ts';

test('snapshot admission excludes in-flight and newly arriving mutations and releases after errors', async () => {
  const gate = new MutationGate();
  const held = Promise.withResolvers<void>();
  const active = gate.run(() => held.promise);
  await assert.rejects(gate.exclusive(() => false, async () => 'snapshot'), { detail: 'care_busy' });
  held.resolve(); await active;
  const snapshot = Promise.withResolvers<void>();
  const reserved = gate.exclusive(() => false, () => snapshot.promise);
  await assert.rejects(gate.run(async () => 'late mutation'), { detail: 'care_busy' });
  await assert.rejects(gate.exclusive(() => false, async () => 'overlap'), { detail: 'care_busy' });
  snapshot.resolve(); await reserved;
  await assert.rejects(gate.exclusive(() => true, async () => 'busy service'), { detail: 'care_busy' });
  await assert.rejects(gate.exclusive(() => false, async () => { throw new Error('snapshot failed'); }), /snapshot failed/u);
  assert.equal(await gate.run(async () => 'released'), 'released');
});
