import { useState, type ReactNode } from 'react';
import { Eye, EyeOff, Hash, Image as ImageIcon, Layers, Lock, Move, Scan, Sparkles, Type, Unlock } from 'lucide-react';
import type { PageComposition } from '../api';
import type { ViewportController } from '../ui/viewport';

export type LayerOpacityState = {
  typeset: number;
  mask: number;
  working: number;
  original: number;
};

type LayerId = 'typeset' | 'mask' | 'working' | 'original';

interface LayersPanelProps {
  composition: PageComposition;
  showOriginal: boolean;
  onShowOriginal: (value: boolean) => void;
  showWorking: boolean;
  onShowWorking: (value: boolean) => void;
  showTypography: boolean;
  onShowTypography: (value: boolean) => void;
  showRegions: boolean;
  onShowRegions: (value: boolean) => void;
  showSelection: boolean;
  onShowSelection: (value: boolean) => void;
  showBoxes: boolean;
  onShowBoxes: (value: boolean) => void;
  showMask: boolean;
  onShowMask: (value: boolean) => void;
  hasMask: boolean;
  opacity: LayerOpacityState;
  onOpacityChange: (layer: LayerId, value: number) => void;
  onChangeComposition: (patch: Partial<PageComposition>) => void;
  viewport: ViewportController;
  disabled: boolean;
  typographyLayerList?: ReactNode;
}

export function LayersPanel(props: LayersPanelProps) {
  const [selectedLayer, setSelectedLayer] = useState<LayerId>('working');
  const [peeking, setPeeking] = useState(false);
  const [typesetLocked, setTypesetLocked] = useState(false);
  const [maskLocked, setMaskLocked] = useState(false);

  const startPeek = () => {
    setPeeking(true);
    props.viewport.update({ peek: true });
  };

  const stopPeek = () => {
    if (!peeking) return;
    setPeeking(false);
    props.viewport.update({ peek: false });
  };

  const stack: Array<{
    id: LayerId;
    name: string;
    badge: string;
    icon: ReactNode;
    visible: boolean;
    onToggleVisible: () => void;
    visibleDisabled?: boolean;
    lockable: boolean;
    locked?: boolean;
    onToggleLock?: () => void;
  }> = [
    {
      id: 'typeset',
      name: 'Typeset Text Layer',
      badge: 'Vector / Live',
      icon: <Type size={14} className="text-sky-400" />,
      visible: props.showTypography,
      onToggleVisible: () => props.onShowTypography(!props.showTypography),
      lockable: true,
      locked: typesetLocked,
      onToggleLock: () => setTypesetLocked(v => !v),
    },
    {
      id: 'mask',
      name: 'Inpaint / Healing Mask',
      badge: 'AI + Manual',
      icon: <Sparkles size={14} className="text-rose-400" />,
      visible: props.showMask,
      onToggleVisible: () => props.onShowMask(!props.showMask),
      visibleDisabled: !props.hasMask,
      lockable: true,
      locked: maskLocked,
      onToggleLock: () => setMaskLocked(v => !v),
    },
    {
      id: 'working',
      name: 'Cleaned / Working Artwork',
      badge: 'Active Canvas',
      icon: <Layers size={14} className="text-emerald-400" />,
      visible: props.showWorking,
      onToggleVisible: () => props.onShowWorking(!props.showWorking),
      lockable: true,
      locked: Boolean(props.composition.artwork_locked),
      onToggleLock: () => props.onChangeComposition({ artwork_locked: !props.composition.artwork_locked }),
    },
    {
      id: 'original',
      name: 'Raw Original Manga',
      badge: 'Base Reference',
      icon: <ImageIcon size={14} className="text-amber-400" />,
      visible: props.showOriginal,
      onToggleVisible: () => props.onShowOriginal(!props.showOriginal),
      lockable: false,
    },
  ];

  const activeTarget =
    props.composition.artwork === 'original' || props.composition.text_mode === 'overlay'
      ? 'raw-typeset'
      : !props.showTypography
        ? 'cleaned-only'
        : 'cleaned-typeset';

  const setPipelineTarget = (mode: 'cleaned-typeset' | 'cleaned-only' | 'raw-typeset') => {
    if (mode === 'cleaned-typeset') {
      props.onShowTypography(true);
      props.onChangeComposition({ artwork: 'working', text_mode: 'clean' });
    } else if (mode === 'cleaned-only') {
      props.onShowTypography(false);
      props.onChangeComposition({ artwork: 'working', text_mode: 'clean' });
    } else {
      props.onShowTypography(true);
      props.onChangeComposition({ artwork: 'original', text_mode: 'overlay' });
    }
  };

  return (
    <div className="flex flex-col gap-3 text-xs text-[#E5E7EB]">
      {/* Quick-Compare Hold Action */}
      <button
        type="button"
        onPointerDown={startPeek}
        onPointerUp={stopPeek}
        onPointerLeave={stopPeek}
        onPointerCancel={stopPeek}
        className={`w-full min-h-[28px] px-2.5 py-1.5 rounded-md border text-[11px] font-medium flex items-center justify-center gap-1.5 transition-all duration-150 ${
          peeking
            ? 'bg-[#EF4444]/20 border-[#EF4444] text-[#FCA5A5]'
            : 'bg-[#14161B] border-[#232730] text-[#9CA3AF] hover:text-[#F3F4F6] hover:border-[#323846]'
        }`}
      >
        <Eye size={13} />
        <span>{peeking ? 'Peeking Raw Manga…' : 'Hold [Space / Tab] to Peek Raw'}</span>
      </button>

      {/* Section 1: Composite Artwork Stack */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
            Composite Artwork Stack
          </span>
          <span className="text-[10px] font-mono text-[#6B7280]">Z-Order</span>
        </div>

        {stack.map(layer => {
          const isSelected = selectedLayer === layer.id;
          const pct = props.opacity[layer.id];
          return (
            <div
              key={layer.id}
              onClick={() => setSelectedLayer(layer.id)}
              className={`bg-[#14161B] border rounded-md p-2 flex flex-col gap-2 cursor-pointer transition-colors duration-150 ${
                isSelected ? 'border-[#EF4444]/70 bg-[#181B22]' : 'border-[#232730] hover:border-[#323846]'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    type="button"
                    aria-label={`Toggle ${layer.name} visibility`}
                    disabled={layer.visibleDisabled}
                    onClick={e => {
                      e.stopPropagation();
                      layer.onToggleVisible();
                    }}
                    className={`w-7 h-7 flex-none rounded flex items-center justify-center border transition-colors ${
                      layer.visibleDisabled
                        ? 'opacity-35 cursor-not-allowed border-transparent text-[#6B7280]'
                        : layer.visible
                          ? 'bg-[#1C1F26] border-[#2D323E] text-[#F3F4F6] hover:border-[#4B5563]'
                          : 'bg-transparent border-transparent text-[#6B7280] hover:text-[#9CA3AF]'
                    }`}
                  >
                    {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>

                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="flex-none">{layer.icon}</span>
                    <div className="flex flex-col min-w-0">
                      <span className="text-[11px] font-medium text-[#F3F4F6] truncate leading-tight">
                        {layer.name}
                      </span>
                      <span className="text-[9px] font-mono text-[#9CA3AF] leading-tight">
                        {layer.badge}
                      </span>
                    </div>
                  </div>
                </div>

                {layer.lockable && (
                  <button
                    type="button"
                    aria-label={`Toggle ${layer.name} lock`}
                    disabled={props.disabled && layer.id === 'working'}
                    onClick={e => {
                      e.stopPropagation();
                      layer.onToggleLock?.();
                    }}
                    className={`w-7 h-7 flex-none rounded flex items-center justify-center border transition-colors ${
                      layer.locked
                        ? 'bg-[#EF4444]/15 border-[#EF4444]/60 text-[#FCA5A5]'
                        : 'bg-transparent border-transparent text-[#6B7280] hover:text-[#D1D5DB] hover:bg-[#1C1F26]'
                    }`}
                    title={layer.locked ? 'Locked' : 'Unlocked'}
                  >
                    {layer.locked ? <Lock size={13} /> : <Unlock size={13} />}
                  </button>
                )}
              </div>

              {isSelected && (
                <div
                  className="flex items-center gap-2 pt-1.5 border-t border-[#232730]"
                  onClick={e => e.stopPropagation()}
                >
                  <span className="text-[10px] text-[#9CA3AF] w-11 flex-none">Opacity</span>
                  <div className="relative flex-1 h-5 flex items-center">
                    <div className="w-full h-1.5 rounded-full bg-[#232730] overflow-hidden">
                      <div
                        className="h-full bg-[#EF4444] rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={pct}
                      aria-label={`${layer.name} opacity`}
                      onChange={e => props.onOpacityChange(layer.id, Number(e.target.value))}
                      className="studio-range-overlay"
                    />
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[#0D0E11] border border-[#232730] text-[#F3F4F6] w-10 text-right">
                    {pct}%
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Dialogue sub-layers */}
      {props.typographyLayerList && (
        <div className="pt-1 border-t border-[#232730]">{props.typographyLayerList}</div>
      )}

      {/* Section 2: Viewport HUD & Geometry Overlays (2x2 Grid) */}
      <div className="flex flex-col gap-1.5 pt-1 border-t border-[#232730]">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] px-0.5">
          Viewport Overlays (HUD)
        </span>
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            aria-pressed={props.showRegions}
            onClick={() => props.onShowRegions(!props.showRegions)}
            className={`min-h-[28px] px-2 py-1.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors duration-150 ${
              props.showRegions
                ? 'bg-[#1C1F26] border-[#EF4444]/60 text-[#F3F4F6]'
                : 'bg-[#14161B] border-[#232730] text-[#9CA3AF] hover:border-[#323846]'
            }`}
          >
            <Hash size={12} className={props.showRegions ? 'text-[#EF4444]' : 'text-[#6B7280]'} />
            <span className="truncate">Bounding Boxes</span>
          </button>

          <button
            type="button"
            aria-pressed={props.showSelection}
            onClick={() => props.onShowSelection(!props.showSelection)}
            className={`min-h-[28px] px-2 py-1.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors duration-150 ${
              props.showSelection
                ? 'bg-[#1C1F26] border-[#EF4444]/60 text-[#F3F4F6]'
                : 'bg-[#14161B] border-[#232730] text-[#9CA3AF] hover:border-[#323846]'
            }`}
          >
            <Move size={12} className={props.showSelection ? 'text-[#EF4444]' : 'text-[#6B7280]'} />
            <span className="truncate">Transform Handles</span>
          </button>

          <button
            type="button"
            aria-pressed={props.showBoxes}
            onClick={() => props.onShowBoxes(!props.showBoxes)}
            className={`min-h-[28px] px-2 py-1.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors duration-150 ${
              props.showBoxes
                ? 'bg-[#1C1F26] border-[#EF4444]/60 text-[#F3F4F6]'
                : 'bg-[#14161B] border-[#232730] text-[#9CA3AF] hover:border-[#323846]'
            }`}
          >
            <Scan size={12} className={props.showBoxes ? 'text-[#EF4444]' : 'text-[#6B7280]'} />
            <span className="truncate">OCR Candidates</span>
          </button>

          <button
            type="button"
            aria-pressed={props.showMask}
            disabled={!props.hasMask}
            onClick={() => props.onShowMask(!props.showMask)}
            className={`min-h-[28px] px-2 py-1.5 rounded-md border text-[11px] flex items-center gap-1.5 transition-colors duration-150 ${
              !props.hasMask
                ? 'opacity-40 cursor-not-allowed bg-[#14161B] border-[#232730] text-[#6B7280]'
                : props.showMask
                  ? 'bg-[#1C1F26] border-[#EF4444]/60 text-[#F3F4F6]'
                  : 'bg-[#14161B] border-[#232730] text-[#9CA3AF] hover:border-[#323846]'
            }`}
          >
            <span className="w-2.5 h-2.5 rounded-full flex-none bg-[#EF4444]/50 border border-[#EF4444]" />
            <span className="truncate">Mask Tint</span>
          </button>
        </div>
      </div>

      {/* Section 3: Export & Active Pipeline Target */}
      <div className="flex flex-col gap-1.5 pt-1 border-t border-[#232730]">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF] px-0.5">
          Artwork in Editing &amp; Export
        </span>
        <div className="grid grid-cols-3 gap-1 p-1 rounded-md bg-[#0D0E11] border border-[#232730]">
          {[
            { id: 'cleaned-typeset' as const, label: 'Cleaned + Type' },
            { id: 'cleaned-only' as const, label: 'Cleaned Only' },
            { id: 'raw-typeset' as const, label: 'Raw + Type' },
          ].map(opt => {
            const active = activeTarget === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                disabled={props.disabled}
                aria-pressed={active}
                onClick={() => setPipelineTarget(opt.id)}
                className={`min-h-[28px] px-1.5 py-1 rounded text-[10px] font-medium transition-colors duration-150 ${
                  active
                    ? 'bg-[#EF4444] text-white shadow-sm'
                    : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#14161B]'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
