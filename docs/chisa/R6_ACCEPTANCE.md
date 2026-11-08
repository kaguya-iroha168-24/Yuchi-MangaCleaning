# MangaClean Atelier R6 — Chisa continuation

**Status: PARTIAL.** Branch `feature/chisa-editor-enhancements`. Stable `main` and the Demo Ready executable matched the checkpoint. The working tree retains earlier R5 and navigation changes alongside R6 changes.

## Delivered

- Healing creates a blank, page-bound mask inside a selected bubble or an explicit native-pixel rectangle. The rectangle path supports SFX outside detected bubbles. Strokes clip to that area. Brush size, an Editing-canvas cursor, add/erase, an explicit Apply, and Undo/Redo reuse the existing preview and restoration services. The result saves through the existing v3 working image. The box variant leaves `manual_mask` and bubble data unchanged.
- Manually drawn bubble regions have stable IDs, use the existing region and mask model, survive v3 Save/Reload, and remain present after the first scan. Deleting an uncleaned manual region detaches its linked source and Dialogue without deleting text or changing artwork. Cleaning must be undone before deleting a region with an attached applied mask. Editable vector Bubble Shape controls were removed from this release's scope.
- Properties groups Original OCR/source and editable Translation together. Typography provides five local size presets, existing family, weight, case, alignment, color, Auto Fit, Copy/Paste Style and geometry controls. Double-clicking a Dialogue opens an editor in the canvas. Ctrl+Enter applies and Escape cancels. The Page navigator uses compact thumbnail rows, active position/count, filenames and existing selection checkboxes.
- Import and direct cleaning show indeterminate progress while work runs. Scan/OCR, automatic cleaning and translation reuse actual job progress and Cancel. An in-flight Gemini request can finish or time out after cancellation. Its result is discarded if the page had not committed. Completed pages are kept.
- Settings → Translate accepts a Gemini model, a masked API key and optional translation style. The key exists in backend memory for the app session. Test connection sends a fixed greeting. Explicit translation sends only applicable source strings and integer row IDs to Google Gemini. OCR or manual source is matched to its source region. Existing nonempty Indonesian Dialogue is preserved. The result stays editable and persists in v3. See [Google's Gemini API reference](https://ai.google.dev/api) for transport and API-key conventions.

## Verification

| Check | Result |
|---|---|
| Backend regression | 14 passed across Gemini, manual bubble/Healing, scan workflow and automatic queue. Gemini tests cover ID ordering, invalid output, existing Dialogue preservation, page-by-page commit, cancellation and restoring the original page. Network responses are mocked. |
| Frontend and build | Seven focused checks passed across Inspector, Healing, size presets, Copy/Paste Style, font stepper and empty App startup. TypeScript and the Windows release build passed. |
| Bubble detection | Shima V1 in the packaged R6 backend, on a fresh copy of `page_009.png`, found 12 candidates in 104.36 s on CPU. The working artwork matched the source. This was an API smoke, independent of the WebView. |
| Healing save, reload and export | On the 1114 × 1600 R5 fixture, one radius-6 dab selected 113 mask pixels and changed 92. Zero pixels changed outside the mask. The codec reopened the result. The PNG matched the composite and JPEG bytes matched the same composite encoded at quality 95. Text overlays were omitted from the copy for this isolated Healing export check. |
| RAM | Isolated backend process-tree private resident memory was 69.47 MiB at editing baseline, 78.16 MiB peak during preview and 124.89 MiB peak during Apply, a +55.42 MiB peak delta for this operation. Larger pages, repeated strokes and full WebView editing were not measured by this probe. |
| Native startup and close | Final R6 opened and rendered the empty workspace at a 1440 × 900 viewport, DPR 1.25. The authenticated backend was ready after 19.15 s. Native idle private resident memory was 164.50 MiB median and 178.96 MiB peak during the startup/idle run. Normal main-window close exited 0 with no owned process survivors. Desktop input failed to initialize with Windows error 3, so interaction, full layout/DPI and comparable navigation timing remain partial. |
| Protected files | All 25 entries matched across 24 unique paths, including the protected model/resources and the known-good release. PageFrames, PageNavigation and disk-backed chapter implementation matched their checkpoint hashes. |

Native proof, test release, backend detection receipt, Healing pixels/memory report and working-tree diff are in `E:/BagassZx/Yuchi-Diagnostics/chisa-enhancements-20261107`. Launch `native-r6-final/MangaClean.exe` from its staged directory. `STAGED_RELEASE-r6-final.json` records the exact executable and backend hashes. `session-r6-final/native-r6-final-startup.png` shows the observed window. The established R5 acceptance remains documented separately.

## Source paths changed in R6

`backend/main.py`, `backend/translation.py`, `backend/workflow.py`, `src/App.tsx`, `src/api.ts`, `src/components/CanvasWorkspace.tsx`, `src/components/ChapterNavigator.tsx`, `src/components/PreferencesDialog.tsx`, `src/components/StudioShell.tsx`, `src/components/Typography.tsx`, `src/design/chapter.css`, `src/design/sumi.css`, `src/ui/processing.ts`, `src/ui/sourceText.ts`.

Focused tests added or extended in `tests/test_manual_bubble.py`, `tests/test_gemini_translation.py`, `tests/studio_ui.test.mjs`, `tests/chisa_typography_controls.test.mjs` and `tests/copy_style.test.mjs`.

## Remaining boundaries

- Real Google Gemini requests require a key entered in Settings. No live connection or quota was verified in this session.
- Italic, stroke, line/letter spacing, rotation, vertical offset and automatic width need a persisted renderer extension. Persistent layer locking/order and image adjustments need the same format boundary. The [v4 proposal](DATA_MODEL_PROPOSAL.md) describes separate saves and rollback through the original v3 file. Approval is pending.
- The [inventory](FEATURE_INVENTORY.md) lists the exact state of requested controls. A fresh native pass through Settings, Properties, Healing and export on the same staged build is still needed.
