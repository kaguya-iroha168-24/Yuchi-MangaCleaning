import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../src/ui/sourceText.ts',import.meta.url),'utf8');
const module=new vm.SourceTextModule(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText);
await module.link(()=>{throw Error('Runtime dependency not expected');});await module.evaluate();
const {sourceValue}=module.namespace;
test('raw OCR is shown only when no manual source override exists, including an intentionally empty correction',()=>{
  const region={text:'',sourceEdited:false,ocr:{edited_text:'OCR original'}};
  assert.equal(sourceValue(region),'OCR original');
  assert.equal(sourceValue({...region,text:'Manual'}),'Manual');
  assert.equal(sourceValue({...region,sourceEdited:true}),'');
  assert.equal(sourceValue(null),'');
});
