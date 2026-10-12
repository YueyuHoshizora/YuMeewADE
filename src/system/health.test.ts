import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeVersion } from './health.ts';

test('diagnostics keep a SemVer CLI version with prerelease and build, and blank anything else', () => {
  for (const version of ['1.2.3', '1.2.3-rc.2', '1.2.3+build.7', '1.2.3-rc.2+build.7', '0.162.1']) assert.equal(safeVersion(version), version);
  for (const value of ['', 'v1.2.3', '1.2', '1.2.3 extra', '1.2.3+a+b', '1.2.3-rc/../x']) assert.equal(safeVersion(value), '', value);
});
