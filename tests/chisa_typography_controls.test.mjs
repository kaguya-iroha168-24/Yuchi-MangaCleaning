import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { readFile } from 'node:fs/promises';

const context=vm.createContext({setTimeout,clearTimeout,requestAnimationFrame:fn=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout});
const compile=async path=>new vm.SourceTextModule(ts.transpileModule(await readFile(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText,{context});
const geometry=await compile('../src/ui/regionEditing.ts');await geometry.link(()=>{throw Error('Unexpected import');});await geometry.evaluate();
const module=await compile('../src/ui/typography.ts');await module.link(()=>geometry);await module.evaluate();
const {TypographySession}=module.namespace;
const plain=value=>JSON.parse(JSON.stringify(value));

test('size preset preferences retain exactly five slots and reject invalid stored values', () => {
  const { readSizePresets, fontSizePatch } = module.namespace;
  assert.deepEqual(plain(readSizePresets('[8,24,144,145,"32",35]')), [8,24,144,null,null]);
  assert.deepEqual(plain(readSizePresets('{broken')), [null,null,null,null,null]);
  assert.deepEqual(plain(fontSizePatch({ minimum_size: 12 }, 8)), { size: 8, minimum_size: 8 });
});
const text={id:'dialogue-a',text:'mIMPIKU malam itu\nKaktus!',bubble_id:'bubble-a',source_region_id:'source-a',x:10,y:20,width:120,height:150,family:'Arial',size:32,minimum_size:12,weight:400,color:'#123456',alignment:'center',visible:true,auto_fit:true,padding:8};
function setup(items=[text],preview=async()=>({png:'layer',warnings:[]})) {
  const session=new TypographySession(),commits=[];
  let document={pageId:'page-a',width:600,height:800,dialogues:items,bubbles:[{id:'bubble-a',rect:[100,200,160,300],containerPixels:48000}]};
  const api={post:async(path,fields)=>{
    if(path.includes('/preview'))return preview(fields);
    commits.push({path,fields:plain(fields)});
    const id=path.split('/').at(-1);document={...document,dialogues:document.dialogues.map(item=>item.id===id?{id,...fields}:item)};
    return {document};
  }};
  const configure=()=>session.configure(api,document,{state(){},dirty(){},error(){}});configure();
  return {session,commits,configure,get document(){return document;}};
}

test('repairing an overflowing translation fits within its linked bubble and preserves text', async () => {
  const h = setup([text], async fields => ({
    overflow: fields.dialogue.width < 160, effectiveSize: 10,
  }));
  try {
    assert.match(await h.session.fitInsideBubble(text.id), /Fitted at 10 px/);
    assert.equal(h.commits.length, 1);
    const [saved] = h.document.dialogues;
    assert.deepEqual([saved.x, saved.y, saved.width, saved.height], [100, 200, 160, 300]);
    assert.equal(saved.text, text.text);
    assert.equal(saved.source_region_id, text.source_region_id);
  } finally { h.session.dispose(); }
});

test('safe fit leaves the previous layout when words still overflow', async () => {
  const h = setup([text], async () => ({ overflow: true }));
  try {
    assert.match(await h.session.fitInsideBubble(text.id), /does not fit safely/);
    assert.equal(h.commits.length, 0);
  } finally { h.session.dispose(); }
});

test('Manga Style commits the previewed lettering while keeping source and dialogue text', async () => {
  const presetPatch = {family:'Komika Text Kaps',weight:700,style:{italic:true,line_height:.84,letter_spacing:-.65}};
  const h = setup([text], async fields => ({
    overflow: false, effectiveSize: 19, resolvedFamily: presetPatch.family,
    ...(fields.preset === 'manga' ? {presetPatch} : {}),
  }));
  try {
    assert.match(await h.session.fitInsideBubble(text.id, 'manga'), /Komika Text Kaps/);
    assert.equal(h.commits.length, 1);
    const [saved] = h.document.dialogues;
    assert.deepEqual(plain(saved.style), presetPatch.style);
    assert.equal(saved.family, presetPatch.family);
    assert.equal(saved.text, text.text);
    assert.equal(saved.source_region_id, text.source_region_id);
  } finally { h.session.dispose(); }
});

test('case conversion that cannot fit keeps the previous text/raster and creates no history commit',async()=>{
 const h=setup([text],async()=>({png:'empty',overflow:true,warnings:['Unbroken word exceeds safe width']}));const errors=[];
 try{
  h.session.configure({post:async(path,fields)=>path.includes('/preview')?{overflow:true,warnings:['Unbroken word exceeds safe width']}:assert.fail('invalid conversion must not commit')},h.document,{state(){},dirty(){},error:error=>errors.push(String(error))});
  await h.session.transformCase(text.id,'upper');
  assert.equal(h.session.getSnapshot().drafts[text.id],undefined,'unsafe case must not replace the visible draft');
  assert.equal(h.document.dialogues[0].text,text.text);assert.equal(h.commits.length,0);
  assert.ok(errors.some(e=>/not applied|does not fit/i.test(e)),'user must receive an explicit reason');
 }finally{h.session.dispose();}
});

test('Auto Fit can apply uppercase by lowering only the chosen Dialogue minimum to the measured safe size, with notice',async()=>{
 const other={...text,id:'other'};
 const h=setup([text,other],async fields=>({overflow:fields.dialogue.text===text.text.toUpperCase()&&fields.dialogue.minimum_size>8,effectiveSize:10}));
 try{
  const notice=await h.session.transformCase(text.id,'upper');
  assert.equal(h.document.dialogues[0].text,text.text.toUpperCase());
  assert.equal(h.document.dialogues[0].minimum_size,10);assert.equal(h.document.dialogues[0].size,32);
  assert.deepEqual(plain(h.document.dialogues[1]),other);assert.equal(h.commits.length,1,'case and local minimum are one history operation');
  assert.match(notice,/12.*10/,'local fitting adjustment must be explicit');
 }finally{h.session.dispose();}
});

test('case fitting never changes the minimum with Auto Fit disabled',async()=>{
 const base={...text,auto_fit:false};const minima=[];
 const h=setup([base],async fields=>{minima.push(fields.dialogue.minimum_size);return {overflow:true,effectiveSize:8};});
 try{await h.session.transformCase(base.id,'upper');assert.equal(h.commits.length,0);assert.ok(minima.every(value=>value===12));}
 finally{h.session.dispose();}
});

test('delayed case preflight never overwrites a newer typed draft or a different page',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const h=setup([text],async fields=>fields.dialogue.text===text.text?{overflow:false}:gate);
 try{
  const pending=h.session.transformCase(text.id,'upper');h.session.edit(text.id,{text:'Newer manual text'});
  release({overflow:false});await pending;
  assert.equal(h.session.getSnapshot().drafts[text.id].text,'Newer manual text');assert.equal(h.commits.length,0);
 }finally{h.session.dispose();}
});

test('flush waits for safe case conversion before navigation/save can proceed',async()=>{
 let release;const gate=new Promise(resolve=>{release=resolve;});
 const h=setup([text],async fields=>fields.dialogue.text===text.text?{overflow:false}:gate);
 try{
  const pending=h.session.transformCase(text.id,'upper');let flushed=false;
  const flush=h.session.flush().then(()=>{flushed=true;});
  await Promise.resolve();assert.equal(flushed,false);assert.equal(h.commits.length,0);
  release({overflow:false});await Promise.all([pending,flush]);
  assert.equal(h.document.dialogues[0].text,'MIMPIKU MALAM ITU\nKAKTUS!');assert.equal(h.commits.length,1);
 }finally{h.session.dispose();}
});

test('latest case intent wins even when preview responses finish out of order',async()=>{
 let upper,lower;const upperGate=new Promise(resolve=>{upper=resolve;}),lowerGate=new Promise(resolve=>{lower=resolve;});
 const h=setup([text],async fields=>fields.dialogue.text===text.text?{overflow:false}:fields.dialogue.text===text.text.toUpperCase()?upperGate:lowerGate);
 try{
  const a=h.session.transformCase(text.id,'upper');const b=h.session.transformCase(text.id,'lower');
  lower({overflow:false});upper({overflow:false});await Promise.all([a,b]);
  assert.equal(h.document.dialogues[0].text,text.text.toLowerCase());assert.equal(h.commits.length,1);
 }finally{h.session.dispose();}
});

test('AA/Aa/aa transform only the explicit dialogue, preserving whitespace, raw-source identity and latest draft', async()=>{
  const other={...text,id:'dialogue-b',text:'LEAVE ME'};
  const h=setup([text,other]);try {
    assert.equal(typeof h.session.transformCase,'function','case actions are not implemented');
    h.session.edit(text.id,{text:'mIMPIKU malam itu\nKaktus!'});
    await h.session.transformCase(text.id,'upper');assert.equal(h.document.dialogues[0].text,'MIMPIKU MALAM ITU\nKAKTUS!');
    await h.session.transformCase(text.id,'title');assert.equal(h.document.dialogues[0].text,'Mimpiku Malam Itu\nKaktus!');
    await h.session.transformCase(text.id,'lower');assert.equal(h.document.dialogues[0].text,'mimpiku malam itu\nkaktus!');
    assert.deepEqual(plain(h.document.dialogues[1]),other);
    for(const [key,value] of Object.entries(text))if(key!=='text')assert.deepEqual(h.document.dialogues[0][key],value,key);
    const count=h.commits.length;await h.session.transformCase('not-on-page','upper');assert.equal(h.commits.length,count);
  }finally{h.session.dispose();}
});

test('native-pixel nudges read latest drafts under rapid input and clamp to all page edges', async()=>{
  const h=setup();try {
    assert.equal(typeof h.session.nudge,'function','position nudges are not implemented');
    await Promise.all(Array.from({length:10},()=>h.session.nudge(text.id,1,0)));
    assert.equal(h.document.dialogues[0].x,20);assert.equal(h.document.dialogues[0].y,20);
    await h.session.nudge(text.id,-1000,-1000);assert.equal(h.document.dialogues[0].x,0);assert.equal(h.document.dialogues[0].y,0);
    await h.session.nudge(text.id,10000,10000);assert.equal(h.document.dialogues[0].x,480);assert.equal(h.document.dialogues[0].y,650);
    const saved=h.document.dialogues[0];assert.equal(saved.text,text.text);assert.equal(saved.width,120);assert.equal(saved.source_region_id,'source-a');
  }finally{h.session.dispose();}
});

test('centering uses linked bubble, otherwise page; bounds stay valid and unknown target is a no-op', async()=>{
  const detached={...text,id:'detached',bubble_id:null};
  const h=setup([text,detached]);try {
    assert.equal(typeof h.session.center,'function','center action is not implemented');
    await h.session.center(text.id);assert.equal(h.document.dialogues[0].x,120);assert.equal(h.document.dialogues[0].y,275);
    await h.session.center(detached.id);assert.equal(h.document.dialogues[1].x,240);assert.equal(h.document.dialogues[1].y,325);
    const count=h.commits.length;await h.session.center('missing');assert.equal(h.commits.length,count);
    h.configure();assert.equal(h.session.getSnapshot().drafts[text.id],undefined);
  }finally{h.session.dispose();}
});

test('actual Inspector buttons route case, Shift nudges and centering to selected Dialogue; disabled state is explicit',async()=>{
  const h=setup();try{
    const jsx={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
    const react={useEffect(){},useMemo:fn=>fn(),useRef:value=>({current:value}),useState:value=>[typeof value==='function'?value():value,()=>{}],useSyncExternalStore:(_subscribe,get)=>get()};
    const synth=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const key of Object.keys(values))this.setExport(key,values[key]);},{context});
    const component=new vm.SourceTextModule(ts.transpileModule(await readFile(new URL('../src/components/Typography.tsx',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText,{context});
    await component.link(async name=>name==='react'?synth(react):name==='react/jsx-runtime'?synth(jsx):name==='lucide-react'?synth(await import(name)):name.endsWith('/typography')?module:synth({FontBrowser:'fonts',TextRegionOverlay:'overlay'}));await component.evaluate();
    const render=disabled=>component.namespace.TypographyControls({api:null,session:h.session,selected:h.document.dialogues[0],disabled,onDelete(){},sourceControls:null});
    const nodes=tree=>!tree||typeof tree!=='object'?[]:[tree,...[tree.props?.children].flat(Infinity).flatMap(nodes)];
    const button=(label,disabled=false)=>nodes(render(disabled)).find(n=>n.type==='button'&&(n.props['aria-label']===label||n.props.children===label));
    assert.ok(button('Uppercase dialogue'));button('Uppercase dialogue').props.onClick();await h.session.flush();
    assert.equal(h.document.dialogues[0].text,'MIMPIKU MALAM ITU\nKAKTUS!');
    button('Nudge dialogue right').props.onClick({shiftKey:true});await h.session.flush();assert.equal(h.document.dialogues[0].x,20);
    const center=nodes(render(false)).find(n=>n.type==='button'&&n.props.title?.startsWith('Center within'));
    assert.ok(center);center.props.onClick();await h.session.flush();assert.equal(h.document.dialogues[0].x,120);
    assert.equal(button('Uppercase dialogue',true).props.disabled,true);
    assert.equal(button('Align center').props['aria-pressed'],true);
    button('Align right').props.onClick();await h.session.flush();
    assert.equal(h.document.dialogues[0].alignment,'right');
    assert.equal(button('Align right').props['aria-pressed'],true);
    assert.equal(button('Auto Fit to Bubble').props['aria-pressed'],true);
    button('Auto Fit to Bubble').props.onClick();await h.session.flush();
    assert.equal(h.document.dialogues[0].auto_fit,false);
    assert.equal(button('Auto Fit to Bubble').props['aria-pressed'],false);
    button('Auto Width').props.onClick();await h.session.flush();
    assert.equal(h.document.dialogues[0].style.auto_width,true);
    const colorElement=()=>nodes(render(false)).find(n=>n.type?.name==='TextColor');
    const pickButton=()=>nodes(colorElement().type(colorElement().props)).find(n=>n.props?.['aria-label']==='Pick text color from screen');
    context.window={EyeDropper:class{async open(){return {sRGBHex:'#456789'};}}};
    assert.ok(pickButton(),'actual screen color picker control is missing');
    await pickButton().props.onClick();await h.session.flush();assert.equal(h.document.dialogues[0].color,'#456789');
    context.window={EyeDropper:class{async open(){throw {name:'AbortError'};}}};
    const count=h.commits.length;await pickButton().props.onClick();assert.equal(h.commits.length,count,'cancelling must not edit color');
    context.window={};assert.equal(pickButton().props.disabled,true,'unavailable native API must not look functional');
    const emptyTree=component.namespace.TypographyControls({api:null,session:h.session,selected:null,disabled:false,onCreate(){assert.fail('must not auto-create dialogue');},onDelete(){assert.fail('must not delete');},sourceControls:null});
    const emptyNodes=nodes(emptyTree);
    const fieldsBox=emptyNodes.find(n=>typeof n.props?.className==='string'&&n.props.className.includes('typography-fields'));
    assert.ok(fieldsBox,'Typography controls container must remain visible when no Dialogue is selected');
    assert.match(fieldsBox.props.className,/\bis-disabled\b/);
    assert.equal(fieldsBox.props['aria-disabled'],true);
    const emptyButtons=emptyNodes.filter(n=>n.type==='button');
    assert.ok(emptyButtons.length>=15,'all typography buttons must be rendered when no Dialogue is selected');
    for(const btn of emptyButtons)assert.equal(btn.props.disabled,true,`button ${btn.props['aria-label']||btn.props.children} must be disabled when no Dialogue is selected`);
    for(const numNode of emptyNodes.filter(n=>n.type?.name==='NativeNumber'))assert.equal(numNode.props.disabled,true,`NativeNumber ${numNode.props.label} must be disabled`);
    for(const colNode of emptyNodes.filter(n=>n.type?.name==='TextColor'))assert.equal(colNode.props.disabled,true,`TextColor ${colNode.props.label||'Text color'} must be disabled`);
    const commitsBefore=h.commits.length;
    emptyButtons.find(n=>n.props['aria-label']==='Uppercase dialogue').props.onClick();
    emptyButtons.find(n=>n.props['aria-label']==='Nudge dialogue right').props.onClick({shiftKey:false});
    await h.session.flush();
    assert.equal(h.commits.length,commitsBefore,'disabled controls with no selected Dialogue must not commit or mutate');
  }finally{h.session.dispose();}
});
