"""Local Ogkalu inference for source lettering inside speech bubbles."""
from functools import lru_cache
from hashlib import sha256
from math import ceil, floor, isfinite
from pathlib import Path

import cv2
import numpy as np


DETECTOR = 'ogkalu_v4_s_int8'
CONFIDENCE = .30
MODEL = Path(__file__).resolve().parents[2] / 'models/ogkalu/detector-v4-s_int8.onnx'
MODEL_SHA256 = '5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79'


@lru_cache(maxsize=1)
def _session():
    if not MODEL.is_file():
        raise RuntimeError('Ogkalu model missing. Restore the models/ogkalu folder for Text only.')
    model_bytes = MODEL.read_bytes()
    if sha256(model_bytes).hexdigest() != MODEL_SHA256:
        raise RuntimeError('Ogkalu model checksum mismatch. Restore the verified model for Text only.')
    try:
        import onnxruntime as ort
    except ImportError as error:
        raise RuntimeError('Ogkalu runtime is unavailable. Install the Text only runtime dependencies.') from error
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    options.add_session_config_entry('session.intra_op.allow_spinning', '0')
    return ort.InferenceSession(model_bytes, options, providers=['CPUExecutionProvider'])


def detect_text_bubbles(image):
    """Return scored text boxes in native page coordinates."""
    session = _session()
    from PIL import Image

    height, width = image.shape[:2]
    rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
    resized = Image.fromarray(rgb).resize((640, 640), Image.Resampling.BICUBIC)
    tensor = np.asarray(resized, dtype=np.float32).transpose(2, 0, 1)[None] / 255.0
    labels, boxes, scores = session.run(None, {
        'images': tensor, 'orig_target_sizes': np.array([[width, height]], dtype=np.int64),
    })
    candidates = []
    for label, box, score in zip(labels[0], boxes[0], scores[0]):
        if label != 1 or not isfinite(score) or score < CONFIDENCE or not np.isfinite(box).all():
            continue
        x1, y1, x2, y2 = box
        left, top = max(0, floor(x1)), max(0, floor(y1))
        right, bottom = min(width, ceil(x2)), min(height, ceil(y2))
        if left < right and top < bottom:
            candidates.append(((left, top, right-left, bottom-top), float(score)))
    return sorted(candidates, key=lambda item: (item[0][1], item[0][0]))
