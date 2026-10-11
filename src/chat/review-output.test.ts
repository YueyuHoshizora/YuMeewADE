import assert from 'node:assert/strict';
import test from 'node:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseReviewOutput, reviewFingerprint } from './review-output.ts';

test('successful prose and malformed structured review never grant approval', () => {
  for (const text of ['APPROVED', 'No findings. Approved.', '{"approved":true,"findings":[]}', '```json\n{"schema":1,"approved":true,"findings":[]}\n```']) {
    assert.equal(parseReviewOutput(text).approved, false);
    assert.equal(parseReviewOutput(text).structured, false);
  }
  assert.equal(parseReviewOutput('{"schema":1,"approved":false,"findings":[]}').approved, false);
  assert.equal(parseReviewOutput('{"schema":1,"approved":true,"findings":[]}').approved, true);
});
test('findings require evidence, safe location and severity; major findings veto approval', () => {
  const finding = { severity: 'major', path: 'src/a.ts', line: 2, message: 'Broken condition', evidence: 'line 2 accepts an invalid token' };
  const parse = (item: unknown) => parseReviewOutput(JSON.stringify({ schema: 1, approved: true, findings: [item] }));
  const result = parse(finding);
  assert.equal(result.structured, true); assert.equal(result.approved, false);
  assert.equal(result.findings[0]?.state, 'open'); assert.deepEqual(result.findings[0]?.transitions, []);
  for (const invalid of [{ ...finding, path: '../outside' }, { ...finding, evidence: '' }, { ...finding, line: 0 }, { ...finding, severity: 'urgent' }]) assert.equal(parse(invalid).structured, false);
});
test('content fingerprints detect same-size edits, new files and deletions without git', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-content-'));
  try {
    await fs.writeFile(path.join(dir, 'a.ts'), 'before'); const before = await reviewFingerprint(dir);
    await fs.writeFile(path.join(dir, 'a.ts'), 'after!'); const after = await reviewFingerprint(dir);
    assert.notEqual(before.content, after.content);
    await fs.writeFile(path.join(dir, 'b.ts'), 'new'); const added = await reviewFingerprint(dir);
    assert.notEqual(added.content, after.content);
    await fs.unlink(path.join(dir, 'b.ts')); assert.equal((await reviewFingerprint(dir)).content, after.content);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
