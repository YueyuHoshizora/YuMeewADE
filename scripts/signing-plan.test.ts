import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signingPlan } from './signing-plan.ts';

test('partial platform signing refuses silently unsigned artifacts without leaking secrets', () => {
  assert.deepEqual(signingPlan('darwin', {}), { signed: false, args: [] });
  assert.deepEqual(signingPlan('linux', { CSC_LINK: 'unrelated' }), { signed: false, args: [] });
  for (const platform of ['darwin', 'win32'] as const) {
    const key = platform === 'darwin' ? 'CSC_LINK' : 'WIN_CSC_LINK';
    assert.throws(() => signingPlan(platform, { [key]: 'private-secret-canary' }), error => error instanceof Error && !error.message.includes('private-secret-canary') && error.message.includes('Incomplete'));
  }
});
test('complete platform credentials require signed output and Apple notarization', () => {
  const mac = signingPlan('darwin', { CSC_LINK: 'fixture', CSC_KEY_PASSWORD: 'fixture', CSC_NAME: 'Developer ID Application: Fixture', APPLE_ID: 'fixture@example.invalid', APPLE_APP_SPECIFIC_PASSWORD: 'fixture', APPLE_TEAM_ID: 'FIXTURE' });
  assert.equal(mac.signed, true);
  assert(mac.args.includes('--config.mac.forceCodeSigning=true'));
  assert(mac.args.includes('--config.mac.notarize=true'));
  const win = signingPlan('win32', { WIN_CSC_LINK: 'fixture', WIN_CSC_KEY_PASSWORD: 'fixture' });
  assert.equal(win.signed, true);
  assert(win.args.includes('--config.win.forceCodeSigning=true'));
});
