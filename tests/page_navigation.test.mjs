import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/ui/pageNavigation.ts', import.meta.url), 'utf8');
const module = new vm.SourceTextModule(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
await module.link(()=>{throw Error('Unexpected dependency');});await module.evaluate();
const { PageNavigation } = module.namespace;
test('rapid requests serialize backend changes, coalesce pending targets and reject stale publication', async()=>{
  const nav=new PageNavigation(), calls=[],shown=[];
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const run=async(id,current)=>{calls.push(id);if(id==='1')await gate;if(current())shown.push(id);};
  const first=nav.request('1',run);nav.request('2',run);const last=nav.request('12',run);
  assert.equal(nav.running,true);assert.deepEqual(calls,['1']);release();await first;await last;
  assert.deepEqual(calls,['1','12']);assert.deepEqual(shown,['12']);assert.equal(nav.running,false);
});
test('failed edit flush stops navigation and permits a safe retry',async()=>{
  const nav=new PageNavigation();
  await assert.rejects(nav.request('2',async()=>{throw Error('unsaved edit failed');}));
  assert.equal(nav.running,false);const seen=[];
  await nav.request('1',async id=>seen.push(id));assert.deepEqual(seen,['1']);
});
