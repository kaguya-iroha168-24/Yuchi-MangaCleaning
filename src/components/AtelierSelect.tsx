import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

export type AtelierBadgeTone = 'emerald' | 'sky' | 'amber' | 'rose' | 'neutral';

export interface AtelierSelectOption {
  value: string;
  label: string;
  badge?: string;
  badgeTone?: AtelierBadgeTone;
  sublabel?: string;
  disabled?: boolean;
}

export interface AtelierSelectProps {
  value: string;
  options: AtelierSelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  ariaLabel?: string;
  className?: string;
  triggerClassName?: string;
  menuMinWidth?: number;
  showTriggerBadge?: boolean;
  testId?: string;
}

const BADGE_CLASSES: Record<AtelierBadgeTone, string> = {
  emerald: 'bg-[#10B981]/15 text-[#34D399] border border-[#10B981]/30',
  sky: 'bg-[#38BDF8]/15 text-[#38BDF8] border border-[#38BDF8]/30',
  amber: 'bg-[#F59E0B]/15 text-[#FBBF24] border border-[#F59E0B]/30',
  rose: 'bg-[#E11D48]/15 text-[#FB7185] border border-[#E11D48]/30',
  neutral: 'bg-[#232730] text-[#9BA1AE] border border-[#2F3542]',
};

export function getModelOptionBadge(modelId: string): { badge: string; badgeTone: AtelierBadgeTone } | undefined {
  const id = modelId.toLowerCase();
  if (id.includes('flash-lite') || /(^|[-/])(mini|haiku)($|[-:])/i.test(id)) {
    return { badge: '💰 Ultra-Cheap · Fast', badgeTone: 'emerald' };
  }
  if (/(^|[-/])(pro|reasoner)($|[-:])/i.test(id) || id === 'gpt-4o') {
    return { badge: '🧠 High Reasoning', badgeTone: 'amber' };
  }
  if (id.includes('flash') || id.includes('chat') || id.includes('qwen') || id.includes('gemma') || id.includes('llama')) {
    return { badge: '⚡ Balanced', badgeTone: 'sky' };
  }
  return undefined;
}

type MenuCoords = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  maxHeight: number;
};

export function AtelierSelect({
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select...',
  ariaLabel,
  className = '',
  triggerClassName = '',
  menuMinWidth,
  showTriggerBadge = false,
  testId,
}: AtelierSelectProps) {
  const [open, setOpen] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [coords, setCoords] = useState<MenuCoords | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value) ?? null;

  const updateCoords = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width, menuMinWidth ?? rect.width));
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const estHeight = Math.min(220, Math.max(40, options.length * 32 + 10));
    const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - 8);
    const spaceAbove = Math.max(0, rect.top - 8);
    if (spaceBelow < Math.min(180, estHeight) && spaceAbove > spaceBelow) {
      setCoords({
        left,
        width,
        bottom: window.innerHeight - rect.top + 4,
        maxHeight: Math.min(220, Math.max(100, spaceAbove)),
      });
    } else {
      setCoords({
        left,
        width,
        top: rect.bottom + 4,
        maxHeight: Math.min(220, Math.max(110, spaceBelow)),
      });
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    updateCoords();
    const activeIdx = Math.max(0, options.findIndex(o => o.value === value && !o.disabled));
    setHighlightIndex(activeIdx);
  }, [open, options.length, menuMinWidth]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlightIndex(prev => {
          for (let offset = 1; offset <= options.length; offset += 1) {
            const idx = (prev + offset) % options.length;
            if (!options[idx]?.disabled) return idx;
          }
          return prev;
        });
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlightIndex(prev => {
          for (let offset = 1; offset <= options.length; offset += 1) {
            const idx = (prev - offset + options.length) % options.length;
            if (!options[idx]?.disabled) return idx;
          }
          return prev;
        });
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const item = options[highlightIndex];
        if (item && !item.disabled) {
          onChange(item.value);
          setOpen(false);
          triggerRef.current?.focus();
        }
      }
    };
    const onScrollOrResize = () => updateCoords();
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('scroll', onScrollOrResize, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('scroll', onScrollOrResize, true);
    };
  }, [open, highlightIndex, options, onChange]);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  return (
    <div className={`relative ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-testid={testId}
        onClick={() => {
          if (disabled) return;
          setOpen(prev => !prev);
        }}
        onKeyDown={event => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={`min-h-0 h-8 w-full px-2.5 rounded-md bg-[#161920] hover:bg-[#1A1E27] border ${
          open ? 'border-[#E11D48]' : 'border-[#262B36] hover:border-[#363D4E]'
        } text-xs text-[#F3F4F6] flex items-center justify-between gap-2 transition-colors disabled:opacity-55 disabled:cursor-not-allowed ${triggerClassName}`}
      >
        <span className="flex items-center gap-1.5 min-w-0 flex-1 text-left">
          <span className="truncate">{selectedOption?.label ?? placeholder}</span>
          {showTriggerBadge && selectedOption?.badge && (
            <span
              className={`px-1.5 py-0.5 rounded text-[9px] font-medium leading-none whitespace-nowrap flex-none ${
                BADGE_CLASSES[selectedOption.badgeTone ?? 'neutral']
              }`}
            >
              {selectedOption.badge}
            </span>
          )}
        </span>
        <ChevronDown
          size={13}
          className={`flex-none text-[#8A909E] transition-transform duration-150 ${open ? 'rotate-180 text-[#E11D48]' : ''}`}
        />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            data-atelier-select-open="true"
            style={{
              position: 'fixed',
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              top: coords.top !== undefined ? `${coords.top}px` : undefined,
              bottom: coords.bottom !== undefined ? `${coords.bottom}px` : undefined,
              maxHeight: `${coords.maxHeight}px`,
              zIndex: 500,
            }}
            className="bg-[#14171F] border border-[#2A303F] rounded-lg shadow-2xl py-1 overflow-y-auto"
          >
            {options.map((opt, idx) => {
              const selected = opt.value === value;
              const highlighted = idx === highlightIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  disabled={opt.disabled}
                  onMouseEnter={() => setHighlightIndex(idx)}
                  onClick={() => {
                    if (opt.disabled) return;
                    onChange(opt.value);
                    setOpen(false);
                    triggerRef.current?.focus();
                  }}
                  className={`min-h-0 w-full px-2.5 py-1.5 text-left text-xs flex items-center justify-between gap-2 border-t-0 border-r-0 border-b-0 border-l-2 border-solid transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                    selected
                      ? 'bg-[#E11D48]/15 text-white border-[#E11D48]'
                      : highlighted
                        ? 'bg-[#1D222D] text-[#F3F4F6] border-[#E11D48]/60'
                        : 'bg-transparent text-[#D0D5DD] border-transparent hover:bg-[#1B1F29]'
                  }`}
                >
                  <span className="flex items-center gap-2 min-w-0 flex-1">
                    <span className="truncate font-medium">{opt.label}</span>
                    {opt.sublabel && (
                      <span className="text-[10px] text-[#7D8494] truncate">{opt.sublabel}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-1.5 flex-none">
                    {opt.badge && (
                      <span
                        className={`px-1.5 py-0.5 rounded text-[10px] font-medium leading-none whitespace-nowrap ${
                          BADGE_CLASSES[opt.badgeTone ?? 'neutral']
                        }`}
                      >
                        {opt.badge}
                      </span>
                    )}
                    {selected && <Check size={12} className="text-[#E11D48]" />}
                  </span>
                </button>
              );
            })}
          </div>,
          window.document.body,
        )}
    </div>
  );
}
