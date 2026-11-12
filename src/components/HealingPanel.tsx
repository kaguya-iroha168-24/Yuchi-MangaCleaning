import { useState } from 'react';
import { Brush, Eraser, Eye, Paintbrush, Pipette, RotateCcw, SquareDashedMousePointer, Undo2 } from 'lucide-react';
import type { ViewportController } from '../ui/viewport';

export type HealingToolMode = 'ai-brush' | 'rect-repair' | 'mask-erase' | 'pure-paint' | 'restore-raw';

export interface HealingPatchEntry {
  id: string;
  label: string;
  roi?: number[];
  changedPixels: number;
  time: string;
}

interface HealingPanelProps {
  mode: HealingToolMode;
  onSelectMode: (mode: HealingToolMode) => void;
  brushRadius: number;
  onBrushRadiusChange: (value: number) => void;
  dilation: number;
  onDilationChange: (value: number) => void;
  contextPadding: number;
  onContextPaddingChange: (value: number) => void;
  method: string;
  onMethodChange: (value: string) => void;
  autoHealOnRelease: boolean;
  onAutoHealChange: (value: boolean) => void;
  pureColor: [number, number, number];
  onPureColorChange: (color: [number, number, number]) => void;
  eyedropperActive: boolean;
  onToggleEyedropper: () => void;
  hasPreview: boolean;
  maskPixels: number;
  manualRect: [number, number, number, number] | null;
  canStartHealing: boolean;
  canClean: boolean;
  canUndo: boolean;
  busy: boolean;
  artworkLocked: boolean;
  onStartEmptyMask: () => void;
  onApplyRepair: () => void;
  onDiscardMask: () => void;
  onUndo: () => void;
  patches: HealingPatchEntry[];
  viewport: ViewportController;
}

function StudioSlider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const pct = Math.max(0, Math.min(100, ((props.value - props.min) / Math.max(1, props.max - props.min)) * 100));
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-[#D1D5DB] font-medium">{props.label}</span>
        <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#0D0E11] border border-[#232730] text-[#F3F4F6]">
          {props.value}
          {props.unit ?? 'px'}
        </span>
      </div>
      <div className="relative h-5 flex items-center">
        <div className="w-full h-1.5 rounded-full bg-[#232730] overflow-hidden">
          <div className="h-full bg-[#EF4444] rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <input
          type="range"
          min={props.min}
          max={props.max}
          value={props.value}
          disabled={props.disabled}
          aria-label={props.label}
          onChange={e => props.onChange(Number(e.target.value))}
          className="studio-range-overlay"
        />
      </div>
    </div>
  );
}

export function HealingPanel(props: HealingPanelProps) {
  const [comparing, setComparing] = useState(false);

  const hexColor = `#${props.pureColor.map(c => c.toString(16).padStart(2, '0')).join('')}`;
  const isPureOrRestore = props.mode === 'pure-paint' || props.mode === 'restore-raw';

  const startCompare = () => {
    setComparing(true);
    props.viewport.update({ peek: true });
  };

  const stopCompare = () => {
    if (!comparing) return;
    setComparing(false);
    props.viewport.update({ peek: false });
  };

  return (
    <div className="flex flex-col gap-3 text-xs text-[#E5E7EB]">
      {props.artworkLocked && (
        <div className="px-2.5 py-2 rounded-md bg-[#EF4444]/10 border border-[#EF4444]/40 text-[11px] text-[#FCA5A5]">
          Working artwork is locked. Unlock it in LAYERS to heal or paint.
        </div>
      )}

      {/* 1. 4-Way Segmented Tool Mode Selector */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
            Repair Mode
          </span>
          <span className="text-[10px] font-mono text-[#6B7280]">[ / ] Size · Alt+Wheel</span>
        </div>

        <div className="grid grid-cols-4 gap-1 p-1 rounded-md bg-[#0D0E11] border border-[#232730]">
          <button
            type="button"
            aria-pressed={props.mode === 'ai-brush'}
            disabled={props.busy || props.artworkLocked}
            onClick={() => props.onSelectMode('ai-brush')}
            title="AI Brush (B)"
            className={`min-h-[30px] px-1 py-1 rounded text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 ${
              props.mode === 'ai-brush'
                ? 'bg-[#EF4444] text-white'
                : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#14161B]'
            }`}
          >
            <Brush size={13} />
            <span>AI (B)</span>
          </button>

          <button
            type="button"
            aria-pressed={props.mode === 'rect-repair'}
            disabled={props.busy || props.artworkLocked}
            onClick={() => props.onSelectMode('rect-repair')}
            title="Rect Repair (R)"
            className={`min-h-[30px] px-1 py-1 rounded text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 ${
              props.mode === 'rect-repair'
                ? 'bg-[#EF4444] text-white'
                : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#14161B]'
            }`}
          >
            <SquareDashedMousePointer size={13} />
            <span>Rect (R)</span>
          </button>

          <button
            type="button"
            aria-pressed={props.mode === 'mask-erase'}
            disabled={props.busy || props.artworkLocked || !props.hasPreview}
            onClick={() => props.onSelectMode('mask-erase')}
            title="Eraser Mask (E)"
            className={`min-h-[30px] px-1 py-1 rounded text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 ${
              props.mode === 'mask-erase'
                ? 'bg-[#EF4444] text-white'
                : !props.hasPreview
                  ? 'opacity-40 cursor-not-allowed text-[#6B7280]'
                  : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#14161B]'
            }`}
          >
            <Eraser size={13} />
            <span>Erase (E)</span>
          </button>

          <button
            type="button"
            aria-pressed={isPureOrRestore}
            disabled={props.busy || props.artworkLocked}
            onClick={() => props.onSelectMode(isPureOrRestore ? props.mode : 'pure-paint')}
            title="Pure Brush / Restore Raw (C)"
            className={`min-h-[30px] px-1 py-1 rounded text-[10px] font-medium flex flex-col items-center justify-center gap-0.5 transition-colors duration-150 ${
              isPureOrRestore
                ? 'bg-[#EF4444] text-white'
                : 'text-[#9CA3AF] hover:text-[#F3F4F6] hover:bg-[#14161B]'
            }`}
          >
            <Paintbrush size={13} />
            <span>Pure (C)</span>
          </button>
        </div>

        {/* Pure / Restore Sub-Bar */}
        {isPureOrRestore && (
          <div className="bg-[#14161B] border border-[#232730] rounded-md p-2 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectMode('pure-paint');
                    props.onPureColorChange([255, 255, 255]);
                  }}
                  className={`min-h-[28px] px-2 rounded border text-[10px] font-medium flex items-center gap-1.5 ${
                    props.mode === 'pure-paint' && hexColor === '#ffffff'
                      ? 'border-[#EF4444] bg-[#1C1F26] text-white'
                      : 'border-[#232730] bg-[#0D0E11] text-[#9CA3AF]'
                  }`}
                >
                  <span className="w-3 h-3 rounded-sm bg-white border border-[#4B5563]" />
                  White
                </button>
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectMode('pure-paint');
                    props.onPureColorChange([0, 0, 0]);
                  }}
                  className={`min-h-[28px] px-2 rounded border text-[10px] font-medium flex items-center gap-1.5 ${
                    props.mode === 'pure-paint' && hexColor === '#000000'
                      ? 'border-[#EF4444] bg-[#1C1F26] text-white'
                      : 'border-[#232730] bg-[#0D0E11] text-[#9CA3AF]'
                  }`}
                >
                  <span className="w-3 h-3 rounded-sm bg-black border border-[#4B5563]" />
                  Black
                </button>
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectMode('pure-paint');
                    props.onToggleEyedropper();
                  }}
                  title="Click or Alt+Click on canvas to sample color"
                  className={`min-h-[28px] w-7 rounded border flex items-center justify-center ${
                    props.eyedropperActive
                      ? 'border-[#EF4444] bg-[#EF4444]/20 text-[#FCA5A5]'
                      : 'border-[#232730] bg-[#0D0E11] text-[#9CA3AF] hover:text-white'
                  }`}
                >
                  <Pipette size={13} />
                </button>
              </div>

              <button
                type="button"
                aria-pressed={props.mode === 'restore-raw'}
                onClick={() => props.onSelectMode('restore-raw')}
                title="Paint original raw manga pixels back onto working canvas"
                className={`min-h-[28px] px-2 rounded border text-[10px] font-medium flex items-center gap-1 ${
                  props.mode === 'restore-raw'
                    ? 'border-emerald-500/80 bg-emerald-500/15 text-emerald-300'
                    : 'border-[#232730] bg-[#0D0E11] text-[#9CA3AF] hover:text-white'
                }`}
              >
                <RotateCcw size={12} />
                <span>Restore Raw</span>
              </button>
            </div>
            <span className="text-[10px] text-[#9CA3AF]">
              {props.mode === 'restore-raw'
                ? 'Brush copies raw original line-art back onto working canvas (0ms).'
                : `Instant 0ms pixel brush (${hexColor.toUpperCase()}). Hold Alt+Click to sample.`}
            </span>
          </div>
        )}
      </div>

      {/* 2. Custom Studio Sliders */}
      <div className="bg-[#14161B] border border-[#232730] rounded-md p-2.5 flex flex-col gap-2.5">
        <StudioSlider
          label="Brush Size"
          value={props.brushRadius}
          min={1}
          max={120}
          disabled={props.busy}
          onChange={props.onBrushRadiusChange}
        />
        <div className="grid grid-cols-4 gap-1 -mt-1">
          {[5, 15, 30, 60].map(preset => (
            <button
              key={preset}
              type="button"
              disabled={props.busy}
              onClick={() => props.onBrushRadiusChange(preset)}
              className={`min-h-[24px] rounded border text-[10px] font-mono transition-colors ${
                props.brushRadius === preset
                  ? 'bg-[#EF4444]/20 border-[#EF4444] text-[#FCA5A5]'
                  : 'bg-[#0D0E11] border-[#232730] text-[#9CA3AF] hover:text-[#F3F4F6]'
              }`}
            >
              {preset}px
            </button>
          ))}
        </div>

        <StudioSlider
          label="Mask Dilation / Feather"
          value={props.dilation}
          min={0}
          max={24}
          disabled={props.busy}
          onChange={props.onDilationChange}
        />

        <StudioSlider
          label="ROI Context Padding"
          value={props.contextPadding}
          min={32}
          max={128}
          disabled={props.busy}
          onChange={props.onContextPaddingChange}
        />
      </div>

      {/* 3. Engine & Execution Mode */}
      <div className="bg-[#14161B] border border-[#232730] rounded-md p-2.5 flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
            Inpainting Engine
          </span>
          <select
            aria-label="Inpainting engine"
            value={props.method}
            disabled={props.busy}
            onChange={e => props.onMethodChange(e.target.value)}
            className="w-full min-h-[30px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6] focus:border-[#EF4444] focus:outline-none"
          >
            <option value="Auto / Recommended">LaMa / Auto Smart (High Quality)</option>
            <option value="Telea Inpainting">OpenCV Telea (Instant Fast Fill)</option>
            <option value="White Bubble Clean">Flat White Bubble Clean (#FFF)</option>
          </select>
        </div>

        <label className="flex items-center justify-between gap-2 min-h-[28px] cursor-pointer">
          <span className="text-[11px] text-[#D1D5DB]">Auto-Heal on Stroke Release</span>
          <input
            type="checkbox"
            checked={props.autoHealOnRelease}
            disabled={props.busy}
            onChange={e => props.onAutoHealChange(e.target.checked)}
            className="accent-[#EF4444] w-3.5 h-3.5"
          />
        </label>

        {/* Action Buttons */}
        <div className="flex flex-col gap-1.5 pt-1 border-t border-[#232730]">
          {!props.hasPreview ? (
            <div className="flex gap-1.5">
              {props.canStartHealing && (
                <button
                  type="button"
                  disabled={props.busy || props.artworkLocked}
                  onClick={props.onStartEmptyMask}
                  className="flex-1 min-h-[30px] px-2.5 rounded bg-[#EF4444] hover:bg-[#DC2626] text-white font-medium text-[11px] transition-colors"
                >
                  Start Mask Session
                </button>
              )}
              {props.manualRect && (
                <span className="px-2 flex items-center rounded bg-[#0D0E11] border border-[#232730] text-[10px] font-mono text-[#9CA3AF]">
                  {props.manualRect[2]}×{props.manualRect[3]}
                </span>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[10px] font-mono text-[#9CA3AF]">
                <span>Staged Mask Pixels</span>
                <span className="text-[#F3F4F6]">{props.maskPixels.toLocaleString()} px</span>
              </div>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  disabled={!props.canClean || props.busy}
                  onClick={props.onApplyRepair}
                  className="flex-1 min-h-[30px] px-2.5 rounded bg-[#EF4444] hover:bg-[#DC2626] disabled:opacity-40 text-white font-medium text-[11px] transition-colors"
                >
                  Apply Repair (Enter)
                </button>
                <button
                  type="button"
                  disabled={props.busy}
                  onClick={props.onDiscardMask}
                  className="min-h-[30px] px-2.5 rounded bg-[#0D0E11] border border-[#232730] hover:border-[#4B5563] text-[#D1D5DB] text-[11px] transition-colors"
                >
                  Reset (Esc)
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 4. Region Repair History Mini Stack */}
      <div className="bg-[#14161B] border border-[#232730] rounded-md p-2.5 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
            Repair History
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              disabled={!props.canUndo || props.busy}
              onClick={props.onUndo}
              title="Undo Stroke (Ctrl+Z)"
              className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] hover:border-[#4B5563] disabled:opacity-40 text-[10px] text-[#D1D5DB] flex items-center gap-1"
            >
              <Undo2 size={12} />
              <span>Undo</span>
            </button>
            <button
              type="button"
              onPointerDown={startCompare}
              onPointerUp={stopCompare}
              onPointerLeave={stopCompare}
              onPointerCancel={stopCompare}
              className={`min-h-[28px] px-2 rounded border text-[10px] flex items-center gap-1 ${
                comparing
                  ? 'bg-[#EF4444]/20 border-[#EF4444] text-[#FCA5A5]'
                  : 'bg-[#0D0E11] border-[#232730] text-[#9CA3AF] hover:text-[#F3F4F6]'
              }`}
              title="Hold to compare raw vs cleaned"
            >
              <Eye size={12} />
              <span>Compare</span>
            </button>
          </div>
        </div>

        {props.patches.length === 0 ? (
          <p className="text-[10px] text-[#6B7280] m-0">
            Paint with AI Brush or Rect Repair to log smart ROI patches for this page.
          </p>
        ) : (
          <div className="flex flex-col gap-1 max-h-[110px] overflow-y-auto pr-0.5">
            {props.patches.map(patch => (
              <div
                key={patch.id}
                className="flex items-center justify-between px-2 py-1 rounded bg-[#0D0E11] border border-[#232730] text-[10px]"
              >
                <span className="text-[#E5E7EB] truncate">{patch.label}</span>
                <span className="font-mono text-[#9CA3AF] flex-none ml-2">
                  {patch.roi ? `${patch.roi[2]}×${patch.roi[3]}` : `${patch.changedPixels}px`} · {patch.time}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
