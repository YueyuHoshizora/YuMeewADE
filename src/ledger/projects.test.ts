import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { test } from 'node:test';
import type { ProjectPatch } from '../shared/types.ts';
import { withTmpWorkspace } from '../testing/tmp.ts';
import { ProjectLedger } from './projects.ts';

test('verify command is trimmed, persisted, preserved and cleared', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  assert.equal((await projects.create({ name: 'P', verify: '  npm test  ' })).verify, 'npm test');
  assert.equal((await projects.update('P', { description: 'updated' })).verify, 'npm test');
  assert.equal((await projects.update('P', { verify: '  npm run typecheck  ' })).verify, 'npm run typecheck');
  assert.equal((await projects.update('P', { verify: '' })).verify, '');
  await fs.writeFile(ws.projectFile('P'), '---\nname: P\n---\n# Notes\n');
  assert.equal((await projects.get('P')).verify, '');
}));

test('verify command rejects invalid types, multiline, NUL and excess length', () => withTmpWorkspace(async ws => {
  const projects = new ProjectLedger(ws);
  await projects.create({ name: 'P' });
  for (const verify of [123, null, 'echo a\necho b', 'echo a\recho b', 'a\0b', 'x'.repeat(501)]) {
    await assert.rejects(projects.update('P', { verify } as ProjectPatch), { status: 400 });
    await assert.rejects(projects.create({ name: 'Invalid', verify } as unknown as Parameters<ProjectLedger['create']>[0]), { status: 400 });
  }
  assert.equal((await projects.update('P', { verify: 'x'.repeat(500) })).verify.length, 500);
}));
