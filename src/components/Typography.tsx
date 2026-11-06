import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Api, Dialogue, FontEntry, TypographyRender } from '../api';
import { FontBrowser } from './FontBrowser';
import type { Point } from '../ui/viewport';
import { cardDialogue, fontSizePatch, type TypographySession } from '../ui/typography';
import { TextRegionOverlay } from './TextRegionOverlay';

export function TypographyOverlay(props: {
  session: TypographySession; dialogues: Dialogue[]; selected: string | null; visible: boolean;
  scale: number; offset: Point; width: number; height: number; imageWidth: number; imageHeight: number;
  enabled: boolean; showSelection: boolean; onSelect: (id: string) => void; onEdit: (id: string) => void;
  onGesture: (active: boolean) => void; onPointer: (point: Point) => void; onWheel: (event: WheelEvent) => void;
}) {
  const live = useSyncExternalStore(props.session.subscribe, props.session.getSnapshot);
  if (!props.visible) return null;
  const regions = props.dialogues.map(saved => live.drafts[saved.id] ?? saved).filter(text => text.visible).map(text => ({ id: text.id, text: text.text, rect: [Math.floor(text.x), Math.floor(text.y), Math.ceil(text.width), Math.ceil(text.height)] }));
  return <TextRegionOverlay typography regions={regions} images={live.layers} selected={props.selected} scale={props.scale} offset={props.offset} width={props.width} height={props.height} imageWidth={props.imageWidth} imageHeight={props.imageHeight} enabled={props.enabled} showSelection={props.showSelection} controller={props.session.interaction} onSelect={props.onSelect} onEdit={text => props.onEdit(text.id)} onCommit={(id, rect) => props.session.pose(id, rect)} onGesture={props.onGesture} onPointer={props.onPointer} onWheel={props.onWheel} />;
}

function NativeNumber({ label, value, min, max, disabled, onValue, onCommit, integer = true }: { label: string; value: number; min: number; max: number; disabled: boolean; onValue: (value: number) => void; onCommit: () => void; integer?: boolean }) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const valid = draft.trim() !== '' && Number.isFinite(Number(draft)) && (!integer || Number.isInteger(Number(draft))) && Number(draft) >= min && Number(draft) <= max;
  useEffect(() => { if (!focused.current) setDraft(String(value)); }, [value]);
  return <label>{label}<input aria-label={label} type="number" min={min} max={max} step={integer ? 1 : 'any'} value={draft} disabled={disabled} aria-invalid={!valid} onFocus={() => { focused.current = true; }} onChange={event => { const raw = event.target.value; setDraft(raw); const number = Number(raw); if (raw.trim() && Number.isFinite(number) && (!integer || Number.isInteger(number)) && number >= min && number <= max) onValue(number); }} onBlur={() => { focused.current = false; if (!valid) setDraft(String(value)); onCommit(); }} /></label>;
}

function TextColor({ value, disabled, onValue, onCommit }: { value: string; disabled: boolean; onValue: (value: string) => void; onCommit: () => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = /^#[0-9a-f]{6}$/i.test(draft);
  return <label>Text color<div className="control-pair"><input aria-label="Typography text color" type="color" value={value} disabled={disabled} onChange={event => onValue(event.target.value)} onBlur={onCommit} /><input aria-label="Typography color hex" value={draft} maxLength={7} disabled={disabled} aria-invalid={!valid} onChange={event => { const next = event.target.value; setDraft(next); if (/^#[0-9a-f]{6}$/i.test(next)) onValue(next); }} onBlur={() => { if (!valid) setDraft(value); onCommit(); }} /></div></label>;
}

export function TypographyControls({ api, session, selected, disabled, onDelete, sourceControls }: { api: Api | null; session: TypographySession; selected: Dialogue | null; disabled: boolean; onCreate: () => void; onDelete: (id: string) => void; sourceControls: React.ReactNode }) {
  const live = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [fonts, setFonts] = useState<FontEntry[]>([]);
  const [fontError, setFontError] = useState('');
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
  const text = selected ? live.drafts[selected.id] ?? selected : null;
  const commit = () => { void session.flush().catch(() => {}); };
  const change = (patch: Partial<Dialogue>, immediate = false) => { if (text) { session.edit(text.id, patch); if (immediate) commit(); } };
  const bumpSize=(delta:number)=>{if(!text)return;const current=session.getSnapshot().drafts[text.id] ?? text;session.edit(text.id,fontSizePatch(current,current.size+delta));commit();};
  const supportsBold=Boolean(text && fonts.find(font=>font.family===text.family)?.weights.includes(700));
  const layer = text ? live.layers[text.id] : null;
  return <div className="typography-properties" data-typography-inspector="true"><h3>Indonesian dialogue / Typography</h3>
    {fontError && <p role="alert" className="warning-note">{fontError}</p>}
    {text ? <div key={text.id} className="typography-fields"><div className="control-pair"><button disabled={disabled} onClick={() => session.copyStyle(text.id)}>Copy Style</button><button disabled={disabled || !live.copiedStyle} onClick={() => { void session.pasteStyle(text.id).catch(() => {}); }}>Paste Style</button></div><label>Indonesian<textarea id="typography-text" aria-label="Typeset dialogue text" maxLength={4000} value={text.text} disabled={disabled} onChange={event => change({ text: event.target.value })} onBlur={commit} /></label>
      <FontBrowser fonts={fonts} value={text.family} disabled={disabled} onSelect={family => change({ family }, true)} />
      <div className="control-pair"><div className="size-stepper"><button type="button" disabled={disabled || text.size<=8} aria-label="Decrease requested font size" title="Decrease requested size; Auto Fit may use a smaller actual size" onClick={()=>bumpSize(-1)}>−</button><NativeNumber label="Font size (native px)" value={text.size} min={8} max={144} disabled={disabled} onValue={size => change(fontSizePatch(text, size))} onCommit={commit} /><button type="button" disabled={disabled || text.size>=144} aria-label="Increase requested font size" title="Increase requested size; Auto Fit may use a smaller actual size" onClick={()=>bumpSize(1)}>+</button></div><label>Weight<select aria-label="Typography weight" value={text.weight} disabled={disabled} onChange={event => change({ weight: Number(event.target.value) }, true)}>{![400, 700].includes(text.weight) && <option value={text.weight}>{text.weight} · requested</option>}<option value={400}>Regular · 400</option><option value={700}>Bold · 700</option></select></label></div>
      <button type="button" aria-label="Bold text" aria-pressed={text.weight>=600} disabled={disabled || (!supportsBold && text.weight<600)} title={supportsBold ? 'Bold' : 'This family has no available Bold 700 face'} onClick={()=>change({weight:text.weight>=600?400:700},true)}>Bold</button>
      <div className="control-pair"><label>Alignment<select aria-label="Typography alignment" value={text.alignment} disabled={disabled} onChange={event => change({ alignment: event.target.value as Dialogue['alignment'] }, true)}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label><TextColor value={text.color} disabled={disabled} onValue={color => change({ color })} onCommit={commit} /></div>
      <label className="layer-control"><input aria-label="Auto Fit to Bubble" type="checkbox" checked={text.auto_fit} disabled={disabled} onChange={event => change({ auto_fit: event.target.checked }, true)} />Auto Fit to Bubble / Box</label>
      <details><summary>Advanced layout &amp; position</summary><div className="control-pair"><NativeNumber label="Safe padding (native px)" value={text.padding} min={0} max={512} disabled={disabled} onValue={padding => change({ padding })} onCommit={commit} /><NativeNumber label="Minimum font size" value={text.minimum_size} min={8} max={Math.min(48, text.size)} disabled={disabled} onValue={minimum_size => change({ minimum_size })} onCommit={commit} /></div>
      <div className="control-pair"><NativeNumber integer={false} label="Dialogue X" value={text.x} min={0} max={20000} disabled={disabled} onValue={x => change({ x })} onCommit={commit} /><NativeNumber integer={false} label="Dialogue Y" value={text.y} min={0} max={2000000} disabled={disabled} onValue={y => change({ y })} onCommit={commit} /></div>
      <div className="control-pair"><NativeNumber integer={false} label="Dialogue width" value={text.width} min={1} max={20000} disabled={disabled} onValue={width => change({ width })} onCommit={commit} /><NativeNumber integer={false} label="Dialogue height" value={text.height} min={1} max={2000000} disabled={disabled} onValue={height => change({ height })} onCommit={commit} /></div>
      {text.bubble_id && <button disabled={disabled} onClick={() => change({ bubble_id: null }, true)}>Detach bubble constraint</button>}
      </details>{live.loading[text.id] && <p role="status">Rendering text…</p>}
      {layer && <p className="section-note">Actual: {layer.resolvedFamily} · {layer.resolvedWeight} · {layer.effectiveSize} native px</p>}
      {layer?.warnings.map((warning, index) => <p key={index} className="warning-note" role="status">{warning}</p>)}
      {live.errors[text.id] && <p role="alert" className="warning-note">{live.errors[text.id]}</p>}
      <button className="studio-action" disabled={disabled} onClick={() => onDelete(text.id)}>Delete text layer</button>
    </div> : <p className="section-note">Select a dialogue on Editing Canvas, or draw a box with T. Double-click a dialogue to edit its text here.</p>}
    {sourceControls}
  </div>;
}

export function TypographyLayerList({ session, dialogues, selected, onSelect }: { session: TypographySession; dialogues: Dialogue[]; selected: string | null; onSelect: (id: string) => void }) {
  const live = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <div className="typography-layer-list">{dialogues.map((saved, index) => { const text = live.drafts[saved.id] ?? saved; return <div key={text.id} className={selected === text.id ? 'selected' : ''}><input type="checkbox" aria-label={`Dialogue ${index+1} export visibility`} checked={text.visible} onChange={event => { session.edit(text.id, { visible: event.target.checked }); void session.flush().catch(() => {}); }} /><button onClick={() => onSelect(text.id)}>Dialogue {String(index+1).padStart(2, '0')} · {text.text || 'empty text'}</button></div>; })}</div>;
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
