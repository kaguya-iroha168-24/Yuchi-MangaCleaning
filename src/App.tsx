import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@radix-ui/react-tooltip';
import { Aperture, Check, CircleHelp, Eye, FolderOpen, Layers3, MousePointer2, Save, ScanSearch, ShieldCheck, X, Languages } from 'lucide-react';
import { Api, ApiError, type ExportPreflight, type Job, type Preview, type State, type TextRegion, connect } from './api';
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
  const [rightWidth, setRightWidth] = useState(360);
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
  const [containersUrl, setContainersUrl] = useState<string | null>(null);
  const [brushRadius, setBrushRadius] = useState(5);
  const [workingUrl, setWorkingUrl] = useState<string | null>(null);
  const [maskUrl, setMaskUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [method, setMethod] = useState('Auto / Recommended');
  const [provider, setProvider] = useState('shima_v1');
  const [device, setDevice] = useState(() => localStorage.getItem('yuchi-tauri-device') || 'auto');
  const [inspector, setInspector] = useState<'Review' | 'Cleaning' | 'Text'>('Review');
  const [manualRect, setManualRect] = useState<[number, number, number, number] | null>(null);
  const [text, setText] = useState('');
  const [activeTextId, setActiveTextId] = useState<string | null>(null);
  const [cropDraft, setCropDraft] = useState('');
  const [directionDraft, setDirectionDraft] = useState('unspecified');
  const [ocrDraft, setOcrDraft] = useState('');
  const [manualDraft, setManualDraft] = useState('');
  const [ocrDevice, setOcrDevice] = useState<'cpu' | 'cuda'>('cpu');
  const fileInput = useRef<HTMLInputElement>(null);
  const completedJob = useRef<string | null>(null);
  const heldTool = useRef<Tool | null>(null);
  const original = useImage(originalUrl);
  const working = useImage(workingUrl);
  const containers = useImage(containersUrl);
  const mask = useImage(maskUrl);
  const document = state.document;
  const active = useMemo(() => document?.bubbles.find(bubble => selected.has(bubble.id)) ?? null, [document, selected]);
  const activeText = useMemo(() => document?.textRegions.find(region => region.id === activeTextId) ?? null, [document, activeTextId]);
  const displayDocument = document && (regionGesture || textEditor || typographyDirty) ? { ...document, dirty: true } : document;
  const activeDialogue = document?.dialogues?.find(text => text.id === selectedDialogueId) ?? null;
  const running = state.job?.status === 'queued' || state.job?.status === 'running';

  const reportError = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
    setExportIssues(reason instanceof ApiError ? reason.preflight ?? null : null);
    if (reason instanceof ApiError && reason.reconnectable) setApi(null);
  }, []);

  useEffect(() => { typography.configure(api, document, { state: setState, dirty: setTypographyDirty, error: reportError }); if (selectedDialogueId && !document?.dialogues?.some(text => text.id === selectedDialogueId)) setSelectedDialogueId(null); }, [api, document, typography, reportError, selectedDialogueId]);
  useEffect(() => () => typography.dispose(), [typography]);

  useEffect(() => { setManualDraft(activeText?.text ?? ''); }, [activeText?.id, activeText?.text]);
  useEffect(() => { setCropDraft(activeText?.rect.join(', ') ?? ''); setDirectionDraft(activeText?.direction ?? 'unspecified'); }, [activeText?.id, activeText?.rect.join(','), activeText?.direction]);
  useEffect(() => { if (activeText?.ocr?.status === 'Needs Review') setOcrDraft(activeText.ocr.edited_text); }, [activeText?.id, activeText?.ocr?.status, activeText?.ocr?.edited_text]);

  const refresh = useCallback(async (client: Api, withImages = false) => {
    const next = await client.get<State>('/v1/state');
    setState(next);
    if (withImages && next.document) {
      const [source, result, geometry] = await Promise.all([client.image('original'), client.image('working'), client.image('containers')]);
      setContainersUrl(previous => { if (previous) URL.revokeObjectURL(previous); return geometry; });
      setOriginalUrl(previous => { if (previous) URL.revokeObjectURL(previous); return source; });
      setWorkingUrl(previous => { if (previous) URL.revokeObjectURL(previous); return result; });
    } else if (withImages) {
      for (const setter of [setOriginalUrl, setWorkingUrl, setContainersUrl, setMaskUrl]) setter(previous => { if (previous) URL.revokeObjectURL(previous); return null; });
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
      if (job && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && completedJob.current !== `${job.id}:${job.status}`) {
        completedJob.current = `${job.id}:${job.status}`;
        void refresh(api, job.status === 'done' && job.type !== 'ocr').catch(reportError);
        if (job.status === 'failed') setError(job.error ?? 'Pekerjaan gagal.');
      }
    }, () => { setApi(null); setError('Koneksi progress backend terputus. Pilih Reconnect untuk memeriksa sesi dan keadaan proyek.'); });
  }, [api, refresh, reportError]);

  useEffect(() => { localStorage.setItem('yuchi-tauri-density', density); }, [density]);
  useEffect(() => { localStorage.setItem('yuchi-tauri-device', device); }, [device]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
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
  const choose = () => fileInput.current?.click();
  const onFile = (file: File | undefined) => {
    if (!file) return;
    const discard = Boolean(document?.dirty || typographyDirty);
    if (discard && !window.confirm('Perubahan saat ini belum tersimpan sebagai proyek. Buka berkas lain dan buang perubahan sesi ini?')) return;
    void action(async () => { await typography.abandon(); const client = await connect(); setApi(client); setState(await client.upload(file, discard)); setSelectedDialogueId(null); setError(''); setSaveNotice(''); setSelected(new Set()); setActiveTextId(null); setPreview(null); setMaskUrl(null); setManualRect(null); setTool('select'); viewport.reset(); await refresh(client, true); });
  };
  const scan = () => { if (api) void action(async () => { setPreview(null); const job = await api.post<Job>('/v1/detect', { provider, device }); setState(previous => ({ ...previous, job })); }); };
  const review = (decision: string) => { if (api && active) void action(async () => { for (const identifier of selected) { const candidate = document?.bubbles.find(bubble => bubble.id === identifier); await api.post(`/v1/bubbles/${identifier}/review`, { decision, kind: candidate?.kind ?? 'Unclassified' }); } await refresh(api); setPreview(null); setMaskUrl(null); }); };
  const previewBubble = () => { if (api && active) void action(async () => { const result = selected.size > 1 ? await api.post<Preview>('/v1/bubbles/preview', { ids: [...selected] }) : await api.post<Preview>(`/v1/bubbles/${active.id}/preview`); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); setShowMask(true); setInspector('Cleaning'); }); };
  const previewManual = () => { if (api && manualRect) void action(async () => { const result = await api.post<Preview>('/v1/manual/preview', { rect: manualRect }); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); setShowMask(true); setInspector('Cleaning'); }); };
  const editMask = (points: Point[]) => { if (api && preview && document) void action(async () => { const result = await api.post<Preview>('/v1/preview/edit', { previewId: preview.id, mode: tool === 'mask-erase' ? 'erase' : 'add', radius: brushRadius, points: points.map(point => [Math.max(0, Math.min(document.width - 1, Math.round(point.x))), Math.max(0, Math.min(document.height - 1, Math.round(point.y)))]) }); setPreview(result); const url = await api.image('preview-overlay'); setMaskUrl(previous => { if (previous) URL.revokeObjectURL(previous); return url; }); }); };
  const clean = () => { if (api && preview) void action(async () => { await api.post('/v1/clean/confirm', { previewId: preview.id, method, radius: 3 }); setPreview(null); setMaskUrl(null); setShowMask(false); setTool('select'); await refresh(api, true); }); };
  const selectBubble = (id: string, multi: boolean) => { if (!multi) setActiveTextId(null); setSelected(previous => { const next = multi ? new Set(previous) : new Set<string>(); if (next.has(id)) next.delete(id); else next.add(id); return next; }); setPreview(null); setMaskUrl(null); };
  const download = (kind: string) => { if (api) void action(async () => { await typography.flush(); const receipt = await api.save(kind); setState(receipt.state); setSaveNotice((kind === 'project' ? 'Saved and verified: ' : 'Exported and verified: ') + receipt.path); }); };
  const moveReadingOrder = (delta: number) => { if (api && document && activeText) void action(async () => { const ids = [...document.readingOrder]; const index = ids.indexOf(activeText.id); const destination = index + delta; if (destination < 0 || destination >= ids.length) return; [ids[index], ids[destination]] = [ids[destination], ids[index]]; await api.post('/v1/reading-order', { ids }); await refresh(api); }); };
  const startOcr = () => { if (api && (activeText || active)) {
    const linked = activeText ?? document?.textRegions.find(region => region.bubbleId === active?.id);
    if (linked?.ocr && !window.confirm('Ganti proposal OCR sebelumnya? Transkripsi tersimpan tetap dipertahankan.')) return;
    void action(async () => {
      const path = activeText ? `/v1/text-regions/${activeText.id}/ocr` : `/v1/bubbles/${active!.id}/ocr`;
      const job = await api.post<Job & { regionId?: string }>(path, { device: ocrDevice, language: 'auto' });
      if (job.regionId) setActiveTextId(job.regionId);
      setState(previous => ({ ...previous, job }));
      await refresh(api, false);
    });
  } };
  const decideOcr = (decision: 'Accepted' | 'Rejected') => { if (api && activeText) void action(async () => { const replaceExisting = decision === 'Accepted' && Boolean(activeText.text) && activeText.text !== ocrDraft; if (replaceExisting && !window.confirm('Ganti transkripsi yang tersimpan dengan hasil OCR yang sudah Anda tinjau?')) return; await api.post(`/v1/text-regions/${activeText.id}/ocr-review`, { decision, editedText: ocrDraft, replaceExisting }); await refresh(api); }); };

  const canScan = Boolean(api && document && !busy && !running && !regionGesture && !textEditor && !document.bubbles.length && !document.textRegions.length && !(document.dialogues?.length));
  const canPreview = Boolean(api && document && !busy && !running && !regionGesture && !textEditor && (tool === 'manual' ? manualRect : active?.review === 'Accepted'));
  const canClean = Boolean(api && document && preview?.maskPixels && !busy && !running);
  const undo = () => { if (api && document?.canUndo && !busy && !running) void action(async () => { await typography.flush(); const result = await api.post<State>('/v1/undo'); setState(result); if (result.imagesChanged !== false) await refresh(api, true); }); };
  const redo = () => { if (api && document?.canRedo && !busy && !running) void action(async () => { await typography.flush(); const result = await api.post<State>('/v1/redo'); setState(result); if (result.imagesChanged !== false) await refresh(api, true); }); };
  const activateTool = (next: Tool) => {
    if (((next === 'manual' || next === 'text') && (!document || !api || busy || running)) || (next.startsWith('mask-') && (!preview || busy || running))) return;
    setTool(next);
    if (next === 'manual' || next === 'text') { setPreview(null); setMaskUrl(null); setDockTab(next === 'text' ? 'Style' : 'Script'); setRightCollapsed(false); setInspector('Text'); }
  };
  const selectFromScript = (id: string, multi: boolean) => {
    setSelectedDialogueId(null); typography.select(null); selectBubble(id, multi);
    const region = document?.textRegions.find(item => item.bubbleId === id);
    setActiveTextId(region?.id ?? null); setInspector(region ? 'Text' : 'Review');
    setDockTab('Script'); setRightCollapsed(false);
  };
  const selectTextRegion = (id: string) => {
    const region = document?.textRegions.find(item => item.id === id);
    if (!region) return;
    setSelectedDialogueId(null); typography.select(null); setActiveTextId(id); setSelected(new Set(region.bubbleId ? [region.bubbleId] : []));
    setPreview(null); setMaskUrl(null); setManualRect(null); setTool('select');
    setInspector('Text'); setDockTab('Script'); setRightCollapsed(false);
  };
  const selectDialogue = (id: string) => {
    setSelectedDialogueId(id); typography.select(id); setActiveTextId(null);
    setSelected(new Set()); setPreview(null); setMaskUrl(null); setManualRect(null);
    setTool('select'); setDockTab('Style'); setRightCollapsed(false);
  };
  const editDialogue = (id: string) => { selectDialogue(id); requestAnimationFrame(() => window.document.getElementById('typography-text')?.focus()); };
  const createDialogue = (rect?: RegionRect) => {
    if (!api || !document || busy || running) return;
    void action(async () => {
      await typography.flush();
      const region = rect ? null : activeText;
      const bubble = rect ? null : active;
      const area = rect ?? region?.rect ?? bubble?.rect ?? [Math.max(0, Math.floor((document.width-240)/2)), Math.max(0, Math.floor((document.height-160)/2)), Math.min(240, document.width), Math.min(160, document.height)];
      const result = await api.post<State>('/v1/dialogues', { x: area[0], y: area[1], width: area[2], height: area[3], text: region?.text.slice(0, 4000) ?? '', source_region_id: region?.id ?? null, bubble_id: region?.bubbleId ?? bubble?.id ?? null });
      const created = result.document?.dialogues.find(text => !document.dialogues?.some(old => old.id === text.id));
      setState(result); if (created) editDialogue(created.id);
    });
  };
  const deleteDialogue = (id: string) => { if (api) void action(async () => { await typography.flush(); setState(await api.post<State>(`/v1/dialogues/${encodeURIComponent(id)}/delete`)); setSelectedDialogueId(null); }); };
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
    <input ref={fileInput} className="visually-hidden" type="file" accept=".png,.jpg,.jpeg,.mangaclean" onChange={event => { onFile(event.target.files?.[0]); event.target.value = ''; }} />
    <StudioHeader document={displayDocument} busy={busy || running || regionGesture || Boolean(textEditor)} step={step} onStep={changeStep} onOpen={choose} onSave={() => download('project')} onExport={() => setExportOpen(true)} onUndo={undo} onRedo={redo} onSettings={() => setSettings(true)} onScan={scan} onPreview={preparePreview} onClean={clean} canScan={canScan} canPreview={canPreview} canClean={canClean} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightCollapsed(value => !value)} onPreset={preset} />
    <ContextToolbar tool={tool} leftCollapsed={leftCollapsed} rightCollapsed={rightCollapsed} onToggleLeft={() => setLeftCollapsed(value => !value)} onToggleRight={() => setRightCollapsed(value => !value)}>
      <IconButton label="Open image or project (Ctrl+O)" disabled={busy || running} onClick={choose}><FolderOpen size={16} /></IconButton>
      {(tool === 'select' || tool === 'pan') && <><select aria-label="Detector" value={provider} onChange={event => setProvider(event.target.value)} disabled={busy || running}><option value="shima_v1">Shima V1</option><option value="opencv">OpenCV fallback</option></select><select aria-label="Detection device" value={device} onChange={event => setDevice(event.target.value)} disabled={provider === 'opencv' || busy || running}><option value="auto">Auto</option><option value="cpu">CPU</option><option value="cuda:0">GPU</option></select><button className="text-command" disabled={!canScan} onClick={scan}><ScanSearch size={15} /> Scan Bubbles</button></>}
      {(tool === 'manual' || tool === 'text') && <><span className="context-rect">{manualRect ? `Native area: ${manualRect.join(', ')}` : 'Draw a native text rectangle on either canvas'}</span><FeatureBadge>BOX</FeatureBadge></>}
      {tool.startsWith('mask-') && <><label>Radius <input aria-label="Mask brush radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} />{brushRadius}px</label><select aria-label="Preview brush mode" value={tool} onChange={event => activateTool(event.target.value as Tool)}><option value="mask-add">Add to preview mask</option><option value="mask-erase">Erase from preview mask</option></select></>}
      <button className="text-command" disabled={!canPreview} onClick={preparePreview}><Eye size={15} /> Preview Mask</button><button className="text-command accent" disabled={!canClean} onClick={clean}><ShieldCheck size={15} /> Clean Selected</button>
      <IconButton label="Toggle bubble overlays" active={showBoxes} onClick={() => setShowBoxes(value => !value)}><Layers3 size={16} /></IconButton><IconButton label="Toggle mask preview" active={showMask} disabled={!maskUrl} onClick={() => setShowMask(value => !value)}><Eye size={16} /></IconButton>
      <ViewportModeControls controller={viewport} disabled={!document} />
    </ContextToolbar>
    <main className="workarea">
      <ToolRail tool={tool} onTool={activateTool} ready={Boolean(document && api)} hasPreview={Boolean(preview)} busy={busy || running} onZoom={() => viewport.zoomBy(1.2)} />
      {!leftCollapsed && <div className="left-dock-container" style={{ width: leftWidth }}><PageNavigator document={document} originalUrl={originalUrl} original={original} working={working} controller={viewport} onCollapse={() => setLeftCollapsed(true)} onOpen={choose} /><DockResizeHandle side="left" width={leftWidth} minimum={180} maximum={300} onResize={setLeftWidth} /></div>}
      <div className="canvas-column">
        {saveNotice && <div className="save-notice" role="status">{saveNotice}</div>}
        {error && <div className="error-banner" role="alert"><CircleHelp size={17} /><div><span>{error}</span>{exportIssues && <><p>Halaman {exportIssues.pageNumber}: {exportIssues.pageName}. Proyek tetap dapat disimpan.</p><ul style={{ maxHeight: 160, overflowY: 'auto' }}>{exportIssues.issues.map(issue => <li key={issue.dialogueId}><strong>{issue.dialogueLabel}</strong> · {issue.candidateNumber ? `Candidate ${String(issue.candidateNumber).padStart(2, '0')}` : 'Tanpa kandidat terhubung'}<br />{issue.reason}<br />Requested: {issue.requestedFamily} / {issue.requestedWeight} / {issue.requestedSize}px · Actual: {issue.resolvedFamily ?? 'tidak tersedia'} / {issue.resolvedWeight ?? '—'} / {issue.resolvedSize ?? '—'}px<br /><small>Dialogue ID: {issue.dialogueId} · Bubble ID: {issue.bubbleId ?? '—'}</small><br /><button disabled={busy || running || document?.pageId !== exportIssues.pageId || !document?.dialogues.some(text => text.id === issue.dialogueId)} onClick={() => { const text = document?.dialogues.find(text => text.id === issue.dialogueId); if (!text || document?.pageId !== exportIssues.pageId) return; selectDialogue(text.id); setShowTypography(true); setShowSelection(true); viewport.update({ pan: { x: text.x + text.width / 2 - document.width / 2, y: text.y + text.height / 2 - document.height / 2 } }); }}>Pilih dan perbaiki Dialogue</button></li>)}</ul></>}</div>{!exportIssues && <button disabled={busy} onClick={reconnect}>Reconnect</button>}<button aria-label="Dismiss error" onClick={() => { setError(''); setExportIssues(null); }}><X size={16} /></button></div>}
        {document ? <CanvasWorkspace typography={{ session: typography, dialogues: document.dialogues ?? [], selected: selectedDialogueId, visible: showTypography, onSelect: selectDialogue, onEdit: editDialogue }} interaction={interaction} editable={Boolean(api) && !busy && !running && !textEditor} showRegions={showRegions} showSelection={showSelection} onEditText={editTextRegion} onCommitRegion={commitRegionRect} onGesture={value => { setRegionGesture(value); if (value) { setSaveNotice(''); setPreview(null); setMaskUrl(null); } }} controller={viewport} original={original} working={working} containers={containers} mask={mask} width={document.width} height={document.height} name={document.sourceName} bubbles={document.bubbles} textRegions={document.textRegions} selected={selected} selectedTextId={activeTextId} tool={tool} brushRadius={brushRadius} showBoxes={showBoxes} showMask={showMask} showOriginal={showOriginal} showWorking={showWorking} onBubble={selectFromScript} onRect={rect => { setManualRect(rect); if (tool === 'text') createDialogue(rect); }} onBrush={editMask} onText={selectTextRegion} /> : <div className="empty-workspace"><div className="empty-grid" /><div className="empty-content"><div className="empty-icon"><Aperture size={31} /></div><div className="eyebrow">YUCHI LABS / WORKSPACE</div><h1>Your page starts here.</h1><p>Open a manga page or an existing MangaClean project to begin reviewing and cleaning in native resolution.</p><div className="empty-actions"><button className="text-command primary large" onClick={choose}><FolderOpen size={18} /> Open Image or Project</button></div><span className="empty-hint">PNG, JPEG, or .mangaclean · Processing stays on this computer</span></div></div>}
      </div>
      {!rightCollapsed && <div className="right-dock-container" style={{ width: rightWidth }}><InspectorDock cardTypography={bubble => <TypographyCardControls session={typography} dialogues={document?.dialogues ?? []} bubbleId={bubble.id} selected={selectedDialogueId} disabled={!api || !document || busy || running || regionGesture || Boolean(textEditor)} onTarget={id => { setSelectedDialogueId(id); typography.select(id); setActiveTextId(null); }} />} document={document} selected={selected} onSelect={selectFromScript} tab={dockTab} onTab={setDockTab} onCollapse={() => setRightCollapsed(true)} textControls={<TypographyControls api={document ? api : null} session={typography} selected={activeDialogue} disabled={!api || !document || busy || running || regionGesture} onCreate={() => createDialogue()} onDelete={deleteDialogue} sourceControls={activeText ? <div className="source-region-properties"><strong>Source TextRegion</strong><p>Source crop and OCR direction stay separate from typeset dialogue.</p><button className="studio-action" onClick={() => editTextRegion(activeText)} disabled={busy || running}>Edit source text</button><label>Native x, y, width, height<input aria-label="Selected TextRegion bounds" value={cropDraft} onChange={event => setCropDraft(event.target.value)} /></label><label>OCR reading direction<select value={directionDraft} onChange={event => setDirectionDraft(event.target.value)}><option value="unspecified">Unspecified</option><option value="ltr">Horizontal · left to right</option><option value="rtl">Horizontal · right to left</option><option value="vertical">Vertical</option></select></label><button className="studio-action" disabled={busy || running} onClick={() => api && void action(async () => { const parts = cropDraft.split(',').map(value => value.trim()); if (parts.length !== 4 || parts.some(value => !/^\d+$/.test(value))) throw new Error('Enter four native integer coordinates.'); setState(await api.post<State>(`/v1/text-regions/${activeText.id}`, { rect: parts.map(Number), direction: directionDraft })); })}>Apply region metadata</button></div> : <p className="section-note">Source transcription: select a source region, or draw with B and save in the Text inspector.</p>} />} layerControls={<>
        <label className="layer-control"><input type="checkbox" checked={showOriginal} onChange={event => setShowOriginal(event.target.checked)} />Raw Artwork<span>Original preview</span></label>
        <label className="layer-control"><input type="checkbox" checked={showWorking} onChange={event => setShowWorking(event.target.checked)} />Cleaned / Working<span>Editing preview</span></label>
        <label className="layer-control"><input type="checkbox" checked={showTypography} onChange={event => setShowTypography(event.target.checked)} />Typography overlay<span>Workspace preview</span></label>
        <TypographyLayerList session={typography} dialogues={document?.dialogues ?? []} selected={selectedDialogueId} onSelect={selectDialogue} />
        <label className="layer-control"><input type="checkbox" checked={showRegions} onChange={event => setShowRegions(event.target.checked)} />TextRegion geometry</label>
        <label className="layer-control"><input type="checkbox" checked={showSelection} onChange={event => setShowSelection(event.target.checked)} />Selection handles</label>
        <label className="layer-control"><input type="checkbox" checked={showBoxes} onChange={event => setShowBoxes(event.target.checked)} />Candidate overlays</label>
        <label className="layer-control"><input type="checkbox" checked={showMask} disabled={!maskUrl} onChange={event => setShowMask(event.target.checked)} />Cleaning preview mask</label>
      </>}>
        {document ? <section className="inspector"><div className="inspector-title"><span className="eyebrow">CONTEXT INSPECTOR</span><strong>{inspector === 'Text' && activeText ? `Text region ${String(document.textRegions.indexOf(activeText) + 1).padStart(2, '0')}` : active ? `Candidate ${String(document.bubbles.indexOf(active) + 1).padStart(2, '0')}` : manualRect ? 'Manual selection' : 'No candidate selected'}</strong></div><div className="inspector-tabs"><button className={inspector === 'Review' ? 'selected' : ''} onClick={() => setInspector('Review')}>Review</button><button className={inspector === 'Cleaning' ? 'selected' : ''} onClick={() => setInspector('Cleaning')}>Cleaning</button><button className={inspector === 'Text' ? 'selected' : ''} onClick={() => setInspector('Text')}>Text</button></div>
        <div className="inspector-body">
          {inspector === 'Review' && (active ? <><div className="property-section"><div className="section-label">CANDIDATE</div><div className="data-row"><span>Status</span><strong className={active.review === 'Accepted' ? 'good' : active.review === 'Rejected' ? 'bad' : 'warm'}>{active.review}</strong></div><div className="data-row"><span>Source</span><strong>{active.source}</strong></div><div className="data-row"><span>Confidence</span><strong>{active.confidence == null ? '—' : `${(active.confidence * 100).toFixed(1)}%`}</strong></div><div className="data-row"><span>Editing ROI</span><strong>{active.rect.join(', ')}</strong></div><div className="data-row"><span>Model bounds</span><strong>{active.predictionRect?.join(', ') ?? 'Legacy / unknown'}</strong></div><p className="section-note">Container geometry is separate from the removable text mask. Editing ROI includes the baseline native margin.</p></div><div className="property-section"><div className="section-label">HUMAN DECISION</div><p className="section-note">Review the original image before accepting this candidate.</p><div className="decision-actions"><button className="accept" onClick={() => review('Accepted')}><Check size={16} /> {selected.size > 1 ? `Accept selected (${selected.size})` : 'Accept'}</button><button className="reject" onClick={() => review('Rejected')}><X size={16} /> {selected.size > 1 ? `Reject selected (${selected.size})` : 'Reject'}</button></div></div></> : <div className="inspector-empty">Select a region on either canvas or in the navigator to review it.</div>)}
          {inspector === 'Cleaning' && <><div className="property-section"><div className="section-label">MASK PREVIEW</div>{preview ? <><div className="preview-ready"><ShieldCheck size={19} /><span><strong>{preview.maskPixels.toLocaleString()} text-mask pixels</strong><small>Preview ready · inspect the text mask before cleaning</small></span></div>{Array.isArray(preview.analysis.warnings) && (preview.analysis.warnings as string[]).map((warning, index) => <p className="warning-note" key={index}>{warning}</p>)}{preview.analysis.safety && Array.isArray((preview.analysis.safety as { reasons?: string[] }).reasons) && (preview.analysis.safety as { reasons: string[] }).reasons.map((reason, index) => <p className="warning-note" key={`safety-${index}`}>{reason}</p>)}</> : <p className="section-note">Select and accept a bubble, or draw a manual text area on either canvas.</p>}{preview && <><label className="field-label" htmlFor="brush-radius">Brush radius · {brushRadius} native px</label><input id="brush-radius" type="range" min="1" max="40" value={brushRadius} onChange={event => setBrushRadius(Number(event.target.value))} /><p className="section-note">Brush edits are clipped to the protected interior. {Number(preview.analysis.clipped_brush_pixels ?? 0)} outside pixels withheld.</p></>}{active && <button className="inspector-command" disabled={active.review !== 'Accepted'} onClick={previewBubble}><Eye size={16} /> Prepare bubble mask</button>}{manualRect && <><div className="data-row"><span>Manual area</span><strong>{manualRect.join(' × ')}</strong></div><button className="inspector-command" onClick={previewManual}><MousePointer2 size={16} /> Preview manual mask</button></>}</div><div className="property-section"><div className="section-label">RESTORATION</div><label className="field-label" htmlFor="method">Method</label><select id="method" value={method} onChange={event => setMethod(event.target.value)}><option>Auto / Recommended</option><option>Telea Inpainting</option><option>White Bubble Clean</option></select><button className="confirm-clean" disabled={!preview || preview.maskPixels === 0 || busy || running} onClick={clean}><ShieldCheck size={17} /> Confirm &amp; Clean Selected</button><p className="section-note">Cleaning uses the full-resolution mask. Inspect the result on the editing canvas.</p></div></>}
          {inspector === 'Text' && <><div className="property-section"><div className="section-label">MANUAL TRANSCRIPTION</div><p className="section-note">Draw a text area with the selection tool, then save the source transcription.</p>{manualRect && <div className="data-row"><span>Text region</span><strong>{manualRect.join(', ')}</strong></div>}<textarea value={text} onChange={event => setText(event.target.value)} placeholder="English / Japanese source text…" aria-label="Source transcription" /><button className="inspector-command" disabled={!manualRect || !api} onClick={() => api && manualRect && void action(async () => { await api.post('/v1/text-regions', { rect: manualRect, text, bubbleId: active?.id ?? null }); setText(''); await refresh(api); })}><Save size={16} /> Save text region</button></div><div className="property-section"><div className="section-label">SAVED TEXT REGIONS</div>{document.textRegions.length ? document.readingOrder.map(id => document.textRegions.find(region => region.id === id)!).map(region => <button className={`saved-text ${region.id === activeTextId ? 'selected' : ''}`} key={region.id} onClick={() => selectTextRegion(region.id)}><span>{region.kind} · {region.ocr?.status ?? 'Manual'}</span><strong>{region.text || '(empty transcription)'}</strong></button>) : <p className="section-note">No text regions on this page.</p>}</div>{activeText && <div className="property-section"><label className="field-label" htmlFor="text-crop">Native crop: x, y, width, height</label><input id="text-crop" className="crop-input" value={cropDraft} onChange={event => setCropDraft(event.target.value)} /><label className="field-label" htmlFor="text-direction">Reading direction</label><select id="text-direction" value={directionDraft} onChange={event => setDirectionDraft(event.target.value)}><option value="unspecified">Unspecified</option><option value="vertical">Vertical</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select><button className="inspector-command" disabled={busy || running} onClick={() => api && void action(async () => { const parts = cropDraft.split(',').map(value => value.trim()); const rect = parts.map(Number); if (parts.length !== 4 || parts.some(value => !/^\d+$/.test(value)) || !rect.every(Number.isSafeInteger)) throw new Error('Enter four native integer coordinates separated by commas.'); await api.post(`/v1/text-regions/${activeText.id}`, { rect, direction: directionDraft }); await refresh(api); })}>Save crop and direction</button><p className="section-note">Changing the crop makes its previous OCR proposal stale. Reading direction records intent; it does not rotate source pixels.</p><label className="field-label" htmlFor="manual-correction">Edit selected transcription</label><textarea id="manual-correction" value={manualDraft} onChange={event => setManualDraft(event.target.value)} /><button className="inspector-command" disabled={busy || running} onClick={() => api && void action(async () => { await api.post(`/v1/text-regions/${activeText.id}`, { text: manualDraft }); await refresh(api); })}>Save correction</button><div className="decision-actions"><button onClick={() => moveReadingOrder(-1)} disabled={document.readingOrder.indexOf(activeText.id) === 0}>Move earlier</button><button onClick={() => moveReadingOrder(1)} disabled={document.readingOrder.indexOf(activeText.id) === document.readingOrder.length - 1}>Move later</button></div></div>}{(activeText || active) && <div className="property-section"><div className="section-label">AUTO DETECT TEXT · OFFLINE</div><p className="section-note">{activeText ? `Selected text region: ${activeText.rect.join(', ')}` : 'Detect text inside the selected bubble automatically.'}</p><p className="section-note">OCR is a proposal. Verify stylized lettering and punctuation against the original.</p><label className="field-label" htmlFor="ocr-device">OCR device</label><select id="ocr-device" value={ocrDevice} onChange={event => setOcrDevice(event.target.value as 'cpu' | 'cuda')}><option value="cpu">CPU</option><option value="cuda">GPU</option></select><button className="inspector-command" disabled={running || busy} onClick={startOcr}><Languages size={16} /> Auto Detect Text</button>{running && state.job?.type === 'ocr' && <p className="section-note" role="status">{state.job.message ?? 'Starting the offline OCR runtime…'}</p>}{activeText?.ocr?.status === 'Needs Review' && <><p className="section-note">OCR proposal only. Review and edit it before accepting.</p><textarea aria-label="OCR proposal" value={ocrDraft} onChange={event => setOcrDraft(event.target.value)} /><div className="decision-actions"><button className="accept" onClick={() => decideOcr('Accepted')}><Check size={15} /> Accept OCR</button><button className="reject" onClick={() => decideOcr('Rejected')}><X size={15} /> Reject</button></div></>}{activeText?.ocr && <><label className="field-label" htmlFor="raw-ocr-text">Raw OCR original · read only</label><textarea id="raw-ocr-text" aria-label="Raw OCR original" readOnly value={activeText.ocr.raw_text} /><p className="section-note">{activeText.ocr.status} · Offline OCR</p></>}</div>}</>}
        </div>
      </section> : <div className="dock-empty">Open a page to review candidates, prepare a mask or edit source text.</div>}
      </InspectorDock><DockResizeHandle side="right" width={rightWidth} minimum={360} maximum={420} onResize={setRightWidth} /></div>}
    </main>
    <EngineStatusBar connected={Boolean(api)} document={displayDocument} job={state.job} selected={selected.size} tool={tool} controller={viewport} onCancel={() => api && state.job && void action(async () => { await api.post(`/v1/jobs/${state.job!.id}/cancel`); })} />
    {textEditor && <SourceTextDialog session={textEditor} busy={busy} error={textEditorError} onClose={() => { if (!busy) setTextEditor(null); }} onSave={value => void saveEditorText(value)} />}
    {settings && <PreferencesDialog onClose={() => setSettings(false)} density={density} onDensity={setDensity} exportFormat={exportFormat} onExportFormat={setExportFormat} device={device} onDevice={setDevice} provider={provider} onProvider={setProvider} busy={busy || running} onReset={() => { setDensity('Balanced'); setStep(1); setLeftCollapsed(window.innerWidth < 1120); setRightCollapsed(false); setLeftWidth(220); setRightWidth(360); viewport.reset(); }} />}
    {exportOpen && document && <QuickExportDialog typographyNotice={<TypographyExportNotice session={typography} count={document.dialogues?.filter(text => text.visible).length ?? 0} />} onClose={() => setExportOpen(false)} width={document.width} height={document.height} busy={busy || running} onExport={kind => { setExportFormat(kind); setExportOpen(false); download(kind); }} />}
  </div></TooltipProvider>;
}
