# Chisa editor additive implementation plan — 7 November 2026

User approved implementation of the existing addendum/inventory; ordinary safe changes proceed without another design gate. No commit/push is authorized. Branch must remain feature/chisa-editor-enhancements. Do not repeat navigation investigation or overwrite the stable release.

## Design and compatibility

Reuse TypographySession for all existing Dialogue-field edits, its selective subscriptions, font cache, preview worker, history and codecs. First add missing controls expressible as existing fields: explicit case transforms, image-bounded native-pixel nudging and centering. No new schema/renderer effect for this slice. Case transforms modify Indonesian Dialogue only, never source OCR. AA=uppercase; Aa=word-title case; aa=lowercase, with whitespace/manual breaks preserved. Nudges use1 native pixel, Shift10; centering uses the linked bubble rectangle, otherwise page rectangle. These are explicit implementation choices, not asserted missing reference defaults. Use names/tooltips that state their behavior.

Restore actual Properties/Layers navigation using current working inspector children. Keep mask correction available through existing preparation/brush controls. Do not create fake Healing or Image-adjustment controls before their real data/render paths exist. Full four-tab acceptance remains incomplete until those paths pass.

## Tasks

1. [x] Run the typography/session/style baseline and write focused behavior tests for the new controls.
2. [x] Add TypographySession methods and Inspector buttons using existing preview and history paths.
3. [x] Add functional Properties/Layers tabs and verify selected-layer binding.
4. [x] Assess missing controls and record the approval boundary for vector shapes, persistent layers and image adjustments in the data-model proposal.
5. [x] Run focused tests and native acceptance for this slice in separate test releases. See the checkpoint for the exact display, performance and native resize/reopen coverage.
6. [x] Update the inventory and checkpoint with test results and limitations.

## Review focus

- Rapid input reads current drafts rather than stale props.
- Page switches flush pending edits; old-page requests cannot target the new page.
- Case/position edits leave raw OCR, source artwork, cleaning masks and other Dialogue objects intact.
- No control claims unsupported renderer effects or guessed reference presets.
- Undo/Redo and codec behavior remain the established semantics; geometry stays within image bounds.
