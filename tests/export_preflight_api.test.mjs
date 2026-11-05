import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const source=ts.transpileModule(await readFile(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
async function api(detail){
  const context=vm.createContext({fetch:async()=>Response.json({detail},{status:422}),Response,AbortController,setTimeout,clearTimeout});
  const module=new vm.SourceTextModule(source,{context});
  const bridge=new vm.SyntheticModule(['invoke'],function(){this.setExport('invoke',()=>{throw Error('Unexpected startup');});},{context});
  await module.link(()=>bridge);await module.evaluate();return module.namespace;
}
test('structured preflight stays actionable without reconnect or lost dialogue IDs',async()=>{
  const detail={code:'typesetting_preflight',message:'Export blocked',pageId:'p1',pageName:'page.png',pageNumber:1,revision:2,issues:[{dialogueId:'d2',dialogueLabel:'Dialogue 02',reason:'Overflow',requestedSize:47,resolvedSize:16}]};
  const {Api,ApiError}=await api(detail);const client=new Api({baseUrl:'http://localhost',token:'test-only'});
  await assert.rejects(client.save('png'),error=>error instanceof ApiError&&error.status===422&&!error.reconnectable&&error.message==='Export blocked'&&error.preflight.issues[0].dialogueId==='d2');
});
test('ordinary HTTP errors do not become preflight errors',async()=>{
  const {Api,ApiError}=await api('Invalid field');const client=new Api({baseUrl:'http://localhost',token:'test-only'});
  await assert.rejects(client.save('jpeg'),error=>error instanceof ApiError&&error.message==='Invalid field'&&!error.preflight);
});
