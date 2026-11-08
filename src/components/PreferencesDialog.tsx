import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, Moon, Sun, X } from 'lucide-react';
import type { Api, DetectionMode } from '../api';

const categories = ['Translate', 'General', 'Editing', 'Text', 'About'] as const;
type Category = typeof categories[number];
export type Density = 'Balanced' | 'Compact' | 'Comfortable';
export type Theme = 'light' | 'dark';
export type TranslationSettings = { configured: boolean; model: string; style: string };

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

export function PreferencesDialog(props: { api: Api | null; onClose: () => void; theme: Theme; onTheme: (value: Theme) => void; needsGeminiKey?: boolean; density: Density; onDensity: (value: Density) => void; exportFormat: 'png' | 'jpeg'; onExportFormat: (value: 'png' | 'jpeg') => void; provider: string; onProvider: (value: string) => void; detectionMode: DetectionMode; onDetectionMode: (mode: DetectionMode) => void; textMode: 'clean' | 'overlay'; onTextMode?: (mode: 'clean' | 'overlay') => void; busy: boolean; onReset: () => void }) {
  const [category, setCategory] = useState<Category>('Translate');
  return <ModalFrame title="Settings" onClose={props.onClose} className="preferences-dialog"><div className="preferences-layout"><nav aria-label="Settings categories">{categories.map(name => <button key={name} aria-current={name === category ? 'page' : undefined} onClick={() => setCategory(name)}>{name}</button>)}</nav><div className="preferences-content">
    {category === 'Translate' && (props.api ? <GeminiSettings api={props.api} busy={props.busy} needsKey={props.needsGeminiKey} /> : <p>Connect to the local engine to configure Gemini.</p>)}
    {category === 'General' && <section className="preference-group">
      <h3>Appearance</h3>
      <div className="theme-options" role="group" aria-label="Appearance">
        <button aria-pressed={props.theme === 'light'} onClick={() => props.onTheme('light')}><Sun size={15} /> Paper White</button>
        <button aria-pressed={props.theme === 'dark'} onClick={() => props.onTheme('dark')}><Moon size={15} /> Dark</button>
      </div>
      <label>Interface density<select value={props.density} onChange={e => props.onDensity(e.target.value as Density)}><option>Balanced</option><option>Compact</option><option>Comfortable</option></select></label><button onClick={props.onReset}>Reset workspace layout</button><p>Display scaling: {Math.round(window.devicePixelRatio*100)}%</p>
    </section>}
    {category === 'Editing' && <section className="preference-group">
      <h3>Text treatment</h3>
      <div className="editing-text-treatment" role="group" aria-label="Text treatment">
        <button aria-pressed={props.textMode === 'clean'} disabled={!props.onTextMode || props.busy} onClick={() => props.onTextMode?.('clean')}>Clean</button>
        <button aria-pressed={props.textMode === 'overlay'} disabled={!props.onTextMode || props.busy} onClick={() => props.onTextMode?.('overlay')}>Overlay</button>
      </div>
      <p>{props.onTextMode ? 'Applies to this page and sets the mode for the next Process run. Overlay covers source text when a linked translation is visible.' : 'Open a page to choose its text treatment.'}</p>
      <label>Detection mode<select value={props.detectionMode} disabled={props.busy} onChange={e => props.onDetectionMode(e.target.value as DetectionMode)}><option value="bubble">Bubble</option><option value="text">Text only</option></select></label>
      <p>{props.detectionMode === 'text' ? 'Finds boxes around original lettering. Uses existing bubble outlines as a filter when available.' : 'Finds bubble containers and applies the selected text treatment.'}</p>
      {props.detectionMode === 'bubble' && <label>Detector<select value={props.provider} disabled={props.busy} onChange={e => props.onProvider(e.target.value)}><option value="shima_v1">Shima V1</option><option value="opencv">OpenCV fallback</option></select></label>}<label>Export format<select value={props.exportFormat} onChange={e => props.onExportFormat(e.target.value as 'png' | 'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label><p>Changes apply to the next scan or export.</p></section>}
    {category === 'Text' && <section className="preference-group"><h3>Universal OCR</h3><p>Use Auto Detect Text on a selected bubble. Review its proposal before accepting. Manual source correction and Indonesian dialogue remain separate.</p><p>Choose fonts and Auto Fit per dialogue in Properties.</p></section>}
    {category === 'About' && <section className="preference-group"><h3>Yuchi Labs — MangaClean Atelier</h3><p>Version 0.1.0</p><p>Ctrl+O Open · Ctrl+S Save · Ctrl+E Export<br/>Ctrl+Z Undo · Ctrl+Shift+Z Redo<br/>V Select · B Region · T Text · H Pan</p></section>}
  </div></div><footer className="preferences-footer"><button className="studio-action primary" onClick={props.onClose}>Done</button></footer></ModalFrame>;
}

function GeminiSettings({ api, busy, needsKey }: { api: Api; busy: boolean; needsKey?: boolean }) {
  const keyInput = useRef<HTMLInputElement>(null);
  const [config, setConfig] = useState<TranslationSettings | null>(null);
  const [model, setModel] = useState('');
  const [style, setStyle] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let current = true;
    void api.get<TranslationSettings>('/v1/translation/capabilities').then(result => {
      if (current) { setConfig(result); setModel(result.model); setStyle(result.style); }
    }).catch(() => { if (current) setNotice('Could not load Gemini settings.'); });
    return () => { current = false; };
  }, [api]);
  const update = async (intent: 'test' | 'clear') => {
    setPending(true); setNotice('');
    const key = keyInput.current?.value.trim() ?? '';
    try {
      const result = await api.post<TranslationSettings>('/v1/translation/settings', intent === 'clear' ? { clear: true } : { model: model.trim() || config?.model, key, style });
      if (keyInput.current) keyInput.current.value = '';
      setConfig(result); setModel(result.model); setStyle(result.style);
      setNotice(intent === 'clear' ? 'API key removed.' : 'Gemini connection verified for this session.');
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : 'Gemini settings could not be updated.'); }
    finally { setPending(false); }
  };
  return <section className="preference-group gemini-settings">
    <div className="gemini-summary"><strong>Gemini</strong><span>Indonesian</span></div>
    <label>Gemini model<input value={model} placeholder={config?.model} maxLength={87} onChange={event => setModel(event.target.value)} disabled={!config || busy || pending} /></label>
    <div className="gemini-key-row">
      <label>Gemini API key<input ref={keyInput} type="password" autoComplete="off" maxLength={200} disabled={!config || busy || pending} placeholder={config?.configured ? 'Verified for this session' : 'Enter key'} /></label>
      <button disabled={!config || busy || pending} onClick={() => void update('test')}>Test connection</button>
    </div>
    <p className="gemini-status" role="status">{pending ? 'Checking Gemini connection…' : notice || (needsKey && !config?.configured ? 'Verify a key, then click Translate again.' : '')}</p>
    <label>Translation style<textarea value={style} maxLength={1000} rows={3} onChange={event => setStyle(event.target.value)} disabled={!config || busy || pending} placeholder="Optional tone or terminology" /></label>
    <p>Translate sends original text crops or corrected transcriptions to Google Gemini. All Pages controls the scope. Your key stays in memory until MangaClean closes.</p>
    {config?.configured && <button disabled={busy || pending} onClick={() => void update('clear')}>Remove key</button>}
  </section>;
}

export function QuickExportDialog({ onClose, onExport, width, height, busy, typographyNotice, chapterCount, onExportPages }: { chapterCount?: number; onExportPages?: (kind: 'png' | 'jpeg') => void; typographyNotice?: ReactNode; onClose: () => void; onExport: (kind: 'png' | 'jpeg') => void; width: number; height: number; busy: boolean }) {
  return <ModalFrame title="Quick Export" onClose={onClose} className="quick-export-dialog"><div className="export-dialog-body"><p>Export the working image with visible text layers at native resolution: <strong>{width} × {height}</strong>.</p>{typographyNotice}<div className="export-format-buttons"><button className="studio-action primary" disabled={busy} onClick={() => onExport('png')}><Download size={16} /> Export PNG</button><button className="studio-action" disabled={busy} onClick={() => onExport('jpeg')}><Download size={16} /> Export JPEG</button></div>{chapterCount && chapterCount > 1 && <section><h3>Chapter · selected pages, or all if none selected</h3><button disabled={busy} onClick={()=>onExportPages?.('png')}>Export chapter PNG</button><button disabled={busy} onClick={()=>onExportPages?.('jpeg')}>Export chapter JPEG</button></section>}<p className="availability-note">PNG/JPEG export checks visible dialogue rendering before writing the final image. Project Save remains available for unfinished work.</p></div></ModalFrame>;
}
