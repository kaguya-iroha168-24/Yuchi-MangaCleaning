import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const code=ts.transpileModule(await readFile(new URL('../src/components/FontBrowser.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
async function harness(){
 let values=[],cursor=0,selected=[];
 const context=vm.createContext({window:{document:{activeElement:null}}});
 const synth=(exports)=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
 const jsx=(type,props)=>({type,props});
 const react=synth({useState:initial=>{const i=cursor++;if(!(i in values))values[i]=initial;return [values[i],v=>{values[i]=v;}];},useRef:()=>({current:null}),useMemo:f=>f()});
 const runtime=synth({jsx,jsxs:jsx}),css=synth({});
 const mod=new vm.SourceTextModule(code,{context});await mod.link(name=>name==='react'?react:name==='react/jsx-runtime'?runtime:css);await mod.evaluate();
 const fonts=[{family:'Arial',status:'Available',preview:'real-png',sample:'Aa'},{family:'Missing Font',status:'Missing',preview:null},{family:'Cambria Math',status:'Available',preview:'math-png',sample:'x²'}];
 return {selected,render:()=>{cursor=0;return mod.namespace.FontBrowser({fonts,value:'Arial',disabled:false,onSelect:value=>selected.push(value)});}};
}
function nodes(node){if(Array.isArray(node))return node.flatMap(nodes);if(!node||typeof node!=='object')return [];return [node,...nodes(node.props?.children)];}
test('opening/search/preview does not apply a font; available selection applies once',async()=>{
 const h=await harness();let tree=h.render();nodes(tree).find(n=>n.props?.['aria-label']==='Typography font family').props.onClick();tree=h.render();
 assert.equal(h.selected.length,0);
 const missing=nodes(tree).find(n=>n.props?.title===undefined&&n.props?.className==='font-browser-item'&&n.props.disabled);
 assert.ok(missing);assert.equal(nodes(missing).some(n=>n.type==='img'),false);
 const search=nodes(tree).find(n=>n.props?.['aria-label']==='Search fonts');search.props.onChange({target:{value:'cambria'}});tree=h.render();
 const rows=nodes(tree).filter(n=>n.props?.className==='font-browser-item');assert.equal(rows.length,1);assert.equal(nodes(rows[0]).find(n=>n.type==='img').props.alt,'Cambria Math: x²');
 rows[0].props.onClick();assert.deepEqual(h.selected,['Cambria Math']);assert.equal(nodes(h.render()).some(n=>n.props?.className==='font-browser-panel'),false);
});
test('ArrowUp from search targets last row; Home/End/Escape are handled',async()=>{
 const h=await harness();nodes(h.render()).find(n=>n.props?.['aria-label']==='Typography font family').props.onClick();const panel=nodes(h.render()).find(n=>n.props?.className==='font-browser-panel');
 let focused=-1;const items=[0,1].map(i=>({focus:()=>focused=i}));
 const event=key=>({key,preventDefault(){},currentTarget:{querySelectorAll:()=>items}});
 panel.props.onKeyDown(event('ArrowUp'));assert.equal(focused,1);panel.props.onKeyDown(event('Home'));assert.equal(focused,0);panel.props.onKeyDown(event('End'));assert.equal(focused,1);panel.props.onKeyDown(event('Escape'));assert.equal(nodes(h.render()).some(n=>n.props?.className==='font-browser-panel'),false);
});
