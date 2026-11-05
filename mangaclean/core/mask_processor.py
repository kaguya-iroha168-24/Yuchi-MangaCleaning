from __future__ import annotations

import cv2
import numpy as np

Rect = tuple[int, int, int, int]  # x, y, width, height; exclusive right/bottom


def validate_image(image: np.ndarray) -> None:
    if not isinstance(image, np.ndarray) or image.dtype != np.uint8:
        raise ValueError('Image must contain 8-bit pixels.')
    if image.ndim != 3 or image.shape[2] != 3 or min(image.shape[:2]) < 1:
        raise ValueError('A nonempty three-channel BGR image is required.')


def validate_mask(mask: np.ndarray, shape: tuple[int, ...]) -> None:
    if not isinstance(mask, np.ndarray) or mask.ndim != 2 or mask.shape != shape[:2] or mask.dtype != np.uint8:
        raise ValueError('Mask must be uint8 with the same dimensions as the source.')
    if np.any((mask != 0) & (mask != 255)):
        raise ValueError('Mask pixels must be 0 (preserve) or 255 (remove).')


def clip_rect(rect: Rect, shape: tuple[int, ...]) -> Rect:
    x, y, w, h = map(int, rect)
    if w <= 0 or h <= 0:
        raise ValueError('Select a rectangle with a positive width and height.')
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(shape[1], x + w), min(shape[0], y + h)
    if x1 <= x0 or y1 <= y0:
        raise ValueError('The selected region is outside the image.')
    return x0, y0, x1 - x0, y1 - y0


def dilate_mask(mask: np.ndarray, radius: int = 1) -> np.ndarray:
    """Cover anti-aliased glyph edges with a small elliptical dilation."""
    if not 0 <= radius <= 3:
        raise ValueError('Mask dilation must be between 0 and 3 pixels.')
    if radius == 0:
        return mask.copy()
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius + 1,) * 2)
    return cv2.dilate(mask, kernel)


def paint_stroke(mask: np.ndarray, start: tuple[int, int], end: tuple[int, int],
                 diameter: int, add: bool = True) -> None:
    """Paint a continuous stroke in native image coordinates, in place."""
    if not 1 <= diameter <= 160:
        raise ValueError('Brush diameter must be between 1 and 160 pixels.')
    color = 255 if add else 0
    cv2.line(mask, start, end, color, diameter, lineType=cv2.LINE_8)
    radius = diameter // 2
    cv2.circle(mask, start, radius, color, -1)
    cv2.circle(mask, end, radius, color, -1)
