import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
async function setup() {
  const sockets = [], timers = [], updates = [];
  class Socket { constructor() { sockets.push(this); } close() { this.onclose?.(); } }
  const context = vm.createContext({ WebSocket: Socket, setTimeout: callback => { timers.push(callback); return timers.length; }, clearTimeout: () => {} });
  const module = new vm.SourceTextModule(source, { context });
  const tauri = new vm.SyntheticModule(['invoke'], function () { this.setExport('invoke', () => { throw Error('Unexpected bootstrap'); }); }, { context });
  await module.link(() => tauri); await module.evaluate();
  const { Api } = module.namespace;
  const api = new Api({ baseUrl: 'http://localhost', token: 'test-only' });
  const stop = api.progress(value => updates.push(value));
  const emit = value => sockets.at(-1).onmessage({ data: typeof value === 'string' ? value : JSON.stringify(value) });
  return { api, Api, sockets, timers, updates, stop, emit };
}
const job = patch => ({ id: 'scan-1', type: 'detect', status: 'running', progress: .1, cancelRequested: false, ...patch });

test('duplicate null frames cause only one callback/state-sink update', async () => {
  const h = await setup(); for (let i = 0; i < 1000; i++) h.emit(null);
  assert.deepEqual(h.updates, [null]); h.stop();
});

test('duplicate non-null frames are suppressed without dropping progress changes', async () => {
  const h = await setup(); const a = job();
  h.emit(a); h.emit(a); h.emit(job({ progress: .2 })); h.emit(job({ progress: .2 }));
  assert.equal(h.updates.length, 2); assert.equal(h.updates[1].progress, .2); h.stop();
});

test('null to progress to completion to null and a new job all reach the sink', async () => {
  const h = await setup();
  for (const value of [null, job(), job({ status: 'done', progress: 1, result: { count: 12 } }), null, null, job({ id: 'scan-2' })]) h.emit(value);
  assert.equal(h.updates.length, 5); assert.equal(h.updates[2].status, 'done');
  assert.equal(h.updates[3], null); assert.equal(h.updates[4].id, 'scan-2'); h.stop();
});

test('status, errors, cancellation, messages and results are never compared by progress alone', async () => {
  const h = await setup();
  const values = [job(), job({ cancelRequested: true }), job({ status: 'cancelled' }), job({ status: 'failed', error: 'Timeout' }), job({ status: 'failed', error: 'Worker exited' }), job({ message: 'Verifying secondary' }), job({ status: 'done', result: { count: 11 } }), job({ status: 'done', result: { count: 12 } })];
  for (const value of values) { h.emit(value); h.emit(value); }
  assert.equal(h.updates.length, values.length);
  assert.deepEqual(h.updates.map(v => JSON.stringify(v)), values.map(v => JSON.stringify(v))); h.stop();
});

test('reconnect resets dedup and keeps font invalidation; first identical job is delivered again', async () => {
  const h = await setup(); let invalidations = 0;
  h.api.subscribeFontCatalog(() => invalidations++);
  h.emit(job({ status: 'done' })); h.sockets[0].onclose();
  assert.equal(invalidations, 1); assert.equal(h.timers.length, 1);
  h.timers[0](); h.emit(job({ status: 'done' })); h.emit(job({ status: 'done' }));
  assert.equal(h.sockets.length, 2); assert.equal(h.updates.length, 2);
  h.stop(); assert.equal(invalidations, 1);
});

test('duplicate heartbeat still resets retry attempts before reconnect', async () => {
  const h = await setup();
  for (let i = 0; i < 5; i++) { h.emit(null); h.emit(null); h.sockets.at(-1).onclose(); h.timers.at(-1)(); }
  assert.equal(h.sockets.length, 6); assert.equal(h.updates.length, 5); h.stop();
});

test('separate subscriptions and API sessions never reuse another connection cache', async () => {
  const h = await setup(), a = [], b = [];
  h.emit(null);
  const stopA = h.api.progress(value => a.push(value)); h.emit(null); h.emit(null);
  const next = new h.Api({ baseUrl: 'http://localhost', token: 'new-test-session' });
  const stopB = next.progress(value => b.push(value)); h.emit(null); h.emit(null);
  assert.deepEqual(h.updates, [null]); assert.deepEqual(a, [null]); assert.deepEqual(b, [null]);
  h.stop(); stopA(); stopB();
});

test('synchronous consumer failure does not mark an undelivered message as cached', async () => {
  const h = await setup(); let attempts = 0;
  const stop = h.api.progress(() => { if (++attempts === 1) throw Error('Consumer failure'); });
  assert.throws(() => h.emit(null), /Consumer failure/); h.emit(null); h.emit(null);
  assert.equal(attempts, 2); stop(); h.stop();
});

test('dedup is conservative: differently encoded JSON is delivered rather than normalized', async () => {
  const h = await setup(); h.emit('{"id":"a","progress":0}'); h.emit('{"progress":0,"id":"a"}');
  assert.equal(h.updates.length, 2); h.stop();
});
