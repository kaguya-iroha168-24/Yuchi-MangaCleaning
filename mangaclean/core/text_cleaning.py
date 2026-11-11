"""Explicit human selection/brush cleanup; no detector, dataset or model needed."""
from dataclasses import dataclass

import cv2
import numpy as np

from .inpainting import inpaint
from .mask_processor import Rect, dilate_mask, validate_image, validate_mask

TELEA = 'Telea Inpainting'
WHITE = 'White Bubble Clean'
AUTO = 'Auto / Recommended'
NS = 'Navier-Stokes Inpainting'
NO_TEXT = 'No removable text pixels were found. Try selecting the text more precisely or use the mask brush.'


@dataclass(frozen=True)
class TextSelection:
    rect: Rect
    mask: np.ndarray  # cropped native-resolution binary mask


@dataclass(frozen=True)
class CleanResult:
    image: np.ndarray
    masked_pixels: int
    changed_pixels: int
    method: str
    decision_reason: str = ''
    outside_changed_pixels: int = 0
    dark_pixels_before: int = 0
    dark_pixels_after: int = 0


def selection_rect(image: np.ndarray, rect: Rect) -> Rect:
    validate_image(image)
    if rect is None or len(rect) != 4:
        raise ValueError('Select a text area inside a white bubble first.')
    values = tuple(map(int, rect))
    if values != tuple(rect):
        raise ValueError('Selection coordinates must be whole source pixels.')
    x, y, w, h = values
    if min(w, h) < 8:
        raise ValueError('Select a text area at least 8 × 8 source pixels.')
    if x < 0 or y < 0 or x+w > image.shape[1] or y+h > image.shape[0]:
        raise ValueError('Selection is outside the image.')
    return values


def selection_mask(image: np.ndarray, rect: Rect, padding: int = 2) -> TextSelection:
    """Extract dark characters from a user-confirmed light ROI, not a box fill.

    Unlike the page detector, a large glyph in a tight ROI is allowed. Components
    touching the ROI edge are excluded to help protect bubble outlines. Explicit
    selection supplies the text-area evidence; this function does not recognize text.
    """
    x, y, w, h = selection_rect(image, rect)
    gray = cv2.cvtColor(image[y:y+h, x:x+w], cv2.COLOR_BGR2GRAY)
    if np.mean(gray >= 205) < .5:
        raise ValueError('Select dark text on a plain white or near-white background; use the mask brush for other areas.')
    threshold, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    ink = cv2.inRange(gray, 0, min(205, max(45, int(threshold))))
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    keep = np.zeros(count, np.uint8)
    for k in range(1, count):
        cx, cy, cw, ch, area = map(int, stats[k])
        if (cx <= 0 or cy <= 0 or cx+cw >= w or cy+ch >= h
                or area < 2 or area > .5*w*h):
            continue
        keep[k] = 255
    mask = dilate_mask(keep[labels], radius=padding)
    mask[[0, -1], :] = 0
    mask[:, [0, -1]] = 0
    return TextSelection((x, y, w, h), mask)


def _background_samples(image, mask, interior):
    x, y, w, h = cv2.boundingRect(mask)
    x0, y0 = max(0, x-8), max(0, y-8)
    x1, y1 = min(image.shape[1], x+w+8), min(image.shape[0], y+h+8)
    crop, local = image[y0:y1, x0:x1], mask[y0:y1, x0:x1]
    vicinity = cv2.dilate(local, np.ones((15, 15), np.uint8))
    eligible = (vicinity > 0) & (local == 0)
    if interior is not None:
        eligible &= interior[y0:y1, x0:x1] > 0
    samples = crop[eligible]
    bright = np.min(samples, axis=1) >= 205
    light = samples[bright]
    uniform = (len(light) >= 32 and np.mean(bright) >= .98
               and np.max(np.percentile(light, 95, axis=0)-np.percentile(light, 5, axis=0)) <= 10)
    return light, bool(uniform)


def restore_text(image: np.ndarray, mask: np.ndarray, method: str = TELEA,
                 radius: float = 3., interior: np.ndarray | None = None) -> CleanResult:
    """Return a new working image, touching only explicitly masked pixels."""
    validate_image(image)
    validate_mask(mask, image.shape)
    pixels = cv2.countNonZero(mask)
    if not pixels:
        raise ValueError(NO_TEXT)
    if interior is not None:
        validate_mask(interior, image.shape)
        if np.any((mask > 0) & (interior == 0)):
            raise ValueError('Text mask extends outside the validated bubble interior.')
    reason = 'Explicit restoration method.'
    if method in (AUTO, WHITE):
        samples, uniform = _background_samples(image, mask, interior)
        if method == AUTO:
            method = WHITE if uniform else TELEA
            reason = ('Local background is >=98% light, with 5th–95th percentile color spread <=10.'
                      if uniform else 'Local background is not confidently uniform and light; using Telea.')
        elif not uniform:
            raise ValueError('The local background is not uniformly light. Refine the mask or choose Telea Inpainting.')
    if method == TELEA:
        output = inpaint(image, mask, radius, flag=cv2.INPAINT_TELEA)
    elif method == NS:
        output = inpaint(image, mask, radius, flag=cv2.INPAINT_NS)
    elif method == WHITE:
        background = np.median(samples, axis=0).astype(np.uint8)
        output = image.copy()
        output[mask > 0] = background
    else:
        raise ValueError(f'Unsupported restoration method: {method}')
    difference = cv2.absdiff(output, image)
    unchanged = cv2.inRange(difference, (0, 0, 0), (0, 0, 0))
    changed = image.shape[0]*image.shape[1]-cv2.countNonZero(unchanged)
    outside = cv2.countNonZero(((unchanged == 0) & (mask == 0)).astype(np.uint8))
    dark_before = int(np.count_nonzero(cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)[mask > 0] < 205))
    dark_after = int(np.count_nonzero(cv2.cvtColor(output, cv2.COLOR_BGR2GRAY)[mask > 0] < 205))
    return CleanResult(output, pixels, changed, method, reason, outside, dark_before, dark_after)


def synthesize_texture_block(image: np.ndarray, rect: Rect) -> np.ndarray | None:
    """Synthesize background texture (screentone / vertical hatching) across a horizontal text region."""
    x, y, w, h = rect
    if w < 1.5 * h:
        return None
    H, W = image.shape[:2]
    pad = min(25, max(8, int(h * 0.4)))
    top_y0 = max(0, y - pad)
    bot_y1 = min(H, y + h + pad)

    top_strip = image[top_y0:y, x:x+w]
    bot_strip = image[y+h:bot_y1, x:x+w]
    if top_strip.size == 0 and bot_strip.size == 0:
        return None

    top_gray = cv2.cvtColor(top_strip, cv2.COLOR_BGR2GRAY) if top_strip.size > 0 else None
    bot_gray = cv2.cvtColor(bot_strip, cv2.COLOR_BGR2GRAY) if bot_strip.size > 0 else None

    col_std_top = float(np.std(np.mean(top_gray, axis=0))) if top_gray is not None and top_gray.shape[0] >= 3 else 0.0
    col_std_bot = float(np.std(np.mean(bot_gray, axis=0))) if bot_gray is not None and bot_gray.shape[0] >= 3 else 0.0

    if max(col_std_top, col_std_bot) < 10.0 and (bot_gray is None or np.mean(bot_gray) > 240):
        return None

    recon = np.zeros((h, w, 3), dtype=np.uint8)
    for r in range(h):
        alpha = r / max(1, h - 1)
        for c in range(w):
            t_pix = top_strip[-1, c].astype(float) if top_strip.size > 0 else np.array([255., 255., 255.])
            b_pix = bot_strip[0, c].astype(float) if bot_strip.size > 0 else np.array([255., 255., 255.])
            if np.mean(t_pix) > 235 and np.mean(b_pix) < 225 and bot_strip.size > 0:
                sample_r = r % bot_strip.shape[0]
                recon[r, c] = bot_strip[sample_r, c]
            elif np.mean(b_pix) > 235 and np.mean(t_pix) < 225 and top_strip.size > 0:
                sample_r = r % top_strip.shape[0]
                recon[r, c] = top_strip[sample_r, c]
            else:
                recon[r, c] = np.clip((1 - alpha) * t_pix + alpha * b_pix, 0, 255).astype(np.uint8)
    return recon

