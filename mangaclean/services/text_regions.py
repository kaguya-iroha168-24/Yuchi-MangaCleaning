"""Locate lettering separately from bubble containers."""
import cv2
import numpy as np

from mangaclean.core.region_graph import MAX_REGIONS, TextRegion
from mangaclean.core.suggestions import overlap
from mangaclean.services.ogkalu_text import DETECTOR, detect_text_bubbles


TEXT_DETECTION_ORIGIN = 'automatic_text_detection'


def split_dialogue_columns(bubble, ink=None):
    """Use a strong gutter in the existing interior ink to separate two blocks."""
    x, y, width, height = bubble.rect
    if ink is None:
        ink = cv2.bitwise_and(bubble.text, bubble.interior)
    if width < 90 or cv2.countNonZero(ink) < 100:
        return ()
    count, _, stats, centroids = cv2.connectedComponentsWithStats(ink)
    if count < 7:
        return ()
    glyph_height = float(np.median(stats[1:, cv2.CC_STAT_HEIGHT]))
    edge = max(18, round(2 * glyph_height))
    window = max(3, round(.35 * glyph_height))
    if width <= 2 * edge:
        return ()
    projection = np.count_nonzero(ink, axis=0)
    smooth = np.convolve(projection, np.ones(window) / window, mode='same')
    cumulative = np.cumsum(projection)
    total = cumulative[-1]
    left_peak = np.maximum.accumulate(smooth)
    right_peak = np.maximum.accumulate(smooth[::-1])[::-1]
    cuts = []
    for col in range(edge, width - edge):
        if min(cumulative[col-1], total - cumulative[col-1]) < .17 * total:
            continue
        peak = min(left_peak[col-1], right_peak[col])
        if peak and smooth[col] <= .18 * peak:
            cuts.append((smooth[col] / peak, col))
    if not cuts:
        return ()
    best = min(score for score, _ in cuts)
    # Prefer the middle of a wide, empty gutter.
    middle = int(np.median([col for score, col in cuts if score == best]))
    cut = min(cuts, key=lambda item: (item[0], abs(item[1]-middle)))[1]
    left_components = np.count_nonzero(centroids[1:, 0] < cut)
    if min(left_components, count-1-left_components) < 3:
        return ()
    regions = []
    for left, right in ((0, cut), (cut, width)):
        _, top, ink_width, ink_height = cv2.boundingRect(ink[:, left:right])
        if min(ink_width, ink_height) < 2 * glyph_height:
            return ()
        padding = max(8, round(1.2 * glyph_height))
        upper, lower = max(0, top-padding), min(height, top+ink_height+padding)
        regions.append((x+left, y+upper, right-left, lower-upper))
    return tuple(regions)


def text_layout_rect(region, bubble):
    provenance = region.provenance
    layout = provenance.get('layout_rect')
    if (bubble is not None and isinstance(layout, (list, tuple)) and len(layout) == 4
            and all(type(v) is int for v in layout) and provenance.get('detected_rect') == list(region.rect)):
        x, y, w, h = layout
        bx, by, bw, bh = bubble.rect
        rx, ry, rw, rh = region.rect
        if bx <= x <= rx < rx+rw <= x+w <= bx+bw and by <= y <= ry < ry+rh <= y+h <= by+bh:
            return tuple(layout)
    return region.rect


def _extend_vertical_column(image, rect):
    x, y, w, h = rect
    H, W = image.shape[:2]
    if h < 2.2 * w or y + h >= H - 5:
        return rect
    col_x0 = max(0, x - 2)
    col_x1 = min(W, x + w + 2)
    max_down = min(H, y + h + int(h * 0.6) + 80)
    strip = image[y+h:max_down, col_x0:col_x1]
    if strip.size == 0:
        return rect
    strip_gray = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY) if strip.ndim == 3 else strip
    otsu_val, _ = cv2.threshold(strip_gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    thresh = min(205, max(30, int(otsu_val)))
    ink = cv2.inRange(strip_gray, 0, thresh)
    row_counts = np.count_nonzero(ink, axis=1)
    extended_h = h
    consecutive_empty = 0
    for r_idx, cnt in enumerate(row_counts):
        if cnt >= 2:
            extended_h = h + r_idx + 1
            consecutive_empty = 0
        else:
            consecutive_empty += 1
            if consecutive_empty > 24:
                break
    return (x, y, w, extended_h)


def locate_text(image, bubbles, include_free_text=False):
    """Detect on the original page and link to a containing bubble when available."""
    detections = detect_text_bubbles(image, include_free_text=include_free_text) if include_free_text else detect_text_bubbles(image)
    for rect, score in detections:
        rect = _extend_vertical_column(image, rect)
        containing = [bubble for bubble in bubbles if overlap(rect, bubble.rect)[1] == 1]
        bubble = min(containing, key=lambda b: b.rect[2] * b.rect[3], default=None)
        if bubble is None or not bubble.provenance.get('excluded'):
            yield rect, bubble.id if bubble is not None else None, score


def merge_text_candidates(graph, candidates, dialogues):
    """Replace unused bubble placeholders and retain edited or linked regions."""
    linked_ids = {layer.source_region_id for layer in dialogues}
    owners = {bubble_id for _, bubble_id, _ in candidates if bubble_id is not None}
    for region in tuple(graph.text_regions):
        provenance = region.provenance
        origin = provenance.get('origin')
        legacy = origin == TEXT_DETECTION_ORIGIN and provenance.get('detector') != DETECTOR
        placeholder = origin == 'automatic_bubble_text_region' and region.bubble_id in owners
        moved = provenance.get('detected_rect', list(region.rect)) != list(region.rect)
        if ((legacy or placeholder) and region.id not in linked_ids and not moved
                and not region.source_text and not provenance.get('source_manually_corrected')
                and not provenance.get('ocr')):
            graph.remove(region.id)
    detected = {
        (tuple(region.provenance.get('detected_rect', region.rect)), region.bubble_id)
        for region in graph.text_regions if region.provenance.get('origin') == TEXT_DETECTION_ORIGIN
    }
    retained = tuple(graph.text_regions)
    for rect, bubble_id, score in candidates:
        if len(graph.text_regions) >= MAX_REGIONS:
            break
        if (rect, bubble_id) in detected:
            continue
        if any(overlap(rect, region.rect)[0] >= .5 for region in retained):
            continue
        graph.add(TextRegion(rect=rect, bubble_id=bubble_id, provenance={
            'origin': TEXT_DETECTION_ORIGIN, 'detected_rect': list(rect), 'layout_rect': list(rect),
            'detector': DETECTOR, 'confidence': score,
        }))
        detected.add((rect, bubble_id))
    return len(detected)
