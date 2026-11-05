import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Download, X } from 'lucide-react';
import { FeatureBadge } from './StudioShell';

const categories = ['AI & Translation Providers', 'Cleaning & Inpainting', 'Typography & Presets', 'Canvas & Appearance', 'Shortcuts & Keymap', 'Storage & Hardware'] as const;
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

function PlannedGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="preference-group"><h3>{title} <FeatureBadge /></h3><fieldset disabled>{children}</fieldset><p className="availability-note">Not available in this version. These controls do not change your project.</p></section>; }

export function PreferencesDialog(props: { onClose: () => void; density: Density; onDensity: (value: Density) => void; exportFormat: 'png' | 'jpeg'; onExportFormat: (value: 'png' | 'jpeg') => void; device: string; onDevice: (value: string) => void; provider: string; onProvider: (value: string) => void; busy: boolean; onReset: () => void }) {
  const [category, setCategory] = useState<Category>('AI & Translation Providers');
  return <ModalFrame title="Settings & Preferences" onClose={props.onClose} className="preferences-dialog"><div className="preferences-layout"><nav aria-label="Settings categories">{categories.map((name, index) => <button key={name} aria-current={name === category ? 'page' : undefined} onClick={() => setCategory(name)}><b>{index + 1}</b><span>{name}</span></button>)}</nav><div className="preferences-content"><h2>{category}</h2>
    {category === categories[0] && <>
      <section className="preference-group"><h3>OCR Engine Configuration</h3><label>Primary OCR<select disabled><option>Manga OCR · Offline Japanese</option><option disabled>PaddleOCR · PLANNED</option><option disabled>Vision LLM OCR · PLANNED</option></select></label><p className="availability-note">Run Manga OCR on a selected TextRegion in the Script inspector. CPU/GPU is chosen there.</p></section>
      <PlannedGroup title="Translation Provider"><label>Provider<select><option>Choose a provider when translation is available</option>{['Google Gemini', 'OpenAI', 'Anthropic Claude', 'DeepSeek', 'OpenRouter', 'Ollama', 'LM Studio', 'KoboldCpp', 'vLLM'].map(item => <option key={item}>{item}</option>)}</select></label><label>API Key<input type="password" placeholder="Secure provider storage is not available yet" autoComplete="off" /></label><label>Custom Base URL<input placeholder="Local or cloud endpoint" /></label><button>Test Connection & Latency</button></PlannedGroup>
      <PlannedGroup title="Multi-Page Mosaic Batching"><label><input type="checkbox" /> Enable Mosaic Grid Batching</label><label>Max Bubbles per Mosaic<input type="range" min="4" max="64" /></label><label>Request Throttle / Cooldown<input type="number" placeholder="ms" /></label></PlannedGroup>
      <PlannedGroup title="Prompt & Context"><label>Source language<select><option>Japanese</option><option>Korean</option><option>Chinese</option><option>English</option></select></label><label>Target language<select><option>Indonesian</option><option>English</option></select></label><label>Temperature<input type="range" min="0" max="1" step="0.1" /></label><label>Custom System Prompt<textarea placeholder="{{source_lang}} · {{target_lang}} · {{glossary_json}} · {{previous_page_context}}" /></label></PlannedGroup>
    </>}
    {category === categories[1] && <>
      <section className="preference-group"><h3>Bubble & Text Detection</h3><label>Detector<select disabled={props.busy} value={props.provider} onChange={event => props.onProvider(event.target.value)}><option value="shima_v1">Shima V1</option><option value="opencv">OpenCV fallback</option><option disabled>Shima Beta · research · unavailable</option><option disabled>Multi-Class AI Detector · PLANNED</option></select></label><p className="availability-note">Selecting a detector affects the next scan. Existing candidates are preserved.</p></section>
      <PlannedGroup title="Detector Configuration"><label>Confidence Threshold<input type="range" min="0.25" max="0.9" step="0.01" /></label><label>Vector Mask Padding / Bleed<input type="number" min="1" max="10" placeholder="native px" /></label><p>Current engine thresholds and checkpoint remain unchanged.</p></PlannedGroup>
      <PlannedGroup title="Smart Cleaning Routing"><label>Auto-Classifier Threshold<input type="range" min="0" max="15" /></label><label>Background Sampling<select><option>Edge Median Sampling</option><option>Brightest Peak</option></select></label><label>LaMa Model Management<select><option>LaMa · not available in this workflow</option></select></label><button>Model Weights Downloader</button></PlannedGroup>
      <p>Auto / Recommended, Telea Inpainting and White Bubble Clean remain available in the Cleaning inspector.</p>
    </>}
    {category === categories[2] && <><p>Font family, size, weight, color, alignment, safe padding and Auto Fit are available per dialogue in the Typography Inspector. Presets and advanced layout rules below remain planned.</p><PlannedGroup title="Font Preset Manager">{['Standard Dialogue', 'Shouting / Scream', 'Internal Thought', 'Narration / Box', 'Outside Bubble / Floating'].map(item => <label key={item}>{item}<select><option>Font preset unavailable</option></select></label>)}</PlannedGroup><PlannedGroup title="Typesetting Engine Rules"><label>Auto-Sizing (Kyusu) bounds<input placeholder="8–42 pt" /></label><label>Bubble Safe Margin<input type="number" placeholder="%" /></label><label>Hyphenation & Word Breaking<select><option>Diamond Layout</option></select></label><button>Custom Font Directory…</button></PlannedGroup></>}
    {category === categories[3] && <>
      <section className="preference-group"><h3>Canvas & Appearance</h3><label>Interface density<select value={props.density} onChange={event => props.onDensity(event.target.value as Density)}><option>Balanced</option><option>Compact</option><option>Comfortable</option></select></label><label>Theme<select disabled><option>Dark Studio</option></select></label><p>Canvas workspace: Matte Graphite <code>#252B32</code>. Image colors and transparency remain unchanged.</p><p>Windows display scale: {Math.round(window.devicePixelRatio * 100)}%</p><button className="studio-action" onClick={props.onReset}>Reset workspace layout</button></section>
      <PlannedGroup title="Dual Viewport & Overlays"><label>Split orientation<select><option>Horizontal · Original / Editing</option><option>Vertical</option></select></label><label><input type="checkbox" /> Ghost Cursor</label><label>Outline Stroke<input type="number" placeholder="px" /></label><label><input type="checkbox" /> Auto-Hide Vector Outlines While Typing</label></PlannedGroup>
    </>}
    {category === categories[4] && <><section className="preference-group"><h3>Default Hybrid Keymap</h3><table className="keymap-table"><thead><tr><th>Shortcut</th><th>Action</th><th>Status</th></tr></thead><tbody>{[
      ['V / B / H', 'Select / Box Draw / Pan', 'WORKING'], ['M', 'Prepared mask brush', 'PARTIAL'], ['Z', 'Zoom in', 'WORKING'], ['Space + Drag', 'Temporary Pan', 'WORKING'], ['Ctrl + O', 'Open', 'WORKING'], ['Ctrl + S', 'Save Project', 'WORKING'], ['Ctrl + Shift + S', 'Scan Active Page', 'WORKING'], ['Ctrl + Z / Ctrl + Shift + Z', 'Undo / Redo', 'WORKING'], ['Ctrl + E', 'Quick Export', 'WORKING'], ['Ctrl + ,', 'Settings', 'WORKING'], ['T', 'Create editable dialogue layer', 'WORKING'], ['P / S / I / L', 'Vector / Stamp / Eyedropper / Redraw', 'PLANNED'], ['Tab / F', 'Viewport Quick Peek / Single-Dual View', 'WORKING'], ['Ctrl + Scroll', 'Pointer-centered Zoom', 'WORKING'], ['A / D / PageUp / PageDown', 'Bubble / Page navigation', 'PLANNED'], ['Ctrl + Shift + C', 'Auto-Clean Selected — not available', 'PLANNED'], ['Ctrl + Enter', 'Commit & Next Bubble — not available', 'PLANNED'],
    ].map(([keys, action, status]) => <tr key={keys}><td><kbd>{keys}</kbd></td><td>{action}</td><td>{status}</td></tr>)}</tbody></table><p>Editor shortcuts are scoped away from text input, IME, menus and dialogs. Ctrl+Shift+S is distinct from Ctrl+S.</p></section><PlannedGroup title="Interactive Keymap & Pen Tablet"><label>Profile<select><option>Default Hybrid</option><option>Photoshop/CSP Familiar</option><option>Chisa Classic</option></select></label><button>Remap Shortcuts / Live Conflict Detection</button><label><input type="checkbox" /> Pressure Sensitivity Mapping</label><label><input type="checkbox" /> Single-Key Hold Modifiers</label></PlannedGroup></>}
    {category === categories[5] && <>
      <section className="preference-group"><h3>Compute Backend</h3><label>Detection device<select value={props.device} disabled={props.busy} onChange={event => props.onDevice(event.target.value)}><option value="auto">Auto · CPU fallback</option><option value="cpu">CPU</option><option value="cuda:0">GPU · CUDA</option><option disabled>ROCm · PLANNED</option><option disabled>DirectML · PLANNED</option><option disabled>Vulkan · PLANNED</option></select></label><label>Export format<select value={props.exportFormat} onChange={event => props.onExportFormat(event.target.value as 'png' | 'jpeg')}><option value="png">PNG</option><option value="jpeg">JPEG</option></select></label><p>Device selection applies to the next inference. The status bar reports the device actually used.</p></section>
      <PlannedGroup title="Storage, Cache & History"><label>Auto-Save Interval<input type="number" placeholder="minutes" /></label><label>Undo History Limit<input type="number" min="50" max="500" /></label><label>VRAM Cap<input type="number" placeholder="GiB" /></label><label>Batch Inference<input type="number" /></label><button>Clear Temporary Mosaic & Inpaint Cache</button></PlannedGroup>
    </>}
  </div></div></ModalFrame>;
}

export function QuickExportDialog({ onClose, onExport, width, height, busy, typographyNotice }: { typographyNotice?: ReactNode; onClose: () => void; onExport: (kind: 'png' | 'jpeg') => void; width: number; height: number; busy: boolean }) {
  return <ModalFrame title="Quick Export" onClose={onClose} className="quick-export-dialog"><div className="export-dialog-body"><p>Export the working image with visible text layers at native resolution: <strong>{width} × {height}</strong>.</p>{typographyNotice}<div className="export-format-buttons"><button className="studio-action primary" disabled={busy} onClick={() => onExport('png')}><Download size={16} /> Export PNG</button><button className="studio-action" disabled={busy} onClick={() => onExport('jpeg')}><Download size={16} /> Export JPEG</button></div><div className="planned-feature-list">{['Layered PSD / Editable Text', 'PDF / CBZ / ZIP', 'WebP / Chapter Naming Rules', 'Advanced QA Checks'].map(label => <div key={label}><button disabled>{label}</button><FeatureBadge /></div>)}</div><p className="availability-note">PNG/JPEG export checks visible dialogue rendering before writing the final image. Project Save remains available for unfinished work. Other automated QA checks are planned.</p></div></ModalFrame>;
}
