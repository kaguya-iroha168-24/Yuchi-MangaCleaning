"""Bounded chapter automation with actual mask/clean/persistence code, controlled AI."""
from copy import deepcopy
from io import BytesIO
from types import SimpleNamespace
from threading import Event,Thread
import time
import unittest
from unittest.mock import patch
import cv2,numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.core.bubble_detector import Bubble


class AutomaticQueue(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app);self.headers={'Authorization':'Bearer '+main.TOKEN}
        main.store.job=None;main.store.chapter=None;main.store.document=None;main.store.cancel.clear()
        main.store.cancel_requested_job=None
        self.source=np.full((140,140,3),255,np.uint8)
        shape=np.zeros((110,110),np.uint8);cv2.ellipse(shape,(55,55),(48,48),0,0,360,255,-1)
        cv2.putText(self.source,'HI',(58,80),cv2.FONT_HERSHEY_SIMPLEX,.6,(10,10,10),1)
        self.bubble=Bubble((15,15,110,110),cv2.erode(shape,np.ones((7,7),np.uint8)),np.zeros_like(shape),segmentation=shape)
        _,png=cv2.imencode('.png',self.source);self.png=png.tobytes()

    def post(self,path,body=None):return self.client.post(path,headers=self.headers,json=body or {})
    def pages(self,count):
        result=self.client.post('/v1/pages/import',headers=self.headers,files=[('files',(f'page_{i:02}.png',BytesIO(self.png),'image/png')) for i in range(count)])
        self.assertEqual(result.status_code,200,result.text)
        return result.json()['chapter']['pages']
    def wait(self):
        deadline=time.monotonic()+20
        while main.store.job['status'] in {'queued','running'} and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(main.store.job['status'],'done',main.store.job)
        return main.store.job['result']
    def batch(self,*args,**kwargs):return SimpleNamespace(bubbles=[deepcopy(self.bubble)],metadata={})

    def test_twenty_pages_process_once_without_approval_and_reuse_results(self):
        pages=self.pages(20)
        with patch.object(main,'detect_with_fallback',side_effect=self.batch) as detector,patch.object(main,'recognize',return_value=dict(text='HI',provider='controlled',model_id='fixture')) as ocr:
            response=self.post('/v1/process',{'provider':'opencv','device':'cpu','ids':[p['id'] for p in pages]})
            self.assertEqual(response.status_code,200,response.text);result=self.wait()
            self.assertEqual((result['processedPages'],result['cleanedRegions'],result['skippedRegions']),(20,20,0))
            self.assertEqual(result['translationStatus'],'unavailable')
            self.assertEqual(main.store.document.dialogues,[])
            self.assertEqual((detector.call_count,ocr.call_count),(20,20))
            self.assertTrue(np.any(main.store.document.working!=self.source))
            np.testing.assert_array_equal(main.store.document.source,self.source)
            self.post('/v1/process',{'provider':'opencv','device':'cpu','ids':[p['id'] for p in pages]});again=self.wait()
            self.assertEqual((detector.call_count,ocr.call_count),(20,20))
            self.assertEqual((again['cleanedRegions'],again['alreadyProcessedRegions']),(0,20))

    def test_failed_page_does_not_erase_completed_or_later_pages(self):
        pages=self.pages(3);calls=[]
        def detect(*args,**kwargs):
            calls.append(True)
            if len(calls)==2:raise RuntimeError('controlled failed page')
            return self.batch()
        with patch.object(main,'detect_with_fallback',side_effect=detect),patch.object(main,'recognize',return_value=dict(text='HI',provider='controlled',model_id='fixture')):
            response=self.post('/v1/process',{'provider':'opencv','device':'cpu','ids':[p['id'] for p in pages]})
            self.assertEqual(response.status_code,200,response.text);result=self.wait()
        self.assertEqual((result['processedPages'],result['cleanedRegions']),(2,2))
        self.assertEqual(len(result['failures']),1)
        for index in (0,2):
            self.post('/v1/pages/'+pages[index]['id']+'/activate')
            self.assertTrue(np.any(main.store.document.working!=self.source))
        self.post('/v1/pages/'+pages[1]['id']+'/activate')
        np.testing.assert_array_equal(main.store.document.working,self.source)

    def test_cancel_during_locked_restoration_does_not_commit_pixels(self):
        self.pages(1);entered=Event();release=Event();original=main.restore_text
        def restore(*args,**kwargs):
            entered.set();release.wait(5);return original(*args,**kwargs)
        with patch.object(main,'detect_with_fallback',side_effect=self.batch),patch.object(main,'recognize',return_value=dict(text='HI',provider='controlled',model_id='fixture')),patch.object(main,'restore_text',side_effect=restore):
            response=self.post('/v1/process',{'provider':'opencv','device':'cpu'})
            self.assertEqual(response.status_code,200,response.text);self.assertTrue(entered.wait(5))
            identifier=response.json()['id'];cancel=Thread(target=lambda:self.post('/v1/jobs/'+identifier+'/cancel'));cancel.start()
            deadline=time.monotonic()+3
            while main.store.cancel_requested_job!=identifier and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(main.store.cancel_requested_job,identifier);release.set();cancel.join(5)
            deadline=time.monotonic()+3
            while main.store.job['status']=='running' and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(main.store.job['status'],'cancelled')
        np.testing.assert_array_equal(main.store.document.working,self.source)
        self.assertIsNone(main.store.preview)


if __name__=='__main__':unittest.main()
