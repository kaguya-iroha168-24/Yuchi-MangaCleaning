import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const catalog = { fonts: [{ family: 'Segoe UI', weights: [400, 700] }, { family: 'Arial', weights: [400] }] };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function setup(fetch) {
  const sockets = [];
  class Socket { constructor() { sockets.push(this); } close() { this.onclose?.(); } }
  const context = vm.createContext({ fetch, setTimeout, clearTimeout, AbortController, WebSocket: Socket });
  const module = new vm.SourceTextModule(source, { context });
  const tauri = new vm.SyntheticModule(['invoke'], function () { this.setExport('invoke', () => { throw Error('Unexpected bootstrap'); }); }, { context });
  await module.link(() => tauri); await module.evaluate();
  const { Api } = module.namespace;
  return { api: new Api({ baseUrl: 'http://localhost', token: 'test-only' }), Api, sockets };
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('concurrent callers and successful remounts share one fetch without changing catalog', async () => {
  let calls = 0; const gate = deferred();
  const { api } = await setup(() => { calls++; return gate.promise; });
  const a = api.fontCatalog(), b = api.fontCatalog(); assert.equal(a, b); assert.equal(calls, 1);
  gate.resolve(response(catalog));
  const result = await a; assert.deepEqual(result, catalog);
  assert.equal(await api.fontCatalog(), result); assert.equal(calls, 1);
});

test('a failed request is not cached and concurrent retry is single-flight', async () => {
  let calls = 0;
  const { api } = await setup(async () => { if (++calls === 1) throw Error('Offline'); return response(catalog); });
  await assert.rejects(api.fontCatalog(), /Koneksi backend gagal/);
  await Promise.all([api.fontCatalog(), api.fontCatalog()]); assert.equal(calls, 2);
});

test('different API instances never share catalog or in-flight work', async () => {
  let calls = 0;
  const { api, Api } = await setup(async () => response({ fonts: [{ family: `Session ${++calls}`, weights: [400] }] }));
  const next = new Api({ baseUrl: 'http://localhost', token: 'another-test-session' });
  assert.notDeepEqual(await api.fontCatalog(), await next.fontCatalog()); assert.equal(calls, 2);
});

for (const failed of [false, true]) test(`invalidation discards a late ${failed ? 'failure' : 'success'} and joins new generation`, async () => {
  const gate = deferred(); let calls = 0;
  const { api } = await setup(() => ++calls === 1 ? gate.promise : Promise.resolve(response(catalog)));
  const old = api.fontCatalog(); api.invalidateFontCatalog(); const current = api.fontCatalog();
  if (failed) gate.reject(Error('Old connection')); else gate.resolve(response({ fonts: [] }));
  assert.deepEqual(await old, catalog); assert.equal(await current, await api.fontCatalog()); assert.equal(calls, 2);
});

test('source invalidation notifies mounted consumers; unsubscribed components stay detached', async () => {
  let calls = 0, notices = 0;
  const { api } = await setup(async () => { calls++; return response(catalog); });
  await api.fontCatalog();
  const unsubscribe = api.subscribeFontCatalog(() => { notices++; void api.fontCatalog(); });
  api.invalidateFontCatalog(); await api.fontCatalog(); assert.equal(calls, 2); assert.equal(notices, 1);
  unsubscribe(); api.invalidateFontCatalog(); assert.equal(notices, 1); assert.equal(calls, 2);
});

test('unexpected progress disconnect invalidates, intentional close does not', async () => {
  let calls = 0;
  const { api, sockets } = await setup(async () => { calls++; return response(catalog); });
  await api.fontCatalog(); const stop = api.progress(() => {});
  sockets[0].onclose(); await api.fontCatalog(); assert.equal(calls, 2);
  stop(); await api.fontCatalog(); assert.equal(calls, 2);
});

for (const status of [0, 401]) test(`other API ${status ? 'authentication' : 'network'} failure clears old catalog`, async () => {
  let fonts = 0;
  const { api } = await setup(async url => {
    if (url.endsWith('/v1/typography/fonts')) { fonts++; return response(catalog); }
    if (!status) throw Error('Disconnected');
    return new Response('{}', { status });
  });
  await api.fontCatalog(); await assert.rejects(api.get('/v1/state'));
  await api.fontCatalog(); assert.equal(fonts, 2);
});
