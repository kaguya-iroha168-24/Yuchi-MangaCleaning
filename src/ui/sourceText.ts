import type { TextRegion } from '../api';
export function sourceValue(region: TextRegion | null | undefined): string {
  if (!region) return '';
  return region.sourceEdited || region.text ? region.text : region.ocr?.edited_text ?? '';
}
