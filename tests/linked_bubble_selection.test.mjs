import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';

const context=vm.createContext({window:{addEventListener(){},removeEventListener(){}},requestAnimationFrame(){},cancelAnimationFrame(){}});
const compile=async file=>new vm.SourceTextModule(ts.transpileModule(await readFile(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText,{context});
const selection=await compile('../src/ui/selection.ts');await selection.link(()=>{throw Error('Unexpected import');});await selection.evaluate();
const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
let refIndex=0,stage;
const react={memo:fn=>fn,useRef:initial=>({current:++refIndex===2&&stage?stage:initial}),useState:initial=>[initial?.width===1?{width:1000,height:800}:initial,()=>{}],useEffect(){},useSyncExternalStore:(_subscribe,get)=>get()};
const moduleFor=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
const viewport=await compile('../src/ui/viewport.ts');await viewport.link(()=>{throw Error('Unexpected import');});await viewport.evaluate();
const geometry=await compile('../src/ui/regionEditing.ts');await geometry.link(()=>{throw Error('Unexpected import');});await geometry.evaluate();
const overlay=await compile('../src/components/TextRegionOverlay.tsx');await overlay.link(name=>name==='react'?moduleFor(react):name==='react/jsx-runtime'?moduleFor(jsx):geometry);await overlay.evaluate();
const workspace=await compile('../src/components/CanvasWorkspace.tsx');await workspace.link(name=>{
 if(name==='react')return moduleFor(react);if(name==='react/jsx-runtime')return moduleFor(jsx);
 if(name.endsWith('/selection'))return selection;if(name.endsWith('/viewport'))return viewport;
 if(name.endsWith('/TextRegionOverlay'))return overlay;
 if(name.endsWith('/Typography'))return moduleFor({TypographyOverlay:'typography'});
 if(name==='react-konva')return moduleFor(Object.fromEntries(['Stage','Layer','Image','Rect','Line','Group','Circle'].map(key=>[key,'konva.'+key])));
 return moduleFor({Maximize:'Maximize',ZoomIn:'ZoomIn',ZoomOut:'ZoomOut'});
});await workspace.evaluate();
function nodes(tree){if(!tree||typeof tree!=='object')return [];return [tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];}
const bubble={id:'same-page-bubble',rect:[100,200,160,300],excluded:false,confidence:.8};
function pane(source,activeLayer=null,selected=new Set(),bubbles=[bubble]){
 stage={getPointerPosition:()=>({x:400,y:400}),getContent:()=>({setPointerCapture(){}})};refIndex=0;
 const controller=new viewport.namespace.ViewportController();
 const props={activeLayer,controller,original:null,working:null,containers:null,mask:null,width:600,height:800,name:'test',bubbles,textRegions:[],selected,selectedTextId:null,tool:'select',brushRadius:5,showBoxes:true,showMask:false,showOriginal:true,showWorking:true,showRegions:false,showSelection:true,editable:true,interaction:new geometry.namespace.RegionInteraction(),onCommitBubble:async()=>{},onDeselect(){},onEditText(){},onCommitRegion:async()=>{},onGesture(){},onBubble(){},onText(){},onRect(){},onBrush(){},typography:{session:{},dialogues:[],selected:null,visible:true}};
 const tree=workspace.namespace.CanvasWorkspace(props);const child=nodes(tree).find(n=>n.props?.source===source);
 refIndex=0;return {tree:child.type({...child.props,scale:1}),props:child.props,stage};
}

test('geometry hit testing works without text pixels and keeps connected logical IDs; excludes stale/hidden candidates',()=>{
 assert.equal(typeof selection.namespace.bubbleAt,'function','geometry hit test missing');
 const hit=selection.namespace.bubbleAt;
 assert.equal(hit([bubble],{x:140,y:300})?.id,bubble.id);
 assert.equal(hit([bubble],{x:99,y:300}),null);
 assert.equal(hit([bubble],{x:NaN,y:300}),null);
 assert.equal(hit([{...bubble,excluded:true}],{x:140,y:300}),null);
 assert.equal(hit([{...bubble,id:'outer',rect:[0,0,600,800]},bubble],{x:140,y:300})?.id,bubble.id);
});

test('linked overlays preserve native geometry at 50%,100%,200% with pan and never duplicate handles',()=>{
 for(const scale of [.5,1,2]){
  refIndex=0;stage=null;
  const tree=overlay.namespace.TextRegionOverlay({regions:[{...bubble,text:''}],selected:bubble.id,scale,offset:{x:-30,y:40},width:2000,height:2000,imageWidth:600,imageHeight:800,enabled:true,showSelection:true,candidate:true,controller:new geometry.namespace.RegionInteraction(),onSelect(){},onGesture(){},onPointer(){},onWheel(){}});
  const box=nodes(tree).find(n=>n.props?.['aria-pressed']!==undefined);
  assert.equal(box.props.style.left,-30+100*scale);assert.equal(box.props.style.top,40+200*scale);
  assert.equal(box.props.style.width,160*scale);assert.equal(box.props.style.height,300*scale);
  assert.equal(nodes(tree).filter(n=>n.props?.className?.startsWith('text-region-handle ')).length,8);
 }
});

test('translation cover follows the source region while dialogue position and zoom change',()=>{
 const props={typography:true,regions:[{id:'dialogue',rect:[160,120,100,90],text:'Hai',bubbleBound:true}],images:{dialogue:{png:'sample',width:100,height:90,coverRect:[120,100,60,50],coverPng:'mask',overlayOrigin:[152,115]}},selected:null,scale:2,offset:{x:-20,y:10},width:500,height:500,imageWidth:600,imageHeight:800,enabled:false,showSelection:false,controller:new geometry.namespace.RegionInteraction()};
 const tree=overlay.namespace.TextRegionOverlay({...props,showCovers:true});
 const box=nodes(tree).find(n=>n.props?.['data-dialogue']==='dialogue');
 const cover=nodes(tree).find(n=>n.props?.className==='typography-cover');
 assert.equal(box.props.style.left+cover.props.style.left,220);
 assert.equal(box.props.style.top+cover.props.style.top,210);
 assert.equal(cover.props.style.width,120);
 assert.equal(cover.props.style.height,100);
 assert.equal(cover.props.src,'data:image/png;base64,mask');
 const glyphs=nodes(tree).find(n=>n.props?.className==='typography-raster');
 assert.equal(box.props.style.left+glyphs.props.style.left,284);
 assert.equal(box.props.style.top+glyphs.props.style.top,240);
 assert.equal(nodes(overlay.namespace.TextRegionOverlay(props)).some(n=>n.props?.className==='typography-cover'),false);
 const stale = overlay.namespace.TextRegionOverlay({...props,showCovers:true,images:{dialogue:{png:'unbounded'}}});
 assert.equal(nodes(stale).some(n=>n.props?.className==='typography-raster'),false);
});

test('unselected cleaned Editing canvas click resolves stored bubble and does not deselect it',()=>{
 const h=pane('editing');let selected=null,deselected=0;
 const layer=nodes(h.tree).find(n=>n.type==='konva.Stage');
 // In the 1000x800 host, image offset is (200,0); native point=(140,300).
 h.stage.getPointerPosition=()=>({x:340,y:300});h.props.onBubble=(id)=>{selected=id;};
 // Re-render with handlers overridden (same object props used by pane JSX).
 const child=nodes(workspace.namespace.CanvasWorkspace({...h.props,original:null,working:null,showWorking:true,showOriginal:true,name:'test',onBubble:id=>{selected=id;},onDeselect:()=>deselected++})).find(n=>n.props?.source==='editing');
 refIndex=0;const rendered=child.type({...child.props,scale:1});
 const target={getStage(){return target;}};
 nodes(rendered).find(n=>n.type==='konva.Stage').props.onPointerDown({evt:{button:0,pointerId:1},target});
 assert.equal(selected,bubble.id);assert.equal(deselected,0);assert.ok(layer);
});

test('shared selected identity highlights Original without handles; Editing gets exactly eight',()=>{
 for(const source of ['original','editing']){
  const h=pane(source,'bubble',new Set([bubble.id]));
  const component=nodes(h.tree).find(n=>n.type===overlay.namespace.TextRegionOverlay&&n.props.candidate);
  assert.ok(component,'candidate overlay missing');refIndex=0;stage=null;
  const tree=component.type(component.props),box=nodes(tree).find(n=>n.props?.role==='button'&&n.props['aria-pressed']!==undefined);
  assert.equal(box.props['aria-pressed'],true,source+' selection highlight missing');
  assert.equal(nodes(tree).filter(n=>n.props?.className?.startsWith('text-region-handle ')).length,source==='editing'?8:0);
 }
});

test('filtered Editing overlay retains the same candidate number as Original',()=>{
 const first={...bubble,id:'first',rect:[0,0,50,50]};
 for(const source of ['original','editing']){
  const h=pane(source,'bubble',new Set([bubble.id]),[first,bubble]);
  const component=nodes(h.tree).find(n=>n.type===overlay.namespace.TextRegionOverlay&&n.props.candidate);
  refIndex=0;stage=null;
  const box=nodes(component.type(component.props)).find(n=>n.props?.['data-text-region']===bubble.id);
  assert.match(box.props['aria-label'],/^Bubble 02:/,source+' candidate number must not be reindexed');
 }
});

test('clicking the already-linked Original bubble focuses before changing selection, without a geometry gesture',()=>{
 let selected=null,gestures=0,focused=false;refIndex=0;stage=null;
 const tree=overlay.namespace.TextRegionOverlay({regions:[{...bubble,text:''}],selected:bubble.id,scale:1,offset:{x:0,y:0},width:1000,height:800,imageWidth:600,imageHeight:800,enabled:true,showSelection:false,showHighlight:true,selectionOnly:true,candidate:true,controller:new geometry.namespace.RegionInteraction(),onSelect:id=>{assert.equal(focused,true,'blur/commit old editor before selection change');selected=id;},onGesture:()=>gestures++,onPointer(){},onWheel(){}});
 const box=nodes(tree).find(n=>n.props?.['aria-pressed']!==undefined);
 box.props.onPointerDown({button:0,preventDefault(){},stopPropagation(){},currentTarget:{focus(){focused=true;}}});
 assert.equal(selected,bubble.id);assert.equal(gestures,0);
});
