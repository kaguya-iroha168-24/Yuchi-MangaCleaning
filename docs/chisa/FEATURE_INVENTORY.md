# Chisa enhancements — inventory before development

The [implementation checkpoint](IMPLEMENTATION_PROGRESS.md) records the linked selection, typography controls and ROI mask repair verified after this baseline inventory.

The [R7 acceptance](R7_V4_ACCEPTANCE.md) supersedes the R6 pending status for italic, stroke, spacing, offset, rotation, fitted width, dialogue ordering/locks and brightness/contrast. Those controls are implemented in the optional v4 composition. Native click-through and additional imported image layers remain outside the verified R7 slice.

## R6 status by control group — 7 November 2026

| Controls | Actual status |
|---|---|
| Toolbar, status, Pages with thumbnails/filename/current count, chapter checkboxes and compact active row | Implemented. Full responsive/DPI and navigation timing matrix pending native interaction. |
| Synchronized Original/Editing, Onion-Skin, zoom/pan, linked selection, eight handles, ROI edit and mask repair | R5 and navigation checkpoint evidence remains applicable to the existing paths. Core cache/activation files matched their hashes. |
| Create/delete manual bubble region | Implemented in v3. Stable IDs, bounds, Undo/Redo, scan retention and text unlinking tested. Deletion is disabled after cleaning while the applied mask is attached. Detected regions retain Exclude. |
| Move/resize manual or detected ROI | Existing clipped geometry path reused. A moved ROI must intersect the source geometry basis. Undo cleaning before adjusting a cleaned ROI. |
| Original OCR / edited source, Indonesian translation, canvas editing | Source text has raw OCR fallback. Editable Translation and Typography groups and direct canvas editor implemented. Native click-through pending. |
| Family, weight/Bold, size, presets 1–5, AA/Aa/aa, horizontal alignment, text color/eyedropper, X/Y/nudge/center, width, Auto Fit, Copy/Paste Style | Existing v3 renderer controls preserved. Five customizable preset slots use local preferences and start empty. Applied size is stored on the existing Dialogue field. Numeric width is available. |
| Italic, line height, letter spacing, vertical offset, rotation, automatic width, stroke color/width/eyedropper | Pending v4 proposal for persisted renderer effects. Current Inspector exposes the supported controls. |
| Rectangle, rounded rectangle, circle, ellipse, speech/custom shapes, roundness, Segment/Node, fill, outline, vector bubble type, feather and flips | Removed from scope by the latest user direction. Manual bubble ROI is a separate existing-data operation. |
| Original/working/overlay visibility, selected layer and Dialogue export visibility | Existing Layers controls. Full heterogeneous locking/order, additional image layers and persistent preview visibility await composition design. |
| Healing brush size/cursor, add/erase mask, selected bubble or explicit box including SFX, apply, Undo/Redo, Save/Reload, export | Implemented. Automated API and pixel evidence pass. Native interaction pending. |
| Image tab, brightness, contrast and other adjustments | Pending v4 proposal for non-destructive persisted adjustments. |
| Gemini settings, API key, test connection, selected bubble/current page/all pages | Implemented, with session-only key and local/mocked transport validation. Real Google response pending a configured key. No translation is started automatically by Scan or Clean. |
| Animated progress for import, scan, translation and cleaning | Implemented. Jobs use actual progress and expose Cancel; single atomic import/clean actions use indeterminate progress. Native interaction pending. |

Checkpoint: `ece3dc84c271288d55976d16a6dcd54307bddc3c`. Authorized branch: `feature/chisa-editor-enhancements`. Stable release: `releases/local-20261106-121336/MangaClean.exe`; must not be overwritten.

This is source inspection, not a new runtime verification. User subsequently prohibited testing while gaming. No application, inference, benchmark or desktop-input session was started. No production code was changed.

The inventory below covers the requirements explicitly present in the integration addendum and navigation request. The separate original Claude specification and its precise defaults were not found in the repository or the targeted Downloads filename search. Therefore completeness against that separate document, exact presets/defaults and screenshot fidelity remain unverified; none are silently invented or removed from scope.

## Evidence keys

- A: `src/App.tsx` — actions, state, page switching, source editing, automatic processing.
- C: `src/components/CanvasWorkspace.tsx`, `src/ui/viewport.ts`, overlay components — synchronized viewer and object manipulation.
- N: `src/components/ChapterNavigator.tsx`, `backend/chapter_routes.py`, `mangaclean/services/chapter.py` — chapter/navigation.
- T: `src/components/Typography.tsx`, `src/ui/typography.ts`, `mangaclean/core/dialogue.py`, `mangaclean/services/typesetting.py` — text model/session/renderer.
- S: `src/components/StudioShell.tsx`, `src/components/PreferencesDialog.tsx` — toolbar/inspector/settings.
- B: `backend/main.py`, `backend/automatic_processing.py`, `backend/workflow.py`, `mangaclean/services/bubble_geometry.py` — editing and processing routes.
- P: `mangaclean/services/project_io.py`, chapter codec — existing v1/v2 reading, v3 single-page and chapter-v1 persistence.
- Existing native evidence: `E:/BagassZx/Yuchi-Diagnostics/final-master-verification-20261106/FINAL_NATIVE_ACCEPTANCE_REPORT.md`; this is historical evidence on the baseline, not proof for new controls.

EXISTS means an implementation was located, not that it was retested now. MISSING means no supporting field/handler was found in the inspected paths. PARTIAL identifies a narrower existing capability. Each missing feature still requires behavior, history, persistence, export and native proof.

| Requested feature / expected behavior | Status / current location | Frontend work required | State/backend/persistence required | Test/native evidence |
|---|---|---|---|---|
| Dark workspace, compact toolbar, status | EXISTS — A/S | Preserve; extend only requested actions | None for preserved layout | Baseline screenshots; exact reference defaults unresolved |
| Expandable chapter navigator / checkboxes | EXISTS — N | Preserve | Existing disk-backed chapter | Baseline 12 native /20 backend pages |
| Synchronized Original/Editing zoom/pan | EXISTS — C | Preserve dual/single/Onion-Skin | Shared ViewportController | Baseline native; no new test |
| Import / Export / Save / Undo / Redo / Settings | EXISTS — A/S | Preserve | Existing routes/codecs | Baseline native |
| Process Automatically / universal OCR | EXISTS — A/B | Preserve one user-facing workflow | Existing bounded jobs, no mandatory Review | Baseline 139 regions /133 cleaned /6 skipped |
| Fast page navigation | PARTIAL — A/N | Immediate pending selection, light loading, stale-result protection require design/testing | Profile flush/decode/history/image encoding before choosing cache | No latency samples yet; 2–4s is user observation |
| Stable bubble IDs / direct selection | EXISTS — A/B/C | Preserve | Existing region graph | Baseline |
| Manual region creation | PARTIAL — A/B | Existing manual rectangle; clarify promotion to editable bubble | Must preserve distinction between manual text ROI, bubble and mask | Manual selection exists; new vector bubble absent |
| Delete bubble | PARTIAL — A/B | Existing exclude action; actual object deletion semantics unresolved | Keep linked text/mask/provenance safe | Exclusion is not permanent deletion |
| Move/resize /8 handles /one active layer | EXISTS — C/B | Preserve | Image-space geometry; invalidate mask preview | Baseline native handles; focused geometry tests exist |
| Properties tab | PARTIAL — S | Existing contextual Properties must become first of four tabs | Reuse existing children | Current InspectorDock has no rendered tab strip |
| Layers tab | PARTIAL — S/A | Existing visibility disclosure, not full tab/model | Extend per-page layers only after design | No ordering/locking native proof |
| Healing tab | MISSING — S | Add only with real supported actions | See brush capability below | Not verified |
| Image tab | MISSING — S | Add functional adjustments only | See adjustment state below | Not verified |
| Editable Original Source | EXISTS — A/B | Preserve field/binding | Source edits separate from raw OCR | Baseline raw OCR integrity; source binding tests exist |
| Indonesian text /live preview /no Apply gate | EXISTS — T | Preserve | TypographySession debounce/commit | Baseline native Save/Reload/export |
| Font browser/family and legal fallback | EXISTS — T | Preserve availability/actual font previews | Resolver and renderer remain authoritative | Baseline; do not download fonts |
| Font size /−/+ | EXISTS — T | Preserve requested vs fitted size | Existing size/minimum fields | Baseline |
| Size presets 1–5 | MISSING — T | Add named presets after original values known | Reuse size commit; no new schema needed for simple application | Values not supplied; no invented defaults |
| Font weight /Bold | EXISTS — T | Preserve available-face checks | Existing weight | Baseline |
| Italic | MISSING — T | Add actual-face availability handling | New model/renderer support; compatible codec needed | Cannot simulate with inert toggle |
| AA /Aa /aa transformations | MISSING — T | Three real text transformations | Existing text commit/history; casing rules require specification | Preserve raw OCR; no new test now |
| Left/center/right alignment | EXISTS — T | Preserve | Existing alignment | Baseline |
| Line height | MISSING — T | Real numeric control | Renderer metrics + optional persistence extension | Defaults and bounds unresolved |
| Letter spacing | MISSING — T | Real numeric control | Glyph layout/render/export extension | Defaults unresolved |
| Vertical offset | PARTIAL — T | Absolute Y exists; semantic offset control missing | Define offset vs geometry, avoid double applying | No dedicated offset field |
| Rotation | MISSING — T | Rotation and transformed handles | Model/renderer bounds/hit testing/export | Requires end-to-end design |
| Text width | EXISTS — T | Existing numeric width | Existing geometry | Baseline |
| Text width Auto | PARTIAL — T | Auto Fit exists; automatic width is distinct | Define auto-width algorithm without altering mask | Exact semantics/default absent |
| Auto Fit /word wrap /manual line breaks | EXISTS — T | Preserve warnings/requested vs fitted size | Existing real glyph metrics /padding | Baseline renderer/export |
| X/Y coordinates | EXISTS — T | Preserve | Existing model/commit | Baseline |
| Position nudging | MISSING — T | Step controls/keyboard integration | Reuse coordinates/history; image bounds | Step defaults unresolved |
| Reset position | MISSING — T | Reset to a defined origin | Original-vs-bubble-center policy required | Must not guess target |
| Text color | EXISTS — T | Preserve picker/hex input | Existing color | Baseline |
| Text eyedropper | MISSING — T/C | Sample intended artwork coordinate | Reuse color; handle canvas/overlay distinction | Native sampling proof needed |
| Stroke color | MISSING — T | Add functional picker | New style fields and renderer | Existing card Stroke button is disabled Planned |
| Stroke eyedropper | MISSING — T/C | Real sampling | Reuse new stroke field | No proof |
| Stroke width | MISSING — T | Real numeric control | Renderer/layout overflow and persistence | No proof |
| Copy/Paste Style | EXISTS — T | Preserve; extend field allowlist when supported | Never copy content, geometry, IDs, masks | Native cross-page /Undo/Redo/Save verified |
| Rectangle shape | MISSING — inspected model | New non-destructive editable vector object | Shape model/render/export/history/persistence | Detected ROI rectangle is not vector artwork |
| Rounded rectangle shape | MISSING | Shape control | Same vector representation | No proof |
| Circle shape | MISSING | Shape control | Same vector representation | No proof |
| Ellipse shape | MISSING | Shape control | Same vector representation | No proof |
| Speech bubble shape | MISSING | Shape/tail controls | Same vector representation | No proof |
| Add custom shape | MISSING | Creation workflow | Validated custom geometry representation | Scope and limits require design |
| Roundness presets | MISSING | Preset controls | Vector-only radius, no raster distortion | Exact preset values absent |
| Segment controls | MISSING | Conditional controls | Editable path segments/constraints | Not supported by detected-mask representation |
| Node controls | MISSING | Conditional node manipulation | Path node geometry/history/export | No proof |
| Fill | MISSING for vector bubble | Color/opacity control | Vector style; original image immutable | No proof |
| Outline | MISSING for vector bubble | Style control | Vector outline | No proof |
| Bubble type | MISSING for editable vector | Contextual choice | Explicit type semantics | Existing candidate classification not equivalent |
| Feather | MISSING for vector style | Numeric control | Vector rasterization effect, separate from cleaning mask | No proof |
| Horizontal flip | MISSING | Vector-only action | Geometry transform/history | No proof |
| Vertical flip | MISSING | Vector-only action | Geometry transform/history | No proof |
| Original/cleaned visibility | PARTIAL — A/S | Existing workspace switches | Persisted layer metadata not present | Workspace preview is not export layer ordering |
| Text object visibility | EXISTS — T/P | Preserve existing checkbox | Dialogue.visible serialized | Baseline export |
| Bubble visibility | PARTIAL — A/C | Global overlay toggle exists | Per-object persisted display vs vector visibility requires distinction | No full layer model |
| Additional image layers | MISSING | Import/select controls | Image object assets, ordering and codec extension | Major addition; not equivalent to source/working buffers |
| Layer lock/unlock | MISSING — T | Existing disabled Planned Lock is inert | Lock must gate all editing routes/gestures | Requires backend enforcement, not just UI |
| Layer ordering | MISSING — inspected model | Order controls | Unified compositing order/export and history | Dialogue list order alone insufficient |
| Selected-layer indication | PARTIAL — A/C | Existing active bubble/source/dialogue | Extend to future object types | Baseline one handle layer |
| Healing brush size/cursor | PARTIAL — A/C/B | Prepared mask brush exists | Existing safe-area clipping | Free post-clean brush not equivalent |
| Healing/inpainting strokes | PARTIAL — B | Real localized brush workflow needed | Reuse validated restoration; exact applied mask/history | No new model; source immutable |
| Healing Undo/Redo/export | PARTIAL — B/P | Preserve clean history | Existing clean results persist; free strokes not modeled | Existing clean proof not free-brush proof |
| Brightness | MISSING | Preview control | Non-destructive adjustment parameters/composite/codec | No proof |
| Contrast | MISSING | Preview control | Same | No proof |
| Other image adjustments | MISSING / unspecified | Inventory from original specification required | Do not invent list/defaults | Original prompt unavailable |
| Translate selected bubble | MISSING | Action and clear unavailable state | Provider interface and routing | Execution BLOCKED: no approved configured provider |
| Translate current page | MISSING | Action scope | Same, bounded queue | Execution BLOCKED |
| Translate all pages | MISSING | Action scope | Same, per-page failures/cancellation | Execution BLOCKED |
| Translate toolbar action | MISSING | Add requested action with honest availability | No fake output or OCR-as-translation | Not added yet |
| Provider settings/adapter | MISSING — inspected paths | Settings UI after provider design | No raw secret in project/log; integration approval required | New provider/API not authorized |
| Existing project compatibility /PNG/JPEG | EXISTS — P/B | Preserve | Existing v1/v2/v3 and chapter-v1 | Baseline native; new fields need round-trip/legacy tests |

## Confirmed inert / narrower controls

`TypographyCardControls` contains disabled Stroke and Lock buttons marked Planned. They are not implemented features. `DockTab` still defines Script/Style/Layers, but current `InspectorDock` renders contextual Properties and a visibility disclosure rather than actual four tabs. Numeric Y and width, Auto Fit, global visibility switches and manual mask correction must not be relabeled as vertical-offset, Auto-width, full persisted layers or free Healing Brush respectively.

## Existing defaults, not asserted Chisa defaults

`Dialogue`: Segoe UI, size32 native px, weight400, minimum12, black, center, visible true, Auto Fit true, padding8; geometry160×60 at0,0. These are current source defaults only. The original requested size presets, spacing, rotation, roundness and brush defaults remain unresolved until their actual specification is available.

## Implementation boundary

Retain the authorized features above in scope. Start with measured page navigation; then extend typography with one model-to-renderer-to-export path per property. Vector bubbles, full persisted layers and image adjustments require a concrete shared representation and compatibility design before implementation; do not silently overload cleaning masks or alter the project format. No ordinary safe in-scope change requires a new approval, but major architecture, incompatible formats, new dependencies or provider integrations retain the user's explicit approval gate.
