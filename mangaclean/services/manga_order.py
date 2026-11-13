"""Manga RTL reading-order sorting, bubble/region merge, split, and box expansion."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import replace
import re
from typing import Callable, Iterable, Sequence, TypeVar
from uuid import uuid4

import cv2
import numpy as np

from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.dialogue import Dialogue, manga_lettering
from mangaclean.core.region_graph import RegionGraph, TextRegion

T = TypeVar('T')
Rect = tuple[int, int, int, int]


def _rect_metrics(rect: Sequence[float | int]) -> tuple[float, float, float, float, float, float, float]:
    x, y, w, h = float(rect[0]), float(rect[1]), max(1.0, float(rect[2])), max(1.0, float(rect[3]))
    return x, y, w, h, x + w / 2.0, y + h / 2.0, x + w, y + h  # noqa: F841


def _box_data(item: T, get_rect: Callable[[T], Sequence[float | int]], index: int) -> dict:
    rect = get_rect(item)
    x, y = float(rect[0]), float(rect[1])
    w, h = max(1.0, float(rect[2])), max(1.0, float(rect[3]))
    return {
        'item': item,
        'index': index,
        'x': x,
        'y': y,
        'w': w,
        'h': h,
        'right': x + w,
        'bot': y + h,
        'cx': x + w / 2.0,
        'cy': y + h / 2.0,
    }


def sort_items_manga_rtl(items: Iterable[T], get_rect: Callable[[T], Sequence[float | int]]) -> list[T]:
    """2-Stage Panel-Band RTL Algorithm:
    Stage 1: Sort initially by centerY ascending and group into horizontal bands
             whenever vertical overlap >= 30% of the shorter box height.
    Stage 2: Sort bands Top-to-Bottom by min top; within each band group stacked
             columns (horizontal overlap >= 40% of narrower box width) sorted
             Top-to-Bottom, and sort columns Right-to-Left (centerX descending).
    """
    entries = [_box_data(item, get_rect, idx) for idx, item in enumerate(items)]
    if len(entries) <= 1:
        return [e['item'] for e in entries]

    entries.sort(key=lambda e: (e['cy'], e['y'], -e['cx'], e['index']))

    bands: list[list[dict]] = []
    for entry in entries:
        best_band = None
        best_ratio = 0.0
        for band in reversed(bands):
            band_max_ratio = 0.0
            for member in band:
                overlap_y = min(entry['bot'], member['bot']) - max(entry['y'], member['y'])
                if overlap_y > 0:
                    ratio = overlap_y / min(entry['h'], member['h'])
                    if ratio > band_max_ratio:
                        band_max_ratio = ratio
            if band_max_ratio >= 0.30 and band_max_ratio > best_ratio:
                best_ratio = band_max_ratio
                best_band = band
        if best_band is not None:
            best_band.append(entry)
        else:
            bands.append([entry])

    bands.sort(key=lambda b: (min(e['y'] for e in b), min(e['cy'] for e in b)))

    ordered: list[T] = []
    for band in bands:
        n = len(band)
        parent = list(range(n))

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        def union(a: int, b: int) -> None:
            ra, rb = find(a), find(b)
            if ra != rb:
                parent[rb] = ra

        for i in range(n):
            for j in range(i + 1, n):
                overlap_x = min(band[i]['right'], band[j]['right']) - max(band[i]['x'], band[j]['x'])
                if overlap_x > 0 and overlap_x / min(band[i]['w'], band[j]['w']) >= 0.40:
                    union(i, j)

        columns: dict[int, list[dict]] = {}
        for i, entry in enumerate(band):
            columns.setdefault(find(i), []).append(entry)

        col_groups = list(columns.values())
        for col in col_groups:
            col.sort(key=lambda e: (e['cy'], e['y'], -e['cx'], e['index']))

        col_groups.sort(key=lambda col: (-(sum(e['cx'] for e in col) / len(col)), min(e['cy'] for e in col)))
        for col in col_groups:
            ordered.extend(e['item'] for e in col)

    return ordered


def _align_dialogues_order(doc) -> None:
    if not doc.dialogues:
        return
    region_rank = {rid: idx for idx, rid in enumerate(doc.region_graph.reading_order)}
    bubble_rank = {b.id: idx for idx, b in enumerate(doc.bubbles)}

    def dialogue_key(d: Dialogue) -> tuple[int, int, float, float]:
        if d.source_region_id and d.source_region_id in region_rank:
            return (0, region_rank[d.source_region_id], d.y, -d.x)
        if d.bubble_id and d.bubble_id in bubble_rank:
            return (0, bubble_rank[d.bubble_id], d.y, -d.x)
        return (1, 0, d.y, -d.x)

    doc.dialogues = sorted(doc.dialogues, key=dialogue_key)


def sort_document_rtl(doc, *, sort_text_regions_list: bool = True, align_dialogues: bool = True) -> None:
    """Sort bubbles and reading_order into Manga RTL order."""
    if doc.bubbles:
        doc.bubbles = sort_items_manga_rtl(doc.bubbles, lambda b: b.rect)
    if doc.region_graph and doc.region_graph.text_regions:
        graph = deepcopy(doc.region_graph)
        if doc.bubbles:
            bubble_rank = {b.id: idx for idx, b in enumerate(doc.bubbles)}
            linked = [r for r in graph.text_regions if r.bubble_id in bubble_rank]
            free = [r for r in graph.text_regions if r.bubble_id not in bubble_rank]
            # Sort globally by effective rect (parent bubble rect if single, else own rect) for unified RTL order,
            # keeping siblings inside the same parent bubble together in RTL sub-order.
            grouped_by_bubble: dict[str, list[TextRegion]] = {}
            for r in linked:
                grouped_by_bubble.setdefault(r.bubble_id, []).append(r)
            representatives: list[tuple[str, Rect, list[TextRegion]]] = []
            for bid, regs in grouped_by_bubble.items():
                sorted_subs = sort_items_manga_rtl(regs, lambda r: r.rect)
                parent_bubble = next(b for b in doc.bubbles if b.id == bid)
                representatives.append(('bubble', parent_bubble.rect, sorted_subs))
            for r in free:
                representatives.append(('free', r.rect, [r]))
            ordered_reps = sort_items_manga_rtl(representatives, lambda rep: rep[1])
            regions_sorted: list[TextRegion] = []
            for _, _, regs in ordered_reps:
                regions_sorted.extend(regs)
        else:
            regions_sorted = sort_items_manga_rtl(graph.text_regions, lambda r: r.rect)
        graph.reading_order = [r.id for r in regions_sorted]
        if sort_text_regions_list:
            graph.text_regions = regions_sorted
        graph.validate(doc.source.shape, doc.bubbles)
        doc.region_graph = graph
    if align_dialogues:
        _align_dialogues_order(doc)


def smart_split_text(text: str) -> tuple[str, str]:
    """Split text cleanly along lines, sentence boundaries, or leave in Box 1."""
    trimmed = (text or '').strip()
    if not trimmed:
        return ('', '')
    lines = [line.strip() for line in trimmed.splitlines() if line.strip()]
    if len(lines) >= 2:
        mid = (len(lines) + 1) // 2
        return ('\n'.join(lines[:mid]), '\n'.join(lines[mid:]))
    sentences = [s.strip() for s in re.split(r'(?<=[.!?])\s+', trimmed) if s.strip()]
    if len(sentences) >= 2:
        total = sum(len(s) for s in sentences)
        acc = 0
        split_at = 1
        best_diff = float('inf')
        for idx in range(1, len(sentences)):
            acc += len(sentences[idx - 1])
            diff = abs(acc - (total - acc))
            if diff < best_diff:
                best_diff = diff
                split_at = idx
        return (' '.join(sentences[:split_at]), ' '.join(sentences[split_at:]))
    return (trimmed, '')


def _copy_mask_region(
    target_shape: tuple[int, int],
    sources: Sequence[tuple[Rect, np.ndarray | None]],
    dst_rect: Rect,
) -> np.ndarray | None:
    dx, dy, dw, dh = dst_rect
    if not any(arr is not None for _, arr in sources):
        return None
    out = np.zeros(target_shape, np.uint8)
    for (sx, sy, sw, sh), arr in sources:
        if arr is None:
            continue
        lx0 = max(sx, dx)
        ly0 = max(sy, dy)
        lx1 = min(sx + sw, dx + dw)
        ly1 = min(sy + sh, dy + dh)
        if lx1 > lx0 and ly1 > ly0:
            out[ly0 - dy:ly1 - dy, lx0 - dx:lx1 - dx] |= arr[ly0 - sy:ly1 - sy, lx0 - sx:lx1 - sx]
    return out


def _copy_bgr_region(
    source_image: np.ndarray,
    patches: Sequence[tuple[Rect, np.ndarray | None]],
    dst_rect: Rect,
) -> np.ndarray | None:
    if not any(arr is not None for _, arr in patches):
        return None
    dx, dy, dw, dh = dst_rect
    out = source_image[dy:dy + dh, dx:dx + dw].copy()
    for (sx, sy, sw, sh), arr in patches:
        if arr is None:
            continue
        lx0 = max(sx, dx)
        ly0 = max(sy, dy)
        lx1 = min(sx + sw, dx + dw)
        ly1 = min(sy + sh, dy + dh)
        if lx1 > lx0 and ly1 > ly0:
            out[ly0 - dy:ly1 - dy, lx0 - dx:lx1 - dx] = arr[ly0 - sy:ly1 - sy, lx0 - sx:lx1 - sx]
    return out


def _clip_rect_bounds(rect: tuple[int, int, int, int], shape: tuple[int, ...]) -> Rect:
    H, W = int(shape[0]), int(shape[1])
    x, y, w, h = rect
    x0 = max(0, int(x))
    y0 = max(0, int(y))
    x1 = min(W, int(x) + max(8, int(w)))
    y1 = min(H, int(y) + max(8, int(h)))
    if x1 - x0 < 8 or y1 - y0 < 8:
        raise ValueError('Region exceeds valid page bounds (minimum 8 × 8 pixels).')
    return (x0, y0, x1 - x0, y1 - y0)


def expand_rect(rect: Rect, shape: tuple[int, ...], padding_ratio: float = 0.15) -> Rect:
    x, y, w, h = rect
    H, W = int(shape[0]), int(shape[1])
    ew = max(4, round(w * padding_ratio))
    eh = max(4, round(h * padding_ratio))
    dx = ew // 2
    dy = eh // 2
    x0 = max(0, x - dx)
    y0 = max(0, y - dy)
    x1 = min(W, x + w + (ew - dx))
    y1 = min(H, y + h + (eh - dy))
    return (x0, y0, max(8, x1 - x0), max(8, y1 - y0))


def expand_bubble_in_doc(doc, bubble: Bubble, padding_ratio: float = 0.15) -> tuple[Rect, str]:
    new_rect = expand_rect(bubble.rect, doc.source.shape, padding_ratio)
    nx, ny, nw, nh = new_rect
    kx = max(3, (abs(nw - bubble.rect[2]) + 1) | 1)
    ky = max(3, (abs(nh - bubble.rect[3]) + 1) | 1)

    interior = _copy_mask_region((nh, nw), [(bubble.rect, bubble.interior)], new_rect)
    assert interior is not None
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (min(kx, 51), min(ky, 51)))
    expanded_interior = cv2.dilate(interior, kernel)
    # Keep 2px outer border clear if expanded so renderer padding stays safe
    if nw > 8 and nh > 8:
        expanded_interior[:2, :] = 0
        expanded_interior[-2:, :] = 0
        expanded_interior[:, :2] = 0
        expanded_interior[:, -2:] = 0
    interior = np.maximum(interior, expanded_interior)

    text_mask = _copy_mask_region((nh, nw), [(bubble.rect, bubble.text)], new_rect)
    assert text_mask is not None
    seg = _copy_mask_region((nh, nw), [(bubble.rect, bubble.segmentation)], new_rect)
    if seg is not None:
        seg = np.maximum(seg, interior)
    last_applied = _copy_mask_region((nh, nw), [(bubble.rect, bubble.last_applied_mask)], new_rect)
    last_before = _copy_bgr_region(doc.source, [(bubble.rect, bubble.last_before)], new_rect)

    replacement = deepcopy(bubble)
    replacement.rect = new_rect
    replacement.interior = interior
    replacement.text = text_mask
    replacement.segmentation = seg
    replacement.last_applied_mask = last_applied
    replacement.last_before = last_before
    replacement.__dict__.pop('contours', None)

    doc.bubbles = [replacement if b.id == bubble.id else b for b in doc.bubbles]

    graph = deepcopy(doc.region_graph)
    linked_region_ids = set()
    for reg in graph.text_regions:
        if reg.bubble_id == bubble.id:
            reg.rect = new_rect
            linked_region_ids.add(reg.id)
    graph.validate(doc.source.shape, doc.bubbles)
    doc.region_graph = graph

    doc.dialogues = [
        replace(d, x=float(nx), y=float(ny), width=float(nw), height=float(nh))
        if (d.bubble_id == bubble.id or (d.source_region_id and d.source_region_id in linked_region_ids))
        else d
        for d in doc.dialogues
    ]
    return new_rect, bubble.id


def expand_text_region_in_doc(doc, region: TextRegion, padding_ratio: float = 0.15) -> Rect:
    new_rect = expand_rect(region.rect, doc.source.shape, padding_ratio)
    nx, ny, nw, nh = new_rect
    graph = deepcopy(doc.region_graph)
    target = graph.region(region.id)
    assert target is not None
    target.rect = new_rect
    graph.validate(doc.source.shape, doc.bubbles)
    doc.region_graph = graph
    doc.dialogues = [
        replace(d, x=float(nx), y=float(ny), width=float(nw), height=float(nh))
        if d.source_region_id == region.id
        else d
        for d in doc.dialogues
    ]
    return new_rect


def _region_ocr_text(region: TextRegion) -> str:
    if region.source_text and region.source_text.strip():
        return region.source_text.strip()
    ocr = region.provenance.get('ocr') or {}
    text = ocr.get('edited_text') if ocr.get('edited_text') is not None else ocr.get('raw_text')
    return (text or '').strip()


def merge_bubbles_in_doc(doc, bubble_ids: Sequence[str]) -> str:
    id_set = set(bubble_ids)
    targets = [b for b in doc.bubbles if b.id in id_set]
    if len(targets) < 2 or len(targets) != len(id_set):
        raise ValueError('Select at least 2 valid bubble regions to merge.')

    ordered = sort_items_manga_rtl(targets, lambda b: b.rect)
    first = ordered[0]
    first_pos = min(doc.bubbles.index(b) for b in ordered)

    region_ids = {r.id for r in doc.region_graph.text_regions if r.bubble_id in id_set}
    linked_dialogues = [
        d for d in doc.dialogues
        if d.bubble_id in id_set or (d.source_region_id and d.source_region_id in region_ids)
    ]
    if any(d.locked for d in linked_dialogues):
        raise PermissionError('Unlock linked dialogue layers before merging these bubbles.')

    ux = min(b.rect[0] for b in ordered)
    uy = min(b.rect[1] for b in ordered)
    ur = max(b.rect[0] + b.rect[2] for b in ordered)
    ub = max(b.rect[1] + b.rect[3] for b in ordered)
    union_rect = _clip_rect_bounds((ux, uy, ur - ux, ub - uy), doc.source.shape)
    nx, ny, nw, nh = union_rect

    interior = _copy_mask_region((nh, nw), [(b.rect, b.interior) for b in ordered], union_rect)
    assert interior is not None
    text_mask = _copy_mask_region((nh, nw), [(b.rect, b.text) for b in ordered], union_rect)
    assert text_mask is not None
    seg = _copy_mask_region((nh, nw), [(b.rect, b.segmentation) for b in ordered], union_rect)
    last_applied = _copy_mask_region((nh, nw), [(b.rect, b.last_applied_mask) for b in ordered], union_rect)
    last_before = _copy_bgr_region(doc.source, [(b.rect, b.last_before) for b in ordered], union_rect)

    # Combine OCR text & translated dialogue text in strict RTL order
    ocr_parts: list[str] = []
    trans_parts: list[str] = []
    template_dialogue: Dialogue | None = None
    for b in ordered:
        b_regs = sort_items_manga_rtl(
            [r for r in doc.region_graph.text_regions if r.bubble_id == b.id],
            lambda r: r.rect,
        )
        for r in b_regs:
            t = _region_ocr_text(r)
            if t:
                ocr_parts.append(t)
            for d in doc.dialogues:
                if d.source_region_id == r.id and d not in linked_dialogues:
                    linked_dialogues.append(d)
        b_reg_ids = {r.id for r in b_regs}
        b_dlgs = [
            d for d in linked_dialogues
            if d.bubble_id == b.id or (d.source_region_id and d.source_region_id in b_reg_ids)
        ]
        for d in b_dlgs:
            if template_dialogue is None:
                template_dialogue = d
            if d.text and d.text.strip():
                trans_parts.append(d.text.strip())

    merged_ocr = '\n'.join(ocr_parts)
    trans_joiner = '\n' if any('\n' in part for part in trans_parts) else ' '
    merged_trans = trans_joiner.join(trans_parts)

    merged_text_regions: list[Rect] = []
    for b in ordered:
        merged_text_regions.extend(b.text_regions)

    merged_id = uuid4().hex
    all_manual = all(b.provenance.get('manual_region') is True for b in ordered)
    all_cleaned = all(b.cleaning_status == 'Cleaned' for b in ordered)
    merged_bubble = Bubble(
        rect=union_rect,
        interior=interior,
        text=text_mask,
        method=first.method,
        confidence=first.confidence,
        reviewed=all(b.reviewed for b in ordered),
        glyph_count=sum(b.glyph_count for b in ordered),
        id=merged_id,
        segmentation=seg,
        text_regions=tuple(merged_text_regions),
        shape_status=first.shape_status,
        provenance={
            'provider': 'manual_region' if all_manual else first.provenance.get('provider'),
            'manual_region': all_manual,
            'merged_from': [b.id for b in ordered],
        },
        review_decision='Accepted' if all(b.review_decision == 'Accepted' for b in ordered) else first.review_decision,
        candidate_kind=first.candidate_kind,
        cleaning_status='Cleaned' if all_cleaned else first.cleaning_status,
        cleaning_message=first.cleaning_message,
        last_applied_mask=last_applied,
        last_before=last_before,
    )

    remaining_bubbles = [b for b in doc.bubbles if b.id not in id_set]
    remaining_bubbles.insert(min(first_pos, len(remaining_bubbles)), merged_bubble)
    doc.bubbles = remaining_bubbles

    # Update region graph
    graph = deepcopy(doc.region_graph)
    first_order_idx = min(
        (graph.reading_order.index(rid) for rid in region_ids if rid in graph.reading_order),
        default=len(graph.reading_order),
    )
    for rid in region_ids:
        graph.remove(rid)
    merged_reg_prov: dict = {'origin': 'merged_region', 'detected_rect': list(union_rect), 'layout_rect': list(union_rect)}
    if merged_ocr:
        merged_reg_prov['ocr'] = {
            'status': 'Accepted',
            'raw_text': merged_ocr,
            'edited_text': merged_ocr,
            'confidence': None,
            'provider': 'merged',
            'model_id': 'merged',
            'device': 'cpu',
            'region_rect': list(union_rect),
        }
    merged_region = TextRegion(
        rect=union_rect,
        bubble_id=merged_id,
        source_text=merged_ocr,
        provenance=merged_reg_prov,
    )
    graph.text_regions.append(merged_region)
    insert_at = min(first_order_idx, len(graph.reading_order))
    graph.reading_order.insert(insert_at, merged_region.id)
    doc.region_graph = graph

    # Replace merged dialogues cleanly
    removed_dialogue_ids = {d.id for d in linked_dialogues}
    remaining_dialogues = [d for d in doc.dialogues if d.id not in removed_dialogue_ids]
    if template_dialogue is not None or merged_trans:
        base_attrs = (
            {
                'family': template_dialogue.family,
                'weight': template_dialogue.weight,
                'size': template_dialogue.size,
                'minimum_size': template_dialogue.minimum_size,
                'alignment': template_dialogue.alignment,
                'color': template_dialogue.color,
                'visible': template_dialogue.visible,
                'auto_fit': template_dialogue.auto_fit,
                'padding': template_dialogue.padding,
                'style': deepcopy(template_dialogue.style),
            }
            if template_dialogue is not None
            else manga_lettering(nw, nh, doc.source.shape)
        )
        merged_dialogue = Dialogue(
            text=merged_trans,
            bubble_id=merged_id,
            source_region_id=merged_region.id,
            x=float(nx),
            y=float(ny),
            width=float(nw),
            height=float(nh),
            **base_attrs,
        )
        merged_dialogue.validate()
        remaining_dialogues.append(merged_dialogue)
    doc.dialogues = remaining_dialogues

    sort_document_rtl(doc, sort_text_regions_list=True, align_dialogues=True)
    return merged_id


def _split_rect_pair(rect: Rect) -> tuple[Rect, Rect]:
    x, y, w, h = rect
    gap = 4
    if w >= h:
        if w < 20:
            raise ValueError('Selected box is too small horizontally to split into two regions.')
        left_w = (w - gap) // 2
        right_w = w - gap - left_w
        if left_w < 8 or right_w < 8:
            raise ValueError('Selected box is too small to split into two valid regions.')
        # Vertical cut: Box 1 = Right (1st in Manga RTL), Box 2 = Left (2nd)
        rect1 = (x + left_w + gap, y, right_w, h)
        rect2 = (x, y, left_w, h)
    else:
        if h < 20:
            raise ValueError('Selected box is too small vertically to split into two regions.')
        top_h = (h - gap) // 2
        bot_h = h - gap - top_h
        if top_h < 8 or bot_h < 8:
            raise ValueError('Selected box is too small to split into two valid regions.')
        # Horizontal cut: Box 1 = Top (1st), Box 2 = Bottom (2nd)
        rect1 = (x, y, w, top_h)
        rect2 = (x, y + top_h + gap, w, bot_h)
    return rect1, rect2


def _rect_intersects(a: Rect, b: Rect) -> bool:
    return min(a[0] + a[2], b[0] + b[2]) > max(a[0], b[0]) and min(a[1] + a[3], b[1] + b[3]) > max(a[1], b[1])


def split_bubble_in_doc(doc, bubble: Bubble) -> tuple[str, str, str]:
    if len(doc.bubbles) >= 200:
        raise ValueError('This page already has the maximum 200 bubble regions.')
    linked_regions = [r for r in doc.region_graph.text_regions if r.bubble_id == bubble.id]
    linked_region_ids = {r.id for r in linked_regions}
    linked_dialogues = [
        d for d in doc.dialogues
        if d.bubble_id == bubble.id or (d.source_region_id and d.source_region_id in linked_region_ids)
    ]
    if any(d.locked for d in linked_dialogues):
        raise PermissionError('Unlock linked dialogue layers before splitting this bubble.')

    rect1, rect2 = _split_rect_pair(bubble.rect)

    ocr_combined = '\n'.join(
        t for t in (_region_ocr_text(r) for r in sort_items_manga_rtl(linked_regions, lambda r: r.rect)) if t
    )
    ocr1, ocr2 = smart_split_text(ocr_combined)

    trans_combined = '\n'.join(d.text.strip() for d in linked_dialogues if d.text and d.text.strip())
    trans1, trans2 = smart_split_text(trans_combined)

    template_dialogue = linked_dialogues[0] if linked_dialogues else None

    children: list[Bubble] = []
    child_regions: list[TextRegion] = []
    child_dialogues: list[Dialogue] = []

    for child_rect, ocr_txt, trans_txt in ((rect1, ocr1, trans1), (rect2, ocr2, trans2)):
        cx, cy, cw, ch = child_rect
        interior = _copy_mask_region((ch, cw), [(bubble.rect, bubble.interior)], child_rect)
        assert interior is not None
        text_mask = _copy_mask_region((ch, cw), [(bubble.rect, bubble.text)], child_rect)
        assert text_mask is not None
        seg = _copy_mask_region((ch, cw), [(bubble.rect, bubble.segmentation)], child_rect)
        last_applied = _copy_mask_region((ch, cw), [(bubble.rect, bubble.last_applied_mask)], child_rect)
        last_before = _copy_bgr_region(doc.source, [(bubble.rect, bubble.last_before)], child_rect)
        sub_regs = tuple(r for r in bubble.text_regions if _rect_intersects(r, child_rect))

        cid = uuid4().hex
        child_bubble = Bubble(
            rect=child_rect,
            interior=interior,
            text=text_mask,
            method=bubble.method,
            confidence=bubble.confidence,
            reviewed=bubble.reviewed,
            glyph_count=max(0, bubble.glyph_count // 2),
            id=cid,
            segmentation=seg,
            text_regions=sub_regs,
            shape_status=bubble.shape_status,
            provenance=dict({k: v for k, v in bubble.provenance.items() if k != 'geometry_basis_v1'}, split_from=bubble.id),
            review_decision=bubble.review_decision,
            candidate_kind=bubble.candidate_kind,
            cleaning_status=bubble.cleaning_status,
            cleaning_message=bubble.cleaning_message,
            last_applied_mask=last_applied,
            last_before=last_before,
        )
        children.append(child_bubble)

        reg_prov: dict = {'origin': 'split_region', 'detected_rect': list(child_rect), 'layout_rect': list(child_rect)}
        if ocr_txt:
            reg_prov['ocr'] = {
                'status': 'Needs Review',
                'raw_text': ocr_txt,
                'edited_text': ocr_txt,
                'confidence': None,
                'provider': 'split',
                'model_id': 'split',
                'device': 'cpu',
                'region_rect': list(child_rect),
            }
        creg = TextRegion(rect=child_rect, bubble_id=cid, source_text=ocr_txt, provenance=reg_prov)
        child_regions.append(creg)

        if template_dialogue is not None or trans_txt:
            attrs = (
                {
                    'family': template_dialogue.family,
                    'weight': template_dialogue.weight,
                    'size': template_dialogue.size,
                    'minimum_size': template_dialogue.minimum_size,
                    'alignment': template_dialogue.alignment,
                    'color': template_dialogue.color,
                    'visible': template_dialogue.visible,
                    'auto_fit': template_dialogue.auto_fit,
                    'padding': template_dialogue.padding,
                    'style': deepcopy(template_dialogue.style),
                }
                if template_dialogue is not None
                else manga_lettering(cw, ch, doc.source.shape)
            )
            cdlg = Dialogue(
                text=trans_txt,
                bubble_id=cid,
                source_region_id=creg.id,
                x=float(cx),
                y=float(cy),
                width=float(cw),
                height=float(ch),
                **attrs,
            )
            cdlg.validate()
            child_dialogues.append(cdlg)

    idx = doc.bubbles.index(bubble)
    doc.bubbles = [*doc.bubbles[:idx], *children, *doc.bubbles[idx + 1:]]

    graph = deepcopy(doc.region_graph)
    first_order_idx = min(
        (graph.reading_order.index(rid) for rid in linked_region_ids if rid in graph.reading_order),
        default=len(graph.reading_order),
    )
    for rid in linked_region_ids:
        graph.remove(rid)
    for creg in child_regions:
        graph.text_regions.append(creg)
    for offset, creg in enumerate(child_regions):
        graph.reading_order.insert(min(first_order_idx + offset, len(graph.reading_order)), creg.id)
    doc.region_graph = graph

    removed_d_ids = {d.id for d in linked_dialogues}
    remaining_d = [d for d in doc.dialogues if d.id not in removed_d_ids]
    if len(remaining_d) + len(child_dialogues) > 200:
        raise ValueError('At most 200 editable text layers are supported.')
    doc.dialogues = [*remaining_d, *child_dialogues]

    sort_document_rtl(doc, sort_text_regions_list=True, align_dialogues=True)
    focus_id = children[0].id if trans2.strip() else children[1].id
    return children[0].id, children[1].id, focus_id


def merge_text_regions_in_doc(doc, region_ids: Sequence[str]) -> str:
    id_set = set(region_ids)
    targets = [r for r in doc.region_graph.text_regions if r.id in id_set]
    if len(targets) < 2 or len(targets) != len(id_set):
        raise ValueError('Select at least 2 text regions to merge.')
    ordered = sort_items_manga_rtl(targets, lambda r: r.rect)
    linked_dialogues = [d for d in doc.dialogues if d.source_region_id in id_set]
    if any(d.locked for d in linked_dialogues):
        raise PermissionError('Unlock linked dialogue layers before merging these regions.')

    ux = min(r.rect[0] for r in ordered)
    uy = min(r.rect[1] for r in ordered)
    ur = max(r.rect[0] + r.rect[2] for r in ordered)
    ub = max(r.rect[1] + r.rect[3] for r in ordered)
    union_rect = _clip_rect_bounds((ux, uy, ur - ux, ub - uy), doc.source.shape)
    nx, ny, nw, nh = union_rect

    ocr_parts = [_region_ocr_text(r) for r in ordered if _region_ocr_text(r)]
    merged_ocr = '\n'.join(ocr_parts)
    trans_parts: list[str] = []
    template_dialogue: Dialogue | None = None
    for r in ordered:
        for d in linked_dialogues:
            if d.source_region_id == r.id:
                if template_dialogue is None:
                    template_dialogue = d
                if d.text and d.text.strip():
                    trans_parts.append(d.text.strip())
    trans_joiner = '\n' if any('\n' in p for p in trans_parts) else ' '
    merged_trans = trans_joiner.join(trans_parts)

    graph = deepcopy(doc.region_graph)
    insert_idx = min(
        (graph.reading_order.index(r.id) for r in ordered if r.id in graph.reading_order),
        default=len(graph.reading_order),
    )
    bubble_id = ordered[0].bubble_id if all(r.bubble_id == ordered[0].bubble_id for r in ordered) else None
    for rid in id_set:
        graph.remove(rid)
    prov: dict = {'origin': 'merged_region', 'detected_rect': list(union_rect), 'layout_rect': list(union_rect)}
    if merged_ocr:
        prov['ocr'] = {
            'status': 'Accepted', 'raw_text': merged_ocr, 'edited_text': merged_ocr,
            'confidence': None, 'provider': 'merged', 'model_id': 'merged', 'device': 'cpu',
            'region_rect': list(union_rect),
        }
    merged_region = TextRegion(rect=union_rect, bubble_id=bubble_id, source_text=merged_ocr, provenance=prov)
    graph.text_regions.append(merged_region)
    graph.reading_order.insert(min(insert_idx, len(graph.reading_order)), merged_region.id)
    graph.validate(doc.source.shape, doc.bubbles)
    doc.region_graph = graph

    removed_d = {d.id for d in linked_dialogues}
    remaining_d = [d for d in doc.dialogues if d.id not in removed_d]
    if template_dialogue is not None or merged_trans:
        attrs = (
            {
                'family': template_dialogue.family, 'weight': template_dialogue.weight,
                'size': template_dialogue.size, 'minimum_size': template_dialogue.minimum_size,
                'alignment': template_dialogue.alignment, 'color': template_dialogue.color,
                'visible': template_dialogue.visible, 'auto_fit': template_dialogue.auto_fit,
                'padding': template_dialogue.padding, 'style': deepcopy(template_dialogue.style),
            }
            if template_dialogue is not None else manga_lettering(nw, nh, doc.source.shape)
        )
        mdlg = Dialogue(
            text=merged_trans, bubble_id=bubble_id, source_region_id=merged_region.id,
            x=float(nx), y=float(ny), width=float(nw), height=float(nh), **attrs,
        )
        mdlg.validate()
        remaining_d.append(mdlg)
    doc.dialogues = remaining_d
    sort_document_rtl(doc, sort_text_regions_list=True, align_dialogues=True)
    return merged_region.id


def split_text_region_in_doc(doc, region: TextRegion) -> tuple[str, str, str]:
    linked_dialogues = [d for d in doc.dialogues if d.source_region_id == region.id]
    if any(d.locked for d in linked_dialogues):
        raise PermissionError('Unlock linked dialogue layers before splitting this region.')
    rect1, rect2 = _split_rect_pair(region.rect)
    ocr1, ocr2 = smart_split_text(_region_ocr_text(region))
    trans_combined = '\n'.join(d.text.strip() for d in linked_dialogues if d.text and d.text.strip())
    trans1, trans2 = smart_split_text(trans_combined)
    template_dialogue = linked_dialogues[0] if linked_dialogues else None

    graph = deepcopy(doc.region_graph)
    insert_idx = graph.reading_order.index(region.id) if region.id in graph.reading_order else len(graph.reading_order)
    graph.remove(region.id)

    child_regions: list[TextRegion] = []
    child_dialogues: list[Dialogue] = []
    for crect, ocr_txt, trans_txt in ((rect1, ocr1, trans1), (rect2, ocr2, trans2)):
        prov: dict = {'origin': 'split_region', 'detected_rect': list(crect), 'layout_rect': list(crect)}
        if ocr_txt:
            prov['ocr'] = {
                'status': 'Needs Review', 'raw_text': ocr_txt, 'edited_text': ocr_txt,
                'confidence': None, 'provider': 'split', 'model_id': 'split', 'device': 'cpu',
                'region_rect': list(crect),
            }
        creg = TextRegion(rect=crect, bubble_id=region.bubble_id, source_text=ocr_txt, provenance=prov)
        child_regions.append(creg)
        graph.text_regions.append(creg)
        if template_dialogue is not None or trans_txt:
            attrs = (
                {
                    'family': template_dialogue.family, 'weight': template_dialogue.weight,
                    'size': template_dialogue.size, 'minimum_size': template_dialogue.minimum_size,
                    'alignment': template_dialogue.alignment, 'color': template_dialogue.color,
                    'visible': template_dialogue.visible, 'auto_fit': template_dialogue.auto_fit,
                    'padding': template_dialogue.padding, 'style': deepcopy(template_dialogue.style),
                }
                if template_dialogue is not None else manga_lettering(crect[2], crect[3], doc.source.shape)
            )
            cdlg = Dialogue(
                text=trans_txt, bubble_id=region.bubble_id, source_region_id=creg.id,
                x=float(crect[0]), y=float(crect[1]), width=float(crect[2]), height=float(crect[3]),
                **attrs,
            )
            cdlg.validate()
            child_dialogues.append(cdlg)

    for offset, creg in enumerate(child_regions):
        graph.reading_order.insert(min(insert_idx + offset, len(graph.reading_order)), creg.id)
    graph.validate(doc.source.shape, doc.bubbles)
    doc.region_graph = graph

    removed_d = {d.id for d in linked_dialogues}
    remaining_d = [d for d in doc.dialogues if d.id not in removed_d]
    if len(remaining_d) + len(child_dialogues) > 200:
        raise ValueError('At most 200 editable text layers are supported.')
    doc.dialogues = [*remaining_d, *child_dialogues]
    sort_document_rtl(doc, sort_text_regions_list=True, align_dialogues=True)
    focus_id = child_regions[0].id if trans2.strip() else child_regions[1].id
    return child_regions[0].id, child_regions[1].id, focus_id
