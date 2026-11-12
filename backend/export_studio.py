"""Publisher & Krita Layered Export Studio builders (.ora, .epub, .cbz, flat sequence)."""
from __future__ import annotations

import base64
from datetime import datetime, timezone
from hashlib import sha256
import html
import io
import math
import re
from pathlib import Path
from typing import Any, Literal
from uuid import uuid4
import xml.etree.ElementTree as ET
import zipfile

import cv2
import numpy as np
from PIL import Image
from pydantic import BaseModel, Field

from mangaclean.services.export_preflight import dialogue_export_issues
from mangaclean.services.typesetting import (
    TypesettingUnavailable,
    composite_page,
    dialogue_cover_rect,
    page_artwork,
    render_dialogue,
)


class KritaOptions(BaseModel):
    includeOriginal: bool = True
    includeCleaned: bool = True
    includeTypeset: bool = True
    includeRedrawSfx: bool = True
    cleanedPatchOnly: bool = True
    splitTypesetBubbles: bool = False


class MetadataOptions(BaseModel):
    seriesTitle: str = "MangaClean Project"
    chapterTitle: str = "Chapter 1"
    chapterNumber: str = "1"
    author: str = ""
    publisher: str = "Yuchi Labs — MangaClean Atelier"
    language: str = "id"
    readingDirection: Literal["rtl", "ltr"] = "rtl"
    includeCover: bool = True
    coverImagePath: str | None = None
    coverDataUrl: str | None = None


class FlatImageOptions(BaseModel):
    imageFormat: Literal["png", "jpg", "webp"] = "png"
    quality: int = Field(default=95, ge=50, le=100)
    namingPattern: Literal["page_001", "001", "series_ch_page", "original"] = "page_001"
    target: Literal["composite", "cleaned", "typeset_only"] = "composite"


class StudioExportRequest(BaseModel):
    format: Literal["krita", "epub", "cbz", "flat"]
    scope: Literal["all", "approved", "current", "range"] = "all"
    rangeExpr: str = ""
    approvedPageIds: list[str] = Field(default_factory=list)
    destinationDir: str = ""
    krita: KritaOptions = Field(default_factory=KritaOptions)
    metadata: MetadataOptions = Field(default_factory=MetadataOptions)
    flat: FlatImageOptions = Field(default_factory=FlatImageOptions)


def _safe_slug(text: str, fallback: str = "export") -> str:
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", text or "").strip("._-")
    return (slug[:64] or fallback)


def _bgr_to_pil_rgb(bgr: np.ndarray) -> Image.Image:
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return Image.fromarray(rgb, mode="RGB")


def _bgr_to_pil_rgba(bgr: np.ndarray) -> Image.Image:
    rgba = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGBA)
    return Image.fromarray(rgba, mode="RGBA")


def _encode_pil_bytes(img: Image.Image, fmt: Literal["png", "jpg", "webp"], quality: int = 95) -> bytes:
    buf = io.BytesIO()
    if fmt == "png":
        compress = max(0, min(9, int(round((100 - quality) * 0.18))))
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        img.save(buf, format="PNG", compress_level=compress)
    elif fmt == "jpg":
        if img.mode != "RGB":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == "RGBA":
                bg.paste(img, mask=img.split()[3])
            else:
                bg.paste(img)
            img = bg
        img.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "webp":
        if img.mode not in ("RGB", "RGBA"):
            img = img.convert("RGBA")
        img.save(buf, format="WEBP", quality=quality, lossless=(quality >= 100), method=4)
    return buf.getvalue()


def _parse_page_range(expr: str, total: int) -> list[int]:
    """Parse 1-based range expressions like '1-5, 8' into sorted unique 0-based indices."""
    if total <= 0:
        return []
    cleaned = (expr or "").strip()
    if not cleaned:
        raise ValueError("Enter a page range such as '1-5, 8'.")
    indices: set[int] = set()
    for token in cleaned.split(","):
        part = token.strip()
        if not part:
            continue
        if "-" in part:
            bounds = part.split("-", 1)
            if len(bounds) != 2 or not bounds[0].strip().isdigit() or not bounds[1].strip().isdigit():
                raise ValueError(f"Invalid page range segment: '{part}'.")
            start, end = int(bounds[0].strip()), int(bounds[1].strip())
            if start > end:
                start, end = end, start
            for p in range(max(1, start), min(total, end) + 1):
                indices.add(p - 1)
        elif part.isdigit():
            p = int(part)
            if 1 <= p <= total:
                indices.add(p - 1)
        else:
            raise ValueError(f"Invalid page number: '{part}'.")
    if not indices:
        raise ValueError(f"No valid pages matched '{expr}' within 1–{total}.")
    return sorted(indices)


def _render_typeset_rgba_layers(doc, *, split_bubbles: bool = False) -> tuple[Image.Image, list[tuple[str, Image.Image]], list[str]]:
    """Render all visible dialogues onto exact page-sized transparent RGBA canvases."""
    h, w = doc.source.shape[:2]
    merged = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    split_layers: list[tuple[str, Image.Image]] = []
    warnings: list[str] = []
    overlay_mode = doc.composition.get("text_mode") == "overlay"
    cover_for = (lambda d: dialogue_cover_rect(doc, d)) if overlay_mode else None

    visible_dialogues = [d for d in (doc.dialogues or []) if d.visible and (d.text or "").strip()]
    for idx, dialogue in enumerate(visible_dialogues, start=1):
        try:
            rendered = (
                render_dialogue(dialogue, doc.bubbles, cover_for(dialogue), overlay=True)
                if cover_for
                else render_dialogue(dialogue, doc.bubbles)
            )
            layer_canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0)) if split_bubbles else None

            if overlay_mode and rendered.get("coverRect") and rendered.get("coverPng"):
                cx, cy, _, _ = rendered["coverRect"]
                cover_bytes = base64.b64decode(rendered["coverPng"])
                cover_img = Image.open(io.BytesIO(cover_bytes)).convert("RGBA")
                merged.alpha_composite(cover_img, dest=(max(0, int(cx)), max(0, int(cy))))
                if layer_canvas is not None:
                    layer_canvas.alpha_composite(cover_img, dest=(max(0, int(cx)), max(0, int(cy))))

            rgba_bytes = base64.b64decode(rendered["png"])
            glyph_img = Image.open(io.BytesIO(rgba_bytes)).convert("RGBA")
            dx, dy = math.floor(dialogue.x), math.floor(dialogue.y)

            # Handle negative/out-of-bounds crop cleanly before alpha_composite
            src_x = max(0, -dx)
            src_y = max(0, -dy)
            dst_x = max(0, dx)
            dst_y = max(0, dy)
            crop_w = min(glyph_img.width - src_x, w - dst_x)
            crop_h = min(glyph_img.height - src_y, h - dst_y)
            if crop_w > 0 and crop_h > 0:
                if src_x or src_y or crop_w != glyph_img.width or crop_h != glyph_img.height:
                    glyph_img = glyph_img.crop((src_x, src_y, src_x + crop_w, src_y + crop_h))
                merged.alpha_composite(glyph_img, dest=(dst_x, dst_y))
                if layer_canvas is not None:
                    layer_canvas.alpha_composite(glyph_img, dest=(dst_x, dst_y))

            if layer_canvas is not None:
                split_layers.append((f"Bubble #{idx:02d}", layer_canvas))
        except Exception as exc:
            warnings.append(f"Dialogue #{idx} skipped in transparent layer: {exc}")

    return merged, split_layers, warnings


def _build_cleaned_layer(doc, patch_only: bool) -> Image.Image:
    """Return RGBA layer of either transparent inpaint patches only or full cleaned canvas."""
    cleaned_bgr = page_artwork(doc)
    if not patch_only:
        return _bgr_to_pil_rgba(cleaned_bgr)

    raw_bgr = doc.source
    diff_mask = np.any(cleaned_bgr != raw_bgr, axis=2)
    h, w = cleaned_bgr.shape[:2]
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    if np.any(diff_mask):
        cleaned_rgb = cv2.cvtColor(cleaned_bgr, cv2.COLOR_BGR2RGB)
        rgba[diff_mask, :3] = cleaned_rgb[diff_mask]
        rgba[diff_mask, 3] = 255
    return Image.fromarray(rgba, mode="RGBA")


def build_ora_file(doc, output_path: Path, opts: KritaOptions) -> list[str]:
    """
    Build an OpenRaster (.ora) archive readable natively by Krita with exact Z-order.
    OpenRaster stack.xml lists layers from TOP to BOTTOM (first XML child = topmost layer).
    """
    h, w = doc.source.shape[:2]
    warnings: list[str] = []

    raw_img = _bgr_to_pil_rgba(doc.source)
    cleaned_img = _build_cleaned_layer(doc, opts.cleanedPatchOnly)
    typeset_merged, typeset_splits, text_warnings = _render_typeset_rgba_layers(
        doc, split_bubbles=opts.splitTypesetBubbles
    )
    warnings.extend(text_warnings)
    sfx_blank = Image.new("RGBA", (w, h), (0, 0, 0, 0))

    # Build composite mergedimage.png following active visibility toggles
    merged = Image.new("RGBA", (w, h), (255, 255, 255, 255))
    if opts.includeOriginal:
        merged.alpha_composite(raw_img)
    if opts.includeCleaned:
        merged.alpha_composite(cleaned_img)
    if opts.includeTypeset:
        merged.alpha_composite(typeset_merged)

    thumb = merged.convert("RGB")
    thumb.thumbnail((256, 256), Image.Resampling.LANCZOS)

    # Construct OpenRaster stack.xml (TOP child first -> BOTTOM child last)
    root_el = ET.Element(
        "image",
        attrib={
            "version": "0.0.3",
            "w": str(w),
            "h": str(h),
            "xres": "72",
            "yres": "72",
        },
    )
    root_stack = ET.SubElement(root_el, "stack", attrib={"name": "MangaClean Layers"})

    def add_layer(parent: ET.Element, name: str, src: str, visible: bool = True, locked: bool = False):
        attrib = {
            "name": name,
            "src": src,
            "x": "0",
            "y": "0",
            "opacity": "1.0",
            "visibility": "visible" if visible else "hidden",
            "composite-op": "svg:src-over",
        }
        if locked:
            attrib["edit-locked"] = "true"
        ET.SubElement(parent, "layer", attrib=attrib)

    # Layer 4 (Top): 04_Redraw_SFX
    add_layer(root_stack, "4 - SFX Redraw", "data/04_Redraw_SFX.png", visible=opts.includeRedrawSfx)

    # Layer 3 (Middle-High): 03_Typeset_Text (merged or grouped stack)
    if opts.splitTypesetBubbles and typeset_splits:
        text_group = ET.SubElement(
            root_stack,
            "stack",
            attrib={
                "name": "3 - Typeset Text",
                "opacity": "1.0",
                "visibility": "visible" if opts.includeTypeset else "hidden",
                "isolation": "isolate",
            },
        )
        # Put higher-numbered bubbles above earlier ones cleanly
        for idx, (label, _) in reversed(list(enumerate(typeset_splits, start=1))):
            add_layer(
                text_group,
                f"3.{idx:02d} - {label}",
                f"data/03_Text_Bubble_{idx:02d}.png",
                visible=opts.includeTypeset,
            )
    else:
        add_layer(root_stack, "3 - Typeset Text", "data/03_Typeset_Text.png", visible=opts.includeTypeset)

    # Layer 2 (Middle-Low): 02_Cleaned_Inpaint
    add_layer(root_stack, "2 - Cleaned Artwork", "data/02_Cleaned_Inpaint.png", visible=opts.includeCleaned)

    # Layer 1 (Bottom): 01_Original_Raw (locked base reference)
    add_layer(root_stack, "1 - Original Raw", "data/01_Original_Raw.png", visible=opts.includeOriginal, locked=True)

    ET.indent(root_el, space="  ")
    stack_xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + ET.tostring(root_el, encoding="unicode")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        # OpenRaster requires 'mimetype' as the very first uncompressed ZIP entry
        zf.writestr("mimetype", b"image/openraster", compress_type=zipfile.ZIP_STORED)
        zf.writestr("stack.xml", stack_xml.encode("utf-8"))
        zf.writestr("mergedimage.png", _encode_pil_bytes(merged, "png", 95))
        zf.writestr("Thumbnails/thumbnail.png", _encode_pil_bytes(thumb, "png", 95))

        zf.writestr("data/01_Original_Raw.png", _encode_pil_bytes(raw_img, "png", 95))
        zf.writestr("data/02_Cleaned_Inpaint.png", _encode_pil_bytes(cleaned_img, "png", 95))
        if opts.splitTypesetBubbles and typeset_splits:
            for idx, (_, bubble_img) in enumerate(typeset_splits, start=1):
                zf.writestr(f"data/03_Text_Bubble_{idx:02d}.png", _encode_pil_bytes(bubble_img, "png", 95))
        else:
            zf.writestr("data/03_Typeset_Text.png", _encode_pil_bytes(typeset_merged, "png", 95))
        zf.writestr("data/04_Redraw_SFX.png", _encode_pil_bytes(sfx_blank, "png", 95))

    return warnings


def _resolve_cover_bytes(meta: MetadataOptions, fallback_page_img: Image.Image) -> tuple[bytes, str, str, int, int]:
    """Load custom cover from disk/dataUrl or fall back to rendered Page 1."""
    img: Image.Image | None = None
    if meta.coverImagePath:
        p = Path(meta.coverImagePath)
        if p.is_file():
            try:
                img = Image.open(p).convert("RGB")
            except Exception:
                img = None
    if img is None and meta.coverDataUrl and meta.coverDataUrl.startswith("data:image/"):
        try:
            _, b64 = meta.coverDataUrl.split(",", 1)
            img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")
        except Exception:
            img = None
    if img is None:
        img = fallback_page_img.convert("RGB")
    return _encode_pil_bytes(img, "jpg", 94), "image/jpeg", "jpg", img.width, img.height


def build_epub_archive(
    pages: list[tuple[str, Image.Image]],
    output_path: Path,
    meta: MetadataOptions,
    image_fmt: Literal["png", "jpg", "webp"] = "jpg",
    quality: int = 94,
) -> None:
    """Build a valid Fixed-Layout EPUB 3.0 manga/LN package with RTL/LTR support."""
    if not pages:
        raise ValueError("No pages available for EPUB export.")

    epub_ext = "png" if image_fmt == "png" else "jpg"
    epub_mime = "image/png" if epub_ext == "png" else "image/jpeg"
    book_uuid = f"urn:uuid:{uuid4()}"
    modified_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    title = f"{meta.seriesTitle} — {meta.chapterTitle}".strip(" —") or "MangaClean Export"

    manifest_items: list[str] = [
        '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
    ]
    spine_items: list[str] = []
    nav_links: list[str] = []

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("mimetype", b"application/epub+zip", compress_type=zipfile.ZIP_STORED)
        zf.writestr(
            "META-INF/container.xml",
            (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n'
                '  <rootfiles>\n'
                '    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n'
                '  </rootfiles>\n'
                '</container>\n'
            ).encode("utf-8"),
        )

        # Cover Page (optional)
        if meta.includeCover:
            cover_bytes, cover_mime, cover_ext, cw, ch = _resolve_cover_bytes(meta, pages[0][1])
            zf.writestr(f"OEBPS/Images/cover.{cover_ext}", cover_bytes)
            cover_xhtml = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!DOCTYPE html>\n'
                '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
                '  <head>\n'
                f'    <title>{html.escape(title)} — Cover</title>\n'
                f'    <meta name="viewport" content="width={cw}, height={ch}"/>\n'
                '    <style>html,body{margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden;display:flex;align-items:center;justify-content:center;}img{width:100%;height:100%;object-fit:contain;display:block;}</style>\n'
                '  </head>\n'
                f'  <body><img src="../Images/cover.{cover_ext}" alt="Cover"/></body>\n'
                '</html>\n'
            )
            zf.writestr("OEBPS/Text/cover.xhtml", cover_xhtml.encode("utf-8"))
            manifest_items.append(
                f'<item id="cover-img" href="Images/cover.{cover_ext}" media-type="{cover_mime}" properties="cover-image"/>'
            )
            manifest_items.append(
                '<item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>'
            )
            spine_items.append('<itemref idref="cover-page"/>')
            nav_links.append('        <li><a href="Text/cover.xhtml">Cover</a></li>')

        # Rendered Manga Pages
        for idx, (page_name, img) in enumerate(pages, start=1):
            pw, ph = img.size
            img_href = f"Images/page_{idx:03d}.{epub_ext}"
            text_href = f"Text/page_{idx:03d}.xhtml"
            zf.writestr(f"OEBPS/{img_href}", _encode_pil_bytes(img, "png" if epub_ext == "png" else "jpg", quality))

            page_xhtml = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!DOCTYPE html>\n'
                '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
                '  <head>\n'
                f'    <title>Page {idx:03d}</title>\n'
                f'    <meta name="viewport" content="width={pw}, height={ph}"/>\n'
                '    <style>html,body{margin:0;padding:0;background:#000;width:100%;height:100%;overflow:hidden;display:flex;align-items:center;justify-content:center;}img{width:100%;height:100%;object-fit:contain;display:block;}</style>\n'
                '  </head>\n'
                f'  <body><img src="../{img_href}" alt="Page {idx:03d} ({html.escape(page_name)})"/></body>\n'
                '</html>\n'
            )
            zf.writestr(f"OEBPS/{text_href}", page_xhtml.encode("utf-8"))
            manifest_items.append(f'<item id="img_{idx:03d}" href="{img_href}" media-type="{epub_mime}"/>')
            manifest_items.append(f'<item id="page_{idx:03d}" href="{text_href}" media-type="application/xhtml+xml"/>')
            spine_items.append(f'<itemref idref="page_{idx:03d}"/>')
            nav_links.append(f'        <li><a href="{text_href}">Page {idx}</a></li>')

        nav_xhtml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<!DOCTYPE html>\n'
            '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n'
            '  <head><title>Table of Contents</title></head>\n'
            '  <body>\n'
            '    <nav epub:type="toc" id="toc">\n'
            f'      <h1>{html.escape(title)}</h1>\n'
            '      <ol>\n'
            + "\n".join(nav_links) + "\n"
            '      </ol>\n'
            '    </nav>\n'
            '  </body>\n'
            '</html>\n'
        )
        zf.writestr("OEBPS/nav.xhtml", nav_xhtml.encode("utf-8"))

        author_xml = f"    <dc:creator>{html.escape(meta.author)}</dc:creator>\n" if meta.author.strip() else ""
        pub_xml = f"    <dc:publisher>{html.escape(meta.publisher)}</dc:publisher>\n" if meta.publisher.strip() else ""
        opf_xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="bookid" version="3.0" '
            'prefix="rendition: http://www.idpf.org/vocab/rendition/#">\n'
            '  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
            f'    <dc:identifier id="bookid">{book_uuid}</dc:identifier>\n'
            f'    <dc:title>{html.escape(title)}</dc:title>\n'
            f'{author_xml}{pub_xml}'
            f'    <dc:language>{html.escape(meta.language or "id")}</dc:language>\n'
            f'    <meta property="dcterms:modified">{modified_iso}</meta>\n'
            '    <meta property="rendition:layout">pre-paginated</meta>\n'
            '    <meta property="rendition:orientation">auto</meta>\n'
            '    <meta property="rendition:spread">landscape</meta>\n'
            '  </metadata>\n'
            '  <manifest>\n'
            + "\n".join(f"    {m}" for m in manifest_items) + "\n"
            '  </manifest>\n'
            f'  <spine page-progression-direction="{meta.readingDirection}">\n'
            + "\n".join(f"    {s}" for s in spine_items) + "\n"
            '  </spine>\n'
            '</package>\n'
        )
        zf.writestr("OEBPS/content.opf", opf_xml.encode("utf-8"))


def build_cbz_archive(
    pages: list[tuple[str, Image.Image]],
    output_path: Path,
    meta: MetadataOptions,
    image_fmt: Literal["png", "jpg", "webp"] = "png",
    quality: int = 95,
) -> None:
    """Build a .cbz Comic Book Archive with standard ComicInfo.xml metadata."""
    if not pages:
        raise ValueError("No pages available for CBZ export.")

    total_pages = len(pages) + (1 if meta.includeCover else 0)
    manga_tag = "YesAndRightToLeft" if meta.readingDirection == "rtl" else "Yes"

    root_el = ET.Element("ComicInfo")
    ET.SubElement(root_el, "Series").text = meta.seriesTitle or "MangaClean"
    ET.SubElement(root_el, "Title").text = meta.chapterTitle or ""
    ET.SubElement(root_el, "Number").text = meta.chapterNumber or ""
    if meta.author.strip():
        ET.SubElement(root_el, "Writer").text = meta.author.strip()
    if meta.publisher.strip():
        ET.SubElement(root_el, "Publisher").text = meta.publisher.strip()
    ET.SubElement(root_el, "LanguageISO").text = meta.language or "id"
    ET.SubElement(root_el, "PageCount").text = str(total_pages)
    ET.SubElement(root_el, "Manga").text = manga_tag
    pages_el = ET.SubElement(root_el, "Pages")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output_path, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        img_index = 0
        if meta.includeCover:
            cover_bytes, _, cover_ext, cw, ch = _resolve_cover_bytes(meta, pages[0][1])
            zf.writestr(f"000_cover.{cover_ext}", cover_bytes)
            ET.SubElement(
                pages_el,
                "Page",
                attrib={"Image": str(img_index), "Type": "FrontCover", "ImageWidth": str(cw), "ImageHeight": str(ch)},
            )
            img_index += 1

        for idx, (_, img) in enumerate(pages, start=1):
            filename = f"{idx:03d}.{image_fmt}"
            zf.writestr(filename, _encode_pil_bytes(img, image_fmt, quality))
            ET.SubElement(
                pages_el,
                "Page",
                attrib={
                    "Image": str(img_index),
                    "Type": "Story",
                    "ImageWidth": str(img.width),
                    "ImageHeight": str(img.height),
                },
            )
            img_index += 1

        ET.indent(root_el, space="  ")
        comic_info_xml = '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(root_el, encoding="unicode")
        zf.writestr("ComicInfo.xml", comic_info_xml.encode("utf-8"))


def _format_flat_filename(index: int, orig_name: str, opts: FlatImageOptions, meta: MetadataOptions) -> str:
    ext = "png" if opts.target == "typeset_only" else opts.imageFormat
    stem = _safe_slug(Path(orig_name).stem, f"page_{index:03d}")
    series_slug = _safe_slug(meta.seriesTitle, "manga")
    ch_slug = _safe_slug(meta.chapterNumber, "1")
    if opts.namingPattern == "001":
        base = f"{index:03d}"
    elif opts.namingPattern == "series_ch_page":
        base = f"{series_slug}_ch{ch_slug}_{index:03d}"
    elif opts.namingPattern == "original":
        base = stem
    else:
        base = f"page_{index:03d}"
    return f"{base}.{ext}"


def execute_studio_export(store, root_dir: Path, payload: StudioExportRequest) -> dict[str, Any]:
    """Execute multi-format Publisher / Krita Layered export over the active page or chapter."""
    chapter = getattr(store, "chapter", None)
    if chapter:
        chapter.flush(store)
        all_pages = chapter.pages
    elif store.document is not None:
        all_pages = [{"id": store.document.region_graph.page_id, "name": store.document.source_name}]
    else:
        raise ValueError("Open a page or chapter before exporting.")

    total = len(all_pages)
    if payload.scope == "current":
        active_id = store.document.region_graph.page_id if store.document else all_pages[0]["id"]
        selected_pages = [p for p in all_pages if p["id"] == active_id] or [all_pages[0]]
    elif payload.scope == "approved":
        approved_set = set(payload.approvedPageIds)
        selected_pages = [p for p in all_pages if p["id"] in approved_set]
        if not selected_pages:
            raise ValueError("No 100% approved pages found. Approve a page or choose another scope.")
    elif payload.scope == "range":
        idxs = _parse_page_range(payload.rangeExpr, total)
        selected_pages = [all_pages[i] for i in idxs]
    else:
        selected_pages = list(all_pages)

    # Resolve docs in order
    def _load_doc(page_entry: dict):
        pid = page_entry["id"]
        if store.document is not None and store.document.region_graph.page_id == pid:
            return store.document
        if chapter is not None:
            return chapter.decode(pid)
        return store.require()

    base_dest = (
        Path(payload.destinationDir.strip())
        if payload.destinationDir and payload.destinationDir.strip()
        else (root_dir / "outputs" / "exports")
    )
    base_dest.mkdir(parents=True, exist_ok=True)

    series_slug = _safe_slug(payload.metadata.seriesTitle, "MangaClean")
    ch_slug = _safe_slug(f"ch{payload.metadata.chapterNumber}", "ch1")
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    warnings: list[str] = []
    written_files: list[dict[str, Any]] = []

    if payload.format == "krita":
        if len(selected_pages) == 1:
            target_dir = base_dest
        else:
            target_dir = base_dest / f"{series_slug}_{ch_slug}_krita_{stamp}"
            target_dir.mkdir(parents=True, exist_ok=True)

        for idx, page_entry in enumerate(selected_pages, start=1):
            doc = _load_doc(page_entry)
            stem = _safe_slug(Path(doc.source_name).stem, f"page_{idx:03d}")
            out_file = target_dir / (f"{stem}.ora" if len(selected_pages) == 1 else f"{idx:03d}_{stem}.ora")
            if out_file.exists() and len(selected_pages) == 1:
                out_file = target_dir / f"{stem}_{stamp}.ora"
            page_warnings = build_ora_file(doc, out_file, payload.krita)
            warnings.extend(page_warnings)
            raw_bytes = out_file.read_bytes()
            written_files.append({
                "pageId": doc.region_graph.page_id,
                "path": str(out_file),
                "bytes": len(raw_bytes),
                "sha256": sha256(raw_bytes).hexdigest(),
            })

        return {
            "format": "krita",
            "directory": str(target_dir),
            "primaryPath": written_files[0]["path"] if written_files else str(target_dir),
            "files": written_files,
            "count": len(written_files),
            "warnings": warnings,
        }

    # Preflight typography check for composite/typeset publisher exports
    needs_typeset_check = (
        payload.format in {"epub", "cbz"}
        or (payload.format == "flat" and payload.flat.target in {"composite", "typeset_only"})
    )
    rendered_pages: list[tuple[str, Image.Image]] = []
    for idx, page_entry in enumerate(selected_pages, start=1):
        doc = _load_doc(page_entry)
        if needs_typeset_check:
            issues = dialogue_export_issues(doc)
            if issues:
                raise TypesettingUnavailable(
                    f"Page {idx} ({doc.source_name}) has {len(issues)} typography preflight issue(s): {issues[0]['reason']}"
                )

        if payload.format == "flat" and payload.flat.target == "cleaned":
            pil_img = _bgr_to_pil_rgb(page_artwork(doc))
        elif payload.format == "flat" and payload.flat.target == "typeset_only":
            pil_img, _, tw = _render_typeset_rgba_layers(doc, split_bubbles=False)
            warnings.extend(tw)
        else:
            pil_img = _bgr_to_pil_rgb(composite_page(doc))
        rendered_pages.append((doc.source_name, pil_img))

    if payload.format == "epub":
        out_file = base_dest / f"{series_slug}_{ch_slug}.epub"
        if out_file.exists():
            out_file = base_dest / f"{series_slug}_{ch_slug}_{stamp}.epub"
        build_epub_archive(rendered_pages, out_file, payload.metadata, image_fmt="jpg", quality=94)
        raw_bytes = out_file.read_bytes()
        written_files.append({"path": str(out_file), "bytes": len(raw_bytes), "sha256": sha256(raw_bytes).hexdigest()})
        return {
            "format": "epub",
            "directory": str(base_dest),
            "primaryPath": str(out_file),
            "files": written_files,
            "count": len(rendered_pages),
            "warnings": warnings,
        }

    if payload.format == "cbz":
        out_file = base_dest / f"{series_slug}_{ch_slug}.cbz"
        if out_file.exists():
            out_file = base_dest / f"{series_slug}_{ch_slug}_{stamp}.cbz"
        build_cbz_archive(
            rendered_pages,
            out_file,
            payload.metadata,
            image_fmt=payload.flat.imageFormat,
            quality=payload.flat.quality,
        )
        raw_bytes = out_file.read_bytes()
        written_files.append({"path": str(out_file), "bytes": len(raw_bytes), "sha256": sha256(raw_bytes).hexdigest()})
        return {
            "format": "cbz",
            "directory": str(base_dest),
            "primaryPath": str(out_file),
            "files": written_files,
            "count": len(rendered_pages),
            "warnings": warnings,
        }

    # Flat image sequence
    out_dir = (
        base_dest
        if len(rendered_pages) == 1
        else base_dest / f"{series_slug}_{ch_slug}_{stamp}"
    )
    out_dir.mkdir(parents=True, exist_ok=True)
    ext = "png" if payload.flat.target == "typeset_only" else payload.flat.imageFormat
    for idx, (orig_name, img) in enumerate(rendered_pages, start=1):
        fname = _format_flat_filename(idx, orig_name, payload.flat, payload.metadata)
        out_file = out_dir / fname
        if out_file.exists() and len(rendered_pages) == 1:
            out_file = out_dir / f"{Path(fname).stem}_{stamp}.{ext}"
        data = _encode_pil_bytes(img, ext, payload.flat.quality)
        out_file.write_bytes(data)
        written_files.append({
            "path": str(out_file),
            "bytes": len(data),
            "sha256": sha256(data).hexdigest(),
        })

    return {
        "format": "flat",
        "directory": str(out_dir),
        "primaryPath": written_files[0]["path"] if written_files else str(out_dir),
        "files": written_files,
        "count": len(written_files),
        "warnings": warnings,
    }
