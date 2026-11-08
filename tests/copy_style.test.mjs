import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import ts from 'typescript';

const context = vm.createContext({ setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(() => callback(0), 0), cancelAnimationFrame: clearTimeout });
const compile = async file => new vm.SourceTextModule(ts.transpileModule(await readFile(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText, { context });
const geometry = await compile('../src/ui/regionEditing.ts'); await geometry.link(() => { throw Error('Unexpected dependency'); }); await geometry.evaluate();
const typography = await compile('../src/ui/typography.ts'); await typography.link(() => geometry); await typography.evaluate();
const { TypographySession } = typography.namespace;
const text = { id: 'source', text: 'Source content', bubble_id: 'bubble-source', source_region_id: 'ocr-source', x: 10, y: 20, width: 120, height: 150, family: 'Segoe UI', size: 32, weight: 400, minimum_size: 12, color: '#000000', alignment: 'center', visible: true, auto_fit: true, padding: 8 };
const styleFields = ['family', 'weight', 'size', 'minimum_size', 'alignment', 'color', 'auto_fit', 'padding'];
const style = item => Object.fromEntries(styleFields.map(field => [field, item[field]]));
const plain = value => JSON.parse(JSON.stringify(value));
const page = (items = [text], pageId = 'page-source') => ({ pageId, dialogues: items });
const layer = { png: 'preview', width: 120, height: 150, warnings: [] };
const callbacks = { state() {}, dirty() {}, error() {} };

test('copy captures latest draft style only without committing or rendering', async () => {
  const calls = [], session = new TypographySession();
  session.configure({ post: async path => { calls.push(path); return layer; } }, page(), callbacks);
  await delay(10); calls.length = 0;
  session.edit(text.id, { family: 'Arial', size: 46, weight: 700, minimum_size: 18, alignment: 'right', color: '#123456', auto_fit: false, padding: 21, text: 'Unsaved source content', x: 99 });
  const draft = session.getSnapshot().drafts[text.id];
  session.copyStyle(text.id);
  assert.deepEqual(plain(session.getSnapshot().copiedStyle), style(draft));
  assert.deepEqual(Object.keys(session.getSnapshot().copiedStyle).sort(), [...styleFields].sort());
  assert.equal(session.getSnapshot().drafts[text.id], draft);
  assert.equal(calls.length, 0);
  session.edit(text.id, { color: '#abcdef' });
  assert.equal(session.getSnapshot().copiedStyle.color, '#123456');
  session.dispose();
});

test('clipboard survives page load and paste commits only style to explicit target with latest content and geometry', async () => {
  const session = new TypographySession(), commits = [], states = [];
  let current = page();
  const api = { post: async (path, fields) => {
    if (path.includes('preview')) return layer;
    commits.push({ path, fields: plain(fields) });
    const id = decodeURIComponent(path.split('/').at(-1));
    current = { ...current, dialogues: current.dialogues.map(item => item.id === id ? { id, ...fields } : item) };
    return { document: current };
  } };
  session.configure(api, current, { ...callbacks, state: state => states.push(state) });
  session.edit(text.id, { size: 55, minimum_size: 25, color: '#445566' });
  session.copyStyle(text.id);
  const copied = plain(session.getSnapshot().copiedStyle);
  session.select(text.id);
  const target = { ...text, id: 'different-target', text: 'Keep target content', bubble_id: 'target-bubble', source_region_id: 'target-ocr', x: 240, y: 350, width: 300, height: 450, visible: false };
  const other = { ...target, id: 'other' };
  current = page([target, other], 'page-target');
  session.configure(api, current, callbacks);
  session.configure(api, null, callbacks);
  session.configure(api, current, { ...callbacks, state: state => states.push(state) });
  assert.deepEqual(plain(session.getSnapshot().copiedStyle), copied);
  session.edit(target.id, { text: 'Latest target draft', x: 260 });
  const before = plain(session.getSnapshot().drafts[target.id]);
  await session.pasteStyle(target.id);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].path, '/v1/dialogues/different-target');
  const saved = plain(states[0].document.dialogues.find(item => item.id === target.id));
  assert.deepEqual(style(saved), copied);
  for (const field of Object.keys(before).filter(field => !styleFields.includes(field))) assert.deepEqual(saved[field], before[field], field);
  assert.deepEqual(plain(states[0].document.dialogues.find(item => item.id === other.id)), other);
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0);
  session.dispose();
});

test('paste without clipboard or a current target is a no-op; unknown copy preserves clipboard', async () => {
  let commits = 0;
  const session = new TypographySession();
  session.configure({ post: async path => { if (!path.includes('preview')) commits++; return layer; } }, page(), callbacks);
  await session.pasteStyle(text.id);
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0);
  session.copyStyle(text.id);
  const copied = session.getSnapshot().copiedStyle;
  session.copyStyle('absent');
  assert.equal(session.getSnapshot().copiedStyle, copied);
  await session.pasteStyle('absent');
  assert.equal(commits, 0);
  session.dispose();
});

test('failed paste uses existing commit error and keeps styled target draft for retry', async () => {
  const session = new TypographySession(), errors = [];
  session.configure({ post: async path => { if (path.includes('preview')) return layer; throw Error('Commit unavailable'); } }, page(), { ...callbacks, error: error => errors.push(error) });
  session.copyStyle(text.id);
  session.edit(text.id, { color: '#ffffff' });
  await assert.rejects(session.pasteStyle(text.id), /Commit unavailable/);
  assert.equal(errors.length, 1);
  assert.equal(session.getSnapshot().drafts[text.id].color, text.color);
  session.dispose();
});

async function inspector(session, api) {
  let hooks = [], cursor = 0, currentSnapshot;
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function () { for (const [key, value] of Object.entries(exports)) this.setExport(key, value); }, { context });
  const jsx = (type, props) => ({ type, props });
  const react = synthetic({
    useState: initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], value => { hooks[index] = value; }]; },
    useEffect: (effect, deps) => { const index = cursor++, previous = hooks[index]; if (!previous || deps.some((value, item) => value !== previous[item])) { hooks[index] = deps; effect(); } },
    useMemo: factory => factory(), useRef: () => ({ current: null }), useSyncExternalStore: (_subscribe, getSnapshot) => { currentSnapshot = getSnapshot; return getSnapshot(); },
  });
  const runtime = synthetic({ jsx, jsxs: jsx, Fragment: 'fragment' }), font = synthetic({ FontBrowser: () => null }), overlay = synthetic({ TextRegionOverlay: () => null });
  const component = await compile('../src/components/Typography.tsx');
  await component.link(async name => name === 'react' ? react : name === 'react/jsx-runtime' ? runtime : name === 'lucide-react' ? synthetic(await import(name)) : name.includes('ui/typography') ? typography : name.includes('FontBrowser') ? font : overlay);
  await component.evaluate();
  const render = (selected = text, disabled = false) => { cursor = 0; return component.namespace.TypographyControls({ api, session, selected, disabled, onDelete() {}, sourceControls: null }); };
  render.cardSnapshot = () => {
    component.namespace.TypographyCardControls({ session, dialogues: [text], bubbleId: text.bubble_id, selected: text.id, disabled: false, onTarget() {} });
    return currentSnapshot;
  };
  return render;
}
function nodes(node) { if (Array.isArray(node)) return node.flatMap(nodes); if (!node || typeof node !== 'object') return []; return [node, ...nodes(node.props?.children)]; }
const button = (tree, label) => nodes(tree).find(node => node.type === 'button' && node.props.children === label);

test('inspector font step buttons preserve rapid changes without relying on a rerender',async()=>{
  const committed=[];const session=new TypographySession();
  const api={fontCatalog:async()=>({fonts:[]}),subscribeFontCatalog:()=>()=>{},post:async(path,fields)=>{if(path.includes('preview'))return layer;committed.push(fields);return {document:page([{id:text.id,...fields}])};}};
  session.configure(api,page(),callbacks);const render=await inspector(session,api);const tree=render();
  assert.ok(button(tree,'+'),'Inspector font increase control is missing');
  for(let i=0;i<10;i++)button(tree,'+').props.onClick();
  await session.flush();assert.equal(committed.at(-1).size,text.size+10);
  assert.equal(committed.at(-1).text,text.text);session.dispose();
});

test('inspector copy/paste buttons track clipboard, honor disabled state and reuse font catalog subscription', async () => {
  let fontRequests = 0, subscriptions = 0, commits = 0;
  const session = new TypographySession();
  const api = {
    fontCatalog: async () => { fontRequests++; return { fonts: [] }; },
    subscribeFontCatalog: () => { subscriptions++; return () => {}; },
    post: async (path, fields) => { if (path.includes('preview')) return layer; commits++; return { document: page([{ id: text.id, ...fields }]) }; },
  };
  session.configure(api, page(), callbacks);
  const render = await inspector(session, api);
  let tree = render();
  assert.ok(button(tree, 'Copy Style'));
  assert.equal(button(tree, 'Paste Style').props.disabled, true);
  session.edit(text.id, { size: 41 });
  button(tree, 'Copy Style').props.onClick();
  tree = render();
  assert.equal(button(tree, 'Paste Style').props.disabled, false);
  session.edit(text.id, { size: 20 });
  button(tree, 'Paste Style').props.onClick();
  await delay(10);
  assert.equal(commits, 1);
  assert.equal(Object.keys(session.getSnapshot().drafts).length, 0);
  tree = render(text, true);
  assert.equal(button(tree, 'Copy Style').props.disabled, true);
  assert.equal(button(tree, 'Paste Style').props.disabled, true);
  assert.equal(button(render(null), 'Paste Style'), undefined);
  assert.equal(fontRequests, 1);
  assert.equal(subscriptions, 1);
  session.dispose();
});

test('copy leaves raster references and selective card snapshot unchanged', async () => {
  const session = new TypographySession();
  session.configure({ post: async () => layer }, page(), callbacks);
  await delay(10);
  const render = await inspector(session, null), getCardSnapshot = render.cardSnapshot();
  const before = session.getSnapshot(), cardBefore = getCardSnapshot();
  session.copyStyle(text.id);
  assert.notEqual(session.getSnapshot(), before);
  for (const field of ['drafts', 'layers', 'errors', 'loading']) assert.equal(session.getSnapshot()[field], before[field], field);
  assert.equal(getCardSnapshot(), cardBefore);
  session.dispose();
});
