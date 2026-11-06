import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function load(path) {
  const source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async name => {
    // Chrome/capability tests intentionally exclude the native canvas renderer.
    // Geometry has separate pure tests; WebView2 checks cover real rendering.
    const value = name === './CanvasWorkspace' ? { LoupePreview: () => null, MiniMap: () => null, ViewportReadout: () => null } : await import(name);
    return new vm.SyntheticModule(Object.keys(value), function () { for (const key of Object.keys(value)) this.setExport(key, value[key]); }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
const keys = await load('../src/ui/shortcuts.ts');
const ui = await load('../src/components/StudioShell.tsx');
const event = (key, options = {}) => ({ key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...options });

test('Scan and Save shortcuts cannot collide', () => {
  assert.equal(keys.resolveStudioShortcut(event('s', { ctrlKey: true })), 'save');
  assert.equal(keys.resolveStudioShortcut(event('S', { ctrlKey: true, shiftKey: true })), 'scan');
  assert.equal(keys.resolveStudioShortcut(event('z', { metaKey: true, shiftKey: true })), 'redo');
});
test('IME, input, menus and modal scopes block editor shortcuts', () => {
  assert.equal(keys.blocksStudioShortcuts(null, true), true);
  for (const scope of ['input', 'textarea', 'select', '[role="dialog"]', '[role="menu"]', '[contenteditable="true"]']) {
    assert.equal(keys.blocksStudioShortcuts({ closest: selector => selector.includes(scope) ? {} : null }, false), true);
  }
  assert.equal(keys.blocksStudioShortcuts({ closest: () => null }, false), false);
  assert.equal(keys.resolveStudioShortcut(event('b', { isComposing: true })), undefined);
  assert.equal(keys.resolveStudioShortcut(event('m', { altKey: true })), undefined);
});
test('unsupported commands are never silently mapped to a different tool', () => {
  for (const key of ['p', 's', 'i', 'l', 'a', 'd', 'PageDown', 'Tab']) assert.equal(keys.resolveStudioShortcut(event(key)), undefined);
  assert.equal(keys.resolveStudioShortcut(event('f')), 'view');
  assert.equal(keys.resolveStudioShortcut(event('t')), 'text');
  assert.equal(keys.resolveStudioShortcut(event(' ')), 'pan-hold');
});
test('empty project keeps manual and mask tools disabled', () => {
  const html = renderToStaticMarkup(React.createElement(ui.ToolRail, { tool: 'select', ready: false, hasPreview: false, busy: false, onTool() {}, onZoom() {} }));
  const buttons = html.match(/<button\b[\s\S]*?<\/button>/g);
  const manual = buttons.find(button => button.includes('Select text area manually'));
  const mask = buttons.find(button => button.includes('Correct prepared mask'));
  assert.match(manual, /disabled=""/);
  assert.match(mask, /disabled=""/);
  assert.equal(buttons.length, 6);
  assert.doesNotMatch(html, /PLANNED|Clone Stamp|Vector Pen/);
});
test('Script Matrix never fabricates OCR or an executable translation', () => {
  const document = { bubbles: [{ id: 'fixture-id', rect: [0, 0, 50, 50], review: 'Needs Review', cleaning: 'Needs Review', kind: 'Unclassified', source: 'Shima V1', confidence: null }], textRegions: [] };
  const html = renderToStaticMarkup(React.createElement(ui.InspectorDock, { document, selected: new Set(), onSelect() {}, tab: 'Script', onTab() {}, onCollapse() {}, layerControls: null, children: null }));
  assert.match(html, /Properties/);
  assert.doesNotMatch(html, /Script Matrix|No OCR proposal|No confidence|Translation is not available/);
  assert.doesNotMatch(html, /93\.6%|CUDA Active|8GB/);
});
test('Saved only reflects a verified persisted path, not merely clean state', () => {
  const props = { document: null, busy: false, step: 1, onStep() {}, onOpen() {}, onSave() {}, onExport() {}, onUndo() {}, onRedo() {}, onSettings() {}, onScan() {}, onPreview() {}, onClean() {}, canScan: false, canPreview: false, canClean: false, onToggleLeft() {}, onToggleRight() {}, onPreset() {} };
  const doc = { sourceName: 'fixture.png', dirty: false, savedPath: null };
  const render = document => renderToStaticMarkup(React.createElement(ui.EngineStatusBar, { ...props, document, connected:true, selected:0, controller:{}, job:null, onCancel(){} }));
  assert.match(render(doc), />Unmodified<\/span>/);
  assert.match(render({ ...doc, savedPath: 'verified.mangaclean' }), />Saved<\/span>/);
  assert.match(render({ ...doc, savedPath: 'verified.mangaclean', dirty: true }), />Unsaved<\/span>/);
});
