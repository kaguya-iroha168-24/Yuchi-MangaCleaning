# Chisa editor checkpoint — 7 November 2026

The [R6 continuation and verification](R6_ACCEPTANCE.md) records the work after this R5 checkpoint.

Branch `feature/chisa-editor-enhancements`, HEAD `ece3dc84c271288d55976d16a6dcd54307bddc3c`. The separate R4/R5 test releases preserve the Demo Ready executable. Previous navigation work is outside this diff.

| Area | Status | Evidence |
|---|---|---|
| Linked selection | PASS | Native Bubble 07 used the same ID, box and label in both canvases. Editing showed eight handles and Original showed none. The user verified alignment during zoom and pan. |
| Typography and Properties | PASS for tested controls | Properties/Layers, selected-Dialogue color eyedropper, AA/Aa/aa, position nudge and centering use existing history and persistence. The tested narrow AA example fit at 10 px with its local Auto Fit floor lowered from 12 px. The requested size stayed at 32 px. |
| R4 persistence and export | PASS | Native 12-page Save/Reload and 1114 × 1600 PNG/JPEG. PNG matched the renderer, and JPEG matched the same renderer encoded at quality 95, both with zero differing decoded pixels. |
| ROI shrink and regrow | PASS in fixture regression | Repeated crops used the prior crop as input and discarded 2,152 text-mask pixels. Each resize now clips the same source-coordinate basis. The real copied fixture preserved all 7,560 text-mask pixels and round-tripped the basis with the existing codec. |
| R5 Bubble 03 preview and cleaning | PASS for observed operations | Screenshot shows all six lines covered, including “SEEN BEFORE.” The saved file confirms an 8,632-pixel applied mask, 4,673 changed pixels and zero changes outside that mask. Source pixels and raw OCR matched the fixture. The cleaning check flagged two possible residual ink pixels, neither near the mask edge. |
| R5 Undo/Redo, Save and Normal Close | PASS for observed operations | Native Undo reverted cleaning and Redo restored it. The saved file was reopened by the codec. Normal Close returned 0 and left no owned processes. |
| R5 native resize/reopen | PARTIAL | The native capture used the complete ROI. The shrink/regrow sequence and saved geometry-basis reload are covered by the fixture regression. No native reopen of this R5 saved file was captured. |
| RAM and display | PARTIAL | R5 process-tree private resident memory was 176.6 MiB median during the idle sampling window and 475.1 MiB peak for the session. The native screenshot recorded DPR 1.25 and a 1440 × 900 viewport. No comparable before/after RAM run, full resolution matrix or sustained FPS result for this slice. |
| Remaining Chisa features | PARTIAL / BLOCKED | The original feature inventory remains in scope. Advanced typography, editable vector shapes, persistent layer order/locks and image adjustments await the composition-model decision. Existing mask correction remains available. Translation execution needs an approved provider. Exact reference preset defaults are still unavailable. |

## Verification and files

- Focused frontend suite 62 passed. Backend suite 27 passed, plus one dedicated case/Auto Fit history test. Typecheck and separate native build succeeded. The R5 executable is byte-identical to R4 and loads the patched geometry adapter from its own runtime.
- All 25 protected hash entries matched across 24 unique paths. The stable release, original chapter, navigation changes, existing project codec, renderer and AI workflow source hashes matched the checkpoint.
- Source paths changed in this slice: `mangaclean/services/bubble_geometry.py`, `src/ui/selection.ts`, `src/ui/typography.ts`, `src/components/CanvasWorkspace.tsx`, `src/components/TextRegionOverlay.tsx`, `src/components/Typography.tsx`, `src/components/StudioShell.tsx` and `src/design/sumi.css`. Seven test paths are listed in the applied diff.
- The mask basis uses bounded existing bubble provenance. Files saved by older builds after a lossy crop may need an intact copy for recovery. The prior discarded pixels are unavailable in those files.

Artifacts in `E:/BagassZx/Yuchi-Diagnostics/chisa-features-20261107` include `APPLIED_CHANGES.diff`, `ROI_MASK_LOSS_BEFORE.json`, `ROI_MASK_LOSS_AFTER.json`, `NATIVE_FILE_PROOF-r4.json`, `NATIVE_SAVED_MASK_PROOF-r5.json`, `PROTECTED_INTEGRITY.json`, native screenshots in `session-r4` and `session-r5`, and the R5 process-tree profile in `session-r5/release-chisa-r5.json`.

See [the feature inventory](FEATURE_INVENTORY.md) for remaining controls and [the unapplied data-model proposal](DATA_MODEL_PROPOSAL.md) for the compatibility boundary.
