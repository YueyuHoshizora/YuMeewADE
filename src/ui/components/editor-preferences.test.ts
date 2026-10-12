import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, preferenceCommand, serializeEol, validatePreferences } from './editor-preferences.ts';
import { fileHierarchy, normalizeLayout, pendingProposalRanges } from './editor-layout.ts';
test('preferences reject CSS injection, bounds and colliding shortcuts', () => {
  for (const patch of [{fontFamily:'monospace; color:red'}, {fontSize:41}, {tabSize:0}, {keys:{save:'Mod-c',selection:'Mod-Shift-l'}}, {keys:{save:'Mod-s',selection:'Mod-s'}}]) assert.throws(() => validatePreferences({...defaultPreferences,...patch}));
  assert.deepEqual(validatePreferences(defaultPreferences),defaultPreferences);
});
test('preferences saved before format-on-save keep every other choice and default it off', () => {
  const stored = { fontFamily: 'Menlo', fontSize: 16, tabSize: 4, insertSpaces: false, wrap: true, eol: 'lf', keys: { save: 'Mod-s', selection: 'Mod-Shift-l' } };
  assert.deepEqual(validatePreferences(stored), { ...stored, formatOnSave: false });
  assert.equal(validatePreferences({ ...stored, formatOnSave: true }).formatOnSave, true);
  assert.throws(() => validatePreferences({ ...stored, formatOnSave: 'yes' }));
  // Ctrl/⌘+P is the global go-to-file picker and cannot be rebound to an editor command.
  assert.throws(() => validatePreferences({ ...stored, keys: { save: 'Mod-p', selection: 'Mod-Shift-l' } }));
});
test('IME and plain typing never invoke editor commands', () => {
  const event = {isComposing:false,keyCode:83,key:'s',ctrlKey:true,metaKey:false,shiftKey:false,altKey:false};
  assert.equal(preferenceCommand(event,defaultPreferences),'save');
  assert.equal(preferenceCommand({...event,isComposing:true},defaultPreferences),undefined);
  assert.equal(preferenceCommand({...event,keyCode:229},defaultPreferences),undefined);
  assert.equal(preferenceCommand({...event,ctrlKey:false},defaultPreferences),undefined);
  assert.equal(preferenceCommand({...event,altKey:true},defaultPreferences),undefined);
});
test('EOL serialization preserves base and converts explicitly', () => {
  assert.equal(serializeEol('a\nb\n','preserve','a\r\nb\r\n'),'a\r\nb\r\n');
  assert.equal(serializeEol('a\r\nb','lf',''),'a\nb');
});
test('layout normalizes corrupt storage; hierarchy retains exact paths', () => {
  assert.deepEqual(normalizeLayout({width:Infinity,tree:-3,dock:'bogus'}),{width:50,tree:20,dock:'right'});
  assert.deepEqual([...fileHierarchy(['a.ts','src/b.ts','src/c.ts'])],[['',['a.ts']],['src',['src/b.ts','src/c.ts']]]);
});
test('accepted proposal replacement deltas shift only later pending ranges', () => {
  assert.deepEqual(pendingProposalRanges([{from:0,to:2,text:'longer',state:'accepted'},{from:5,to:7,text:'x',state:'pending'},{from:8,to:9,text:'',state:'rejected'},{from:10,to:11,text:'',state:'pending'}]), [{from:9,to:11},{from:14,to:15}]);
});
