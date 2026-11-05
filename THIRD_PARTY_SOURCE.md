# Source provenance

The `mangaclean/core`, selected `mangaclean/services`, `scripts/yuchi_inference.py`,
`scripts/ocr_inference.py`, and initial `configs/*.json` files were copied from the
user's local `E:\BagassZx\Yuchi Labs` application on 2026-10-27. They are kept in
this separate workspace so the Tauri application never imports code from that folder.
No upstream license file was present in the source root at the time of copying.
Ownership, checkpoint provenance, and redistribution rights must be checked before
publishing an installer. The Shima V1 checkpoint remains MangaLens Original weights.

The copied domain algorithms are not altered for the Tauri backend. The API adapter
and frontend are new code in this workspace.

For parity validation, `.cache/shima-parity/baseline` holds controlled snapshots of
the original Qt UI, domain services, inference worker, configs, and bundled fonts.
`SOURCE_SNAPSHOT.json` and `BASELINE_GUI_SOURCE_INTEGRITY.json` in the diagnostics
record source paths and hashes. Existing font license/attribution files are retained.
This snapshot runs only with separate settings/cache/temp directories and a separate
application identity; it never imports the old checkout in place. The existing
PySide6 interpreter and model files are read only. This is a local test snapshot,
not a redistribution license grant.

The real-world coexistence test uses an additional unmodified original-app copy at `.cache/realworld-20261028/pyside-original-copy`, including main.py, modules, configs, assets/fonts and existing notices. All98 copied source/assets entries have before/after hashes in `realworld-20261028/PYSIDE_SOURCE_INTEGRITY.json`. It uses the original GUI interpreter read only with separate writable paths; there are no mocked widgets or source rewrites in that copy. Manga109 images/XML are local read-only inputs copied only for private testing, not redistribution assets.
