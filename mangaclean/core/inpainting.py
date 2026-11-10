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
    pad = int(np.ceil(radius)) + 4
    ys, xs = np.where(mask > 0)
    ymin = max(0, int(np.min(ys)) - pad)
    ymax = min(image.shape[0], int(np.max(ys)) + pad + 1)
    xmin = max(0, int(np.min(xs)) - pad)
    xmax = min(image.shape[1], int(np.max(xs)) + pad + 1)
    crop_img = image[ymin:ymax, xmin:xmax]
    crop_mask = mask[ymin:ymax, xmin:xmax]
    crop_res = cv2.inpaint(crop_img, crop_mask, radius, cv2.INPAINT_TELEA)
    result = image.copy()
    crop_slice = result[ymin:ymax, xmin:xmax]
    crop_slice[crop_mask > 0] = crop_res[crop_mask > 0]
    return result
