import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { patchSprintfSource } from './patch-sprintf.ts';

const filename = createRequire(import.meta.url).resolve('sprintf-js');
const source = await readFile(filename, 'utf8');

test('pinned sprintf precision patch is exact-source gated and idempotent', () => {
  const patched = patchSprintfSource(source);
  assert.equal(patchSprintfSource(patched), patched);
  assert.throws(() => patchSprintfSource(source + '\n'), /source changed/);
  assert.throws(() => patchSprintfSource(source.replace('toFixed', 'toPrecision')), /source changed/);
});

test('invalid precision is rejected before evaluating arguments or invoking numeric formatting', () => {
  const sandbox = vm.createContext({ exports: {}, observed: { argumentCalls: 0, numberCalls: 0 } });
  vm.runInContext(patchSprintfSource(source), sandbox, { timeout: 1000 });
  vm.runInContext("Number.prototype.toFixed = Number.prototype.toExponential = Number.prototype.toPrecision = function () { observed.numberCalls++; throw new Error('native formatter reached'); }", sandbox, { timeout: 1000 });
  for (const format of ['%.101f', '%.101e', '%.101g', '%.0g', '%.999999999999999999999999999999999999999999999999999999999999999999999f']) {
    sandbox['format'] = format;
    const result: unknown = vm.runInContext("(() => { try { exports.sprintf(format, () => { observed.argumentCalls++; return 1; }); return 'not rejected'; } catch (error) { return error.name + ':' + error.message; } })()", sandbox, { timeout: 1000 });
    assert.equal(result, 'SyntaxError:[sprintf] numeric precision outside supported range');
  }
  const observations: unknown = vm.runInContext('JSON.stringify(observed)', sandbox, { timeout: 1000 });
  assert.equal(observations, '{"argumentCalls":0,"numberCalls":0}');
});

test('valid numeric boundaries and existing text formatting retain behavior', () => {
  const sandbox = vm.createContext({ exports: {} });
  vm.runInContext(patchSprintfSource(source), sandbox, { timeout: 1000 });
  const formatted: unknown = vm.runInContext("JSON.stringify([exports.sprintf('%.0f', 1.25), exports.sprintf('%.2f', 1.25), exports.sprintf('%.1g', 1.25), exports.sprintf('%.100f', 1).length, exports.sprintf('%s %d', 'value', 7), exports.vsprintf('%.2f', [1.25])])", sandbox, { timeout: 1000 });
  assert.equal(formatted, '["1","1.25","1",102,"value 7","1.25"]');
});
