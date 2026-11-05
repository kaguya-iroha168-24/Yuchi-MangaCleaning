import { memo, useEffect, useRef, useSyncExternalStore } from 'react';
import type { Point } from '../ui/viewport';
import { editRegion, RegionInteraction, type RegionHandle, type RegionRect } from '../ui/regionEditing';

const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Gesture = { id: string; rect: number[]; handle: RegionHandle; start: Point; pointer: number; element: HTMLElement; moved: boolean };
type RegionObject = { id: string; rect: number[]; text: string };

export const TextRegionOverlay = memo(function TextRegionOverlay(props: {
  regions: RegionObject[]; selected: string | null; scale: number; offset: Point; width: number; height: number; imageWidth: number; imageHeight: number;
  enabled: boolean; showSelection: boolean; controller: RegionInteraction;
  onSelect: (id: string) => void; onEdit: (region: RegionObject) => void;
  onCommit: (id: string, rect: RegionRect) => Promise<void>; onGesture: (active: boolean) => void;
  onPointer: (point: Point) => void; onWheel: (event: WheelEvent) => void;
  typography?: boolean; images?: Record<string, { png: string }>;
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
    if (props.selected !== region.id) props.onSelect(region.id);
    event.currentTarget.focus({ preventScroll: true });
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
      if (left + w < 0 || top + h < 0 || left > props.width || top > props.height) return null;
      const active = region.id === props.selected && props.showSelection;
      return <div key={region.id} data-text-region={props.typography ? undefined : region.id} data-dialogue={props.typography ? region.id : undefined} role="button" aria-label={`${props.typography ? 'Dialogue' : 'Text region'} ${String(index + 1).padStart(2, '0')}: ${region.text || 'empty text'}`} aria-pressed={active} tabIndex={props.enabled ? 0 : -1}
        className={`text-region-box ${props.typography ? 'typography-region-box' : ''} ${active ? 'is-selected' : ''}`} style={{ left, top, width: w, height: h, pointerEvents: props.enabled ? 'auto' : 'none' }}
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
        onDoubleClick={event => { if (props.enabled) { event.stopPropagation(); props.onEdit(region); } }}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); props.onSelect(region.id); props.onEdit(region); } }}>
        {props.images?.[region.id] && <img className="typography-raster" src={`data:image/png;base64,${props.images[region.id].png}`} draggable={false} alt="" />}
        {active && handles.map(handle => <span key={handle} role="button" tabIndex={props.enabled ? 0 : -1} aria-label={`Resize ${props.typography ? 'dialogue' : 'text region'} ${handle}`} className={`text-region-handle handle-${handle}`} onPointerDown={event => begin(event, region, handle)} />)}
      </div>;
    })}
  </div>;
});
