# Page navigation — source findings and measurement plan

Status: **PARTIAL — investigation only**. User observation: 2–4 seconds; Chisa comparison is subjective and not a measured benchmark. No latency, cache hit rate, FPS or RAM improvement has been measured in this phase. No application/testing launched because the user is gaming and explicitly prohibited tests.

## Current path located in source

1. `ChapterNavigator.tsx` sends `onPage(page.id)`. The visual selected marker uses backend `chapter.activePageId`; there is no separate pending-selection state.
2. `App.tsx:switchPage` invokes `action`, which sets busy and disables navigator controls; awaits source commits and `TypographySession.flush()`.
3. POST `/v1/pages/{id}/activate` takes the store lock and calls `Chapter.activate`.
4. `Chapter.activate` calls `flush` on the outgoing page. `flush` always invokes the existing project codec, even if the page has not changed. It also serializes every undo/redo frame as a separate complete project snapshot.
5. The existing project codec validates/fingerprints and PNG-encodes source/working/masks and bubble assets, then writes a ZIP package. This is actual source behavior, but its latency contribution has not been measured.
6. `decode` reads the target package; activation also decodes every target undo/redo package into arrays. The chapter retains only the active decoded page/history; there is no decoded-page LRU in this path.
7. The route clears render cache and returns public state. No detector, OCR or cleaning call appears in this direct activation path. This is static evidence, not a native request trace.
8. Frontend clears both image URLs, sets new state, resets viewport and calls `refresh`. `refresh` makes another GET `/v1/state` and requests original/working images; `useImage` creates new `Image` objects, clears prior image state and decodes URLs again. No bounded image reuse is present here.

These are **candidate costs**, not the proven root cause of the reported 2–4 seconds. Multiple full history encodes and a redundant state round trip deserve timing before choosing a fix. Do not claim caching will solve it without data.

## Measurements queued — not executed

Use an updated development release in a new folder, never overwrite `local-20261106-121336`. Capture native thumbnail click timestamp, immediate pending marker paint, outgoing edit flush, POST duration, backend flush/encode/disk and target decode/history time, GET/state, original/working response bytes/time, image decode, final dual canvas presentation and overlay identity. Correlate by navigation generation and page ID without logging tokens/source OCR content. Distinguish fetched, decoded and presented milestones; HTTP success alone is insufficient.

Test cold page visit, warm visit and explicit cache hits separately on a copied 12-page chapter. Sequences:1→2;2→1;1→12;1→2→3→2; after OCR/clean; many text objects; unsaved typography; rapid requests; Save/Reload; synchronized canvases. Count activation, image, detector/OCR/clean requests and measure complete owned process RAM. No rerun of already-passed detection benchmarks.

Report p50/p95/worst for click→selection and click→correct original+editing presentation; include sample count and errors. Goals remain ≤150ms selection, ≤300ms cached switch, ideally<1s warm. Cache hits must be recorded rather than inferred from a fast sample.

## Smallest potential fixes, conditional on evidence

- If repeated outgoing serialization dominates: skip only a demonstrably unchanged persisted page/history, with explicit invalidation on revision, history and save-state changes. Never equate `dirty=false` with an unchanged navigation snapshot. Prove unsaved edits/history survive before adoption.
- If redundant state/encoding dominates: consume activation's returned state and avoid the extra GET only when correctness permits. Fetch assets tied to page/revision identity; mutable current-page endpoints cannot safely support speculative concurrent prefetch.
- If decoding dominates: bounded page/revision image cache with owned URL lifecycle and eviction; cap by bytes and count. Do not load a whole chapter of full-resolution arrays. Retain valid images while loading only if overlays/labels cannot appear to belong to the wrong page.
- For rapid navigation: explicit pending selection and serialized/latest-intent navigation coordinator. Backend active state must agree with the last committed UI page. A frontend generation check alone does not undo out-of-order backend mutations. Preserve edit-flush errors and allow retry.
- Prefetch is optional after stable page-addressable reads exist; do not prefetch via activation or rerun AI.

## Gate/checkpoint

Branch confirmed before these documentation additions: `feature/chisa-editor-enhancements`, HEAD `ece3dc8`, upstream tracking verified; local/remote main unchanged. Only documentation added. Source, stable executable, models, original artwork, project codecs and environments untouched. No tests, profiler, native UI actions, builds, commits or pushes performed. Resume measurement and TDD when testing is permitted; no unmeasured optimization is presented as implemented.
