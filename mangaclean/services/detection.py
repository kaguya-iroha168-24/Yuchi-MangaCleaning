"""Detector interface and native-coordinate adapter, independent of Qt widgets."""
from dataclasses import dataclass
import base64
import math
from time import perf_counter

import numpy as np
import cv2

from mangaclean.core.bubble_detector import detect_bubbles, estimate_bubble
from mangaclean.core.mask_processor import validate_image
from .yuchi_process import YuchiProcess

YUCHI = 'yuchi_v4'
SHIMA = 'shima_v1'
OPENCV = 'opencv'
PROVIDERS = ((SHIMA, 'Shima V1'), (YUCHI, 'Yuchi Fine-Tuned v4'), (OPENCV, 'OpenCV Classical (Fallback)'))


@dataclass
class DetectionBatch:
    bubbles: list
    metadata: dict


def detect(provider, source, working, padding=2, config=None):
    validate_image(source)
    validate_image(working)
    if source.shape != working.shape:
        raise ValueError('Detection and restoration images must share native dimensions.')
    started = perf_counter()
    if provider == OPENCV:
        bubbles = detect_bubbles(working, padding)
        for bubble in bubbles:
            bubble.provenance = {'provider': OPENCV, 'checkpoint': None, 'provisional': True}
        return DetectionBatch(bubbles, dict(provider=OPENCV, model_name='OpenCV Classical',
            checkpoint=None, device='CPU', input_shape=list(source.shape), predict_s=perf_counter()-started))
    if provider not in (YUCHI, SHIMA):
        raise ValueError(f'Unsupported detector: {provider}')
    if config is None:
        from .yuchi_process import detection_config
        config = detection_config(provider)
    result = YuchiProcess(config).predict(source)
    metadata = result['metadata']
    if config is not None:
        metadata.update(max_detections=config['max_detections'],requested_device=config['device'])
    if metadata.get('input_shape') != list(source.shape):
        raise ValueError('Inference metadata does not match native image dimensions.')
    height, width = source.shape[:2]
    bubbles = []
    for prediction in result['predictions']:
        values = prediction['xyxy']
        score = float(prediction['confidence'])
        if len(values) != 4 or not all(math.isfinite(v) for v in values) or not 0 <= score <= 1:
            raise ValueError('Invalid detector coordinates or confidence.')
        if prediction['class_id'] != 0:
            raise ValueError('Unexpected detection class; only physical bubble class 0 is supported.')
        x0, y0 = max(0, math.floor(values[0])), max(0, math.floor(values[1]))
        x1, y1 = min(width, math.ceil(values[2])), min(height, math.ceil(values[3]))
        if min(x1-x0, y1-y0) < (1 if provider == SHIMA else 8):
            continue
        native_box = [x0, y0, x1-x0, y1-y0]
        # A small native margin lets CV find an enclosed interior at the box edge.
        margin = 6
        a, b = max(0, x0-margin), max(0, y0-margin)
        c, d = min(width, x1+margin), min(height, y1+margin)
        if provider == SHIMA and min(width,height)>=8:
            # Keep tiny edge candidates reviewable without violating the CV ROI minimum.
            a,b=max(0,min(a,width-8)),max(0,min(b,height-8))
            c,d=min(width,max(c,a+8)),min(height,max(d,b+8))
        bubble = estimate_bubble(working, (a, b, c-a, d-b), padding=padding)
        if provider == SHIMA:
            bounds = prediction.get('mask_bounds')
            if not isinstance(bounds,list) or len(bounds)!=4 or not all(type(v)is int for v in bounds):
                raise ValueError('Invalid native segmentation bounds.')
            mx,my,mw,mh=bounds
            if min(bounds)<0 or mx+mw>width or my+mh>height:
                raise ValueError('Segmentation lies outside native image coordinates.')
            shape=np.zeros((d-b,c-a),np.uint8)
            if mw and mh:
                pixels=cv2.imdecode(np.frombuffer(base64.b64decode(prediction['mask_png'],validate=True),np.uint8),cv2.IMREAD_GRAYSCALE)
                if pixels is None or pixels.shape!=(mh,mw)or not np.all((pixels==0)|(pixels==255)):
                    raise ValueError('Invalid binary native container mask.')
                left,top=max(a,mx),max(b,my);right,bottom=min(c,mx+mw),min(d,my+mh)
                if right>left and bottom>top:
                    shape[top-b:bottom-b,left-a:right-a]=pixels[top-my:bottom-my,left-mx:right-mx]
            bubble.segmentation=shape
            bubble.interior=cv2.erode(shape,np.ones((7,7),np.uint8),borderType=cv2.BORDER_CONSTANT,borderValue=0)
            bubble.text &= bubble.interior
            bubble.__dict__.pop('contours',None)
        bubble.method = 'Shima V1' if provider == SHIMA else 'Yuchi Fine-Tuned v4'
        bubble.confidence = score
        bubble.provenance = {'provider': provider, 'checkpoint': metadata['checkpoint'],
            'checkpoint_sha256': metadata['checkpoint_sha256'], 'native_prediction_rect': native_box,
            'native_prediction_xyxy': list(values),
            'provisional': True, 'device': metadata['device']}
        if provider == SHIMA:
            bubble.provenance.update(model_provenance=config['model_provenance'],native_model_segmentation=True,
                requires_candidate_review=True,requires_mask_confirmation=True)
        bubble.shape_status = ('YOLO box + CV interior — review text mask' if np.any(bubble.interior)
            else 'YOLO box only — no verified interior; use manual mask/shape correction')
        if provider == SHIMA:
            bubble.shape_status='Native model container mask — review candidate and separate text-ink mask'
        bubbles.append(bubble)
    metadata['candidate_count'] = len(bubbles)
    metadata['post_nms_count'] = len(result['predictions'])
    metadata['adapter_count'] = len(bubbles)
    metadata['skipped_degenerate_count'] = len(result['predictions']) - len(bubbles)
    metadata['scan_total_s'] = perf_counter()-started
    return DetectionBatch(sorted(bubbles, key=lambda bubble: (bubble.rect[1], bubble.rect[0])), metadata)
