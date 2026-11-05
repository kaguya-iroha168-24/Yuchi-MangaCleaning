export type Point = { x: number; y: number };
export type FitMode = 'page' | 'width' | 'actual';
export type ViewMode = 'single' | 'dual' | 'onion';
export type ViewTransform = { zoom: number; pan: Point; fit: FitMode; mode: ViewMode; split: number; peek: boolean };
export type ViewMetrics = { width: number; height: number; imageWidth: number; imageHeight: number; scale: number };
export type PixelPointer = { point: Point; source: 'original' | 'editing' } | null;

export function fitScale(size: { width: number; height: number }, image: { width: number; height: number }, fit: FitMode, zoom: number): number {
  const base = fit === 'actual' ? 1 : fit === 'width' ? (size.width - 44) / image.width : Math.min((size.width - 44) / image.width, (size.height - 44) / image.height);
  return Math.max(0.01, base * zoom);
}
export function imageOffset(size: { width: number; height: number }, image: { width: number; height: number }, pan: Point, scale: number): Point {
  return { x: size.width / 2 - (image.width / 2 + pan.x) * scale, y: size.height / 2 - (image.height / 2 + pan.y) * scale };
}
export function toImage(point: Point, offset: Point, scale: number, width: number, height: number): Point {
  return { x: Math.max(0, Math.min(width, (point.x - offset.x) / scale)), y: Math.max(0, Math.min(height, (point.y - offset.y) / scale)) };
}
export function zoomAt(transform: ViewTransform, factor: number, point: Point, size: { width: number; height: number }, image: { width: number; height: number }, scale: number): Pick<ViewTransform, 'zoom' | 'pan'> {
  const zoom = Math.max(.01, Math.min(12, transform.zoom * factor));
  const nextScale = scale * zoom / transform.zoom;
  const offset = imageOffset(size, image, transform.pan, scale);
  const native = { x: (point.x - offset.x) / scale, y: (point.y - offset.y) / scale };
  return { zoom, pan: { x: native.x - image.width / 2 + (size.width / 2 - point.x) / nextScale, y: native.y - image.height / 2 + (size.height / 2 - point.y) / nextScale } };
}
export function visibleImageRect(metrics: ViewMetrics, pan: Point): [number, number, number, number] {
  const x = metrics.imageWidth / 2 + pan.x - metrics.width / (2 * metrics.scale);
  const y = metrics.imageHeight / 2 + pan.y - metrics.height / (2 * metrics.scale);
  const right = Math.min(metrics.imageWidth, x + metrics.width / metrics.scale), bottom = Math.min(metrics.imageHeight, y + metrics.height / metrics.scale);
  const left = Math.min(metrics.imageWidth, Math.max(0, x)), top = Math.min(metrics.imageHeight, Math.max(0, y));
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}

export function roundedImageRect(rect: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const x = Math.max(0, Math.min(width, Math.round(rect[0]))), y = Math.max(0, Math.min(height, Math.round(rect[1])));
  const right = Math.max(x, Math.min(width, Math.round(rect[0] + rect[2]))), bottom = Math.max(y, Math.min(height, Math.round(rect[1] + rect[3])));
  return [x, y, right - x, bottom - y];
}

export class ViewportController {
  private transform: ViewTransform = { zoom: 1, pan: { x: 0, y: 0 }, fit: 'page', mode: 'dual', split: .5, peek: false };
  private metrics: ViewMetrics = { width: 1, height: 1, imageWidth: 1, imageHeight: 1, scale: 1 };
  private pointer: PixelPointer = null;
  private listeners = new Set<() => void>();
  private metricListeners = new Set<() => void>();
  private pointerListeners = new Set<() => void>();
  getSnapshot = () => this.transform;
  getMetrics = () => this.metrics;
  getPointer = () => this.pointer;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeMetrics = (listener: () => void) => { this.metricListeners.add(listener); return () => { this.metricListeners.delete(listener); }; };
  subscribePointer = (listener: () => void) => { this.pointerListeners.add(listener); return () => { this.pointerListeners.delete(listener); }; };
  update(value: Partial<ViewTransform>) { this.transform = { ...this.transform, ...value }; this.listeners.forEach(listener => listener()); }
  updateMetrics(value: ViewMetrics) { if (Object.keys(value).every(key => value[key as keyof ViewMetrics] === this.metrics[key as keyof ViewMetrics])) return; this.metrics = value; this.metricListeners.forEach(listener => listener()); }
  updatePointer(value: PixelPointer) { this.pointer = value; this.pointerListeners.forEach(listener => listener()); }
  reset() { this.update({ zoom: 1, pan: { x: 0, y: 0 }, fit: 'page', peek: false }); this.updatePointer(null); }
  fit(mode: FitMode) { this.update({ fit: mode, zoom: 1, pan: mode === 'actual' ? this.transform.pan : { x: 0, y: 0 } }); }
  zoomBy(factor: number) { this.update({ zoom: Math.max(.01, Math.min(12, this.transform.zoom * factor)) }); }
  actualScale(value: number) { this.update({ fit: 'actual', zoom: Math.max(.01, Math.min(12, value)) }); }
  toggleDual() { this.update({ mode: this.transform.mode === 'dual' ? 'single' : 'dual', peek: false }); }
}
