export {
  computeAutoFitFontSize,
  evaluateDialogueOverflow,
  autoFitFontSizePatch,
  manualFontSizePatch,
  type AutoFitInput,
  type AutoFitResult,
} from './typography';

export interface BoxRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function toBoxRect(rect: readonly number[] | BoxRect): BoxRect {
  if (Array.isArray(rect) || (typeof (rect as readonly number[])[0] === 'number')) {
    const tuple = rect as readonly number[];
    return { x: Number(tuple[0] ?? 0), y: Number(tuple[1] ?? 0), w: Math.max(1, Number(tuple[2] ?? 1)), h: Math.max(1, Number(tuple[3] ?? 1)) };
  }
  const box = rect as BoxRect;
  return { x: Number(box.x), y: Number(box.y), w: Math.max(1, Number(box.w)), h: Math.max(1, Number(box.h)) };
}

type SortEntry<T> = BoxRect & {
  item: T;
  index: number;
  right: number;
  bot: number;
  cx: number;
  cy: number;
};

/**
 * 2-Stage Panel-Band RTL Algorithm:
 * Stage 1: Group boxes into horizontal bands where vertical overlap >= 30% of shorter box height.
 * Stage 2: Sort bands Top-to-Bottom by min top; within each band, group vertical columns
 *          (horizontal overlap >= 40% of narrower box width) sorted Top-to-Bottom, and sort columns Right-to-Left.
 */
export function sortBoxesMangaRTL<T>(items: readonly T[], getRect: (item: T) => readonly number[] | BoxRect): T[] {
  if (items.length <= 1) return [...items];

  const entries: SortEntry<T>[] = items.map((item, index) => {
    const { x, y, w, h } = toBoxRect(getRect(item));
    return { item, index, x, y, w, h, right: x + w, bot: y + h, cx: x + w / 2, cy: y + h / 2 };
  });

  entries.sort((a, b) => a.cy - b.cy || a.y - b.y || b.cx - a.cx || a.index - b.index);

  const bands: SortEntry<T>[][] = [];
  for (const entry of entries) {
    let bestBand: SortEntry<T>[] | null = null;
    let bestRatio = 0;
    for (let bIdx = bands.length - 1; bIdx >= 0; bIdx--) {
      const band = bands[bIdx];
      let bandMaxRatio = 0;
      for (const member of band) {
        const overlapY = Math.min(entry.bot, member.bot) - Math.max(entry.y, member.y);
        if (overlapY > 0) {
          const ratio = overlapY / Math.min(entry.h, member.h);
          if (ratio > bandMaxRatio) bandMaxRatio = ratio;
        }
      }
      if (bandMaxRatio >= 0.30 && bandMaxRatio > bestRatio) {
        bestRatio = bandMaxRatio;
        bestBand = band;
      }
    }
    if (bestBand) bestBand.push(entry);
    else bands.push([entry]);
  }

  bands.sort((a, b) => {
    const topA = Math.min(...a.map(e => e.y));
    const topB = Math.min(...b.map(e => e.y));
    if (topA !== topB) return topA - topB;
    return Math.min(...a.map(e => e.cy)) - Math.min(...b.map(e => e.cy));
  });

  const ordered: T[] = [];
  for (const band of bands) {
    const n = band.length;
    const parent = Array.from({ length: n }, (_, i) => i);
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    const union = (a: number, b: number) => {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    };

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const overlapX = Math.min(band[i].right, band[j].right) - Math.max(band[i].x, band[j].x);
        if (overlapX > 0 && overlapX / Math.min(band[i].w, band[j].w) >= 0.40) {
          union(i, j);
        }
      }
    }

    const columnMap = new Map<number, SortEntry<T>[]>();
    for (let i = 0; i < n; i++) {
      const root = find(i);
      const col = columnMap.get(root);
      if (col) col.push(band[i]);
      else columnMap.set(root, [band[i]]);
    }

    const columns = [...columnMap.values()];
    for (const col of columns) {
      col.sort((a, b) => a.cy - b.cy || a.y - b.y || b.cx - a.cx || a.index - b.index);
    }
    columns.sort((colA, colB) => {
      const meanCxA = colA.reduce((sum, e) => sum + e.cx, 0) / colA.length;
      const meanCxB = colB.reduce((sum, e) => sum + e.cx, 0) / colB.length;
      if (meanCxB !== meanCxA) return meanCxB - meanCxA;
      return Math.min(...colA.map(e => e.cy)) - Math.min(...colB.map(e => e.cy));
    });

    for (const col of columns) {
      for (const entry of col) ordered.push(entry.item);
    }
  }

  return ordered;
}

/**
 * Smart split for Quick Split (`S`):
 * Splits multiline text evenly across lines, or splits multi-sentence text near midpoint,
 * or leaves single-sentence text in Box 1 with empty string in Box 2.
 */
export function smartSplitText(text: string): [string, string] {
  const trimmed = (text || '').trim();
  if (!trimmed) return ['', ''];
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const mid = Math.ceil(lines.length / 2);
    return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
  }
  const sentences = trimmed.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  if (sentences.length >= 2) {
    const total = sentences.reduce((sum, s) => sum + s.length, 0);
    let acc = 0;
    let splitAt = 1;
    let bestDiff = Infinity;
    for (let i = 1; i < sentences.length; i++) {
      acc += sentences[i - 1].length;
      const diff = Math.abs(acc - (total - acc));
      if (diff < bestDiff) {
        bestDiff = diff;
        splitAt = i;
      }
    }
    return [sentences.slice(0, splitAt).join(' '), sentences.slice(splitAt).join(' ')];
  }
  return [trimmed, ''];
}
