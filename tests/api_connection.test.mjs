import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/api.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

async function client(fetch, invoke = async () => ({ baseUrl: 'http://127.0.0.1:49173', token: 'test-session-only' })) {
  const context = vm.createContext({ window: { __TAURI_INTERNALS__: {} }, fetch, Response, AbortController, FormData, URL, document: {}, setTimeout, clearTimeout });
  const module = new vm.SourceTextModule(source, { context, initializeImportMeta(meta) { meta.env = {}; } });
  const bridge = new vm.SyntheticModule(['invoke'], function () { this.setExport('invoke', invoke); }, { context });
  await module.link(() => bridge);
  await module.evaluate();
  return module.namespace;
}

const state = () => Response.json({ schema: 1, document: null, job: null });

test('native startup uses the returned dynamic session and Bearer, not Vite values', async () => {
  const calls = [];
  const api = await client(async (url, options) => { calls.push({ url, options }); return state(); });
  await api.connect();
  assert.equal(calls[0].url, 'http://127.0.0.1:49173/v1/state');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-session-only');
});

test('concurrent startup shares one bootstrap', async () => {
  let count = 0;
  const api = await client(async () => state(), async () => { count++; return { baseUrl: 'http://127.0.0.1:49174', token: 'test-session-only' }; });
  const first = api.connect();
  assert.equal(first, api.connect());
  await first;
  assert.equal(count, 1);
});

test('startup recovers after two transport failures', async () => {
  let count = 0;
  const api = await client(async () => { if (++count < 3) throw new TypeError('Failed to fetch'); return state(); });
  await api.connect();
  assert.equal(count, 3);
});

test('401 stays distinct from transport/CORS failure and is not retried blindly', async () => {
  let count = 0;
  const api = await client(async () => { count++; return Response.json({ detail: 'Unauthorized' }, { status: 401 }); });
  await assert.rejects(api.connect(), error => error instanceof api.ApiError && error.status === 401 && !error.message.includes('test-session-only'));
  assert.equal(count, 1);
});

test('failed startup is bounded, then a later Open can connect', async () => {
  let offline = true;
  let count = 0;
  const api = await client(async () => { count++; if (offline) throw new TypeError('Failed to fetch'); return state(); });
  await assert.rejects(api.connect(), error => error instanceof api.ApiError && error.status === undefined);
  assert.equal(count, 3);
  offline = false;
  const connected = await api.connect();
  const form = new FormData();
  form.append('file', new Blob(['fixture']), 'fixture.png');
  await connected.request('/v1/open', 'POST', form);
  assert.equal(count, 5);
});

test('mutating request is never replayed after an ambiguous transport failure', async () => {
  let count = 0;
  const api = await client(async () => { count++; throw new TypeError('Failed to fetch'); });
  const connected = new api.Api({ baseUrl: 'http://127.0.0.1:49175', token: 'test-session-only' });
  await assert.rejects(connected.post('/v1/clean/confirm', { previewId: 'test' }), error => error.reconnectable && error.message.includes('POST /v1/clean/confirm'));
  assert.equal(count, 1);
});

test('validation errors preserve the connection', async () => {
  const api = await client(async () => Response.json({ detail: 'No document' }, { status: 409 }));
  const connected = new api.Api({ baseUrl: 'http://127.0.0.1:49176', token: 'test-session-only' });
  await assert.rejects(connected.post('/v1/detect'), error => error.status === 409 && !error.reconnectable);
});
