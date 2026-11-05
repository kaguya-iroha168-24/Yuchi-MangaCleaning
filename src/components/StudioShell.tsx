import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Aperture, ChevronDown, ChevronLeft, ChevronRight, FolderOpen, Hand, LoaderCircle, MousePointer2, Paintbrush, PanelLeftClose, PanelRightClose, PenTool, Pipette, Redo2, Save, Settings2, Stamp, Type, Undo2, ZoomIn } from 'lucide-react';
import type { Bubble, DocumentState, Job, TextRegion } from '../api';
import { LoupePreview, MiniMap, ViewportReadout } from './CanvasWorkspace';
import type { ViewportController } from '../ui/viewport';

export type StudioTool = 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase';
export type WorkflowStep = 1 | 2 | 3 | 4;
export type DockTab = 'Script' | 'Style' | 'Layers';
type MenuItem = { label: string; action?: () => void; disabled?: boolean; planned?: boolean };

export function FeatureBadge({ children = 'PLANNED' }: { children?: ReactNode }) { return <span className="feature-badge">{children}</span>; }
export function ChromeButton({ label, children, active, disabled, onClick }: { label: string; children: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`chrome-button ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

function StudioMenu({ label, items }: { label: string; items: MenuItem[] }) {
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setPosition(null); trigger.current?.focus(); } };
    const resized = () => setPosition(null);
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape); window.addEventListener('resize', resized);
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape); window.removeEventListener('resize', resized); };
  }, [position]);
  const open = () => { const rect = trigger.current?.getBoundingClientRect(); if (rect) setPosition(position ? null : { top: rect.bottom + 4, left: Math.max(8, Math.min(rect.left, window.innerWidth - 256)) }); };
  return <><button className="studio-menu-trigger" ref={trigger} aria-haspopup="menu" aria-expanded={Boolean(position)} onClick={open} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); open(); } }}>{label}</button>{position && createPortal(<div className="studio-menu" ref={menu} role="menu" aria-label={label} style={position} onKeyDown={event => {
    const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const index = buttons.indexOf(event.target as HTMLButtonElement);
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && buttons.length) { event.preventDefault(); buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus(); }
  }}>{items.map(item => <button key={item.label} role="menuitem" disabled={item.disabled || item.planned} onClick={() => { setPosition(null); item.action?.(); trigger.current?.focus(); }}><span>{item.label}</span>{item.planned && <FeatureBadge />}</button>)}</div>, window.document.body)}</>;
}

export function WorkflowStepper({ step, onStep }: { step: WorkflowStep; onStep: (step: WorkflowStep) => void }) {
  return <nav className="workflow-stepper" aria-label="Workflow stepper">{(['Scan & Clean', 'Translate', 'Typeset', 'QA & Export'] as const).map((label, index) => <button key={label} aria-label={`${index + 1}. ${label}`} title={label} aria-current={step === index + 1 ? 'step' : undefined} onClick={() => onStep(index + 1 as WorkflowStep)}><b>{index + 1}</b><span>{label}</span></button>)}</nav>;
}

export function UndoRedoMenu({ document, busy, onUndo, onRedo, onSave }: { document: DocumentState | null; busy: boolean; onUndo: () => void; onRedo: () => void; onSave: () => void }) {
  return <div className="header-history" aria-label="Undo, Redo and Save"><ChromeButton label="Undo (Ctrl+Z)" disabled={!document?.canUndo || busy} onClick={onUndo}><Undo2 size={16} /></ChromeButton><ChromeButton label="Redo (Ctrl+Shift+Z)" disabled={!document?.canRedo || busy} onClick={onRedo}><Redo2 size={16} /></ChromeButton><ChromeButton label="Save Project (Ctrl+S)" disabled={!document || busy} onClick={onSave}><Save size={16} /></ChromeButton></div>;
}

export function StudioHeader(props: {
  document: DocumentState | null; busy: boolean; step: WorkflowStep; onStep: (step: WorkflowStep) => void;
  onOpen: () => void; onSave: () => void; onExport: () => void; onUndo: () => void; onRedo: () => void; onSettings: () => void;
  onScan: () => void; onPreview: () => void; onClean: () => void; canScan: boolean; canPreview: boolean; canClean: boolean;
  onToggleLeft: () => void; onToggleRight: () => void; onPreset: (preset: 'Quick Clean' | 'Studio' | 'Review') => void;
}) {
  const file = props.document;
  const name = file?.projectName || file?.sourceName || 'Untitled workspace';
  const saved = file ? file.dirty ? 'Unsaved' : file.savedPath ? 'Saved' : 'Unmodified' : 'No document';
  return <header className="studio-header">
    <div className="studio-brand"><Aperture size={23} /><strong>YUCHI LABS<small>MANGACLEAN ATELIER</small></strong></div>
    <nav className="studio-menus" aria-label="Studio menu">
      <StudioMenu label="File" items={[{ label: 'Open Image or Project…', action: props.onOpen, disabled: props.busy }, { label: 'Save Project', action: props.onSave, disabled: !file || props.busy }, { label: 'Import Chapter / Archive…', planned: true }, { label: 'Pre-Processing / Upscaling…', planned: true }, { label: 'Settings…', action: props.onSettings }]} />
      <StudioMenu label="Edit" items={[{ label: 'Undo', action: props.onUndo, disabled: !file?.canUndo || props.busy }, { label: 'Redo', action: props.onRedo, disabled: !file?.canRedo || props.busy }, { label: 'Branching History', planned: true }, { label: 'Settings…', action: props.onSettings }]} />
      <StudioMenu label="View" items={[{ label: 'Toggle Page Navigator', action: props.onToggleLeft }, { label: 'Toggle Right Inspector', action: props.onToggleRight }, ...(['Quick Clean', 'Studio', 'Review'] as const).map(preset => ({ label: `${preset} workspace`, action: () => props.onPreset(preset) }))]} />
      <StudioMenu label="Pipeline" items={[{ label: 'Scan Active Page', action: props.onScan, disabled: !props.canScan }, { label: 'Preview Mask', action: props.onPreview, disabled: !props.canPreview }, { label: 'Confirm & Clean Selected', action: props.onClean, disabled: !props.canClean }, { label: 'Scan Chapter', planned: true }, { label: 'Translate / Mosaic Batching', planned: true }, { label: 'Automated QA Preflight', planned: true }]} />
      <StudioMenu label="Glossary" items={[{ label: 'Series Glossary', planned: true }, { label: 'Character Voice Matrix', planned: true }, { label: 'Translation Memory', planned: true }]} />
      <StudioMenu label="Export" items={[{ label: 'Export PNG / JPEG…', action: props.onExport, disabled: !file || props.busy }, { label: 'PSD / PDF / CBZ / WebP…', planned: true }, { label: 'Chapter Export / Naming Rules', planned: true }]} />
    </nav>
    <div className="studio-project" title={name}><span>{name}</span><small className={file?.dirty ? 'dirty' : ''}>{saved}</small></div>
    <UndoRedoMenu document={file} busy={props.busy} onUndo={props.onUndo} onRedo={props.onRedo} onSave={props.onSave} />
    <WorkflowStepper step={props.step} onStep={props.onStep} />
    <ChromeButton label="Settings (Ctrl+,)" onClick={props.onSettings}><Settings2 size={17} /></ChromeButton>
  </header>;
}

export function ToolRail({ tool, onTool, ready, hasPreview, busy, onZoom }: { tool: StudioTool; onTool: (tool: StudioTool) => void; ready: boolean; hasPreview: boolean; busy: boolean; onZoom: () => void }) {
  return <nav className="tool-rail" aria-label="Left Vertical Toolbar">
    <ChromeButton label="Select / Move (V)" active={tool === 'select'} onClick={() => onTool('select')}><MousePointer2 size={19} /></ChromeButton>
    <ChromeButton label="Box Draw / Select text area manually (B)" active={tool === 'manual'} disabled={!ready || busy} onClick={() => onTool('manual')}><span className="box-tool-icon" /></ChromeButton>
    <ChromeButton label="Vector Pen / Node Editor (P / A) — PLANNED" disabled onClick={() => {}}><PenTool size={19} /></ChromeButton>
    <span className="rail-separator" />
    <ChromeButton label="Magic Cleaning Brush (M) — PARTIAL: edits prepared preview mask only" active={tool.startsWith('mask-')} disabled={!hasPreview || busy} onClick={() => onTool('mask-add')}><Paintbrush size={19} /></ChromeButton>
    <ChromeButton label="Screentone / Clone Stamp (S) — PLANNED" disabled onClick={() => {}}><Stamp size={19} /></ChromeButton>
    <ChromeButton label="Line-Art Continuation Pen (L) — PLANNED" disabled onClick={() => {}}><PenTool size={19} /></ChromeButton>
    <span className="rail-separator" />
    <ChromeButton label="Typography / Editable Dialogue (T)" active={tool === 'text'} disabled={!ready || busy} onClick={() => onTool('text')}><Type size={20} /></ChromeButton>
    <ChromeButton label="Smart Eyedropper (I) — PLANNED" disabled onClick={() => {}}><Pipette size={19} /></ChromeButton>
    <span className="rail-separator" />
    <ChromeButton label="Pan canvas (H / Space + drag)" active={tool === 'pan'} onClick={() => onTool('pan')}><Hand size={19} /></ChromeButton>
    <ChromeButton label="Zoom in (Z)" disabled={!ready} onClick={onZoom}><ZoomIn size={19} /></ChromeButton>
    <span className="rail-note" title="Unavailable tools remain visible; no simulated processing">TOOLS</span>
  </nav>;
}

export function ContextToolbar(props: { tool: StudioTool; children: ReactNode; leftCollapsed: boolean; rightCollapsed: boolean; onToggleLeft: () => void; onToggleRight: () => void }) {
  const names: Record<StudioTool, string> = { select: 'Select / Move', pan: 'Pan Canvas', manual: 'Box Draw', text: 'Typography', 'mask-add': 'Mask Brush', 'mask-erase': 'Mask Brush · Erase' };
  return <div className="context-toolbar" aria-label="Contextual Sub-Toolbar"><span className="context-tool-name">{names[props.tool]}</span><div className="context-controls">{props.children}</div><div className="context-dock-actions"><ChromeButton label={props.leftCollapsed ? 'Expand Page Navigator' : 'Collapse Page Navigator'} active={!props.leftCollapsed} onClick={props.onToggleLeft}><PanelLeftClose size={17} /></ChromeButton><ChromeButton label={props.rightCollapsed ? 'Expand Right Inspector' : 'Collapse Right Inspector'} active={!props.rightCollapsed} onClick={props.onToggleRight}><PanelRightClose size={17} /></ChromeButton></div></div>;
}

export function DockResizeHandle({ side, width, minimum, maximum, onResize }: { side: 'left' | 'right'; width: number; minimum: number; maximum: number; onResize: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const resize = (value: number) => onResize(Math.max(minimum, Math.min(maximum, Math.round(value))));
  return <div className={`dock-resize-handle ${side}`} role="separator" aria-label={`Resize ${side} dock`} aria-orientation="vertical" aria-valuenow={width} aria-valuemin={minimum} aria-valuemax={maximum} tabIndex={0}
    onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId); start.current = { x: event.clientX, width }; }}
    onPointerMove={event => { if (start.current) resize(start.current.width + (event.clientX - start.current.x) * (side === 'left' ? 1 : -1)); }}
    onPointerUp={event => { start.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { start.current = null; }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(width + (event.key === 'ArrowRight' ? 8 : -8) * (side === 'left' ? 1 : -1)); } }} />;
}

export function PageNavigator({ document, originalUrl, original, working, controller, onCollapse, onOpen }: { document: DocumentState | null; originalUrl: string | null; original: HTMLImageElement | null; working: HTMLImageElement | null; controller: ViewportController; onCollapse: () => void; onOpen: () => void }) {
  const [filter, setFilter] = useState('All');
  const warning = document?.bubbles.some(bubble => bubble.cleaning === 'Failed' || bubble.cleaning === 'Needs Result Review');
  const cleaned = document?.bubbles.filter(bubble => bubble.cleaning === 'Cleaned').length ?? 0;
  const status = warning ? 'Needs Manual Review' : cleaned ? `Cleaning · ${cleaned}/${document?.bubbles.length}` : 'Raw';
  const visible = document && (filter === 'All' || filter === 'Dirty' && document.dirty || filter === 'Needs Redraw' && warning);
  return <aside className="page-navigator" aria-label="Page Navigator"><div className="dock-heading"><strong>PAGE NAVIGATOR</strong><span>{document ? '01' : '00'}</span><ChromeButton label="Collapse Page Navigator" onClick={onCollapse}><ChevronLeft size={16} /></ChromeButton></div>
    <div className="navigator-scroll">{visible ? <div className="page-entry active"><div className="page-number">01</div><div className="page-preview">{originalUrl && <img src={originalUrl} alt="Active page thumbnail" />}</div><strong title={document.sourceName}>{document.sourceName}</strong><small>{document.width} × {document.height}</small><span className={`page-state ${warning ? 'warning' : cleaned ? 'cleaning' : ''}`}>{status}</span>{document.dirty && <small className="unsaved-mark">Unsaved</small>}</div> : <div className="dock-empty">{document ? 'No page matches this filter.' : 'No pages loaded.'}<button className="studio-action" onClick={onOpen}><FolderOpen size={14} /> Open Image</button></div>}
      <div className="navigator-filter"><label htmlFor="page-filter">Filter</label><select id="page-filter" value={filter} onChange={event => setFilter(event.target.value)}><option>All</option><option>Dirty</option><option>Needs Redraw</option></select></div>
      <p className="availability-note">Single page connected. <FeatureBadge /> Chapter import and batch queue.</p>
    </div><MiniMap controller={controller} image={original} /><LoupePreview controller={controller} original={original} working={working} />
  </aside>;
}

function BubbleCard({ bubble, index, selected, regions, onSelect, typography }: { typography?: ReactNode; bubble: Bubble; index: number; selected: boolean; regions: TextRegion[]; onSelect: (id: string, multi: boolean) => void }) {
  const related = regions.filter(region => region.bubbleId === bubble.id);
  const raw = related.map(region => region.ocr?.raw_text).filter(Boolean).join('\n');
  const source = related.map(region => region.text).filter(Boolean).join('\n');
  return <article className={`smart-bubble-card ${selected ? 'selected' : ''}`} aria-label={`Candidate ${String(index + 1).padStart(2, '0')} card`}>
    <div className="bubble-card-header"><button className="bubble-select" onClick={event => onSelect(bubble.id, event.ctrlKey || event.metaKey)} aria-pressed={selected}><b>#{String(index + 1).padStart(2, '0')}</b> Candidate {String(index + 1).padStart(2, '0')}</button><span className={bubble.cleaning === 'Cleaned' ? 'cleaned-label' : 'review-label'}>{bubble.cleaning === 'Cleaned' ? 'Cleaned' : bubble.review}</span></div>
    <div className="bubble-card-meta"><span>{bubble.source}</span><span>{bubble.confidence == null ? 'No confidence' : `${(bubble.confidence * 100).toFixed(1)}%`}</span><select aria-label={`Candidate ${index + 1} shape classification`} disabled value={bubble.kind}><option>{bubble.kind}</option></select></div>
    <label>OCR ORIGINAL</label><p className="script-original">{raw || 'No OCR proposal for this candidate.'}</p>{source && <p className="script-source" title="Saved source transcription">{source}</p>}
    <label>TRANSLATION <FeatureBadge /></label><textarea disabled placeholder="Translation is not available yet" aria-label={`Candidate ${index + 1} translation`} />
    {typography ?? (<div className="bubble-style-footer" title="Live typography is available in the Style inspector. Card quick styling, stroke and object locking are planned."><button disabled aria-label="Decrease font size">−</button><span>— pt</span><button disabled aria-label="Increase font size">+</button><button disabled>Stroke</button><button disabled>Lock</button><FeatureBadge /></div>)}
  </article>;
}

export function TypographyInspector({ children }: { children?: ReactNode }) { return <div className="planned-inspector"><h3>TYPOGRAPHY INSPECTOR <FeatureBadge>LIVE</FeatureBadge></h3>{children}<div className="planned-feature-list">{['Font Preset Manager', 'Advanced SFX / Text on Path'].map(label => <div key={label}>{label}<FeatureBadge /></div>)}</div></div>; }

export function InspectorDock({ document, selected, onSelect, tab, onTab, onCollapse, children, layerControls, textControls, cardTypography }: { cardTypography?: (bubble: Bubble) => ReactNode; document: DocumentState | null; selected: Set<string>; onSelect: (id: string, multi: boolean) => void; tab: DockTab; onTab: (tab: DockTab) => void; onCollapse: () => void; children: ReactNode; layerControls: ReactNode; textControls?: ReactNode }) {
  const [matrixExpanded, setMatrixExpanded] = useState(true);
  return <aside className="right-dock" aria-label="Hybrid Inspector & Script Matrix"><div className="dock-heading"><strong>INSPECTOR & SCRIPT</strong><ChromeButton label="Collapse Right Inspector" onClick={onCollapse}><ChevronRight size={16} /></ChromeButton></div><div className="dock-tabs" role="tablist" aria-label="Inspector panels">{(['Script', 'Style', 'Layers'] as const).map(item => <button role="tab" aria-selected={tab === item} key={item} onClick={() => onTab(item)}>{item}</button>)}</div>
    {tab === 'Script' && <><button className="matrix-heading" aria-expanded={matrixExpanded} onClick={() => setMatrixExpanded(value => !value)}><ChevronDown size={14} style={{ transform: matrixExpanded ? undefined : 'rotate(-90deg)' }} /> SCRIPT MATRIX <span>{document?.bubbles.length ?? 0}</span></button>{matrixExpanded && <div className="script-matrix" aria-label="Script Matrix">{document?.bubbles.length ? document.bubbles.map((bubble, index) => <BubbleCard key={bubble.id} bubble={bubble} index={index} selected={selected.has(bubble.id)} regions={document.textRegions} onSelect={onSelect} typography={cardTypography?.(bubble)} />) : <p className="dock-empty">Open and scan a page to review its real candidates.</p>}</div>}<div className="legacy-inspector-slot">{children}</div></>}
    {tab === 'Style' && <div className="dock-scroll"><TypographyInspector>{textControls}</TypographyInspector></div>}
    {tab === 'Layers' && <div className="dock-scroll"><div className="planned-inspector"><h3>LAYERS</h3><p>Workspace switches affect preview only. Each dialogue visibility checkbox controls its exported text layer.</p>{layerControls}<div className="planned-feature-list">{['Vector Redraw / Strokes', 'Advanced SFX', 'Layer reorder, lock and persistence'].map(label => <div key={label}>{label}<FeatureBadge /></div>)}</div></div></div>}
  </aside>;
}

export function EngineStatusBar({ connected, document, job, selected, tool, controller, onCancel }: { connected: boolean; document: DocumentState | null; job: Job | null; selected: number; tool: StudioTool; controller: ViewportController; onCancel: () => void }) {
  const run = document?.detectionRuns.at(-1);
  const running = job?.status === 'queued' || job?.status === 'running';
  return <footer className="engine-statusbar"><span className={`engine-connection ${connected ? 'connected' : ''}`}>{connected ? 'Local engine connected' : 'Engine unavailable'}</span><span title={String(run?.fallback_reason ?? '')}>{run ? `${run.model_name ?? run.provider} · ${run.device ?? 'Unknown device'}${run.cpu_fallback ? ' · CPU fallback' : ''}` : 'Compute: no inference yet'}</span>{running && <span className="engine-job"><LoaderCircle size={13} className="spin" />{job.type} · {Math.round(job.progress * 100)}% <button onClick={onCancel}>Cancel</button></span>}<span className="status-grow" /><span>{document ? `${document.bubbles.length} candidates · ${selected} selected` : 'No page open'}</span><span className="status-tool">Tool: {tool}</span><ViewportReadout controller={controller} /><span>{document ? document.dirty ? 'Unsaved' : document.savedPath ? 'Saved' : 'Unmodified' : 'Idle'}</span></footer>;
}
