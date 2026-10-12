import { test } from 'node:test';
import assert from 'node:assert/strict';
import { providerCapabilities } from './capabilities.ts';
import { CodexCliProvider } from './codex.ts';
import { MockCliProvider } from './mock.ts';
import { DEFAULT_CONFIG } from '../shared/config.ts';
test('capabilities distinguish app-server/exec and refuse fixture provider aliases', () => {
  const app = providerCapabilities({ codex: new CodexCliProvider(DEFAULT_CONFIG.cli.codex, []) })[0]!;
  assert.equal(app.transport, 'app-server'); assert.equal(app.approvals, true); assert.equal(app.slash, 'native-and-prompts');
  const exec = providerCapabilities({ codex: new CodexCliProvider({ ...DEFAULT_CONFIG.cli.codex, mode: 'exec' }, []) })[0]!;
  assert.equal(exec.transport, 'exec'); assert.equal(exec.approvals, false); assert.equal(exec.readonly, app.readonly);
  const fixture = providerCapabilities({ codex: new MockCliProvider() })[0]!;
  assert.equal(fixture.transport, 'fixture'); assert.equal(fixture.readonly, false); assert.equal(fixture.resume, false); assert.equal(fixture.usage, false);
});
