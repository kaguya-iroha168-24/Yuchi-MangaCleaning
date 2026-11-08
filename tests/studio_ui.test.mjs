import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

async function load(path, modules = {}) {
  const source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const context = vm.createContext({});
  const module = new vm.SourceTextModule(source, { context });
  await module.link(async name => {
    // Chrome/capability tests intentionally exclude the native canvas renderer.
    // Geometry has separate pure tests; WebView2 checks cover real rendering.
    const value = modules[name] ?? (name === './CanvasWorkspace' ? { LoupePreview: () => null, MiniMap: () => null, ViewportReadout: () => null } : await import(name));
    return new vm.SyntheticModule(Object.keys(value), function () { for (const key of Object.keys(value)) this.setExport(key, value[key]); }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
const keys = await load('../src/ui/shortcuts.ts');
const ui = await load('../src/components/StudioShell.tsx');
const event = (key, options = {}) => ({ key, code: key === ' ' ? 'Space' : `Key${key.toUpperCase()}`, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, isComposing: false, ...options });

test('Properties and Layers are real inspector tabs, preserving one mounted editor and selected-layer content',()=>{
  const props={document:null,selected:new Set(),onSelect(){},onTab(){},onCollapse(){},children:React.createElement('textarea',{'aria-label':'Dialogue editor'}),layerControls:React.createElement('p',null,'Actual layer controls')};
  for(const tab of ['Script','Style','Layers']){
    const html=renderToStaticMarkup(React.createElement(ui.InspectorDock,{...props,tab}));
    assert.match(html,/role="tablist"/);assert.match(html,/role="tab"[^>]*>Properties/);assert.match(html,/role="tab"[^>]*>Layers/);
    assert.equal((html.match(/aria-label="Dialogue editor"/g)||[]).length,1);
    assert.match(html,new RegExp('id="inspector-'+(tab==='Layers'?'layers':'properties')+'"[^>]*role="tabpanel"[^>]*>(?!hidden)'));
    assert.doesNotMatch(html,/>Image</,'unsupported image adjustments must not masquerade as implemented controls');
  }
});

test('Healing opens the repair controls while Properties is hidden', () => {
  const html = renderToStaticMarkup(React.createElement(ui.InspectorDock, {
    tab: 'Healing', onTab() {}, onCollapse() {},
    healingControls: React.createElement('button', null, 'Start empty mask'),
  }));
  assert.match(html, /id="tab-healing" role="tab" aria-selected="true"/);
  assert.match(html, /id="inspector-healing" role="tabpanel" aria-labelledby="tab-healing"><button>Start empty mask/);
  assert.match(html, /id="inspector-properties"[^>]* hidden=""/);
});

test('Scan and Save shortcuts cannot collide', () => {
  assert.equal(keys.resolveStudioShortcut(event('s', { ctrlKey: true })), 'save');
  assert.equal(keys.resolveStudioShortcut(event('S', { ctrlKey: true, shiftKey: true })), 'scan');
  assert.equal(keys.resolveStudioShortcut(event('z', { metaKey: true, shiftKey: true })), 'redo');
});
test('Detect and Clean and one-click Translate share All Pages scope', () => {
  const scopes = [];
  const props = { document: { sourceName: 'page_001.png' }, canScan: true, onDetect() {}, onToggleAll() {}, onProcess() {}, onTranslate: scope => scopes.push(scope) };
  const render = (pageCount, detectAll = false) => renderToStaticMarkup(React.createElement(ui.StudioHeader, { ...props, pageCount, detectAll }));
  assert.match(render(14), /title="Detect &amp; Clean Bubbles on the current page \(Ctrl\+Shift\+S\)"/);
  assert.match(render(14, true), /title="Detect &amp; Clean Bubbles on all 14 pages/);
  assert.doesNotMatch(render(14), /Process Automatically/);
  assert.match(render(14, true), /<button aria-pressed="true"[^>]*>All Pages<\/button>/);
  assert.match(render(1), /<button disabled="" aria-pressed="false"[^>]*>All Pages<\/button>/);
  assert.doesNotMatch(render(14), /Detect &amp; Overlay/);
  assert.match(render(14), /aria-label="Translate the current page"/);
  assert.match(render(14, true), /aria-label="Translate all 14 pages"/);
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  for (const [pageCount, detectAll] of [[14, false], [14, true], [1, true]]) {
    const translation = elements(ui.StudioHeader({ ...props, pageCount, detectAll })).find(node => node.props.label?.startsWith('Translate'));
    translation.props.onClick();
  }
  assert.deepEqual(scopes, ['page', 'chapter', 'page']);
  assert.doesNotMatch(render(14), /Detect &amp; Read Text|OCR and translation/);
});
test('the compact header exposes folder import and page controls with correct edge states', () => {
  const html = renderToStaticMarkup(React.createElement(ui.StudioHeader, {
    document: {sourceName:'page_001.png'}, onOpenFolder() {}, pages: {number:1, next() {}}, pageCount:14,
  }));
  assert.match(html, /aria-label="Open folder as chapter"/);
  assert.match(html, /aria-label="Previous page" disabled=""/);
  assert.match(html, /aria-label="Current page">1\/14/);
  assert.doesNotMatch(html, /aria-label="Next page" disabled=""/);
  assert.ok(html.indexOf('Bubble detection') < html.indexOf('Page navigation'));
});
test('Settings Editing can switch the current page between Overlay and Clean', async () => {
  const { PreferencesDialog } = await load('../src/components/PreferencesDialog.tsx', { react: { ...React, useState: () => ['Editing', () => {}] } });
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  const modes = [];
  const buttons = elements(PreferencesDialog({ textMode: 'clean', onTextMode: mode => modes.push(mode) })).filter(node => node.type === 'button');
  const overlay = buttons.find(node => node.props.children === 'Overlay');
  const clean = buttons.find(node => node.props.children === 'Clean');
  assert.equal(overlay.props['aria-pressed'], false);
  assert.equal(clean.props['aria-pressed'], true);
  overlay.props.onClick(); clean.props.onClick();
  assert.deepEqual(modes, ['overlay','clean']);
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
  const html = renderToStaticMarkup(React.createElement(ui.ToolRail, { tool: 'select', ready: false, hasPreview: false, busy: false, canPreview: false, onTool() {}, onPreview() {}, onHealing() {} }));
  const buttons = html.match(/<button\b[\s\S]*?<\/button>/g);
  const manual = buttons.find(button => button.includes('Select text area manually'));
  const mask = buttons.find(button => button.includes('Correct prepared mask'));
  assert.match(manual, /disabled=""/);
  assert.match(mask, /disabled=""/);
  assert.match(buttons.find(button => button.includes('Preview Mask')), /disabled=""/);
  assert.equal(buttons.length, 7);
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
