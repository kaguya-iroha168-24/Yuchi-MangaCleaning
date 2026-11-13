import type { Api, Dialogue, DocumentState, State, TypographyRender } from '../api';
import { editRegion, RegionInteraction, type RegionRect } from './regionEditing';

type TypographyStyle = Pick<Dialogue, 'family' | 'weight' | 'size' | 'minimum_size' | 'alignment' | 'color' | 'auto_fit' | 'padding' | 'style'>;
type Snapshot = { drafts: Record<string, Dialogue>; layers: Record<string, TypographyRender>; errors: Record<string, string>; loading: Record<string, boolean>; copiedStyle: TypographyStyle | null };
export const dialogueFields = ({ id: _id, locked: _locked, ...fields }: Dialogue) => fields;
export const fontSizePatch = (text: Dialogue, size: number) => ({ size: Math.max(8, Math.min(144, Math.round(size))), minimum_size: Math.min(Math.max(8, Math.round(size)), text.minimum_size) });
export const manualFontSizePatch = (text: Pick<Dialogue, 'minimum_size'>, size: number) => ({ ...fontSizePatch(text as Dialogue, size), auto_fit: false });
export const autoFitFontSizePatch = (text: Pick<Dialogue, 'minimum_size'>, size: number) => ({ ...fontSizePatch(text as Dialogue, size), auto_fit: true });

export interface AutoFitInput {
  text: string;
  boxWidth: number;
  boxHeight: number;
  fontFamily?: string;
  fontWeight?: number | string;
  italic?: boolean;
  lineHeight?: number;
  letterSpacing?: number;
  minFontSize?: number;
  maxFontSize?: number;
  measureTextWidth?: (text: string, font: string, fontSize: number) => number;
}

export interface AutoFitResult {
  fontSize: number;
  lines: string[];
  isOverflowing: boolean;
  totalTextHeight: number;
  maxWordWidth: number;
}

let measureCanvasContext: CanvasRenderingContext2D | null | undefined;
function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCanvasContext !== undefined) return measureCanvasContext;
  if (typeof document === 'undefined') { measureCanvasContext = null; return null; }
  const canvas = document.createElement('canvas');
  measureCanvasContext = canvas.getContext('2d');
  return measureCanvasContext;
}

function measureRunWidth(
  value: string,
  font: string,
  fontSize: number,
  letterSpacing: number,
  customMeasure?: (text: string, font: string, fontSize: number) => number,
): number {
  if (!value) return 0;
  let baseWidth = 0;
  if (customMeasure) {
    baseWidth = customMeasure(value, font, fontSize);
  } else {
    const ctx = getMeasureContext();
    if (ctx) {
      ctx.font = font;
      baseWidth = ctx.measureText(value).width;
    } else {
      // Deterministic metric fallback only in headless non-DOM test environments
      baseWidth = value.length * fontSize * 0.56;
    }
  }
  const spacing = value.length > 1 ? (value.length - 1) * letterSpacing : 0;
  return Math.max(0, baseWidth + spacing);
}

function measureLayoutAtSize(input: AutoFitInput, fontSize: number, wrapWidth: number): { lines: string[]; totalTextHeight: number; maxWordWidth: number } {
  const family = (input.fontFamily || 'Komika Text Kaps').trim();
  const quotedFamily = /[\s,]/.test(family) && !/^["']/.test(family) ? `"${family}"` : family;
  const weight = input.fontWeight ?? 700;
  const italic = input.italic ? 'italic ' : '';
  const font = `${italic}${weight} ${fontSize}px ${quotedFamily}`;
  const lineHeight = input.lineHeight && input.lineHeight > 0.4 ? input.lineHeight : 1.15;
  const letterSpacing = input.letterSpacing ?? 0;

  const trimmed = (input.text || '').replace(/\r\n/g, '\n');
  if (!trimmed.trim()) return { lines: [], totalTextHeight: 0, maxWordWidth: 0 };

  const paragraphs = trimmed.split('\n');
  const lines: string[] = [];
  let maxWordWidth = 0;

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push('');
      continue;
    }
    let currentLine = '';
    for (const word of words) {
      const wordW = measureRunWidth(word, font, fontSize, letterSpacing, input.measureTextWidth);
      if (wordW > maxWordWidth) maxWordWidth = wordW;
      if (!currentLine) {
        currentLine = word;
      } else {
        const candidate = `${currentLine} ${word}`;
        const candW = measureRunWidth(candidate, font, fontSize, letterSpacing, input.measureTextWidth);
        if (candW <= wrapWidth) {
          currentLine = candidate;
        } else {
          lines.push(currentLine);
          currentLine = word;
        }
      }
    }
    if (currentLine) lines.push(currentLine);
  }

  return {
    lines,
    totalTextHeight: lines.length * fontSize * lineHeight,
    maxWordWidth,
  };
}

export function computeAutoFitFontSize(input: AutoFitInput): AutoFitResult {
  const minSize = Math.max(8, Math.round(input.minFontSize ?? 11));
  const maxSize = Math.max(minSize, Math.round(input.maxFontSize ?? 32));
  const boxW = Math.max(8, input.boxWidth);
  const boxH = Math.max(8, input.boxHeight);
  const safeWidth = boxW * 0.86;
  const safeHeight = boxH * 0.86;
  const overflowWidth = boxW * 0.92;
  const overflowHeight = boxH * 0.92;

  if (!input.text || !input.text.trim()) {
    return { fontSize: maxSize, lines: [], isOverflowing: false, totalTextHeight: 0, maxWordWidth: 0 };
  }

  let low = minSize;
  let high = maxSize;
  let best = minSize;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const measured = measureLayoutAtSize(input, mid, safeWidth);
    const fits = measured.maxWordWidth <= safeWidth && measured.totalTextHeight <= safeHeight;
    if (fits) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  const finalMetrics = measureLayoutAtSize(input, best, safeWidth);
  const isOverflowing = finalMetrics.totalTextHeight > overflowHeight || finalMetrics.maxWordWidth > overflowWidth;
  return {
    fontSize: best,
    lines: finalMetrics.lines,
    isOverflowing,
    totalTextHeight: finalMetrics.totalTextHeight,
    maxWordWidth: finalMetrics.maxWordWidth,
  };
}

export function evaluateDialogueOverflow(dialogue: Pick<Dialogue, 'text' | 'width' | 'height' | 'family' | 'weight' | 'size' | 'auto_fit' | 'style'>, boxWidth?: number, boxHeight?: number, measureTextWidth?: AutoFitInput['measureTextWidth']): AutoFitResult {
  const w = Math.max(8, boxWidth ?? dialogue.width);
  const h = Math.max(8, boxHeight ?? dialogue.height);
  if (!dialogue.text || !dialogue.text.trim()) {
    return { fontSize: dialogue.size, lines: [], isOverflowing: false, totalTextHeight: 0, maxWordWidth: 0 };
  }
  const baseInput: AutoFitInput = {
    text: dialogue.text,
    boxWidth: w,
    boxHeight: h,
    fontFamily: dialogue.family,
    fontWeight: dialogue.weight,
    italic: Boolean(dialogue.style?.italic),
    lineHeight: dialogue.style?.line_height ?? 1.15,
    letterSpacing: dialogue.style?.letter_spacing ?? 0,
    measureTextWidth,
  };
  if (dialogue.auto_fit) {
    return computeAutoFitFontSize(baseInput);
  }
  const lockedSize = Math.max(8, dialogue.size);
  const metrics = measureLayoutAtSize(baseInput, lockedSize, w * 0.86);
  return {
    fontSize: lockedSize,
    lines: metrics.lines,
    isOverflowing: metrics.totalTextHeight > h * 0.92 || metrics.maxWordWidth > w * 0.92,
    totalTextHeight: metrics.totalTextHeight,
    maxWordWidth: metrics.maxWordWidth,
  };
}
export function readSizePresets(serialized: string | null): (number | null)[] {
  let values: unknown;
  try { values = serialized === null ? null : JSON.parse(serialized); } catch { values = null; }
  const slots = Array.isArray(values) ? values : [];
  return Array.from({ length: 5 }, (_, index) => {
    const value = slots[index];
    return Number.isInteger(value) && value >= 8 && value <= 144 ? value : null;
  });
}
export function cardDialogue(dialogues: Dialogue[], bubbleId: string, selected: string | null): Dialogue | null {
  const linked = dialogues.filter(text => text.bubble_id === bubbleId);
  return linked.length === 1 ? linked[0] : linked.find(text => text.id === selected) ?? null;
}
export const rasterKey = (text: Dialogue, bound = Boolean(text.auto_fit && text.bubble_id)) => JSON.stringify({ ...dialogueFields(text), x: bound ? text.x : 0, y: bound ? text.y : 0, source_region_id: null });

// Transient typography changes subscribe locally; App is notified only when dirty changes.
export class TypographySession {
  readonly interaction = new RegionInteraction();
  private snapshot: Snapshot = { drafts: {}, layers: {}, errors: {}, loading: {}, copiedStyle: null };
  private saved = new Map<string, Dialogue>();
  private keys = new Map<string, string>();
  private bubbleGeometry = new Map<string, string>();
  private coverGeometry = new Map<string, string>();
  private overlayMode = false;
  private bubbleRects = new Map<string, number[]>();
  private bounds = { width: 0, height: 0 };
  private caseVersion = 0;
  private caseRequests = new Map<string, number>();
  private casePreviews = new Set<Promise<TypographyRender>>();
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
      this.caseRequests.clear();
      this.timers.forEach(clearTimeout); this.timers.clear();
      this.snapshot = { drafts: {}, layers: {}, errors: {}, loading: {}, copiedStyle: this.snapshot.copiedStyle }; this.interaction.flush(null);
    }
    this.bubbleGeometry = new Map((document?.bubbles ?? []).map(bubble => [bubble.id, `${bubble.rect.join(',')}:${bubble.containerPixels}`]));
    this.bubbleRects = new Map((document?.bubbles ?? []).map(bubble => [bubble.id, bubble.rect]));
    this.bounds = { width: document?.width ?? 0, height: document?.height ?? 0 };
    const items = document?.dialogues ?? [];
    this.coverGeometry.clear();
    this.overlayMode = document?.composition?.text_mode === 'overlay';
    if (this.overlayMode && document) {
      for (const text of items) {
        const matches = (document.textRegions ?? []).filter(region => text.source_region_id ? region.id === text.source_region_id : text.bubble_id && region.bubbleId === text.bubble_id);
        if (matches.length === 1) this.coverGeometry.set(text.id, matches[0].rect.join(','));
      }
    }
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
    const { family, weight, size, minimum_size, alignment, color, auto_fit, padding, style } = text;
    this.snapshot = { ...this.snapshot, copiedStyle: { family, weight, size, minimum_size, alignment, color, auto_fit, padding, ...(style ? { style: { ...style } } : {}) } };
    this.publish();
  }
  async pasteStyle(id: string) {
    const target = this.snapshot.drafts[id] ?? this.saved.get(id);
    if (!this.snapshot.copiedStyle || !target || target.locked) return;
    this.edit(id, { ...this.snapshot.copiedStyle, ...(target.style && !this.snapshot.copiedStyle.style ? { style: {} } : {}) });
    await this.flush();
  }
  async abandon() {
    this.timers.forEach(clearTimeout); this.timers.clear(); this.queue.clear();
    if (this.commit) { try { await this.commit; } catch { /* Opening a confirmed replacement remains possible after a failed commit. */ } }
    this.snapshot = { ...this.snapshot, drafts: {} }; this.publish();
  }
  edit(id: string, fields: Partial<Dialogue>) {
    const base = this.snapshot.drafts[id] ?? this.saved.get(id); if (!base || base.locked) return;
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
  async transformCase(id: string, mode: 'upper' | 'title' | 'lower') {
    const base = this.snapshot.drafts[id] ?? this.saved.get(id); if (!base || base.locked) return;
    const ticket = ++this.caseVersion; this.caseRequests.set(id, ticket);
    const lower = base.text.toLocaleLowerCase('id');
    const text = mode === 'upper' ? base.text.toLocaleUpperCase('id') : mode === 'title' ? lower.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toLocaleUpperCase('id')) : lower;
    if (text === base.text && !this.snapshot.layers[id]?.overflow) return;
    if (!this.api) return;
    const page = this.page, api = this.api, before = JSON.stringify(base);
    const current = () => this.page === page && this.api === api && this.caseRequests.get(id) === ticket && JSON.stringify(this.snapshot.drafts[id] ?? this.saved.get(id)) === before;
    const preview = api.post<TypographyRender>('/v1/typography/preview', { pageId: page, dialogue: dialogueFields({ ...base, text }) });
    this.casePreviews.add(preview);
    let minimum = base.minimum_size;
    try {
      let layer = await preview;
      if (!current()) return;
      if (layer.overflow && base.auto_fit && minimum > 8) {
        const fitted = api.post<TypographyRender>('/v1/typography/preview', { pageId: page, dialogue: dialogueFields({ ...base, text, minimum_size: 8 }) });
        this.casePreviews.add(fitted);
        try { layer = await fitted; } finally { this.casePreviews.delete(fitted); }
        if (!current()) return;
        if (!layer.overflow) minimum = Math.max(8, Math.min(minimum, layer.effectiveSize));
      }
      if (layer.overflow) {
        this.callbacks.error(new Error('Case change not applied: the converted words do not fit the safe area at the minimum font size. Previous text is preserved. Enlarge the text box or adjust padding/minimum size, then retry.'));
        return;
      }
    } catch (error) { if (!current()) return; this.callbacks.error(error); throw error; }
    finally { this.casePreviews.delete(preview); }
    this.edit(id, { text, minimum_size: minimum }); await this.flush();
    if (minimum < base.minimum_size) return `Auto Fit adjusted this dialogue's minimum from ${base.minimum_size} to ${minimum} px for the case change. Requested size stays ${base.size} px. Undo restores both changes.`;
  }
  async nudge(id: string, dx: number, dy: number) {
    const text = this.snapshot.drafts[id] ?? this.saved.get(id);
    if (!text || !this.bounds.width || !this.bounds.height || !Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const rect = editRegion([text.x, text.y, text.width, text.height], 'move', { x: dx, y: dy }, this.bounds);
    if (rect[0] === text.x && rect[1] === text.y) return;
    await this.pose(id, rect);
  }
  async center(id: string) {
    const text = this.snapshot.drafts[id] ?? this.saved.get(id); if (!text) return;
    const rect = text.bubble_id ? this.bubbleRects.get(text.bubble_id) : null;
    const [x, y, width, height] = rect ?? [0, 0, this.bounds.width, this.bounds.height];
    await this.nudge(id, x + (width - text.width) / 2 - text.x, y + (height - text.height) / 2 - text.y);
  }
  async fitInsideBubble(id: string, preset?: 'manga') {
    const base = this.snapshot.drafts[id] ?? this.saved.get(id);
    const api = this.api, page = this.page;
    if (!base || base.locked || !api) return;
    const otherDialogue = base.bubble_id && [...this.saved.values()].some(text => text.id !== id && text.bubble_id === base.bubble_id);
    const bubble = base.bubble_id && !otherDialogue ? this.bubbleRects.get(base.bubble_id) : undefined;
    const [x, y, width, height] = bubble ?? [base.x, base.y, base.width, base.height];
    const patch = { x, y, width, height, auto_fit: true, minimum_size: 8,
      padding: Math.min(base.padding, Math.max(2, Math.min(6, Math.floor(Math.min(width, height) / 12)))) };
    const preview = api.post<TypographyRender & { presetPatch?: Partial<Dialogue> }>('/v1/typography/preview', {
      pageId: page, dialogue: dialogueFields({ ...base, ...patch }), preset,
    });
    this.casePreviews.add(preview);
    let layer: Awaited<typeof preview>;
    try { layer = await preview; } finally { this.casePreviews.delete(preview); }
    if (page !== this.page || api !== this.api || base !== (this.snapshot.drafts[id] ?? this.saved.get(id))) return;
    if (layer.overflow) return 'This text still does not fit safely. Shorten the translation or adjust its box.';
    if (preset && !layer.presetPatch) throw new Error('Manga lettering is unavailable in the local engine.');
    this.edit(id, { ...patch, ...layer.presetPatch });
    await this.flush();
    return preset ? `Manga lettering · ${layer.resolvedFamily} · ${layer.effectiveSize} px.`
      : `Fitted at ${layer.effectiveSize} px. Requested size stays ${base.size} px.`;
  }
  discard(id: string) {
    const drafts = { ...this.snapshot.drafts }; delete drafts[id];
    this.snapshot = { ...this.snapshot, drafts }; clearTimeout(this.timers.get(id)); this.timers.delete(id); this.keys.delete(id);
    const text = this.saved.get(id); if (text) this.request(text); this.publish();
  }
  async flush(): Promise<void> {
    while (this.casePreviews.size) await Promise.all([...this.casePreviews]);
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
    const bound = (text.auto_fit || this.overlayMode) && text.bubble_id;
    const key = `${rasterKey(text, Boolean(bound))}|${this.overlayMode}|${bound ? this.bubbleGeometry.get(bound) ?? '' : ''}|${this.coverGeometry.get(text.id) ?? ''}`; if (this.keys.get(text.id) === key) return;
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
    this.caseRequests.clear();
    this.disposed = true; this.queue.clear(); this.timers.forEach(clearTimeout); this.timers.clear();
    if (this.frame !== null) cancelAnimationFrame(this.frame); this.frame = null; this.interaction.flush(null);
  }
}
