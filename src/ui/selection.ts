/** Exactly one manipulated object; passive bubble outlines remain independent. */
export function selectionLayer(input: { editing: boolean; mask: boolean; dialogue: string | null; text: string | null; bubble: string | null }): 'none' | 'dialogue' | 'source' | 'bubble' {
  if (!input.editing || input.mask) return 'none';
  if (input.dialogue) return 'dialogue';
  if (input.text && !input.bubble) return 'source';
  return input.bubble ? 'bubble' : 'none';
}
