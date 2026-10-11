import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPreferences, preferenceCommand, serializeEol, validatePreferences } from './editor-preferences.ts';
import { fileHierarchy, normalizeLayout } from './editor-layout.ts';
test('preferences reject CSS injection, bounds and colliding shortcuts', () => {
  for (const patch of [{fontFamily:'monospace; color:red'}, {fontSize:41}, {tabSize:0}, {keys:{save:'Mod-c',selection:'Mod-Shift-l'}}, {keys:{save:'Mod-s',selection:'Mod-s'}}]) assert.throws(() => validatePreferences({...defaultPreferences,...patch}));
  assert.deepEqual(validatePreferences(defaultPreferences),defaultPreferences);
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
