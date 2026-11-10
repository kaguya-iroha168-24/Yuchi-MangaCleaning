import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';

test('actual App renders the empty workspace before any page or decoded frame exists', async () => {
  const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const context=vm.createContext({window:{innerWidth:1536},localStorage:{getItem:()=>null}});
  const ast=ts.createSourceFile('App.js',code,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
  const imports=new Map();
  for(const node of ast.statements)if(ts.isImportDeclaration(node)){
    const names=node.importClause?.namedBindings?.elements?.map(item=>item.propertyName?.text??item.name.text)??[];
    imports.set(node.moduleSpecifier.text,names);
  }
  const app=new vm.SourceTextModule(code,{context});
  await app.link(async name=>{
    let values;
    if(name==='react'||name==='react/jsx-runtime')values=await import(name);
    else {
      values=Object.fromEntries((imports.get(name)??[]).map(key=>[key,key==='sourceValue'?()=>'' : /^[A-Z]/.test(key)?props=>props?.children??null:()=>{}]));
      for(const key of ['PageFrames','PageNavigation','TypographySession','ViewportController','RegionInteraction'])if(key in values)values[key]=class{getSnapshot(){return {mode:'dual'};}};
      if('ApiError' in values)values.ApiError=class extends Error{};
    }
    return new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
  });
  await app.evaluate();
  const html=renderToStaticMarkup(React.createElement(app.namespace.default));
  assert.match(html,/Open Image or Project/);
  assert.match(html,/Open Chapter Folder/);
  assert.match(html,/empty-workspace/);
});

test('App gates Text only Clean on visible Cleaned / Working layer and renders consistent guidance across toolbar and Properties while keeping Bubble mode unchanged', async () => {
  const source=await readFile(new URL('../src/App.tsx',import.meta.url),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const procSource=await readFile(new URL('../src/ui/processing.ts',import.meta.url),'utf8');
  const procCode=ts.transpileModule(procSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const shellSource=await readFile(new URL('../src/components/StudioShell.tsx',import.meta.url),'utf8');
  const shellCode=ts.transpileModule(shellSource,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;

  async function renderScenario({mode='text',showWorking=true,artwork='working',textMode='clean',artworkLocked=false,hasTextPreview=false,activeLayer='source'}={}){
    let callIndex=0;
    const doc={
      pageId:'page-1',revision:1,width:800,height:1200,sourceName:'page_001.png',dirty:false,savedPath:null,
      bubbles:[{id:'bubble-1',rect:[10,10,100,100],review:'Needs Review',cleaning:'Needs Review',kind:'Speech',source:'Shima V1',confidence:0.9}],
      textRegions:[{id:'text-1',rect:[20,20,60,40],text:'',bubbleId:null,direction:'vertical'}],
      dialogues:[],readingOrder:['text-1'],
      composition:{text_mode:textMode,artwork,artwork_locked:artworkLocked},
    };
    const reactMod=await import('react');
    const customReact={
      ...reactMod,
      default:{...reactMod.default},
      useSyncExternalStore:(_sub,get)=>get(),
      useState(init){
        const idx=callIndex++;
        const value=typeof init==='function'?init():init;
        if(idx===0)return [{},()=>{}]; // api
        if(idx===1)return [{schema:1,document:doc,job:null},()=>{}]; // state
        if(idx===14)return [showWorking,()=>{}]; // showWorking
        if(idx===21)return [activeLayer,()=>{}]; // activeLayer
        if(idx===28)return [new Set(['bubble-1']),()=>{}]; // selected
        if(idx===36)return [hasTextPreview?{id:'prev-1',textRegionId:'text-1',maskPixels:128,analysis:{}}:null,()=>{}]; // preview
        if(idx===43)return ['text-1',()=>{}]; // activeTextId
        return [value,()=>{}];
      },
    };
    const context=vm.createContext({window:{innerWidth:1536},localStorage:{getItem:k=>k==='yuchi-tauri-detection-mode'?mode:null}});
    const procMod=new vm.SourceTextModule(procCode,{context});
    await procMod.link(()=>{throw new Error('Unexpected import');});
    await procMod.evaluate();
    const shellMod=new vm.SourceTextModule(shellCode,{context});
    await shellMod.link(async name=>{
      if(name==='react')return new vm.SyntheticModule(Object.keys(customReact),function(){for(const k of Object.keys(customReact))this.setExport(k,customReact[k]);},{context});
      if(name==='react/jsx-runtime'){const m=await import(name);return new vm.SyntheticModule(Object.keys(m),function(){for(const k of Object.keys(m))this.setExport(k,m[k]);},{context});}
      if(name==='lucide-react'){const m=await import(name);return new vm.SyntheticModule(Object.keys(m),function(){for(const k of Object.keys(m))this.setExport(k,m[k]);},{context});}
      const stub={LoupePreview:()=>null,MiniMap:()=>null,ViewportReadout:()=>null};
      return new vm.SyntheticModule(Object.keys(stub),function(){for(const k of Object.keys(stub))this.setExport(k,stub[k]);},{context});
    });
    await shellMod.evaluate();

    const ast=ts.createSourceFile('App.js',code,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
    const imports=new Map();
    for(const node of ast.statements)if(ts.isImportDeclaration(node)){
      const names=node.importClause?.namedBindings?.elements?.map(item=>item.propertyName?.text??item.name.text)??[];
      imports.set(node.moduleSpecifier.text,names);
    }
    const app=new vm.SourceTextModule(code,{context});
    await app.link(async name=>{
      if(name==='react')return new vm.SyntheticModule(Object.keys(customReact),function(){for(const k of Object.keys(customReact))this.setExport(k,customReact[k]);},{context});
      if(name==='react/jsx-runtime'){const m=await import(name);return new vm.SyntheticModule(Object.keys(m),function(){for(const k of Object.keys(m))this.setExport(k,m[k]);},{context});}
      if(name==='./ui/processing')return procMod;
      if(name==='./components/StudioShell')return shellMod;
      const values=Object.fromEntries((imports.get(name)??[]).map(key=>[key,key==='sourceValue'?()=>'' : /^[A-Z]/.test(key)?props=>props?.children??null:()=>{}]));
      for(const key of ['PageFrames','PageNavigation','TypographySession','ViewportController','RegionInteraction'])if(key in values)values[key]=class{getSnapshot(){return {mode:'dual'};}};
      if('ApiError' in values)values.ApiError=class extends Error{};
      return new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
    });
    await app.evaluate();
    return renderToStaticMarkup(React.createElement(app.namespace.default));
  }

  // 1. Working layer visible + Clean + Cleaned / Working artwork => Clean enabled, no warning guidance
  const readyHtml=await renderScenario({mode:'text',showWorking:true,artwork:'working',textMode:'clean'});
  assert.match(readyHtml,/<button aria-label="Clean Selected" title="Clean Selected">Clean<\/button>/);
  assert.match(readyHtml,/<button>Preview Mask<\/button><button>Clean Selected<\/button>/);
  assert.doesNotMatch(readyHtml,/To clean text,/);

  // 2. Working layer checkbox hidden (even with prepared text preview mask!) => Clean disabled everywhere + checkbox hint
  const hiddenWorkingHtml=await renderScenario({mode:'text',showWorking:false,artwork:'working',textMode:'clean',hasTextPreview:true});
  assert.match(hiddenWorkingHtml,/<button disabled="" aria-label="Clean Selected" title="To clean text, enable the Layers → Cleaned \/ Working checkbox\.">Clean<\/button>/);
  assert.match(hiddenWorkingHtml,/<button disabled="" title="To clean text, enable the Layers → Cleaned \/ Working checkbox\.">Preview Mask<\/button><button disabled="" title="To clean text, enable the Layers → Cleaned \/ Working checkbox\.">Clean Selected<\/button>/);
  assert.match(hiddenWorkingHtml,/<p>To clean text, enable the Layers → Cleaned \/ Working checkbox\.<\/p>/);

  // 3. Both Artwork dropdown (Raw artwork) and Working checkbox hidden => guidance distinguishes both controls
  const bothHtml=await renderScenario({mode:'text',showWorking:false,artwork:'original',textMode:'clean'});
  assert.match(bothHtml,/<p>To clean text, set Layers → Artwork in Editing and export to Cleaned \/ Working and enable the Layers → Cleaned \/ Working checkbox\.<\/p>/);

  // 4. Bubble mode is unaffected when Working layer checkbox is hidden
  const bubbleHtml=await renderScenario({mode:'bubble',showWorking:false,artwork:'working',textMode:'clean',activeLayer:'bubble'});
  assert.match(bubbleHtml,/<button aria-label="Clean Selected" title="Clean Selected">Clean<\/button>/);
  assert.match(bubbleHtml,/<h3>Bubble \/ Cleaning<\/h3><button>Preview Mask<\/button><button>Clean Selected<\/button>/);
  assert.doesNotMatch(bubbleHtml,/To clean text,/);
});


test('App keeps Typography controls visible and disabled when no Dialogue or an empty bubble is selected, and active when a Dialogue is selected', async () => {
  const appCode=ts.transpileModule(await readFile(new URL('../src/App.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const procCode=ts.transpileModule(await readFile(new URL('../src/ui/processing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const shellCode=ts.transpileModule(await readFile(new URL('../src/components/StudioShell.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const typoUiCode=ts.transpileModule(await readFile(new URL('../src/ui/typography.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const regionCode=ts.transpileModule(await readFile(new URL('../src/ui/regionEditing.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const typoCompCode=ts.transpileModule(await readFile(new URL('../src/components/Typography.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;

  async function renderInspector({selectedBubbles=[],dialogues=[],selectedDialogueId=null,activeLayer=null}={}){
    let callIndex=0;
    const doc={
      pageId:'page-1',revision:1,width:800,height:1200,sourceName:'page_001.png',dirty:false,savedPath:null,
      bubbles:[{id:'bubble-empty',rect:[10,10,120,100],review:'Accepted',cleaning:'Needs Review',kind:'Speech',source:'Shima V1',confidence:0.95}],
      textRegions:[],dialogues,readingOrder:[],
      composition:{text_mode:'clean',artwork:'working',artwork_locked:false},
    };
    const reactMod=await import('react');
    const customReact={
      ...reactMod,
      default:{...reactMod.default},
      useSyncExternalStore:(_sub,get)=>get(),
      useState(init){
        const idx=callIndex++;
        const value=typeof init==='function'?init():init;
        if(idx===0)return [{fontCatalog:async()=>({fonts:[]}),subscribeFontCatalog:()=>()=>{}},()=>{}]; // api
        if(idx===1)return [{schema:1,document:doc,job:null},()=>{}]; // state
        if(idx===20)return [selectedDialogueId,()=>{}]; // selectedDialogueId
        if(idx===21)return [activeLayer,()=>{}]; // activeLayer
        if(idx===28)return [new Set(selectedBubbles),()=>{}]; // selected
        return [value,()=>{}];
      },
    };
    const context=vm.createContext({window:{innerWidth:1536},localStorage:{getItem:()=>null},setTimeout,clearTimeout});
    const synth=(obj)=>new vm.SyntheticModule(Object.keys(obj),function(){for(const k of Object.keys(obj))this.setExport(k,obj[k]);},{context});
    const procMod=new vm.SourceTextModule(procCode,{context});await procMod.link(()=>{throw new Error('Unexpected');});await procMod.evaluate();
    const regMod=new vm.SourceTextModule(regionCode,{context});await regMod.link(()=>{throw new Error('Unexpected');});await regMod.evaluate();
    const typoUiMod=new vm.SourceTextModule(typoUiCode,{context});await typoUiMod.link(()=>regMod);await typoUiMod.evaluate();
    const typoCompMod=new vm.SourceTextModule(typoCompCode,{context});
    await typoCompMod.link(async name=>{
      if(name==='react')return synth(customReact);
      if(name==='react/jsx-runtime')return synth(await import(name));
      if(name==='lucide-react')return synth(await import(name));
      if(name.endsWith('/typography'))return typoUiMod;
      return synth({FontBrowser:({value,disabled})=>React.createElement('button',{disabled,'aria-label':'Typography font family'},value),TextRegionOverlay:()=>null});
    });
    await typoCompMod.evaluate();
    const shellMod=new vm.SourceTextModule(shellCode,{context});
    await shellMod.link(async name=>{
      if(name==='react')return synth(customReact);
      if(name==='react/jsx-runtime')return synth(await import(name));
      if(name==='lucide-react')return synth(await import(name));
      return synth({LoupePreview:()=>null,MiniMap:()=>null,ViewportReadout:()=>null});
    });
    await shellMod.evaluate();
    const ast=ts.createSourceFile('App.js',appCode,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS);
    const imports=new Map();
    for(const node of ast.statements)if(ts.isImportDeclaration(node)){
      const names=node.importClause?.namedBindings?.elements?.map(item=>item.propertyName?.text??item.name.text)??[];
      imports.set(node.moduleSpecifier.text,names);
    }
    const app=new vm.SourceTextModule(appCode,{context});
    await app.link(async name=>{
      if(name==='react')return synth(customReact);
      if(name==='react/jsx-runtime')return synth(await import(name));
      if(name==='./ui/processing')return procMod;
      if(name==='./ui/typography')return typoUiMod;
      if(name==='./components/Typography')return typoCompMod;
      if(name==='./components/StudioShell')return shellMod;
      const values=Object.fromEntries((imports.get(name)??[]).map(key=>[key,key==='sourceValue'?()=>'' : /^[A-Z]/.test(key)?props=>props?.children??null:()=>{}]));
      for(const key of ['PageFrames','PageNavigation','ViewportController','RegionInteraction'])if(key in values)values[key]=class{getSnapshot(){return {mode:'dual'};}};
      if('ApiError' in values)values.ApiError=class extends Error{};
      return synth(values);
    });
    await app.evaluate();
    return renderToStaticMarkup(React.createElement(app.namespace.default));
  }

  // 1. Nothing selected on canvas -> prompt + disabled Typography controls visible
  const noneHtml=await renderInspector({selectedBubbles:[],dialogues:[],selectedDialogueId:null});
  assert.match(noneHtml,/Select a bubble or dialogue on the canvas\./);
  assert.match(noneHtml,/class="typography-fields is-disabled" aria-disabled="true"/);
  assert.match(noneHtml,/<button disabled="" aria-label="Typography font family">Arial<\/button>/);

  // 2. Empty bubble selected -> Bubble 01 header + disabled Typography controls visible; no Dialogue created/selected
  const emptyBubbleHtml=await renderInspector({selectedBubbles:['bubble-empty'],dialogues:[],selectedDialogueId:null,activeLayer:'bubble'});
  assert.match(emptyBubbleHtml,/<h2>Bubble 01<\/h2>/);
  assert.match(emptyBubbleHtml,/class="typography-fields is-disabled" aria-disabled="true"/);
  assert.doesNotMatch(emptyBubbleHtml,/id="typography-text"/);

  // 3. Dialogue selected -> Typography controls active and displaying Dialogue's values
  const dlg={id:'dlg-1',text:'Halo Chisa!',bubble_id:'bubble-empty',source_region_id:null,x:15,y:20,width:90,height:60,family:'Komika Axis',size:28,weight:700,minimum_size:12,color:'#223344',alignment:'right',visible:true,auto_fit:true,padding:8,style:{}};
  const activeDlgHtml=await renderInspector({selectedBubbles:['bubble-empty'],dialogues:[dlg],selectedDialogueId:'dlg-1',activeLayer:'dialogue'});
  assert.match(activeDlgHtml,/class="typography-fields" aria-disabled="false"/);
  assert.match(activeDlgHtml,/<button aria-label="Typography font family">Komika Axis<\/button>/);
  assert.match(activeDlgHtml,/Halo Chisa!/);
});
