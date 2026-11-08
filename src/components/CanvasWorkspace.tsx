import { bubbleAt, selectionLayer } from '../ui/selection';
import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Stage, Layer, Image as CanvasImage, Rect, Line, Group, Circle } from 'react-konva';
import type Konva from 'konva';
import { TextRegionOverlay } from './TextRegionOverlay';
import { TypographyOverlay } from './Typography';
import type { TypographySession } from '../ui/typography';
import type { RegionInteraction, RegionRect } from '../ui/regionEditing';
import { Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import type { Bubble, DetectionMode, TextRegion, Dialogue } from '../api';
import { ViewportController, fitScale, imageOffset, roundedImageRect, toImage, visibleImageRect, zoomAt, type Point, type ViewMode } from '../ui/viewport';

function useSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(1, entry.contentRect.width), height: Math.max(1, entry.contentRect.height) })); observer.observe(ref.current); return () => observer.disconnect(); }, [ref]);
  return size;
}

export function ViewportModeControls({ controller, disabled }: { controller: ViewportController; disabled: boolean }) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return <span className="view-mode-controls" aria-label="View Modes">{(['single', 'dual', 'onion'] as ViewMode[]).map(mode => <button key={mode} disabled={disabled} className={view.mode === mode ? 'active' : ''} aria-pressed={view.mode === mode} title={mode === 'single' ? 'Single Canvas' : mode === 'dual' ? 'Synchronized Dual Viewport' : 'Onion-Skin Comparison'} onClick={() => controller.update({ mode, peek: false })}>{mode === 'onion' ? 'Onion-Skin' : mode === 'single' ? 'Single' : 'Dual'}</button>)}</span>;
}

export function ViewportReadout({ controller }: { controller: ViewportController }) {
  const metrics = useSyncExternalStore(controller.subscribeMetrics, controller.getMetrics);
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  return <><span>{Math.round(metrics.scale * 100)}%</span><span className="coordinate-status">{pointer ? `X: ${Math.round(pointer.point.x)} Y: ${Math.round(pointer.point.y)}` : 'X: — Y: —'}</span></>;
}

export function ViewportZoomControls({ controller }: { controller: ViewportController }) {
  const { scale } = useSyncExternalStore(controller.subscribeMetrics, controller.getMetrics);
  return <div className="canvas-controls" aria-label="Canvas zoom">
    <button id="canvas-zoom-out" className="chrome-button" title="Zoom out" aria-label="Zoom out" onClick={() => controller.zoomBy(1 / 1.2)}><ZoomOut size={15} /></button>
    <label className="zoom-value"><input aria-label="Canvas zoom percent" type="number" min="1" max="1200" value={Math.round(scale * 100)} onChange={event => { const value = Number(event.target.value); if (value >= 1 && value <= 1200) controller.actualScale(value / 100); }} />%</label>
    <button className="chrome-button" title="Zoom in" aria-label="Zoom in" onClick={() => controller.zoomBy(1.2)}><ZoomIn size={15} /></button>
    <button aria-label="Fit Page" title="Fit Page" onClick={() => controller.fit('page')}><Maximize size={14} /></button>
    <button onClick={() => controller.fit('width')}>Fit Width</button>
    <button onClick={() => controller.fit('actual')}>100%</button>
  </div>;
}

function Ruler({ axis, length, scale, offset, limit, controller }: { axis: 'x' | 'y'; length: number; scale: number; offset: number; limit: number; controller: ViewportController }) {
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const step = [10, 25, 50, 100, 250, 500, 1000, 2500].find(value => value * scale >= 45) ?? 5000;
  const first = Math.max(0, Math.ceil(-offset / scale / step) * step);
  const ticks: number[] = [];
  for (let value = first; value <= Math.min(limit, (length - offset) / scale); value += step) ticks.push(value);
  const position = pointer ? pointer.point[axis] * scale + offset : -1;
  return <svg className={`image-ruler ruler-${axis}`} width={axis === 'x' ? length : 20} height={axis === 'y' ? length : 20} aria-label={`${axis.toUpperCase()} ruler in native image pixels`}>
    {ticks.map(value => { const at = value * scale + offset; return <g key={value}>{axis === 'x' ? <><line x1={at} x2={at} y1={12} y2={20} /><text x={at + 3} y={9}>{value}</text></> : <><line x1={12} x2={20} y1={at} y2={at} /><text x={3} y={at - 3} transform={`rotate(-90 3 ${at - 3})`}>{value}</text></>}</g>; })}
    {position >= 0 && position <= length && (axis === 'x' ? <line className="ruler-pointer" x1={position} x2={position} y1={0} y2={20} /> : <line className="ruler-pointer" x1={0} x2={20} y1={position} y2={position} />)}
  </svg>;
}

type PaneProps = {
  activeLayer: 'bubble' | 'source' | 'dialogue' | null;
  title: string; source: 'original' | 'editing'; image: HTMLImageElement | null; comparison: HTMLImageElement | null; mask: HTMLImageElement | null; containers: HTMLImageElement | null;
  width: number; height: number; scale: number; controller: ViewportController; bubbles: Bubble[]; textRegions: TextRegion[]; selected: Set<string>; selectedTextId: string | null;
  tool: 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase'; brushRadius: number; showRulers: boolean; showBoxes: boolean; showMask: boolean; onion: boolean;
  detectionMode: DetectionMode; interaction: RegionInteraction; editable: boolean; showRegions: boolean; showSelection: boolean;
  onCommitBubble: (id: string, rect: RegionRect) => Promise<void>; onDeselect: () => void; onEditText: (region: TextRegion) => void; onCommitRegion: (id: string, rect: RegionRect) => Promise<void>; onGesture: (active: boolean) => void;
  onBubble: (id: string, multi: boolean) => void; onText: (id: string) => void; onRect: (rect: [number, number, number, number]) => void; onBrush?: (points: Point[]) => void; onEscape: () => void;
  typography: { session: TypographySession; dialogues: Dialogue[]; selected: string | null; visible: boolean; coverText?: boolean; onSelect: (id: string) => void; onEdit: (id: string) => void };
};

const CanvasPane = memo(function CanvasPane(props: PaneProps) {
  const host = useRef<HTMLDivElement>(null);
  const size = useSize(host);
  const stage = useRef<Konva.Stage>(null);
  const view = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot);
  const drag = useRef<{ point: Point; pan: Point } | null>(null);
  const rightDrag = useRef<{ pointer: number; point: Point; pan: Point } | null>(null);
  const selectionStart = useRef<Point | null>(null);
  const brushPoints = useRef<Point[]>([]);
  const brushCursor = useRef<Konva.Circle>(null);
  const [brushDraft, setBrushDraft] = useState<Point[]>([]);
  const [draft, setDraft] = useState<[number, number, number, number] | null>(null);
  const scale = props.scale;
  const maskMode=props.tool.startsWith('mask-');
  const brushEnabled = maskMode && props.onBrush && props.editable && !view.peek;
  const textMode = props.detectionMode === 'text';
  const showTextBoxes = textMode && props.showBoxes && (props.source === 'original' || view.mode !== 'dual');
  const selectedBubble=[...props.selected][0] ?? null;
  const layer=selectionLayer({editing:props.source==='editing',mask:maskMode,dialogue:props.activeLayer==='dialogue'?props.typography.selected:null,text:props.activeLayer==='source'?props.selectedTextId:null,bubble:props.activeLayer==='bubble'?selectedBubble:null});
  const offset = imageOffset(size, props, view.pan, scale);
  const native = (): Point | null => { const point = stage.current?.getPointerPosition(); return point ? toImage(point, offset, scale, props.width, props.height) : null; };
  const resetGesture = () => { drag.current = null; selectionStart.current = null; brushPoints.current = []; setBrushDraft([]); setDraft(null); };
  const release = (pointerId: number) => { const content = stage.current?.getContent(); if (content?.hasPointerCapture(pointerId)) content.releasePointerCapture(pointerId); };
  const panTo = (start: { point: Point; pan: Point }, event: PointerEvent) => {
    props.controller.update({ pan: { x: start.pan.x - (event.clientX - start.point.x) / scale, y: start.pan.y - (event.clientY - start.point.y) / scale } });
  };
  const stopRightDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (rightDrag.current?.pointer !== event.pointerId) return;
    event.stopPropagation();
    rightDrag.current = null;
    delete event.currentTarget.dataset.rightPanning;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const raw = view.peek && props.source === 'editing' ? props.comparison : props.image;
  const cut = Math.max(0, Math.min(props.width, (size.width * view.split - offset.x) / scale));
  return <section className="canvas-pane"><div className="pane-caption"><span className="pane-indicator" />{view.peek && props.source === 'editing' ? 'ORIGINAL · QUICK PEEK' : props.title}<span className="pane-dimensions">{props.width} × {props.height}</span></div>
    <div className={props.showRulers ? "ruler-grid" : "ruler-grid rulers-hidden"}>{props.showRulers && <><div className="ruler-origin">px</div><Ruler axis="x" length={size.width} scale={scale} offset={offset.x} limit={props.width} controller={props.controller} /><Ruler axis="y" length={size.height} scale={scale} offset={offset.y} limit={props.height} controller={props.controller} /></>}
      <div className="stage-host" ref={host} tabIndex={0} data-viewport="true" aria-label={`${props.title} canvas. Right-drag to pan. Hold Tab to peek original. Escape leaves canvas.`}
        onPointerDownCapture={event => {
          if (event.button !== 2 || drag.current || selectionStart.current || brushPoints.current.length) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          rightDrag.current = { pointer: event.pointerId, point: { x: event.clientX, y: event.clientY }, pan: props.controller.getSnapshot().pan };
          event.currentTarget.dataset.rightPanning = 'true';
        }}
        onPointerMoveCapture={event => {
          const start = rightDrag.current;
          if (start?.pointer !== event.pointerId) return;
          if ((event.buttons & 2) === 0) { stopRightDrag(event); return; }
          event.stopPropagation();
          panTo(start, event.nativeEvent);
        }}
        onPointerUpCapture={stopRightDrag}
        onPointerCancelCapture={stopRightDrag}
        onLostPointerCapture={event => { if (event.target === event.currentTarget) stopRightDrag(event); }}
        onContextMenu={event => event.preventDefault()}
        onKeyDown={event => { if (event.key === 'Tab' && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); props.controller.update({ peek: true }); } if (event.key === 'Escape') { props.controller.update({ peek: false }); props.onEscape(); } }}
        onKeyUp={event => { if (event.key === 'Tab') { event.preventDefault(); props.controller.update({ peek: false }); } }}
        onBlur={() => { if (props.controller.getSnapshot().peek) props.controller.update({ peek: false }); }}>
        <Stage ref={stage} width={size.width} height={size.height} scaleX={scale} scaleY={scale} x={offset.x} y={offset.y}
          onWheel={event => { event.evt.preventDefault(); const point = stage.current?.getPointerPosition() ?? { x: size.width / 2, y: size.height / 2 }; props.controller.update(zoomAt(view, event.evt.deltaY < 0 ? 1.11 : .9, point, size, props, scale)); }}
          onPointerDown={event => {
            if (event.evt.button !== 0 && event.evt.button !== 1) return;
            host.current?.focus({ preventScroll: true });
            stage.current?.getContent().setPointerCapture(event.evt.pointerId);
            const point = native(); if (!point) return;
            props.controller.updatePointer({ point, source: props.source });
            if (brushEnabled && event.evt.button === 0) { brushPoints.current = [point]; setBrushDraft([point]); }
            else if (props.tool === 'pan' || event.evt.button === 1 || event.evt.shiftKey && props.tool !== 'manual' && props.tool !== 'text') drag.current = { point: { x: event.evt.clientX, y: event.evt.clientY }, pan: view.pan };
            else if (props.tool === 'select' && props.editable && event.target === event.target.getStage()) {
              const screen = stage.current?.getPointerPosition();
              const hit = !textMode && screen && bubbleAt(props.bubbles, { x: (screen.x - offset.x) / scale, y: (screen.y - offset.y) / scale });
              if (hit) props.onBubble(hit.id, Boolean(event.evt.ctrlKey || event.evt.metaKey));
              else props.onDeselect();
            }
            else if (props.tool === 'manual' || props.tool === 'text') { selectionStart.current = point; setDraft([point.x, point.y, 0, 0]); }
          }}
          onPointerMove={event => {
            const point = native(); if (point) props.controller.updatePointer({ point, source: props.source });
            if (point) brushCursor.current?.position(point);
            brushCursor.current?.visible(Boolean(point));
            if (brushPoints.current.length && point) { if (brushPoints.current.length < 2000) { brushPoints.current.push(point); setBrushDraft([...brushPoints.current]); } }
            else if (drag.current) panTo(drag.current, event.evt);
            else if (selectionStart.current && point) setDraft([Math.min(point.x, selectionStart.current.x), Math.min(point.y, selectionStart.current.y), Math.abs(point.x - selectionStart.current.x), Math.abs(point.y - selectionStart.current.y)]);
          }}
          onPointerUp={event => { const points = brushPoints.current; const rect = draft ? roundedImageRect(draft, props.width, props.height) : null; resetGesture(); if (points.length) props.onBrush?.(points); if (rect && rect[2] >= 8 && rect[3] >= 8) props.onRect(rect); release(event.evt.pointerId); }}
          onPointerCancel={event => { resetGesture(); release(event.evt.pointerId); }}
          onPointerLeave={() => brushCursor.current?.hide()}
          onLostPointerCapture={resetGesture}>
          <Layer listening={false}>
            {props.onion && !view.peek ? <>{props.comparison && <CanvasImage image={props.comparison} width={props.width} height={props.height} />}<Group clipX={cut} clipY={0} clipWidth={props.width - cut} clipHeight={props.height}>{props.image && <CanvasImage image={props.image} width={props.width} height={props.height} />}</Group></> : raw && <CanvasImage image={raw} width={props.width} height={props.height} />}
            
            {brushDraft.length > 0 && <Line points={brushDraft.flatMap(point => [point.x, point.y])} stroke={props.tool === 'mask-erase' ? '#e89a90' : '#a8dfca'} strokeWidth={props.brushRadius * 2} lineCap="round" lineJoin="round" opacity={.7} />}
            {props.showMask && props.mask && <CanvasImage image={props.mask} width={props.width} height={props.height} />}
          </Layer>
          {brushEnabled && <Layer listening={false}><Circle ref={brushCursor} visible={false} radius={props.brushRadius} stroke="#E63946" strokeWidth={2 / scale} /></Layer>}
          {draft && <Layer listening={false}><Rect x={draft[0]} y={draft[1]} width={draft[2]} height={draft[3]} stroke="#B52837" strokeWidth={2 / scale} dash={[7 / scale, 4 / scale]} fill="rgba(230,57,70,.12)" /></Layer>}
        </Stage>
        {!textMode && (props.showBoxes || selectedBubble) && !maskMode && (props.source==='original' || view.mode!=='dual' || layer==='bubble') && <TextRegionOverlay showHighlight={props.showSelection} selectionOnly={props.source==='original'} candidate regions={props.bubbles.filter(b=>(props.showBoxes && (props.source==='original' || view.mode!=='dual')) || b.id===selectedBubble).map(b => ({ id:b.id, rect:b.rect as RegionRect, text:'', number:props.bubbles.indexOf(b)+1 }))} reviewIds={new Set(props.bubbles.filter(b => b.confidence != null && b.confidence < .25).map(b => b.id))} selected={[...props.selected][0] ?? null} scale={scale} offset={offset} width={size.width} height={size.height} imageWidth={props.width} imageHeight={props.height} enabled={props.editable && props.tool === 'select'} showSelection={props.showSelection && layer==='bubble'} controller={props.interaction} onSelect={id => props.onBubble(id,false)} onMultiSelect={props.onBubble} onEdit={() => {}} onCommit={props.onCommitBubble} onGesture={props.onGesture} onPointer={point => props.controller.updatePointer({point,source:props.source})} onWheel={event => {event.preventDefault();const bounds=host.current?.getBoundingClientRect();if(bounds) props.controller.update(zoomAt(view,event.deltaY<0?1.11:.9,{x:event.clientX-bounds.left,y:event.clientY-bounds.top},size,props,scale));}} />}
        {props.showRegions && !maskMode && (showTextBoxes || props.source==='editing' && props.activeLayer==='source') && <TextRegionOverlay
          numberedText={showTextBoxes} selectionOnly={props.source==='original'}
          showHighlight={props.showSelection && props.activeLayer==='source'}
          regions={showTextBoxes ? props.textRegions.filter(region => region.origin === 'automatic_text_detection' || region.origin === 'manual' || region.id === props.selectedTextId) : props.textRegions.filter(region => region.id === props.selectedTextId)} selected={props.selectedTextId} scale={scale} offset={offset} width={size.width} height={size.height} imageWidth={props.width} imageHeight={props.height} enabled={props.editable && props.tool === 'select'} showSelection={props.showSelection && layer==='source'} controller={props.interaction} onSelect={props.onText} onEdit={region => { const text = props.textRegions.find(item => item.id === region.id); if (text) props.onEditText(text); }} onCommit={props.onCommitRegion} onGesture={props.onGesture} onPointer={point => props.controller.updatePointer({ point, source: props.source })} onWheel={event => { event.preventDefault(); const bounds = host.current?.getBoundingClientRect(); if (bounds) props.controller.update(zoomAt(view, event.deltaY < 0 ? 1.11 : .9, { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, size, props, scale)); }} />}
        {props.source === 'editing' && !view.peek && <div className="typography-overlay-clip" style={{ clipPath: props.onion ? `inset(0 0 0 ${view.split*100}%)` : undefined }}><TypographyOverlay {...props.typography} scale={scale} offset={offset} width={size.width} height={size.height} imageWidth={props.width} imageHeight={props.height} enabled={props.editable && props.tool === 'select'} showSelection={props.showSelection && layer==='dialogue'} onGesture={props.onGesture} onPointer={point => props.controller.updatePointer({ point, source: props.source })} onWheel={event => { event.preventDefault(); const bounds = host.current?.getBoundingClientRect(); if (bounds) props.controller.update(zoomAt(view, event.deltaY < 0 ? 1.11 : .9, { x: event.clientX-bounds.left, y: event.clientY-bounds.top }, size, props, scale)); }} /></div>}
        {props.onion && <div className="onion-divider" role="slider" aria-label="Drag comparison divider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(view.split * 100)} tabIndex={0} style={{ left: `${view.split * 100}%` }}
          onPointerDown={event => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) { const bounds = host.current?.getBoundingClientRect(); if (bounds) props.controller.update({ split: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) }); } }}
          onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)}
          onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); props.controller.update({ split: Math.max(0, Math.min(1, view.split + (event.key === 'ArrowRight' ? .02 : -.02))) }); } }}><span>Original</span><span>Editing</span></div>}
        <div className="canvas-corner">{Math.round(scale * 100)}%</div>
      </div>
    </div>
  </section>;
});

export function CanvasWorkspace(props: {
  activeLayer: PaneProps['activeLayer']; controller: ViewportController; original: HTMLImageElement | null; working: HTMLImageElement | null; containers: HTMLImageElement | null; mask: HTMLImageElement | null;
  width: number; height: number; name: string; bubbles: Bubble[]; textRegions: TextRegion[]; selected: Set<string>; selectedTextId: string | null; tool: PaneProps['tool']; brushRadius: number; showRulers: boolean; showBoxes: boolean; showMask: boolean; showOriginal: boolean; showWorking: boolean;
  onCommitBubble: PaneProps['onCommitBubble']; onDeselect: () => void; detectionMode: DetectionMode; interaction: RegionInteraction; editable: boolean; showRegions: boolean; showSelection: boolean; onEditText: PaneProps['onEditText']; onCommitRegion: PaneProps['onCommitRegion']; onGesture: PaneProps['onGesture'];
  onBubble: PaneProps['onBubble']; onText: PaneProps['onText']; onRect: PaneProps['onRect']; onBrush: NonNullable<PaneProps['onBrush']>;
  typography: PaneProps['typography'];
}) {
  const host = useRef<HTMLDivElement>(null);
  const size = useSize(host);
  const view = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot);
  const rulerSize = props.showRulers ? 20 : 0;
  const area = { width: Math.max(1, (view.mode === 'dual' ? (size.width - 1) / 2 : size.width) - rulerSize), height: Math.max(1, size.height - 27 - rulerSize) };
  const scale = fitScale(area, props, view.fit, view.zoom);
  useEffect(() => { props.controller.updateMetrics({ ...area, imageWidth: props.width, imageHeight: props.height, scale }); }, [area.width, area.height, props.controller, props.width, props.height, scale]);
  useEffect(() => { const cancel = () => { if (props.controller.getSnapshot().peek) props.controller.update({ peek: false }); }; window.addEventListener('blur', cancel); return () => window.removeEventListener('blur', cancel); }, [props.controller]);
  const common = { detectionMode: props.detectionMode, activeLayer: props.activeLayer, onCommitBubble: props.onCommitBubble, onDeselect: props.onDeselect, typography: props.typography, interaction: props.interaction, editable: props.editable, showRegions: props.showRegions, showSelection: props.showSelection, onEditText: props.onEditText, onCommitRegion: props.onCommitRegion, onGesture: props.onGesture, controller: props.controller, width: props.width, height: props.height, scale, bubbles: props.bubbles, textRegions: props.textRegions, selected: props.selected, selectedTextId: props.selectedTextId, tool: props.tool, brushRadius: props.brushRadius, showRulers: props.showRulers, showBoxes: props.showBoxes, containers: props.containers, onBubble: props.onBubble, onText: props.onText, onRect: props.onRect, onEscape: () => document.getElementById('canvas-zoom-out')?.focus() };
  return <>
    {view.mode === 'onion' && <div className="onion-controls"><label>Onion-Skin Comparison<input aria-label="Onion-Skin divider" type="range" min="0" max="100" value={Math.round(view.split * 100)} onChange={event => props.controller.update({ split: Number(event.target.value) / 100 })} /></label><span>Original ← → Editing</span></div>}
    <div className={`dual-canvas viewport-panes mode-${view.mode}`} ref={host} role="region" aria-label={`Page canvas: ${props.name}`}>{view.mode === 'dual' && <CanvasPane {...common} title="ORIGINAL" source="original" image={props.showOriginal ? props.original : null} comparison={null} mask={null} showMask={false} onion={false} />}<CanvasPane {...common} title={view.mode === 'onion' ? 'ONION-SKIN COMPARISON' : 'EDITING'} source="editing" image={props.showWorking ? props.working : null} comparison={props.showOriginal ? props.original : null} mask={props.mask} showMask={props.showMask} onion={view.mode === 'onion'} onBrush={props.onBrush} /></div>
  </>;
}

export function MiniMap({ controller, image }: { controller: ViewportController; image: HTMLImageElement | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const metrics = useSyncExternalStore(controller.subscribeMetrics, controller.getMetrics);
  const width = 180, height = 92;
  const ratio = image ? Math.min(width / image.width, height / image.height) : 1;
  const imageWidth = image ? image.width * ratio : 0, imageHeight = image ? image.height * ratio : 0;
  const offset = { x: (width - imageWidth) / 2, y: (height - imageHeight) / 2 };
  useEffect(() => { const target = canvas.current; if (!target) return; const dpr = window.devicePixelRatio || 1; target.width = width * dpr; target.height = height * dpr; const context = target.getContext('2d'); if (!context) return; context.scale(dpr, dpr); context.clearRect(0, 0, width, height); if (!image) return; context.drawImage(image, offset.x, offset.y, imageWidth, imageHeight); const [x, y, w, h] = visibleImageRect(metrics, view.pan); context.strokeStyle = '#E63946'; context.lineWidth = 1.5; context.strokeRect(offset.x + x * ratio, offset.y + y * ratio, w * ratio, h * ratio); }, [image, imageWidth, imageHeight, metrics, offset.x, offset.y, ratio, view.pan]);
  const navigate = (event: React.PointerEvent<HTMLCanvasElement>) => { if (!image) return; const bounds = event.currentTarget.getBoundingClientRect(); const x = (event.clientX - bounds.left) * width / bounds.width, y = (event.clientY - bounds.top) * height / bounds.height; controller.update({ pan: { x: Math.max(0, Math.min(image.width, (x - offset.x) / ratio)) - image.width / 2, y: Math.max(0, Math.min(image.height, (y - offset.y) / ratio)) - image.height / 2 } }); };
  return <div className="mini-map"><div className="section-label">MINI-MAP</div><canvas ref={canvas} style={{ width, height }} aria-label="Mini-map: click or drag to pan the image" tabIndex={image ? 0 : -1} onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); navigate(event); }} onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) navigate(event); }} onPointerUp={event => event.currentTarget.releasePointerCapture(event.pointerId)} onKeyDown={event => { const directions: Record<string, Point> = { ArrowLeft: { x: -30, y: 0 }, ArrowRight: { x: 30, y: 0 }, ArrowUp: { x: 0, y: -30 }, ArrowDown: { x: 0, y: 30 } }; const delta = directions[event.key]; if (delta && image) { event.preventDefault(); controller.update({ pan: { x: view.pan.x + delta.x, y: view.pan.y + delta.y } }); } }} />{!image && <span>No source image</span>}</div>;
}

export function LoupePreview({ controller, original, working }: { controller: ViewportController; original: HTMLImageElement | null; working: HTMLImageElement | null }) {
  const pointer = useSyncExternalStore(controller.subscribePointer, controller.getPointer);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = pointer?.source === 'editing' ? working : original;
  useEffect(() => { const target = canvas.current; if (!target) return; const width = 180, height = 92, dpr = window.devicePixelRatio || 1; target.width = width * dpr; target.height = height * dpr; const context = target.getContext('2d'); if (!context) return; context.scale(dpr, dpr); context.clearRect(0, 0, width, height); if (!pointer || !image) return; context.imageSmoothingEnabled = false; context.drawImage(image, pointer.point.x - width / 8, pointer.point.y - height / 8, width / 4, height / 4, 0, 0, width, height); context.strokeStyle = '#E63946'; context.beginPath(); context.moveTo(width / 2 - 5, height / 2); context.lineTo(width / 2 + 5, height / 2); context.moveTo(width / 2, height / 2 - 5); context.lineTo(width / 2, height / 2 + 5); context.stroke(); }, [pointer, image]);
  return <div className="loupe-preview"><div className="section-label">MAGNIFIER LOUPE <span>400%</span></div><canvas ref={canvas} style={{ width: 180, height: 92 }} aria-label="400 percent source-pixel magnifier" /><small>{pointer ? `${pointer.source} · ${Math.round(pointer.point.x)}, ${Math.round(pointer.point.y)}` : 'Move pointer over a page'}</small></div>;
}
