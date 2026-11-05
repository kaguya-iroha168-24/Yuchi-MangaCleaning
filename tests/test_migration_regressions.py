"""Fault and native-coordinate regressions using recorded, real Shima output."""
from copy import deepcopy
from io import BytesIO
import json
from pathlib import Path
from threading import Event
import time
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services import detection
from mangaclean.services.detection_runtime import detect_with_fallback, DetectionCancelled
from mangaclean.services.yuchi_process import DetectorUnavailable

REPORT=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity')
FIXTURE=Path('.cache/shima-parity/fixtures/page_009.png')
HEADERS={'Authorization':f'Bearer {main.TOKEN}','Origin':'http://tauri.localhost'}


def wait_job(client):
    deadline=time.monotonic()+12
    while time.monotonic()<deadline:
        state=client.get('/v1/state',headers=HEADERS).json()
        if state['job']['status'] not in ('queued','running'):return state
        time.sleep(.02)
    raise AssertionError('Test job did not finish')


class MigrationRegression(unittest.TestCase):
    def setUp(self):
        main.store.job=None;main.store.cancel.clear()
        self.client=TestClient(main.app)
        self.image=cv2.imread(str(FIXTURE))
        self.raw=json.loads((REPORT/'tauri-cpu-page_009.json').read_text())
        self.predict_patch=patch.object(detection.YuchiProcess,'predict',lambda _,image:deepcopy(self.raw))
        self.predict_patch.start()
        opened=self.client.post('/v1/open?discard=true',headers=HEADERS,files={'file':('page_009.png',BytesIO(FIXTURE.read_bytes()),'image/png')})
        self.assertEqual(opened.status_code,200)

    def tearDown(self):self.predict_patch.stop()

    def post(self,path,data=None):return self.client.post(path,headers=HEADERS,json=data or {})
    def state(self):return self.client.get('/v1/state',headers=HEADERS).json()['document']
    def pixels(self,kind):
        return cv2.imdecode(np.frombuffer(self.client.get('/v1/image/'+kind,headers=HEADERS).content,np.uint8),cv2.IMREAD_UNCHANGED)

    def scan(self):
        self.assertEqual(self.post('/v1/detect',{'provider':'shima_v1','device':'cpu'}).status_code,200)
        state=wait_job(self.client)
        self.assertEqual(state['job']['status'],'done',state['job'])
        self.assertEqual(len(state['document']['bubbles']),11)
        return state['document']['bubbles'][0]['id']

    def test_scan_history_restores_metadata_and_candidates(self):
        self.scan();state=self.state()
        self.assertEqual(state['detectionRuns'][-1]['post_nms_count'],11)
        expected=state['bubbles'];self.post('/v1/undo')
        self.assertEqual(self.state()['bubbles'],[])
        self.assertEqual(self.state()['detectionRuns'],[])
        self.post('/v1/redo');self.assertEqual(self.state()['bubbles'],expected)
        self.assertEqual(len(self.state()['detectionRuns']),1)

    def test_review_preview_brush_clip_clean_undo_redo(self):
        identifier=self.scan()
        self.assertEqual(self.post(f'/v1/bubbles/{identifier}/preview').status_code,409)
        self.post(f'/v1/bubbles/{identifier}/review',{'decision':'Rejected'})
        self.assertEqual(self.post(f'/v1/bubbles/{identifier}/preview').status_code,409)
        self.post(f'/v1/bubbles/{identifier}/review',{'decision':'Accepted'})
        preview=self.post(f'/v1/bubbles/{identifier}/preview').json()
        original_mask=self.pixels('preview');before=self.pixels('working')
        self.assertEqual(self.post('/v1/clean/confirm',{'previewId':'stale'}).status_code,409)
        clipped=self.post('/v1/preview/edit',{'previewId':preview['id'],'mode':'add','radius':40,'points':[[0,0]]})
        self.assertEqual(clipped.status_code,200,clipped.text)
        self.assertGreater(clipped.json()['analysis']['clipped_brush_pixels'],0)
        np.testing.assert_array_equal(self.pixels('preview'),original_mask)
        ys,xs=np.where(original_mask>0);point=[int(xs[len(xs)//2]),int(ys[len(ys)//2])]
        erased=self.post('/v1/preview/edit',{'previewId':preview['id'],'mode':'erase','radius':3,'points':[point]})
        self.assertLess(erased.json()['maskPixels'],preview['maskPixels'])
        self.post('/v1/preview/edit',{'previewId':preview['id'],'mode':'add','radius':2,'points':[point]})
        mask=self.pixels('preview')
        cleaned=self.post('/v1/clean/confirm',{'previewId':preview['id'],'method':'Telea Inpainting'})
        self.assertEqual(cleaned.status_code,200,cleaned.text)
        self.assertEqual(cleaned.json()['result']['outsideChangedPixels'],0)
        after=self.pixels('working')
        np.testing.assert_array_equal(after[mask==0],before[mask==0])
        np.testing.assert_array_equal(self.pixels('original'),self.image)
        self.post('/v1/undo');np.testing.assert_array_equal(self.pixels('working'),before)
        self.post('/v1/redo');np.testing.assert_array_equal(self.pixels('working'),after)
        saved=self.post('/v1/save/project');self.assertEqual(saved.status_code,200,saved.text)
        self.assertTrue(Path(saved.json()['path']).is_file())

    def test_stale_preview_and_rejected_candidate_cannot_clean(self):
        identifier=self.scan();self.post(f'/v1/bubbles/{identifier}/review',{'decision':'Accepted'})
        preview=self.post(f'/v1/bubbles/{identifier}/preview').json()
        self.post(f'/v1/bubbles/{identifier}/review',{'decision':'Rejected'})
        self.assertEqual(self.post('/v1/clean/confirm',{'previewId':preview['id']}).status_code,409)
        np.testing.assert_array_equal(self.pixels('working'),self.image)

    def test_multi_selected_clean_is_atomic_and_requires_all_reviews(self):
        self.scan();ids=[b['id'] for b in self.state()['bubbles'][:2]]
        self.post(f'/v1/bubbles/{ids[0]}/review',{'decision':'Accepted'})
        self.assertEqual(self.post('/v1/bubbles/preview',{'ids':ids}).status_code,409)
        self.post(f'/v1/bubbles/{ids[1]}/review',{'decision':'Accepted'})
        preview=self.post('/v1/bubbles/preview',{'ids':ids})
        self.assertEqual(preview.status_code,200,preview.text)
        mask=self.pixels('preview');before=self.pixels('working')
        result=self.post('/v1/clean/confirm',{'previewId':preview.json()['id']})
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()['result']['outsideChangedPixels'],0)
        after=self.pixels('working')
        np.testing.assert_array_equal(after[mask==0],before[mask==0])
        self.post('/v1/undo');np.testing.assert_array_equal(self.pixels('working'),before)
        self.post('/v1/redo');np.testing.assert_array_equal(self.pixels('working'),after)

    def test_reading_order_and_transcription_history(self):
        first=self.post('/v1/text-regions',{'rect':[10,10,50,50],'text':'first'}).json()['document']['textRegions'][0]['id']
        second=self.post('/v1/text-regions',{'rect':[100,10,50,50],'text':'second'}).json()['document']['textRegions'][1]['id']
        self.assertEqual(self.post('/v1/reading-order',{'ids':[second,first]}).status_code,200)
        self.assertEqual(self.state()['readingOrder'],[second,first])
        self.assertEqual(self.post('/v1/reading-order',{'ids':[first,first]}).status_code,422)
        self.post('/v1/undo');self.assertEqual(self.state()['readingOrder'],[first,second])
        self.post(f'/v1/text-regions/{first}',{'text':'corrected'})
        self.post('/v1/undo');self.assertEqual(self.state()['textRegions'][0]['text'],'first')
        self.post('/v1/redo');self.assertEqual(self.state()['textRegions'][0]['text'],'corrected')

    def test_ocr_failure_and_cancel_preserve_manual_text(self):
        region=self.post('/v1/text-regions',{'rect':[20,20,100,100],'text':'keep'}).json()['document']['textRegions'][0]['id']
        with patch.object(main,'recognize',side_effect=main.OCRCancelled('controlled cancellation')):
            self.post(f'/v1/text-regions/{region}/ocr',{'device':'cpu'})
            self.assertEqual(wait_job(self.client)['job']['status'],'cancelled')
        with patch.object(main,'recognize',side_effect=RuntimeError('Local model unavailable')):
            self.post(f'/v1/text-regions/{region}/ocr',{'device':'cpu'})
            self.assertEqual(wait_job(self.client)['job']['status'],'failed')
        self.assertEqual(self.state()['textRegions'][0]['text'],'keep')
        self.assertIsNone(self.state()['textRegions'][0]['ocr'])

    def test_cuda_failure_cpu_retry_preserves_all_settings(self):
        attempts=[]
        def runner(provider,source,working,config=None):
            attempts.append(dict(config))
            if len(attempts)==1:raise DetectorUnavailable('CUDA_OOM: controlled injected failure')
            return detection.detect(provider,source,working,config=config)
        batch=detect_with_fallback('shima_v1',self.image,self.image,'cuda:0',Event(),runner=runner)
        self.assertTrue(batch.metadata['cpu_fallback']);self.assertEqual(batch.metadata['effective_device'],'cpu')
        self.assertEqual({k:v for k,v in attempts[0].items() if k!='device'}, {k:v for k,v in attempts[1].items() if k!='device'})
        self.assertEqual(attempts[1]['device'],'cpu')
        with self.assertRaisesRegex(DetectorUnavailable,'checkpoint'):
            detect_with_fallback('shima_v1',self.image,self.image,'auto',Event(),runner=lambda *a,**k: (_ for _ in ()).throw(DetectorUnavailable('checkpoint mismatch')))

    def test_cancel_before_cpu_fallback(self):
        cancel=Event();calls=[]
        def runner(*args,**kwargs):
            calls.append(1);cancel.set();raise DetectorUnavailable('CUDA_ERROR: injected')
        with self.assertRaises(DetectionCancelled):detect_with_fallback('shima_v1',self.image,self.image,'auto',cancel,runner=runner)
        self.assertEqual(len(calls),1)


if __name__=='__main__':unittest.main(verbosity=2)
