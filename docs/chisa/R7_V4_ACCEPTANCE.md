# R7 optional project v4 — 7 November 2026

R7 implements the approved Typography, Layers and Image slice on `feature/chisa-editor-enhancements`. Native startup and shutdown passed. Interactive native verification is partial because the desktop control tool could not initialize.

## Editing and compatibility

- Typography supports licensed installed italic faces, line height, letter spacing, vertical offset, rotation, fitted width inside the existing box, and stroke width/color with the available system eyedropper. Auto Fit checks placement inside the safe text area. The status line shows the actual italic face and fitted width. Missing italic coverage uses the current upright fallback and reports it. Custom tracking for RTL retains default shaping and reports the limitation.
- Layers supports dialogue visibility, locking, and front/back order. Locking a dialogue blocks edits, deletion, canvas manipulation and automatic translation replacement. Artwork can use the working image, raw image, or a white background in Editing and export. Artwork lock blocks cleaning, Healing and image adjustments. The base stays below text; there are no additional imported image layers in this slice.
- Image supports brightness, contrast and reset. Releasing a slider commits an undoable adjustment, fetches only the Editing image and keeps the decoded Original. The original and working source buffers are retained separately from composition. Preview and export use the same adjustment pipeline.
- The writer emits v3 with default composition and v4 when extended metadata is present. `Save Project` creates a new file. Chapter v1 can contain a mixture of v3 and v4 page packages. The reader accepts legacy v1–v3. The prior R6 reader explicitly rejects v4, so keep the v3 original for rollback.

## Evidence

| Check | Result |
|---|---|
| Backend and frontend | 41 backend tests, 13 renderer/font tests and 30 frontend tests passed. TypeScript and offline Windows build passed. |
| Default rendering | 24 comparisons across Latin/CJK text, alignment and Auto Fit produced the same raster and overflow flag as the v3 renderer. |
| V4 API | Layer order changed composited pixels. Locked edits/deletes and stale page requests were rejected. Brightness/contrast Undo/Redo restored the expected preview. Reopened v4, PNG and quality-95 JPEG matched the composite. |
| Existing chapter | A real copied 12-page v3 fixture reopened and saved as a new mixed chapter with one v4 page and 11 v3 pages. The original file hash and the composed pixels after reload matched. R6 opened the 11 v3 members and explicitly rejected the v4 member. |
| Native smoke | R7 rendered its startup window at 1440 × 900 and DPR 1.25. Authenticated backend readiness took 19.39 s in this run. Median private resident RAM was 164.69 MiB at idle. Closing the owned window exited 0 with no owned processes left. Editing interactions, viewport matrix, and sustained FPS have no new native proof. |
| Integrity | All 25 protected entries matched. Stable executable, original stable chapter and `main` matched the checkpoint. |

Artifacts are under `E:/BagassZx/Yuchi-Diagnostics/chisa-v4-20261107`, including `native-r7/MangaClean.exe`, `chapter-12-v4-copy.mangaclean`, `STAGED_RELEASE.json`, `CHAPTER_COPY_PROOF.json`, the startup screenshot and process profile under `session-r7`, and `WORKTREE_CHECKPOINT.diff`.

## Why the photographed run paused at text 4/9

The counters are emitted immediately before OCR processes each text region. The detector has already emitted bubble geometry at that point. Process Automatically recognizes regions in sequence, using the English Windows OCR CPU path first and the configured Manga OCR CPU fallback when the first result is ambiguous. GPU detection selection belongs to the preceding detector stage. Automatic cleaning starts after OCR; the on-demand Preview Mask is separate. The screenshot does not include elapsed times or confirm which OCR branch that individual region used.
