import assert from 'node:assert/strict';
import test from 'node:test';
import { filterTree } from './tree-filter.ts';

test('matching descendants keep all ancestors visible without revealing unrelated siblings', () => {
  const project = { hidden: false };
  const parent = { hidden: false };
  const child = { hidden: false };
  const sibling = { hidden: false };
  const entries = [
    { node: project, parent: null, text: 'project', completed: false },
    { node: parent, parent: project, text: 'parent', completed: false },
    { node: child, parent, text: 'needle', completed: true },
    { node: sibling, parent: project, text: 'unrelated', completed: false },
  ];
  filterTree(entries, 'needle');
  assert.deepEqual(entries.map(entry => entry.node.hidden), [false, false, false, true]);
  filterTree(entries, 'missing');
  assert.deepEqual(entries.map(entry => entry.node.hidden), [true, true, true, true]);
  filterTree(entries, '');
  assert.deepEqual(entries.map(entry => entry.node.hidden), [false, false, true, false]);
});

test('completed parent does not hide an unfinished descendant and filtering is reusable', () => {
  const parent = { hidden: false };
  const child = { hidden: false };
  const entries = [
    { node: parent, parent: null, text: 'done', completed: true },
    { node: child, parent, text: 'active', completed: false },
  ];
  filterTree(entries, '');
  assert.deepEqual(entries.map(entry => entry.node.hidden), [false, false]);
  filterTree(entries, 'done');
  assert.deepEqual(entries.map(entry => entry.node.hidden), [false, true]);
  filterTree([], 'anything');
});
