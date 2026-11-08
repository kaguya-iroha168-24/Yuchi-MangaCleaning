import { useEffect, useState } from 'react';
import type { PageComposition } from '../api';

export function ImageAdjustments({ settings, disabled, onChange }: { settings: PageComposition; disabled: boolean; onChange: (patch: PageComposition) => void }) {
  const brightness = settings.brightness ?? 0;
  const contrast = settings.contrast ?? 0;
  const [draft, setDraft] = useState({ brightness, contrast });
  useEffect(() => { setDraft({ brightness, contrast }); }, [brightness, contrast, disabled]);
  return <section className="selection-properties" aria-label="Image adjustments">
    <h2>Image adjustments</h2>
    <p>Adjustments update Editing and export when you release the control. Original stays available for comparison.</p>
    {settings.artwork_locked && <p>Unlock working artwork in Layers to adjust it.</p>}
    {(['brightness', 'contrast'] as const).map(key => {
      const label = key === 'brightness' ? 'Brightness' : 'Contrast';
      const commit = (value: number) => { if (!disabled && value !== (settings[key] ?? 0)) onChange({ [key]: value }); };
      return <label key={key}>{label} · {draft[key]}
        <input type="range" aria-label={label} min={-100} max={100} value={draft[key]} disabled={disabled}
          onChange={event => setDraft(previous => ({ ...previous, [key]: Number(event.target.value) }))}
          onPointerUp={event => commit(Number(event.currentTarget.value))}
          onKeyUp={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) commit(Number(event.currentTarget.value)); }}
          onBlur={event => commit(Number(event.currentTarget.value))} />
      </label>;
    })}
    <button disabled={disabled || (!brightness && !contrast)} onClick={() => onChange({ brightness: 0, contrast: 0 })}>Reset adjustments</button>
  </section>;
}
