import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile, writeFile} from 'node:fs/promises';
import ts from 'typescript';

// Hook-contract harness: measures snapshot equality and callback delivery, not React rendering.
const current = await readFile(new URL('../src/components/Typography.tsx', import.meta.url), 'utf8');
const before = process.env.UI09C_BEFORE ? await readFile(process.env.UI09C_BEFORE, 'utf8') : null;
const fixtures = count => Array.from({length:count}, (_,i)=>({id:`d${i}`,bubble_id:`b${i}`,text:`Dialogue ${i}`,size:32,minimum_size:12,visible:true,auto_fit:true}));
function store() {
  let snapshot={drafts:{},layers:{},loading:{},errors:{}};
  const listeners=new Set();
  return {subscribe:fn=>(listeners.add(fn),()=>listeners.delete(fn)),getSnapshot:()=>snapshot,
    emit:patch=>{snapshot={...snapshot,...patch};listeners.forEach(fn=>fn());},listeners,
    resizeFont:async()=>{},snapshot:()=>snapshot};
}
async function component(source) {
  let active;
  const context=vm.createContext({});
  const synthetic=(names,values)=>new vm.SyntheticModule(names,function(){names.forEach(n=>this.setExport(n,values[n]));},{context});
  const jsx=(_type,props)=>({_type,props});
  const react=synthetic(['useEffect','useMemo','useRef','useState','useSyncExternalStore'],{
    useEffect:()=>{},useRef:()=>{},useState:()=>{},
    useMemo:(factory,deps)=>{const h=active; if(!h.memo||deps.some((x,i)=>!Object.is(x,h.deps[i]))){h.memo=factory();h.deps=deps;}return h.memo;},
    useSyncExternalStore:(subscribe,get)=>{const h=active;h.get=get;if(!h.stop)h.stop=subscribe(()=>{h.callbacks++;const value=h.get();if(!Object.is(value,h.value)){h.updates++;h.render();}});h.value=get();return h.value;}
  });
  const helpers=synthetic(['cardDialogue','fontSizePatch'],{cardDialogue:(items,bubble,selected)=>{const linked=items.filter(x=>x.bubble_id===bubble);return linked.length===1?linked[0]:linked.find(x=>x.id===selected)??null;},fontSizePatch:()=>{}});
  const runtime=synthetic(['jsx','jsxs'],{jsx,jsxs:jsx});
  const overlay=synthetic(['TextRegionOverlay'],{TextRegionOverlay:()=>null});
  const browser=synthetic(['FontBrowser'],{FontBrowser:()=>null});
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const mod=new vm.SourceTextModule(code,{context});
  await mod.link(name=>name==='react'?react:name==='react/jsx-runtime'?runtime:name.includes('ui/typography')?helpers:name.includes('FontBrowser')?browser:overlay);await mod.evaluate();
  return props=>{const h={props,callbacks:0,updates:0,executions:0,render(){active=h;h.executions++;h.output=mod.namespace.TypographyCardControls(h.props);active=null;}};h.render();return h;};
}
const mount=await component(current);
const props=(session,dialogues,bubbleId='b0',selected=null)=>({session,dialogues,bubbleId,selected,disabled:false,onTarget:()=>{}});

for(const count of [1,5,20])test(`stable selective snapshot and genuine updates with ${count} Dialogue`,()=>{
  const s=store(),items=fixtures(count),h=mount(props(s,items));const initial=h.value;
  assert.equal(h.get(),initial);
  s.emit({drafts:{unrelated:{id:'unrelated',size:80}}});assert.equal(h.updates,0);assert.equal(h.value,initial);
  const changed={...items[0],size:33};s.emit({drafts:{d0:changed}});assert.equal(h.updates,1);assert.equal(h.value.text,changed);
  const b=mount(props(s,items,count>1?'b1':'empty'));
  s.emit({drafts:{d0:{...changed,size:34}}});assert.equal(b.updates,0);
  if(count>1){s.emit({drafts:{...s.snapshot().drafts,d1:{...items[1],size:35}}});assert.equal(b.updates,1);assert.equal(b.value.text.size,35);}
  h.stop();b.stop();assert.equal(s.listeners.size,0);
});

test('multi-layer remains ambiguous until explicit Dialogue 02; callback targets its ID',()=>{
  const s=store(),items=fixtures(2).map(x=>({...x,bubble_id:'b0'}));const h=mount(props(s,items));
  assert.equal(h.value.text,null);assert.equal(h.output.props.children[0].props.disabled,true);
  h.props={...h.props,selected:'d1'};h.render();assert.equal(h.value.text.id,'d1');
  let target; s.resizeFont=async(id,bubble,delta)=>{target={id,bubble,delta};};
  h.output.props.children[2].props.onClick();assert.deepEqual(target,{id:'d1',bubble:'b0',delta:1});assert.equal(items[0].size,32);h.stop();
});

test('loading, resolved Auto Fit, fallback layer, error, visibility and Auto Fit off remain observable',()=>{
  const s=store(),items=fixtures(1),h=mount(props(s,items));
  s.emit({loading:{d0:true}});assert.equal(h.value.pending,true);
  const layer={effectiveSize:19,resolvedFamily:'Fallback',warnings:['Fallback'],png:'raster'};
  s.emit({loading:{d0:false},layers:{d0:layer}});assert.equal(h.value.layer,layer);assert.equal(h.value.pending,false);
  s.emit({errors:{d0:'preview failed'}});assert.equal(h.value.error,'preview failed');
  s.emit({errors:{}});assert.equal(h.value.error,undefined);
  s.emit({drafts:{d0:{...items[0],auto_fit:false,visible:false}}});assert.equal(h.value.text.auto_fit,false);assert.equal(h.output.props.children[0].props.disabled,true);h.stop();
});

test('session/project replacement, restore, delete and remount have no cached old layer',()=>{
  const a=store(),items=fixtures(1),h=mount(props(a,items));
  a.emit({drafts:{d0:{...items[0],size:40}}});assert.equal(h.value.text.size,40);
  a.emit({drafts:{}});assert.equal(h.value.text.size,32); // Restore snapshot contract; not backend Undo.
  h.props={...h.props,dialogues:[]};h.render();assert.equal(h.value.text,null);
  h.stop();assert.equal(a.listeners.size,0);
  const b=store(),replacement=[{...items[0],size:15}];const fresh=mount(props(b,replacement));assert.equal(fresh.value.text.size,15);assert.equal(fresh.value.layer,undefined);fresh.stop();assert.equal(b.listeners.size,0);
});

test('comparable before/after callback and effective snapshot update metrics',async()=>{
  if(!before)return;
  const baseline=await component(before),rows=[];
  for(const count of [1,5,20])for(const [mode,mounter]of[['before',baseline],['after',mount]]){
    const s=store(),items=fixtures(count),cards=Array.from({length:11},(_,i)=>mounter(props(s,items,`b${i}`)));
    for(let i=0;i<30;i++)s.emit({drafts:{d0:{...items[0],text:`Edit ${i}`}}});
    assert.equal(cards[0].updates,30);assert.equal(cards[1].updates,mode==='before'?30:0);
    rows.push({dialogues:count,mode,notifications:30,callbacks:cards.reduce((n,h)=>n+h.callbacks,0),effectiveSnapshotUpdates:cards.reduce((n,h)=>n+h.updates,0),unrelatedCardUpdates:cards[1].updates,reactRenders:null,reactCommits:null});
    cards.forEach(h=>h.stop());assert.equal(s.listeners.size,0);
  }
  if(process.env.UI09C_METRICS)await writeFile(process.env.UI09C_METRICS,JSON.stringify(rows,null,2));
});
