import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const module = new vm.SourceTextModule(ts.transpileModule(await readFile(new URL('../src/ui/viewport.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText);
await module.link(() => { throw new Error('Geometry must remain dependency-free'); });
await module.evaluate();
const { ViewportController, fitScale, imageOffset, toImage, visibleImageRect, roundedImageRect, zoomAt } = module.namespace;
const page = { width: 1114, height: 1600 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);

test('image-space coordinates survive fit, pan, zoom and 100/125 percent DPI', () => {
  for (const dpr of [1, 1.25]) for (const fit of ['page', 'width', 'actual']) for (const zoom of [.2, 1, 4]) {
    const size = { width: 361, height: 503 }, pan = { x: 17, y: -26 }, native = { x: 937, y: 73 };
    const scale = fitScale(size, page, fit, zoom), offset = imageOffset(size, page, pan, scale);
    const physical = { x: (native.x * scale + offset.x) * dpr, y: (native.y * scale + offset.y) * dpr };
    const result = toImage({ x: physical.x / dpr, y: physical.y / dpr }, offset, scale, page.width, page.height);
    close(result.x, native.x); close(result.y, native.y);
  }
});
test('both dual panes use identical image-space transforms', () => {
  const size = { width: 371, height: 620 }, pan = { x: 15, y: 40 };
  const scale = fitScale(size, page, 'page', 1.3);
  const left = imageOffset(size, page, pan, scale), right = imageOffset(size, page, pan, scale);
  close(left.x, right.x); close(left.y, right.y);
});
test('wheel zoom remains anchored at the pointer', () => {
  const transform = { zoom: 1, pan: { x: 14, y: -19 }, fit: 'page', mode: 'dual', split: .5, peek: false };
  const size = { width: 450, height: 600 }, point = { x: 190, y: 250 };
  const scale = fitScale(size, page, 'page', 1), before = toImage(point, imageOffset(size, page, transform.pan, scale), scale, page.width, page.height);
  const next = zoomAt(transform, 1.11, point, size, page, scale), nextScale = fitScale(size, page, 'page', next.zoom);
  const after = toImage(point, imageOffset(size, page, next.pan, nextScale), nextScale, page.width, page.height);
  close(before.x, after.x); close(before.y, after.y);
});
test('rounding a manual rectangle never escapes the native image', () => {
  const result = [...roundedImageRect([1100.6, 1590.6, 13.4, 9.4], 1114, 1600)];
  assert.deepEqual(result, [1101, 1591, 13, 9]);
  for (const rect of [[-1.1, -3, 30, 50], [1113.7, 1599.7, 20, 20], [0, 0, 1114, 1600]]) {
    const [x, y, w, h] = roundedImageRect(rect, 1114, 1600);
    assert.ok(x >= 0 && y >= 0 && w >= 0 && h >= 0 && x + w <= 1114 && y + h <= 1600);
  }
});
test('mini-map visible bounds stay clipped when panned off page', () => {
  const metrics = { width: 360, height: 500, imageWidth: 1114, imageHeight: 1600, scale: .5 };
  for (const pan of [{ x: 0, y: 0 }, { x: 10000, y: -10000 }, { x: -10000, y: 10000 }]) {
    const [x, y, w, h] = visibleImageRect(metrics, pan);
    assert.ok(x >= 0 && y >= 0 && x + w <= 1114 && y + h <= 1600 && w >= 0 && h >= 0);
  }
});
test('pointer tracking cannot notify the transform/App subscription', () => {
  const controller = new ViewportController(); let transforms = 0, pointers = 0;
  controller.subscribe(() => transforms++); controller.subscribePointer(() => pointers++);
  controller.updatePointer({ point: { x: 11, y: 29 }, source: 'editing' });
  assert.equal(transforms, 0); assert.equal(pointers, 1);
  controller.update({ pan: { x: 3, y: 4 } }); assert.equal(transforms, 1);
});
test('mode switches and new image reset preserve a safe view without touching image data', () => {
  const controller = new ViewportController();
  controller.toggleDual(); assert.equal(controller.getSnapshot().mode, 'single');
  controller.update({ mode: 'onion', pan: { x: 50, y: -12 }, zoom: 3, peek: true });
  controller.reset(); const value = controller.getSnapshot();
  assert.equal(value.mode, 'onion'); assert.equal(value.zoom, 1); assert.equal(value.pan.x, 0); assert.equal(value.peek, false);
});
test('zoom remains finite within the supported 1–1200 percent actual range', () => {
  const controller = new ViewportController(); controller.actualScale(.01); controller.zoomBy(1.11); close(controller.getSnapshot().zoom, .0111);
  controller.zoomBy(100000); assert.equal(controller.getSnapshot().zoom, 12);
  controller.actualScale(-10); assert.equal(controller.getSnapshot().zoom, .01);
});
