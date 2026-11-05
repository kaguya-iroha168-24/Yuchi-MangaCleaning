# Yuchi Labs — MangaClean Atelier (Tauri migration)

This is an isolated desktop migration workspace. The old PySide6 checkout is read only.
Development is currently supported; no redistributable installer or bundled Python
sidecar has been verified yet.

## Run on this machine

1. Use the existing local dependencies in this folder. If missing, install Node modules
   with `npm install` and Python packages with `.venv-standalone\Scripts\python.exe -m pip install -r requirements.txt`.
   Keep `npm_config_cache`, `PIP_CACHE_DIR`, `TEMP`, and `TMP` pointed into `.cache`.
2. Run `Start-Yuchi-Tauri.cmd`. It sets `CARGO_HOME`, `RUSTUP_HOME`,
   `CARGO_TARGET_DIR`, npm cache, and temporary paths to this E: workspace for its
   process only. It opens the Tauri development desktop window.
3. Open PNG/JPEG or an existing `.mangaclean` project. Scan a fresh page with
   Shima V1 or OpenCV fallback, review a candidate, inspect its mask, and confirm
   cleaning. Only accepted candidates can be cleaned; Ctrl-click and Accept selected
   support a batch. Add/erase brush edits stay inside the safe mask interior, and
   Undo/Redo restore pixels, candidates, and source-text metadata.
   Save Project writes a new editable copy to `outputs\projects` and
   verifies a reload before showing Saved. Export PNG writes the full-resolution
   working image to `outputs\exports` and verifies its pixels. Settings also offers
   JPEG export (quality 95; lossy). The result path
   appears in the workspace. Every save uses a unique name; input projects are
   never overwritten. Open the resulting `.mangaclean` to reload it.

The desktop shell launches an authenticated FastAPI process on a dynamic loopback
port. The launcher also chooses a dynamic frontend port and passes its exact
origin to the backend. Use the launcher for desktop development. Closing the shell requests graceful shutdown and falls back to stopping its
owned process tree if necessary. It does not launch or change the PySide6 app.

## Scope and safety

- `mangaclean/core`, selected Qt-free services, inference scripts, and configs are
  local copies. Source algorithms remain unchanged. See `THIRD_PARTY_SOURCE.md`.
- Source images remain separate from working pixels. Cleaning uses native-resolution
  masks and the copied `restore_text`/`execute` pipeline. Export never uses a canvas
  screenshot.
- A second scan on a document with candidates, masks, or source text is blocked to
  protect review data. Open a new copy to rescan.
- This development build references existing Shima and OCR Python runtimes and
  checkpoints read only. Their cache and temporary paths are redirected to this
  workspace. Redistribution needs a separate bundled sidecar, license review, and
  integration testing.
- Saved means the local project copy was written, reopened, and verified. Export
  does not mark unsaved project changes as saved. A loaded file shows Unmodified
  until this application creates a verified save. WebView storage is in `.cache\webview`.

## Checks

Shima parity on `page_009.png` and two exact copies has passed on CPU and CUDA.
The real PySide6 interpreter has OpenCV 4.14.0; this app has OpenCV 5.0.0.
Using those interpreters, 11 masks and 33 cleaning results per device matched
exactly. Detection settings and checkpoint hashes matched. See the diagnostic
`SHIMA_PARITY_REPORT.md` for scope, reproducible scripts, and retained evidence.

Auto selects CPU when CUDA is unavailable. Known CUDA/memory failures retry on CPU
with identical inference settings and report the effective device. Offline Manga OCR
uses the existing model/runtime read only, stages a proposal, and requires explicit
review before replacing manual transcription. CPU/GPU Japanese synthetic-text tests
passed; broader manga OCR accuracy is not established. Model load can take several
minutes; progress stages are visible and the request timeout is 300 seconds.

From this folder:

```powershell
npm run build
.\.venv-standalone\Scripts\python.exe -B -c "import runpy,tempfile,pathlib;d=runpy.run_path('tests/test_api_workflow.py');d['test_auth_and_native_clean_roundtrip'](pathlib.Path(tempfile.mkdtemp(dir='.cache')));d['test_upload_requires_explicit_discard']();d['test_websocket_session_and_origin']()"
.\.venv-standalone\Scripts\python.exe -B -c "import runpy;runpy.run_path('tests/check_lifecycle.py',run_name='__main__')"
.\.venv-standalone\Scripts\python.exe -B -c "import runpy;runpy.run_path('tests/check_legacy.py',run_name='__main__')"
```

Additional save, write-failure, export, and dynamic-origin checks are in
`tests/test_api_workflow.py` (`test_verified_save_and_export`, `test_dynamic_origin`).

`tests/test_migration_regressions.py` contains 8 focused regression cases. It replays
recorded real Shima predictions and injects controlled failure/cancellation cases;
it does not train or run a new detector inference. `scripts/finalize_parity_evidence.py`
audits retained runtime/GUI outputs and protected-file hashes without redoing inference.
Actual model probes in `tests/check_cpu_fallback_real.py`, `tests/check_offline_ocr.py`,
and `scripts/parity_inference_probe.py` should only be repeated when relevant code,
runtime, configuration, or fixtures change.

`tests/check_legacy.py` requires the copied fixture at
`.cache\fixtures\legacy-copy.mangaclean`; never point a write test at the old
application's project file. See the diagnostic report for current results and gaps.

## Real manga validation checkpoint

TextRegion now supports native crop and reading-direction edits, with a selected-region overlay. Crop changes mark previous OCR Stale while retaining raw provenance; direction metadata does not rotate source pixels. Six real Japanese manga workflows and eight real-crop OCR requests were evaluated. Patterned text and rotated OCR remain partial; exact native1366/1920 and cold-start acceptance are incomplete. See `E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028\REPORT.md`. Packaging is gated; `scripts/release_preflight.py` inventories blockers without building/installing. New regression only: `.venv-standalone\Scripts\python.exe -B tests/test_text_region_editing.py`. Retained parity tests were not repeated.
