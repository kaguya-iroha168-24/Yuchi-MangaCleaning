import { sourceValue } from './ui/sourceText';
import { processingPageIds, processingMessage, refreshJobImages } from './ui/processing';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@radix-ui/react-tooltip';
import { Aperture, CircleHelp, Eye, FolderOpen, Layers3, X } from 'lucide-react';
import { Api, ApiError, type ExportPreflight, type Job, type Preview, type State, type TextRegion, connect } from './api';
import { ChapterNavigator } from './components/ChapterNavigator';
import { ContextToolbar, DockResizeHandle, EngineStatusBar, FeatureBadge, InspectorDock, PageNavigator, StudioHeader, ToolRail, type DockTab, type WorkflowStep } from './components/StudioShell';
import { PreferencesDialog, QuickExportDialog } from './components/PreferencesDialog';
import { blocksStudioShortcuts, resolveStudioShortcut } from './ui/shortcuts';
import { CanvasWorkspace, ViewportModeControls } from './components/CanvasWorkspace';
import { SourceTextDialog, sessionForRegion, type TextEditSession } from './components/SourceTextDialog';
import { RegionInteraction, type RegionRect } from './ui/regionEditing';
import { TypographySession } from './ui/typography';
import { TypographyCardControls, TypographyControls, TypographyLayerList, TypographyExportNotice } from './components/Typography';
import { ViewportController, type Point } from './ui/viewport';

type Workspace = 'Quick Clean' | 'Studio' | 'Review';
type Tool = 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase';
type Density = 'Balanced' | 'Compact' | 'Comfortable';
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
  const [step, setStep] = useState<WorkflowStep>(1);
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
  const [showTypography, setShowTypography] = useState(true);
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem('yuchi-tauri-density') as Density) || 'Balanced');
  const [settings, setSettings] = useState(false);
  const [exportFormat, setExportFormat] = useState<'png' | 'jpeg'>('png');
  const [tool, setTool] = useState<Tool>('select');
  const viewport = useMemo(() => new ViewportController(), []);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showBoxes, setShowBoxes] = useState(true);
  const [showMask, setShowMask] = useState(false);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);

  const [brushRadius, setBrushRadius] = useState(5);
  const [workingUrl, setWorkingUrl] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [method, setMethod] = useState('Auto / Recommended');
  const [provider, setProvider] = useState('shima_v1');
  const [device, setDevice] = useState(() => localStorage.getItem('yuchi-tauri-device') || 'auto');
  const [, setInspector] = useState<'Review' | 'Cleaning' | 'Text'>('Review');
  const [manualRect, setManualRect] = useState<[number, number, number, number] | null>(null);
  const [text, setText] = useState('');
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const [cropDraft, setCropDraft] = useState('');
  const [directionDraft, setDirectionDraft] = useState('unspecified');
  const [newDialogue, setNewDialogue] = useState('');
  const [queuedPages, setQueuedPages] = useState<Set<string>>(new Set());
  const [scanScope, setScanScope] = useState('all');
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
  const original = useImage(originalUrl);
  const working = useImage(workingUrl);
  const containers = null;
  const mask = useImage(maskUrl);
  const document = state.document;
  const active = useMemo(() => document?.bubbles.find(bubble => selected.has(bubble.id)) ?? null, [document, selected]);
  const activeText = useMemo(() => document?.textRegions.find(region => region.id === activeTextId) ?? null, [document, activeTextId]);
  const sourceDirty = activeText ? manualDraft !== (sourceValue(activeText)) : Boolean(text);
  const displayDocument = document && (sourceDirty || Boolean(newDialogue && !selectedDialogueId) || regionGesture || textEditor || typographyDirty || state.chapter?.dirty) ? { ...document, dirty: true } : document;
  const activeDialogue = document?.dialogues?.find(text => text.id === selectedDialogueId) ?? null;
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


  const refresh = useCallback(async (client: Api, withImages = false) => {
    const next = await client.get<State>('/v1/state');
    setState(next);
    if (withImages && next.document) {
      const [source, result] = await Promise.all([client.image('original'), client.image('working')]);
      setOriginalUrl(previous => { if (previous) URL.revokeObjectURL(previous); return source; });
      setWorkingUrl(previous => { if (previous) URL.revokeObjectURL(previous); return result; });
    } else if (withImages) {
      for (const setter of [setOriginalUrl, setWorkingUrl, setMaskUrl]) setter(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
      setPreview(null); setSelected(new Set()); setActiveTextId(null); setManualRect(null);
    }
  }, []);

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
        void refresh(api, refreshJobImages(job)).catch(reportError);
        if(job.status==='done' && job.type==='process')setSaveNotice(processingMessage(job));
        if (job.status === 'done' && Array.isArray(job.result?.failures) && job.result.failures.length) setError(`${job.result.failures.length} processing item(s) failed. Completed results were retained.`);
        if (job.status === 'failed') setError(job.error ?? 'Pekerjaan gagal.');
      }
    }, () => { setApi(null); setError('Koneksi progress backend terputus. Pilih Reconnect untuk memeriksa sesi dan keadaan proyek.'); });
  }, [api, refresh, reportError]);

  useEffect(() => { localStorage.setItem('yuchi-tauri-density', density); }, [density]);
  useEffect(() => { localStorage.setItem('yuchi-tauri-device', device); }, [device]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if(event.key==='Delete' && !blocksStudioShortcuts(event.target,event.isComposing) && !settings && !exportOpen && !textEditor && !busy && !running){ event.preventDefault(); if(selectedDialogueId)deleteDialogue(selectedDialogueId);else excludeCandidate();return; }
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

  async function action(work: () => Promise<void>) { setError(''); setExportIssues(null); setSaveNotice(''); setBusy(true); try { await work(); } catch (reason) { reportError(reason); } finally { setBusy(false); } }
  const reconnect = () => void action(async () => { const client = await connect(); await refresh(client, true); setApi(client); });
  async function flushEdits() { await sourceCommit.current; await typography.flush(); }
  const resetSelection = () => { setActiveLayer(null); setSelected(new Set()); setActiveTextId(null); setSelectedDialogueId(null); typography.select(null); setPreview(null); setMaskUrl(null); setManualRect(null); setNewDialogue(''); };
  const choose = () => { appendImport.current = false; fileInput.current?.click(); };
  const addPages = () => { appendImport.current = true; fileInput.current?.click(); };
  const addFolder = () => { appendImport.current = true; folderInput.current?.click(); };
  const onFiles = (files: File[]) => {
    if (!files.length || jobActive) return;
    const append = appendImport.current;
    const discard = Boolean(displayDocument?.dirty);
    if (!append && discard && !window.confirm('Open another project and discard unsaved changes?')) return;
    void action(async () => { await flushEdits(); await typography.abandon(); const client = api ?? await connect(); setApi(client);
      const next = files.length === 1 && files[0].name.toLowerCase().endsWith('.mangaclean') ? await client.upload(files[0],discard) : await client.uploadPages(files,append,discard);
      setState(next); resetSelection(); setQueuedPages(new Set()); setTool('select'); viewport.reset(); await refresh(client,true);
    });
  };
  const switchPage = (id: string) => { if (api && !jobActive) void action(async () => { await flushEdits(); const next = await api.post<State>(`/v1/pages/${id}/activate`); resetSelection(); setOriginalUrl(null);setWorkingUrl(null);setState(next);viewport.reset();await refresh(api,true); }); };
  const scan = (automatic=false) => { if (api && !jobActive) void action(async () => { await flushEdits(); setPreview(null);setMaskUrl(null);
    const ids = processingPageIds(scanScope,state.chapter,queuedPages);
    const job = await api.post<Job>(automatic ? '/v1/process' : '/v1/scan-detect',{provider,device,ids});setState(previous => ({...previous,job}));
  }); };
  const excludeCandidate = () => { if(api && active) void action(async () => {await flushEdits();setState(await api.post<State>(`/v1/bubbles/${active.id}/exclude`));resetSelection();}); };
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
  const previewBubble = () => { if (api && active) void action(async () => { const result = selected.size > 1 ? await api.post<Preview>('/v1/bubbles/preview', { ids: [...selected] }) : await api.post<Preview>(`/v1/bubbles/${active.id}/preview`); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); setShowMask(true); setInspector('Cleaning'); }); };
  const previewManual = () => { if (api && manualRect) void action(async () => { const result = await api.post<Preview>('/v1/manual/preview', { rect: manualRect }); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); setShowMask(true); setInspector('Cleaning'); }); };
  const editMask = (points: Point[]) => { if (api && preview && document) void action(async () => { const result = await api.post<Preview>('/v1/preview/edit', { previewId: preview.id, mode: tool === 'mask-erase' ? 'erase' : 'add', radius: brushRadius, points: points.map(point => [Math.max(0, Math.min(document.width - 1, Math.round(point.x))), Math.max(0, Math.min(document.height - 1, Math.round(point.y)))]) }); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); }); };
  const clean = () => { if (api && (preview || active || manualRect)) void action(async () => {
    await flushEdits();let prepared=preview;
    if(!prepared){ prepared = tool === 'manual' && manualRect ? await api.post<Preview>('/v1/manual/preview',{rect:manualRect}) : selected.size>1 ? await api.post<Preview>('/v1/bubbles/preview',{ids:[...selected]}) : await api.post<Preview>(`/v1/bubbles/${active!.id}/preview`);
    }
    if(!prepared.maskPixels)throw new Error('The selected area has no valid cleaning mask. Correct the mask first.');
    await api.post('/v1/clean/confirm',{previewId:prepared.id,method,radius:3});setPreview(null);setMaskUrl(null);setShowMask(false);setTool('select');await refresh(api,true);
  }); };
  const selectBubble = (id: string, multi: boolean) => { if (!multi) setActiveTextId(null); setSelected(previous => { const next = multi ? new Set(previous) : new Set<string>(); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setPreview(null); setMaskUrl(null); };
  const download = (kind: string) => { if (api) void action(async () => { await flushEdits(); const receipt = await api.save(kind); setState(receipt.state); setSaveNotice((kind === 'project' ? 'Saved and verified: ' : 'Exported and verified: ') + receipt.path); }); };
  const moveReadingOrder = (delta: number) => { if (api && document && activeText) void action(async () => { const ids = [...document.readingOrder]; const index = ids.indexOf(activeText.id); const destination = index + delta; if (destination < 0 || destination >= ids.length) return; [ids[index], ids[destination]] = [ids[destination], ids[index]]; await api.post('/v1/reading-order', { ids }); await refresh(api); }); };
  const canScan = Boolean(api && document && !busy && !running && !regionGesture && !textEditor && !jobActive);
  const canPreview = Boolean(api && document && !busy && !running && !regionGesture && !textEditor && (tool === 'manual' ? manualRect : active));
  const canClean = Boolean(api && document && (preview?.maskPixels || active || manualRect) && !busy && !running && !regionGesture);
  const undo = () => { if (api && document?.canUndo && !busy && !running) void action(async () => { await flushEdits(); const result = await api.post<State>('/v1/undo'); setState(result); if (result.imagesChanged !== false) await refresh(api, true); }); };
  const redo = () => { if (api && document?.canRedo && !busy && !running) void action(async () => { await flushEdits(); const result = await api.post<State>('/v1/redo'); setState(result); if (result.imagesChanged !== false) await refresh(api, true); }); };
  const activateTool = (next: Tool) => {
    if (((next === 'manual' || next === 'text') && (!document || !api || busy || running)) || (next.startsWith('mask-') && (!preview || busy || running))) return;
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
  const changeStep = (next: WorkflowStep) => { setStep(next); setRightCollapsed(false); setDockTab(next === 3 ? 'Style' : 'Script'); if (next === 2) setInspector('Text'); if (next === 4 && document) setExportOpen(true); };
  const preset = (next: Workspace) => { setLeftCollapsed(next === 'Quick Clean'); setRightCollapsed(false); setDockTab('Script'); if (next === 'Review') setInspector('Review'); };
  const preparePreview = () => { setRightCollapsed(false); setDockTab('Script'); if (tool === 'manual') previewManual(); else previewBubble(); };

  return <TooltipProvider delayDuration={350}><div className={`app density-${density.toLowerCase()}`}>
    <input ref={fileInput} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.mangaclean" multiple onChange={event => { onFiles([...event.target.files ?? []]); event.target.value = ''; }} />
    <input ref={folderInput} className="visually-hidden" type="file" multiple {...{webkitdirectory:''}} onChange={event=>{onFiles([...event.target.files ?? []].filter(file=>/\.(png|jpe?g)$/i.test(file.name)));event.target.value='';}} />
    <StudioHeader processing={jobActive} tools={document ? <ToolRail tool={tool} onTool={activateTool} ready={Boolean(document && api)} hasPreview={Boolean(preview)} busy={busy || running} onZoom={()=>viewport.zoomBy(1.2)} /> : null} document={displayDocument} busy={busy || running || regionGesture || Boolean(textEditor)} step={step} onStep={changeStep} onOpen={choose} onSave={() => download('project')} onExport={() => setExportOpen(true)} onUndo={undo} onRedo={redo} onSettings={() => setSettings(true)} onScan={()=>scan(false)} onProcess={()=>scan(true)} onPreview={preparePreview} onClean={clean} canScan={canScan} canPreview={canPreview} canClean={canClean} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightCollapsed(value => !value)} onPreset={preset} onOcr={()=>scan(false)} canOcr={Boolean(api && (active || activeText) && !busy && !running)} onAddText={() => createDialogue()} />
    {document && <ContextToolbar tool={tool} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightCollapsed(value => !value)}>
      {state.chapter && <select aria-label="Processing pages" value={scanScope} disabled={jobActive} onChange={event=>setScanScope(event.target.value)}><option value="current">Current page</option><option value="selected">Selected pages</option><option value="all">All pages</option></select>}
      {(tool === 'manual' || tool === 'text') && <><span className="context-rect">{manualRect ? `Native area: ${manualRect.join(', ')}` : 'Draw a native text rectangle on either canvas'}</span><FeatureBadge>BOX</FeatureBadge></>}
      {tool.startsWith('mask-') && <><label>Radius <input aria-label="Mask brush radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} />{brushRadius}px</label><select aria-label="Preview brush mode" value={tool} onChange={event => activateTool(event.target.value as Tool)}><option value="mask-add">Add to preview mask</option><option value="mask-erase">Erase from preview mask</option></select></>}
      <IconButton label="Toggle bubble overlays" active={showBoxes} onClick={() => setShowBoxes(value => !value)}><Layers3 size={16} /></IconButton><IconButton label="Toggle mask preview" active={showMask} disabled={!maskUrl} onClick={() => setShowMask(value => !value)}><Eye size={16} /></IconButton>
      <ViewportModeControls controller={viewport} disabled={!document} />
    </ContextToolbar>}
    <main className="workarea">

      {document && !leftCollapsed && (state.chapter ? <ChapterNavigator processingPageId={jobActive ? state.job?.currentPageId : null} chapter={state.chapter} selected={queuedPages} expanded={navigatorExpanded} disabled={busy || jobActive} onExpand={()=>setNavigatorExpanded(value=>!value)} onPage={switchPage} onAdd={addPages} onFolder={addFolder} onSelected={(id,checked)=>setQueuedPages(previous=>{const next=new Set(previous);if(checked)next.add(id);else next.delete(id);return next;})} /> : <div className="left-dock-container" style={{width:leftWidth}}><PageNavigator document={document} originalUrl={originalUrl} original={original} working={working} controller={viewport} onCollapse={()=>setLeftCollapsed(true)} onOpen={addPages}/><button disabled={busy || jobActive} onClick={addPages}>Add pages</button></div>)}
      <div className="canvas-column">
        {saveNotice && <div className="save-notice" role="status">{saveNotice}</div>}
        {error && <div className="error-banner" role="alert"><CircleHelp size={17} /><div><span>{error}</span>{exportIssues && <><p>Halaman {exportIssues.pageNumber}: {exportIssues.pageName}. Proyek tetap dapat disimpan.</p><ul style={{ maxHeight: 160, overflowY: 'auto' }}>{exportIssues.issues.map(issue => <li key={issue.dialogueId}><strong>{issue.dialogueLabel}</strong> · {issue.candidateNumber ? `Candidate ${String(issue.candidateNumber).padStart(2, '0')}` : 'Tanpa kandidat terhubung'}<br />{issue.reason}<br />Requested: {issue.requestedFamily} / {issue.requestedWeight} / {issue.requestedSize}px · Actual: {issue.resolvedFamily ?? 'tidak tersedia'} / {issue.resolvedWeight ?? '—'} / {issue.resolvedSize ?? '—'}px<br /><small>Dialogue ID: {issue.dialogueId} · Bubble ID: {issue.bubbleId ?? '—'}</small><br /><button disabled={busy || running || document?.pageId !== exportIssues.pageId || !document?.dialogues.some(text => text.id === issue.dialogueId)} onClick={() => { const text = document?.dialogues.find(text => text.id === issue.dialogueId); if (!text || document?.pageId !== exportIssues.pageId) return; selectDialogue(text.id); setShowTypography(true); setShowSelection(true); viewport.update({ pan: { x: text.x + text.width / 2 - document.width / 2, y: text.y + text.height / 2 - document.height / 2 } }); }}>Pilih dan perbaiki Dialogue</button></li>)}</ul></>}</div>{!exportIssues && <button disabled={busy} onClick={reconnect}>Reconnect</button>}<button aria-label="Dismiss error" onClick={() => { setError(''); setExportIssues(null); }}><X size={16} /></button></div>}
        {document ? <CanvasWorkspace activeLayer={activeLayer} typography={{ session: typography, dialogues: document.dialogues ?? [], selected: selectedDialogueId, visible: showTypography, onSelect: selectDialogue, onEdit: editDialogue }} interaction={interaction} editable={Boolean(api) && !busy && !running && !textEditor} showRegions={showRegions} showSelection={showSelection} onEditText={editTextRegion} onDeselect={() => { setActiveLayer(null);setSelected(new Set()); setActiveTextId(null); setSelectedDialogueId(null); typography.select(null); setPreview(null); setMaskUrl(null); }} onCommitBubble={commitBubbleRect} onCommitRegion={commitRegionRect} onGesture={value => { setRegionGesture(value); if (value) { setSaveNotice(''); setPreview(null); setMaskUrl(null); } }} controller={viewport} original={original} working={working} containers={containers} mask={mask} width={document.width} height={document.height} name={document.sourceName} bubbles={document.bubbles.filter(bubble=>!bubble.excluded)} textRegions={document.textRegions} selected={selected} selectedTextId={activeTextId} tool={tool} brushRadius={brushRadius} showBoxes={showBoxes} showMask={showMask} showOriginal={showOriginal} showWorking={showWorking} onBubble={selectFromScript} onRect={rect => { setManualRect(rect); if (tool === 'text') createDialogue(rect); }} onBrush={editMask} onText={selectTextRegion} /> : <div className="empty-workspace"><div className="empty-content"><div className="empty-icon"><Aperture size={31} /></div><h1>MangaClean Atelier</h1><p>Open a page to start editing.</p><div className="empty-actions"><button className="text-command primary large" onClick={choose}><FolderOpen size={18} /> Open Image or Project</button></div><span className="empty-hint">PNG, JPEG, or .mangaclean · Processing stays on this computer</span></div></div>}
      </div>
      {document && !rightCollapsed && <div className="right-dock-container" style={{ width: rightWidth }}><InspectorDock cardTypography={bubble => <TypographyCardControls session={typography} dialogues={document?.dialogues ?? []} bubbleId={bubble.id} selected={selectedDialogueId} disabled={!api || !document || busy || running || regionGesture || Boolean(textEditor)} onTarget={id => { setSelectedDialogueId(id); typography.select(id); setActiveTextId(null); }} />} document={document} selected={selected} onSelect={selectFromScript} tab={dockTab} onTab={setDockTab} onCollapse={() => setRightCollapsed(true)} layerControls={<>
        <label className="layer-control"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />Raw Artwork<span>Original preview</span></label>
        <label className="layer-control"><input type="checkbox" checked={showWorking} onChange={event => setShowWorking(event.target.checked)} />Cleaned / Working<span>Editing preview</span></label>
        <label className="layer-control"><input type="checkbox" checked={showTypography} onChange={event => setShowTypography(event.target.checked)} />Typography overlay<span>Workspace preview</span></label>
        <TypographyLayerList session={typography} dialogues={document?.dialogues ?? []} selected={selectedDialogueId} onSelect={selectDialogue} />
        <label className="layer-control"><input type="checkbox" checked={showRegions} onChange={event => setShowRegions(event.target.checked)} />TextRegion geometry</label>
        <label className="layer-control"><input type="checkbox" checked={showSelection} onChange={event => setShowSelection(event.target.checked)} />Selection handles</label>
        <label className="layer-control"><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} />Candidate overlays</label>
        <label className="layer-control"><input type="checkbox" checked={showMask} disabled={!maskUrl} onChange={event => setShowMask(event.target.checked)} />Cleaning preview mask</label>
      </>}>
        <section className="selection-properties" aria-label="Selected object properties">
          {active || activeText || activeDialogue || manualRect ? <>
            <h2>{active ? `Bubble ${String(document!.bubbles.indexOf(active)+1).padStart(2,'0')}` : activeDialogue ? 'Dialogue' : 'Text region'}</h2>
            {active && <button disabled={busy || running} onClick={excludeCandidate}>Exclude candidate</button>}
            <section><h3>Text</h3>
              <label>Source<textarea aria-label="Source transcription" value={activeText ? manualDraft : text} onFocus={()=>{sourceFocused.current=true;}} onBlur={()=>{sourceFocused.current=false;saveSource();}} onChange={event => activeText ? setManualDraft(event.target.value) : setText(event.target.value)} disabled={busy || running} /></label>
              <details><summary>Source options</summary>
                {activeText && <button disabled={busy || jobActive} onClick={()=>api && void action(async()=>{await flushEdits();const job=await api.post<Job>(`/v1/text-regions/${activeText.id}/ocr`,{device:'cpu',language:'auto'});setState(previous=>({...previous,job}));})}>Retry text recognition for this region</button>}
                {activeText && <><label>Source bounds<input value={cropDraft} onChange={e => setCropDraft(e.target.value)} /></label><label>Reading direction<select value={directionDraft} onChange={e => setDirectionDraft(e.target.value)}><option value="unspecified">Unspecified</option><option value="vertical">Vertical</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label><button onClick={() => api && void action(async () => { const parts=cropDraft.split(',').map(v => v.trim()); if(parts.length!==4 || parts.some(v => !/^\d+$/.test(v))) throw new Error('Enter four integer coordinates.'); setState(await api.post<State>(`/v1/text-regions/${activeText.id}`,{rect:parts.map(Number),direction:directionDraft})); setPreview(null);setMaskUrl(null); })}>Apply source bounds</button><button disabled={busy || running} onClick={() => moveReadingOrder(-1)}>Read earlier</button><button disabled={busy || running} onClick={() => moveReadingOrder(1)}>Read later</button><label>Raw OCR original<textarea readOnly value={activeText.ocr?.raw_text ?? ''}/></label></>}
              </details>
            </section>
            {!activeDialogue && <label>Indonesian text<textarea aria-label="New Indonesian dialogue" value={newDialogue} onChange={event=>setNewDialogue(event.target.value)} onBlur={()=>{if(newDialogue.trim())createDialogue(undefined,newDialogue);}} disabled={busy || running}/></label>}
            {document && <><TypographyLayerList session={typography} dialogues={document.dialogues.filter(layer => active ? layer.bubble_id === active.id : layer.id === selectedDialogueId)} selected={selectedDialogueId} onSelect={selectDialogue} />
              <TypographyControls api={api} session={typography} selected={activeDialogue} disabled={!api || busy || running || regionGesture} onCreate={() => createDialogue()} onDelete={deleteDialogue} sourceControls={null} /></>}
            <section><h3>Bubble / Cleaning</h3><button disabled={!canPreview} onClick={preparePreview}>Preview Mask</button><button disabled={!canClean} onClick={clean}>Clean Selected</button>
              <label>Method<select value={method} onChange={event => setMethod(event.target.value)}><option>Auto / Recommended</option><option>Telea Inpainting</option><option>White Bubble Clean</option></select></label>
              {preview && <><p>Inspect the mask before confirming cleaning.</p><button onClick={() => activateTool('mask-add')}>Correct mask</button><button onClick={() => activateTool('mask-erase')}>Erase mask</button><label>Brush radius<input type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} /></label>{Array.isArray(preview.analysis.warnings) && preview.analysis.warnings.map((warning, i) => <p className="warning-note" key={i}>{String(warning)}</p>)}</>}
            </section>
          </> : <p>Select a bubble or dialogue on the canvas.</p>}
        </section>
      </InspectorDock><DockResizeHandle side="right" width={rightWidth} minimum={280} maximum={320} onResize={setRightWidth} /></div>}
    </main>
    <EngineStatusBar connected={Boolean(api)} document={displayDocument} job={state.job} selected={selected.size} tool={tool} controller={viewport} onCancel={() => api && state.job && void action(async () => { await api.post(`/v1/jobs/${state.job!.id}/cancel`); })} />
    {textEditor && <SourceTextDialog session={textEditor} busy={busy} error={textEditorError} onClose={() => { if (!busy) setTextEditor(null); }} onSave={value => void saveEditorText(value)} />}
    {settings && <PreferencesDialog onClose={() => setSettings(false)} density={density} onDensity={setDensity} exportFormat={exportFormat} onExportFormat={setExportFormat} device={device} onDevice={setDevice} provider={provider} onProvider={setProvider} busy={busy || running} onReset={() => { setDensity('Balanced'); setStep(1); setLeftCollapsed(window.innerWidth < 1120); setRightCollapsed(false); setLeftWidth(220); setRightWidth(300); viewport.reset(); }} />}
    {exportOpen && document && <QuickExportDialog chapterCount={state.chapter?.pages.length} onExportPages={exportPages} typographyNotice={<TypographyExportNotice session={typography} count={document.dialogues?.filter(text => text.visible).length ?? 0} />} onClose={() => setExportOpen(false)} width={document.width} height={document.height} busy={busy || running} onExport={kind => { setExportFormat(kind); setExportOpen(false); download(kind); }} />}
  </div></TooltipProvider>;
}
