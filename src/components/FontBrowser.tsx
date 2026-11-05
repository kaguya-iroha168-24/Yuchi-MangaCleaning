import { useMemo, useRef, useState } from 'react';
import type { FontEntry } from '../api';
import './font-browser.css';

export function FontBrowser({ fonts, value, disabled, onSelect }: { fonts: FontEntry[]; value: string; disabled: boolean; onSelect: (family: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const shown = useMemo(() => fonts.filter(font => font.family.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [fonts, query]);
  const current = fonts.find(font => font.family === value);
  return <div className="font-browser"><span>Font family</span><button ref={trigger} type="button" aria-label="Typography font family" aria-expanded={open} disabled={disabled} onClick={() => setOpen(!open)}>{value} · {current?.status ?? 'Missing'}</button>
    {open && <div className="font-browser-panel" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.font-browser-item:not(:disabled)')];
        if (!items.length) return;
        event.preventDefault(); const active = items.indexOf(window.document.activeElement as HTMLButtonElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : active < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[index].focus();
      }
    }}><input autoFocus aria-label="Search fonts" placeholder="Search fonts…" value={query} onChange={event => setQuery(event.target.value)} /><div className="font-browser-list" aria-label="Font choices">{shown.map(font => <button key={font.family} type="button" className="font-browser-item" aria-pressed={font.family === value} disabled={disabled || font.status !== 'Available'} title={font.warning ?? font.license} onClick={() => { onSelect(font.family); close(); }}><span>{font.family}<small>{font.status ?? 'Missing'}{font.family === value ? ' · Selected' : ''}</small></span>{font.status === 'Available' && font.preview ? <img loading="lazy" src={`data:image/png;base64,${font.preview}`} alt={`${font.family}: ${font.sample}`} /> : <span>Preview unavailable</span>}</button>)}{!shown.length && <p>No matching fonts.</p>}</div></div>}
  </div>;
}
