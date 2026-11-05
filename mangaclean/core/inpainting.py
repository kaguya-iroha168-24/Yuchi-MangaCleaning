from __future__ import annotations

import cv2
import numpy as np

from .mask_processor import validate_image, validate_mask


def inpaint(image: np.ndarray, mask: np.ndarray, radius: float = 3.0) -> np.ndarray:
    """Restore masked pixels with Telea; preserve the source and unmasked pixels."""
    validate_image(image)
    validate_mask(mask, image.shape)
    if not np.any(mask):
        raise ValueError('The mask is empty. Detect text or add a mask stroke first.')
    if not np.isfinite(radius) or not 1 <= radius <= 12:
        raise ValueError('Inpainting radius must be between 1 and 12 pixels.')
    result = cv2.inpaint(image, mask, radius, cv2.INPAINT_TELEA)
    result[mask == 0] = image[mask == 0]
    return result
