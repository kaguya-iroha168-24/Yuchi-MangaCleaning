import { useRef, useState, type ReactNode } from 'react';
import { Aperture, ChevronLeft, ChevronRight, FolderOpen, Hand, LoaderCircle, MousePointer2, Paintbrush, PanelLeftClose, PanelRightClose, Redo2, Save, Settings2, Type, Undo2, ZoomIn } from 'lucide-react';
import type { Bubble, DocumentState, Job } from '../api';
import { LoupePreview, MiniMap, ViewportReadout } from './CanvasWorkspace';
import type { ViewportController } from '../ui/viewport';

export type StudioTool = 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase';
export type WorkflowStep = 1 | 2 | 3 | 4;
export type DockTab = 'Script' | 'Style' | 'Layers';
export function FeatureBadge({ children = 'PLANNED' }: { children?: ReactNode }) { return <span className="feature-badge">{children}</span>; }
export function ChromeButton({ label, children, active, disabled, onClick }: { label: string; children: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void }) {
  return <button type="button" className={`chrome-button ${active ? 'active' : ''}`} title={label} aria-label={label} aria-pressed={active} disabled={disabled} onClick={onClick}>{children}</button>;
}

export function WorkflowStepper({ step, onStep }: { step: WorkflowStep; onStep: (step: WorkflowStep) => void }) {
  return <nav className="workflow-stepper" aria-label="Workflow stepper">{(['Scan & Clean', 'Translate', 'Typeset', 'QA & Export'] as const).map((label, index) => <button key={label} aria-label={`${index + 1}. ${label}`} title={label} aria-current={step === index + 1 ? 'step' : undefined} onClick={() => onStep(index + 1 as WorkflowStep)}><b>{index + 1}</b><span>{label}</span></button>)}</nav>;
}

export function UndoRedoMenu({ document, busy, onUndo, onRedo, onSave, saveBusy }: { saveBusy?: boolean; document: DocumentState | null; busy: boolean; onUndo: () => void; onRedo: () => void; onSave: () => void }) {
  return <div className="header-history" aria-label="Undo, Redo and Save"><ChromeButton label="Undo (Ctrl+Z)" disabled={!document?.canUndo || busy} onClick={onUndo}><Undo2 size={16} /></ChromeButton><ChromeButton label="Redo (Ctrl+Shift+Z)" disabled={!document?.canRedo || busy} onClick={onRedo}><Redo2 size={16} /></ChromeButton><ChromeButton label="Save Project (Ctrl+S)" disabled={!document || busy || saveBusy} onClick={onSave}><Save size={16} /></ChromeButton></div>;
}

export function StudioHeader(props: {
  processing?: boolean; tools?: ReactNode; onOcr: () => void; canOcr: boolean; onAddText: () => void; document: DocumentState | null; busy: boolean; step: WorkflowStep; onStep: (step: WorkflowStep) => void;
  onOpen: () => void; onSave: () => void; onExport: () => void; onUndo: () => void; onRedo: () => void; onSettings: () => void;
  onScan: () => void; onProcess?: () => void; onPreview: () => void; onClean: () => void; canScan: boolean; canPreview: boolean; canClean: boolean;
  onToggleLeft: () => void; onToggleRight: () => void; onPreset: (preset: 'Quick Clean' | 'Studio' | 'Review') => void;
}) {
  const file = props.document;
  const name = file?.projectName || file?.sourceName || 'Untitled workspace';
  return <header className="studio-header">
    <div className="studio-brand"><Aperture size={22}/><div><strong>Yuchi Labs</strong><small>MangaClean Atelier</small></div></div>
    <div className="studio-project" title={name}><span>{name}</span></div>
    <div className="header-actions"><button disabled={props.busy || props.processing} onClick={props.onOpen}>{props.onProcess ? 'Import' : 'Open'}</button><button className={props.onProcess ? 'primary' : undefined} disabled={!props.canScan} onClick={props.onProcess ?? props.onScan} title={props.onProcess ? 'Detect, recognize and safely clean the chosen pages. Automatic Indonesian translation is not configured.' : undefined}>{props.onProcess ? 'Process Automatically' : 'Scan & Detect'}</button>{props.onProcess && <details className="processing-options"><summary aria-label="Processing options" title="Processing options">▾</summary><div><button disabled={!props.canScan} onClick={event=>{event.currentTarget.closest('details')?.removeAttribute('open');props.onScan();}}>Scan &amp; Detect only</button></div></details>}{props.tools}<button disabled={!props.canClean} onClick={props.onClean}>Clean Selected</button><button className={props.onProcess ? undefined : 'primary'} disabled={!file || props.busy || props.processing} onClick={props.onExport}>Export</button></div>
    <UndoRedoMenu document={file} saveBusy={props.processing} busy={props.busy} onUndo={props.onUndo} onRedo={props.onRedo} onSave={props.onSave}/>
    <ChromeButton label="Settings (Ctrl+,)" onClick={props.onSettings}><Settings2 size={17}/></ChromeButton>
  </header>;
}

export function ToolRail({ tool, onTool, ready, hasPreview, busy, onZoom }: { tool: StudioTool; onTool: (tool: StudioTool) => void; ready: boolean; hasPreview: boolean; busy: boolean; onZoom: () => void }) {
  return <nav className="tool-rail top-tools" aria-label="Editing tools">
    <ChromeButton label="Select / Move (V)" active={tool === 'select'} onClick={() => onTool('select')}><MousePointer2 size={19} /></ChromeButton>
    <ChromeButton label="Correct prepared mask (M)" active={tool.startsWith('mask-')} disabled={!hasPreview || busy} onClick={() => onTool('mask-add')}><Paintbrush size={19}/></ChromeButton>
    <ChromeButton label="Add text (T)" active={tool === 'text'} disabled={!ready || busy} onClick={() => onTool('text')}><Type size={19}/></ChromeButton>
    <details className="tool-overflow" onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector<HTMLElement>('summary')?.focus();}}}><summary aria-label="More editing tools" title="More editing tools">•••</summary><div onClick={event=>event.currentTarget.closest('details')?.removeAttribute('open')}>
      <ChromeButton label="Box Draw / Select text area manually (B)" active={tool === 'manual'} disabled={!ready || busy} onClick={() => onTool('manual')}><span className="box-tool-icon" /></ChromeButton>
      <ChromeButton label="Pan canvas (H / Space + drag)" active={tool === 'pan'} onClick={() => onTool('pan')}><Hand size={19} /></ChromeButton>
      <ChromeButton label="Zoom in (Z)" disabled={!ready} onClick={onZoom}><ZoomIn size={19} /></ChromeButton>
    </div></details>

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
  const status = warning ? 'Check result' : cleaned ? `Cleaning · ${cleaned}/${document?.bubbles.length}` : 'Raw';
  const visible = document && (filter === 'All' || filter === 'Dirty' && document.dirty || filter === 'Needs Redraw' && warning);
  return <aside className="page-navigator" aria-label="Page Navigator"><div className="dock-heading"><strong>PAGE NAVIGATOR</strong><span>{document ? '01' : '00'}</span><ChromeButton label="Collapse Page Navigator" onClick={onCollapse}><ChevronLeft size={16} /></ChromeButton></div>
    <div className="navigator-scroll">{visible ? <div className="page-entry active"><div className="page-number">01</div><div className="page-preview">{originalUrl && <img src={originalUrl} alt="Active page thumbnail" />}</div><strong title={document.sourceName}>{document.sourceName}</strong><small>{document.width} × {document.height}</small><span className={`page-state ${warning ? 'warning' : cleaned ? 'cleaning' : ''}`}>{status}</span>{document.dirty && <small className="unsaved-mark">Unsaved</small>}</div> : <div className="dock-empty">{document ? 'No page matches this filter.' : 'No pages loaded.'}<button className="studio-action" onClick={onOpen}><FolderOpen size={14} /> Open Image</button></div>}
      <div className="navigator-filter"><label htmlFor="page-filter">Filter</label><select id="page-filter" value={filter} onChange={event => setFilter(event.target.value)}><option>All</option><option>Dirty</option><option>Needs Redraw</option></select></div>

    </div><MiniMap controller={controller} image={original} /><LoupePreview controller={controller} original={original} working={working} />
  </aside>;
}

export function InspectorDock({ onCollapse, children, layerControls }: { cardTypography?: (bubble: Bubble) => ReactNode; document: DocumentState | null; selected: Set<string>; onSelect: (id: string, multi: boolean) => void; tab: DockTab; onTab: (tab: DockTab) => void; onCollapse: () => void; children: ReactNode; layerControls: ReactNode; textControls?: ReactNode }) {
  return <aside className="right-dock" aria-label="Properties"><div className="dock-heading"><strong>Properties</strong><ChromeButton label="Collapse properties" onClick={onCollapse}><ChevronRight size={16}/></ChromeButton></div><div className="dock-scroll">{children}<details><summary>Layers / workspace visibility</summary>{layerControls}</details></div></aside>;
}

export function EngineStatusBar({ connected, document, job, selected, controller, onCancel }: { connected: boolean; document: DocumentState | null; job: Job | null; selected: number; tool: StudioTool; controller: ViewportController; onCancel: () => void }) {
  const running = job?.status === 'queued' || job?.status === 'running';
  return <footer className="engine-statusbar">{!connected && <span role="status">Connecting…</span>}{running && <span className="engine-job"><LoaderCircle size={13} className="spin"/>{job.message || `${Math.round(job.progress*100)}%`} <button onClick={onCancel}>Cancel</button></span>}<span className="status-grow"/><span>{selected} selected</span><ViewportReadout controller={controller}/><span>{document ? document.dirty ? 'Unsaved' : document.savedPath ? 'Saved' : 'Unmodified' : 'Idle'}</span></footer>;
}
