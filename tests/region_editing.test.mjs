import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const module = new vm.SourceTextModule(ts.transpileModule(await readFile(new URL('../src/ui/regionEditing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
await module.link(()=>{throw Error('Geometry must stay independent of runtime libraries');});await module.evaluate();
const {editRegion,RegionInteraction}=module.namespace;
const image={width:1114,height:1600};const rect=Object.freeze([124,184,117,120]);
test('moving preserves native dimensions and clamps every image edge',()=>{
  assert.deepEqual([...editRegion(rect,'move',{x:20.4,y:-10.2},image)],[144,174,117,120]);
  assert.deepEqual([...editRegion(rect,'move',{x:-10000,y:10000},image)],[0,1480,117,120]);
  assert.deepEqual([...rect],[124,184,117,120]);
});
test('all eight resize handles preserve opposite edges and positive integer bounds',()=>{
  for(const handle of ['nw','n','ne','e','se','s','sw','w'])for(const delta of [{x:11.7,y:22.8},{x:99999,y:-99999},{x:-99999,y:99999}]){
    const [x,y,w,h]=editRegion(rect,handle,delta,image);
    assert.ok([x,y,w,h].every(Number.isSafeInteger));assert.ok(x>=0&&y>=0&&w>=1&&h>=1&&x+w<=image.width&&y+h<=image.height);
    if(handle.includes('w'))assert.equal(x+w,241);else if(handle.includes('e'))assert.equal(x,124);
    if(handle.includes('n'))assert.equal(y+h,304);else if(handle.includes('s'))assert.equal(y,184);
  }
});
test('same physical gesture maps to the same native rectangle across zoom and DPI',()=>{
  for(const scale of [.2,1,4])for(const dpr of [1,1.25]){
    const physical={x:20*scale*dpr,y:12*scale*dpr};
    assert.deepEqual([...editRegion(rect,'se',{x:physical.x/dpr/scale,y:physical.y/dpr/scale},image)],[124,184,137,132]);
  }
});
test('100 pointer samples publish one latest frame to both viewport subscribers',()=>{
  let next=0;const callbacks=new Map();const store=new RegionInteraction(callback=>{callbacks.set(++next,callback);return next;},id=>callbacks.delete(id));
  let left=0,right=0;const off=store.subscribe(()=>left++);store.subscribe(()=>right++);
  for(let i=0;i<100;i++)store.update({id:'region',rect:[i,0,10,10]});
  assert.equal(callbacks.size,1);assert.equal(left,0);
  [...callbacks.values()][0](0);callbacks.clear();
  assert.equal(left,1);assert.equal(right,1);assert.equal(store.getSnapshot().rect[0],99);off();
  store.flush(null);assert.equal(left,1);assert.equal(right,2);
});
test('cancel or committed flush removes queued stale drafts',()=>{
  const callbacks=new Map();let id=0;const store=new RegionInteraction(callback=>{callbacks.set(++id,callback);return id;},key=>callbacks.delete(key));
  store.update({id:'region',rect:[1,2,3,4]});store.flush(null);assert.equal(callbacks.size,0);assert.equal(store.getSnapshot(),null);
  store.update({id:'region',rect:[2,3,4,5]});store.flush({id:'region',rect:[3,4,5,6]});assert.equal(callbacks.size,0);assert.deepEqual([...store.getSnapshot().rect],[3,4,5,6]);
});
