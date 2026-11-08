"""Image-export validation; project saves remain independent of render readiness."""
import base64
from hashlib import sha256
import os
from uuid import uuid4

import cv2
import numpy as np

from .image_io import read_image, write_image
from .typesetting import render_dialogue, TypesettingUnavailable


def dialogue_export_issues(doc):
    issues = []
    for index, text in enumerate(doc.dialogues):
        if not text.visible or not text.text.strip():
            continue
        layer = None
        code = reason = None
        try:
            layer = render_dialogue(text, doc.bubbles, overlay=True) if doc.composition.get('text_mode') == 'overlay' else render_dialogue(text, doc.bubbles)
            if layer['overflow']:
                code, reason = 'overflow', 'Teks tidak muat pada area aman. Perbesar box atau perbaiki ukuran/padding/baris.'
            elif any('Some glyphs are missing' in message for message in layer['warnings']):
                code, reason = 'missing_glyphs', 'Font yang tersedia tidak memiliki seluruh glyph yang diperlukan.'
            else:
                image = cv2.imdecode(np.frombuffer(base64.b64decode(layer['png'], validate=True), np.uint8), cv2.IMREAD_UNCHANGED)
                if image is None or image.ndim != 3 or image.shape[2] != 4:
                    raise ValueError('Renderer tidak menghasilkan layer RGBA yang valid.')
                if image.shape[:2] != (int(np.ceil(text.height)), int(np.ceil(text.width))):
                    raise ValueError('Ukuran layer hasil render tidak sesuai dengan Dialogue.')
                ink = cv2.findNonZero(image[:, :, 3])
                if ink is None:
                    code, reason = 'missing_ink', 'Dialogue berisi teks tetapi tidak menghasilkan glyph yang terlihat.'
                else:
                    x, y, w, h = cv2.boundingRect(ink)
                    left, top = int(np.floor(text.x))+x, int(np.floor(text.y))+y
                    if left < 0 or top < 0 or left+w > doc.working.shape[1] or top+h > doc.working.shape[0]:
                        code, reason = 'outside_page', 'Sebagian glyph berada di luar halaman dan akan terpotong.'
        except (TypesettingUnavailable, ValueError, KeyError, TypeError, cv2.error) as error:
            code, reason = 'render_error', str(error)[:500]
        if code:
            number = next((i+1 for i, bubble in enumerate(doc.bubbles) if bubble.id == text.bubble_id), None)
            issues.append(dict(dialogueId=text.id, dialogueLabel=f'Dialogue {index+1:02d} · {text.text[:40]}',
                bubbleId=text.bubble_id, candidateNumber=number, reason=reason, code=code,
                requestedFamily=text.family, requestedWeight=text.weight, requestedSize=text.size,
                resolvedFamily=layer.get('resolvedFamily') if layer else None,
                resolvedWeight=layer.get('resolvedWeight') if layer else None,
                resolvedSize=layer.get('effectiveSize') if layer else None))
    return issues


def write_verified_image(path, image):
    """Verify an unpublished image, then publish without overwriting on Windows."""
    pending = path.with_name(f'.pending-{uuid4().hex}{path.suffix}')
    try:
        write_image(pending, image)
        loaded = read_image(pending)
        if loaded.shape != image.shape or (path.suffix == '.png' and not np.array_equal(loaded, image)):
            raise ValueError('Verifikasi ekspor gambar gagal.')
        with pending.open('rb+') as stream:
            os.fsync(stream.fileno())
        data = pending.read_bytes()
        digest = sha256(data).hexdigest()
        # Windows rename refuses an existing destination, including a raced file.
        os.rename(pending, path)
        return digest, len(data)
    finally:
        pending.unlink(missing_ok=True)
