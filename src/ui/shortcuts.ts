export const studioShortcuts = {
  'Ctrl+O': 'open', 'Ctrl+S': 'save', 'Ctrl+Shift+S': 'scan',
  'Ctrl+Z': 'undo', 'Ctrl+Shift+Z': 'redo', 'Ctrl+E': 'export', 'Ctrl+,': 'settings',
  V: 'select', B: 'manual', T: 'text', H: 'pan', M: 'mask', Z: 'zoom', F: 'view', Space: 'pan-hold',
} as const;
export type StudioShortcut = typeof studioShortcuts[keyof typeof studioShortcuts];
type KeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'isComposing'>;

export function blocksStudioShortcuts(target: EventTarget | null, composing: boolean): boolean {
  if (composing) return true;
  return Boolean((target as Element | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="menu"]'));
}

export function resolveStudioShortcut(event: KeyEvent): StudioShortcut | undefined {
  if (event.isComposing || event.altKey) return;
  const key = event.code === 'Space' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const combination = `${event.ctrlKey || event.metaKey ? 'Ctrl+' : ''}${event.shiftKey ? 'Shift+' : ''}${key}`;
  return studioShortcuts[combination as keyof typeof studioShortcuts];
}
