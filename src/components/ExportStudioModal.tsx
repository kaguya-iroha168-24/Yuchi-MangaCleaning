import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  Archive,
  BookOpen,
  Check,
  Download,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Lock,
  Sparkles,
  Type,
  X,
} from 'lucide-react';
import type { Api, DocumentState } from '../api';
import { ModalFrame } from './PreferencesDialog';

export type ExportStudioFormat = 'krita' | 'epub' | 'cbz' | 'flat';
export type ExportStudioScope = 'all' | 'approved' | 'current' | 'range';

interface ExportStudioResult {
  format: ExportStudioFormat;
  directory: string;
  primaryPath: string;
  files: Array<{ pageId?: string; path: string; bytes: number; sha256: string }>;
  count: number;
  warnings?: string[];
}

export interface ExportStudioModalProps {
  api: Api;
  document: DocumentState;
  chapterPages: Array<{ id: string; name: string }>;
  approvedPageIds: string[];
  projectMeta?: {
    seriesTitle?: string;
    chapterNumber?: string;
    languagePair?: string;
    coverImage?: string;
  };
  onClose: () => void;
  onSuccessNotice?: (notice: string) => void;
}

const FORMAT_CARDS: Array<{
  id: ExportStudioFormat;
  title: string;
  extBadge: string;
  subtitle: string;
  icon: typeof Layers;
}> = [
  {
    id: 'krita',
    title: 'Krita Layered Project',
    extBadge: '.ORA Multi-Layer',
    subtitle: 'For Redraw & Post-Processing in Krita',
    icon: Layers,
  },
  {
    id: 'epub',
    title: 'Digital Manga / LN',
    extBadge: '.EPUB 3.0 Fixed',
    subtitle: 'E-Reader & Publisher Ready',
    icon: BookOpen,
  },
  {
    id: 'cbz',
    title: 'Comic Book Archive',
    extBadge: '.CBZ + ComicInfo',
    subtitle: '1-Click Reader Bundle',
    icon: Archive,
  },
  {
    id: 'flat',
    title: 'Flat Sequence Images',
    extBadge: '.PNG / .JPG / .WEBP',
    subtitle: 'Standard Release Folder',
    icon: ImageIcon,
  },
];

export function ExportStudioModal(props: ExportStudioModalProps) {
  const totalPages = Math.max(1, props.chapterPages.length);
  const defaultSeries =
    props.projectMeta?.seriesTitle ||
    props.document.projectName?.replace(/\.mangaclean$/i, '') ||
    props.document.sourceName.replace(/\.[^/.]+$/, '');
  const defaultChapter = props.projectMeta?.chapterNumber || '1';
  const defaultLang = props.projectMeta?.languagePair?.toLowerCase().includes('en') ? 'en' : 'id';

  const [format, setFormat] = useState<ExportStudioFormat>('krita');
  const [scope, setScope] = useState<ExportStudioScope>(totalPages === 1 ? 'current' : 'all');
  const [rangeExpr, setRangeExpr] = useState(`1-${Math.min(5, totalPages)}`);
  const [destinationDir, setDestinationDir] = useState('');
  const [defaultDirHint, setDefaultDirHint] = useState('outputs/exports');

  // Krita (.ora) options
  const [includeOriginal, setIncludeOriginal] = useState(true);
  const [includeCleaned, setIncludeCleaned] = useState(true);
  const [includeTypeset, setIncludeTypeset] = useState(true);
  const [includeRedrawSfx, setIncludeRedrawSfx] = useState(true);
  const [cleanedPatchOnly, setCleanedPatchOnly] = useState(true);
  const [splitTypesetBubbles, setSplitTypesetBubbles] = useState(false);
  const [launchInKrita, setLaunchInKrita] = useState(false);

  // Publisher metadata (EPUB / CBZ / Flat)
  const [readingDirection, setReadingDirection] = useState<'rtl' | 'ltr'>('rtl');
  const [includeCover, setIncludeCover] = useState(true);
  const [seriesTitle, setSeriesTitle] = useState(defaultSeries);
  const [chapterTitle, setChapterTitle] = useState(`Chapter ${defaultChapter}`);
  const [chapterNumber, setChapterNumber] = useState(defaultChapter);
  const [author, setAuthor] = useState('');
  const [publisher, setPublisher] = useState('Yuchi Labs — MangaClean Atelier');

  // Flat / CBZ image options
  const [imageFormat, setImageFormat] = useState<'png' | 'jpg' | 'webp'>('png');
  const [quality, setQuality] = useState(95);
  const [namingPattern, setNamingPattern] = useState<'page_001' | '001' | 'series_ch_page' | 'original'>('page_001');
  const [flatTarget, setFlatTarget] = useState<'composite' | 'cleaned' | 'typeset_only'>('composite');

  // Execution state
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportStudioResult | null>(null);

  useEffect(() => {
    let alive = true;
    void props.api
      .get<{ directory: string }>('/v1/export/default-dir')
      .then(res => {
        if (alive && res?.directory) setDefaultDirHint(res.directory);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [props.api]);

  const coverInfo = useMemo(() => {
    const raw = props.projectMeta?.coverImage;
    if (!raw) return { path: null as string | null, dataUrl: null as string | null, label: 'Page 1 fallback' };
    if (raw.startsWith('data:image/')) return { path: null, dataUrl: raw, label: 'Custom Cover' };
    return { path: raw, dataUrl: null, label: 'Custom Cover (disk)' };
  }, [props.projectMeta?.coverImage]);

  const estimatedPageCount = useMemo(() => {
    if (scope === 'current') return 1;
    if (scope === 'approved') return props.approvedPageIds.length;
    if (scope === 'all') return totalPages;
    // Rough count preview for range string
    const tokens = rangeExpr
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
    const set = new Set<number>();
    for (const tok of tokens) {
      if (tok.includes('-')) {
        const [aRaw, bRaw] = tok.split('-', 2);
        const a = Number(aRaw);
        const b = Number(bRaw);
        if (Number.isInteger(a) && Number.isInteger(b)) {
          const lo = Math.max(1, Math.min(a, b));
          const hi = Math.min(totalPages, Math.max(a, b));
          for (let i = lo; i <= hi; i++) set.add(i);
        }
      } else {
        const n = Number(tok);
        if (Number.isInteger(n) && n >= 1 && n <= totalPages) set.add(n);
      }
    }
    return set.size;
  }, [scope, props.approvedPageIds.length, totalPages, rangeExpr]);

  const handleBrowseFolder = async () => {
    try {
      const picked = await invoke<string | null>('pick_export_directory', {
        initialDir: destinationDir || defaultDirHint || null,
      });
      if (picked) setDestinationDir(picked);
    } catch {
      // Fallback gracefully if invoked outside desktop webview
    }
  };

  const handleOpenFile = async (targetPath: string, preferKrita: boolean) => {
    try {
      await invoke<boolean>('open_exported_file', { path: targetPath, preferKrita });
    } catch {
      // Ignore shell spawn error silently
    }
  };

  const handleReveal = async (targetPath: string) => {
    try {
      await invoke<boolean>('reveal_path', { path: targetPath });
    } catch {
      await props.api.revealPath(targetPath).catch(() => {});
    }
  };

  const handleExport = async () => {
    setExporting(true);
    setError('');
    setResult(null);
    try {
      const res = await props.api.post<ExportStudioResult>('/v1/export/studio', {
        format,
        scope,
        rangeExpr,
        approvedPageIds: props.approvedPageIds,
        destinationDir: destinationDir.trim(),
        krita: {
          includeOriginal,
          includeCleaned,
          includeTypeset,
          includeRedrawSfx,
          cleanedPatchOnly,
          splitTypesetBubbles,
        },
        metadata: {
          seriesTitle: seriesTitle.trim() || defaultSeries,
          chapterTitle: chapterTitle.trim() || `Chapter ${defaultChapter}`,
          chapterNumber: chapterNumber.trim() || defaultChapter,
          author: author.trim(),
          publisher: publisher.trim() || 'Yuchi Labs — MangaClean Atelier',
          language: defaultLang,
          readingDirection,
          includeCover,
          coverImagePath: coverInfo.path,
          coverDataUrl: coverInfo.dataUrl,
        },
        flat: {
          imageFormat,
          quality,
          namingPattern,
          target: flatTarget,
        },
      });
      setResult(res);
      props.onSuccessNotice?.(`Exported ${res.count} file(s) → ${res.primaryPath}`);
      if (format === 'krita' && launchInKrita && res.primaryPath) {
        await handleOpenFile(res.primaryPath, true);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  const ctaLabel =
    format === 'krita'
      ? 'Export Krita (.ORA)'
      : format === 'epub'
        ? 'Build .EPUB 3'
        : format === 'cbz'
          ? 'Package .CBZ'
          : `Export ${imageFormat.toUpperCase()} Sequence`;

  return (
    <ModalFrame title="Publisher Export Studio" onClose={props.onClose} className="atelier-settings-modal">
      <div className="w-[620px] max-w-[94vw] bg-[#111318] border border-[#252934] rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[88vh] text-[#E5E7EB]">
        {/* Header */}
        <header className="px-4 py-3 bg-[#14161B] border-b border-[#232730] flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-7 h-7 rounded-md bg-[#EF4444]/15 border border-[#EF4444]/40 flex items-center justify-center text-[#F87171]">
              <Download size={14} />
            </div>
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold text-[#F9FAFB] m-0 leading-tight">
                Publisher &amp; Krita Export Studio
              </h2>
              <p className="text-[10px] font-mono text-[#9CA3AF] m-0 truncate">
                {props.document.width}×{props.document.height}px · {totalPages} page{totalPages > 1 ? 's' : ''} loaded · Active: {props.document.sourceName}
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label="Close Publisher Export Studio"
            onClick={props.onClose}
            className="w-7 h-7 rounded-md flex items-center justify-center text-[#9CA3AF] hover:text-white hover:bg-[#1E222B] transition-colors"
          >
            <X size={16} />
          </button>
        </header>

        {/* Scrollable Content */}
        <div className="overflow-y-auto p-4 flex flex-col gap-3.5">
          {/* A. 4 Interactive Format Cards */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
              1. Export Format
            </span>
            <div className="grid grid-cols-2 gap-2">
              {FORMAT_CARDS.map(card => {
                const Icon = card.icon;
                const active = format === card.id;
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => {
                      setFormat(card.id);
                      setError('');
                      setResult(null);
                    }}
                    className={`p-2.5 rounded-lg border text-left transition-all flex items-start gap-2.5 ${
                      active
                        ? 'bg-[#EF4444]/10 border-[#EF4444] shadow-[0_0_0_1px_rgba(239,68,68,0.25)]'
                        : 'bg-[#14161B] border-[#232730] hover:border-[#323846]'
                    }`}
                  >
                    <div
                      className={`w-7 h-7 rounded-md flex-none flex items-center justify-center mt-0.5 ${
                        active ? 'bg-[#EF4444] text-white' : 'bg-[#0D0E11] text-[#9CA3AF] border border-[#232730]'
                      }`}
                    >
                      <Icon size={14} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] font-semibold text-[#F3F4F6] truncate">{card.title}</span>
                      </div>
                      <span className="inline-block px-1.5 py-0.5 my-0.5 rounded bg-[#0D0E11] border border-[#232730] font-mono text-[9px] text-[#FCA5A5]">
                        {card.extBadge}
                      </span>
                      <p className="text-[10px] text-[#9CA3AF] m-0 leading-snug">{card.subtitle}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Format-Specific Controls */}
          <div className="bg-[#14161B] border border-[#232730] rounded-lg p-3 flex flex-col gap-2.5">
            {format === 'krita' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                    Krita Layer Stack Preview (Top → Bottom Z-Order)
                  </span>
                  <span className="text-[10px] font-mono text-[#6B7280]">OpenRaster (.ora)</span>
                </div>

                {/* Top-to-Bottom Z-order interactive checklist matching OpenRaster stack */}
                <div className="flex flex-col gap-1.5">
                  {/* Layer 4 (Top): 04_Redraw_SFX */}
                  <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0D0E11] border border-[#232730]">
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-[#E5E7EB]">
                      <input
                        type="checkbox"
                        checked={includeRedrawSfx}
                        onChange={e => setIncludeRedrawSfx(e.target.checked)}
                        className="accent-[#EF4444]"
                      />
                      <Sparkles size={12} className="text-amber-400" />
                      <span>
                        <strong className="font-mono text-[10px] text-[#9CA3AF]">Layer 4 · </strong>
                        04_Redraw_SFX
                      </span>
                    </label>
                    <span className="text-[10px] text-[#6B7280]">Blank SFX brush layer</span>
                  </div>

                  {/* Layer 3 (Typeset): 03_Typeset_Text */}
                  <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded bg-[#0D0E11] border border-[#232730]">
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 cursor-pointer text-[11px] text-[#E5E7EB]">
                        <input
                          type="checkbox"
                          checked={includeTypeset}
                          onChange={e => setIncludeTypeset(e.target.checked)}
                          className="accent-[#EF4444]"
                        />
                        <Type size={12} className="text-sky-400" />
                        <span>
                          <strong className="font-mono text-[10px] text-[#9CA3AF]">Layer 3 · </strong>
                          03_Typeset_Text
                        </span>
                      </label>
                      <div className="inline-flex rounded bg-[#14161B] border border-[#232730] p-0.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() => setSplitTypesetBubbles(false)}
                          className={`px-2 py-0.5 rounded transition-colors ${
                            !splitTypesetBubbles ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                          }`}
                        >
                          Merged Layer
                        </button>
                        <button
                          type="button"
                          onClick={() => setSplitTypesetBubbles(true)}
                          className={`px-2 py-0.5 rounded transition-colors ${
                            splitTypesetBubbles ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                          }`}
                        >
                          Group per Bubble
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Layer 2 (Clean): 02_Cleaned_Inpaint */}
                  <div className="flex flex-col gap-1.5 px-2.5 py-2 rounded bg-[#0D0E11] border border-[#232730]">
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 cursor-pointer text-[11px] text-[#E5E7EB]">
                        <input
                          type="checkbox"
                          checked={includeCleaned}
                          onChange={e => setIncludeCleaned(e.target.checked)}
                          className="accent-[#EF4444]"
                        />
                        <Layers size={12} className="text-emerald-400" />
                        <span>
                          <strong className="font-mono text-[10px] text-[#9CA3AF]">Layer 2 · </strong>
                          02_Cleaned_Inpaint
                        </span>
                      </label>
                      <div className="inline-flex rounded bg-[#14161B] border border-[#232730] p-0.5 text-[10px]">
                        <button
                          type="button"
                          onClick={() => setCleanedPatchOnly(true)}
                          className={`px-2 py-0.5 rounded transition-colors ${
                            cleanedPatchOnly ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                          }`}
                          title="Transparent alpha everywhere except repaired pixels — erase in Krita to reveal Raw underneath"
                        >
                          Transparent Patch Only
                        </button>
                        <button
                          type="button"
                          onClick={() => setCleanedPatchOnly(false)}
                          className={`px-2 py-0.5 rounded transition-colors ${
                            !cleanedPatchOnly ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                          }`}
                        >
                          Full Canvas
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* Layer 1 (Base): 01_Original_Raw */}
                  <div className="flex items-center justify-between gap-2 px-2.5 py-2 rounded bg-[#0D0E11] border border-[#232730]">
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-[#E5E7EB]">
                      <input
                        type="checkbox"
                        checked={includeOriginal}
                        onChange={e => setIncludeOriginal(e.target.checked)}
                        className="accent-[#EF4444]"
                      />
                      <Lock size={12} className="text-[#9CA3AF]" />
                      <span>
                        <strong className="font-mono text-[10px] text-[#9CA3AF]">Layer 1 · </strong>
                        01_Original_Raw
                      </span>
                    </label>
                    <span className="text-[10px] text-[#6B7280]">Locked raw reference base</span>
                  </div>
                </div>

                {/* Open in Krita checkbox */}
                <label className="flex items-center gap-2 pt-1 cursor-pointer text-[11px] text-[#D1D5DB]">
                  <input
                    type="checkbox"
                    checked={launchInKrita}
                    onChange={e => setLaunchInKrita(e.target.checked)}
                    className="accent-[#EF4444]"
                  />
                  <span>Launch directly in Krita (or OS default handler) after export</span>
                </label>
              </>
            )}

            {(format === 'epub' || format === 'cbz') && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                    {format === 'epub' ? 'EPUB 3.0 Fixed-Layout & Metadata' : 'CBZ ComicInfo.xml Metadata'}
                  </span>
                  <div className="inline-flex rounded bg-[#0D0E11] border border-[#232730] p-0.5 text-[10px]">
                    <button
                      type="button"
                      onClick={() => setReadingDirection('rtl')}
                      className={`px-2 py-0.5 rounded transition-colors ${
                        readingDirection === 'rtl' ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                      }`}
                    >
                      RTL (Japanese Manga)
                    </button>
                    <button
                      type="button"
                      onClick={() => setReadingDirection('ltr')}
                      className={`px-2 py-0.5 rounded transition-colors ${
                        readingDirection === 'ltr' ? 'bg-[#EF4444] text-white font-medium' : 'text-[#9CA3AF]'
                      }`}
                    >
                      LTR
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                    <span>Series Title</span>
                    <input
                      type="text"
                      value={seriesTitle}
                      onChange={e => setSeriesTitle(e.target.value)}
                      className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                    />
                  </label>
                  <div className="flex gap-1.5">
                    <label className="flex-1 flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                      <span>Chapter / Volume Title</span>
                      <input
                        type="text"
                        value={chapterTitle}
                        onChange={e => setChapterTitle(e.target.value)}
                        className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                      />
                    </label>
                    <label className="w-[62px] flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                      <span>Ch. #</span>
                      <input
                        type="text"
                        value={chapterNumber}
                        onChange={e => setChapterNumber(e.target.value)}
                        className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] font-mono text-[11px] text-[#F3F4F6]"
                      />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                    <span>Author / Artist</span>
                    <input
                      type="text"
                      placeholder="Optional mangaka credit"
                      value={author}
                      onChange={e => setAuthor(e.target.value)}
                      className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                    <span>Scanlation / Publisher</span>
                    <input
                      type="text"
                      value={publisher}
                      onChange={e => setPublisher(e.target.value)}
                      className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                    />
                  </label>
                </div>

                <div className="flex items-center justify-between gap-2 pt-0.5">
                  <label className="flex items-center gap-2 cursor-pointer text-[11px] text-[#D1D5DB]">
                    <input
                      type="checkbox"
                      checked={includeCover}
                      onChange={e => setIncludeCover(e.target.checked)}
                      className="accent-[#EF4444]"
                    />
                    <span>Include Cover Page</span>
                    <span className="px-1.5 py-0.5 rounded bg-[#0D0E11] border border-[#232730] font-mono text-[9px] text-[#9CA3AF]">
                      {coverInfo.label}
                    </span>
                  </label>

                  {format === 'cbz' && (
                    <div className="flex items-center gap-1.5 text-[10px]">
                      <select
                        value={imageFormat}
                        onChange={e => setImageFormat(e.target.value as 'png' | 'jpg' | 'webp')}
                        className="min-h-[26px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                      >
                        <option value="png">PNG Lossless</option>
                        <option value="jpg">JPG High-Res</option>
                        <option value="webp">WEBP Compact</option>
                      </select>
                      <span className="font-mono text-[#9CA3AF]">{quality}%</span>
                    </div>
                  )}
                </div>
              </>
            )}

            {format === 'flat' && (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                    Flat Image Release Options
                  </span>
                  <div className="inline-flex rounded bg-[#0D0E11] border border-[#232730] p-0.5 text-[10px]">
                    {(['png', 'jpg', 'webp'] as const).map(ext => (
                      <button
                        key={ext}
                        type="button"
                        disabled={flatTarget === 'typeset_only' && ext !== 'png'}
                        onClick={() => setImageFormat(ext)}
                        className={`px-2 py-0.5 rounded uppercase transition-colors disabled:opacity-35 ${
                          (flatTarget === 'typeset_only' ? 'png' : imageFormat) === ext
                            ? 'bg-[#EF4444] text-white font-medium'
                            : 'text-[#9CA3AF]'
                        }`}
                      >
                        .{ext}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Composite Target */}
                <div className="grid grid-cols-3 gap-1.5">
                  {[
                    { id: 'composite', label: 'Cleaned + Typeset' },
                    { id: 'cleaned', label: 'Cleaned Only' },
                    { id: 'typeset_only', label: 'Typeset Transparent PNG' },
                  ].map(opt => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setFlatTarget(opt.id as typeof flatTarget);
                        if (opt.id === 'typeset_only') setImageFormat('png');
                      }}
                      className={`min-h-[28px] px-2 rounded border text-[10px] transition-colors ${
                        flatTarget === opt.id
                          ? 'bg-[#EF4444]/15 border-[#EF4444] text-white font-medium'
                          : 'bg-[#0D0E11] border-[#232730] text-[#9CA3AF] hover:text-[#E5E7EB]'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2.5 items-center">
                  <div className="flex flex-col gap-1">
                    <div className="flex justify-between text-[10px] text-[#9CA3AF]">
                      <span>Quality / Compression</span>
                      <span className="font-mono text-[#E5E7EB]">{quality}%</span>
                    </div>
                    <input
                      type="range"
                      min={80}
                      max={100}
                      value={quality}
                      onChange={e => setQuality(Number(e.target.value))}
                      className="accent-[#EF4444] cursor-pointer"
                    />
                  </div>

                  <label className="flex flex-col gap-1 text-[10px] text-[#9CA3AF]">
                    <span>Naming Pattern</span>
                    <select
                      value={namingPattern}
                      onChange={e => setNamingPattern(e.target.value as typeof namingPattern)}
                      className="min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] text-[11px] text-[#F3F4F6]"
                    >
                      <option value="page_001">page_001.{imageFormat}</option>
                      <option value="001">001.{imageFormat}</option>
                      <option value="series_ch_page">
                        {'{series}'}_ch{chapterNumber}_001.{imageFormat}
                      </option>
                      <option value="original">{'{original_name}'}.{imageFormat}</option>
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>

          {/* B. Scope & Destination Controls */}
          <div className="bg-[#14161B] border border-[#232730] rounded-lg p-3 flex flex-col gap-2.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[#9CA3AF]">
                2. Scope &amp; Destination
              </span>
              <span className="text-[10px] font-mono text-[#9CA3AF]">
                {estimatedPageCount} page{estimatedPageCount === 1 ? '' : 's'} selected
              </span>
            </div>

            <div className="grid grid-cols-4 gap-1.5">
              {[
                { id: 'all' as const, label: `All (${totalPages})` },
                { id: 'approved' as const, label: `Approved (${props.approvedPageIds.length})` },
                { id: 'current' as const, label: 'Current Page' },
                { id: 'range' as const, label: 'Custom Range' },
              ].map(pill => (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setScope(pill.id)}
                  className={`min-h-[28px] px-2 rounded border text-[10px] transition-colors truncate ${
                    scope === pill.id
                      ? 'bg-[#EF4444]/15 border-[#EF4444] text-white font-medium'
                      : 'bg-[#0D0E11] border-[#232730] text-[#9CA3AF] hover:text-[#E5E7EB]'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {scope === 'range' && (
              <label className="flex items-center gap-2 text-[10px] text-[#9CA3AF]">
                <span className="flex-none">Page range (1–{totalPages}):</span>
                <input
                  type="text"
                  placeholder="e.g., 1-5, 8"
                  value={rangeExpr}
                  onChange={e => setRangeExpr(e.target.value)}
                  className="flex-1 min-h-[28px] px-2 rounded bg-[#0D0E11] border border-[#232730] font-mono text-[11px] text-[#F3F4F6]"
                />
              </label>
            )}

            <div className="flex items-center gap-1.5">
              <input
                type="text"
                placeholder={`Default: ${defaultDirHint}`}
                value={destinationDir}
                onChange={e => setDestinationDir(e.target.value)}
                className="flex-1 min-h-[30px] px-2.5 rounded bg-[#0D0E11] border border-[#232730] font-mono text-[10px] text-[#E5E7EB]"
              />
              <button
                type="button"
                onClick={() => void handleBrowseFolder()}
                className="min-h-[30px] px-3 rounded bg-[#0D0E11] border border-[#232730] hover:border-[#4B5563] text-[11px] text-[#E5E7EB] flex items-center gap-1.5"
              >
                <FolderOpen size={13} />
                <span>Browse…</span>
              </button>
            </div>
          </div>

          {/* Packaging Progress / Error / Success Banner */}
          {exporting && (
            <div className="p-2.5 rounded-lg bg-[#14161B] border border-[#232730] flex flex-col gap-1.5">
              <div className="flex items-center justify-between text-[11px] text-[#E5E7EB]">
                <span>Packaging {format.toUpperCase()} archive…</span>
                <span className="font-mono text-[10px] text-[#9CA3AF]">{estimatedPageCount} page(s)</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-[#0D0E11] overflow-hidden">
                <div className="h-full w-2/3 bg-[#EF4444] rounded-full animate-pulse" />
              </div>
            </div>
          )}

          {error && (
            <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/40 text-[11px] text-red-200">
              {error}
            </div>
          )}

          {result && (
            <div className="p-2.5 rounded-lg bg-emerald-950/35 border border-emerald-500/40 flex flex-col gap-2">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2 min-w-0">
                  <Check size={14} className="text-emerald-400 flex-none mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-[11px] font-medium text-emerald-200 m-0">
                      Exported {result.count} {result.format === 'krita' ? '.ora file(s)' : 'item(s)'} successfully
                    </p>
                    <p className="text-[10px] font-mono text-emerald-300/80 m-0 break-all">{result.primaryPath}</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 flex-none">
                  <button
                    type="button"
                    onClick={() => void handleReveal(result.primaryPath)}
                    className="min-h-[26px] px-2 rounded bg-[#0D0E11] border border-emerald-500/40 text-[10px] text-emerald-200 hover:bg-emerald-900/40 flex items-center gap-1"
                  >
                    <FolderOpen size={11} />
                    <span>Reveal</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleOpenFile(result.primaryPath, result.format === 'krita')}
                    className="min-h-[26px] px-2 rounded bg-emerald-600 hover:bg-emerald-500 text-[10px] text-white font-medium flex items-center gap-1"
                  >
                    <ExternalLink size={11} />
                    <span>{result.format === 'krita' ? 'Open Krita' : 'Open'}</span>
                  </button>
                </div>
              </div>
              {result.warnings && result.warnings.length > 0 && (
                <p className="text-[10px] text-amber-300 m-0">{result.warnings.join(' · ')}</p>
              )}
            </div>
          )}
        </div>

        {/* Sticky Footer */}
        <footer className="px-4 py-2.5 bg-[#14161B] border-t border-[#232730] flex items-center justify-between">
          <span className="text-[10px] font-mono text-[#9CA3AF]">
            {estimatedPageCount} page{estimatedPageCount === 1 ? '' : 's'} ·{' '}
            {format === 'krita' ? 'RGBA Layered OpenRaster' : format.toUpperCase()}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={exporting}
              onClick={props.onClose}
              className="min-h-[30px] px-3 rounded-md bg-[#0D0E11] border border-[#232730] hover:border-[#4B5563] text-[11px] text-[#D1D5DB] transition-colors"
            >
              Close
            </button>
            <button
              type="button"
              disabled={exporting || estimatedPageCount === 0}
              onClick={() => void handleExport()}
              className="min-h-[30px] px-4 rounded-md bg-[#EF4444] hover:bg-[#DC2626] disabled:opacity-45 text-white text-[11px] font-semibold flex items-center gap-1.5 transition-colors"
            >
              <Download size={13} />
              <span>{exporting ? 'Exporting…' : ctaLabel}</span>
            </button>
          </div>
        </footer>
      </div>
    </ModalFrame>
  );
}
