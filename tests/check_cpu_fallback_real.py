"""Real CPU inference with CUDA hidden in this test process only."""
from threading import Event
import json
from pathlib import Path
import os
import cv2
import numpy as np
from mangaclean.services.detection_runtime import detect_with_fallback
from mangaclean.services.yuchi_process import close_detector

assert os.environ.get('CUDA_VISIBLE_DEVICES')=='-1'
report_dir=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity')
image=cv2.imread('.cache/shima-parity/fixtures/page_009.png')
expected=json.loads((report_dir/'baseline-cpu-page_009.json.domain').read_text())
arrays=np.load(str(report_dir/'baseline-cpu-page_009.json.domain')+'.npz')
rows=[]
try:
    for requested in ('auto','cuda:0'):
        batch=detect_with_fallback('shima_v1',image,image,requested,Event())
        assert batch.metadata['effective_device']=='cpu'
        assert len(batch.bubbles)==11
        for index,bubble in enumerate(batch.bubbles):
            assert list(bubble.rect)==expected[index]['rect']
            np.testing.assert_array_equal(bubble.full_segmentation(image.shape),arrays[f'shape_{index}'])
        if requested=='cuda:0':assert batch.metadata['cpu_fallback']
        rows.append({'requested':requested,'effective':'cpu','count':len(batch.bubbles),
                     'cpu_fallback':batch.metadata['cpu_fallback'],'reason':batch.metadata.get('fallback_reason'),
                     'predict_s':batch.metadata['predict_s'],'baseline_mask_different_pixels':0})
        close_detector()
finally:close_detector()
(report_dir/'CPU_FALLBACK_REAL.json').write_text(json.dumps({'passed':True,'cases':rows},indent=2))
print(json.dumps(rows))
