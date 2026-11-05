import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';
const context = vm.createContext({ setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout });
const compile = async file => new vm.SourceTextModule(ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, { context });
const geometry = await compile('../src/ui/regionEditing.ts'); await geometry.link(() => { throw Error('Unexpected dependency'); }); await geometry.evaluate();
const module = await compile('../src/ui/typography.ts'); await module.link(() => geometry); await module.evaluate();
const { TypographySession, cardDialogue, fontSizePatch } = module.namespace;
const text = { id: 'text1', text: 'Initial', bubble_id: null, source_region_id: null, x: 10, y: 20, width: 120, height: 150, family: 'Segoe UI', size: 32, weight: 400, minimum_size: 12, color: '#000000', alignment: 'center', visible: true, auto_fit: true, padding: 8 };
const page = (item = text, pageId = 'page1') => ({ pageId, dialogues: [item] });
const layer = name => ({ png: name, warnings: [], width: 120, height: 150 });

test('typing stays transient, coalesces preview and persists once before Save', async () => {
  const calls = [], states = [], dirty = [];
  const api = { post: async (path, values) => { calls.push(path); return path.includes('preview') ? layer(values.dialogue.text) : { document: page({ id: text.id, ...values }) }; } };
  const session = new TypographySession();
  session.configure(api, page(), { state: state => states.push(state), dirty: value => dirty.push(value), error: () => {} });
  await delay(20); calls.length = 0;
  for (let index = 0; index < 100; index++) session.edit(text.id, { text: 'Draft '+index });
  assert.equal(states.length, 0); assert.deepEqual(dirty, [true]);
  await delay(180);
  assert.equal(calls.filter(path => path.includes('preview')).length, 1);
  await session.flush();
  assert.equal(calls.filter(path => path.includes('/dialogues/')).length, 1);
  assert.equal(states[0].document.dialogues[0].text, 'Draft 99');
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0);
  assert.deepEqual(dirty, [true, false]); session.dispose();
});

test('manual move reuses raster, resize requests a new bounded layer', async () => {
  const calls = [];
  const api = { post: async (path, values) => { calls.push(path); return path.includes('preview') ? layer('raster') : { document: page({ id: text.id, ...values }) }; } };
  const session = new TypographySession(); session.configure(api, page(), { state: () => {}, dirty: () => {}, error: () => {} });
  await delay(20); calls.length = 0;
  await session.pose(text.id, [20, 30, 120, 150]); await delay(20);
  assert.equal(calls.filter(path => path.includes('preview')).length, 0);
  await session.pose(text.id, [20, 30, 140, 180]); await delay(20);
  assert.equal(calls.filter(path => path.includes('preview')).length, 1); session.dispose();
});

test('failed commit keeps draft and reconnect reconciles a lost acknowledgement', async () => {
  let mutations = 0, failures = 0;
  const api = { post: async path => { if (path.includes('preview')) return layer('raster'); mutations++; throw Error('Acknowledgement lost'); } };
  const session = new TypographySession(); const callbacks = { state: () => {}, dirty: () => {}, error: () => failures++ };
  session.configure(api, page(), callbacks); session.edit(text.id, { text: 'Preserved' });
  await assert.rejects(session.flush(), /Acknowledgement lost/);
  assert.equal(session.getSnapshot().drafts[text.id].text, 'Preserved');
  session.configure(api, page({ ...text, text: 'Preserved' }), callbacks);
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0);
  assert.equal(mutations, 1); assert.equal(failures, 1); session.dispose();
});

test('late preview cannot attach old-page raster to a newly opened document', async () => {
  let finish;
  const api = { post: async (_path, payload) => payload.pageId === 'page1' ? await new Promise(resolve => { finish = resolve; }) : layer('new-page') };
  const session = new TypographySession(); const callbacks = { state: () => {}, dirty: () => {}, error: () => {} };
  session.configure(api, page(), callbacks);
  session.configure(api, page({ ...text, id: 'text2' }, 'page2'), callbacks);
  finish(layer('old-page')); await delay(30);
  assert.equal(session.getSnapshot().layers.text1, undefined);
  assert.equal(session.getSnapshot().layers.text2.png, 'new-page'); session.dispose();
});

test('flush includes edits arriving while the previous commit is in flight', async () => {
  let finish; const values = [];
  const api = { post: async (path, fields) => {
    if (path.includes('preview')) return layer('raster');
    values.push(fields.text);
    if (values.length === 1) await new Promise(resolve => { finish = resolve; });
    return { document: page({ id: text.id, ...fields }) };
  } };
  const session = new TypographySession(); session.configure(api, page(), { state: () => {}, dirty: () => {}, error: () => {} });
  session.edit(text.id, { text: 'First' }); const pending = session.flush();
  session.edit(text.id, { text: 'Latest' }); finish(); await pending;
  assert.deepEqual(values, ['First', 'Latest']);
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0); session.dispose();
});

test('card targets require explicit bubble binding and selection for multiple layers', () => {
  const a = { ...text, id: 'a', bubble_id: 'b' }, b = { ...a, id: 'b2' };
  assert.equal(cardDialogue([text], 'b', text.id), null);
  assert.equal(cardDialogue([a], 'b', null).id, 'a');
  assert.equal(cardDialogue([a,b], 'b', null), null);
  assert.equal(cardDialogue([a,b], 'b', text.id), null);
  assert.equal(cardDialogue([a,b], 'b', 'b2').id, 'b2');
  assert.equal(fontSizePatch(text, 999).size, 144);
  assert.equal(fontSizePatch(text, 1).size, 8);
  assert.equal(fontSizePatch(text, 9).minimum_size, 9);
});

test('rapid card clicks read latest draft and preserve unrelated typography through commit', async () => {
  const linked = { ...text, bubble_id: 'bubble', auto_fit: true };
  const states = [];
  const api = { post: async (path, values) => { if (path.includes('preview')) return layer('preview'); await delay(15); const state = { document: page({ id: text.id, ...values }) }; states.push(state); return state; } };
  const session = new TypographySession();
  session.configure(api, page(linked), { state: () => {}, dirty: () => {}, error: () => {} });
  await session.resizeFont(text.id, 'wrong-bubble', 1);
  assert.equal(states.length, 0);
  await Promise.all(Array.from({length:20}, () => session.resizeFont(text.id, 'bubble', 1)));
  const result = states.at(-1).document.dialogues[0];
  assert.equal(result.size, 52); assert.equal(result.text, text.text); assert.equal(result.color, text.color); assert.equal(result.auto_fit,true);
  session.edit(text.id, { visible:false }); await session.flush();
  const count=states.length; await session.resizeFont(text.id,'bubble',1); assert.equal(states.length,count);
  session.configure(api, {pageId:'new-page',dialogues:[]}, {state:()=>{},dirty:()=>{},error:()=>{}});
  await session.resizeFont(text.id,'bubble',1); assert.equal(states.length,count);
  session.dispose();
});
