import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

async function load() {
  const source = await readFile(new URL('../src/ui/pageFrames.ts', import.meta.url), 'utf8');
  const module = new vm.SourceTextModule(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
  await module.link(() => { throw Error('Unexpected runtime dependency'); });
  await module.evaluate();
  return module.namespace;
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('1 → 2 → 1 reuses only the last decoded page at the matching revision', async () => {
  const { PageFrames } = await load();
  const fetched = [], released = [], shown = [];
  const frames = new PageFrames(async src => ({ src, naturalWidth: 1114, naturalHeight: 1600 }), url => released.push(url));
  const openFrame = (id, revision, suffix) => frames.load({ image: async kind => { const url = `${suffix}-${kind}`; fetched.push(url); return url; } }, id, frame => shown.push(frame), `${id}:${revision}`, true);
  await openFrame('1', 0, 'initial');
  await openFrame('2', 0, 'second');
  assert.equal(frames.peek('1', '1:0'), shown[0]);
  assert.equal(frames.peek('1', '1:1'), null);
  assert.equal(frames.peek('2', '2:0'), null);
  await openFrame('1', 0, 'should-not-fetch');
  assert.equal(shown[2], shown[0]);
  assert.equal(fetched.length, 4);
  await openFrame('2', 1, 'edited');
  assert.equal(shown.at(-1).workingUrl, 'edited-working');
  assert.equal(fetched.length, 6);
  assert.deepEqual(released.sort(), ['second-original', 'second-working']);
  frames.clearCache();
  assert.equal(frames.peek('1', '1:0'), null);
  await openFrame('1', 0, 'reopened');
  assert.equal(shown.at(-1).originalUrl, 'reopened-original');
  frames.dispose();
  assert.equal(released.length, 8);
});

test('refreshing artwork keeps the decoded Original and discards stale adjustments', async () => {
  const { PageFrames } = await load();
  const released = [], displayed = [], requests = [], slow = deferred();
  const frames = new PageFrames(async url => ({ src: url }), url => released.push(url));
  const publish = frame => displayed.push(frame);
  await frames.load({ image: async kind => `a-${kind}` }, 'a', publish);
  const original = displayed[0].original;
  await frames.loadWorking({ image: async kind => { requests.push(kind); return 'adjusted'; } }, 'a', publish);
  assert.deepEqual(requests, ['working']);
  assert.equal(displayed[1].original, original);
  assert.deepEqual(released, ['a-working']);
  const pending = frames.loadWorking({ image: () => slow.promise }, 'a', publish);
  await frames.load({ image: async kind => `b-${kind}` }, 'b', publish);
  slow.resolve('late-adjustment');
  assert.equal(await pending, false);
  assert.equal(displayed.at(-1).pageId, 'b');
  assert.deepEqual(released, ['a-working', 'a-original', 'adjusted', 'late-adjustment']);
});

test('keeps old frame until both new images are decoded, publishing them together', async () => {
  const { PageFrames } = await load();
  const released = [], decoded = new Map(), displayed = [];
  const frames = new PageFrames(url => { const value = deferred(); decoded.set(url, value); return value.promise; }, url => released.push(url));
  const api = { image: async kind => 'a-' + kind };
  const first = frames.load(api, 'a', frame => displayed.push(frame));
  await new Promise(setImmediate);
  decoded.get('a-original').resolve({ src: 'a-original' });
  await new Promise(setImmediate);
  assert.equal(displayed.length, 0);
  decoded.get('a-working').resolve({ src: 'a-working' });
  await first;
  const second = frames.load({ image: async kind => 'b-' + kind }, 'b', frame => displayed.push(frame));
  await new Promise(setImmediate);
  assert.equal(displayed.at(-1).pageId, 'a');
  assert.deepEqual(released, []);
  decoded.get('b-original').resolve({ src: 'b-original' });
  decoded.get('b-working').resolve({ src: 'b-working' });
  await second;
  assert.equal(displayed.at(-1).pageId, 'b');
  assert.deepEqual(released.sort(), ['a-original', 'a-working']);
  frames.dispose();
  assert.equal(released.length, 4);
});

test('an invalidated slow load cannot replace a newer frame and releases its URLs', async () => {
  const { PageFrames } = await load();
  const slow = deferred(), released = [], displayed = [];
  const frames = new PageFrames(async url => url.startsWith('slow') ? slow.promise : { src: url }, url => released.push(url));
  const old = frames.load({ image: async kind => 'slow-' + kind }, 'old', x => displayed.push(x));
  await new Promise(setImmediate);
  frames.invalidate();
  await frames.load({ image: async kind => 'new-' + kind }, 'new', x => displayed.push(x));
  slow.resolve({ src: 'slow' });
  assert.equal(await old, false);
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0].pageId, 'new');
  assert.deepEqual(released.sort(), ['slow-original', 'slow-working']);
  frames.dispose();
});

test('failed image fetch releases the successful sibling and preserves displayed frame', async () => {
  const { PageFrames } = await load();
  const released = [], displayed = [];
  const frames = new PageFrames(async url => ({ src: url }), url => released.push(url));
  await frames.load({ image: async kind => 'old-' + kind }, 'old', x => displayed.push(x));
  await assert.rejects(frames.load({ image: async kind => { if (kind === 'working') throw Error('network'); return 'partial'; } }, 'bad', x => displayed.push(x)));
  assert.equal(displayed.at(-1).pageId, 'old');
  assert.deepEqual(released, ['partial']);
  frames.dispose();
});

test('decode failure and dispose during pending load release every owned URL', async () => {
  const { PageFrames } = await load();
  const released = [], slow = deferred();
  const frames = new PageFrames(async () => slow.promise, url => released.push(url));
  const pending = frames.load({ image: async kind => kind }, 'a', () => assert.fail('disposed load published'));
  await new Promise(setImmediate);
  frames.dispose();
  slow.resolve({});
  assert.equal(await pending, false);
  assert.deepEqual(released.sort(), ['original', 'working']);
  const bad = new PageFrames(async () => { throw Error('decode'); }, url => released.push(url));
  await assert.rejects(bad.load({ image: async kind => 'bad-' + kind }, 'bad', () => assert.fail('decode error published')));
  assert.equal(released.length, 4);
});

test('failure of an obsolete load cannot cancel the latest navigation', async () => {
  const { PageFrames } = await load();
  const slow=deferred(), released=[];
  const frames=new PageFrames(async url=>({src:url}),url=>released.push(url));
  const old=frames.load({image: kind=>kind==='working'?slow.promise:Promise.resolve('partial-old')},'old',()=>assert.fail('obsolete frame'));
  await frames.load({image:async kind=>'current-'+kind},'current',()=>{});
  slow.reject(Error('obsolete request failed'));
  assert.equal(await old,false);
  assert.deepEqual(released,['partial-old']);
  frames.dispose();
});

test('1 → 2 → 3 → 2 → 1 reuses both recent frames without additional image requests', async () => {
  const { PageFrames } = await load();
  const fetched = [], shown = [];
  const frames = new PageFrames(async src => ({ src, naturalWidth: 1114, naturalHeight: 1600 }), () => {});
  for (const id of ['1', '2', '3', '2', '1']) {
    const client = { image: async kind => { fetched.push(id); return id + kind; } };
    await frames.load(client, id, frame => shown.push(frame), id + ':0', true);
  }
  assert.deepEqual(fetched, ['1', '1', '2', '2', '3', '3']);
  assert.equal(shown[3], shown[1]);
  assert.equal(shown[4], shown[0]);
});

test('1 → 2 → 3 → 1 previews the correct text boxes immediately after a text-only scan', async () => {
  const { PageFrames } = await load();
  const frames = new PageFrames(async src => ({ src, naturalWidth: 1114, naturalHeight: 1600 }), () => {});
  const open = (id, revision) => frames.load({ image: async kind => id + kind }, id, () => {}, `chapter:${revision}`, true);
  const firstBoxes = [{ id: 'T1', rect: [10, 20, 30, 40] }];
  await open('1', 0);
  frames.rememberTextRegions('1', 'chapter:1', firstBoxes, 'chapter:0');
  for (const id of ['2', '3']) {
    await open(id, 1);
    frames.rememberTextRegions(id, 'chapter:1', [{ id: `T${id}` }]);
  }
  assert.equal(frames.peek('1', 'chapter:1').textRegions, firstBoxes);
  assert.equal(frames.peek('2', 'chapter:1').textRegions[0].id, 'T2');
  assert.equal(frames.peek('1', 'chapter:2'), null);
  frames.rememberTextRegions('3', 'chapter:3', [], 'chapter:2');
  await open('1', 1);
  assert.equal(frames.peek('3', 'chapter:3'), null);
});

test('the total decoded cache stays within the same pixel budget', async () => {
  const { PageFrames } = await load();
  const released = [];
  const frames = new PageFrames(async src => ({ src, naturalWidth: 1500, naturalHeight: 1600 }), url => released.push(url));
  for (const id of ['1', '2', '3']) {
    await frames.load({ image: async kind => id + kind }, id, () => {}, id + ':0', true);
  }
  assert.equal(frames.peek('1', '1:0'), null);
  assert.equal(frames.peek('2', '2:0').pageId, '2');
  assert.deepEqual(released, ['1original', '1working']);
});
