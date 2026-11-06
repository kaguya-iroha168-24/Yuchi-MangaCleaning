import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source=await readFile(new URL('../src/ui/selection.ts',import.meta.url),'utf8');
const mod=new vm.SourceTextModule(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText);
await mod.link(()=>{throw Error('No dependencies expected');});await mod.evaluate();
const {selectionLayer}=mod.namespace;
test('one active handle layer, with no handles on Original or during mask correction',()=>{
  const input={editing:true,mask:false,dialogue:'dialogue',text:'source',bubble:'bubble'};
  assert.equal(selectionLayer(input),'dialogue');
  assert.equal(selectionLayer({...input,dialogue:null}),'bubble');
  assert.equal(selectionLayer({...input,dialogue:null,bubble:null}),'source');
  assert.equal(selectionLayer({...input,editing:false}),'none');
  assert.equal(selectionLayer({...input,mask:true}),'none');
});
