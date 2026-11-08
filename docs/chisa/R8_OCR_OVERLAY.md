# Chisa R8 — OCR profiling and translation overlay

Branch `feature/chisa-editor-enhancements`, based on `ece3dc84c271288d55976d16a6dcd54307bddc3c`.

## OCR on page_001.jpg

The same nine crops from a copied manga project went through Universal OCR on CPU. Wall time covers crop encoding, host communication and recognition. Crop extraction was below 0.1 ms per bubble. The two baseline runs started fresh Python processes, without controlling the Windows file cache. The table uses the repeated baseline.

| Bubble | Windows before (s) | Windows after (s) | Full before (s) | Full after (s) | Final engine |
| --- | ---: | ---: | ---: | ---: | --- |
| 1 | 1.354 | 0.817 | 1.355 | 0.817 | Windows |
| 2 | 0.816 | 0.138 | 0.816 | 0.139 | Windows |
| 3 | 1.009 | 0.113 | 1.009 | 0.113 | Windows |
| 4 | 0.793 | 0.095 | 50.952 | 70.774 | Manga OCR |
| 5 | 0.841 | 1.206 | 0.841 | 1.206 | Windows |
| 6 | 0.882 | 0.147 | 0.882 | 0.147 | Windows |
| 7 | 0.804 | 0.133 | 1.705 | 1.097 | Manga OCR |
| 8 | 0.684 | 0.145 | 0.684 | 0.145 | Windows |
| 9 | 0.842 | 0.137 | 1.826 | 0.980 | Manga OCR |

- Windows total fell from 8.026 s to 2.933 s across nine crops. Median fell from 0.841 s to 0.138 s. The first baseline total was 10.814 s. Bubble 5 starts a fresh Windows host after the long Manga OCR request.
- SHA-256 of the OCR text and final engine matched on all nine crops against both baselines. This checks parity for this fixture. Recognition mistakes already present in those baseline outputs remain possible.
- The slowest bubble is still bubble 4. First-use Manga OCR imports took 122.90 s, 48.48 s and 57.16 s in the three runs. The new full run took longer than the repeated baseline. These runs do not establish a speedup for cold Manga OCR. Preview Mask was outside the measured OCR path.
- The Windows OCR host and its English engine are reused within a 10 s idle window. Worker startup, shutdown, timeout and cancellation are tested, including independent ownership of the Manga OCR worker. Recognition input, routing and post-processing are unchanged.

## Two text treatments

- **Process Automatically** uses Shima V1, Universal OCR and existing validated cleaning.
- **Processing options → Detect & Overlay** uses the same detection and OCR. When a linked Indonesian dialogue has a valid render, it draws a solid white cover on the source-text rectangle, followed by the lettering. A cover can obscure artwork within its rectangle. The original and previously cleaned images are retained as separate assets. A dialogue without an unambiguous source region stays transparent.
- **Layers → Text treatment** switches the display and export treatment without re-running detection or OCR. The clean treatment uses Working by default. Overlay uses Original as its base. Translation can be entered manually or via the existing configured translation flow.
- The non-default treatment is saved in the existing optional v4 composition. v3 remains readable and default-only pages can still save as v3. Projects save to a new file.

## Verification

- 52 focused backend tests, 28 focused frontend tests and TypeScript typecheck passed.
- Tests verify the existing detection and OCR paths, v3/v4 persistence, white-cover geometry at zoom, and exact PNG and quality-95 JPEG encoding from the same composite. The OCR worker tests use real owned subprocesses, and the nine-crop profile uses the actual OCR engines.
- Windows release smoke passed. The editor opened a copied `page_001.jpg` v3 project, ran **Detect & Overlay**, reused one detected page and nine cached OCR regions, and reported zero errors and zero cleaning operations. The Editing canvas restored original lettering in untranslated bubbles and showed the covers and dialogue in two translated regions. Native Save wrote a new v4 file and the overlay appeared again after reload.
- The native exports were 1114 × 1600. PNG differed by zero pixels from the saved project's reference composite. JPEG matched byte-for-byte after encoding that composite at quality 95. Source, working image, masks, OCR provenance and dialogue data matched the input fixture. On the rendered copy, zero changed pixels were found outside the union of the covers and text boxes.
- Normal Close via the window's X returned code 0 and left no owned processes. The native smoke run reused existing OCR results, so the live OCR timings above are from the separate worker profile. One launch of the fresh test directory showed the window in 0.48 s and authenticated backend readiness at 40.95 s. This is a single startup observation outside the per-bubble timing.
- The protected-resource receipt passed all 25 entries (24 unique paths). The stable release executable and protected project hashes also matched.
- Raw timing files and the copied fixture are in `E:\BagassZx\Yuchi-Diagnostics\chisa-ocr-overlay-20261107`.
