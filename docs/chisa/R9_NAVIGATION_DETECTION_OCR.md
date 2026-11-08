# Chisa R9 — page return, detection controls and OCR diagnosis

Work stayed on `feature/chisa-editor-enhancements`. The R8 and stable releases remain separate from the R9 test build.

## Page return and detection

- Baseline on a copied chapter, 12 page activations alternating 1 and 2. Median backend activation was 102.05 ms. Separate Original and Editing image requests took medians of 42.60 and 40.91 ms. These request measurements exclude WebView decode and presentation, and the app can request both images concurrently.
- Navigation still flushes committed edits and verifies the active page with the backend. A return to the previous page can reuse its decoded Original and Editing pair after matching the chapter, page and revision. The extra pair is bounded to 8 million combined pixels. Opening a project or reconnecting clears it. Edit, revision mismatch, cancellation and stale load paths remain covered by tests.
- **Detect Bubbles** runs the detector. With **All Pages** off it scans the active page. Turning **All Pages** on changes the scope to the chapter, and the next click on **Detect Bubbles** starts that scan. Both scopes reuse existing valid detections and create source regions without OCR or cleaning. **Process** and **Detect & Read Text** retain the existing OCR workflows.
- **Settings → Editing → Text treatment** holds the Clean and Overlay controls. Changing mode takes effect on the current page. The next automatic Process run uses the active page's mode across its chosen scope. The existing optional v4 fields persist the mode. v3 files remain readable.

## OCR import and file handoff

| Fresh module probe | Seconds |
| --- | ---: |
| PyTorch | 2.263 |
| PIL Image | 0.015 |
| Transformers ViTImageProcessor, including transitive dependencies | 3.355 |
| AutoTokenizer | 0.205 |
| StoppingCriteria | <0.001 |
| Manga OCR model and post-processing import | 0.217 |

The probe ran in a fresh interpreter with the OS cache uncontrolled. A traced request launched by the real worker path took about 22.6 s to reach model integrity verification after starting imports. The trace sampled file lookups in `torch._dynamo.trace_rules`, reached through TorchVision and Transformers. A separate uninstrumented attempt hit the 300 s request timeout at runtime import. The earlier 57.16 s result is consistent with variable initialization, and the probes do not identify the full cause of that particular timing. The traced request reached a separate diagnostic timeout while hashing the model. Neither the load path nor the model, preprocessing, generation or integrity checks were changed to claim a cold-start improvement.

A separate OCR handoff failure was reproduced at `result.read_text`. Windows could temporarily refuse a read of an already-published result. Reading again within the existing cancellation and timeout window completed 24/24 runs, compared with 7/24 before the fix. The same worker and crop are retained across the retry.

## Focused verification

- Test coverage includes a 14-page queue, active-page scope, page-switch undo persistence, v3/v4 and both treatments, worker cancellation and locked result retry.
- A real Shima V1 `cuda:0` run used 14 copied manga pages, comprising 12 source pages plus two repeats under distinct page IDs. The current-page action populated nine bubbles on page 1 only. The all-pages action reused page 1 and detected the remaining 13 with zero failures. After save and reload, the per-page candidate counts were `9, 9, 13, 17, 12, 12, 12, 12, 18, 7, 13, 5, 9, 9`. OCR/cleaning counts stayed at zero, and every reloaded working raster still matched its source. These are backend integration results with the real detector.
- The separate R9 Windows build opened successfully at device pixel ratio 1.25 with the new toolbar. The protected-integrity check matched all 25 entries and the stable executable and chapter.
- A user-operated R9 native session produced completion receipts for the current page and then all 14 pages, and saved the chapter as v3. A native 2→1 return reused both images, but the backend activation request in that sample took 560.3 ms. The follow-up build presents the revision-matched cached image pair while activation and pending edit persistence are still running. Editing is disabled and selection, mask and text overlays wait for the authoritative page. A cache miss still waits for fresh decoded images.
- In the final Windows build, **All Pages** enabled followed by **Detect Bubbles** completed 14 pages with 14 cache reuses and zero errors, OCR calls or cleaning operations. Three observed cached 2→1 returns reached the first WebView animation-frame callback with the new canvas title at 4.7, 4.9 and 5.0 ms. Active-page confirmation followed at 251–321 ms. These are sampled WebView timings, with display scan-out and fresh-page equivalence to Chisa unmeasured.
- **Settings → Editing → Overlay** saved page 1 as v4 in a new 14-page file. All 13 other pages stayed v3. The saved copy matched the input for artwork, masks, OCR provenance, bubbles and all existing dialogue. The edit verified in this final session was the text treatment, while regression tests also cover dialogue editing and Undo/Redo across page changes.
- Final source tests passed 57 backend and 24 frontend cases. TypeScript checks and the offline Windows release build also passed.
- Native reload of the 14-page v4/v3 copy passed. Normal Close returned code 0 and left no owned processes.
- Diagnostics are in `E:\BagassZx\Yuchi-Diagnostics\chisa-r9-20261107`.

## Overlay boundary follow-up

Overlay backing now takes the intersection of the linked source-text rectangle and the bubble's saved safe interior. When a segmentation mask is present, backing and glyph layout stay within it too. The canvas draws the same transparent PNG backing used for exports. The glyph layout stays inside the safe area with Auto Fit either on or off. A linked dialogue that cannot fit retains its text for editing and produces the existing overflow warning. Unlinked text has no backing.

On the two translated bubbles from `page_001.jpg`, the old rectangular backing changed 5,545 pixels outside the combined safe interiors. The bounded renderer changed zero outside those interiors and rendered both layers without overflow. The proof and Original/Editing crop are in `OVERLAY_BOUNDS_PROOF.json` and `overlay-bubble-bounds.png`. The project schema remains the same.

The bounded Windows release displayed both translated bubbles at 125% display scaling and exported a 1114 × 1600 PNG with zero differences against the compositor and zero differences outside the safe interiors. The native screenshot is `session-r9-bounded/bounded-overlay-native.png`. Normal Close via X exited with code 0 and left no owned processes. Sixteen API/workflow cases, nine renderer cases and 32 frontend cases passed after the boundary change, along with TypeScript and the Windows release build. The protected check again matched all 25 entries.
