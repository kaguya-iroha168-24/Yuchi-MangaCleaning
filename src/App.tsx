import { sourceValue } from './ui/sourceText';
import { PageFrames, type PageFrame } from './ui/pageFrames';
import { PageNavigation } from './ui/pageNavigation';
import { processingPageIds, processingMessage, refreshJobImages, textCleanHint } from './ui/processing';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@radix-ui/react-tooltip';
import { CircleHelp, Eye, FolderOpen, Layers3, Trash2, X } from 'lucide-react';
import { MangaCleanLogo } from './components/MangaCleanIcons';
import { Api, ApiError, type DetectionMode, type ExportPreflight, type Job, type LayerPatch, type PageComposition, type Preview, type State, type TextRegion, connect } from './api';
import { ChapterNavigator } from './components/ChapterNavigator';
import { ContextToolbar, DockResizeHandle, EngineStatusBar, FeatureBadge, InspectorDock, PageNavigator, StudioHeader, ToolRail, type DockTab } from './components/StudioShell';
import { PreferencesDialog, QuickExportDialog, type TranslationSettings } from './components/PreferencesDialog';
import { blocksStudioShortcuts, resolveStudioShortcut } from './ui/shortcuts';
import { CanvasWorkspace, ViewportModeControls, ViewportZoomControls } from './components/CanvasWorkspace';
import { SourceTextDialog, sessionForRegion, type TextEditSession } from './components/SourceTextDialog';
import { RegionInteraction, type RegionRect } from './ui/regionEditing';
import { TypographySession } from './ui/typography';
import { TypographyCardControls, TypographyControls, TypographyLayerList, TypographyExportNotice } from './components/Typography';
import { ImageAdjustments } from './components/ImageAdjustments';
import { ViewportController, type Point } from './ui/viewport';

type Tool = 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase';
type Density = 'Balanced' | 'Compact' | 'Comfortable';
const emptySelection = new Set<string>();
function useImage(url: string | null): HTMLImageElement | null {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) { setImage(null); return; }
    setImage(null);
    const next = new Image();
    next.onload = () => setImage(next);
    next.src = url;
    return () => { next.onload = null; if (url.startsWith('blob:')) URL.revokeObjectURL(url); };
  }, [url]);
  return image;
}

function IconButton({ label, disabled, onClick, children, active = false }: { label: string; disabled?: boolean; onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return <Tooltip><TooltipTrigger asChild><button type="button" className={`icon-button ${active ? 'active' : ''}`} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button></TooltipTrigger><TooltipContent className="tooltip" sideOffset={7}>{label}</TooltipContent></Tooltip>;
}

export default function App() {
  const [api, setApi] = useState<Api | null>(null);
  const [state, setState] = useState<State>({ schema: 1, document: null, job: null });
  const [error, setError] = useState('');
  const [exportIssues, setExportIssues] = useState<ExportPreflight | null>(null);
  const [saveNotice, setSaveNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [leftCollapsed, setLeftCollapsed] = useState(() => window.innerWidth < 1120);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftWidth, setLeftWidth] = useState(220);
  const [rightWidth, setRightWidth] = useState(300);
  const [dockTab, setDockTab] = useState<DockTab>('Script');
  const [exportOpen, setExportOpen] = useState(false);
  const [showOriginal, setShowOriginal] = useState(true);
  const [showWorking, setShowWorking] = useState(true);
  const [showRegions, setShowRegions] = useState(true);
  const [showSelection, setShowSelection] = useState(true);
  const [regionGesture, setRegionGesture] = useState(false);
  const [textEditor, setTextEditor] = useState<TextEditSession | null>(null);
  const [textEditorError, setTextEditorError] = useState('');
  const interaction = useMemo(() => new RegionInteraction(), []);
  const typography = useMemo(() => new TypographySession(), []);
  const [typographyDirty, setTypographyDirty] = useState(false);
  const [activeLayer, setActiveLayer] = useState<'bubble' | 'source' | 'dialogue' | null>(null);
  const [selectedDialogueId, setSelectedDialogueId] = useState<string | null>(null);
  const [approvedMap, setApprovedMap] = useState<Record<string, Set<string>>>({});
  const [showTypography, setShowTypography] = useState(true);
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('yuchi-tauri-density') as Density) || 'Balanced');
  const [settings, setSettings] = useState<boolean | 'gemini-key'>(false);
  const [exportFormat, setExportFormat] = useState<'png' | 'jpeg'>('png');
  const [tool, setTool] = useState<Tool>('select');
  const viewport = useMemo(() => new ViewportController(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBoxes, setShowBoxes] = useState(true);
  const [showRulers, setShowRulers] = useState(false);
  const [showMask, setShowMask] = useState(false);
  const frames = useMemo(() => new PageFrames(undefined, undefined, 200_000_000, 30), []);
  const navigation = useMemo(() => new PageNavigation(), []);
  const [pageFrame, setPageFrame] = useState<PageFrame | null>(null);
  const [pendingPageId, setPendingPageId] = useState<string | null>(null);
  const originalUrl = pageFrame?.originalUrl ?? null;

  const [brushRadius, setBrushRadius] = useState(5);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [method, setMethod] = useState('Auto / Recommended');
  const [provider, setProvider] = useState('shima_v1');
  const [detectionMode, setDetectionMode] = useState<DetectionMode>(() => localStorage.getItem('yuchi-tauri-detection-mode') === 'text' ? 'text' : 'bubble');
  const [includeFreeText, setIncludeFreeText] = useState<boolean>(() => localStorage.getItem('yuchi-tauri-include-free-text') !== 'false');
  const [, setInspector] = useState<'Review' | 'Cleaning' | 'Text'>('Review');
  const [manualRect, setManualRect] = useState<[number, number, number, number] | null>(null);
  const [text, setText] = useState('');
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const [cropDraft, setCropDraft] = useState('');
  const [directionDraft, setDirectionDraft] = useState('unspecified');
  const [newDialogue, setNewDialogue] = useState('');
  const [queuedPages, setQueuedPages] = useState<Set<string>>(new Set());
  const [detectAll, setDetectAll] = useState(false);
  const [navigatorExpanded, setNavigatorExpanded] = useState(false);
  const appendImport = useRef(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const sourceFocused = useRef(false);
  const sourceCommit = useRef<Promise<void>>(Promise.resolve());
  const progressVersion = useRef('');
  const [manualDraft, setManualDraft] = useState('');

  const fileInput = useRef<HTMLInputElement>(null);
  const completedJob = useRef<string | null>(null);
  const heldTool = useRef<Tool | null>(null);
  const original = pageFrame && pageFrame.pageId === state.document?.pageId ? pageFrame.original : null;
  const working = pageFrame && pageFrame.pageId === state.document?.pageId ? pageFrame.working : null;
  const containers = null;
  const mask = useImage(maskUrl);
  const document = state.document;
  const documentFrameKey = document && state.chapter ? `${state.chapter.id}:${document.revision}` : undefined;
  const lastDocumentFrameKey = useRef<string | undefined>(undefined);
  const thumbnailCache = useRef<Map<string, HTMLImageElement>>(new Map());
  useEffect(() => {
    if (!state.chapter) return;
    for (const page of state.chapter.pages) {
      if (page.thumbnail && !thumbnailCache.current.has(page.id)) {
        const img = new Image();
        img.src = `data:image/png;base64,${page.thumbnail}`;
        thumbnailCache.current.set(page.id, img);
      }
    }
  }, [state.chapter?.id, state.chapter?.pages]);
  const pendingPage = state.chapter?.pages.find(page => page.id === pendingPageId && page.id !== document?.pageId);
  const fullCached = pendingPage && state.chapter ? frames.peek(pendingPage.id, `${state.chapter.id}:${pendingPage.revision}`) : null;
  const thumbImg = pendingPage ? thumbnailCache.current.get(pendingPage.id) : null;
  const cachedPreview = fullCached ?? (pendingPage && thumbImg ? {
    pageId: pendingPage.id,
    originalUrl: thumbImg.src,
    workingUrl: thumbImg.src,
    original: thumbImg,
    working: thumbImg,
    bubbles: [],
    textRegions: [],
  } as PageFrame : null);
  const composition = document?.composition ?? {};
  const active = useMemo(() => document?.bubbles.find(bubble => selected.has(bubble.id)) ?? null, [document, selected]);
  const activeText = useMemo(() => document?.textRegions.find(region => region.id === activeTextId) ?? null, [document, activeTextId]);
  const sourceDirty = activeText ? manualDraft !== (sourceValue(activeText)) : Boolean(text);
  const displayDocument = document && (sourceDirty || Boolean(newDialogue && !selectedDialogueId) || regionGesture || textEditor || typographyDirty || state.chapter?.dirty) ? { ...document, dirty: true } : document;
  const linkedDialogues = active ? document?.dialogues.filter(layer => layer.bubble_id === active.id) ?? [] : [];
  const activeDialogue = document?.dialogues?.find(text => text.id === selectedDialogueId)
    ?? (activeLayer === 'source' && activeText
      ? document?.dialogues.find(text => text.source_region_id === activeText.id) ?? null
      : linkedDialogues.length === 1 ? linkedDialogues[0] : null);
  const jobActive = state.job?.status === 'queued' || state.job?.status === 'running';
  const running = jobActive && !state.job?.editingAllowed;

  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    setExportIssues(reason instanceof ApiError ? reason.preflight ?? null : null);
    if (reason instanceof ApiError && reason.reconnectable) setApi(null);
  }, []);

  useEffect(() => { typography.configure(api, document, { state: setState, dirty: setTypographyDirty, error: reportError }); if (selectedDialogueId && !document?.dialogues?.some(text => text.id === selectedDialogueId)) setSelectedDialogueId(null); }, [api, document, typography, reportError, selectedDialogueId]);
  useEffect(() => () => typography.dispose(), [typography]);

  useEffect(() => { if(!sourceFocused.current)setManualDraft(sourceValue(activeText)); }, [activeText?.id, activeText?.text, activeText?.sourceEdited, activeText?.ocr?.edited_text]);
  useEffect(() => { setCropDraft(activeText?.rect.join(', ') ?? ''); setDirectionDraft(activeText?.direction ?? 'unspecified'); }, [activeText?.id, activeText?.rect.join(','), activeText?.direction]);


  useEffect(() => () => frames.dispose(), [frames]);

  // Preload chapter pages in background so page switching is instant
  useEffect(() => {
    if (!api || !state.chapter || jobActive) return;
    let cancelled = false;
    const preloadPages = async () => {
      const chapter = state.chapter;
      if (!chapter) return;
      const pages = chapter.pages;
      const activeIdx = pages.findIndex(p => p.id === chapter.activePageId);
      const ordered = [...pages].sort((a, b) => {
        const distA = Math.abs(pages.indexOf(a) - activeIdx);
        const distB = Math.abs(pages.indexOf(b) - activeIdx);
        return distA - distB;
      });
      for (const page of ordered) {
        if (cancelled) break;
        if (page.id === chapter.activePageId) continue;
        const cacheKey = `${chapter.id}:${page.revision}`;
        if (frames.peek(page.id, cacheKey)) continue;
        try {
          await frames.preload(api, page.id, cacheKey);
        } catch {
          // Preload error, non-blocking
        }
      }
    };
    const timer = setTimeout(preloadPages, 30);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [api, state.chapter?.id, state.chapter?.activePageId, state.chapter?.pages, jobActive]);
  useLayoutEffect(() => {
    lastDocumentFrameKey.current = documentFrameKey;
    if (document && documentFrameKey) frames.rememberDetections(document.pageId, documentFrameKey, document.bubbles.filter(b => !b.excluded), document.textRegions);
  }, [document, documentFrameKey, frames, pageFrame]);
  const refresh = useCallback(async (client: Api, withImages = false, knownState?: State, ready?: () => void, workingOnly = false, reuseFrame = false, textScanOnly = false) => {
    if (navigation.running && !knownState) return;
    const version = frames.version;
    const previousKey = lastDocumentFrameKey.current;
    const next = knownState ?? await client.get<State>('/v1/state');
    if (version !== frames.version || (navigation.running && !knownState)) return;
    if (withImages && next.document) {
      const publish = (frame: PageFrame) => { setPageFrame(frame); setState(next); ready?.(); };
      const cacheKey = next.chapter ? `${next.chapter.id}:${next.document.revision}` : undefined;
      if (workingOnly) await frames.loadWorking(client, next.document.pageId, publish, cacheKey);
      else await frames.load(client, next.document.pageId, publish, cacheKey, reuseFrame);
    } else if (withImages) {
      frames.dispose(); setPageFrame(null); setState(next);
      setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
      setPreview(null); setSelected(new Set()); setActiveTextId(null); setManualRect(null);
      ready?.();
    } else {
      if (textScanOnly && next.document && next.chapter && previousKey) {
        frames.rememberTextRegions(next.document.pageId, `${next.chapter.id}:${next.document.revision}`, next.document.textRegions, previousKey);
      }
      setState(next);
    }
  }, [frames, navigation]);

  useEffect(() => {
    let closed = false;
    connect().then(async client => { if (!closed) { await refresh(client, true); if (!closed) setApi(client); } }).catch(reason => { if (!closed) reportError(reason); });
    return () => { closed = true; };
  }, [refresh, reportError]);

  useEffect(() => {
    if (!api) return;
    return api.progress(job => {
      setState(previous => ({ ...previous, job }));
      const version = `${job?.id}:${job?.result?.stateVersion}`;
      if (job?.editingAllowed && job.result?.stateVersion && version !== progressVersion.current) {
        progressVersion.current = version;
        void api.get<State>('/v1/state').then(next => setState(previous => next.document?.pageId === previous.document?.pageId && next.document!.revision >= previous.document!.revision ? { ...next, job: previous.job } : previous)).catch(reportError);
      }
      if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && completedJob.current !== `${job.id}:${job.status}`) {
        completedJob.current = `${job.id}:${job.status}`;
        void refresh(api, refreshJobImages(job), undefined, undefined, job.type === 'detect-text', false, false).catch(reportError);
        if(job.status==='done' && ['process','detect-bubbles','detect-text'].includes(job.type))setSaveNotice(processingMessage(job));
        if(job.status==='done' && job.type==='translate') {
          const count = Number(job.result?.translatedRegions ?? 0);
          const unreadable = Number(job.result?.unreadableRegions ?? 0);
          setSaveNotice(count || unreadable ? `${count} dialogue region(s) translated${unreadable ? ` · ${unreadable} crops unreadable or without dialogue` : ''}.` : 'No new dialogue to translate. Detect regions first if the page is empty.');
        }
        if (job.status === 'done' && Array.isArray(job.result?.failures) && job.result.failures.length) setError(`${job.result.failures.length} processing item(s) failed. Completed results were retained.`);
        if (job.status === 'failed') setError(job.error ?? 'Pekerjaan gagal.');
      }
    }, () => { setApi(null); setError('Koneksi progress backend terputus. Pilih Reconnect untuk memeriksa sesi dan keadaan proyek.'); });
  }, [api, refresh, reportError]);

  useEffect(() => { localStorage.setItem('yuchi-tauri-density', density); }, [density]);
  useEffect(() => { localStorage.setItem('yuchi-tauri-detection-mode', detectionMode); }, [detectionMode]);
  useEffect(() => { localStorage.setItem('yuchi-tauri-include-free-text', String(includeFreeText)); }, [includeFreeText]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && document && !settings && !exportOpen && !textEditor && !busy && !running) {
        event.preventDefault();
        cycleBubble(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && document && !settings && !exportOpen && !textEditor && !busy && !running) {
        event.preventDefault();
        approveAndAdvance();
        return;
      }
      if (event.key === '\\' && !blocksStudioShortcuts(event.target, event.isComposing) && document) {
        event.preventDefault();
        viewport.toggleDual();
        return;
      }
      if (event.key === 'PageDown' && !blocksStudioShortcuts(event.target, event.isComposing) && canNavigate) {
        const next = goToAdjacentPage(1);
        if (next) { event.preventDefault(); next(); }
        return;
      }
      if (event.key === 'PageUp' && !blocksStudioShortcuts(event.target, event.isComposing) && canNavigate) {
        const prev = goToAdjacentPage(-1);
        if (prev) { event.preventDefault(); prev(); }
        return;
      }
      if (event.key === 'Escape') {
        const activeEl = window.document.activeElement;
        if (activeEl instanceof HTMLTextAreaElement || activeEl instanceof HTMLInputElement) {
          activeEl.blur();
          return;
        }
      }
      if((event.key === 'Delete' || event.key === 'Backspace') && !blocksStudioShortcuts(event.target, event.isComposing) && !settings && !exportOpen && !textEditor && !busy && !running) {
        if (selectedDialogueId) {
          event.preventDefault();
          deleteDialogue(selectedDialogueId);
        } else if (activeTextId) {
          event.preventDefault();
          deleteTextRegion(activeTextId);
        } else if (active) {
          event.preventDefault();
          deleteActiveBubble();
        }
        return;
      }
      const shortcut = resolveStudioShortcut(event);
      if (!shortcut) return;
      if (event.ctrlKey || event.metaKey) event.preventDefault();
      if (blocksStudioShortcuts(event.target, event.isComposing) || settings || exportOpen || textEditor || regionGesture || event.repeat) return;
      event.preventDefault();
      if (shortcut === 'open' && !busy && !running) choose();
      if (shortcut === 'save' && document && !busy && !running) download('project');
      if (shortcut === 'scan' && canScan) scan();
      if (shortcut === 'undo') undo();
      if (shortcut === 'redo') redo();
      if (shortcut === 'export' && document && !busy && !running) setExportOpen(true);
      if (shortcut === 'settings') setSettings(true);
      if (shortcut === 'select') activateTool('select');
      if (shortcut === 'manual') activateTool('manual');
      if (shortcut === 'text') activateTool('text');
      if (shortcut === 'pan') activateTool('pan');
      if (shortcut === 'mask') activateTool('mask-add');
      if (shortcut === 'zoom' && document) viewport.zoomBy(1.2);
      if (shortcut === 'view' && document) viewport.toggleDual();
      if (shortcut === 'pan-hold' && !heldTool.current) { heldTool.current = tool; setTool('pan'); }
    };
    const restoreTool = () => { if (heldTool.current) { setTool(heldTool.current); heldTool.current = null; } };
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') restoreTool(); };
    window.addEventListener('keydown', key); window.addEventListener('keyup', up);
    window.addEventListener('blur', restoreTool);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', up); window.removeEventListener('blur', restoreTool); };
  });

  async function action(work: () => Promise<void>, label: string | null = null) { setError(''); setExportIssues(null); setSaveNotice(''); setBusy(true); setOperation(label); try { await work(); } catch (reason) { reportError(reason); } finally { setBusy(false); setOperation(null); } }
  const reconnect = () => void action(async () => { const client = await connect(); frames.clearCache(); await refresh(client, true); setApi(client); });
  async function flushEdits() { await sourceCommit.current; await typography.flush(); }
  const resetSelection = () => { setActiveLayer(null); setSelected(new Set()); setActiveTextId(null); setSelectedDialogueId(null); typography.select(null); setPreview(null); setMaskUrl(null); setManualRect(null); setNewDialogue(''); };
  const choose = () => { appendImport.current = false; fileInput.current?.click(); };
  const chooseFolder = () => { appendImport.current = false; folderInput.current?.click(); };
  const addPages = () => { appendImport.current = true; fileInput.current?.click(); };
  const addFolder = () => { appendImport.current = true; folderInput.current?.click(); };
  const onFiles = (files: File[]) => {
    if (!files.length || jobActive) return;
    const append = appendImport.current;
    const openingProject = files.length === 1 && files[0].name.toLowerCase().endsWith('.mangaclean');
    const discard = Boolean(displayDocument?.dirty);
    if (!append && discard && !window.confirm('Open another project and discard unsaved changes?')) return;
    void action(async () => { await flushEdits(); await typography.abandon(); const client = api ?? await connect(); setApi(client);
      const next = openingProject ? await client.upload(files[0],discard) : await client.uploadPages(files,append,discard);
      frames.clearCache();
      await refresh(client,true,next,()=>{resetSelection(); setQueuedPages(new Set()); if (!append) setDetectAll(false); setTool('select'); viewport.reset();});
    }, openingProject ? 'Opening project…' : `Importing ${files.length === 1 ? '1 image' : `${files.length} images`}…`);
  };
  const switchPage = (id: string) => {
    if (!api || jobActive || (busy && !navigation.running)) return;
    setPendingPageId(id);
    let flushed = false;
    const load = () => navigation.request(id, async (target, current) => {
      if (!flushed) { await flushEdits(); flushed = true; }
      const next = await api.post<State>(`/v1/pages/${target}/activate`);
      if (next.document?.pageId !== target) throw new Error('Backend returned a different page. Retry navigation.');
      if (current()) await refresh(api,true,next,()=>{resetSelection();viewport.reset();},false,true);
    });
    const runNavigation = async () => {
      try {
        await load();
      } catch (reason) {
        setApi(null);
        reportError(reason);
      } finally {
        setPendingPageId(null);
      }
    };
    if (navigation.running) { void load().catch(()=>{}); return; }
    void runNavigation();
  };
  const scan = (scope = detectAll ? 'all' : 'current') => { if (canScan && api) void action(async () => { await flushEdits(); setPreview(null);setMaskUrl(null);
    if (detectionMode === 'bubble') frames.clearCache();
    const ids = processingPageIds(scope,state.chapter,queuedPages);
    const job = detectionMode === 'text' ? await api.post<Job>('/v1/detect-text', {ids, include_free_text: includeFreeText})
      : await api.post<Job>('/v1/process', {provider,ids,skip_ocr:true,output_mode:composition.text_mode ?? 'clean'});
    setState(previous => ({...previous,job}));
  }); };
  const translate = (scope: 'bubble' | 'text' | 'page' | 'chapter') => {
    if (!api || !document || busy || jobActive) return;
    void action(async () => {
      const config = await api.get<TranslationSettings>('/v1/translation/capabilities');
      if (!config.configured) {
        setSettings('gemini-key');
        return;
      }
      await flushEdits(); setPreview(null); setMaskUrl(null);
      const job = await api.post<Job>('/v1/translation/start', { pageId: document.pageId, scope,
        bubbleId: scope === 'bubble' ? active?.id : undefined, regionId: scope === 'text' ? activeText?.id : undefined,
        textOnly: detectionMode === 'text' && scope !== 'bubble' });
      setState(previous => ({ ...previous, job }));
    }, 'Preparing translation…');
  };
  const excludeCandidate = () => { if(api && active) void action(async () => {await flushEdits();setState(await api.post<State>(`/v1/bubbles/${active.id}/exclude`));resetSelection();}); };
  const deleteTextRegion = (id?: string) => {
    const targetId = id || activeText?.id;
    if (!api || !targetId || busy || jobActive) return;
    void action(async () => {
      await flushEdits();
      setState(await api.post<State>(`/v1/text-regions/${encodeURIComponent(targetId)}/delete`));
      setActiveTextId(null);
      resetSelection();
    });
  };
  const deleteActiveBubble = () => {
    if (!api || !document || !active || busy || jobActive) return;
    void action(async () => {
      await flushEdits();
      setState(await api.post<State>(`/v1/bubbles/${active.id}/delete`, { pageId: document.pageId }));
      resetSelection();
    });
  };
  const addManualBubble = () => {
    if (!api || !document || !manualRect || busy || jobActive) return;
    void action(async () => {
      await flushEdits();
      const next = await api.post<State>('/v1/bubbles/manual', { pageId: document.pageId, rect: manualRect });
      setState(next); setManualRect(null); setTool('select');
      const created = next.document?.bubbles.at(-1);
      if (created) selectFromScript(created.id, false);
    });
  };
  const deleteManualBubble = () => {
    if (!api || !document || !active?.manualRegion || active.hasAppliedMask || busy || jobActive) return;
    void action(async () => {
      await flushEdits();
      setState(await api.post<State>(`/v1/bubbles/${active.id}/delete-manual`, { pageId: document.pageId }));
      resetSelection();
    });
  };
  const saveSource = () => {
    if (!api || busy || running) return;
    const value = activeText ? manualDraft : text;
    const originalValue = activeText ? sourceValue(activeText) : '';
    if (value === originalValue || (!activeText && !active && !manualRect)) return;
    const targetPage = document?.pageId;
    const client = api, identifier = activeText?.id, bubble = active?.id ?? null, rect = manualRect ?? active?.rect;
    const pending = sourceCommit.current.catch(()=>{}).then(async () => {
      const next = identifier ? await client.post<State>(`/v1/text-regions/${identifier}`,{text:value}) : await client.post<State>('/v1/text-regions',{rect,text:value,bubbleId:bubble});
      setState(previous => previous.document?.pageId===targetPage ? {...next,job:previous.job} : previous);
      if(!identifier)setActiveTextId(next.document?.textRegions.at(-1)?.id ?? null);
    });
    sourceCommit.current = pending;void pending.catch(reportError);
  };
  const exportPages = (kind: 'png' | 'jpeg') => { if(api)void action(async()=>{await flushEdits();setSaveNotice('Exporting chapter…');
    const result = await api.post<{files: {path:string}[];errors: {message:string}[];directory:string}>('/v1/pages/export',{kind,ids:[...queuedPages]});
    setSaveNotice(`Exported and verified ${result.files.length} page(s): ${result.directory}`);
    if(result.errors.length)throw new Error(`${result.errors.length} page(s) could not be exported. Existing exports were retained.`);
  }); };
  const requestSelectionPreview = (client: Api) => {
    if (detectionMode === 'text' && activeLayer === 'source' && activeText && document) {
      return client.post<Preview>(`/v1/text-regions/${encodeURIComponent(activeText.id)}/preview`, { pageId: document.pageId });
    }
    if (tool === 'manual' && manualRect) return client.post<Preview>('/v1/manual/preview', { rect: manualRect });
    if (selected.size > 1) return client.post<Preview>('/v1/bubbles/preview', { ids: [...selected] });
    return client.post<Preview>(`/v1/bubbles/${active!.id}/preview`);
  };
  const editMask = (points: Point[]) => { if (api && preview && document && !busy && !running) void action(async () => { const result = await api.post<Preview>('/v1/preview/edit', { previewId: preview.id, mode: tool === 'mask-erase' ? 'erase' : 'add', radius: brushRadius, points: points.map(point => [Math.max(0, Math.min(document.width - 1, Math.round(point.x))), Math.max(0, Math.min(document.height - 1, Math.round(point.y)))]) }); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); setShowMask(true); }); };
  const clean = () => { if (api && canClean) void action(async () => {
    await flushEdits();
    const prepared = preview ?? await requestSelectionPreview(api);
    if(!prepared.maskPixels)throw new Error('The selected area has no valid cleaning mask. Correct the mask first.');
    await api.post('/v1/clean/confirm',{previewId:prepared.id,method,radius:3});setPreview(null);setMaskUrl(null);setManualRect(null);setShowMask(false);setTool('select');await refresh(api,true);
  }, 'Cleaning selected pixels…'); };
  const selectBubble = (id: string, multi: boolean) => { if (!multi) setActiveTextId(null); setSelected(previous => { const next = multi ? new Set(previous) : new Set<string>(); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setPreview(null); setMaskUrl(null); };
  const download = (kind: string) => { if (api) void action(async () => { await flushEdits(); const receipt = await api.save(kind); setState(receipt.state); setSaveNotice((kind === 'project' ? 'Saved and verified: ' : 'Exported and verified: ') + receipt.path); }); };
  const changeComposition = (settings: PageComposition) => {
    if (!api || !document || busy || running || regionGesture) return;
    void action(async () => {
      await flushEdits();
      const next = await api.post<State>('/v1/composition', { pageId: document.pageId, settings });
      setPreview(null); setMaskUrl(null);
      if (tool.startsWith('mask-')) setTool('select');
      await refresh(api, Boolean(next.imagesChanged), next, undefined, true);
    });
  };
  const changeLayer = (id: string, patch: LayerPatch) => {
    if (!api || !document || busy || running || regionGesture) return;
    void action(async () => {
      await flushEdits();
      setState(await api.post<State>(`/v1/layers/${encodeURIComponent(id)}`, { pageId: document.pageId, ...patch }));
      setPreview(null); setMaskUrl(null);
      if (tool.startsWith('mask-')) setTool('select');
    });
  };
  const moveReadingOrder = (delta: number) => { if (api && document && activeText) void action(async () => { const ids = [...document.readingOrder]; const index = ids.indexOf(activeText.id); const destination = index + delta; if (destination < 0 || destination >= ids.length) return; [ids[index], ids[destination]] = [ids[destination], ids[index]]; await api.post('/v1/reading-order', { ids }); await refresh(api); }); };
  const canScan = Boolean(api && document && !pendingPageId && !busy && !running && !regionGesture && !textEditor && !jobActive);
  const showTextClean = detectionMode === 'text' && activeLayer === 'source' && Boolean(activeText);
  const showsWorkingArtwork = showWorking && composition.text_mode !== 'overlay' && (composition.artwork ?? 'working') === 'working';
  const textCleanGuidance = detectionMode === 'text' ? textCleanHint({ showWorking, textMode: composition.text_mode, artwork: composition.artwork, artworkLocked: composition.artwork_locked }) : '';
  const headerCleanHint = detectionMode === 'text' ? (textCleanGuidance || (!showTextClean ? 'Select a text box on the Original canvas to clean.' : undefined)) : undefined;
  const cleanTarget = detectionMode === 'text' ? showTextClean && showsWorkingArtwork : tool === 'manual' ? manualRect : active;
  const canPrepareClean = Boolean(api && document && !pendingPageId && !composition.artwork_locked && !busy && !running && !regionGesture && !textEditor);
  const canPreview = canPrepareClean && Boolean(cleanTarget);
  const validTextPreview = !preview?.textRegionId || (showTextClean && showsWorkingArtwork && preview.textRegionId === activeText?.id);
  const canClean = canPrepareClean && validTextPreview && Boolean(preview ? preview.maskPixels : cleanTarget);
  const canCleanSelected = canClean && (detectionMode === 'bubble' ||
    showTextClean && showsWorkingArtwork && (!preview || preview.textRegionId === activeText?.id));
  const healingArea = tool === 'manual' && manualRect ? { rect: manualRect }
    : tool !== 'manual' && selected.size === 1 && active && !active.excluded ? { bubbleId: active.id } : null;
  const canStartHealing = Boolean(api && document && healingArea && !composition.artwork_locked && !busy && !jobActive && !regionGesture && !textEditor);
  const prepareHealing = () => {
    if (!api || !document || !healingArea || !canStartHealing) return;
    void action(async () => {
      await flushEdits();
      setPreview(await api.post<Preview>('/v1/healing/preview', { pageId: document.pageId, ...healingArea }));
      setMaskUrl(null); setShowMask(true); setTool('mask-add');
    });
  };
  const stepHistory = (direction: 'undo' | 'redo') => {
    if (!api || !(direction === 'undo' ? document?.canUndo : document?.canRedo) || busy || running) return;
    void action(async () => {
      await flushEdits();
      const next = await api.post<State>(`/v1/${direction}`);
      setPreview(null); setMaskUrl(null);
      if (tool.startsWith('mask-')) setTool('select');
      await refresh(api, next.imagesChanged !== false, next, undefined, true);
    });
  };
  const undo = () => stepHistory('undo');
  const redo = () => stepHistory('redo');
  const activateTool = (next: Tool) => {
    if (((next === 'manual' || next === 'text') && (!document || !api || busy || running)) || (next.startsWith('mask-') && (!preview || busy || running)) || (next === 'mask-add' && preview?.textRegionId)) return;
    setTool(next);
    if (next === 'manual' || next === 'text') { setPreview(null); setMaskUrl(null); setDockTab(next === 'text' ? 'Style' : 'Script'); setRightCollapsed(false); setInspector('Text'); }
  };
  const selectFromScript = (id: string, multi: boolean) => {
    setActiveLayer('bubble');
    setSelectedDialogueId(null); typography.select(null); setText(''); setNewDialogue(''); selectBubble(id, multi);
    const region = document?.textRegions.find(item => item.bubbleId === id);
    setActiveTextId(region?.id ?? null); setInspector(region ? 'Text' : 'Review');
    setDockTab('Script'); setRightCollapsed(false);
  };
  const selectTextRegion = (id: string) => {
    setActiveLayer('source');
    const region = document?.textRegions.find(item => item.id === id);
    if (!region) return;
    setSelectedDialogueId(null); typography.select(null); setActiveTextId(id); setSelected(new Set(region.bubbleId ? [region.bubbleId] : []));
    setPreview(null); setMaskUrl(null); setManualRect(null); setTool('select');
    setInspector('Text'); setDockTab('Script'); setRightCollapsed(false);
  };
  const selectDialogue = (id: string) => {
    setActiveLayer('dialogue');
    const dialogue = document?.dialogues.find(layer => layer.id === id);
    const sources = document?.textRegions.filter(region => region.bubbleId === dialogue?.bubble_id) ?? [];
    setSelectedDialogueId(id); typography.select(id);
    setActiveTextId(dialogue?.source_region_id ?? (sources.length === 1 ? sources[0].id : null));
    setSelected(new Set(dialogue?.bubble_id ? [dialogue.bubble_id] : [])); setText(''); setPreview(null); setMaskUrl(null); setManualRect(null);
    setTool('select'); setDockTab('Style'); setRightCollapsed(false);
  };
  const editDialogue = (id: string) => { selectDialogue(id); requestAnimationFrame(() => window.document.getElementById('typography-text')?.focus()); };
  const createDialogue = (rect?: RegionRect, value = '') => {
    if (!api || !document || busy || running) return;
    void action(async () => {
      await flushEdits();
      const region = rect ? null : activeText;
      const bubble = rect ? null : active;
      const area = rect ?? region?.rect ?? bubble?.rect ?? [Math.max(0, Math.floor((document.width-240)/2)), Math.max(0, Math.floor((document.height-160)/2)), Math.min(240, document.width), Math.min(160, document.height)];
      const result = await api.post<State>('/v1/dialogues', { x: area[0], y: area[1], width: area[2], height: area[3], text: value, source_region_id: region?.id ?? null, bubble_id: region?.bubbleId ?? bubble?.id ?? null });
      const created = result.document?.dialogues.find(text => !document.dialogues?.some(old => old.id === text.id));
      setState(result); if (created) editDialogue(created.id);
    });
  };
  const deleteDialogue = (id: string) => { if (api) void action(async () => { await flushEdits(); setState(await api.post<State>(`/v1/dialogues/${encodeURIComponent(id)}/delete`)); setSelectedDialogueId(null); }); };

  const currentPageId = document?.pageId ?? '';
  const approvedBubbles = useMemo(() => approvedMap[currentPageId] ?? new Set<string>(), [approvedMap, currentPageId]);
  const bubbleStatuses = useMemo(() => {
    const map: Record<string, 'raw' | 'draft' | 'done' | 'error' | 'excluded'> = {};
    if (!document) return map;
    for (const b of document.bubbles) {
      if (b.excluded) { map[b.id] = 'excluded'; continue; }
      const d = document.dialogues?.find(item => item.bubble_id === b.id);
      const render = d ? typography.getSnapshot().layers[d.id] : undefined;
      if (render?.overflow) { map[b.id] = 'error'; continue; }
      if (approvedBubbles.has(b.id)) { map[b.id] = 'done'; continue; }
      if (d?.text?.trim() || b.cleaning === 'Cleaned') { map[b.id] = 'draft'; continue; }
      map[b.id] = 'raw';
    }
    return map;
  }, [document, approvedBubbles, typography]);

  const bubbleSummary = useMemo(() => {
    if (!document || !document.bubbles.length) return '';
    let done = 0, draft = 0, raw = 0;
    for (const b of document.bubbles) {
      if (b.excluded) continue;
      const status = bubbleStatuses[b.id];
      if (status === 'done') done++;
      else if (status === 'draft') draft++;
      else if (status === 'raw') raw++;
    }
    return `${done} ✓ ${draft} ✎ ${raw} ●`;
  }, [document, bubbleStatuses]);

  const activeBubbleIndex = active && document ? document.bubbles.indexOf(active) : -1;
  const activeBubbleLabel = activeBubbleIndex >= 0 ? `ID: ${String(activeBubbleIndex + 1).padStart(2, '0')}` : 'ID: —';

  const cycleBubble = (offset: 1 | -1) => {
    if (!document || !document.bubbles.length) return;
    const validBubbles = document.bubbles.filter(b => !b.excluded);
    if (!validBubbles.length) return;
    const currentIndex = active ? validBubbles.findIndex(b => b.id === active.id) : -1;
    const nextIndex = currentIndex < 0
      ? (offset > 0 ? 0 : validBubbles.length - 1)
      : (currentIndex + offset + validBubbles.length) % validBubbles.length;
    const target = validBubbles[nextIndex];
    if (target) {
      selectFromScript(target.id, false);
      const [bx, by, bw, bh] = target.rect;
      viewport.update({
        pan: {
          x: bx + bw / 2 - document.width / 2,
          y: by + bh / 2 - document.height / 2,
        }
      });
      requestAnimationFrame(() => {
        const input = window.document.getElementById('typography-text') as HTMLTextAreaElement | null;
        if (input) {
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      });
    }
  };

  const approveAndAdvance = () => {
    if (!active || !document) return;
    const bubbleId = active.id;
    setApprovedMap(prev => {
      const set = new Set(prev[currentPageId] ?? []);
      set.add(bubbleId);
      return { ...prev, [currentPageId]: set };
    });
    if (newDialogue.trim() && !activeDialogue) {
      createDialogue(undefined, newDialogue);
    } else if (activeDialogue) {
      void typography.flush().catch(() => {});
    }
    cycleBubble(1);
  };

  const unapproveActiveBubble = () => {
    if (active && approvedBubbles.has(active.id)) {
      setApprovedMap(prev => {
        const set = new Set(prev[currentPageId] ?? []);
        set.delete(active.id);
        return { ...prev, [currentPageId]: set };
      });
    }
  };

  const currentBubbleNumber = active && document ? document.bubbles.indexOf(active) + 1 : null;
  const currentBubbleStatus = active ? bubbleStatuses[active.id] ?? 'raw' : null;
  const bubbleHeaderNode = active && currentBubbleNumber !== null ? (
    <div className="bubble-header-bar">
      <span className="bubble-header-badge">#{String(currentBubbleNumber).padStart(2, '0')}</span>
      <span className={`bubble-header-status ${currentBubbleStatus}`}>{currentBubbleStatus}</span>
      <div className="bubble-header-nav">
        <button type="button" aria-label="Previous bubble (Shift+Tab)" title="Previous bubble (Shift+Tab)" onClick={() => cycleBubble(-1)}>‹</button>
        <button type="button" aria-label="Next bubble (Tab)" title="Next bubble (Tab)" onClick={() => cycleBubble(1)}>›</button>
      </div>
    </div>
  ) : null;
  const commitBubbleRect = async (id: string, rect: RegionRect) => {
    if (!api || busy || running) throw new Error('Wait until the editor is ready.');
    setBusy(true); setPreview(null); setMaskUrl(null);
    try { setState(await api.post<State>(`/v1/bubbles/${encodeURIComponent(id)}/geometry`, { rect })); }
    catch (reason) { reportError(reason); throw reason; }
    finally { setBusy(false); }
  };
  const commitRegionRect = async (id: string, rect: RegionRect) => {
    if (!api || busy || running) throw new Error('Wait until the local engine is ready.');
    setBusy(true); setError(''); setSaveNotice('');
    try { setState(await api.post<State>(`/v1/text-regions/${encodeURIComponent(id)}`, { rect })); }
    catch (reason) { reportError(reason); throw reason; }
    finally { setBusy(false); }
  };
  const editTextRegion = (region: TextRegion) => { if (!busy && !running) { selectTextRegion(region.id); setTextEditorError(''); setTextEditor(sessionForRegion(region)); } };
  const saveEditorText = async (value: string) => {
    if (!api || !textEditor || busy || running) return;
    setBusy(true); setError(''); setSaveNotice(''); setTextEditorError('');
    try {
      const previousIds = new Set(document?.textRegions.map(region => region.id));
      const next = textEditor.id ? await api.post<State>(`/v1/text-regions/${encodeURIComponent(textEditor.id)}`, { text: value }) : await api.post<State>('/v1/text-regions', { rect: textEditor.rect, text: value, bubbleId: null });
      setState(next); setTextEditor(null); setTool('select'); setManualRect(null);
      const id = textEditor.id ?? next.document?.textRegions.find(region => !previousIds.has(region.id))?.id ?? null;
      setActiveTextId(id); setInspector('Text'); setDockTab('Script'); setRightCollapsed(false);
    } catch (reason) { reportError(reason); setTextEditorError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  const preparePreview = () => { if (api && canPreview) void action(async () => {
    setRightCollapsed(false); setDockTab('Script');
    await flushEdits();
    const result = await requestSelectionPreview(api);
    const url = await api.image('preview-overlay');
    setPreview(result); setMaskUrl(url); setShowMask(true); setInspector('Cleaning');
  }); };
  const activeJob = jobActive ? state.job : null;
  const operationMessage = activeJob?.message || operation;
  const pages = state.chapter?.pages;
  const pageCount = pages?.length ?? 1;
  const pageIndex = pages?.findIndex(page => page.id === (pendingPageId ?? state.chapter?.activePageId)) ?? 0;
  const canNavigate = Boolean(api) && !jobActive && (!busy || navigation.running);
  const goToAdjacentPage = (offset: number) => {
    const page = pages?.[pageIndex + offset];
    return page && canNavigate ? () => switchPage(page.id) : undefined;
  };

  return <TooltipProvider delayDuration={350}><div className={`app density-${density.toLowerCase()}`}>
    <input ref={fileInput} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.mangaclean" multiple onChange={event => { onFiles([...event.target.files ?? []]); event.target.value = ''; }} />
    <input ref={folderInput} className="visually-hidden" type="file" multiple {...{webkitdirectory:''}} onChange={event=>{const images=[...event.target.files ?? []].filter(file=>/\.(png|jpe?g)$/i.test(file.name)); if (images.length) onFiles(images); else setError('No PNG or JPEG images were found in that folder.'); event.target.value='';}} />
    <StudioHeader processing={jobActive} document={displayDocument} busy={busy || running || regionGesture || Boolean(textEditor)}
      tools={document && <ToolRail tool={tool} onTool={activateTool} ready={Boolean(api)} hasPreview={Boolean(preview && !preview.textRegionId)} busy={busy || running || regionGesture || Boolean(textEditor)} canPreview={canPreview} cleanHint={headerCleanHint} onPreview={preparePreview} onHealing={()=>{setDockTab('Healing');setRightCollapsed(false);}} />}
      onOpen={choose} onOpenFolder={chooseFolder} onSave={() => download('project')} onExport={() => setExportOpen(true)} onUndo={undo} onRedo={redo} onSettings={() => setSettings(true)}
      onTranslate={api && document && !pendingPageId ? translate : undefined} onProcess={()=>scan()}
      onToggleAll={()=>setDetectAll(value=>!value)} detectAll={detectAll && pageCount > 1}
      pageCount={pageCount} pages={document ? {number:pageIndex + 1,previous:goToAdjacentPage(-1),next:goToAdjacentPage(1)} : undefined}
      view={document && <ContextToolbar leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightCollapsed(value => !value)}>
        <ViewportModeControls controller={viewport} disabled={false} />
        <label><input type="checkbox" checked={showRulers} onChange={event=>setShowRulers(event.target.checked)} /> Show pixel rulers</label>
        {state.chapter && queuedPages.size > 0 && <button disabled={!canScan} onClick={()=>scan('selected')}>Process selected pages</button>}
        <IconButton label={detectionMode === "text" ? "Toggle text boxes" : "Toggle bubble overlays"} active={showBoxes} onClick={() => setShowBoxes(value => !value)}><Layers3 size={16} /></IconButton>
        <IconButton label="Toggle mask preview" active={showMask} disabled={!maskUrl} onClick={() => setShowMask(value => !value)}><Eye size={16} /></IconButton>
      </ContextToolbar>}
      detectionMode={detectionMode} overlayMode={composition.text_mode === 'overlay'} onClean={clean} canScan={canScan} canClean={canCleanSelected} cleanHint={headerCleanHint} />
    {document && (tool === 'manual' || tool === 'text' || tool.startsWith('mask-')) && <div className="context-toolbar"><div className="context-controls">
      {(tool === 'manual' || tool === 'text') && <><span className="context-rect">{manualRect ? `Native area: ${manualRect.join(', ')}` : 'Draw a native text rectangle on either canvas'}</span><FeatureBadge>BOX</FeatureBadge></>}
      {tool.startsWith('mask-') && <><label>Radius <input aria-label="Mask brush radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} />{brushRadius}px</label><select aria-label="Preview brush mode" value={tool} onChange={event => activateTool(event.target.value as Tool)}><option value="mask-add">Add to preview mask</option><option value="mask-erase">Erase from preview mask</option></select></>}
    </div></div>}
    <main className="workarea">

      {document && !leftCollapsed && (state.chapter ? <ChapterNavigator pendingPageId={pendingPageId} processingPageId={jobActive ? state.job?.currentPageId : null} chapter={state.chapter} selected={queuedPages} expanded={navigatorExpanded} disabled={busy || jobActive} onExpand={()=>setNavigatorExpanded(value=>!value)} onPage={switchPage} onAdd={addPages} onFolder={addFolder} onSelected={(id,checked)=>setQueuedPages(previous=>{const next=new Set(previous);if(checked)next.add(id);else next.delete(id);return next;})} /> : <div className="left-dock-container" style={{width:leftWidth}}><PageNavigator document={document} originalUrl={originalUrl} original={original} working={working} controller={viewport} onCollapse={()=>setLeftCollapsed(true)} onOpen={addPages}/><button disabled={busy || jobActive} onClick={addPages}>Add pages</button></div>)}
      <div className="canvas-column">
        {saveNotice && <div className="save-notice" role="status">{saveNotice}</div>}
        {error && <div className="error-banner" role="alert"><CircleHelp size={17} /><div><span>{error}</span>{exportIssues && <><p>Halaman {exportIssues.pageNumber}: {exportIssues.pageName}. Proyek tetap dapat disimpan.</p><ul style={{ maxHeight: 160, overflowY: 'auto' }}>{exportIssues.issues.map(issue => <li key={issue.dialogueId}><strong>{issue.dialogueLabel}</strong> · {issue.candidateNumber ? `Candidate ${String(issue.candidateNumber).padStart(2, '0')}` : 'Tanpa kandidat terhubung'}<br />{issue.reason}<br />Requested: {issue.requestedFamily} / {issue.requestedWeight} / {issue.requestedSize}px · Actual: {issue.resolvedFamily ?? 'tidak tersedia'} / {issue.resolvedWeight ?? '—'} / {issue.resolvedSize ?? '—'}px<br /><small>Dialogue ID: {issue.dialogueId} · Bubble ID: {issue.bubbleId ?? '—'}</small><br /><button disabled={busy || running || document?.pageId !== exportIssues.pageId || !document?.dialogues.some(text => text.id === issue.dialogueId)} onClick={() => { const text = document?.dialogues.find(text => text.id === issue.dialogueId); if (!text || document?.pageId !== exportIssues.pageId) return; selectDialogue(text.id); setShowTypography(true); setShowSelection(true); viewport.update({ pan: { x: text.x + text.width / 2 - document.width / 2, y: text.y + text.height / 2 - document.height / 2 } }); }}>Pilih dan perbaiki Dialogue</button></li>)}</ul></>}</div>{!api && !exportIssues && <button disabled={busy} onClick={reconnect}>Reconnect</button>}<button aria-label="Dismiss error" onClick={() => { setError(''); setExportIssues(null); }}><X size={16} /></button></div>}
        {document ? <CanvasWorkspace bubbleStatuses={bubbleStatuses} detectionMode={detectionMode} showRulers={showRulers} activeLayer={cachedPreview ? null : activeLayer} typography={{ session: typography, dialogues: cachedPreview ? [] : document.dialogues ?? [], selected: selectedDialogueId, visible: !cachedPreview && showTypography, coverText: composition.text_mode === 'overlay', onSelect: selectDialogue, onEdit: selectDialogue }} interaction={interaction} editable={Boolean(api) && !pendingPageId && !busy && !running && !textEditor} showRegions={showRegions} showSelection={!cachedPreview && showSelection} onEditText={editTextRegion} onDeselect={() => { setActiveLayer(null);setSelected(new Set()); setActiveTextId(null); setSelectedDialogueId(null); typography.select(null); setPreview(null); setMaskUrl(null); }} onCommitBubble={commitBubbleRect} onCommitRegion={commitRegionRect} onGesture={value => { setRegionGesture(value); if (value) { setSaveNotice(''); setPreview(null); setMaskUrl(null); } }} controller={viewport} original={cachedPreview?.original ?? original} working={cachedPreview?.working ?? working} containers={containers} mask={cachedPreview ? null : mask} width={cachedPreview ? pendingPage!.width : document.width} height={cachedPreview ? pendingPage!.height : document.height} name={cachedPreview ? pendingPage!.name : document.sourceName} bubbles={cachedPreview ? (cachedPreview.bubbles ?? []) : document.bubbles.filter(bubble=>!bubble.excluded)} textRegions={cachedPreview ? cachedPreview.textRegions ?? [] : document.textRegions} selected={cachedPreview ? emptySelection : selected} selectedTextId={cachedPreview ? null : activeTextId} tool={pendingPageId ? 'select' : tool} brushRadius={brushRadius} showBoxes={showBoxes} showMask={!cachedPreview && showMask} showOriginal={showOriginal} showWorking={showWorking} onBubble={selectFromScript} onRect={rect => { setManualRect(rect); if (tool === 'text') createDialogue(rect); }} onBrush={editMask} onText={selectTextRegion} /> : <div className="empty-workspace"><div className="empty-content"><div className="empty-icon"><MangaCleanLogo size={32} /></div><h1>Open a page to get started</h1><p>Press Ctrl+O, or choose a chapter folder.</p><div className="empty-actions"><button className="text-command primary large" onClick={choose}><FolderOpen size={18} /> Open Image or Project</button><button className="text-command large" onClick={chooseFolder}>Open Chapter Folder</button></div><span className="empty-hint">PNG, JPEG, or .mangaclean · Processing stays on this computer</span></div></div>}
      </div>
      {document && !rightCollapsed && <div className="right-dock-container" inert={Boolean(pendingPageId)} style={{ width: rightWidth }}><InspectorDock cardTypography={bubble => <TypographyCardControls session={typography} dialogues={document?.dialogues ?? []} bubbleId={bubble.id} selected={selectedDialogueId} disabled={!api || !document || busy || running || regionGesture || Boolean(textEditor)} onTarget={id => { setSelectedDialogueId(id); typography.select(id); setActiveTextId(null); }} />} document={document} selected={selected} onSelect={selectFromScript} tab={dockTab} onTab={setDockTab} onCollapse={() => setRightCollapsed(true)} layerControls={<>
        <label className="layer-control"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />Raw Artwork<span>Original preview</span></label>
        <label className="layer-control"><input type="checkbox" checked={showWorking} onChange={event => setShowWorking(event.target.checked)} />Cleaned / Working<span>Editing preview</span></label>
        <label className="layer-control">Artwork in Editing and export<select aria-label="Artwork source" value={composition.artwork ?? 'working'} disabled={!api || busy || running || regionGesture} onChange={event => changeComposition({ artwork: event.target.value as PageComposition['artwork'] })}><option value="working">{composition.text_mode === 'overlay' ? 'Original (overlay base)' : 'Cleaned / Working'}</option><option value="original">Raw artwork</option><option value="hidden">Hidden (white background)</option></select></label>
        <label className="layer-control"><input type="checkbox" checked={Boolean(composition.artwork_locked)} disabled={!api || busy || running || regionGesture} onChange={event => changeComposition({ artwork_locked: event.target.checked })} />Lock working artwork</label>
        <label className="layer-control"><input type="checkbox" checked={showTypography} onChange={event => setShowTypography(event.target.checked)} />Typography overlay<span>Workspace preview</span></label>
        <TypographyLayerList session={typography} dialogues={document?.dialogues ?? []} selected={selectedDialogueId} onSelect={selectDialogue} onLayer={changeLayer} disabled={!api || busy || running || regionGesture} />
        <label className="layer-control"><input type="checkbox" checked={showRegions} onChange={event => setShowRegions(event.target.checked)} />TextRegion geometry</label>
        <label className="layer-control"><input type="checkbox" checked={showSelection} onChange={event => setShowSelection(event.target.checked)} />Selection handles</label>
        <label className="layer-control"><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} />Candidate overlays</label>
        <label className="layer-control"><input type="checkbox" checked={showMask} disabled={!maskUrl} onChange={event => setShowMask(event.target.checked)} />Cleaning preview mask</label>
      </>} healingControls={<section className="selection-properties" aria-label="Healing controls">
        <h2>Healing</h2>
        <p>Select one bubble or draw a repair area on the Editing canvas. Then paint the pixels to repair.</p>
        <button disabled={!api || busy || jobActive} onClick={() => { resetSelection(); activateTool('manual'); setDockTab('Healing'); }}>Draw healing area</button>
        <button disabled={!canStartHealing} onClick={prepareHealing}>Start empty mask</button>
        {manualRect && <p>{manualRect[2]} × {manualRect[3]} px repair area</p>}
        <label>Healing brush radius · {brushRadius} px<input type="range" min="1" max="40" value={brushRadius} disabled={busy || running} onChange={event => setBrushRadius(Number(event.target.value))} /></label>
        {preview && <>
          <p role="status">{preview.maskPixels.toLocaleString()} mask pixels</p>
          <button aria-pressed={tool === 'mask-add'} disabled={busy || running} onClick={() => activateTool('mask-add')}>Add to mask</button>
          <button aria-pressed={tool === 'mask-erase'} disabled={busy || running} onClick={() => activateTool('mask-erase')}>Erase from mask</button>
          <label>Method<select value={method} onChange={event => setMethod(event.target.value)}><option>Auto / Recommended</option><option>Telea Inpainting</option><option>White Bubble Clean</option></select></label>
          <button disabled={!canClean} onClick={clean}>Apply healing</button>
          <button disabled={busy || running} onClick={() => { setPreview(null); setMaskUrl(null); setTool(manualRect ? 'manual' : 'select'); }}>Discard mask</button>
        </>}
      </section>} imageControls={<ImageAdjustments key={document.pageId} settings={composition} disabled={!api || busy || running || regionGesture || Boolean(composition.artwork_locked)} onChange={changeComposition} />}>
        <section className="selection-properties" aria-label="Selected object properties">
          {active || activeText || activeDialogue || manualRect ? <>
            <div className="selection-title">
              <h2>{detectionMode === 'text' && activeLayer === 'source' ? (activeText ? `Text ${activeText.id.slice(0, 4)}` : 'Text region') : active ? `Bubble ${String(document!.bubbles.indexOf(active)+1).padStart(2,'0')}` : activeDialogue ? 'Dialogue' : 'Text region'}</h2>
              <div className="selection-actions">
                {detectionMode === 'text' && activeText && (
                  <button type="button" className="delete-action-btn" disabled={busy || running} onClick={() => deleteTextRegion()} title="Hapus text region ini (Del / Backspace)">
                    <Trash2 size={12} />
                    <span>Hapus</span>
                  </button>
                )}
                {active && (
                  <button type="button" className="delete-action-btn" disabled={busy || running} onClick={deleteActiveBubble} title="Hapus bubble ini (Del / Backspace)">
                    <Trash2 size={12} />
                    <span>Hapus</span>
                  </button>
                )}
                {detectionMode === 'bubble' && active && <button disabled={busy || running} onClick={excludeCandidate} title="Exclude candidate from processing">Exclude</button>}
              </div>
            </div>
            {tool === 'manual' && manualRect && <button disabled={!api || busy || jobActive} onClick={addManualBubble}>Add manual bubble region</button>}
            {active?.manualRegion && <button disabled={!api || busy || jobActive || active.hasAppliedMask} title={active.hasAppliedMask ? 'Undo cleaning before deleting this region' : 'Keep linked text and artwork'} onClick={deleteManualBubble}>Delete manual bubble region</button>}
            {document && <>{linkedDialogues.length > 1 && <TypographyLayerList session={typography} dialogues={linkedDialogues} selected={activeDialogue?.id ?? null} onSelect={selectDialogue} />}
              <TypographyControls api={api} session={typography} selected={activeDialogue} disabled={!api || busy || running || regionGesture} onCreate={() => createDialogue()} onDelete={deleteDialogue} bubbleHeader={bubbleHeaderNode} onApprove={approveAndAdvance} sourceControls={<>
              <div className="source-field-container"><label htmlFor="source-ocr-text">Original (Source)</label><textarea id="source-ocr-text" aria-label="Source transcription" value={activeText ? manualDraft : text} onFocus={()=>{sourceFocused.current=true;}} onBlur={()=>{sourceFocused.current=false;saveSource();}} onChange={event => { unapproveActiveBubble(); if (activeText) setManualDraft(event.target.value); else setText(event.target.value); }} disabled={busy || running} placeholder="Original transcription..." /></div>
              {!activeDialogue && <div className="translation-field-container"><div className="field-header-row"><label htmlFor="typography-text">Translation</label><span className="char-counter">{newDialogue.length} chars</span></div><textarea id="typography-text" aria-label="New Indonesian dialogue" value={newDialogue} onChange={event=>{ unapproveActiveBubble(); setNewDialogue(event.target.value); }} onBlur={()=>{if(newDialogue.trim())createDialogue(undefined,newDialogue);}} disabled={busy || running} placeholder="Enter Indonesian dialogue..."/></div>}
              </>} sourceOptions={<>
              <details><summary>Source options</summary>
                {detectionMode === 'text' && activeText && <button disabled={!api || busy || jobActive} onClick={() => translate('text')}>Translate this text</button>}
                {detectionMode === 'bubble' && active && <button disabled={!api || busy || jobActive} onClick={() => translate('bubble')}>Translate this bubble</button>}
                {activeText && <button disabled={busy || jobActive} onClick={()=>api && void action(async()=>{await flushEdits();const job=await api.post<Job>(`/v1/text-regions/${activeText.id}/ocr`,{device:'cpu',language:'auto'});setState(previous=>({...previous,job}));})}>Retry text recognition for this region</button>}
                {activeText && <><label>Source bounds<input value={cropDraft} onChange={e => setCropDraft(e.target.value)} /></label><label>Reading direction<select value={directionDraft} onChange={e => setDirectionDraft(e.target.value)}><option value="unspecified">Unspecified</option><option value="vertical">Vertical</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label><button onClick={() => api && void action(async () => { const parts=cropDraft.split(',').map(v => v.trim()); if(parts.length!==4 || parts.some(v => !/^\d+$/.test(v))) throw new Error('Enter four integer coordinates.'); setState(await api.post<State>(`/v1/text-regions/${activeText.id}`,{rect:parts.map(Number),direction:directionDraft})); setPreview(null);setMaskUrl(null); })}>Apply source bounds</button><button disabled={busy || running} onClick={() => moveReadingOrder(-1)}>Read earlier</button><button disabled={busy || running} onClick={() => moveReadingOrder(1)}>Read later</button><label>Raw OCR original<textarea readOnly value={activeText.ocr?.raw_text ?? ''}/></label></>}
              </details></>} /></>}
            {(detectionMode === 'bubble' || showTextClean) && <section><h3>{showTextClean ? 'Text Cleaning' : 'Bubble / Cleaning'}</h3><button disabled={!canPreview} title={showTextClean && textCleanGuidance ? textCleanGuidance : undefined} onClick={preparePreview}>Preview Mask</button><button disabled={!canCleanSelected} title={showTextClean && textCleanGuidance ? textCleanGuidance : undefined} onClick={clean}>Clean Selected</button>
              {showTextClean && textCleanGuidance && <p>{textCleanGuidance}</p>}
              <label>Method<select value={method} onChange={event => setMethod(event.target.value)}><option>Auto / Recommended</option><option>Telea Inpainting</option><option>White Bubble Clean</option></select></label>
              {preview && <><p>Inspect the mask before confirming cleaning.</p>{!preview.textRegionId && <button onClick={() => activateTool('mask-add')}>Correct mask</button>}<button onClick={() => activateTool('mask-erase')}>Erase from mask</button><label>Brush radius<input type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} /></label>{Array.isArray(preview.analysis.warnings) && preview.analysis.warnings.map((warning, i) => <p className="warning-note" key={i}>{String(warning)}</p>)}</>}
            </section>}
          </> : <><p>Select a bubble or dialogue on the canvas.</p><TypographyControls api={api} session={typography} selected={null} disabled={true} onCreate={() => createDialogue()} onDelete={deleteDialogue} sourceControls={null} /></>}
        </section>
      </InspectorDock><DockResizeHandle side="right" width={rightWidth} minimum={280} maximum={320} onResize={setRightWidth} /></div>}
    </main>
    {operationMessage && <div className="operation-overlay"><div className="operation-card"><div className="operation-spinner" role="progressbar" /><p role="status">{operationMessage}</p><progress aria-label="Operation progress" max={1} value={activeJob && typeof activeJob.progress === 'number' && activeJob.progress > 0 ? Math.min(1, activeJob.progress) : undefined} />{activeJob && <button disabled={activeJob.cancelRequested} onClick={() => { if (api) void api.post(`/v1/jobs/${activeJob.id}/cancel`).catch(reportError); }}>{activeJob.cancelRequested ? 'Cancelling…' : 'Cancel'}</button>}</div></div>}
    <EngineStatusBar activeBubbleLabel={activeBubbleLabel} bubbleSummary={bubbleSummary} zoom={document && <ViewportZoomControls controller={viewport} />} connected={Boolean(api)} document={displayDocument} job={state.job} selected={selected.size} tool={tool} controller={viewport} onCancel={() => api && state.job && void action(async () => { await api.post(`/v1/jobs/${state.job!.id}/cancel`); })} />
    {textEditor && <SourceTextDialog session={textEditor} busy={busy} error={textEditorError} onClose={() => { if (!busy) setTextEditor(null); }} onSave={value => void saveEditorText(value)} />}
    {settings && <PreferencesDialog api={api} needsGeminiKey={settings === 'gemini-key'} onClose={() => setSettings(false)} density={density} onDensity={setDensity} exportFormat={exportFormat} onExportFormat={setExportFormat} provider={provider} onProvider={setProvider} detectionMode={detectionMode} onDetectionMode={mode => { setDetectionMode(mode); setShowBoxes(true); resetSelection(); if (tool.startsWith('mask-')) setTool('select'); }} textMode={composition.text_mode ?? 'clean'} onTextMode={document && api ? mode => changeComposition({text_mode:mode}) : undefined} includeFreeText={includeFreeText} onIncludeFreeText={setIncludeFreeText} busy={busy || jobActive || regionGesture || Boolean(textEditor)} onReset={() => { setDensity('Balanced'); setLeftCollapsed(window.innerWidth < 1120); setRightCollapsed(false); setLeftWidth(220); setRightWidth(300); viewport.reset(); }} />}
    {exportOpen && document && <QuickExportDialog chapterCount={state.chapter?.pages.length} onExportPages={exportPages} typographyNotice={<TypographyExportNotice session={typography} count={document.dialogues?.filter(text => text.visible).length ?? 0} />} onClose={() => setExportOpen(false)} width={document.width} height={document.height} busy={busy || running} onExport={kind => { setExportFormat(kind); setExportOpen(false); download(kind); }} />}
  </div></TooltipProvider>;
}
