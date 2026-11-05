"""CPU bubble candidates. All masks/rectangles use original image coordinates."""
from dataclasses import dataclass, field
from uuid import uuid4
from functools import cached_property

import cv2
import numpy as np

from .detector import detect_text
from .mask_processor import Rect, clip_rect, validate_image, validate_mask
from .text_cleaning import selection_mask
from .suggestions import inactive_suggestion


@dataclass
class Bubble:
    rect: Rect
    interior: np.ndarray  # cropped safe interior, uint8 0/255
    text: np.ndarray      # cropped glyph mask, never the bounding rectangle
    method: str = 'Classical CV'
    confidence: float | None = None
    reviewed: bool = False
    glyph_count: int = 0
    id: str = field(default_factory=lambda: uuid4().hex)
    segmentation: np.ndarray | None = None  # native resolution, cropped to rect (not display-scaled)
    text_regions: tuple[Rect, ...] = ()  # native page coordinates
    shape_status: str = 'Legacy interior; verify shape'
    provenance: dict = field(default_factory=dict)
    review_decision: str = 'Needs Review'
    candidate_kind: str = 'Unclassified'
    cleaning_status: str = 'Needs Review'
    cleaning_message: str = ''
    last_applied_mask: np.ndarray | None = None
    last_before: np.ndarray | None = None

    def full_segmentation(self, shape):
        result=np.zeros(shape[:2],np.uint8)
        x,y,w,h=self.rect
        pixels=self.segmentation if self.segmentation is not None else self.interior
        validate_mask(pixels,(h,w));result[y:y+h,x:x+w]=pixels
        return result

    @cached_property
    def contours(self):
        mask=self.segmentation if self.segmentation is not None else self.interior
        found,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        offset=np.array(self.rect[:2],np.int32)
        return [cv2.approxPolyDP(c,.6,True).reshape(-1,2)+offset for c in found]

    def contains(self,x,y):
        a,b,w,h=self.rect
        if not (a<=x<a+w and b<=y<b+h):return False
        mask=self.segmentation if self.segmentation is not None else self.interior
        return bool(mask[int(y-b),int(x-a)])


def estimate_bubble(image: np.ndarray, rect: Rect, manual: bool = False, padding: int = 2) -> Bubble:
    validate_image(image)
    rect = clip_rect(rect, image.shape)
    x, y, w, h = rect
    if min(w, h) < 8:
        raise ValueError('Bubble must be at least 8 × 8 source pixels.')
    crop = image[y:y+h, x:x+w]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    white = cv2.inRange(gray, 205, 255)
    manual_text = selection_mask(crop, (0, 0, w, h), padding).mask if np.mean(gray >= 205) >= .5 else None
    count, labels, stats, _ = cv2.connectedComponentsWithStats(white)
    choices = []
    for k in range(1, count):
        a, b, cw, ch, area = stats[k]
        # A closed white interior must be separated from the ROI boundary.
        if a > 0 and b > 0 and a+cw < w and b+ch < h and area > 0.05*w*h:
            choices.append(k)
    interior = np.zeros((h, w), np.uint8)
    if choices:
        k = max(choices, key=lambda j: stats[j, cv2.CC_STAT_AREA])
        contours, _ = cv2.findContours((labels == k).astype(np.uint8), cv2.RETR_EXTERNAL,
                                      cv2.CHAIN_APPROX_SIMPLE)
        cv2.drawContours(interior, contours, -1, 255, cv2.FILLED)
    elif manual:
        # Manual text-area fallback: use actual bright pixels plus only small
        # enclosed holes. This cannot guarantee a complete speech-bubble shape.
        interior = white.copy()
        if manual_text is not None:
            interior |= manual_text
        holes, _ = cv2.findContours(255-white, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in holes:
            bx, by, bw, bh = cv2.boundingRect(contour)
            if bx > 1 and by > 1 and bx+bw < w-1 and by+bh < h-1 and bw*bh < .025*w*h:
                cv2.drawContours(interior, [contour], -1, 255, cv2.FILLED)
    segmentation=interior.copy()
    interior = cv2.erode(interior, np.ones((7, 7), np.uint8), borderType=cv2.BORDER_CONSTANT,
                         borderValue=0)
    detected = detect_text(crop, (0, 0, w, h))
    text = (manual_text if manual_text is not None else detected.mask) & interior
    return Bubble(rect, interior, text, 'Manual + CV' if manual else 'Classical CV', glyph_count=detected.component_count,
                  segmentation=segmentation,text_regions=tuple((x+a,y+b,c,d) for a,b,c,d in detected.regions),
                  shape_status='Manual region — verify boundary' if manual else 'Enclosed bright region — review text mask')


def detect_bubbles(image: np.ndarray, padding: int = 2) -> list[Bubble]:
    validate_image(image)
    height, width = image.shape[:2]
    # Native connectivity preserves thin necks; no proximity merging or large closing.
    ratio = 1.
    small = cv2.resize(image, (max(1, round(width*ratio)), max(1, round(height*ratio))),
                       interpolation=cv2.INTER_AREA) if ratio < 1 else image
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    white = cv2.inRange(gray, 205, 255)
    count, components, stats, _ = cv2.connectedComponentsWithStats(white)
    sh, sw = gray.shape
    bubbles = []
    for k in range(1, count):
        x, y, w, h, area = map(int, stats[k])
        if (x <= 0 or y <= 0 or x+w >= sw or y+h >= sh or min(w, h) < 16
                or area < max(100, .0003*sw*sh) or area > .85*sw*sh
                or max(w/h, h/w) > 4 or area/(w*h) < .35 or area/(w*h) > .92):
            continue
        contour_image = (components[y:y+h, x:x+w] == k).astype(np.uint8)
        contours, _ = cv2.findContours(contour_image, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour = max(contours, key=cv2.contourArea)
        # Measure the outer shape rather than white occupancy: a panel with
        # artwork has low white occupancy but still has a rectangular boundary.
        if cv2.contourArea(contour)/(w*h) > .9:
            continue
        # Independent X/Y factors avoid preview-rounding coordinate drift.
        x0, y0 = max(0, int(x*width/sw)-5), max(0, int(y*height/sh)-5)
        x1, y1 = min(width, int(np.ceil((x+w)*width/sw))+5), min(height, int(np.ceil((y+h)*height/sh))+5)
        bubble = estimate_bubble(image, (x0, y0, x1-x0, y1-y0), padding=padding)
        if np.count_nonzero(bubble.text) and bubble.glyph_count >= 4:
            bubbles.append(bubble)
    return sorted(bubbles, key=lambda b: (b.rect[1], b.rect[0]))[:200]


def _bubble_pixels(shape, bubble, mask):
    x, y, w, h = bubble.rect
    if min(x, y) < 0 or min(w, h) < 1 or x+w > shape[1] or y+h > shape[0]:
        raise ValueError('Bubble geometry is outside the source image.')
    validate_mask(bubble.interior, (h, w))
    validate_mask(bubble.text, (h, w))
    if inactive_suggestion(bubble):return np.zeros((h,w),np.uint8)
    pixels = bubble.text if mask is None else mask[y:y+h, x:x+w]
    return pixels.copy() if bubble.provenance.get('manual_mask_approved') else pixels & bubble.interior


def effective_bubble_mask(shape: tuple[int, int], bubble: Bubble,
                          mask: np.ndarray | None = None) -> np.ndarray:
    """The same native mask feeds inspector, confirmation and restoration."""
    if mask is not None:
        validate_mask(mask, shape)
    pixels = _bubble_pixels(shape, bubble, mask)
    x, y, w, h = bubble.rect
    result = np.zeros(shape, np.uint8)
    result[y:y+h, x:x+w] = pixels
    return result


def combined_mask(shape: tuple[int, int], bubbles: list[Bubble], mask: np.ndarray | None = None) -> np.ndarray:
    """Clean only reviewed interiors, intersecting any human-edited page mask."""
    if mask is not None:
        validate_mask(mask, shape)
    result = np.zeros(shape, np.uint8)
    for bubble in bubbles:
        if not bubble.reviewed or bubble.review_decision == 'Rejected':
            continue
        x, y, w, h = bubble.rect
        result[y:y+h, x:x+w] |= _bubble_pixels(shape, bubble, mask)
    return result
