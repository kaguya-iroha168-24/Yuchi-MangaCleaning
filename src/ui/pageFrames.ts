import type { Bubble, TextRegion } from '../api';

export type PageFrame = { pageId: string; originalUrl: string; workingUrl: string; original: HTMLImageElement; working: HTMLImageElement; cacheKey?: string; textRegions?: TextRegion[]; bubbles?: Bubble[] };

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

const CACHE_PIXELS = 8_000_000;
const CACHE_PAGES = 2;

function framePixels(frame: PageFrame) {
  return frame.original.naturalWidth * frame.original.naturalHeight + frame.working.naturalWidth * frame.working.naturalHeight;
}

// Keep up to two inactive decoded pairs within the shared pixel budget.
export class PageFrames {
  private generation = 0;
  private current: PageFrame | null = null;
  private recent: PageFrame[] = [];
  constructor(private decode = decodeImage, private release = (url: string) => URL.revokeObjectURL(url), private maxPixels = CACHE_PIXELS, private maxPages = CACHE_PAGES) {}
  get version() { return this.generation; }
  invalidate() { this.generation++; }
  peek(pageId: string, cacheKey: string) {
    return this.recent.find(frame => frame.pageId === pageId && frame.cacheKey === cacheKey) ?? null;
  }
  rememberDetections(pageId: string, cacheKey: string, bubbles: Bubble[], regions?: TextRegion[], previousKey = cacheKey) {
    const frame = this.current;
    if (frame?.pageId !== pageId || frame.cacheKey !== previousKey) return;
    frame.cacheKey = cacheKey;
    frame.bubbles = bubbles;
    if (regions) frame.textRegions = regions;
  }
  rememberTextRegions(pageId: string, cacheKey: string, regions: TextRegion[], previousKey = cacheKey) {
    const frame = this.current;
    if (frame?.pageId !== pageId || frame.cacheKey !== previousKey) return;
    frame.cacheKey = cacheKey;
    frame.textRegions = regions;
  }
  private releaseFrame(frame: PageFrame) {
    this.release(frame.originalUrl); this.release(frame.workingUrl);
  }
  clearCache() {
    this.recent.forEach(frame => this.releaseFrame(frame));
    this.recent = [];
    if (this.current) this.current = { ...this.current, cacheKey: undefined };
  }
  dispose() {
    this.invalidate();
    this.clearCache();
    if (this.current) this.releaseFrame(this.current);
    this.current = null;
  }
  private show(frame: PageFrame, publish: (frame: PageFrame) => void) {
    const outgoing = this.current;
    publish(frame);
    this.current = frame;
    const index = this.recent.findIndex(cached => cached.pageId === frame.pageId);
    if (index !== -1) {
      const [cached] = this.recent.splice(index, 1);
      if (cached !== frame) this.releaseFrame(cached);
    }
    if (!outgoing || outgoing === frame) return;
    if (outgoing.pageId !== frame.pageId && outgoing.cacheKey && frame.cacheKey &&
        framePixels(outgoing) <= this.maxPixels) {
      this.recent.push(outgoing);
      while (this.recent.length > this.maxPages || this.recent.reduce((total, cached) => total + framePixels(cached), 0) > this.maxPixels) {
        this.releaseFrame(this.recent.shift()!);
      }
    } else this.releaseFrame(outgoing);
  }
  async preload(client: { pageImage?(id: string, kind: string): Promise<string>; image(kind: string): Promise<string> }, pageId: string, cacheKey?: string): Promise<boolean> {
    if (this.current?.pageId === pageId && this.current.cacheKey === cacheKey) return true;
    if (this.peek(pageId, cacheKey ?? '')) return true;
    if (!client.pageImage) return false;
    let originalUrl: string | undefined;
    let workingUrl: string | undefined;
    let accepted = false;
    try {
      [originalUrl, workingUrl] = await Promise.all([
        client.pageImage(pageId, 'original'),
        client.pageImage(pageId, 'working'),
      ]);
      const [original, working] = await Promise.all([
        this.decode(originalUrl),
        this.decode(workingUrl),
      ]);
      const frame: PageFrame = { pageId, originalUrl, workingUrl, original, working, cacheKey };
      const index = this.recent.findIndex(cached => cached.pageId === pageId);
      if (index !== -1) {
        const [cached] = this.recent.splice(index, 1);
        if (cached !== frame) this.releaseFrame(cached);
      }
      this.recent.push(frame);
      while (this.recent.length > this.maxPages || this.recent.reduce((total, cached) => total + framePixels(cached), 0) > this.maxPixels) {
        this.releaseFrame(this.recent.shift()!);
      }
      accepted = true;
      return true;
    } catch {
      return false;
    } finally {
      if (!accepted) {
        if (originalUrl) this.release(originalUrl);
        if (workingUrl) this.release(workingUrl);
      }
    }
  }
  async loadWorking(client: { image(kind: string): Promise<string> }, pageId: string, publish: (frame: PageFrame) => void, cacheKey?: string): Promise<boolean> {
    const previous = this.current;
    if (!previous || previous.pageId !== pageId) return this.load(client, pageId, publish, cacheKey);
    const version = ++this.generation;
    let url: string | undefined;
    let accepted = false;
    try {
      url = await client.image('working');
      if (version !== this.generation) return false;
      const working = await this.decode(url);
      if (version !== this.generation) return false;
      const frame = { ...previous, workingUrl: url, working, cacheKey };
      publish(frame);
      this.current = frame; accepted = true;
      this.release(previous.workingUrl);
      return true;
    } catch (error) {
      if (version !== this.generation) return false;
      throw error;
    } finally {
      if (url && !accepted) this.release(url);
    }
  }
  async load(client: { image(kind: string): Promise<string> }, pageId: string, publish: (frame: PageFrame) => void, cacheKey?: string, reuse = false): Promise<boolean> {
    const version = ++this.generation;
    if (reuse && cacheKey) {
      const cached = this.current?.pageId === pageId && this.current.cacheKey === cacheKey ? this.current : this.peek(pageId, cacheKey);
      if (cached) { this.show(cached, publish); return true; }
    }
    const fetched = await Promise.allSettled([client.image('original'), client.image('working')]);
    const urls = fetched.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
    let accepted = false;
    try {
      if (version !== this.generation) return false;
      const failure = fetched.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      const [originalUrl, workingUrl] = urls;
      const decoded = await Promise.allSettled([this.decode(originalUrl), this.decode(workingUrl)]);
      if (version !== this.generation) return false;
      const failed = decoded.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      if (version !== this.generation) return false;
      const [original, working] = decoded.map(result => (result as PromiseFulfilledResult<HTMLImageElement>).value);
      const frame = { pageId, originalUrl, workingUrl, original, working, cacheKey };
      this.show(frame, publish); accepted = true;
      return true;
    } finally {
      if (!accepted) urls.forEach(url => this.release(url));
    }
  }
}
