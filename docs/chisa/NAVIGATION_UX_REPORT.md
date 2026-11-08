# Navigation UX, memory and JPEG verification — 7 November 2026

Status: **PARTIAL overall. Blink fix and native JPEG parity PASS.** This is a focused extension of NAVIGATION_FIX_REPORT.md, not a repeat of the detector/backend benchmark. The full Chisa feature inventory is not complete.

Branch `feature/chisa-editor-enhancements`; HEAD and stable main `ece3dc84c271288d55976d16a6dcd54307bddc3c`. Known-good `releases/local-20261106-121336` remains unchanged. Test executable is only in `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-ux-20261107/native-after-r2/MangaClean.exe` (SHA256 `7078fd21c4eedf969eb8f05e07842c9aefe7f4c7179f00de7f06c0488c2e921c`). No commit/push/merge/reset, dependency installation, model/environment/OCR/cleaning change.

## Proven cause and narrow fix

The old frontend replaced image URLs before their replacements had loaded/decoded. Its image hook temporarily returned null, so the mounted Original/Editing image layers were cleared while a replacement was pending. State/overlay metadata could also move ahead of the image pair. This was additional frontend work after the already-fixed chapter persistence cost, not a new detector problem.

`PageFrames` now fetches and decodes both page images before publishing one paired frame together with its corresponding document state. The previous pair remains displayed during loading. Successful replacement releases the previous URLs; stale/failed fetches and decodes release their own URLs. Ownership is one displayed pair plus one pending pair, not a full-chapter decoded cache. No fake fade or resolution reduction was introduced.

`PageNavigation` serializes the backend's mutable active-page operations, coalesces pending clicks to the latest target, and prevents obsolete results from publishing. The first operation flushes edits before activation. Required automatic saving/history is retained. A failure disables editing until reconnect instead of allowing stale visible-page controls to edit another backend page. Pending thumbnail selection updates immediately; edits are disabled while the pair is loading. Activation reuses the returned state instead of issuing another state GET.

The same paired publication is used for image-changing Open/Undo/Redo. Selection and viewport reset on successful ready publication. The existing mask preview mechanism and engine are preserved.

## Native evidence and measurement limits

Manual user input was used; Computer Use could not initialize (kernel-assets error). Passive inspection was attached to the actual Windows release WebView2. This was not a browser replacement, input simulation or viewport emulation.

The native trace correlates thumbnail clicks, selected-page DOM state, image requests/load/decode, Original/Editing canvas draws and native PipelineReporter PRESENTED reports. A qualifying correct-frame bound requires both images from the clicked generation, the correct page title, enabled Import and ready typography. Only a presented frame beginning after readiness qualifies. Therefore these values are **conservative post-ready presentation upper bounds**, not an exact first OS scan-out timestamp. Unmeasurable cases are not assigned zero. WebView callback counts are not counted as rendered FPS.

| Native sample | A: old frontend | B: fixed frontend |
|---|---:|---:|
| Visible selection feedback bound n | 23 | 14 |
| Feedback p50 /p95 /worst, ms | 124.65 /174.36 /176.21 | 14.37 /19.18 /20.81 |
| Correct interactive frame bound n | 22 | 12 |
| Correct frame p50 /p95 /worst, ms | 237.67 /441.89 /479.59 | 260.65 /287.85 /289.63 |
| Cleared-image-layer presentation reports | 219 | 0 |
| Native CSS viewport /DPR | 1536×890 /1.25 | 1440×900 /1.25 |
| Maximum observed live page-image URLs | 2 | 4 |

The user confirmed that the visible blink disappeared in B. The zero cleared-layer reports support that observation, but are not pixel-level display scan-out proof. B's median correct-frame bound did **not** improve; its observed tail and feedback did. Different viewport, accepted click counts/manual pacing, and continuous versus segmented trace collection prevent a statistically controlled speedup claim. Two B clicks lacked a qualifying post-ready presentation bound and remain unmeasured.

Nine bounded B trace segments were saved, each without reported trace data loss. Earlier B startup was blank due to an introduced null dereference in empty-state frame selection; the actual failing App-render test reproduced it, the null guard was corrected, and the rebuilt R2 release rendered normally. An exploratory R2 trace exceeded its diagnostic cap; another trace was lost when that app closed before retrieval. Neither is used as successful after-performance evidence. All artifacts remain preserved.

No decoded-page LRU/cache hit was implemented; these numbers must not be labeled cached-page latency. OS warm state is uncontrolled. There is no defensible cold/warm/cache-hit split or sustained 60/120 FPS claim. Page 001↔002 and repeated 001/002/003 navigation were captured; an explicit 001→012 correct-presented-frame sample was not captured. All 12 saved pages are checked separately, which does not replace that missing timing case. Exact target viewports 1366×768, 1600×900 and 1920×1080 are not newly certified.

## Memory: observations, not a matched improvement claim

Private resident memory is the sum of private working sets over the application's owned process tree, sampled at approximately 250ms using PID plus creation time and ancestry. Shared working sets are not summed as private allocations.

| Phase | A | R2 B |
|---|---:|---:|
| Idle median, MiB | 164.29 | 164.33 |
| Untraced navigation median /peak, MiB | 357.94 /428.17 | 385.87 /436.02 |
| Untraced samples | 220 | 33 |
| Whole instrumented session peak, MiB | 687.28 | 673.56 |
| Last 30s median, MiB | 275.19 | 230.01 |

The sessions used the same chapter and optimized Python runtime but different click sequences and interval durations. These are not an identical-workload memory comparison. A RAM improvement, leak-free repeated cycles, OCR memory or detector idle-worker release is **not** claimed. The final recovery session measured idle187.06 MiB; its untraced navigation interval (128 samples over33.06s,10 accepted clicks) measured median350.74/peak377.95 MiB. Whole-session peak570.91 MiB includes tracing, detached full-resolution preview readback and renderer/export verification; it must not be called ordinary editing RAM. Final30s median301.28 MiB. Raw process attribution and interval limits are in MEMORY_ANALYSIS.json.

At the A session peak the two largest WebViews used 260.89 and 231.23 MiB; at R2 B peak they used 414.25 and 88.61 MiB. Backend Python was about 69 MiB and its renderer about 23–24 MiB. This locates most retained sampled memory in WebView processes, but does not prove which Chromium/GPU allocation is responsible. Previous 519/625/869 MiB observations had a different workload/instrumentation, including an earlier accidental AI job, and are not valid reduction denominators.

The pair lifetime is explicitly bounded. Observed encoded live-URL bytes rose from about 5.09 to 8.17 MiB during double buffering. Holding one additional decoded pair costs roughly 13.6 MiB at 1114×1600 RGBA before browser/GPU overhead; that is a deliberate bounded anti-blink tradeoff, not evidence of an unbounded chapter cache. Precise allocation tracing and a truly matched memory workload remain PARTIAL. No speculative cache/GC changes were made to chase a number.

## JPEG and Auto Fit — PASS

Actual native output: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-ux-20261107/native-after-r2/runtime/app/outputs/exports/page_002-20261106-195447-fe307b8d.jpg`, 1114×1600, SHA256 `4473f22dffea43e696f765d0c1e75419b21086b357a2557724b178dfaca4a794`.

Native Original/Editing image pixels equal the fixture source/clean arrays; both native text raster PNGs equal their renderer outputs. Re-compositing that state and encoding with the existing JPEG quality-95 path yields **identical encoded bytes and 0 decoded differing pixels**. This is not lossless equality between JPEG and the unencoded preview or a scaled screenshot. See JPEG_PREVIEW_PARITY.json.

The unchanged renderer resolves requested34 px, Arial700, box143×202 and padding12 to a safe 79×116 text area. Actual24 fits without overflow; forced25 overflows. Disabling Auto Fit uses the larger rectangular content area and permits34; a detached300×300 box also permits34. The size difference is justified by the existing safe-area font-metric fit, not an unintended global cap. No Auto Fit algorithm change was made. The second text object's requested30/actual15 also matches native raster and export.

## Tests, preservation and remaining gates

- Frontend focused suite: **28 PASS**, including 5 paired-frame ownership/failed-sibling/stale-decode tests, 2 navigation queue/coalescing/failure tests, 1 real App empty-startup render test, and the existing style/session/studio tests. App startup red/green evidence is preserved.
- Existing backend navigation guard: **9 PASS**. The previous optimized chapter module SHA256 is unchanged. The completed 41 backend tests and large serialization/detector benchmarks were not repeated.
- Diagnostic presentation analyzer: **2 PASS**, guarding against old-generation and pre-ready/in-flight frame misclassification. These tests validate the analyzer, not native behavior alone.
- Typecheck, production frontend build, incremental offline Windows release build and whitespace checks passed. No build required to launch the staged release; the stable release/launcher pointers are not replaced.
- Native Save/Reload **PASS**: verified 12-page chapter `chapter-4b8f607405c342319a17222c98fd8412.mangaclean`, SHA256 `616752a822555666d8fa8944340cd57c6be39321ab8f67a3ea37fe12ebb1c80e`. All source/clean/mask/manual-mask arrays, raw OCR region graph, bubble data and all Dialogue properties remain equal to the input fixture. The native reopen response matches both dialogues; the user confirmed12 pages and correct text. See SAVED_CHAPTER_PROOF.json.
- Final native Normal Close **PASS**: user closed via X; root exit0, normalProcessExitObserved=true, remainingOwnedPids=[] after PID+creation-time checks. Before and R2 exploratory sessions also exited0 with no owned survivors. No unrelated Python process was stopped.
- The passive observer ended with a socket-disconnect error when the native WebView closed. Its diagnostic exit1 is separate from the application's verified normal exit0; saved trace/file/process artifacts remain readable and validated.
- Session Undo/Redo across page switches remains the existing semantics. Saved chapter reopening starts a fresh history session; no new persistent Undo format is claimed. Historical native Undo/Redo and fresh focused backend tests are retained. The fixed frontend's full manual Undo/Redo matrix is not freshly re-certified by these navigation traces.
- **25 protected entries /24 unique paths identical**. Stable main, stable executable/backend and original stable chapter unchanged; model/OCR/cleaning/runtime/environment untouched. FINAL_INTEGRITY.json contains hashes.

## Actual changed source files this frontend phase

`src/App.tsx`, `src/components/ChapterNavigator.tsx`, new `src/ui/pageFrames.ts`, new `src/ui/pageNavigation.ts`; new focused tests `tests/app_startup.test.mjs`, `tests/page_frames.test.mjs`, `tests/page_navigation.test.mjs`. No CSS/layout/AI/schema change. The already-uncommitted `mangaclean/services/chapter.py`, `tests/test_navigation_persistence.py` and `scripts/profile_page_navigation.py` belong to the preceding preserved backend optimization.

Artifacts and source diff: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-ux-20261107`. Before screenshot `session-before/before-after-navigation.png`; after screenshot `session-after-final/final-saved.png`. Screenshots prove actual visible native states, not frame latency by themselves.

## Acceptance decision

**PASS:** paired-frame blink fix in observed native cases, immediate pending feedback, real JPEG Q95/preview parity, Auto Fit explanation, protected integrity. **PARTIAL:** complete native timing matrix (especially001→012 and exact first-frame), controlled cold/warm/cache split, matched-workload RAM/leak proof, complete fixed-frontend Undo/Redo matrix, target viewport matrix and sustained FPS. No full navigation-performance PASS or complete Chisa implementation is claimed. Further Chisa features remain in FEATURE_INVENTORY.md behind this incomplete performance gate; no requirements were deleted or silently replaced.
