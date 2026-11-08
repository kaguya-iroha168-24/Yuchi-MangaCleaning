/** Exactly one manipulated object; passive bubble outlines remain independent. */
export function bubbleAt<T extends { rect: number[]; excluded?: boolean }>(bubbles: readonly T[], point: { x: number; y: number }): T | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  let hit: T | null = null;
  for (const bubble of bubbles) {
    const [x, y, width, height] = bubble.rect;
    if (bubble.excluded || width <= 0 || height <= 0 || point.x < x || point.y < y || point.x >= x + width || point.y >= y + height) continue;
    // Stable smallest-area priority for nested ROIs, without splitting logical bubbles.
    if (!hit || width * height < hit.rect[2] * hit.rect[3]) hit = bubble;
  }
  return hit;
}

export function selectionLayer(input: { editing: boolean; mask: boolean; dialogue: string | null; text: string | null; bubble: string | null }): 'none' | 'dialogue' | 'source' | 'bubble' {
  if (!input.editing || input.mask) return 'none';
  if (input.dialogue) return 'dialogue';
  if (input.text && !input.bubble) return 'source';
  return input.bubble ? 'bubble' : 'none';
}
