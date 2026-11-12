import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  Check,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  HardDrive,
  Keyboard,
  Languages,
  Loader2,
  Plus,
  RotateCcw,
  ScanText,
  Sparkles,
  Trash2,
  Type,
  X,
} from 'lucide-react';
import type { Api, DetectionMode } from '../api';
import { AtelierSelect, getModelOptionBadge, type AtelierSelectOption } from './AtelierSelect';
import {
  DEFAULT_ATELIER_SETTINGS,
  DEFAULT_PRESETS,
  loadAtelierSettings,
  saveAtelierSettings,
  type AtelierSettings,
} from '../utils/settingsStorage';

type SettingsSectionId = 'ai' | 'ocr' | 'inpaint' | 'type' | 'keys' | 'about';

const NAV_ITEMS: Array<{
  id: SettingsSectionId;
  label: string;
  subtitle: string;
  icon: typeof Languages;
}> = [
  { id: 'ai', label: 'AI & Translation', subtitle: 'Zero-click API vault, Flash-Lite routing & persona prompt', icon: Languages },
  { id: 'ocr', label: 'Bubble & OCR Engine', subtitle: 'Bubble detection model, OCR engine & confidence bounds', icon: ScanText },
  { id: 'inpaint', label: 'Inpainting & Healing', subtitle: 'Cleaner model, mask dilation, VRAM policy & output format', icon: Sparkles },
  { id: 'type', label: 'Typography & Fonts', subtitle: 'Default comic font family, size, leading & wrapping', icon: Type },
  { id: 'keys', label: 'Keybindings', subtitle: 'Canvas tools, brush shortcuts & workflow navigation', icon: Keyboard },
  { id: 'about', label: 'Storage & About', subtitle: 'Interface density, local store path & factory reset', icon: HardDrive },
];

export type Density = 'Balanced' | 'Compact' | 'Comfortable';
export type TranslationSettings = {
  configured: boolean;
  model: string;
  endpointModel?: string;
  style: string;
  providerName?: string;
  langPair?: string;
  translationMode?: string;
  rememberKey?: boolean;
  autoPickCheapest?: boolean;
  modelStrategy?: 'cheapest' | 'balanced' | 'manual';
  keyPreview?: string;
  configPath?: string;
  latencyMs?: number;
  availableModels?: string[];
  modelAdjusted?: boolean;
};

const MODEL_CHOICES: Record<AtelierSettings['translate']['providerName'], string[]> = {
  gemini: [
    'gemini-3.5-flash-lite',
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-2.0-flash-lite',
    'gemini-2.0-flash',
  ],
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
  deepseek: ['deepseek-chat', 'deepseek-reasoner'],
  ollama: ['qwen2.5:14b', 'gemma3:12b', 'llama3.1:8b'],
};

const PROVIDER_OPTIONS: AtelierSelectOption[] = [
  { value: 'gemini', label: 'Google Gemini', sublabel: 'v1beta live discovery' },
  { value: 'openai', label: 'OpenAI / Compat', sublabel: 'sk- auto-detect' },
  { value: 'deepseek', label: 'DeepSeek', sublabel: 'Reasoning & chat' },
  { value: 'ollama', label: 'Ollama (Local)', sublabel: 'Self-hosted models' },
];

const LANG_PAIR_OPTIONS: AtelierSelectOption[] = [
  { value: 'JA → ID', label: 'JA → ID', sublabel: 'Japanese → Indonesian' },
  { value: 'JA → EN', label: 'JA → EN', sublabel: 'Japanese → English' },
  { value: 'EN → ID', label: 'EN → ID', sublabel: 'English → Indonesian' },
  { value: 'KO → ID', label: 'KO → ID', sublabel: 'Korean → Indonesian' },
  { value: 'ZH → ID', label: 'ZH → ID', sublabel: 'Chinese → Indonesian' },
];

const MODE_OPTIONS: AtelierSelectOption[] = [
  { value: 'per_page', label: 'Per Page Batch', sublabel: 'Context-aware page batch' },
  { value: 'per_bubble', label: 'Per Bubble Fast', sublabel: 'Isolated fast pass' },
  { value: 'glossary_locked', label: 'Glossary Locked', sublabel: 'Series terminology lock' },
];

function cleanGeminiModelId(value: string): string {
  return value.trim().replace(/^models\//i, '').trim();
}

function detectKeySignature(raw: string): 'gemini' | 'openai' | null {
  const trimmed = raw.trim();
  if (/^AIza[0-9A-Za-z_-]{20,}$/.test(trimmed)) return 'gemini';
  if (/^sk-[A-Za-z0-9_-]{16,}$/.test(trimmed)) return 'openai';
  return null;
}

function pickFlashLiteModel(models: string[]): string {
  const match = models.find(m => m.toLowerCase().includes('flash-lite'));
  return match || 'gemini-3.5-flash-lite';
}

function pickBalancedGeminiModel(models: string[]): string {
  const match = models.find(m => m.toLowerCase().includes('flash') && !m.toLowerCase().includes('flash-lite'));
  return match || 'gemini-2.5-flash';
}

function formatTestErrorBadge(message: string): string {
  if (/404|unavailable/i.test(message)) return 'Model unavailable (404)';
  if (/400|invalid.*key|paste the full api key/i.test(message)) return 'Invalid API key (400)';
  if (/401|unauthorized|rejected the api key/i.test(message)) return 'Unauthorized key (401)';
  if (/403|denied/i.test(message)) return 'Access denied (403)';
  if (/429|quota|rate limit/i.test(message)) return 'Quota / rate limit (429)';
  if (/503|temporarily unavailable/i.test(message)) return 'Service unavailable (503)';
  if (/timeout|reach/i.test(message)) return 'Connection timed out';
  if (/offline/i.test(message)) return 'Engine offline';
  return message.length <= 36 ? message : `${message.slice(0, 33)}…`;
}

export function ModalFrame({
  title,
  onClose,
  children,
  className = '',
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  const modal = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    const initialTarget =
      modal.current?.querySelector<HTMLElement>('[data-autofocus]:not(:disabled)') ??
      modal.current?.querySelector<HTMLElement>('input:not([type="checkbox"]):not(:disabled), select:not(:disabled), button:not(:disabled)');
    initialTarget?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (window.document.querySelector('[data-atelier-select-open="true"]')) return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key === 'Tab') {
        const items = [
          ...(modal.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
          ) ?? []),
        ];
        const first = items[0];
        const last = items.at(-1);
        if (event.shiftKey && window.document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && window.document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      previous?.focus();
    };
  }, []);
  return createPortal(
    <div
      className="studio-modal-backdrop"
      onPointerDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`studio-modal ${className}`} ref={modal} role="dialog" aria-modal="true" aria-label={title}>
        {!className.includes('atelier-settings-modal') && (
          <div className="studio-modal-heading">
            <h2>{title}</h2>
            <button aria-label={`Close ${title}`} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>,
    window.document.body,
  );
}

function SettingsSlider(props: {
  label: string;
  displayValue: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const pct = Math.max(0, Math.min(100, ((props.value - props.min) / Math.max(1e-6, props.max - props.min)) * 100));
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-[11px] font-medium text-[#9BA1AE] leading-none">
        <span>{props.label}</span>
        <span className="font-mono text-[#F3F4F6]">{props.displayValue}</span>
      </div>
      <div className="relative h-5 flex items-center select-none">
        <div className="w-full h-1.5 rounded-full bg-[#232730] overflow-hidden">
          <div className="h-full bg-[#E11D48] rounded-full" style={{ width: `${pct}%` }} />
        </div>
        <div
          className="w-3.5 h-3.5 rounded-full bg-[#F3F4F6] border-2 border-[#E11D48] shadow-sm pointer-events-none absolute -translate-x-1/2"
          style={{ left: `${pct}%` }}
        />
        <input
          type="range"
          min={props.min}
          max={props.max}
          step={props.step ?? 1}
          value={props.value}
          onChange={e => props.onChange(Number(e.target.value))}
          className="studio-range-overlay"
        />
      </div>
    </div>
  );
}

export function PreferencesDialog(props: {
  api: Api | null;
  onClose: () => void;
  needsGeminiKey?: boolean;
  density: Density;
  onDensity: (value: Density) => void;
  exportFormat: 'png' | 'jpeg';
  onExportFormat: (value: 'png' | 'jpeg') => void;
  provider: string;
  onProvider: (value: string) => void;
  detectionMode: DetectionMode;
  onDetectionMode: (mode: DetectionMode) => void;
  textMode: 'clean' | 'overlay';
  onTextMode?: (mode: 'clean' | 'overlay') => void;
  busy: boolean;
  onReset: () => void;
  includeFreeText?: boolean;
  onIncludeFreeText?: (value: boolean) => void;
  onAtelierSettingsApplied?: (settings: AtelierSettings) => void;
}) {
  const [section, setSection] = useState<SettingsSectionId>('ai');
  const [draft, setDraft] = useState<AtelierSettings>(() => loadAtelierSettings());
  const [configInfo, setConfigInfo] = useState<TranslationSettings | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [customModelMode, setCustomModelMode] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [testPending, setTestPending] = useState(false);
  const [testStatus, setTestStatus] = useState<{ ok: boolean; text: string; fullText?: string } | null>(null);
  const [savedNotice, setSavedNotice] = useState('Auto-saved to local store');
  const [newPresetName, setNewPresetName] = useState('');
  const [addingPreset, setAddingPreset] = useState(false);

  const draftRef = useRef(draft);
  draftRef.current = draft;
  const verifySeqRef = useRef(0);
  const apiRef = useRef(props.api);
  apiRef.current = props.api;
  const onAppliedRef = useRef(props.onAtelierSettingsApplied);
  onAppliedRef.current = props.onAtelierSettingsApplied;

  const activePreset =
    draft.translate.presets.find(p => p.id === draft.translate.activePresetId) ?? draft.translate.presets[0];
  const activeNav = NAV_ITEMS.find(item => item.id === section) ?? NAV_ITEMS[0];

  useEffect(() => {
    if (!props.api) return;
    let alive = true;
    void props.api
      .get<TranslationSettings>('/v1/translation/capabilities')
      .then(result => {
        if (!alive) return;
        setConfigInfo(result);
        if (result.availableModels?.length) {
          setDiscoveredModels(result.availableModels);
        }
        setDraft(prev => ({
          ...prev,
          translate: {
            ...prev.translate,
            model: cleanGeminiModelId(result.model || prev.translate.model) || prev.translate.model,
            providerName: (result.providerName as AtelierSettings['translate']['providerName']) || prev.translate.providerName,
            langPair: result.langPair || prev.translate.langPair,
            translationMode:
              (result.translationMode as AtelierSettings['translate']['translationMode']) || prev.translate.translationMode,
            rememberKey: result.rememberKey ?? prev.translate.rememberKey,
            autoPickCheapest: result.autoPickCheapest ?? prev.translate.autoPickCheapest,
            modelStrategy: result.modelStrategy ?? prev.translate.modelStrategy,
          },
        }));
      })
      .catch(() => {
        if (alive) {
          setTestStatus({ ok: false, text: 'Engine offline', fullText: 'Engine offline — local preferences still editable.' });
        }
      });
    return () => {
      alive = false;
    };
  }, [props.api]);

  // Zero-click API key auto-detection & 300ms debounced live verification
  useEffect(() => {
    const trimmed = apiKeyInput.trim();
    const detected = detectKeySignature(trimmed);
    const api = apiRef.current;
    if (!trimmed || !detected || !api) return;

    const timer = window.setTimeout(() => {
      const seq = ++verifySeqRef.current;
      const current = draftRef.current;
      const preset = current.translate.presets.find(p => p.id === current.translate.activePresetId) ?? current.translate.presets[0];
      const preferCheapest =
        detected === 'gemini' && (current.translate.autoPickCheapest || current.translate.modelStrategy === 'cheapest');
      const requestedModel =
        detected === 'gemini'
          ? preferCheapest
            ? 'gemini-3.5-flash-lite'
            : MODEL_CHOICES.gemini.includes(cleanGeminiModelId(current.translate.model))
              ? cleanGeminiModelId(current.translate.model)
              : 'gemini-3.5-flash-lite'
          : MODEL_CHOICES.openai[0];

      setTestPending(true);
      setTestStatus(null);
      setSavedNotice(detected === 'gemini' ? 'Verifying Gemini key…' : 'Detecting OpenAI key…');

      void api
        .post<TranslationSettings>('/v1/translation/settings', {
          providerName: detected,
          model: requestedModel,
          key: trimmed,
          style: preset?.prompt ?? '',
          langPair: current.translate.langPair,
          translationMode: current.translate.translationMode,
          rememberKey: current.translate.rememberKey,
          autoPickCheapest: current.translate.autoPickCheapest,
          modelStrategy: preferCheapest ? 'cheapest' : current.translate.modelStrategy,
          preferCheapest,
          skipVerify: detected !== 'gemini',
          discoverModels: detected === 'gemini',
        })
        .then(result => {
          if (seq !== verifySeqRef.current) return;
          setConfigInfo(result);
          if (result.availableModels?.length) {
            setDiscoveredModels(result.availableModels);
          }
          const resolvedModel = cleanGeminiModelId(result.model || requestedModel) || requestedModel;
          const nextDraft: AtelierSettings = {
            ...draftRef.current,
            translate: {
              ...draftRef.current.translate,
              providerName: detected,
              model: resolvedModel,
              modelStrategy: preferCheapest ? 'cheapest' : draftRef.current.translate.modelStrategy,
            },
          };
          setDraft(nextDraft);
          saveAtelierSettings(nextDraft);
          onAppliedRef.current?.(nextDraft);
          setSavedNotice('Key verified & auto-saved');

          if (detected === 'openai') {
            setTestStatus({
              ok: true,
              text: `✓ OpenAI Key Detected · ${resolvedModel}`,
              fullText: `Detected OpenAI key signature · Ready with ${resolvedModel}`,
            });
          } else if (preferCheapest || resolvedModel.toLowerCase().includes('flash-lite')) {
            const aliasNote =
              result.endpointModel && result.endpointModel !== resolvedModel
                ? ` -> ${result.endpointModel}`
                : '';
            setTestStatus({
              ok: true,
              text: '✓ Key Verified · Auto-selected Flash-Lite (Lowest Cost)',
              fullText: `Verified (${resolvedModel}${aliasNote} · ${result.latencyMs ?? 0}ms)`,
            });
          } else {
            setTestStatus({
              ok: true,
              text: `✓ Key Verified · ${resolvedModel} (${result.latencyMs ?? 0}ms)`,
              fullText: `Verified (${resolvedModel} · ${result.latencyMs ?? 0}ms)`,
            });
          }
        })
        .catch(reason => {
          if (seq !== verifySeqRef.current) return;
          const raw = reason instanceof Error ? reason.message : 'Auto-verification failed';
          setTestStatus({
            ok: false,
            text: formatTestErrorBadge(raw),
            fullText: raw,
          });
          setSavedNotice('Verification failed');
        })
        .finally(() => {
          if (seq === verifySeqRef.current) setTestPending(false);
        });
    }, 300);

    return () => window.clearTimeout(timer);
  }, [apiKeyInput, props.api]);

  const updatePrompt = (prompt: string) => {
    setDraft(prev => ({
      ...prev,
      translate: {
        ...prev.translate,
        presets: prev.translate.presets.map(p => (p.id === activePreset.id ? { ...p, prompt } : p)),
      },
    }));
  };

  const insertToken = (token: string) => {
    const current = activePreset?.prompt ?? '';
    const sep = current && !current.endsWith(' ') && !current.endsWith('\n') ? ' ' : '';
    updatePrompt(`${current}${sep}${token}`);
  };

  const handleCreatePreset = () => {
    const name = newPresetName.trim();
    if (!name) return;
    const id = `custom-${Date.now()}`;
    setDraft(prev => ({
      ...prev,
      translate: {
        ...prev.translate,
        activePresetId: id,
        presets: [...prev.translate.presets, { id, name, prompt: activePreset?.prompt ?? '', builtin: false }],
      },
    }));
    setNewPresetName('');
    setAddingPreset(false);
  };

  const handleDeletePreset = () => {
    if (!activePreset || activePreset.builtin) return;
    setDraft(prev => {
      const remaining = prev.translate.presets.filter(p => p.id !== activePreset.id);
      return {
        ...prev,
        translate: {
          ...prev.translate,
          presets: remaining.length ? remaining : DEFAULT_PRESETS,
          activePresetId: (remaining[0] ?? DEFAULT_PRESETS[0]).id,
        },
      };
    });
  };

  const curatedModels = MODEL_CHOICES[draft.translate.providerName] ?? MODEL_CHOICES.gemini;
  const liveModels =
    draft.translate.providerName === 'gemini' && discoveredModels.length > 0
      ? discoveredModels
      : curatedModels;
  const cleanSelectedModel = cleanGeminiModelId(draft.translate.model);
  const selectModelIds =
    cleanSelectedModel && !liveModels.includes(cleanSelectedModel)
      ? [cleanSelectedModel, ...liveModels]
      : liveModels;

  const modelOptions: AtelierSelectOption[] = selectModelIds.map(id => {
    const meta = getModelOptionBadge(id);
    let sublabel: string | undefined;
    if (
      cleanSelectedModel === id &&
      configInfo?.endpointModel &&
      configInfo.endpointModel !== id
    ) {
      sublabel = `-> ${configInfo.endpointModel}`;
    } else if (id === 'gemini-3.5-flash-lite') {
      sublabel = 'Smart lowest-cost alias';
    }
    return {
      value: id,
      label: id,
      badge: meta?.badge,
      badgeTone: meta?.badgeTone,
      sublabel,
    };
  });

  const presetOptions: AtelierSelectOption[] = draft.translate.presets.map(p => ({
    value: p.id,
    label: p.name,
    sublabel: p.builtin ? 'Built-in' : 'Custom',
  }));

  const applyStrategy = (strategy: AtelierSettings['translate']['modelStrategy']) => {
    setCustomModelMode(false);
    setDraft(prev => {
      let nextModel = prev.translate.model;
      if (prev.translate.providerName === 'gemini') {
        const pool = discoveredModels.length > 0 ? discoveredModels : MODEL_CHOICES.gemini;
        if (strategy === 'cheapest') nextModel = pickFlashLiteModel(pool);
        else if (strategy === 'balanced') nextModel = pickBalancedGeminiModel(pool);
      } else if (strategy === 'cheapest') {
        nextModel = MODEL_CHOICES[prev.translate.providerName]?.[0] ?? prev.translate.model;
      }
      return {
        ...prev,
        translate: {
          ...prev.translate,
          modelStrategy: strategy,
          autoPickCheapest: strategy === 'cheapest',
          model: nextModel,
        },
      };
    });
  };

  const syncTranslationSettings = async (verifyNow: boolean, sourceDraft: AtelierSettings = draft) => {
    const cleanModel = cleanGeminiModelId(sourceDraft.translate.model) || liveModels[0];
    const preset =
      sourceDraft.translate.presets.find(p => p.id === sourceDraft.translate.activePresetId) ??
      sourceDraft.translate.presets[0];
    const preferCheapest =
      sourceDraft.translate.providerName === 'gemini' &&
      (sourceDraft.translate.autoPickCheapest || sourceDraft.translate.modelStrategy === 'cheapest');
    const baseDraft: AtelierSettings = {
      ...sourceDraft,
      translate: { ...sourceDraft.translate, model: cleanModel },
    };
    if (!props.api) {
      return { result: null as TranslationSettings | null, resolvedModel: cleanModel, nextDraft: baseDraft };
    }
    const shouldVerifyGemini = verifyNow && baseDraft.translate.providerName === 'gemini';
    const result = await props.api.post<TranslationSettings>('/v1/translation/settings', {
      providerName: baseDraft.translate.providerName,
      model: cleanModel,
      key: apiKeyInput.trim(),
      style: preset?.prompt ?? '',
      langPair: baseDraft.translate.langPair,
      translationMode: baseDraft.translate.translationMode,
      rememberKey: baseDraft.translate.rememberKey,
      autoPickCheapest: baseDraft.translate.autoPickCheapest,
      modelStrategy: baseDraft.translate.modelStrategy,
      preferCheapest,
      skipVerify: !shouldVerifyGemini,
      discoverModels: shouldVerifyGemini,
    });
    setConfigInfo(result);
    if (result.availableModels?.length) {
      setDiscoveredModels(result.availableModels);
    }
    const resolvedModel = cleanGeminiModelId(result.model || cleanModel) || cleanModel;
    const nextDraft: AtelierSettings = {
      ...baseDraft,
      translate: { ...baseDraft.translate, model: resolvedModel },
    };
    setDraft(nextDraft);
    if (result.modelAdjusted || (resolvedModel !== cleanModel && result.availableModels?.includes(resolvedModel))) {
      setCustomModelMode(false);
    }
    return { result, resolvedModel, nextDraft };
  };

  const handleTestConnection = async () => {
    if (!props.api) return;
    verifySeqRef.current += 1;
    setTestPending(true);
    setTestStatus(null);
    try {
      const { result, resolvedModel, nextDraft } = await syncTranslationSettings(true);
      const isGemini = nextDraft.translate.providerName === 'gemini';
      const isCheapest = nextDraft.translate.autoPickCheapest || nextDraft.translate.modelStrategy === 'cheapest';
      const msg = !isGemini
        ? `✓ Saved ${nextDraft.translate.providerName.toUpperCase()} (${resolvedModel})`
        : isCheapest && resolvedModel.toLowerCase().includes('flash-lite')
          ? '✓ Key Verified · Auto-selected Flash-Lite (Lowest Cost)'
          : `✓ Key Verified · ${resolvedModel} (${result?.latencyMs ?? 0}ms)`;
      setTestStatus({ ok: true, text: msg, fullText: `${resolvedModel} · ${result?.latencyMs ?? 0}ms` });
      saveAtelierSettings(nextDraft);
      props.onAtelierSettingsApplied?.(nextDraft);
      setSavedNotice('Verified & saved to store');
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : 'Connection test failed';
      setTestStatus({
        ok: false,
        text: formatTestErrorBadge(raw),
        fullText: raw,
      });
    } finally {
      setTestPending(false);
    }
  };

  const handleClearKey = async () => {
    if (!props.api) return;
    verifySeqRef.current += 1;
    setTestPending(true);
    try {
      const result = await props.api.post<TranslationSettings>('/v1/translation/settings', { clear: true });
      setConfigInfo(result);
      setDiscoveredModels([]);
      setApiKeyInput('');
      setTestStatus({ ok: false, text: 'Key removed', fullText: 'API key removed from disk & memory.' });
      setSavedNotice('API key removed');
    } catch (reason) {
      const raw = reason instanceof Error ? reason.message : 'Failed to clear key';
      setTestStatus({ ok: false, text: formatTestErrorBadge(raw), fullText: raw });
    } finally {
      setTestPending(false);
    }
  };

  const handleSaveAndApply = async () => {
    verifySeqRef.current += 1;
    const cleanModel = cleanGeminiModelId(draft.translate.model) || liveModels[0];
    const cleanDraft: AtelierSettings = {
      ...draft,
      translate: { ...draft.translate, model: cleanModel },
    };
    const needsLiveVerify = Boolean(props.api && apiKeyInput.trim() && cleanDraft.translate.providerName === 'gemini');
    if (needsLiveVerify) {
      setTestPending(true);
      setTestStatus(null);
      try {
        const { result, resolvedModel, nextDraft } = await syncTranslationSettings(true, cleanDraft);
        setApiKeyInput('');
        setTestStatus({
          ok: true,
          text: resolvedModel.toLowerCase().includes('flash-lite')
            ? '✓ Key Verified · Auto-selected Flash-Lite (Lowest Cost)'
            : `✓ Key Verified · ${resolvedModel}`,
          fullText: `Connected (${resolvedModel} · ${result?.latencyMs ?? 0}ms)`,
        });
        saveAtelierSettings(nextDraft);
        props.onAtelierSettingsApplied?.(nextDraft);
        setSavedNotice('Saved to disk');
        props.onClose();
      } catch (reason) {
        const raw = reason instanceof Error ? reason.message : 'Connection test failed';
        setTestStatus({ ok: false, text: formatTestErrorBadge(raw), fullText: raw });
      } finally {
        setTestPending(false);
      }
      return;
    }

    setDraft(cleanDraft);
    saveAtelierSettings(cleanDraft);
    props.onAtelierSettingsApplied?.(cleanDraft);
    if (props.api) {
      try {
        await syncTranslationSettings(false, cleanDraft);
      } catch {
        // Non-blocking when no new API key is verified; local settings are saved
      }
    }
    setSavedNotice('Saved to disk');
    props.onClose();
  };

  return (
    <ModalFrame title="Atelier Settings" onClose={props.onClose} className="atelier-settings-modal">
      <div className="w-[740px] max-w-[96vw] h-[460px] bg-[#0D0E12] border border-[#232730] rounded-xl shadow-2xl flex overflow-hidden text-[#E5E7EB]">
        {/* Left Vertical Navigation Rail */}
        <aside className="w-[190px] flex-none bg-[#111318] border-r border-[#1F232B] p-3 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-2 px-1.5 pb-2.5 border-b border-[#1D212B]">
              <span className="w-6 h-6 rounded-md bg-[#E11D48]/15 border border-[#E11D48]/40 flex items-center justify-center text-[#E11D48] flex-none">
                <Sparkles size={13} />
              </span>
              <div className="min-w-0">
                <div className="text-xs font-semibold text-[#F3F4F6] leading-tight truncate">
                  MangaClean Atelier
                </div>
                <div className="text-[10px] text-[#7D8494] leading-tight">
                  Preferences
                </div>
              </div>
            </div>

            <nav aria-label="Settings categories" className="mt-2.5 flex flex-col gap-1">
              {NAV_ITEMS.map(item => {
                const Icon = item.icon;
                const active = section === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => setSection(item.id)}
                    className={`min-h-0 h-8 w-full px-2.5 rounded-r-md border-t-0 border-r-0 border-b-0 border-l-2 border-solid flex items-center gap-2 text-xs font-medium text-left transition-colors cursor-pointer focus:outline-none focus-visible:ring-1 focus-visible:ring-[#E11D48]/60 ${
                      active
                        ? 'bg-[#181B23] text-white border-[#E11D48]'
                        : 'bg-transparent text-[#8A909E] hover:text-[#E5E7EB] hover:bg-[#151821] border-transparent'
                    }`}
                  >
                    <Icon size={14} className={active ? 'text-[#E11D48] flex-none' : 'text-[#6B7280] flex-none'} />
                    <span className="truncate">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          <div className="px-1.5 pt-2 border-t border-[#1D212B] flex items-center gap-1.5 text-[10px] text-[#8A909E]">
            <span className={`w-1.5 h-1.5 rounded-full flex-none ${testPending ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'}`} />
            <span className="truncate">{savedNotice}</span>
          </div>
        </aside>

        {/* Right Content Workspace */}
        <section className="flex-1 min-w-0 p-3.5 flex flex-col gap-2.5 overflow-hidden bg-[#0D0E12]">
          {/* Compact Workspace Header */}
          <header className="h-9 pb-2 border-b border-[#1D212B] flex items-center justify-between gap-2 flex-none">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-[#F3F4F6] m-0 leading-tight truncate">
                {activeNav.label}
              </h2>
              <p className="text-[10px] text-[#7D8494] m-0 leading-tight truncate">
                {activeNav.subtitle}
              </p>
            </div>

            <div className="flex items-center gap-1.5 flex-none">
              <button
                type="button"
                onClick={props.onClose}
                className="min-h-0 h-7 px-2.5 text-[11px] font-medium rounded-md bg-[#161920] hover:bg-[#1E222B] text-[#D0D5DD] border border-[#262B36] transition-colors"
              >
                Close
              </button>
              <button
                type="button"
                onClick={() => void handleSaveAndApply()}
                className="min-h-0 h-7 px-3 text-[11px] font-semibold rounded-md bg-[#E11D48] hover:bg-[#BE123C] text-white border-0 transition-colors"
              >
                Apply &amp; Close
              </button>
            </div>
          </header>

          {/* Pane Body — strictly zero scroll */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {section === 'ai' && (
              <div className="flex-1 min-h-0 flex flex-col gap-2.5">
                {/* Bento Card 1: AI Engine & Smart API Vault */}
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-2.5 flex flex-col gap-2 flex-none">
                  <div className="flex items-center justify-between gap-2 min-h-[18px]">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] font-semibold text-[#E5E7EB] tracking-tight whitespace-nowrap">
                        AI Engine &amp; Smart API Vault
                      </span>
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] leading-none text-[#E11D48] hover:text-[#FB7185] transition-colors whitespace-nowrap"
                      >
                        <span>Get Key</span>
                        <ExternalLink size={9} />
                      </a>
                    </div>

                    <div className="flex items-center gap-1.5 min-w-0">
                      {testPending ? (
                        <span
                          role="status"
                          className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-[#38BDF8]/15 border border-[#38BDF8]/30 text-[#38BDF8] text-[10px] font-medium leading-none whitespace-nowrap"
                        >
                          <Loader2 size={10} className="animate-spin flex-none" />
                          <span>Verifying &amp; discovering models…</span>
                        </span>
                      ) : testStatus ? (
                        <span
                          role="status"
                          title={testStatus.fullText ?? testStatus.text}
                          className={`inline-flex items-center gap-1 h-5 px-2 rounded-full text-[10px] font-medium leading-none whitespace-nowrap max-w-[290px] overflow-hidden ${
                            testStatus.ok
                              ? 'bg-[#10B981]/15 border border-[#10B981]/30 text-[#34D399]'
                              : 'bg-[#E11D48]/15 border border-[#E11D48]/35 text-[#FB7185]'
                          }`}
                        >
                          <span className="truncate">{testStatus.text}</span>
                        </span>
                      ) : configInfo?.configured ? (
                        <span
                          title={`Configured: ${configInfo.keyPreview ?? 'Saved'} · Endpoint: ${configInfo.endpointModel || configInfo.model}`}
                          className="inline-flex items-center gap-1 h-5 px-2 rounded-full bg-[#10B981]/12 border border-[#10B981]/25 text-[#34D399] text-[10px] font-medium leading-none whitespace-nowrap"
                        >
                          <Check size={10} className="flex-none" />
                          <span>Saved ({configInfo.keyPreview ?? 'Active'})</span>
                        </span>
                      ) : props.needsGeminiKey ? (
                        <span className="inline-flex items-center h-5 px-2 rounded-full bg-amber-500/15 border border-amber-500/30 text-amber-300 text-[10px] leading-none whitespace-nowrap">
                          Paste key to auto-verify
                        </span>
                      ) : null}

                      {configInfo?.configured && (
                        <button
                          type="button"
                          disabled={testPending}
                          onClick={() => void handleClearKey()}
                          title="Remove stored API key"
                          className="min-h-0 h-5 px-1.5 rounded text-[10px] leading-none text-[#8A909E] hover:text-[#FB7185] bg-transparent border-0 transition-colors flex-none"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Prominent API Key Input with Auto-Detect */}
                  <div className="flex items-center gap-1.5">
                    <div className="relative flex-1 min-w-0">
                      <input
                        type={showKey ? 'text' : 'password'}
                        data-autofocus="true"
                        autoComplete="off"
                        aria-label="API Key"
                        value={apiKeyInput}
                        maxLength={200}
                        disabled={!props.api || props.busy}
                        onChange={e => {
                          const val = e.target.value;
                          setApiKeyInput(val);
                          const head = val.trim();
                          if (head.startsWith('AIza')) {
                            setDraft(prev => ({
                              ...prev,
                              translate: {
                                ...prev.translate,
                                providerName: 'gemini',
                                model:
                                  prev.translate.autoPickCheapest || prev.translate.modelStrategy === 'cheapest'
                                    ? 'gemini-3.5-flash-lite'
                                    : prev.translate.providerName === 'gemini'
                                      ? prev.translate.model
                                      : MODEL_CHOICES.gemini[0],
                              },
                            }));
                          } else if (head.startsWith('sk-')) {
                            setDraft(prev => ({
                              ...prev,
                              translate: {
                                ...prev.translate,
                                providerName: 'openai',
                                model:
                                  prev.translate.providerName === 'openai'
                                    ? prev.translate.model
                                    : MODEL_CHOICES.openai[0],
                              },
                            }));
                          }
                        }}
                        placeholder={
                          configInfo?.configured
                            ? `Saved (${configInfo.keyPreview ?? '••••'}) — paste AIza… or sk-…`
                            : 'Paste Gemini (AIza...) or OpenAI (sk-...) key — auto-verifies'
                        }
                        className="w-full h-8 text-xs pl-2.5 pr-8 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] placeholder:text-[#636B7C] focus:border-[#E11D48] focus:outline-none"
                      />
                      <button
                        type="button"
                        aria-label={showKey ? 'Hide API key' : 'Reveal API key'}
                        onClick={() => setShowKey(v => !v)}
                        className="min-h-0 absolute right-1.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded bg-transparent border-0 p-0 flex items-center justify-center text-[#8A909E] hover:text-[#F3F4F6]"
                      >
                        {showKey ? <EyeOff size={13} /> : <Eye size={13} />}
                      </button>
                    </div>

                    <button
                      type="button"
                      disabled={!props.api || props.busy || testPending}
                      onClick={() => void handleTestConnection()}
                      className="min-h-0 h-8 px-2.5 text-[11px] font-medium rounded-md bg-[#161920] border border-[#262B36] hover:border-[#E11D48] disabled:opacity-40 text-[#F3F4F6] transition-colors flex-none"
                    >
                      {testPending ? 'Testing…' : 'Test'}
                    </button>
                  </div>

                  {/* 3-Column Inline Bar: Provider + Model + Cost Strategy */}
                  <div className="grid grid-cols-[132px_minmax(0,1fr)_168px] gap-2 items-end">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[10px] font-medium text-[#8A909E] mb-1 leading-none">
                        Provider
                      </span>
                      <AtelierSelect
                        ariaLabel="Translation Provider"
                        testId="provider-select"
                        value={draft.translate.providerName}
                        options={PROVIDER_OPTIONS}
                        menuMinWidth={210}
                        onChange={val => {
                          const nextProv = val as AtelierSettings['translate']['providerName'];
                          const nextChoices =
                            nextProv === 'gemini' && discoveredModels.length > 0
                              ? discoveredModels
                              : (MODEL_CHOICES[nextProv] ?? MODEL_CHOICES.gemini);
                          const nextModel =
                            nextProv === 'gemini' &&
                            (draft.translate.autoPickCheapest || draft.translate.modelStrategy === 'cheapest')
                              ? pickFlashLiteModel(nextChoices)
                              : nextChoices[0];
                          setCustomModelMode(false);
                          setDraft(prev => ({
                            ...prev,
                            translate: { ...prev.translate, providerName: nextProv, model: nextModel },
                          }));
                        }}
                      />
                    </div>

                    <div className="flex flex-col min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-medium text-[#8A909E] leading-none">
                          Model
                        </span>
                        <button
                          type="button"
                          onClick={() => setCustomModelMode(v => !v)}
                          className="min-h-0 h-4 px-1.5 text-[9px] leading-none rounded bg-[#181B22] border border-[#262B36] hover:border-[#E11D48]/60 text-[#9BA1AE] hover:text-[#F3F4F6] transition-colors"
                        >
                          {customModelMode ? 'List' : 'Custom ID'}
                        </button>
                      </div>
                      {customModelMode ? (
                        <input
                          type="text"
                          value={draft.translate.model}
                          maxLength={96}
                          onChange={e => {
                            const cleaned = e.target.value.replace(/^models\//i, '').trimStart();
                            setDraft(prev => ({
                              ...prev,
                              translate: {
                                ...prev.translate,
                                model: cleaned,
                                modelStrategy: 'manual',
                                autoPickCheapest: false,
                              },
                            }));
                          }}
                          onBlur={() =>
                            setDraft(prev => ({
                              ...prev,
                              translate: { ...prev.translate, model: cleanGeminiModelId(prev.translate.model) },
                            }))
                          }
                          placeholder="e.g. gemini-2.5-flash-lite"
                          className="h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                        />
                      ) : (
                        <AtelierSelect
                          ariaLabel="Model Name"
                          testId="model-select"
                          value={cleanSelectedModel}
                          options={modelOptions}
                          menuMinWidth={305}
                          triggerClassName="font-mono"
                          onChange={val => {
                            const picked = cleanGeminiModelId(val);
                            const isLite = picked.toLowerCase().includes('flash-lite');
                            setDraft(prev => ({
                              ...prev,
                              translate: {
                                ...prev.translate,
                                model: picked,
                                modelStrategy: isLite
                                  ? prev.translate.modelStrategy === 'manual'
                                    ? 'manual'
                                    : 'cheapest'
                                  : 'manual',
                                autoPickCheapest: isLite ? prev.translate.autoPickCheapest : false,
                              },
                            }));
                          }}
                        />
                      )}
                    </div>

                    <div className="flex flex-col min-w-0">
                      <span className="text-[10px] font-medium text-[#8A909E] mb-1 leading-none">
                        Cost Strategy
                      </span>
                      <div className="h-8 p-0.5 rounded-md bg-[#0D0F14] border border-[#262B36] grid grid-cols-3 gap-0.5">
                        {(
                          [
                            ['cheapest', 'Cheapest'],
                            ['balanced', 'Balanced'],
                            ['manual', 'Manual'],
                          ] as const
                        ).map(([id, label]) => {
                          const active = draft.translate.modelStrategy === id;
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => applyStrategy(id)}
                              className={`min-h-0 h-full px-1 rounded text-[10px] font-medium border-0 transition-colors cursor-pointer truncate ${
                                active
                                  ? 'bg-[#E11D48] text-white'
                                  : 'bg-transparent text-[#8A909E] hover:text-[#E5E7EB]'
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>

                  {/* Compact Bottom Toggles */}
                  <div className="flex items-center justify-between gap-2 pt-0.5 text-[11px] text-[#9BA1AE]">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer truncate">
                      <input
                        type="checkbox"
                        checked={draft.translate.autoPickCheapest}
                        onChange={e => {
                          const checked = e.target.checked;
                          if (checked) {
                            applyStrategy('cheapest');
                          } else {
                            setDraft(prev => ({
                              ...prev,
                              translate: {
                                ...prev.translate,
                                autoPickCheapest: false,
                                modelStrategy: prev.translate.modelStrategy === 'cheapest' ? 'manual' : prev.translate.modelStrategy,
                              },
                            }));
                          }
                        }}
                        className="accent-[#E11D48]"
                      />
                      <span className="truncate">Auto-pick cheapest model (Flash-Lite)</span>
                    </label>

                    <label className="inline-flex items-center gap-1.5 cursor-pointer flex-none">
                      <input
                        type="checkbox"
                        checked={draft.translate.rememberKey}
                        onChange={e =>
                          setDraft(prev => ({
                            ...prev,
                            translate: { ...prev.translate, rememberKey: e.target.checked },
                          }))
                        }
                        className="accent-[#E11D48]"
                      />
                      <span>Remember Key locally</span>
                    </label>
                  </div>
                </div>

                {/* Bento Card 2: Translation Direction & Persona Matrix */}
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-2.5 flex flex-col gap-2 flex-1 min-h-0">
                  <div className="grid grid-cols-[96px_132px_minmax(0,1fr)] gap-2 items-end flex-none">
                    <div className="flex flex-col min-w-0">
                      <span className="text-[10px] font-medium text-[#8A909E] mb-1 leading-none">
                        Language Pair
                      </span>
                      <AtelierSelect
                        ariaLabel="Source and Target Language"
                        value={draft.translate.langPair}
                        options={LANG_PAIR_OPTIONS}
                        menuMinWidth={190}
                        onChange={val =>
                          setDraft(prev => ({
                            ...prev,
                            translate: { ...prev.translate, langPair: val },
                          }))
                        }
                      />
                    </div>

                    <div className="flex flex-col min-w-0">
                      <span className="text-[10px] font-medium text-[#8A909E] mb-1 leading-none">
                        Batch Mode
                      </span>
                      <AtelierSelect
                        ariaLabel="Translation Batch Mode"
                        value={draft.translate.translationMode}
                        options={MODE_OPTIONS}
                        menuMinWidth={210}
                        onChange={val =>
                          setDraft(prev => ({
                            ...prev,
                            translate: {
                              ...prev.translate,
                              translationMode: val as AtelierSettings['translate']['translationMode'],
                            },
                          }))
                        }
                      />
                    </div>

                    <div className="flex flex-col min-w-0">
                      <span className="text-[10px] font-medium text-[#8A909E] mb-1 leading-none">
                        Persona Preset
                      </span>
                      {addingPreset ? (
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={newPresetName}
                            onChange={e => setNewPresetName(e.target.value)}
                            placeholder="Preset name..."
                            className="flex-1 min-w-0 h-8 text-xs px-2 rounded-md bg-[#0D0F14] border border-[#262B36] text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={handleCreatePreset}
                            className="min-h-0 h-8 px-2 text-[11px] rounded-md bg-[#E11D48] hover:bg-[#BE123C] text-white font-medium border-0"
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => setAddingPreset(false)}
                            className="min-h-0 h-8 px-2 text-[11px] rounded-md bg-[#161920] border border-[#262B36] text-[#9BA1AE]"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <AtelierSelect
                            ariaLabel="Persona Preset"
                            value={activePreset?.id ?? ''}
                            options={presetOptions}
                            menuMinWidth={225}
                            className="flex-1 min-w-0"
                            onChange={val =>
                              setDraft(prev => ({
                                ...prev,
                                translate: { ...prev.translate, activePresetId: val },
                              }))
                            }
                          />
                          <button
                            type="button"
                            title="Save current prompt as new preset"
                            onClick={() => setAddingPreset(true)}
                            className="min-h-0 h-8 w-7 p-0 rounded-md bg-[#161920] border border-[#262B36] hover:border-[#4B5563] text-[#D0D5DD] flex items-center justify-center flex-none"
                          >
                            <Plus size={12} />
                          </button>
                          <button
                            type="button"
                            disabled={Boolean(activePreset?.builtin)}
                            title={activePreset?.builtin ? 'Built-in preset cannot be deleted' : 'Delete custom preset'}
                            onClick={handleDeletePreset}
                            className="min-h-0 h-8 w-7 p-0 rounded-md bg-[#161920] border border-[#262B36] hover:border-rose-500/60 disabled:opacity-35 text-[#D0D5DD] hover:text-rose-400 flex items-center justify-center flex-none"
                          >
                            <Trash2 size={12} />
                          </button>
                          <button
                            type="button"
                            title="Reset preset prompt to default"
                            onClick={() => {
                              const def = DEFAULT_PRESETS.find(p => p.id === activePreset?.id) ?? DEFAULT_PRESETS[0];
                              updatePrompt(def.prompt);
                            }}
                            className="min-h-0 h-8 w-7 p-0 rounded-md bg-[#161920] border border-[#262B36] hover:border-[#4B5563] text-[#D0D5DD] flex items-center justify-center flex-none"
                          >
                            <RotateCcw size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Dark Prompt Textarea with Embedded Token Toolbar */}
                  <div className="flex-1 min-h-0 flex flex-col rounded-md bg-[#0D0F14] border border-[#1E222D] focus-within:border-[#E11D48] overflow-hidden">
                    <textarea
                      maxLength={4000}
                      value={activePreset?.prompt ?? ''}
                      onChange={e => updatePrompt(e.target.value)}
                      className="flex-1 min-h-[58px] w-full resize-none bg-transparent border-0 px-2.5 py-2 text-[11px] font-mono text-[#E5E7EB] leading-snug focus:outline-none"
                      placeholder="Enter system prompt persona instructions..."
                    />
                    <div className="h-7 px-2 bg-[#101319] border-t border-[#1C2029] flex items-center justify-between gap-2 flex-none">
                      <div className="flex items-center gap-1 min-w-0">
                        <span className="text-[10px] text-[#7D8494] mr-0.5">Tokens:</span>
                        {['{target_lang}', '{page_context}', '{series_glossary}'].map(tok => (
                          <button
                            key={tok}
                            type="button"
                            onClick={() => insertToken(tok)}
                            className="min-h-0 px-1.5 py-0.5 rounded bg-[#181C26] hover:bg-[#E11D48]/15 border border-[#262B38] hover:border-[#E11D48]/50 font-mono text-[10px] text-[#CBD5E1] transition-colors cursor-pointer"
                          >
                            {tok}
                          </button>
                        ))}
                      </div>
                      <span className="text-[10px] font-mono text-[#6B7280] flex-none">
                        {(activePreset?.prompt ?? '').length}/4000
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'ocr' && (
              <div className="flex flex-col gap-3">
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        Detection Mode
                      </span>
                      <AtelierSelect
                        ariaLabel="Detection Mode"
                        disabled={props.busy}
                        value={props.detectionMode}
                        options={[
                          { value: 'bubble', label: 'Bubble Containers', sublabel: 'Speech balloon detection' },
                          { value: 'text', label: 'Text Only (Ogkalu)', sublabel: 'Direct text regions' },
                        ]}
                        onChange={val => props.onDetectionMode(val as DetectionMode)}
                      />
                    </div>

                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        OCR Engine
                      </span>
                      <AtelierSelect
                        ariaLabel="OCR Engine"
                        value={draft.bubbleOcr.ocrEngine}
                        options={[
                          { value: 'ogkalu', label: 'Ogkalu ONNX + Gemini Vision' },
                          { value: 'mangaocr', label: 'MangaOCR Local' },
                        ]}
                        onChange={val =>
                          setDraft(prev => ({
                            ...prev,
                            bubbleOcr: { ...prev.bubbleOcr, ocrEngine: val as 'ogkalu' | 'mangaocr' },
                          }))
                        }
                      />
                    </div>
                  </div>

                  <SettingsSlider
                    label="YOLO Confidence Threshold"
                    displayValue={draft.bubbleOcr.yoloConfidence.toFixed(2)}
                    min={25}
                    max={90}
                    value={Math.round(draft.bubbleOcr.yoloConfidence * 100)}
                    onChange={val =>
                      setDraft(prev => ({
                        ...prev,
                        bubbleOcr: { ...prev.bubbleOcr, yoloConfidence: val / 100 },
                      }))
                    }
                  />
                </div>

                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        Box Expansion Padding (px)
                      </span>
                      <input
                        type="number"
                        min={0}
                        max={32}
                        value={draft.bubbleOcr.boxPadding}
                        onChange={e =>
                          setDraft(prev => ({
                            ...prev,
                            bubbleOcr: { ...prev.bubbleOcr, boxPadding: Number(e.target.value) },
                          }))
                        }
                        className="h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                      />
                    </div>

                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        Container Provider
                      </span>
                      <AtelierSelect
                        ariaLabel="Container Provider"
                        disabled={props.busy}
                        value={props.provider}
                        options={[
                          { value: 'shima_v1', label: 'Shima V1 YOLO' },
                          { value: 'opencv', label: 'OpenCV Fallback' },
                        ]}
                        onChange={val => props.onProvider(val)}
                      />
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-[#D0D5DD]">
                      <input
                        type="checkbox"
                        checked={draft.bubbleOcr.autoMergeOverlapping}
                        onChange={e =>
                          setDraft(prev => ({
                            ...prev,
                            bubbleOcr: { ...prev.bubbleOcr, autoMergeOverlapping: e.target.checked },
                          }))
                        }
                        className="accent-[#E11D48]"
                      />
                      <span>Auto-merge overlapping detection boxes</span>
                    </label>

                    <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-[#D0D5DD]">
                      <input
                        type="checkbox"
                        checked={Boolean(props.includeFreeText)}
                        disabled={props.busy}
                        onChange={e => props.onIncludeFreeText?.(e.target.checked)}
                        className="accent-[#E11D48]"
                      />
                      <span>Include free text / SFX outside bubbles</span>
                    </label>
                  </div>
                </div>
              </div>
            )}

            {section === 'inpaint' && (
              <div className="flex flex-col gap-3">
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        Default Cleaning Model
                      </span>
                      <AtelierSelect
                        ariaLabel="Default Cleaning Model"
                        value={draft.inpainting.defaultEngine}
                        options={[
                          { value: 'lama', label: 'LaMa + Smart Bubble White Fill' },
                          { value: 'opencv', label: 'OpenCV Telea (Instant CPU)' },
                        ]}
                        onChange={val =>
                          setDraft(prev => ({
                            ...prev,
                            inpainting: { ...prev.inpainting, defaultEngine: val as 'lama' | 'opencv' },
                          }))
                        }
                      />
                    </div>

                    <div className="flex flex-col">
                      <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                        Export Format
                      </span>
                      <AtelierSelect
                        ariaLabel="Export Format"
                        value={props.exportFormat}
                        options={[
                          { value: 'png', label: 'PNG (Lossless Native)' },
                          { value: 'jpeg', label: 'JPEG (Compact Archive)' },
                        ]}
                        onChange={val => props.onExportFormat(val as 'png' | 'jpeg')}
                      />
                    </div>
                  </div>

                  <SettingsSlider
                    label="Automatic Mask Dilation"
                    displayValue={`${draft.inpainting.autoDilation} px`}
                    min={0}
                    max={12}
                    value={draft.inpainting.autoDilation}
                    onChange={val =>
                      setDraft(prev => ({
                        ...prev,
                        inpainting: { ...prev.inpainting, autoDilation: val },
                      }))
                    }
                  />
                </div>

                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-3">
                  <div className="flex flex-col">
                    <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                      VRAM Execution Policy
                    </span>
                    <AtelierSelect
                      ariaLabel="VRAM Execution Policy"
                      value={draft.inpainting.vramPolicy}
                      options={[
                        { value: 'keep_in_vram', label: 'Keep Models Loaded in VRAM (Fastest)' },
                        { value: 'sequential_low_vram', label: 'Sequential Low-VRAM Mode (6GB GPUs)' },
                      ]}
                      onChange={val =>
                        setDraft(prev => ({
                          ...prev,
                          inpainting: {
                            ...prev.inpainting,
                            vramPolicy: val as AtelierSettings['inpainting']['vramPolicy'],
                          },
                        }))
                      }
                    />
                  </div>

                  <div className="flex items-center justify-between pt-0.5">
                    <span className="text-xs text-[#D0D5DD]">Page Text Treatment</span>
                    <div className="inline-flex p-0.5 rounded-md bg-[#0D0F14] border border-[#262B36]">
                      <button
                        type="button"
                        disabled={!props.onTextMode || props.busy}
                        onClick={() => props.onTextMode?.('clean')}
                        className={`min-h-0 h-7 px-3 rounded text-[11px] border-0 ${
                          props.textMode === 'clean' ? 'bg-[#E11D48] text-white font-medium' : 'bg-transparent text-[#8A909E]'
                        }`}
                      >
                        Clean
                      </button>
                      <button
                        type="button"
                        disabled={!props.onTextMode || props.busy}
                        onClick={() => props.onTextMode?.('overlay')}
                        className={`min-h-0 h-7 px-3 rounded text-[11px] border-0 ${
                          props.textMode === 'overlay' ? 'bg-[#E11D48] text-white font-medium' : 'bg-transparent text-[#8A909E]'
                        }`}
                      >
                        Overlay
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'type' && (
              <div className="flex flex-col gap-3">
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 grid grid-cols-2 gap-3">
                  <div className="flex flex-col">
                    <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                      Default Comic Font
                    </span>
                    <AtelierSelect
                      ariaLabel="Default Comic Font"
                      value={draft.typography.defaultFont}
                      options={[
                        { value: 'CC Wild Words', label: 'CC Wild Words' },
                        { value: 'Anime Ace', label: 'Anime Ace' },
                        { value: 'Komika Axis', label: 'Komika Axis' },
                        { value: 'Arial', label: 'System Sans' },
                      ]}
                      onChange={val =>
                        setDraft(prev => ({
                          ...prev,
                          typography: { ...prev.typography, defaultFont: val },
                        }))
                      }
                    />
                  </div>

                  <div className="flex flex-col">
                    <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                      Default Font Size (px)
                    </span>
                    <input
                      type="number"
                      min={10}
                      max={72}
                      value={draft.typography.defaultFontSize}
                      onChange={e =>
                        setDraft(prev => ({
                          ...prev,
                          typography: { ...prev.typography, defaultFontSize: Number(e.target.value) },
                        }))
                      }
                      className="h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col">
                    <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                      Default Line Height
                    </span>
                    <input
                      type="number"
                      step={0.05}
                      min={0.9}
                      max={2.0}
                      value={draft.typography.defaultLineHeight}
                      onChange={e =>
                        setDraft(prev => ({
                          ...prev,
                          typography: { ...prev.typography, defaultLineHeight: Number(e.target.value) },
                        }))
                      }
                      className="h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                    />
                  </div>

                  <div className="flex flex-col">
                    <span className="text-[11px] font-medium text-[#9BA1AE] mb-1 leading-none">
                      Default Stroke Width (px)
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={10}
                      value={draft.typography.defaultStrokeWidth}
                      onChange={e =>
                        setDraft(prev => ({
                          ...prev,
                          typography: { ...prev.typography, defaultStrokeWidth: Number(e.target.value) },
                        }))
                      }
                      className="h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] font-mono text-[#F3F4F6] focus:border-[#E11D48] focus:outline-none"
                    />
                  </div>
                </div>

                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-1.5">
                  <label className="inline-flex items-center gap-2 cursor-pointer text-xs text-[#D0D5DD]">
                    <input
                      type="checkbox"
                      checked={draft.typography.autoDiamondWrap}
                      onChange={e =>
                        setDraft(prev => ({
                          ...prev,
                          typography: { ...prev.typography, autoDiamondWrap: e.target.checked },
                        }))
                      }
                      className="accent-[#E11D48]"
                    />
                    <span>Enable Auto-Diamond Bubble Wrap</span>
                  </label>
                  <p className="text-[11px] text-[#7D8494] m-0">
                    Balances multi-line English/Indonesian dialogue to match oval manga balloon contours automatically.
                  </p>
                </div>
              </div>
            )}

            {section === 'keys' && (
              <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 grid grid-cols-2 gap-2">
                {[
                  ['Approve & Next Box', 'Ctrl+Enter'],
                  ['AI Healing Brush', 'B'],
                  ['Rect Repair Area', 'R'],
                  ['Eraser Mask', 'E'],
                  ['Pure / Restore Brush', 'C'],
                  ['Brush Size Step', '[ / ] or Alt+Wheel'],
                  ['Apply Repair / Clean', 'Enter'],
                  ['Peek Raw Manga Hold', 'Space / Tab'],
                  ['Undo / Redo Stroke', 'Ctrl+Z / Ctrl+Shift+Z'],
                  ['Open / Save / Export', 'Ctrl+O / S / E'],
                ].map(([action, shortcut]) => (
                  <div
                    key={action}
                    className="h-8 px-2.5 rounded-md bg-[#0D0F14] border border-[#20242F] flex items-center justify-between"
                  >
                    <span className="text-[11px] text-[#D0D5DD] truncate">{action}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-[#181B23] border border-[#2D3342] font-mono text-[10px] text-[#F3F4F6] flex-none ml-1">
                      {shortcut}
                    </kbd>
                  </div>
                ))}
              </div>
            )}

            {section === 'about' && (
              <div className="flex flex-col gap-3">
                <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-3">
                  <div className="flex items-center justify-between pb-2.5 border-b border-[#1E222D]">
                    <div>
                      <h3 className="text-xs font-semibold text-[#F3F4F6] m-0">Yuchi Labs — MangaClean Atelier</h3>
                      <p className="text-[11px] text-[#8A909E] m-0 mt-0.5">
                        v0.4.0-atelier · Display Scaling {Math.round(window.devicePixelRatio * 100)}%
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setDraft(DEFAULT_ATELIER_SETTINGS);
                        props.onReset();
                      }}
                      className="min-h-0 h-8 text-xs px-2.5 rounded-md bg-[#0D0F14] border border-[#262B36] hover:border-[#E11D48] text-[#D0D5DD] transition-colors"
                    >
                      Reset Layout &amp; Defaults
                    </button>
                  </div>

                  <div className="flex items-center justify-between gap-3">
                    <span className="text-xs text-[#D0D5DD]">Interface Density</span>
                    <AtelierSelect
                      ariaLabel="Interface Density"
                      value={props.density}
                      className="w-44"
                      options={[
                        { value: 'Balanced', label: 'Balanced' },
                        { value: 'Compact', label: 'Compact' },
                        { value: 'Comfortable', label: 'Comfortable' },
                      ]}
                      onChange={val => props.onDensity(val as Density)}
                    />
                  </div>
                </div>

                {configInfo?.configPath && (
                  <div className="bg-[#12141A] border border-[#1E222D] rounded-lg p-3 flex flex-col gap-1">
                    <span className="text-[11px] font-medium text-[#9BA1AE]">Local Config Store</span>
                    <p className="text-[11px] font-mono text-[#7D8494] m-0 break-all bg-[#0D0F14] border border-[#20242F] rounded-md p-2">
                      {configInfo.configPath}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </ModalFrame>
  );
}

export function QuickExportDialog({
  onClose,
  onExport,
  width,
  height,
  busy,
  typographyNotice,
  chapterCount,
  onExportPages,
}: {
  chapterCount?: number;
  onExportPages?: (kind: 'png' | 'jpeg') => void;
  typographyNotice?: ReactNode;
  onClose: () => void;
  onExport: (kind: 'png' | 'jpeg') => void;
  width: number;
  height: number;
  busy: boolean;
}) {
  return (
    <ModalFrame title="Quick Export" onClose={onClose} className="quick-export-dialog">
      <div className="export-dialog-body">
        <p>
          Export the working image with visible text layers at native resolution: <strong>{width} × {height}</strong>.
        </p>
        {typographyNotice}
        <div className="export-format-buttons">
          <button className="studio-action primary" disabled={busy} onClick={() => onExport('png')}>
            <Download size={16} /> Export PNG
          </button>
          <button className="studio-action" disabled={busy} onClick={() => onExport('jpeg')}>
            <Download size={16} /> Export JPEG
          </button>
        </div>
        {chapterCount && chapterCount > 1 && (
          <section>
            <h3>Chapter · selected pages, or all if none selected</h3>
            <button disabled={busy} onClick={() => onExportPages?.('png')}>
              Export chapter PNG
            </button>
            <button disabled={busy} onClick={() => onExportPages?.('jpeg')}>
              Export chapter JPEG
            </button>
          </section>
        )}
        <p className="availability-note">
          PNG/JPEG export checks visible dialogue rendering before writing the final image. Project Save remains
          available for unfinished work.
        </p>
      </div>
    </ModalFrame>
  );
}
