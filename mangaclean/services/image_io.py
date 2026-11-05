from __future__ import annotations

import os
from pathlib import Path
import struct
import tempfile

import cv2
import numpy as np

from mangaclean.core.mask_processor import validate_image

MAX_PIXELS = 24_000_000
MAX_FILE_BYTES = 100 * 1024 * 1024
FORMATS = {'.png', '.jpg', '.jpeg'}


def _dimensions(data: bytes) -> tuple[int, int]:
    """Inspect PNG/JPEG dimensions before allocating the decoded image."""
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 24:
        return struct.unpack('>II', data[16:24])
    if data.startswith(b'\xff\xd8'):
        offset = 2
        while offset + 4 <= len(data):
            if data[offset] != 0xFF:
                break
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if marker == 0xDA:
                break
            length = int.from_bytes(data[offset:offset + 2], 'big')
            if length < 2 or offset + length > len(data):
                break
            if marker in {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}:
                height, width = struct.unpack('>HH', data[offset + 3:offset + 7])
                return width, height
            offset += length
    raise ValueError('This file is not a readable PNG or JPEG image.')


def read_image(path: str | Path) -> np.ndarray:
    """Read Unicode paths; normalize grayscale/16-bit/transparent PNG to BGR8."""
    source = Path(path)
    if source.suffix.lower() not in FORMATS:
        raise ValueError('Choose a PNG or JPEG image.')
    if source.stat().st_size > MAX_FILE_BYTES:
        raise ValueError('The file exceeds 100 MB. Please use a smaller source.')
    data = source.read_bytes()
    width, height = _dimensions(data)
    if width < 1 or height < 1 or width * height > MAX_PIXELS:
        raise ValueError('Images up to 24 megapixels are supported. Crop a copy of this page first.')
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError('Image decoding failed. The file may be damaged.')
    if image.dtype == np.uint16:
        image = (image // 257).astype(np.uint8)
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.ndim == 3 and image.shape[2] == 4:
        alpha = image[:, :, 3:4].astype(np.uint16)
        image = ((image[:, :, :3].astype(np.uint16) * alpha + 255 * (255 - alpha)) // 255).astype(np.uint8)
    validate_image(image)
    return np.ascontiguousarray(image)


def write_image(path: str | Path, image: np.ndarray, overwrite: bool = False) -> Path:
    """Encode the cleaned BGR buffer and atomically publish to a Unicode path."""
    validate_image(image)
    target = Path(path)
    extension = target.suffix.lower()
    if extension not in FORMATS:
        raise ValueError('Export with a .png, .jpg, or .jpeg extension.')
    if target.exists() and not overwrite:
        raise FileExistsError('This destination exists. Choose another name or confirm overwrite.')
    params = [cv2.IMWRITE_JPEG_QUALITY, 95] if extension != '.png' else [cv2.IMWRITE_PNG_COMPRESSION, 3]
    ok, encoded = cv2.imencode(extension, image, params)
    if not ok:
        raise ValueError('The cleaned image could not be encoded.')
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix='.mangaclean-', suffix='.tmp', delete=False) as stream:
            temporary = stream.name
            stream.write(encoded.tobytes())
        if overwrite:
            os.replace(temporary, target)
        else:
            # On Windows rename refuses an existing target, including one
            # created after the initial check. No silent overwrite race.
            os.rename(temporary, target)
        temporary = None
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    return target
