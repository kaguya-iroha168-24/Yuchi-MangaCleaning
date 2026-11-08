# Navigation baseline — 7 November 2026

Status: **PARTIAL**. Backend bottleneck reproduced on a copied native saved chapter; native click-to-presentation baseline is still pending desktop availability. No production optimization has been applied. Do not begin later Chisa features until navigation is optimized and natively verified as requested.

Authorized branch was checked: `feature/chisa-editor-enhancements`, upstream `origin/feature/chisa-editor-enhancements`, HEAD `ece3dc84c271288d55976d16a6dcd54307bddc3c`. Local main remains on that stable commit. Working tree already contained the inventory/investigation documentation; it was preserved.

## Executed

`scripts/profile_page_navigation.py` loads the existing 12-page saved native fixture through the real chapter codec into a new scratch chapter. It calls the real activation route with FastAPI TestClient and times flush, project encode/write, project decode, the extra state GET and original/working image responses. Instrumentation is installed only in this isolated process, not in the active backend or stable release. It does not call detector/OCR/cleaning. Typesetting used for working-image responses is the existing renderer and is closed after the run.

Sequences include 1→2,2→1,1→12,1→2→3→2 and repeated visits: 24 total activations. Second scenario seeds four metadata-only Undo snapshots on page 1; this is a controlled history workload, not a new OCR run or proof of every native editing case.

| Backend activation group | n | p50 ms | p95 ms | Worst ms | Median outgoing flush ms |
|---|---:|---:|---:|---:|---:|
| All | 24 | 1234.13 | 4435.71 | 4531.28 | 785.49 |
| Outgoing Undo=0 | 19 | 1098.30 | 2191.13 | 2804.38 | 677.69 |
| Outgoing Undo=4 | 5 | 4311.78 | 4516.54 | 4531.28 | 4058.55 |

Outgoing flush accounts for a median **94.13%** of activation duration in the four-Undo group. The trace shows five `save_project` calls on these outgoing switches: current page plus four complete history packages, even on a repeated unchanged visit. Returning to that page also decodes its four history packages. This proves unnecessary repeated serialization is costly in this backend workload. It does not yet prove the complete latency of the user's native click.

State responses are approximately 0.68MB because chapter state includes thumbnails. The profiler records response sizes/timings in raw cases. Original/working image endpoints are measured; client decode and native frame presentation are not. Instrumentation adds small call-timing overhead; disk/OS cache was not flushed.

## Evidence and limitations

- Raw: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-20261107/baseline/BACKEND_BASELINE.json`.
- Summary: `E:/BagassZx/Yuchi-Diagnostics/chisa-navigation-20261107/BASELINE_SUMMARY.json`.
- Log: `E:/BagassZx/Yuchi Labs Tauri/.cache/navigation-baseline.log`.
- Fixture: stable release's saved `chapter-f48a506a30624e3b9a1242b4288d89e5.mangaclean`, opened read-only by this script; all new chapter files are under scratch.

No explicit decoded-page cache exists in the measured path. Cache hit/miss counts are not invented from warm timing. OS-cold vs warm, image decoding, full process-tree RAM, overlay restoration/paint, native selected-indicator latency, rapid-click state safety, Save/Reload and native Undo/Redo regression remain unmeasured in this phase. TestClient timing excludes actual HTTP transport; image requests in the script are sequential whereas frontend uses parallel requests. Nested stages are not added together.

## Next step / safety gate

Desktop availability was requested once and has not yet been confirmed in this run. No desktop input or native application launch was performed. When available, measure the same routes and sequences in the native release and correlate click, response, image decode and presentation. Then write failing invalidation/history tests before changing flush behavior. A safe first candidate is avoiding reserialization only when page contents **and** undo/redo stacks are demonstrably unchanged; `dirty=false` alone is insufficient. Continue retaining every required edit and history frame. No full-resolution chapter preload or speculative prefetch via active-page mutation.

No source optimization, build, dependency installation, environment/model change, Git commit/push or stable release overwrite occurred. No claimed before/after improvement or navigation PASS.
