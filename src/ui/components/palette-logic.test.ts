import test from 'node:test';
import assert from 'node:assert/strict';
import { fileQuery, rank, routeScope } from './palette-logic.ts';
test('fuzzy ranking prioritizes exact and prefix matches, preserves ties and ignores case', () => {
  const items = ['Some settings', 'Settings advanced', 'Settings', 'Save every task', 'Other'].map(label => ({ label }));
  assert.deepEqual(rank(items, 'SET').map(x => x.label), ['Settings advanced', 'Settings', 'Some settings', 'Save every task']);
  assert.equal(rank(items, 'settings')[0]?.label, 'Settings');
  assert.deepEqual(rank(items, 'xyz'), []);
  assert.deepEqual(rank(items, '  '), items);
  assert.deepEqual(rank([{ label: '甲乙丙' }, { label: '甲丙' }], '甲丙').map(x => x.label), ['甲丙', '甲乙丙']);
});
test('scope only accepts project/task routes and safely decodes ids', () => {
  assert.deepEqual(routeScope('#/p/a%20b?tab=x'), { project: 'a b', task: '' });
  assert.deepEqual(routeScope('#/t/p/t'), { project: 'p', task: 't' });
  for (const route of ['#/settings', '#/t/p', '#/p/%ZZ']) assert.equal(routeScope(route), undefined);
});
test('file query separates one-based positive safe line numbers from paths', () => {
  assert.deepEqual(fileQuery(' src/main.ts:42 '), { path: 'src/main.ts', line: 42 });
  assert.deepEqual(fileQuery('a:b:1'), { path: 'a:b', line: 1 });
  for (const path of ['file', 'file:0', 'file:-1', 'file:999999999999999999']) assert.deepEqual(fileQuery(path), { path });
});
