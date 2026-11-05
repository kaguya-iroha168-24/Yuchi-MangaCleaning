import { useState } from 'react';
import type { TextRegion } from '../api';
import type { RegionRect } from '../ui/regionEditing';
import { ModalFrame } from './PreferencesDialog';
export type TextEditSession = { id: string | null; rect: RegionRect; text: string; raw: string | null };
export function SourceTextDialog({ session, busy, error, onClose, onSave }: { session: TextEditSession; busy: boolean; error: string; onClose: () => void; onSave: (value: string) => void }) {
  const [value, setValue] = useState(session.text);
  return <ModalFrame title={session.id ? 'Edit TextRegion' : 'New TextRegion'} onClose={() => { if (!busy) onClose(); }} className="source-text-dialog"><form className="source-text-form" onSubmit={event => { event.preventDefault(); if (!busy) onSave(value); }}>
    <p>Source transcription · native area {session.rect.join(', ')}. Font styling and rendered dialogue export are PLANNED; this editor saves source text and its region.</p>
    <label>Source text<textarea autoFocus aria-label="TextRegion source text" maxLength={20000} value={value} disabled={busy} onChange={event => setValue(event.target.value)} /></label>
    {session.raw !== null && <label>Raw OCR · read only<textarea aria-label="TextRegion raw OCR" readOnly value={session.raw} /></label>}
    {error && <p role="alert">{error}</p>}<div className="source-text-actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="studio-action primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save TextRegion'}</button></div>
  </form></ModalFrame>;
}
export const sessionForRegion = (region: TextRegion): TextEditSession => ({ id: region.id, rect: [...region.rect] as RegionRect, text: region.text, raw: region.ocr?.raw_text ?? null });
