import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function loadTsGraph(entryRelativePath) {
  const cache = new Map();
  const baseUrl = new URL('../src/ui/', import.meta.url);

  async function compile(url) {
    const key = url.href;
    if (cache.has(key)) return cache.get(key);
    const source = await readFile(url, 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    const mod = new vm.SourceTextModule(code, { identifier: key });
    cache.set(key, mod);
    await mod.link(async specifier => {
      if (specifier === '../api') {
        const stub = new vm.SourceTextModule('', { identifier: 'api-stub' });
        await stub.link(() => { throw new Error('Unexpected import in api-stub'); });
        return stub;
      }
      const nextUrl = new URL(specifier.endsWith('.ts') ? specifier : `${specifier}.ts`, url);
      return compile(nextUrl);
    });
    await mod.evaluate();
    return mod;
  }

  return compile(new URL(entryRelativePath, baseUrl));
}

const mangaUtilsMod = await loadTsGraph('./mangaUtils.ts');
const {
  sortBoxesMangaRTL,
  smartSplitText,
  computeAutoFitFontSize,
  evaluateDialogueOverflow,
  manualFontSizePatch,
  autoFitFontSizePatch,
} = mangaUtilsMod.namespace;

test('sortBoxesMangaRTL orders bands top-to-bottom and stacked columns right-to-left', () => {
  const boxes = [
    { id: 'l_single', rect: [30, 35, 110, 120] },
    { id: 'b_left', rect: [50, 270, 120, 90] },
    { id: 'm_bot', rect: [225, 95, 115, 70] },
    { id: 'r_single', rect: [420, 25, 110, 130] },
    { id: 'b_right', rect: [390, 260, 130, 95] },
    { id: 'm_top', rect: [220, 20, 120, 65] },
  ];
  const sorted = sortBoxesMangaRTL(boxes, b => b.rect);
  assert.deepEqual(
    sorted.map(b => b.id),
    ['r_single', 'm_top', 'm_bot', 'l_single', 'b_right', 'b_left'],
  );
});

test('computeAutoFitFontSize picks max fitting size in 11-32px and flags overflow cleanly', () => {
  const measure = (text, _font, fontSize) => text.length * fontSize * 0.55;

  const shortFit = computeAutoFitFontSize({
    text: 'Hi!',
    boxWidth: 160,
    boxHeight: 160,
    measureTextWidth: measure,
  });
  assert.equal(shortFit.fontSize, 32);
  assert.equal(shortFit.isOverflowing, false);

  const shrunkFit = computeAutoFitFontSize({
    text: 'This is a moderately long manga speech line that must shrink to fit nicely.',
    boxWidth: 130,
    boxHeight: 120,
    measureTextWidth: measure,
  });
  assert.ok(shrunkFit.fontSize >= 11 && shrunkFit.fontSize < 32, `unexpected fontSize ${shrunkFit.fontSize}`);
  assert.equal(shrunkFit.isOverflowing, false);

  const heightOverflow = computeAutoFitFontSize({
    text: 'Line one\nLine two\nLine three\nLine four\nLine five\nLine six\nLine seven',
    boxWidth: 110,
    boxHeight: 75,
    measureTextWidth: measure,
  });
  assert.equal(heightOverflow.fontSize, 11);
  assert.equal(heightOverflow.isOverflowing, true);

  const unbrokenWordOverflow = computeAutoFitFontSize({
    text: 'SUPERCALIFRAGILISTICEXPIALIDOCIOUS',
    boxWidth: 120,
    boxHeight: 120,
    measureTextWidth: measure,
  });
  assert.equal(unbrokenWordOverflow.fontSize, 11);
  assert.equal(unbrokenWordOverflow.isOverflowing, true);
});

test('evaluateDialogueOverflow checks manual locked size when auto_fit is false', () => {
  const measure = (text, _font, fontSize) => text.length * fontSize * 0.55;
  const dlg = {
    text: 'Enough words to overflow at manual 28px size inside this compact bubble.',
    width: 120,
    height: 90,
    family: 'Komika Text Kaps',
    weight: 700,
    size: 28,
    auto_fit: false,
    style: { italic: false, line_height: 1.15, letter_spacing: 0 },
  };
  const manualRes = evaluateDialogueOverflow(dlg, 120, 90, measure);
  assert.equal(manualRes.fontSize, 28);
  assert.equal(manualRes.isOverflowing, true);

  const autoRes = evaluateDialogueOverflow({ ...dlg, auto_fit: true }, 120, 90, measure);
  assert.ok(autoRes.fontSize < 28);
  assert.equal(autoRes.isOverflowing, false);
});

test('smartSplitText and font size patch helpers behave deterministically', () => {
  assert.deepEqual(
    smartSplitText('Line 1\nLine 2\nLine 3'),
    ['Line 1\nLine 2', 'Line 3'],
  );
  assert.deepEqual(
    smartSplitText('Wait! Where are you going? Stop right there.'),
    ['Wait! Where are you going?', 'Stop right there.'],
  );
  assert.deepEqual(smartSplitText('Single clause'), ['Single clause', '']);

  assert.deepEqual(manualFontSizePatch({ minimum_size: 16 }, 12), { size: 12, minimum_size: 12, auto_fit: false });
  assert.deepEqual(autoFitFontSizePatch({ minimum_size: 10 }, 18), { size: 18, minimum_size: 10, auto_fit: true });
});
