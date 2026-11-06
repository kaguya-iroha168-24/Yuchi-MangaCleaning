import type { Api, Dialogue, DocumentState, State, TypographyRender } from '../api';
import { RegionInteraction, type RegionRect } from './regionEditing';

type TypographyStyle = Pick<Dialogue, 'family' | 'weight' | 'size' | 'minimum_size' | 'alignment' | 'color' | 'auto_fit' | 'padding'>;
type Snapshot = { drafts: Record<string, Dialogue>; layers: Record<string, TypographyRender>; errors: Record<string, string>; loading: Record<string, boolean>; copiedStyle: TypographyStyle | null };
export const dialogueFields = ({ id: _id, ...fields }: Dialogue) => fields;
export const fontSizePatch = (text: Dialogue, size: number) => ({ size: Math.max(8, Math.min(144, Math.round(size))), minimum_size: Math.min(Math.max(8, Math.round(size)), text.minimum_size) });
export function cardDialogue(dialogues: Dialogue[], bubbleId: string, selected: string | null): Dialogue | null {
  const linked = dialogues.filter(text => text.bubble_id === bubbleId);
  return linked.length === 1 ? linked[0] : linked.find(text => text.id === selected) ?? null;
}
export const rasterKey = (text: Dialogue) => JSON.stringify({ ...dialogueFields(text), x: text.auto_fit && text.bubble_id ? text.x : 0, y: text.auto_fit && text.bubble_id ? text.y : 0, source_region_id: null });

// Transient typography changes subscribe locally; App is notified only when dirty changes.
export class TypographySession {
  readonly interaction = new RegionInteraction();
  private snapshot: Snapshot = { drafts: {}, layers: {}, errors: {}, loading: {}, copiedStyle: null };
  private saved = new Map<string, Dialogue>();
  private keys = new Map<string, string>();
  private bubbleGeometry = new Map<string, string>();
  private queue = new Map<string, { text: Dialogue; key: string; page: string }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private listeners = new Set<() => void>();
  private api: Api | null = null;
  private page = '';
  private draining = false;
  private commit: Promise<void> | null = null;
  private frame: number | null = null;
  private dirty = false;
  private disposed = false;
  private priority: string | null = null;
  private callbacks = { state: (_state: State) => {}, dirty: (_dirty: boolean) => {}, error: (_error: unknown) => {} };
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  configure(api: Api | null, document: DocumentState | null, callbacks: typeof this.callbacks) {
    this.callbacks = callbacks; this.api = api; this.disposed = false;
    const page = document?.pageId ?? '';
    if (page !== this.page) {
      this.page = page; this.keys.clear(); this.queue.clear(); this.saved.clear();
      this.timers.forEach(clearTimeout); this.timers.clear();
      this.snapshot = { drafts: {}, layers: {}, errors: {}, loading: {}, copiedStyle: this.snapshot.copiedStyle }; this.interaction.flush(null);
    }
    this.bubbleGeometry = new Map((document?.bubbles ?? []).map(bubble => [bubble.id, `${bubble.rect.join(',')}:${bubble.containerPixels}`]));
    const items = document?.dialogues ?? [];
    this.saved = new Map(items.map(text => [text.id, text]));
    const drafts = { ...this.snapshot.drafts }, layers = { ...this.snapshot.layers }, errors = { ...this.snapshot.errors }, loading = { ...this.snapshot.loading };
    for (const id of new Set([...Object.keys(drafts), ...Object.keys(layers), ...Object.keys(errors), ...Object.keys(loading)])) {
      if (!this.saved.has(id)) { delete drafts[id]; delete layers[id]; delete errors[id]; delete loading[id]; this.queue.delete(id); this.keys.delete(id); clearTimeout(this.timers.get(id)); this.timers.delete(id); }
      else if (drafts[id] && JSON.stringify(drafts[id]) === JSON.stringify(this.saved.get(id))) delete drafts[id];
    }
    this.snapshot = { ...this.snapshot, drafts, layers, errors, loading };
    for (const text of items) this.request(drafts[text.id] ?? text);
    this.publish();
  }
  select(id: string | null) { this.priority = id; }
  copyStyle(id: string) {
    const text = this.snapshot.drafts[id] ?? this.saved.get(id); if (!text) return;
    const { family, weight, size, minimum_size, alignment, color, auto_fit, padding } = text;
    this.snapshot = { ...this.snapshot, copiedStyle: { family, weight, size, minimum_size, alignment, color, auto_fit, padding } };
    this.publish();
  }
  async pasteStyle(id: string) {
    if (!this.snapshot.copiedStyle || !(this.snapshot.drafts[id] ?? this.saved.get(id))) return;
    this.edit(id, this.snapshot.copiedStyle);
    await this.flush();
  }
  async abandon() {
    this.timers.forEach(clearTimeout); this.timers.clear(); this.queue.clear();
    if (this.commit) { try { await this.commit; } catch { /* Opening a confirmed replacement remains possible after a failed commit. */ } }
    this.snapshot = { ...this.snapshot, drafts: {} }; this.publish();
  }
  edit(id: string, fields: Partial<Dialogue>) {
    const base = this.snapshot.drafts[id] ?? this.saved.get(id); if (!base) return;
    const text = { ...base, ...fields };
    this.snapshot = { ...this.snapshot, drafts: { ...this.snapshot.drafts, [id]: text } };
    clearTimeout(this.timers.get(id));
    this.timers.set(id, setTimeout(() => { this.timers.delete(id); this.request(text); }, 150));
    this.publish();
  }
  async pose(id: string, rect: RegionRect) { this.edit(id, { x: rect[0], y: rect[1], width: rect[2], height: rect[3] }); await this.flush(); }
  async resizeFont(id: string, bubbleId: string, delta: number) {
    const text = this.snapshot.drafts[id] ?? this.saved.get(id);
    if (!text || text.bubble_id !== bubbleId || !text.visible) return;
    // Read the current draft synchronously; rapid clicks never reuse stale props.
    this.edit(id, fontSizePatch(text, text.size + delta));
    await this.flush();
  }
  discard(id: string) {
    const drafts = { ...this.snapshot.drafts }; delete drafts[id];
    this.snapshot = { ...this.snapshot, drafts }; clearTimeout(this.timers.get(id)); this.timers.delete(id); this.keys.delete(id);
    const text = this.saved.get(id); if (text) this.request(text); this.publish();
  }
  async flush(): Promise<void> {
    if (this.commit) { await this.commit; if (Object.keys(this.snapshot.drafts).length) return this.flush(); return; }
    if (!Object.keys(this.snapshot.drafts).length) return;
    if (!this.api) throw new Error('Local engine is unavailable; typography changes are not confirmed.');
    const page = this.page, api = this.api;
    this.commit = (async () => {
      for (const id of Object.keys(this.snapshot.drafts)) {
        const text = this.snapshot.drafts[id]; if (!text || page !== this.page) continue;
        const result = await api.post<State>(`/v1/dialogues/${encodeURIComponent(id)}`, dialogueFields(text));
        if (page !== this.page) return;
        const drafts = { ...this.snapshot.drafts };
        if (drafts[id] === text) delete drafts[id];
        this.snapshot = { ...this.snapshot, drafts };
        if (result.document) this.saved = new Map(result.document.dialogues.map(item => [item.id, item]));
        this.callbacks.state(result); this.request(this.snapshot.drafts[id] ?? this.saved.get(id)!); this.publish();
      }
    })();
    try { await this.commit; }
    catch (error) { this.callbacks.error(error); throw error; }
    finally { this.commit = null; this.publish(); }
    if (Object.keys(this.snapshot.drafts).length) return this.flush();
  }
  private request(text: Dialogue) {
    if (!text || !this.api || !this.page || this.disposed) return;
    const key = rasterKey(text) + (text.auto_fit && text.bubble_id ? this.bubbleGeometry.get(text.bubble_id) ?? '' : ''); if (this.keys.get(text.id) === key) return;
    this.keys.set(text.id, key); this.queue.set(text.id, { text, key, page: this.page });
    this.snapshot = { ...this.snapshot, loading: { ...this.snapshot.loading, [text.id]: true } }; this.publish();
    void this.drain();
  }
  private async drain() {
    if (this.draining || !this.api) return;
    this.draining = true;
    try {
      while (this.queue.size && this.api && !this.disposed) {
        const id = this.priority && this.queue.has(this.priority) ? this.priority : this.queue.keys().next().value!;
        const pending = this.queue.get(id)!; this.queue.delete(id);
        try {
          const layer = await this.api.post<TypographyRender>('/v1/typography/preview', { pageId: pending.page, dialogue: dialogueFields(pending.text) });
          if (this.page !== pending.page || this.keys.get(id) !== pending.key) continue;
          const errors = { ...this.snapshot.errors }; delete errors[id];
          this.snapshot = { ...this.snapshot, layers: { ...this.snapshot.layers, [id]: layer }, errors, loading: { ...this.snapshot.loading, [id]: false } };
        } catch (error) {
          if (this.page !== pending.page || this.keys.get(id) !== pending.key) continue;
          this.keys.delete(id);
          this.snapshot = { ...this.snapshot, errors: { ...this.snapshot.errors, [id]: error instanceof Error ? error.message : String(error) }, loading: { ...this.snapshot.loading, [id]: false } };
        }
        this.publish();
      }
    } finally { this.draining = false; }
  }
  private publish() {
    const dirty = Object.keys(this.snapshot.drafts).length > 0;
    if (dirty !== this.dirty) { this.dirty = dirty; this.callbacks.dirty(dirty); }
    if (this.frame === null && !this.disposed) this.frame = requestAnimationFrame(() => { this.frame = null; this.listeners.forEach(listener => listener()); });
  }
  dispose() {
    this.disposed = true; this.queue.clear(); this.timers.forEach(clearTimeout); this.timers.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.interaction.flush(null);
  }
}
