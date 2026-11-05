"""Conservative, explicit mask repair and provisional review hints; no model filtering."""
from copy import deepcopy
import cv2
import numpy as np
from .bubble_detector import estimate_bubble

REVIEW_DECISIONS = ('Needs Review', 'Accepted', 'Rejected')
CANDIDATE_KINDS = ('Unclassified', 'Bubble', 'Narration / text region', 'Possible false positive', 'Uncertain')
CLEANING_STATES = ('Needs Review', 'Ready', 'Processing', 'Auto Mask Ready', 'Needs Mask Review',
                   'Cleaning', 'Cleaned', 'Needs Result Review', 'Failed')


def candidate_hint(bubble):
    """Geometry hints are never human labels and never remove a prediction."""
    if bubble.candidate_kind != 'Unclassified':
        return bubble.candidate_kind
    if np.any(bubble.interior) and not np.any(bubble.text) and bubble.glyph_count == 0:
        return 'Possible false positive — review non-text shape'
    shape = bubble.segmentation
    if shape is not None and np.any(shape):
        contours, _ = cv2.findContours(shape, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contour = max(contours, key=cv2.contourArea)
        _, _, w, h = cv2.boundingRect(contour)
        if cv2.contourArea(contour)/max(1, (w-1)*(h-1)) > .93:
            return 'Narration / rectangular container candidate — review'
    return 'Bubble candidate — review' if np.any(bubble.interior) else 'Container unverified — repair mask or select manually'


def repair_empty_mask(image, bubble, padding=2):
    """Search a bounded larger ROI for a CLOSED component, never accept an open edge.

    The model box/provenance remains unchanged. The safe interior is eroded and
    glyphs stay within the original cleaning ROI. User approval commits the draft.
    """
    if np.any(bubble.interior) and np.any(bubble.text):
        raise ValueError('A text mask already exists. Use mask/shape correction to refine it.')
    if bubble.provenance.get('manual_corrected'):
        raise ValueError('Manual shape corrections are preserved. Refine the shape or use manual text selection.')
    x, y, w, h = bubble.rect
    height, width = image.shape[:2]
    limit = min(24, max(4, min(w, h)//4))
    for margin in sorted({4, 8, 12, 16, limit}):
        if margin > limit:
            continue
        a, b = max(0, x-margin), max(0, y-margin)
        c, d = min(width, x+w+margin), min(height, y+h+margin)
        candidate = estimate_bubble(image, (a, b, c-a, d-b), padding=padding)
        shape = candidate.segmentation
        if shape is None or not np.any(shape) or not np.any(candidate.interior):
            continue
        inside = shape[y-b:y-b+h, x-a:x-a+w]
        # Reject a neighbouring container or a large panel found in the wider ROI.
        if (np.count_nonzero(inside) < .85*np.count_nonzero(shape)
                or np.count_nonzero(shape) < .15*w*h
                or not shape[min(d-b-1,y-b+h//2), min(c-a-1,x-a+w//2)]):
            continue
        cleaning_roi = np.zeros_like(shape)
        cleaning_roi[y-b:y-b+h, x-a:x-a+w] = 255
        candidate.text &= cleaning_roi
        if not np.any(candidate.text):
            continue
        repaired = deepcopy(bubble)
        repaired.rect = candidate.rect
        repaired.segmentation = shape
        repaired.interior = candidate.interior
        repaired.text = candidate.text
        repaired.text_regions = candidate.text_regions
        repaired.glyph_count = candidate.glyph_count
        repaired.__dict__.pop('contours', None)
        repaired.reviewed = False
        repaired.review_decision = 'Needs Review'
        repaired.cleaning_status = 'Needs Review'
        repaired.cleaning_message = 'Repaired mask prepared; confirm before cleaning.'
        repaired.shape_status = 'Expanded CV container ROI; eroded interior; glyph-only cleaning mask'
        repaired.provenance = dict(bubble.provenance, mask_recovery={
            'original_roi': list(bubble.rect), 'container_roi': list(candidate.rect),
            'cleaning_roi': list(bubble.rect), 'expansion_px': margin,
            'requires_confirmation': True})
        return repaired
    raise ValueError('No safely enclosed text mask found. Use Select text manually, Add/Remove Mask, or Refine Bubble Shape. No pixels were cleaned.')
