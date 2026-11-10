import { useRef, useState, type ReactNode } from 'react';
import { Aperture, ChevronLeft, ChevronRight, FolderOpen, Hand, Languages, LoaderCircle, MousePointer2, Paintbrush, PanelLeftClose, PanelRightClose, Redo2, Save, Scan, Settings2, Type, Undo2, Upload } from 'lucide-react';
import type { Bubble, DocumentState, Job } from '../api';
import { LoupePreview, MiniMap, ViewportReadout } from './CanvasWorkspace';
import type { ViewportController } from '../ui/viewport';

export type StudioTool = 'select' | 'pan' | 'manual' | 'text' | 'mask-add' | 'mask-erase';
export type WorkflowStep = 1 | 2 | 3 | 4;
export type DockTab = 'Script' | 'Style' | 'Layers' | 'Healing' | 'Image';
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
  processing?: boolean; tools?: ReactNode; document: DocumentState | null; busy: boolean;
  onOpen: () => void; onOpenFolder?: () => void; onSave: () => void; onExport: () => void; onUndo: () => void; onRedo: () => void; onSettings: () => void; onTranslate?: (scope: 'page' | 'chapter') => void;
  onProcess: () => void; onToggleAll: () => void; detectAll: boolean; pageCount: number; overlayMode: boolean; detectionMode: 'bubble' | 'text';
  onClean: () => void; canScan: boolean; canClean: boolean; cleanHint?: string;
  pages?: { number: number; previous?: () => void; next?: () => void };
  view?: ReactNode;
}) {
  const file = props.document;
  const name = file?.projectName || file?.sourceName || 'Untitled workspace';
  const allPages = props.detectAll && props.pageCount > 1;
  const process = props.detectionMode === 'text' ? 'Detect Text Only' : props.overlayMode ? 'Detect Bubbles for Overlay' : 'Detect & Clean Bubbles';
  return <header className="studio-header">
    <div className="studio-brand"><Aperture size={22}/><div><strong>Yuchi Labs</strong><small>MangaClean Atelier</small></div></div>
    <div className="studio-project" title={name}><span>{name}</span></div>
    <div className="header-actions">
      <div className="header-import" role="group" aria-label="Import">
        <ChromeButton label="Import images or project (Ctrl+O)" disabled={props.busy || props.processing} onClick={props.onOpen}><Upload size={16} /></ChromeButton>
        {props.onOpenFolder && <ChromeButton label="Open folder as chapter" disabled={props.busy || props.processing} onClick={props.onOpenFolder}><FolderOpen size={16} /></ChromeButton>}
      </div>
      {props.tools}
      <div className="header-detect" role="group" aria-label={props.detectionMode === "text" ? "Text detection" : "Bubble detection"}>
        <ChromeButton disabled={!props.canScan} onClick={props.onProcess} label={`${process} on ${allPages ? `all ${props.pageCount} pages` : 'the current page'} (Ctrl+Shift+S)`}><Scan size={16} /></ChromeButton>
        <button disabled={!props.canScan || props.pageCount < 2} aria-pressed={allPages} onClick={props.onToggleAll} title="Apply detection and Translate to all pages">All Pages</button>
      </div>
      <ChromeButton label={allPages ? `Translate all ${props.pageCount} pages` : 'Translate the current page'} disabled={!props.onTranslate || props.busy || props.processing} onClick={() => props.onTranslate?.(allPages ? 'chapter' : 'page')}><Languages size={16} /></ChromeButton>
      <button disabled={!props.canClean} onClick={props.onClean} aria-label="Clean Selected" title={props.cleanHint || 'Clean Selected'}>Clean</button>
    </div>
    <div className="header-document-actions">
      {props.view}
      {props.pages && <div className="header-page-stepper" role="group" aria-label="Page navigation">
        <ChromeButton label="Previous page" disabled={!props.pages.previous} onClick={()=>props.pages?.previous?.()}><ChevronLeft size={16}/></ChromeButton>
        <output aria-label="Current page">{props.pages.number}/{props.pageCount}</output>
        <ChromeButton label="Next page" disabled={!props.pages.next} onClick={()=>props.pages?.next?.()}><ChevronRight size={16}/></ChromeButton>
      </div>}
      <UndoRedoMenu document={file} saveBusy={props.processing} busy={props.busy} onUndo={props.onUndo} onRedo={props.onRedo} onSave={props.onSave}/>
      <button disabled={!file || props.busy || props.processing} onClick={props.onExport}>Export</button>
      <ChromeButton label="Settings (Ctrl+,)" onClick={props.onSettings}><Settings2 size={17}/></ChromeButton>
    </div>
  </header>;
}

export function ToolRail({ tool, onTool, ready, hasPreview, busy, canPreview, cleanHint, onPreview, onHealing }: { tool: StudioTool; onTool: (tool: StudioTool) => void; ready: boolean; hasPreview: boolean; busy: boolean; canPreview: boolean; cleanHint?: string; onPreview: () => void; onHealing: () => void }) {
  return <nav className="tool-rail top-tools" aria-label="Editing tools">
    <ChromeButton label="Box Draw / Select text area manually (B)" active={tool === 'manual'} disabled={!ready || busy} onClick={() => onTool('manual')}><span className="box-tool-icon" /></ChromeButton>
    <ChromeButton label="Add text (T)" active={tool === 'text'} disabled={!ready || busy} onClick={() => onTool('text')}><Type size={16} /></ChromeButton>
    <details className="tool-overflow" onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector<HTMLElement>('summary')?.focus();}}}><summary aria-label="Mask and healing tools" title="Mask and healing tools"><Paintbrush size={16} /></summary><div onClick={event=>event.currentTarget.closest('details')?.removeAttribute('open')}>
      <button disabled={!ready || busy || !canPreview} title={cleanHint || undefined} onClick={onPreview}>Preview Mask</button>
      <button disabled={!hasPreview || busy} aria-pressed={tool.startsWith('mask-')} onClick={() => onTool('mask-add')}>Correct prepared mask (M)</button>
      <button disabled={!ready || busy} onClick={onHealing}>Open Healing panel</button>
    </div></details>
    <ChromeButton label="Select / Move (V)" active={tool === 'select'} disabled={!ready || busy} onClick={() => onTool('select')}><MousePointer2 size={16} /></ChromeButton>
    <ChromeButton label="Pan canvas (H / Space + drag)" active={tool === 'pan'} disabled={!ready || busy} onClick={() => onTool('pan')}><Hand size={16} /></ChromeButton>
  </nav>;
}

export function ContextToolbar(props: { children: ReactNode; leftCollapsed: boolean; rightCollapsed: boolean; onToggleLeft: () => void; onToggleRight: () => void }) {
  return <details className="tool-overflow workspace-options" onKeyDown={event=>{if(event.key==='Escape'){event.currentTarget.open=false;event.currentTarget.querySelector('summary')?.focus();}}}>
    <summary aria-label="Workspace view and options" title="Workspace view and options"><PanelLeftClose size={16} /></summary>
    <div>{props.children}<div className="context-dock-actions"><ChromeButton label={props.leftCollapsed ? 'Expand Page Navigator' : 'Collapse Page Navigator'} active={!props.leftCollapsed} onClick={props.onToggleLeft}><PanelLeftClose size={17} /></ChromeButton><ChromeButton label={props.rightCollapsed ? 'Expand Right Inspector' : 'Collapse Right Inspector'} active={!props.rightCollapsed} onClick={props.onToggleRight}><PanelRightClose size={17} /></ChromeButton></div></div>
  </details>;
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

export function InspectorDock({ onCollapse, children, layerControls, healingControls, imageControls, tab, onTab }: { cardTypography?: (bubble: Bubble) => ReactNode; document: DocumentState | null; selected: Set<string>; onSelect: (id: string, multi: boolean) => void; tab: DockTab; onTab: (tab: DockTab) => void; onCollapse: () => void; children: ReactNode; layerControls: ReactNode; healingControls: ReactNode; imageControls?: ReactNode; textControls?: ReactNode }) {
  const tabs = [
    { key: 'Script', id: 'properties', label: 'Properties', content: children },
    { key: 'Layers', id: 'layers', label: 'Layers', content: layerControls },
    { key: 'Healing', id: 'healing', label: 'Healing', content: healingControls },
    ...(imageControls ? [{ key: 'Image' as const, id: 'image', label: 'Image', content: imageControls }] : []),
  ] as const;
  const selected = tabs.findIndex(item => item.key === (tab === 'Style' ? 'Script' : tab));
  return <aside className="right-dock" aria-label="Properties">
    <div className="dock-tabs" role="tablist" aria-label="Inspector sections">{tabs.map((item,index)=><button key={item.id} id={`tab-${item.id}`} role="tab" aria-selected={selected===index} aria-controls={`inspector-${item.id}`} tabIndex={selected===index?0:-1} onClick={()=>onTab(item.key)} onKeyDown={event=>{
      const keys: Record<string, number> = { ArrowLeft: (index + tabs.length - 1) % tabs.length, ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      const next = keys[event.key];
      if (next === undefined) return;
      event.preventDefault(); onTab(tabs[next].key); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
    }}>{item.label}</button>)}<ChromeButton label="Collapse properties" onClick={onCollapse}><ChevronRight size={14}/></ChromeButton></div>
    <div className="dock-scroll">{tabs.map((item,index)=><div key={item.id} id={`inspector-${item.id}`} role="tabpanel" aria-labelledby={`tab-${item.id}`} hidden={selected!==index}>{item.content}</div>)}</div></aside>;
}

export function EngineStatusBar({ connected, document, job, selected, controller, onCancel, zoom }: { connected: boolean; document: DocumentState | null; job: Job | null; selected: number; tool: StudioTool; controller: ViewportController; onCancel: () => void; zoom?: ReactNode }) {
  const running = job?.status === 'queued' || job?.status === 'running';
  return <footer className="engine-statusbar"><span>{document ? document.dirty ? 'Unsaved' : document.savedPath ? 'Saved' : 'Unmodified' : 'Idle'}</span>{!connected && <span role="status">Connecting…</span>}{running && <span className="engine-job"><LoaderCircle size={13} className="spin"/>{job.message || `${Math.round(job.progress*100)}%`} <button onClick={onCancel}>Cancel</button></span>}<span className="status-grow"/>{zoom ?? <ViewportReadout controller={controller}/>}<span>{selected > 0 ? `${selected} selected · ` : ''}{document?.bubbles?.filter(bubble=>!bubble.excluded).length ?? 0} bubbles</span></footer>;
}
