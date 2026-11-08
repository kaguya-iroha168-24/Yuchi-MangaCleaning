# Targeted navigation persistence fix — 7 November 2026

Status: **PARTIAL — backend fix PASS; native behavior observed, complete rendering/performance acceptance incomplete**.
Branch: `feature/chisa-editor-enhancements`. Main remains `ece3dc84c271288d55976d16a6dcd54307bddc3c`. No commit/push/merge/reset. No frontend, model, OCR, cleaning algorithm, environment or project-format change.

## Confirmed mechanism

`Chapter.flush` encoded the outgoing full page plus every composed Undo/Redo frame on every switch. Each history package includes original/working/mask assets and metadata even for metadata-only edits. The earlier 24-case isolated run measured 94.13% median activation time in outgoing flush for four Undo frames. The implementation also decodes all incoming history packages; that separate cost remains.

History frames in the live Store are partial deep-copied edits. Before writing, the chapter composes those frames backwards into full compatible project snapshots. This composition remains unchanged; the fix does not flatten history, reduce its existing maxlen=4 bound, or delay essential writes.

## Exact change

`mangaclean/services/chapter.py` tracks a small in-memory stamp for the **active persisted snapshot**: page/document identity, revision, source name, active text ID and Undo/Redo frame identities. All committed backend edits already increment document revision. History-only changes also invalidate the stamp. No image buffer is retained by the stamp.

An unchanged stamp can reuse the current on-disk page/history only while every corresponding file still exists. Metadata flags such as dirty/savedPath are updated independently; dirty=false is not used to infer unchanged content. A changed page/history is fully serialized before activation proceeds. The stamp is invalidated before writing and set only after success. History filename lists are published after all writes succeed, permitting retry on failure. After decoding a page/history from disk, its loaded state is known persisted and stamped.

No LRU, decoded-page cache, prefetch, new dependency, deferred persistence or file-format extension was added. Source/working image encoding and the single-page/chapter codecs are unchanged.

## Matched backend benchmark

Same copied native 12-page chapter, same activation sequences, 96 cases per version, including **20 outgoing-four-Undo samples** per version. Before uses the exact baseline chapter module captured from `ece3dc8` in the isolated profiler process; production files are never switched back. Sequential runs, OS cache not flushed. TestClient excludes real HTTP transport and native presentation.

| Backend activation | n per version | Before p50/p95/p99 ms | After p50/p95/p99 ms |
|---|---:|---|---|
| All cases | 96 | 765.16 /4042.83 /4861.12 | 89.98 /485.13 /640.30 |
| Outgoing Undo=0 | 76 | 494.77 /1983.71 /2396.86 | 93.25 /485.13 /541.72 |
| Outgoing Undo=4 | 20 | 2314.64 /4861.12 /4991.38 | 81.44 /206.34 /1628.60 |

Four-Undo median flush: 2198.77→0.247 ms. Total project serializations: **176→5**. After: 95 reused persistence states, 1 required write of current page +4 Undo packages. That first edited switch remains an outlier at 1984.16 ms; worst overall before was 5023.95 ms. Returning to pages with four Undo frames still incurs decoding; do not confuse the group keyed by outgoing history with incoming-history cost.

The prior baseline p50=4.31s was recorded under different machine/cache conditions; it is not used as the denominator for this expanded comparison. No controlled cold-machine benchmark or decoded-image cache hit count is claimed. Persistence reuse is explicitly counted and is not an image cache hit.

Raw and summarized data: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-20261107/COMPARISON.json` and `comparison/before|after/BACKEND_BASELINE.json`.

## Memory

Separate matched 24-case runs sampled the isolated backend and its own renderer children every 500ms. Before n=97 samples: median70.66 MiB, observed peak107.57 MiB. After n=29: median67.60 MiB, observed peak105.51 MiB. These runs include chapter loading, run for different durations and exclude Tauri/WebView. This is not proof of a significant memory reduction or no leaks. No full-resolution page cache or additional image buffer was introduced.

Native whole-process sampling is recording separately. The user started an unrequested Process Automatically job after importing images; any resulting inference peak must be separated from navigation/editing memory. It must not be compared directly with idle or isolated-backend measurements.

## Focused regression

- TDD red: 3 expected failures in 6 tests (redundant writes with no history, repeated four-history writes, reload switch reserialization).
- Green expanded: **9 tests** in `tests/test_navigation_persistence.py` pass: unchanged switching, four-frame persistence, repeated navigation, dirty edits, history-only invalidation, failure/retry, bounded history after seven edits, metadata-only flags, Undo→switch→Redo, and existing Save/Reload semantics across these cases.
- Existing chapter tests **4 pass**: 12/20-page operations, linked source/dialogue history, save/load, chapter PNG export and unchanged source/clean pixels.
- Automatic queue **3**, automatic processing **12**, direct cleaning **3**, geometry API **2**, migration regression **8** pass.
- Copy Style/selective snapshot frontend tests **14 pass** with the repository's required `--experimental-vm-modules` Node flag. Initial run without that flag failed at test harness initialization; no product fix was needed.
- `git diff --check` passed. No full detector benchmark, training or replacement model run.

Chapter persistence retains existing semantics: edits are saved, Undo/Redo survives page navigation within the session; reopening a chapter starts a new Undo session. The chapter format did not previously serialize session history into the saved chapter, and this fix does not claim to add that capability.

## Native test status and remaining gates

Native tooling fails initialization with `failed to write kernel assets` even after reset and alternate supported entrypoint. User agreed to assist manual actions. A separate test folder was prepared at `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-20261107/native-after`; executable bytes are identical to stable, only its copied runtime's chapter backend is updated. No Rust/frontend build or stable release overwrite; no launcher pointer/shortcut changed.

Passive native observation and process-tree sampling are running; no injected mouse/keyboard. Observer records human thumbnail-click timestamps, request timings, sanitized editor state and delayed native screenshots. A preflight body-read error was corrected in the diagnostic observer, preserving earlier events; no app auth/CORS change. The screenshots and response timestamps do not by themselves prove the exact first correctly presented interactive frame.

## Final native evidence

The user opened the correct saved chapter and performed navigation, text-size editing and Undo/Redo manually. Native screenshots and API state were captured from the actual Tauri WebView, not an external browser harness. User reported correct pages and preserved text, but a brief blink during switching. Existing `App.tsx` still clears both image URLs then requests/decodes images again; frontend behavior was not modified in this targeted backend fix.

After the correct saved-project open, **35 native activation requests** matched their requested page IDs. Native HTTP duration p50 **116.89 ms**, p95 **269.20 ms**, p99 **1006.93 ms**, worst **1267.22 ms** (includes edited/history navigation; not trimmed). First visits n4: p50 143.93/p95 166.99 ms; repeat visits n31: p50 116.88/p95 332.23 ms. Click-event-to-request-start p50 **2.20 ms**, p95 **3.00 ms**. The latter is not visible selection-feedback latency. These are real native HTTP timings, **not** click-to-correct-frame or interactive latency. No native before/after controlled pair, ≤150ms visible-feedback, ≤300ms image-cache navigation or <1s full-render PASS is claimed. Delayed screenshots cannot supply an exact first-presentation timestamp.

Saved native chapter `chapter-48f36e605009416da4798d8fb4c18d2b.mangaclean` contains 12 stable page IDs. Target Dialogue content and IDs remained intact and its requested size34 survived Save/Reload. Auto Fit remained true and Actual24 px explains why increasing requested size did not visually enlarge the text. The original Source/clean/mask/manual-mask arrays and region graph/raw OCR across all 12 pages remain identical to the original fixture. PNG1114×1600 differs from the matching renderer by **0 pixels**. User reported JPEG success, but **no new JPEG file was observed**; fresh native JPEG acceptance remains PARTIAL. Historical baseline JPEG proof is not mislabeled as a fresh test.

Native Normal Close: user closed via X, process exit0, `remainingOwnedPids: []`. Expected observer socket-close exception on app exit is diagnostic transport shutdown, not an application crash. Protected integrity: **25 entries /24 unique paths identical**; stable executable and stable backend unchanged, original saved fixture unchanged, test-copy backend hash matches workspace. No release pointer/shortcut overwritten.

Whole-owned-tree native RAM: idle median **164.31 MiB**. Interval after opening the correct saved project and before new edits: median **560.17 MiB**, observed peak **868.85 MiB**. Editing/history/navigation/Save interval: median **518.95 MiB**, peak **624.73 MiB**. These exceed desired ordinary-editing targets and are not claimed as improved. The largest navigation peak processes were WebViews351.94 and332.87 MiB, backend75.67 MiB and another Python32.72 MiB. Repeated screenshots/network observation and image reloads may contribute, but allocation cause is not proven. Do not call this an established leak or a model duplication. Whole-session peak1403.01 MiB occurred during the earlier mistaken image-import/automatic-processing interval and is reported separately. No clean native before/after memory comparison or repeated-cycle leak bound.

Evidence: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-20261107/NATIVE_TIMINGS.json`, `NATIVE_FINAL_PROOF.json`, `NATIVE_FILE_PROOF.json`, `FINAL_INTEGRITY.json`, `APPLIED_CHANGES.diff`; screenshots in `native-session/native-navigation-*.png`, `native-before-edit.png`, `native-edited-history.png`.

Backend behavior regression totals: **41 focused backend tests +14 frontend tests pass**. Source changes remain one production file, one new focused test file, the profiling script and documentation. No frontend image-cache/concurrency refactor, schema change, new AI engine or later Chisa feature implementation was added.

## Remaining bottlenecks / acceptance

First required write after editing and incoming history decode still cost time. Frontend repeated state GET/image reload/blank image transition remains. Native frame-presentation latency and memory stability need a separate measured improvement; current data is insufficient to call the full navigation target PASS. JPEG fresh native artifact is missing. The next Chisa inventory work remains queued behind this navigation gate, consistent with the requested order; no feature was removed from the inventory.
