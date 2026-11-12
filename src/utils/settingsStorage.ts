export interface StylePreset {
  id: string;
  name: string;
  prompt: string;
  builtin?: boolean;
}

export interface AtelierSettings {
  translate: {
    langPair: string;
    translationMode: 'per_page' | 'per_bubble' | 'glossary_locked';
    providerName: 'gemini' | 'openai' | 'deepseek' | 'ollama';
    model: string;
    modelStrategy: 'cheapest' | 'balanced' | 'manual';
    autoPickCheapest: boolean;
    rememberKey: boolean;
    activePresetId: string;
    presets: StylePreset[];
  };
  bubbleOcr: {
    yoloConfidence: number;
    boxPadding: number;
    autoMergeOverlapping: boolean;
    ocrEngine: 'ogkalu' | 'mangaocr';
  };
  inpainting: {
    defaultEngine: 'lama' | 'opencv';
    autoDilation: number;
    vramPolicy: 'keep_in_vram' | 'sequential_low_vram';
  };
  typography: {
    defaultFont: string;
    defaultFontSize: number;
    defaultLineHeight: number;
    autoDiamondWrap: boolean;
    defaultStrokeWidth: number;
  };
  shortcuts: {
    approveNext: string;
    healingBrush: string;
    rectRepair: string;
    restoreBrush: string;
    peekRaw: string;
  };
}

const STORAGE_KEY = 'mangaclean.atelier.settings.v1';

export const DEFAULT_PRESETS: StylePreset[] = [
  {
    id: 'yuri-sol',
    name: 'Yuri / Slice of Life (Natural ID)',
    prompt:
      'You are a senior professional manga translator and editor translating into natural, warm Indonesian. Preserve casual emotional nuance, subtle closeness, and readable conversational bubble flow without stiff literal phrasing.',
    builtin: true,
  },
  {
    id: 'seinen-detail',
    name: 'Seinen High-Detail',
    prompt:
      'Translate into crisp, mature Indonesian suited for seinen manga. Keep internal monologues, understated tension, and terminology accurate while maintaining concise lettering lines.',
    builtin: true,
  },
  {
    id: 'shounen-action',
    name: 'Shounen Action',
    prompt:
      'Translate with punchy, energetic Indonesian for shounen dialogue and impact lines. Keep exclamations short and high-impact so text fits cleanly inside dynamic bubbles.',
    builtin: true,
  },
  {
    id: 'formal-literary',
    name: 'Formal / Literary',
    prompt:
      'Use refined, polite standard Indonesian (EYD) suitable for historical, noble, or formal narration boxes. Preserve honorific register carefully.',
    builtin: true,
  },
];

export const DEFAULT_ATELIER_SETTINGS: AtelierSettings = {
  translate: {
    langPair: 'JA → ID',
    translationMode: 'per_page',
    providerName: 'gemini',
    model: 'gemini-3.5-flash-lite',
    modelStrategy: 'cheapest',
    autoPickCheapest: true,
    rememberKey: true,
    activePresetId: 'yuri-sol',
    presets: DEFAULT_PRESETS,
  },
  bubbleOcr: {
    yoloConfidence: 0.45,
    boxPadding: 4,
    autoMergeOverlapping: true,
    ocrEngine: 'ogkalu',
  },
  inpainting: {
    defaultEngine: 'lama',
    autoDilation: 2,
    vramPolicy: 'keep_in_vram',
  },
  typography: {
    defaultFont: 'CC Wild Words',
    defaultFontSize: 22,
    defaultLineHeight: 1.15,
    autoDiamondWrap: true,
    defaultStrokeWidth: 2,
  },
  shortcuts: {
    approveNext: 'Ctrl+Enter',
    healingBrush: 'B',
    rectRepair: 'R',
    restoreBrush: 'C',
    peekRaw: 'Space / Tab',
  },
};

export function loadAtelierSettings(): AtelierSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ATELIER_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AtelierSettings>;
    return {
      translate: {
        ...DEFAULT_ATELIER_SETTINGS.translate,
        ...parsed.translate,
        presets:
          Array.isArray(parsed.translate?.presets) && parsed.translate.presets.length > 0
            ? parsed.translate.presets
            : DEFAULT_PRESETS,
      },
      bubbleOcr: { ...DEFAULT_ATELIER_SETTINGS.bubbleOcr, ...parsed.bubbleOcr },
      inpainting: { ...DEFAULT_ATELIER_SETTINGS.inpainting, ...parsed.inpainting },
      typography: { ...DEFAULT_ATELIER_SETTINGS.typography, ...parsed.typography },
      shortcuts: { ...DEFAULT_ATELIER_SETTINGS.shortcuts, ...parsed.shortcuts },
    };
  } catch {
    return DEFAULT_ATELIER_SETTINGS;
  }
}

export function saveAtelierSettings(settings: AtelierSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota errors
  }
}
