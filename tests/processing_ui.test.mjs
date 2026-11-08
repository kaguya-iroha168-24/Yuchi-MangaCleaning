import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const path=new URL('../src/ui/processing.ts',import.meta.url);
let api={};
if(fs.existsSync(path)){
  const code=ts.transpileModule(fs.readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const module=new vm.SourceTextModule(code);await module.link(()=>{throw Error('Unexpected runtime dependency');});await module.evaluate();api=module.namespace;
}
test('processing scope uses all chapter IDs or explicit selected IDs',()=>{
  assert.equal(typeof api.processingPageIds,'function');
  const chapter={pages:[{id:'one'},{id:'two'}]};
  assert.deepEqual(Array.from(api.processingPageIds('all',chapter,new Set())),['one','two']);
  assert.deepEqual(Array.from(api.processingPageIds('selected',chapter,new Set(['two']))),['two']);
  assert.deepEqual(Array.from(api.processingPageIds('current',chapter,new Set())),[]);
  assert.throws(()=>api.processingPageIds('selected',chapter,new Set()),/Select pages/);
});
test('completion distinguishes cleaned skipped failed and existing work without pretending to translate',()=>{
  assert.equal(typeof api.processingMessage,'function');
  const message=api.processingMessage({type:'process',status:'done',result:{processedPages:2,attemptedPages:3,cleanedRegions:5,skippedRegions:1,alreadyProcessedRegions:2,translationStatus:'unavailable'}});
  assert.match(message,/2\/3 pages processed/);assert.match(message,/5 regions cleaned/);assert.match(message,/1 skipped/);assert.match(message,/2 already clean/);assert.doesNotMatch(message,/translation is not configured/);
  assert.equal(api.processingMessage({type:'scan-detect',status:'done'}),'');
  assert.equal(api.processingMessage({type:'detect-bubbles',status:'done',result:{processedPages:14,attemptedPages:14}}),'Bubble detection complete · 14 pages');
});
test('manual clean has no review-confirm barrier and automatic processing stays explicit',()=>{
  const app=fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
  assert.doesNotMatch(app,/Apply this validated text mask/);
  assert.match(app,/\/v1\/process/);
  assert.match(app,/skip_ocr:true/);
});
test('terminal automatic jobs refresh retained page pixels even after cancellation or failure',()=>{
  assert.equal(typeof api.refreshJobImages,'function');
  for(const status of ['done','cancelled','failed'])assert.equal(api.refreshJobImages({type:'process',status}),true);
  assert.equal(api.refreshJobImages({type:'scan-detect',status:'done'}),true);
  assert.equal(api.refreshJobImages({type:'ocr',status:'done'}),false);
  assert.equal(api.refreshJobImages({type:'detect-bubbles',status:'done'}),false);
  assert.equal(api.refreshJobImages({type:'process',status:'running'}),false);
});
