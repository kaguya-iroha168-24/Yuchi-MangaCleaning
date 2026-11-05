from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .mask_processor import Rect, clip_rect, dilate_mask, validate_image


@dataclass(frozen=True)
class DetectionResult:
    mask: np.ndarray
    regions: tuple[Rect, ...]
    component_count: int


def _sum_rect(integral: np.ndarray, x: int, y: int, w: int, h: int) -> float:
    return float(integral[y + h, x + w] - integral[y, x + w]
                 - integral[y + h, x] + integral[y, x])


def detect_text(image: np.ndarray, roi: Rect | None = None) -> DetectionResult:
    """Find small dark glyph-like components surrounded by a light background.

    Global detection requires groups of at least two components. Selection mode
    tolerates isolated glyphs, but still rejects outlines, edge-touching objects,
    and large/dense shapes. Boxes organize candidates; only glyph pixels enter
    the mask. This is a heuristic detector, not text recognition.
    """
    validate_image(image)
    x0, y0, rw, rh = clip_rect(roi, image.shape) if roi else (
        0, 0, image.shape[1], image.shape[0])
    if min(rw, rh) < 8:
        raise ValueError('Select a region at least 8 × 8 pixels.')
    gray = cv2.cvtColor(image[y0:y0 + rh, x0:x0 + rw], cv2.COLOR_BGR2GRAY)
    # Otsu separates high-contrast ink; the cap avoids treating gray tone as ink.
    threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = cv2.inRange(gray, 0, min(185, max(45, int(threshold))))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    scale = max(0.65, min(3.0, min(image.shape[:2]) / 800))
    min_area, max_side = max(3, int(5 * scale**2)), int(90 * scale)
    inset = 2 if roi else 1
    light = cv2.integral((gray >= 205).astype(np.uint8), sdepth=cv2.CV_64F)
    accepted: list[int] = []
    for label in range(1, count):
        x, y, w, h, area = map(int, stats[label])
        if (area < min_area or max(w, h) > max_side or min(w, h) < 2
                or max(w / h, h / w) > 7 or area / (w * h) < 0.07):
            continue
        if x < inset or y < inset or x + w > rw - inset or y + h > rh - inset:
            continue
        # Solid large shapes and components that occupy much of a selection
        # are more likely artwork than a glyph.
        if area > 0.025 * rw * rh or (area / (w * h) > 0.92 and min(w, h) > 12 * scale):
            continue
        pad = max(3, int(min(w, h) * 0.65))
        ax, ay = max(0, x - pad), max(0, y - pad)
        bx, by = min(rw, x + w + pad), min(rh, y + h + pad)
        ring_area = (bx - ax) * (by - ay) - w * h
        white_ring = (_sum_rect(light, ax, ay, bx - ax, by - ay)
                      - _sum_rect(light, x, y, w, h)) / max(1, ring_area)
        if white_ring < (0.58 if roi else 0.72):
            continue
        accepted.append(label)
    full_mask = np.zeros(image.shape[:2], np.uint8)
    if not accepted:
        return DetectionResult(full_mask, (), 0)
    keep = np.zeros(count, np.uint8)
    keep[accepted] = 255
    glyphs = keep[labels]
    med_w = max(3, int(np.median(stats[accepted, cv2.CC_STAT_WIDTH])))
    med_h = max(3, int(np.median(stats[accepted, cv2.CC_STAT_HEIGHT])))
    # Group both reading directions; this grouping image never becomes the mask.
    horizontal = cv2.dilate(glyphs, np.ones((max(3, med_h // 2), med_w * 2 + 1), np.uint8))
    vertical = cv2.dilate(glyphs, np.ones((med_h * 2 + 1, max(3, med_w // 2)), np.uint8))
    groups_n, groups, _, _ = cv2.connectedComponentsWithStats(horizontal | vertical)
    members: dict[int, list[int]] = {}
    for label in accepted:
        x, y, w, h, _ = map(int, stats[label])
        local_y, local_x = np.nonzero(labels[y:y + h, x:x + w] == label)
        group = int(groups[y + local_y[0], x + local_x[0]])
        members.setdefault(group, []).append(label)
    final_labels: list[int] = []
    regions: list[Rect] = []
    for group in range(1, groups_n):
        ids = members.get(group, [])
        if len(ids) < (1 if roi else 2):
            continue
        boxes = stats[ids]
        x, y = int(boxes[:, 0].min()), int(boxes[:, 1].min())
        w = int((boxes[:, 0] + boxes[:, 2]).max()) - x
        h = int((boxes[:, 1] + boxes[:, 3]).max()) - y
        # Repeated nearly identical dots and huge merged groups are typical
        # screentone, not a safe text target. Apply this in selection mode too.
        areas = boxes[:, cv2.CC_STAT_AREA]
        if len(ids) > 200 or (len(ids) > 40 and np.std(areas) / np.mean(areas) < 0.12):
            continue
        # Groups made entirely of flat strokes (eyes, mouths, short speed
        # lines) have little character evidence. ROI remains more permissive.
        if not roi and np.count_nonzero(boxes[:, 3] >= boxes[:, 2] * 0.55) < 2:
            continue
        if not roi and w * h > 0.35 * rw * rh:
            continue
        if not roi and (sum(int(stats[i, 4]) for i in ids) / (w * h) > 0.62
                        or _sum_rect(light, x, y, w, h) / (w * h) < 0.48):
            continue
        final_labels.extend(ids)
        regions.append((x0 + x, y0 + y, w, h))
    keep[:] = 0
    keep[final_labels] = 255
    local_mask = dilate_mask(keep[labels], radius=1)
    local_mask[:inset] = 0
    local_mask[-inset:] = 0
    local_mask[:, :inset] = 0
    local_mask[:, -inset:] = 0
    full_mask[y0:y0 + rh, x0:x0 + rw] = local_mask
    return DetectionResult(full_mask, tuple(sorted(regions, key=lambda r: (r[1], r[0]))), len(final_labels))
