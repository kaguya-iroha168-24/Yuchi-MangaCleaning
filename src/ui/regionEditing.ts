import type { Point } from './viewport';
export type RegionRect = [number, number, number, number];
export type RegionHandle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type RegionDraft = { id: string; rect: RegionRect } | null;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

export function editRegion(rect: readonly number[], handle: RegionHandle, delta: Point, image: { width: number; height: number }): RegionRect {
  const [x, y, width, height] = rect;
  const dx = Math.round(delta.x), dy = Math.round(delta.y);
  if (handle === 'move') return [clamp(x + dx, 0, image.width - width), clamp(y + dy, 0, image.height - height), width, height];
  let left = x, top = y, right = x + width, bottom = y + height;
  if (handle.includes('w')) left = clamp(x + dx, 0, right - 1);
  if (handle.includes('e')) right = clamp(right + dx, left + 1, image.width);
  if (handle.includes('n')) top = clamp(y + dy, 0, bottom - 1);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + 1, image.height);
  return [left, top, right - left, bottom - top];
}

// Pointer samples stay outside document/App state. Both panes receive one draft per frame.
export class RegionInteraction {
  private draft: RegionDraft = null;
  private pending: RegionDraft = null;
  private frame: number | null = null;
  private listeners = new Set<() => void>();
  constructor(private schedule = (callback: FrameRequestCallback) => requestAnimationFrame(callback), private cancel = (id: number) => cancelAnimationFrame(id)) {}
  getSnapshot = () => this.draft;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  update(value: RegionDraft) {
    this.pending = value;
    if (this.frame === null) this.frame = this.schedule(() => { this.frame = null; this.draft = this.pending; this.listeners.forEach(listener => listener()); });
  }
  flush(value: RegionDraft) {
    if (this.frame !== null) this.cancel(this.frame);
    this.frame = null; this.pending = this.draft = value; this.listeners.forEach(listener => listener());
  }
}
