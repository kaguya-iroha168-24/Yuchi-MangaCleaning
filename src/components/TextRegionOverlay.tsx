import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { TypographyRender } from '../api';
import type { Point } from '../ui/viewport';
import { editRegion, RegionInteraction, type RegionHandle, type RegionRect } from '../ui/regionEditing';

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Gesture = { id: string; rect: number[]; handle: RegionHandle; start: Point; pointer: number; element: HTMLElement; moved: boolean };
type RegionObject = { id: string; rect: number[]; text: string; number?: number; locked?: boolean; bubbleBound?: boolean };

export const TextRegionOverlay = memo(function TextRegionOverlay(props: {
  regions: RegionObject[]; selected: string | null; scale: number; offset: Point; width: number; height: number; imageWidth: number; imageHeight: number;
  enabled: boolean; showSelection: boolean; controller: RegionInteraction;
  onSelect: (id: string) => void; onEdit: (region: RegionObject) => void;
  onCommit: (id: string, rect: RegionRect) => Promise<void>; onGesture: (active: boolean) => void;
  onPointer: (point: Point) => void; onWheel: (event: WheelEvent) => void;
  candidate?: boolean; reviewIds?: Set<string>; selectedIds?: Set<string>; onMultiSelect?: (id: string, multi: boolean) => void; typography?: boolean; images?: Record<string, TypographyRender>; showCovers?: boolean;
  showHighlight?: boolean; selectionOnly?: boolean; numberedText?: boolean;
}) {
  const draft = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot);
  const gesture = useRef<Gesture | null>(null);
  const surface = useRef<HTMLDivElement>(null);
  const wheel = useRef(props.onWheel); wheel.current = props.onWheel;
  useEffect(() => { const node = surface.current; if (!node) return; const listener = (event: WheelEvent) => wheel.current(event); node.addEventListener('wheel', listener, { passive: false }); return () => node.removeEventListener('wheel', listener); }, []);
  const cancelRef = useRef<() => void>(() => {});
  const cancel = () => {
    const current = gesture.current;
    if (!current) return;
    gesture.current = null;
    if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
    props.controller.flush(null); props.onGesture(false);
  };
  cancelRef.current = cancel;
  useEffect(() => { const reset = () => cancelRef.current(); window.addEventListener('blur', reset); return () => { window.removeEventListener('blur', reset); reset(); }; }, []);
  useEffect(() => { if (!props.enabled) cancelRef.current(); }, [props.enabled]);
  const begin = (event: React.PointerEvent<HTMLElement>, region: RegionObject, handle: RegionHandle) => {
    if (!props.enabled || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    if (props.candidate && (event.ctrlKey || event.metaKey)) { props.onMultiSelect?.(region.id, true); return; }
    if (props.selectionOnly) { event.currentTarget.focus({ preventScroll: true }); props.onSelect(region.id); return; }
    if (props.selected !== region.id) props.onSelect(region.id);
    event.currentTarget.focus({ preventScroll: true });
    if (region.locked) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { id: region.id, rect: [...region.rect], handle, start: { x: event.clientX, y: event.clientY }, pointer: event.pointerId, element: event.currentTarget, moved: false };
    props.onGesture(true);
  };
  const position = (event: React.PointerEvent): RegionRect | null => {
    const current = gesture.current; if (!current || current.pointer !== event.pointerId) return null;
    const delta = { x: event.clientX - current.start.x, y: event.clientY - current.start.y };
    current.moved ||= Math.hypot(delta.x, delta.y) >= 3;
    return editRegion(current.rect, current.handle, { x: delta.x / props.scale, y: delta.y / props.scale }, { width: props.imageWidth, height: props.imageHeight });
  };
  return <div ref={surface} className="text-region-overlays">
    {props.regions.map((region, index) => {
      const rect = draft?.id === region.id ? draft.rect : region.rect;
      const [x, y, width, height] = rect;
      const left = props.offset.x + x * props.scale, top = props.offset.y + y * props.scale;
      const w = width * props.scale, h = height * props.scale;
      const raster = props.images?.[region.id];
      const cover = props.showCovers && raster?.coverPng ? raster.coverRect : null;
      const anchor = props.showCovers ? raster?.overlayOrigin : null;
      const showInk = raster && (!props.showCovers || !region.bubbleBound || anchor);
      const intersects = (a: number, b: number, c: number, d: number) => a + c >= 0 && b + d >= 0 && a <= props.width && b <= props.height;
      if (!intersects(left, top, w, h) && !(cover && intersects(props.offset.x + cover[0] * props.scale, props.offset.y + cover[1] * props.scale, cover[2] * props.scale, cover[3] * props.scale))) return null;
      const active = (props.selectedIds ? props.selectedIds.has(region.id) : region.id === props.selected) && (props.showHighlight ?? props.showSelection);
      return <div key={region.id} data-text-region={props.typography ? undefined : region.id} data-dialogue={props.typography ? region.id : undefined} role="button" aria-label={`${props.candidate ? 'Bubble' : props.typography ? 'Dialogue' : 'Text region'} ${String(region.number ?? index + 1).padStart(2, '0')}: ${region.text || 'empty text'}`} aria-pressed={active} tabIndex={props.enabled ? 0 : -1}
        className={`text-region-box ${props.typography ? 'typography-region-box' : ''} ${props.candidate ? 'candidate-region-box' : ''} ${props.numberedText ? 'source-detection-box' : ''} ${props.reviewIds?.has(region.id) ? 'needs-review' : ''} ${active ? 'is-selected' : ''}`} style={{ left, top, width: w, height: h, pointerEvents: props.enabled ? 'auto' : 'none', zIndex: props.candidate && active && props.showSelection ? 2 : undefined }}
        onPointerDown={event => begin(event, region, 'move')}
        onPointerMove={event => { const next = position(event); if (next && gesture.current?.moved) props.controller.update({ id: region.id, rect: next }); const bounds = event.currentTarget.getBoundingClientRect(); const native = { x: x + (event.clientX - bounds.left) / props.scale, y: y + (event.clientY - bounds.top) / props.scale }; if (!gesture.current) props.onPointer(native); }}
        onPointerUp={event => {
          const current = gesture.current, next = position(event);
          if (!current) return;
          gesture.current = null;
          if (current.element.hasPointerCapture(current.pointer)) current.element.releasePointerCapture(current.pointer);
          if (current.moved && next && next.some((value, i) => value !== current.rect[i])) {
            props.controller.flush({ id: current.id, rect: next });
            void props.onCommit(current.id, next).catch(() => {}).finally(() => { props.controller.flush(null); props.onGesture(false); });
          } else { props.controller.flush(null); props.onGesture(false); }
        }}
        onPointerCancel={cancel} onLostPointerCapture={() => { if (gesture.current) cancel(); }}
        onDoubleClick={event => { if (props.enabled && !region.locked) { event.stopPropagation(); props.onEdit(region); } }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } if (event.key === 'Enter' && props.enabled) { event.preventDefault(); event.stopPropagation(); props.onSelect(region.id); if (!region.locked) props.onEdit(region); } }}>
        {props.candidate && <span className="candidate-number">{String(region.number ?? index+1).padStart(2,'0')}{props.reviewIds?.has(region.id) ? ' · Review' : ''}</span>}
        {props.numberedText && <span className="source-detection-number">T{String(index+1).padStart(2,'0')}</span>}
        {cover && raster?.coverPng && <img className="typography-cover" src={`data:image/png;base64,${raster.coverPng}`} style={{ left: (cover[0] - x) * props.scale, top: (cover[1] - y) * props.scale, width: cover[2] * props.scale, height: cover[3] * props.scale }} draggable={false} alt="" />}
        {showInk && <img className="typography-raster" src={`data:image/png;base64,${raster.png}`} style={anchor ? {left:(anchor[0]-x)*props.scale, top:(anchor[1]-y)*props.scale, width:raster.width*props.scale, height:raster.height*props.scale} : undefined} draggable={false} alt="" />}
        {active && props.showSelection && !region.locked && handles.map(handle => <span key={handle} role="button" tabIndex={props.enabled ? 0 : -1} aria-label={`Resize ${props.candidate ? 'bubble' : props.typography ? 'dialogue' : 'text region'} ${handle}`} className={`text-region-handle handle-${handle}`} onPointerDown={event => begin(event, region, handle)} />)}
      </div>;
    })}
  </div>;
});
