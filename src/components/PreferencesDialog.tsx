import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';

const categories = ['General', 'Editing', 'Text', 'About'] as const;
type Category = typeof categories[number];
export type Density = 'Balanced' | 'Compact' | 'Comfortable';

export function ModalFrame({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const modal = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    modal.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); }
      if (event.key === 'Tab') {
        const items = [...(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])];
        const first = items[0], last = items.at(-1);
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { window.removeEventListener('keydown', key, true); previous?.focus(); };
  }, []);
  return createPortal(<div className="studio-modal-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) onClose(); }}><div className={`studio-modal ${className}`} ref={modal} role="dialog" aria-modal="true" aria-label={title}><div className="studio-modal-heading"><h2>{title}</h2><button aria-label={`Close ${title}`} onClick={onClose}><X size={18} /></button></div>{children}</div></div>, window.document.body);
}

export function PreferencesDialog(props: { onClose: () => void; density: Density; onDensity: (value: Density) => void; exportFormat: 'png' | 'jpeg'; onExportFormat: (value: 'png' | 'jpeg') => void; device: string; onDevice: (value: string) => void; provider: string; onProvider: (value: string) => void; busy: boolean; onReset: () => void }) {
  const [category, setCategory] = useState<Category>('General');
  return <ModalFrame title="Settings & Preferences" onClose={props.onClose} className="preferences-dialog"><div className="preferences-layout"><nav aria-label="Settings categories">{categories.map((name, index) => <button key={name} aria-current={name === category ? 'page' : undefined} onClick={() => setCategory(name)}><b>{index + 1}</b><span>{name}</span></button>)}</nav><div className="preferences-content"><h2>{category}</h2>
    {category === 'General' && <section className="preference-group"><label>Interface density<select value={props.density} onChange={e => props.onDensity(e.target.value as Density)}><option>Balanced</option><option>Compact</option><option>Comfortable</option></select></label><button onClick={props.onReset}>Reset workspace layout</button><p>Display scaling: {Math.round(window.devicePixelRatio*100)}%</p></section>}
    {category === 'Editing' && <section className="preference-group"><label>Detector<select value={props.provider} disabled={props.busy} onChange={e => props.onProvider(e.target.value)}><option value="shima_v1">Shima V1</option><option value="opencv">OpenCV fallback</option></select></label><label>Detection device<select value={props.device} disabled={props.busy} onChange={e => props.onDevice(e.target.value)}><option value="auto">Auto · CPU fallback</option><option value="cpu">CPU</option><option value="cuda:0">GPU · CUDA</option></select></label><label>Export format<select value={props.exportFormat} onChange={e => props.onExportFormat(e.target.value as 'png' | 'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label><p>Changes apply to the next scan or export.</p></section>}
    {category === 'Text' && <section className="preference-group"><h3>Universal OCR</h3><p>Use Auto Detect Text on a selected bubble. Review its proposal before accepting. Manual source correction and Indonesian dialogue remain separate.</p><p>Choose fonts and Auto Fit per dialogue in Properties.</p></section>}
    {category === 'About' && <section className="preference-group"><h3>Yuchi Labs — MangaClean Atelier</h3><p>Version 0.1.0 · Sumi & Hikari</p><p>Ctrl+O Open · Ctrl+S Save · Ctrl+E Export<br/>Ctrl+Z Undo · Ctrl+Shift+Z Redo<br/>V Select · B Region · T Text · H Pan</p></section>}
  </div></div></ModalFrame>;
}

export function QuickExportDialog({ onClose, onExport, width, height, busy, typographyNotice, chapterCount, onExportPages }: { chapterCount?: number; onExportPages?: (kind: 'png' | 'jpeg') => void; typographyNotice?: ReactNode; onClose: () => void; onExport: (kind: 'png' | 'jpeg') => void; width: number; height: number; busy: boolean }) {
  return <ModalFrame title="Quick Export" onClose={onClose} className="quick-export-dialog"><div className="export-dialog-body"><p>Export the working image with visible text layers at native resolution: <strong>{width} × {height}</strong>.</p>{typographyNotice}<div className="export-format-buttons"><button className="studio-action primary" disabled={busy} onClick={() => onExport('png')}><Download size={16} /> Export PNG</button><button className="studio-action" disabled={busy} onClick={() => onExport('jpeg')}><Download size={16} /> Export JPEG</button></div>{chapterCount && chapterCount > 1 && <section><h3>Chapter · selected pages, or all if none selected</h3><button disabled={busy} onClick={()=>onExportPages?.('png')}>Export chapter PNG</button><button disabled={busy} onClick={()=>onExportPages?.('jpeg')}>Export chapter JPEG</button></section>}<p className="availability-note">PNG/JPEG export checks visible dialogue rendering before writing the final image. Project Save remains available for unfinished work.</p></div></ModalFrame>;
}
