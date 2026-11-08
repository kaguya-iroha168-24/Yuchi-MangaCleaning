from io import BytesIO
import json
from types import SimpleNamespace
import time
import unittest
from unittest.mock import patch
from fastapi.testclient import TestClient
import cv2,numpy as np
from backend import main
from mangaclean.core.bubble_detector import Bubble

class ScanWorkflow(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app);self.headers={'Authorization':'Bearer '+main.TOKEN}
        main.store.job=None;main.store.chapter=None
        _,png=cv2.imencode('.png',np.full((80,100,3),255,np.uint8))
        self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('owned.png',BytesIO(png.tobytes()),'image/png')})

    def post(self,path,body=None):return self.client.post(path,headers=self.headers,json=body or {})
    def wait(self, timeout=5):
        deadline=time.monotonic()+timeout
        while main.store.job['status'] in {'queued','running'} and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(main.store.job['status'],'done',main.store.job)

    def test_detect_only_supports_current_and_all_14_pages_without_ocr_or_cleaning(self):
        from mangaclean.services.chapter import Chapter
        from mangaclean.core.region_graph import RegionGraph
        from tempfile import TemporaryDirectory
        image=np.full((80,100,3),255,np.uint8)
        with TemporaryDirectory(dir=main.CACHE) as directory:
            chapter=Chapter(directory,main.Document)
            for i in range(14):
                name=f'{i+1:02}.png'
                chapter.add(main.Document(image,image.copy(),name,np.zeros(image.shape[:2],np.uint8),region_graph=RegionGraph.for_legacy(image,name)))
            ids=[row['id'] for row in chapter.pages]
            chapter.activate(main.store,ids[0],flush=False);main.store.chapter=chapter
            mask=np.full((30,30),255,np.uint8)
            def detection(*args):
                return SimpleNamespace(bubbles=[Bubble((10,10,30,30),mask.copy(),mask.copy())],metadata={})
            with patch.object(main,'detect_with_fallback',side_effect=detection) as detect, patch.object(main,'recognize') as ocr:
                payload={'provider':'opencv','device':'cpu','detect_only':True}
                first=self.post('/v1/scan-detect',payload)
                self.assertEqual(first.status_code,200,first.text);self.wait()
                self.assertEqual(first.json()['type'],'detect-bubbles')
                self.assertEqual(detect.call_count,1)
                batch=self.post('/v1/scan-detect',{**payload,'ids':ids})
                self.assertEqual(batch.status_code,200,batch.text);self.wait(30)
                result=main.store.job['result']
                self.assertEqual((result['processedPages'],result['detectedPages'],result['reusedPages'],result['cleanedRegions']),(14,13,1,0))
                self.assertEqual(detect.call_count,14);ocr.assert_not_called()
                self.assertEqual(chapter.active,ids[0])
                for page in ids:
                    doc=chapter.decode(page)
                    self.assertEqual((len(doc.bubbles),len(doc.region_graph.text_regions)),(1,1))
                    np.testing.assert_array_equal(doc.working,doc.source)
            main.store.chapter=None

    def test_second_scan_reuses_ids_and_ocr_and_never_cleans(self):
        mask=np.full((30,30),255,np.uint8)
        bubble=Bubble((10,10,30,30),mask.copy(),mask.copy(),segmentation=mask.copy())
        with patch.object(main,'detect_with_fallback',return_value=SimpleNamespace(bubbles=[bubble],metadata={})) as detect, patch.object(main,'recognize',return_value=dict(text='TEST',provider='controlled',model_id='fixture')) as ocr:
            first=self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'});self.assertEqual(first.status_code,200,first.text);self.wait()
            identifier=main.store.document.bubbles[0].id;region=main.store.document.region_graph.text_regions[0]
            self.assertEqual(region.provenance['ocr']['raw_text'],'TEST')
            self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'});self.wait()
            self.assertEqual(detect.call_count,1);self.assertEqual(ocr.call_count,1)
            self.assertTrue((main.CACHE/'last-scan-result.json').is_file(),'Scan completion summary is not retained for native diagnosis.')
            diagnostic=json.loads((main.CACHE/'last-scan-result.json').read_text())
            self.assertEqual((diagnostic['detectedPages'],diagnostic['reusedPages'],diagnostic['cachedRegions']),(0,1,1))
            self.assertEqual(main.store.document.bubbles[0].id,identifier)
            self.assertEqual(main.store.document.bubbles[0].cleaning_status,'Needs Review')
            np.testing.assert_array_equal(main.store.document.source,main.store.document.working)
            self.post('/v1/text-regions/'+region.id,{'rect':[12,12,25,25]})
            self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'});self.wait()
            self.assertEqual(detect.call_count,1);self.assertEqual(ocr.call_count,2)

    def test_ocr_failure_retains_candidates_and_allows_direct_mask(self):
        mask=np.full((30,30),255,np.uint8);bubble=Bubble((10,10,30,30),mask.copy(),mask.copy())
        with patch.object(main,'detect_with_fallback',return_value=SimpleNamespace(bubbles=[bubble],metadata={})),patch.object(main,'recognize',side_effect=RuntimeError('controlled OCR failure')):
            self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'});self.wait()
            self.assertEqual(len(main.store.document.bubbles),1)
            self.assertTrue(main.store.job['result']['failures'])
            self.assertEqual(main.store.document.bubbles[0].review_decision,'Needs Review')

    def test_editing_and_cancellation_during_background_ocr_keep_primary(self):
        from threading import Event
        started=Event();release=Event()
        mask=np.full((30,30),255,np.uint8);bubble=Bubble((10,10,30,30),mask.copy(),mask.copy())
        def recognize(*args):
            started.set();release.wait(3)
            if main.store.cancel.is_set():raise main.OCRCancelled('controlled cancellation')
            return dict(text='late OCR',provider='test',model_id='controlled')
        with patch.object(main,'detect_with_fallback',return_value=SimpleNamespace(bubbles=[bubble],metadata={})),patch.object(main,'recognize',side_effect=recognize):
            response=self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'})
            self.assertTrue(started.wait(3));self.assertTrue(main.store.job['editingAllowed'])
            region=main.store.document.region_graph.text_regions[0]
            corrected=self.post('/v1/text-regions/'+region.id,{'text':'Human correction'})
            self.assertEqual(corrected.status_code,200,corrected.text)
            job=response.json()['id'];self.post('/v1/jobs/'+job+'/cancel');release.set()
            deadline=time.monotonic()+4
            while main.store.job['status']=='running' and time.monotonic()<deadline:time.sleep(.01)
            self.assertEqual(main.store.job['status'],'cancelled')
            self.assertEqual(main.store.document.bubbles[0].id,bubble.id)
            self.assertEqual(main.store.document.region_graph.region(region.id).source_text,'Human correction')

    def test_primary_failure_is_not_reported_as_success_and_can_be_retried(self):
        with patch.object(main,'detect_with_fallback',side_effect=RuntimeError('controlled detector startup failure')):
            response=self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'})
            deadline=time.monotonic()+5
            while main.store.job['status'] in {'queued','running'} and time.monotonic()<deadline:time.sleep(.01)
        self.assertEqual(main.store.job['status'],'failed')
        self.assertIn('controlled detector startup failure',main.store.job['error'])
        self.assertEqual(main.store.job['result']['failures'][0]['stage'],'detect')
        diagnostic=json.loads((main.CACHE/'last-scan-failure.json').read_text())
        self.assertEqual(diagnostic['jobId'],response.json()['id'])
        self.assertEqual(diagnostic['stage'],'detect')
        self.assertEqual(diagnostic['errorKind'],'RuntimeError')
        self.assertEqual(main.store.document.bubbles,[])
        self.assertEqual(main.store.document.detection_runs,[])
        mask=np.full((30,30),255,np.uint8);bubble=Bubble((10,10,30,30),mask.copy(),mask.copy())
        with patch.object(main,'detect_with_fallback',return_value=SimpleNamespace(bubbles=[bubble],metadata={})),patch.object(main,'recognize',return_value=dict(text='TEST',provider='controlled',model_id='fixture')):
            self.post('/v1/scan-detect',{'provider':'opencv','device':'cpu'});self.wait()
        self.assertEqual(len(main.store.document.bubbles),1)

if __name__=='__main__':unittest.main()
