import { invoke } from '@tauri-apps/api/core';

export type Bubble = { id: string; rect: number[]; excluded?: boolean; predictionRect: number[] | null; containerPixels: number; confidence: number | null; source: string; review: string; kind: string; cleaning: string; message: string; textRegions: number[][] };
export type OCRProposal = { status: string; raw_text: string; edited_text: string; confidence: number | null; provider: string; model_id: string; device: string; warnings?: string[] };
export type TextRegion = { id: string; rect: number[]; text: string; bubbleId: string | null; sourceEdited?: boolean; kind: string; direction: 'unspecified' | 'ltr' | 'rtl' | 'vertical'; ocr: OCRProposal | null };
export type Dialogue = { id: string; text: string; bubble_id: string | null; source_region_id: string | null; x: number; y: number; width: number; height: number; family: string; size: number; weight: number; minimum_size: number; color: string; alignment: 'left' | 'center' | 'right'; visible: boolean; auto_fit: boolean; padding: number };
export type TypographyRender = { png: string; width: number; height: number; effectiveSize: number; resolvedFamily: string; resolvedWeight: number; overflow: boolean; warnings: string[]; contentRect: number[]; durationMs: number; cacheHit: boolean };
export type DocumentState = { sourceName: string; projectName: string | null; pageId: string; width: number; height: number; revision: number; dirty: boolean; canUndo: boolean; canRedo: boolean; savedPath: string | null; bubbles: Bubble[]; textRegions: TextRegion[]; dialogues: Dialogue[]; readingOrder: string[]; detectionRuns: Record<string, unknown>[] };
export type SaveReceipt = { path: string; sha256: string; bytes: number; revision: number; verified: boolean; state: State };
export type ExportIssue = { dialogueId: string; dialogueLabel: string; bubbleId: string | null; candidateNumber: number | null; reason: string; code: string; requestedFamily: string; requestedWeight: number; requestedSize: number; resolvedFamily: string | null; resolvedWeight: number | null; resolvedSize: number | null };
export type ExportPreflight = { code: 'typesetting_preflight'; message: string; pageName: string; pageId: string; pageNumber: number; revision: number; issues: ExportIssue[] };
export type Job = { id: string; type: string; status: string; progress: number; cancelRequested: boolean; stage?: string; editingAllowed?: boolean; currentPageId?: string; message?: string; error?: string; result?: Record<string, unknown> };
export type State = { schema: number; document: DocumentState | null; job: Job | null; chapter?: ChapterState | null; imagesChanged?: boolean };
export type Preview = { id: string; revision: number; maskPixels: number; analysis: Record<string, unknown>; bubbleId: string | null };
export type ChapterPage = { id: string; name: string; width: number; height: number; dirty: boolean; saved?: boolean; bubbles: number; thumbnail: string };
export type ChapterState = { id: string; activePageId: string; dirty: boolean; savedPath: string | null; pages: ChapterPage[] };
type Session = { baseUrl: string; token: string };
export type FontEntry = { family: string; weights: number[]; status?: 'Available' | 'Missing' | 'Fallback'; sample?: string; preview?: string | null; warning?: string; license?: string };
type FontCatalog = { fonts: FontEntry[] };

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number, public readonly preflight?: ExportPreflight) { super(message); }
  get reconnectable() { return this.status === undefined || this.status === 401; }
}

let connecting: Promise<Api> | null = null;

async function openSession(): Promise<Api> {
  let session: Session;
  if ('__TAURI_INTERNALS__' in window) {
    session = await invoke<Session>('bootstrap');
  } else {
    const baseUrl = import.meta.env.VITE_YUCHI_API as string | undefined;
    const token = import.meta.env.VITE_YUCHI_TOKEN as string | undefined;
    if (!baseUrl || !token) throw new Error('Jalankan melalui Start-Yuchi-Tauri.cmd agar backend lokal aktif.');
    session = { baseUrl, token };
  }
  const api = new Api(session);
  await api.get<State>('/v1/state');
  return api;
}

export function connect(): Promise<Api> {
  // StrictMode and Open can ask for the same startup concurrently.
  if (!connecting) connecting = (async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await openSession(); }
      catch (error) {
        if (attempt >= 2 || (error instanceof ApiError && error.status !== undefined)) throw error;
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

export class Api {
  private fonts: Promise<FontCatalog> | null = null;
  private fontGeneration = 0;
  private fontListeners = new Set<() => void>();
  constructor(private session: Session) {}

  // The catalog belongs to this API session, never to a document or selection.
  fontCatalog(): Promise<FontCatalog> {
    if (!this.fonts) {
      const generation = this.fontGeneration;
      this.fonts = this.get<FontCatalog>('/v1/typography/fonts').then(result => {
        return generation === this.fontGeneration ? result : this.fontCatalog();
      }, error => {
        if (generation !== this.fontGeneration) return this.fontCatalog();
        this.fonts = null;
        throw error;
      });
    }
    return this.fonts;
  }

  subscribeFontCatalog(listener: () => void): () => void {
    this.fontListeners.add(listener);
    return () => { this.fontListeners.delete(listener); };
  }

  // Also call this if a future font-source refresh changes the worker catalog.
  invalidateFontCatalog() {
    this.fontGeneration++;
    this.fonts = null;
    for (const listener of this.fontListeners) listener();
  }

  private async send(path: string, method = 'GET', body?: BodyInit, contentType?: string): Promise<Response> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.session.token}` };
    if (contentType) headers['Content-Type'] = contentType;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try { response = await fetch(`${this.session.baseUrl}${path}`, { method, headers, body, signal: controller.signal }); }
    catch {
      if (path !== '/v1/typography/fonts') this.invalidateFontCatalog();
      throw new ApiError(`Koneksi backend gagal (${method} ${path.split('?')[0]}). Periksa koneksi/origin aplikasi lalu pilih Reconnect. Operasi belum dikonfirmasi; periksa keadaan proyek sebelum mencoba ulang.`);
    } finally { clearTimeout(timeout); }
    if (!response.ok) {
      if (response.status === 401 && path !== '/v1/typography/fonts') this.invalidateFontCatalog();
      let detail = `HTTP ${response.status}`;
      try {
        const value = (await response.json()).detail;
        if (value?.code === 'typesetting_preflight' && Array.isArray(value.issues)) throw new ApiError(value.message, response.status, value as ExportPreflight);
        if (typeof value === 'string') detail = value;
      } catch (error) { if (error instanceof ApiError) throw error; /* Response may not be JSON. */ }
      throw new ApiError(response.status === 401 ? 'Sesi backend ditolak (HTTP 401). Pilih Reconnect untuk memeriksa sesi aplikasi.' : detail, response.status);
    }
    return response;
  }

  async request<T>(path: string, method = 'GET', body?: BodyInit, contentType?: string): Promise<T> {
    const response = await this.send(path, method, body, contentType);
    return response.json() as Promise<T>;
  }

  get<T>(path: string) { return this.request<T>(path); }
  post<T>(path: string, value?: unknown) { return this.request<T>(path, 'POST', JSON.stringify(value ?? {}), 'application/json'); }

  save(kind: string) { return this.post<SaveReceipt>(`/v1/save/${kind}`); }

  async upload(file: File, discard = false): Promise<State> {
    const form = new FormData(); form.append('file', file);
    return this.request<State>(`/v1/open${discard ? '?discard=true' : ''}`, 'POST', form);
  }

  async uploadPages(files: File[], append = false, discard = false): Promise<State> {
    const form = new FormData(); files.forEach(file => form.append('files', file));
    return this.request<State>(`/v1/pages/import?append=${append}&discard=${discard}`, 'POST', form);
  }

  async image(kind: string): Promise<string> {
    const response = await this.send(`/v1/image/${kind}?v=${Date.now()}`);
    return URL.createObjectURL(await response.blob());
  }

  async download(kind: string): Promise<void> {
    const response = await this.send(`/v1/export/${kind}`);
    const header = response.headers.get('content-disposition') ?? '';
    const matched = /filename="?([^";]+)"?/.exec(header);
    const filename = matched?.[1] ?? `yuchi-labs.${kind === 'project' ? 'mangaclean' : kind}`;
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }

  progress(onJob: (job: Job | null) => void, onDisconnect?: () => void): () => void {
    const url = this.session.baseUrl.replace(/^http/, 'ws') + '/v1/progress';
    let socket: WebSocket;
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;
    const open = () => {
      socket = new WebSocket(url, ['yuchi', this.session.token]);
      let previousMessage: string | undefined;
      socket.onmessage = event => {
        attempts = 0;
        if (event.data === previousMessage) return;
        const job = JSON.parse(event.data) as Job | null;
        onJob(job);
        previousMessage = event.data;
      };
      socket.onclose = () => {
        if (stopped) return;
        this.invalidateFontCatalog();
        if (attempts++ < 3) timer = setTimeout(open, 500 * attempts);
        else onDisconnect?.();
      };
    };
    open();
    return () => { stopped = true; clearTimeout(timer); socket.close(); };
  }
}
