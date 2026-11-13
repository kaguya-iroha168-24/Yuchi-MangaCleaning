import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { AlignCenter, AlignLeft, AlignRight, ArrowDownUp, Bold, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Italic, LocateFixed, MoveHorizontal, MoveVertical, Pipette, RotateCw, Scaling, Type } from 'lucide-react';
import type { Api, Dialogue, DialogueStyle, FontEntry, LayerPatch, TypographyRender } from '../api';
import { FontBrowser } from './FontBrowser';
import type { Point } from '../ui/viewport';
import { autoFitFontSizePatch, cardDialogue, computeAutoFitFontSize, evaluateDialogueOverflow, manualFontSizePatch, readSizePresets, type TypographySession } from '../ui/typography';
import { TextRegionOverlay } from './TextRegionOverlay';

export function TypographyOverlay(props: {
  session: TypographySession; dialogues: Dialogue[]; selected: string | null; visible: boolean; coverText?: boolean; overflowIds?: Set<string>;
  scale: number; offset: Point; width: number; height: number; imageWidth: number; imageHeight: number;
  enabled: boolean; showSelection: boolean; onSelect: (id: string) => void; onEdit: (id: string) => void;
  onGesture: (active: boolean) => void; onPointer: (point: Point) => void; onWheel: (event: WheelEvent) => void;
}) {
  const live = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  const [editor, setEditor] = useState<{ id: string; text: string } | null>(null);
  const editing = editor && editor.id === props.selected && props.dialogues.find(text => text.id === editor.id && !text.locked);
  const cancelled = useRef(false);
  const finish = (text: string) => {
    if (editor && editing && !cancelled.current && text !== editor.text) {
      props.session.edit(editor.id, { text });
      void props.session.flush().catch(() => {});
    }
    setEditor(null);
  };
  if (!props.visible) return null;
  const regions = props.dialogues.map(saved => live.drafts[saved.id] ?? saved).filter(text => text.visible).map(text => ({ id: text.id, text: text.text, locked: text.locked, bubbleBound: Boolean(text.bubble_id), overflow: Boolean(props.overflowIds?.has(text.id) || (text.bubble_id && props.overflowIds?.has(text.bubble_id)) || (text.source_region_id && props.overflowIds?.has(text.source_region_id))), rect: [Math.floor(text.x), Math.floor(text.y), Math.ceil(text.width), Math.ceil(text.height)] }));
  const editWidth = editing ? Math.min(props.width, Math.max(180, editing.width * props.scale)) : 0;
  const editHeight = editing ? Math.min(props.height, Math.max(72, Math.min(200, editing.height * props.scale))) : 0;
  return <>
    <TextRegionOverlay typography regions={regions} images={live.layers} showCovers={props.coverText} selected={props.selected} scale={props.scale} offset={props.offset} width={props.width} height={props.height} imageWidth={props.imageWidth} imageHeight={props.imageHeight} enabled={props.enabled && !editing} showSelection={props.showSelection && !editing} controller={props.session.interaction} onSelect={props.onSelect} onEdit={text => {
      props.onEdit(text.id);
      cancelled.current = false;
      setEditor({ id: text.id, text: text.text });
    }} onCommit={(id, rect) => props.session.pose(id, rect)} onGesture={props.onGesture} onPointer={props.onPointer} onWheel={props.onWheel} />
    {editor && editing && <textarea key={editor.id} className="canvas-dialogue-editor" aria-label="Edit dialogue on canvas" title="Ctrl+Enter to apply · Escape to cancel" autoFocus defaultValue={editor.text} maxLength={4000} style={{
      left: Math.max(0, Math.min(props.width - editWidth, props.offset.x + editing.x * props.scale)),
      top: Math.max(0, Math.min(props.height - editHeight, props.offset.y + editing.y * props.scale)),
      width: editWidth, height: editHeight,
    }} onBlur={event => finish(event.currentTarget.value)} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === 'Escape' || (event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
        event.preventDefault(); event.stopPropagation(); cancelled.current = event.key === 'Escape'; event.currentTarget.blur();
      }
    }} />}
  </>;
}

function NativeNumber({ label, value, min, max, disabled, onValue, onCommit, integer = true, icon }: { label: string; value: number; min: number; max: number; disabled: boolean; onValue: (value: number) => void; onCommit: () => void; integer?: boolean; icon?: ReactNode }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const valid = draft.trim() !== '' && Number.isFinite(Number(draft)) && (!integer || Number.isInteger(Number(draft))) && Number(draft) >= min && Number(draft) <= max;
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  return <label className={icon ? 'type-number' : undefined} title={icon ? label : undefined}>
    {icon ? <span aria-hidden="true">{icon}</span> : label}
    <input aria-label={label} type="number" min={min} max={max} step={integer ? 1 : 'any'} value={draft} disabled={disabled} aria-invalid={!valid} onFocus={() => { focused.current = true; }} onChange={event => { const raw = event.target.value; setDraft(raw); const number = Number(raw); if (raw.trim() && Number.isFinite(number) && (!integer || Number.isInteger(number)) && number >= min && number <= max) onValue(number); }} onBlur={() => { focused.current = false; if (!valid) setDraft(String(value)); onCommit(); }} />
  </label>;
}

function TextColor({ value, disabled, onValue, onCommit, label = 'Text color' }: { value: string; disabled: boolean; onValue: (value: string) => void; onCommit: () => void; label?: string }) {
  const [draft, setDraft] = useState(value);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState('');
  const Picker = typeof window === 'undefined' ? undefined : (window as Window & { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  useEffect(() => setDraft(value), [value]);
  const valid = /^#[0-9a-f]{6}$/i.test(draft);
  return <div className="type-color" role="group" aria-label={label}><span>{label}</span><div className="type-color-controls">
    <input aria-label={`Typography ${label.toLowerCase()}`} title={label} type="color" value={value} disabled={disabled} onChange={event => onValue(event.target.value)} onBlur={onCommit} />
    <input aria-label={`${label} hex`} title={`${label} hex`} value={draft} maxLength={7} disabled={disabled} aria-invalid={!valid} onChange={event => { const next = event.target.value; setDraft(next); if (/^#[0-9a-f]{6}$/i.test(next)) onValue(next); }} onBlur={() => { if (!valid) setDraft(value); onCommit(); }} />
    <button type="button" aria-label={`Pick ${label.toLowerCase()} from screen`} disabled={disabled || picking || !Picker} title={Picker?`Sample ${label.toLowerCase()} from screen (Esc to cancel)`:'Screen eyedropper is unavailable in this WebView'} onClick={async()=>{
    if(!Picker||picking)return;setPicking(true);setPickError('');
    try { const result=await new Picker().open();if(!/^#[0-9a-f]{6}$/i.test(result.sRGBHex))throw new Error('The screen picker returned an invalid color.');onValue(result.sRGBHex);onCommit(); }
    catch(error) { if((error as {name?:string})?.name!=='AbortError')setPickError(error instanceof Error?error.message:'Screen color sampling failed.'); }
    finally { setPicking(false); }
  }}><Pipette size={14} aria-hidden="true" /></button></div>
    {(picking || pickError) && <span className="warning-note" role="status">{picking ? 'Pick a screen pixel…' : pickError}</span>}
  </div>;
}

const sizePresetsKey = 'yuchi-tauri-font-size-presets';
const emptyDialogue: Dialogue = { id: '', text: '', bubble_id: null, source_region_id: null, x: 0, y: 0, width: 160, height: 80, family: 'Arial', size: 22, weight: 400, minimum_size: 12, color: '#111111', alignment: 'center', visible: true, auto_fit: true, padding: 8, style: {} };

export function TypographyControls({ api, session, selected, disabled: unavailable, onDelete, sourceControls, sourceOptions, bubbleHeader, onApprove, approveDisabled, boxBounds, onExpandBox, expandBusy }: { api: Api | null; session: TypographySession; selected: Dialogue | null; disabled: boolean; onCreate?: () => void; onDelete: (id: string) => void; sourceControls: React.ReactNode; sourceOptions?: React.ReactNode; bubbleHeader?: React.ReactNode; onApprove?: () => void; approveDisabled?: boolean; boxBounds?: [number, number] | null; onExpandBox?: () => void; expandBusy?: boolean }) {
  const live = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [fontError, setFontError] = useState('');
  const [caseNotice, setCaseNotice] = useState('');
  const [sizePresets, setSizePresets] = useState(() => readSizePresets(globalThis.localStorage?.getItem(sizePresetsKey) ?? null));
  const caseAction = useRef(0);
  const autoFitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const caseTarget = useRef(selected?.id); caseTarget.current = selected?.id;
  useEffect(() => { caseAction.current++; setCaseNotice(''); if (autoFitTimer.current) { clearTimeout(autoFitTimer.current); autoFitTimer.current = null; } }, [selected?.id]);
  useEffect(() => () => { if (autoFitTimer.current) clearTimeout(autoFitTimer.current); }, []);
  // timer cleanup above covers case reset
  useEffect(() => {
    setFonts([]); setFontError('');
    if (!api) return;
    let stale = false;
    let version = 0;
    const load = () => {
      const request = ++version;
      setFonts([]); setFontError('');
      api.fontCatalog().then(result => { if (!stale && request === version) { setFonts(result.fonts); setFontError(''); } }).catch(error => { if (!stale && request === version) setFontError(error instanceof Error ? error.message : String(error)); });
    };
    const unsubscribe = api.subscribeFontCatalog(load);
    load();
    return () => { stale = true; unsubscribe(); };
  }, [api]);
  const selectedText = selected ? live.drafts[selected.id] ?? selected : null; const text = selectedText ?? emptyDialogue;
  const disabled = unavailable || !selectedText || Boolean(selectedText.locked);
  const style = text?.style ?? {};
  const boxW = Math.max(8, boxBounds?.[0] ?? text.width);
  const boxH = Math.max(8, boxBounds?.[1] ?? text.height);
  const overflowState = selectedText ? evaluateDialogueOverflow(text, boxW, boxH) : { fontSize: text.size, lines: [], isOverflowing: false, totalTextHeight: 0, maxWordWidth: 0 };
  const lineCount = overflowState.lines.length || (text.text.trim() ? 1 : 0);
  const commit = () => { if (selectedText) void session.flush().catch(() => {}); };
  const change = (patch: Partial<Dialogue>, immediate = false) => { if (selectedText) { setCaseNotice(''); session.edit(selectedText.id, patch); if (immediate) commit(); } };
  const changeStyle = (patch: DialogueStyle, immediate = false) => {
    if (!selectedText) return;
    const current = session.getSnapshot().drafts[text.id] ?? text;
    change({ style: { ...current.style, ...patch } }, immediate);
  };
  const bumpSize=(delta:number)=>{if(!selectedText)return;const current=session.getSnapshot().drafts[selectedText.id] ?? selectedText;session.edit(selectedText.id,manualFontSizePatch(current,current.size+delta));commit();};
  const currentFont = fonts.find(font => font.family === text?.family);
  const supportsBold = Boolean((style.italic ? currentFont?.italicWeights : currentFont?.weights)?.includes(700));
  const layer = selectedText ? live.layers[selectedText.id] : null;
  const fitText = (preset?: 'manga') => {
    if (!selectedText) return;
    const id = text.id;
    setCaseNotice('Checking safe text fit…');
    void session.fitInsideBubble(id, preset).then(notice => {
      if (caseTarget.current === id) setCaseNotice(notice ?? '');
    }).catch(() => {
      if (caseTarget.current === id) setCaseNotice('Could not fit text. The previous layout was kept.');
    });
  };
  return <div className="typography-properties" data-typography-inspector="true">
    {Boolean(sourceControls || selectedText || sourceOptions || bubbleHeader) && <details className="property-group" open><summary>Translation</summary><div className="property-fields">
      {bubbleHeader}
      {sourceControls}
      {selectedText && <div className="translation-field-container">
        <div className="field-header-row">
          <label htmlFor="typography-text">Translation</label>
          <span className="char-counter">{text.text.length} chars · {lineCount} ln</span>
        </div>
        <textarea id="typography-text" aria-label="Typeset dialogue text" maxLength={4000} value={text.text} disabled={disabled} onChange={event => {
          const nextText = event.target.value;
          change({ text: nextText });
          if (autoFitTimer.current) { clearTimeout(autoFitTimer.current); autoFitTimer.current = null; }
          const id = selectedText.id;
          const targetBoxW = boxW;
          const targetBoxH = boxH;
          autoFitTimer.current = setTimeout(() => {
            autoFitTimer.current = null;
            const current = session.getSnapshot().drafts[id] ?? selected;
            if (!current || !current.auto_fit) return;
            const fitted = computeAutoFitFontSize({
              text: nextText,
              boxWidth: targetBoxW,
              boxHeight: targetBoxH,
              fontFamily: current.family,
              fontWeight: current.weight,
              italic: Boolean(current.style?.italic),
              lineHeight: current.style?.line_height ?? 1.15,
              letterSpacing: current.style?.letter_spacing ?? 0,
            });
            if (fitted.fontSize !== current.size) {
              session.edit(id, autoFitFontSizePatch(current, fitted.fontSize));
            }
          }, 80);
        }} onBlur={commit} placeholder="Enter Indonesian dialogue…" />
        {overflowState.isOverflowing && (
          <div className="overflow-inspector-bar" role="status">
            <span className="overflow-warning-chip">⚠ Text exceeds bubble bounds</span>
            {onExpandBox && (
              <button type="button" className="fit-box-btn" disabled={disabled || expandBusy} onClick={() => onExpandBox()} title="Expand box padding by 15% and refit">
                {expandBusy ? 'Fitting…' : 'Fit Box to Text'}
              </button>
            )}
          </div>
        )}
      </div>}
      {onApprove && <div className="approve-action"><button type="button" className="approve-button" disabled={approveDisabled || disabled} onClick={onApprove} title="Approve and move to next bubble (Ctrl+Enter)">✓ Approve (Ctrl+Enter)</button></div>}
      {sourceOptions}</div></details>}

    <details className="property-group" open><summary>Typography</summary><div className="property-fields">
    {fontError && <p role="alert" className="warning-note">{fontError}</p>}
    {!selectedText && <p className="section-note">Select a dialogue on Editing Canvas, or draw a box with T. Double-click a dialogue to edit it on the canvas.</p>}<div key={selectedText?.id ?? 'no-dialogue'} className={`typography-fields${selectedText ? '' : ' is-disabled'}`} aria-disabled={disabled}>
      <FontBrowser fonts={fonts} value={text.family} disabled={disabled} onSelect={family => change({ family }, true)} />
      <div className="type-size-row">
        <div className="size-stepper">
          <button type="button" disabled={disabled || text.size<=8} aria-label="Decrease requested font size" title="Decrease requested font size" onClick={()=>bumpSize(-1)}>−</button>
          <NativeNumber label="Font size (px)" icon={<Type size={13} />} value={text.size} min={8} max={144} disabled={disabled} onValue={size => change(manualFontSizePatch(text, size))} onCommit={commit} />
          <button type="button" disabled={disabled || text.size>=144} aria-label="Increase requested font size" title="Increase requested font size" onClick={()=>bumpSize(1)}>+</button>
        </div>
        <div className="type-presets" role="group" aria-label="Apply font size preset">{sizePresets.map((size, index) => <button key={index} type="button" disabled={disabled || size === null} aria-label={`Size preset ${index + 1}${size === null ? ', empty' : `, ${size} px`}`} title={size === null ? 'Empty preset · save a size in Advanced' : `Apply ${size} px`} aria-pressed={Boolean(selectedText) && index === sizePresets.indexOf(text.size)} onClick={() => { if (size !== null) change(manualFontSizePatch(text, size), true); }}>{index + 1}</button>)}</div>
      </div>
      <div className="type-format-row">
      <div className="type-quick-actions" role="group" aria-label="Dialogue emphasis and letter case">
      <button type="button" aria-label="Bold text" aria-pressed={text.weight>=600} disabled={disabled || (!supportsBold && text.weight<600)} title={supportsBold ? 'Bold' : 'This family has no available Bold 700 face'} onClick={()=>change({weight:text.weight>=600?400:700},true)}><Bold size={14} aria-hidden="true" /></button>
      <button type="button" aria-label="Italic text" aria-pressed={Boolean(style.italic)} disabled={disabled} title={fonts.find(font => font.family === text.family)?.italicWeights?.length ? 'Italic' : 'Italic uses a licensed installed face when available'} onClick={() => changeStyle({ italic: !style.italic }, true)}><Italic size={14} aria-hidden="true" /></button>
      {(['upper','title','lower'] as const).map((mode,index)=><button key={mode} type="button" disabled={disabled} aria-label={`${['Uppercase','Title case','Lowercase'][index]} dialogue`} title={`${['Uppercase','Title case (each word)','Lowercase'][index]}; Auto Fit may lower this dialogue's minimum to 8 px if needed, with an explicit notice`} onClick={()=>{
        if(!selectedText)return;const action=++caseAction.current,id=text.id;setCaseNotice('Checking case fit…');
        void session.transformCase(id,mode).then(notice=>{if(caseAction.current===action&&caseTarget.current===id)setCaseNotice(notice??'');}).catch(()=>{if(caseAction.current===action&&caseTarget.current===id)setCaseNotice('Case change was not applied.');});
      }}>{['AA','Aa','aa'][index]}</button>)}</div>
      <div className="type-quick-actions" role="group" aria-label="Text alignment">
        {([['left', 'Align left', AlignLeft], ['center', 'Align center', AlignCenter], ['right', 'Align right', AlignRight]] as const).map(([alignment, label, Icon]) =>
          <button key={alignment} type="button" disabled={disabled} aria-label={label} title={label} aria-pressed={text.alignment === alignment} onClick={() => change({ alignment }, true)}><Icon size={14} aria-hidden="true" /></button>)}
      </div>
      </div>
      {caseNotice&&<p role="status" className="section-note">{caseNotice}</p>}
      <div className="type-metrics">
        <NativeNumber label="Line height" icon={<ArrowDownUp size={14} />} value={style.line_height ?? 1} min={.5} max={3} integer={false} disabled={disabled} onValue={line_height => changeStyle({ line_height })} onCommit={commit} />
        <NativeNumber label="Letter spacing (px)" icon={<MoveHorizontal size={14} />} value={style.letter_spacing ?? 0} min={-4} max={24} integer={false} disabled={disabled} onValue={letter_spacing => changeStyle({ letter_spacing })} onCommit={commit} />
        <NativeNumber label="Vertical offset (px)" icon={<MoveVertical size={14} />} value={style.vertical_offset ?? 0} min={-200} max={200} integer={false} disabled={disabled} onValue={vertical_offset => changeStyle({ vertical_offset })} onCommit={commit} />
        <NativeNumber label="Rotation (°)" icon={<RotateCw size={14} />} value={style.rotation ?? 0} min={-180} max={180} integer={false} disabled={disabled} onValue={rotation => changeStyle({ rotation })} onCommit={commit} />
      </div>
      <div className="type-quick-actions" role="group" aria-label="Automatic text layout">
        <button type="button" aria-label="Auto Width" aria-pressed={Boolean(style.auto_width)} disabled={disabled} onClick={()=>changeStyle({auto_width:!style.auto_width},true)} title="Use the text width within the safe area"><MoveHorizontal size={14} aria-hidden="true" /> Auto Width</button>
        <button type="button" aria-label="Auto Fit to Bubble" title="Fit the text inside the bubble" aria-pressed={text.auto_fit} disabled={disabled} onClick={() => {
          if (text.auto_fit) { change({ auto_fit: false }, true); return; }
          const fitted = computeAutoFitFontSize({ text: text.text, boxWidth: boxW, boxHeight: boxH, fontFamily: text.family, fontWeight: text.weight, italic: Boolean(text.style?.italic), lineHeight: text.style?.line_height ?? 1.15, letterSpacing: text.style?.letter_spacing ?? 0 });
          change(autoFitFontSizePatch(text, fitted.fontSize), true);
        }}><Scaling size={14} aria-hidden="true" /> Auto Fit</button>
        <button type="button" title="Apply bold italic manga lettering and fit it inside the bubble" disabled={disabled || !text.text.trim()} onClick={() => fitText('manga')}><Type size={14} aria-hidden="true" /> Manga Style</button>
      </div>
      <div className="type-position">
        <span>Position</span>
        <div className="type-quick-actions" role="group" aria-label="Nudge dialogue position">
          {([['Left',-1,0,ChevronLeft],['Up',0,-1,ChevronUp],['Down',0,1,ChevronDown],['Right',1,0,ChevronRight]] as const).map(([label,dx,dy,Icon])=><button key={label} type="button" disabled={disabled} aria-label={`Nudge dialogue ${label.toLowerCase()}`} title={`${label}: 1 native pixel; Shift: 10 pixels`} onClick={event=>{if(!selectedText)return;void session.nudge(text.id,dx*(event.shiftKey?10:1),dy*(event.shiftKey?10:1)).catch(()=>{});}}><Icon size={14} aria-hidden="true" /></button>)}
          <button type="button" disabled={disabled} aria-label={text.bubble_id?'Center in bubble':'Center in page'} title={text.bubble_id?'Center within the linked bubble':'Center within the page'} onClick={()=>{if(!selectedText)return;void session.center(text.id).catch(()=>{});}}><LocateFixed size={14} aria-hidden="true" /></button>
        </div>
      </div>
      <div className="type-metrics">
        <TextColor value={text.color} disabled={disabled} onValue={color => change({ color })} onCommit={commit} />
        <TextColor label="Stroke color" value={style.stroke_color ?? '#ffffff'} disabled={disabled} onValue={stroke_color => changeStyle({ stroke_color })} onCommit={commit} />
      </div>
      {layer?.overflow && <button className="studio-action" disabled={disabled} onClick={() => fitText()}>Fit text safely</button>}
      <details><summary>Advanced typography</summary>
        <div className="control-pair"><label>Weight<select aria-label="Typography weight" value={text.weight} disabled={disabled} onChange={event => change({ weight: Number(event.target.value) }, true)}>{![400, 700].includes(text.weight) && <option value={text.weight}>{text.weight} · requested</option>}<option value={400}>Regular · 400</option><option value={700}>Bold · 700</option></select></label>
        <NativeNumber label="Stroke width (px)" value={style.stroke_width ?? 0} min={0} max={12} disabled={disabled} onValue={stroke_width => changeStyle({ stroke_width })} onCommit={commit} /></div>
        <label>Save requested size ({text.size} px) to slot<select value="" disabled={disabled} onChange={event => {
          const slot = event.target.value;
          if (slot === '' || !selectedText) return;
          const next = sizePresets.map((size, index) => index === Number(slot) ? text.size : size);
          localStorage.setItem(sizePresetsKey, JSON.stringify(next)); setSizePresets(next);
        }}><option value="" disabled>Choose a slot</option>{sizePresets.map((size, index) => <option key={index} value={index}>Preset {index + 1}{size === null ? '' : ` · replace ${size} px`}</option>)}</select></label>
      <div className="control-pair"><button disabled={disabled} onClick={() => { if (selectedText) session.copyStyle(text.id); }}>Copy Style</button><button disabled={disabled || !live.copiedStyle} onClick={() => { if (selectedText) void session.pasteStyle(text.id).catch(() => {}); }}>Paste Style</button></div>
      <div className="control-pair"><NativeNumber label="Safe padding (native px)" value={text.padding} min={0} max={512} disabled={disabled} onValue={padding => change({ padding })} onCommit={commit} /><NativeNumber label="Minimum font size" value={text.minimum_size} min={8} max={Math.min(48, text.size)} disabled={disabled} onValue={minimum_size => change({ minimum_size })} onCommit={commit} /></div>
      <div className="control-pair"><NativeNumber integer={false} label="Dialogue X" value={text.x} min={0} max={20000} disabled={disabled} onValue={x => change({ x })} onCommit={commit} /><NativeNumber integer={false} label="Dialogue Y" value={text.y} min={0} max={2000000} disabled={disabled} onValue={y => change({ y })} onCommit={commit} /></div>
      <div className="control-pair"><NativeNumber integer={false} label="Dialogue width" value={text.width} min={1} max={20000} disabled={disabled} onValue={width => change({ width })} onCommit={commit} /><NativeNumber integer={false} label="Dialogue height" value={text.height} min={1} max={2000000} disabled={disabled} onValue={height => change({ height })} onCommit={commit} /></div>
      {text.bubble_id && <button disabled={disabled} onClick={() => change({ bubble_id: null }, true)}>Detach bubble constraint</button>}
      </details>{live.loading[text.id] && <p role="status">Rendering text…</p>}
      {layer && <p className="section-note">Actual: {layer.resolvedFamily} {layer.resolvedItalic ? 'Italic' : ''} · {layer.resolvedWeight} · {layer.effectiveSize} native px{style.auto_width && layer.layoutWidth !== undefined ? ` · width ${layer.layoutWidth} px` : ''}</p>}
      {text.locked && <p className="section-note">Unlock this dialogue in Layers to edit it.</p>}
      {layer?.warnings.map((warning, index) => <p key={index} className="warning-note" role="status">{warning}</p>)}
      {live.errors[text.id] && <p role="alert" className="warning-note">{live.errors[text.id]}</p>}
      <button className="studio-action" disabled={disabled} onClick={() => { if (selectedText) onDelete(text.id); }}>Delete text layer</button>
    </div>
    </div></details>

    <details className="property-group" open><summary>Bubble Shape & Style</summary><div className="property-fields">
      <label>Shape<select aria-label="Bubble shape preset" disabled={disabled}>
        <option value="rounded">Rounded Rectangle</option>
        <option value="rect">Rectangle</option>
        <option value="ellipse">Ellipse</option>
        <option value="cloud">Cloud / Thought</option>
        <option value="spiky">Spiky / Shout</option>
      </select></label>
      <div className="shape-preset-grid" role="group" aria-label="Roundness presets">{['0', '20', '50', '70', 'MAX'].map(r => <button key={r} type="button" disabled={disabled} title={`Roundness ${r}%`}>{r}</button>)}</div>
      <div className="control-pair">
        <NativeNumber label="Padding (px)" value={text.padding} min={0} max={128} disabled={disabled} onValue={padding => change({ padding })} onCommit={commit} />
        <NativeNumber label="Outline width" value={style.stroke_width ?? 0} min={0} max={24} disabled={disabled} onValue={stroke_width => changeStyle({ stroke_width })} onCommit={commit} />
      </div>
      <div className="type-metrics">
        <TextColor label="Fill color" value="#ffffff" disabled={disabled} onValue={() => {}} onCommit={commit} />
        <TextColor label="Outline color" value={style.stroke_color ?? '#000000'} disabled={disabled} onValue={stroke_color => changeStyle({ stroke_color })} onCommit={commit} />
      </div>
    </div></details>

  </div>;
}

export function TypographyLayerList({ session, dialogues, selected, onSelect, onLayer, disabled }: { session: TypographySession; dialogues: Dialogue[]; selected: string | null; onSelect: (id: string) => void; onLayer?: (id: string, patch: LayerPatch) => void; disabled?: boolean }) {
  const live = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const ordered = onLayer ? [...dialogues].reverse() : dialogues;
  return <div className="typography-layer-list">{ordered.map((saved, row) => {
    const text = live.drafts[saved.id] ?? saved;
    const index = onLayer ? dialogues.length - 1 - row : row;
    const label = `Dialogue ${index + 1}`;
    return <div key={text.id} className={selected === text.id ? 'selected' : ''}>
      <input type="checkbox" aria-label={`${label} export visibility`} checked={text.visible} disabled={disabled || (!onLayer && text.locked)} onChange={event => {
        const visible = event.target.checked;
        if (onLayer) onLayer(text.id, { visible });
        else { session.edit(text.id, { visible }); void session.flush().catch(() => {}); }
      }} />
      <button onClick={() => onSelect(text.id)}>{label} · {text.text || 'empty text'}</button>
      {onLayer && <div className="layer-order-actions">
        <button aria-label={`${text.locked ? 'Unlock' : 'Lock'} ${label}`} aria-pressed={Boolean(text.locked)} disabled={disabled} onClick={() => onLayer(text.id, { locked: !text.locked })}>{text.locked ? 'Unlock' : 'Lock'}</button>
        <button aria-label={`Bring ${label} forward`} disabled={disabled || text.locked || row === 0} onClick={() => onLayer(text.id, { move: 'up' })}>↑</button>
        <button aria-label={`Send ${label} backward`} disabled={disabled || text.locked || row === ordered.length - 1} onClick={() => onLayer(text.id, { move: 'down' })}>↓</button>
      </div>}
    </div>;
  })}</div>;
}

export function TypographyExportNotice({ session, count }: { session: TypographySession; count: number }) {
  const live = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const warnings = Object.values(live.layers).flatMap(layer => layer.warnings);
  const errors = Object.values(live.errors);
  return <div className="typography-export-notice"><p>{count} editable text layer(s). Export includes visible saved layers; workspace visibility switches affect preview only.</p>{[...new Set([...warnings, ...errors])].map((warning, index) => <p className="warning-note" key={index}>{warning}</p>)}</div>;
}

export function TypographyCardControls({ session, dialogues, bubbleId, selected, disabled, onTarget }: { session: TypographySession; dialogues: Dialogue[]; bubbleId: string; selected: string | null; disabled: boolean; onTarget: (id: string) => void }) {
  const getCardSnapshot = useMemo(() => {
    let previous: { text: Dialogue | null; layer: TypographyRender | undefined; pending: boolean; error: string | undefined } | undefined;
    return () => {
      const live = session.getSnapshot();
      const text = cardDialogue(dialogues.map(item => live.drafts[item.id] ?? item), bubbleId, selected);
      const layer = text ? live.layers[text.id] : undefined;
      const pending = Boolean(text && (live.loading[text.id] || live.drafts[text.id]));
      const error = text ? live.errors[text.id] : undefined;
      if (previous && previous.text === text && previous.layer === layer && previous.pending === pending && previous.error === error) return previous;
      previous = { text, layer, pending, error };
      return previous;
    };
  }, [session, dialogues, bubbleId, selected]);
  const { text, layer, pending, error } = useSyncExternalStore(session.subscribe, getCardSnapshot);
  const unavailable = disabled || !text || !text.visible;
  const reason = !text ? 'Select a linked dialogue on the canvas or Layers first; no layer is chosen for ambiguous candidates.' : !text.visible ? 'This dialogue is hidden. Enable it in Layers first.' : `Dialogue ${String(dialogues.findIndex(item => item.id === text.id) + 1).padStart(2, '0')} · ${text.text.slice(0, 40) || 'empty text'}. Font size is in native pixels. ${text.auto_fit ? 'Auto Fit may reduce the actual size to fit the bubble.' : 'Auto Fit is off.'}`;
  const change = (delta: number) => {
    if (unavailable || !text) return;
    onTarget(text.id);
    void session.resizeFont(text.id, bubbleId, delta).catch(() => {});
  };
  return <div className="bubble-style-footer" title={reason} data-card-dialogue={text?.id}>
    <button disabled={unavailable || text!.size <= 8} aria-label={`Decrease font size for candidate ${bubbleId}`} onClick={() => change(-1)}>−</button>
    <span aria-live="polite">{text ? `${text.size} px${text.auto_fit ? ` · Fit ${pending || !layer ? '…' : layer.effectiveSize + ' px'}` : ''}` : '— px'}</span>
    <button disabled={unavailable || text!.size >= 144} aria-label={`Increase font size for candidate ${bubbleId}`} onClick={() => change(1)}>+</button>
    <button disabled title="Stroke is planned">Stroke</button><button disabled title="Object locking is planned">Lock</button>
    {text && error && <span role="alert">Preview failed</span>}
  </div>;
}
