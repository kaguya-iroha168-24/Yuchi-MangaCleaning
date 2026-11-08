# Chisa persistent editing extensions — proposed, not applied

**R7 implementation status:** approved and applied for Typography, Layers and Image on the Chisa branch. The historical proposal below explains the original compatibility decision. See [R7 acceptance and rollback](R7_V4_ACCEPTANCE.md) for implemented behavior and test evidence.

## R6 decision for review

Propose **v4 only for new copies that use extended typography, persistent layer operations, or non-destructive image adjustments**. Gemini translations use the existing Dialogue text field. Manual bubble regions and Healing round-trip through v3. The latest scope excludes editable Bubble Shape controls, so vector shapes are outside this proposal.

- Current readers reject unknown manifest keys, unknown assets and unknown Dialogue constructor fields. Existing Bubble/TextRegion provenance can describe the origin of those objects. Storing typography effects there would let an older build silently render different pixels and would leave unlinked Dialogue objects without a valid owner.
- Add a validated `composition` object only in v4. Start with styles keyed by Dialogue ID: italic face, line height, letter spacing, vertical offset, rotation, auto-width policy and stroke color/width. Extend it to layer order/locks and brightness/contrast once the preview/export paths are shared. Omitted styles preserve existing rendering defaults.
- Continue reading v1–v3 and exporting regular v3 projects when no extension is used. Opening a v3 file creates no migration. Saving extended edits creates a separate v4 copy. Keep the original v3 as the rollback file; the stable reader must reject v4 explicitly. PNG/JPEG remains available for flattened distribution. No silent v4-to-v3 downgrade.
- Affected paths for the first slice: `mangaclean/services/project_io.py`, `mangaclean/core/dialogue.py`, renderer and font resolver, backend snapshot/validation, the chapter container compatibility checks, and the Typography Inspector. Verify v1/v2/v3 reading, old-reader rejection of v4, malformed field rejection, mixed-page chapter Save/Reload, Undo/Redo, default-pixel parity and preview/PNG/JPEG consistency for each style.

The sections below preserve the original checkpoint reasoning. Where their scope mentions vector bubbles or a missing Gemini integration, the R6 scope above and the current feature inventory take precedence.

Scope boundary: this document requests review of the **new persistent composition/layer representation**, not another approval for the safe case/position/selection controls already implemented. No schema/model/renderer change described below has been applied. The current release remains single-page v3/chapter-v1 with its established fields.

## Why a shared representation is required

The current Document contains source/working pixels, masks, detected bubbles, source TextRegions and Dialogue objects. A detected bubble is not an editable vector artwork layer. There is no persisted common visibility/lock/order state for heterogeneous objects or non-destructive image adjustments. Reusing segmentation masks for these features would violate the protection requirements.

## Proposed compatible storage

Source inspection confirms that current v1/v2/v3 readers reject unknown top-level manifest keys (`project_io.py` checks the allowed set). Therefore `extensions.chisa` cannot silently be added to v3. **Propose explicit single-page v4 for extended compositions**, saved as a new file; continue reading v1/v2/v3 without migrating originals. The chapter container should remain compatible with existing page packaging where possible, while accurately declaring the contained page version. Older stable readers will not open v4; they must receive a clear unsupported-version message, not silently drop edits. Keep v3 output available for unextended projects. This version/representation change requires separate approval before implementation.

The ROI mask-loss repair uses only the existing bounded Bubble provenance dictionary (`geometry_basis_v1`, lossless PNGs within its existing20,000-character limit). It does not add a top-level field, version or new dependency; current codec round-trip tests cover it. Oversized bases are rejected atomically instead of saving incompatible projects. This narrow fix is distinct from the proposed general layer format.

Proposed data:

| Extension | Required contents | Purpose |
|---|---|---|
| typography by Dialogue ID | italic; line-height multiplier; letter spacing; vertical alignment/offset; rotation; stroke color/width; width-auto policy | Real renderer/export effects without altering OCR, text content or mask geometry |
| vector bubbles | stable ID; optional linked detector bubble ID; native rect; shape preset; path nodes/segments; fill/outline; roundness; feather; flips | New non-destructive vector artwork, never a replacement mask |
| layers | stable ID; supported object kind/reference; visibility; lock; ordering | Shared preview/export order and backend-enforced locks |
| image adjustment | brightness/contrast parameters on working image layer | Non-destructive Editing-only adjustment; Original remains raw |

Defaults must reproduce current pixels: no italic, no rotation/stroke/letter spacing/offset; current line-height metric factor1.08; current center vertical alignment; visible/unlocked current layers; identity image adjustments. These are compatibility defaults, not asserted Chisa reference values. Missing original preset1–5/roundness/segment default numbers are still required to claim exact fidelity; do not guess them silently.

## Implementation and safety

1. Prove compatible codec extension handling and default-pixel parity against captured current renderer outputs.
2. Add optional typography effects with actual font-face availability, glyph metrics, word-preserving wrapping, safe overflow, history and Copy Style allowlist. Preserve existing worker and dependencies. No synthetic claim that a missing italic face exists.
3. Introduce vector objects and render them separately from detector ROI/masks. Segment/Node tools operate only on supported vector paths. Original detector identity and segmentation remain untouched.
4. Layer locks must be enforced by routes and canvas interactions. Order/visibility use the same compositor for preview/export. Batch sliders/drags into one history operation.
5. Reuse current cleaning infrastructure for localized healing strokes, preserving source pixels and validating exact stroke masks. Do not add a generative model. Fail safely rather than silently clipping or enlarging masks.
6. Apply image adjustments in that compositor with bounded preview work; preserve original assets and intended exported composition.
7. Verify older saved projects, per-page isolation,12-page navigation/history, zero outside-mask cleaning changes, PNG/JPEG parity, native controls, resource hashes and Normal Close before releasing an extended executable.

## Translation boundary

No approved configured provider was found in the inventory. Provider/action plumbing may be added without an external call; actual translation remains BLOCKED until a named provider and secure configuration are separately approved. No API key in projects/logs, no fabricated output, and no new model/dependency download. Missing translation must never block detection, OCR, cleaning, manual Indonesian text, save or export.

## Review decision

Approval requested only for the new optional composition/layer extension and corresponding renderer work. An incompatible codec revision, new external translation service, model, dependency or environment modification would still need separate approval. This proposal is not a claim that these controls exist or that all Chisa parity is complete.
