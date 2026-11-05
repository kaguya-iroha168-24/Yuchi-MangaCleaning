"""Language routing and metadata-only history; no model loading in unit tests."""
from io import BytesIO
from threading import Event
from unittest import TestCase,main as unittest_main
from unittest.mock import patch
import time
import cv2,numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services.ocr import recognize,OCRCancelled,OCRUnavailable,WindowsOCRProvider,MangaOCRProvider

class OCRG3Tests(TestCase):
 def setUp(self):
  self.client=TestClient(main.app);self.headers={'Authorization':'Bearer '+main.TOKEN,'Origin':'http://tauri.localhost'};main.store.job=None
  image=np.full((100,200,3),255,np.uint8);cv2.putText(image,'SOURCE',(10,60),cv2.FONT_HERSHEY_SIMPLEX,1,(0,0,0),2)
  _,encoded=cv2.imencode('.png',image)
  self.assertEqual(self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('copy.png',BytesIO(encoded),'image/png')}).status_code,200)
  self.post('/v1/text-regions',dict(rect=[0,0,200,100],text='manual'));self.region=main.store.document.region_graph.text_regions[0];self.path='/v1/text-regions/'+self.region.id
 def post(self,path,data):
  result=self.client.post(path,headers=self.headers,json=data);self.assertEqual(result.status_code,200,result.text);return result.json()
 def test_explicit_english_routing_provenance_and_review_language(self):
  seen=[]
  def fake(crop,config,cancel,on_progress=None):seen.append(config);return dict(text='Hello...',language='en',provider='windows_ocr',device='cpu',model_id='fixture',confidence=None)
  with patch('backend.main.recognize',side_effect=fake):
   self.post(self.path+'/ocr',dict(language='en',device='cpu'))
   deadline=time.monotonic()+2
   while main.store.job['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(seen[0]['provider'],'windows_ocr');self.assertEqual(main.store.job['status'],'done',main.store.job)
  region=main.store.document.region_graph.region(self.region.id);self.assertEqual(region.source_text,'manual');self.assertEqual(region.provenance['ocr']['raw_text'],'Hello...')
  self.post(self.path+'/ocr-review',dict(decision='Accepted',editedText='Hello!',replaceExisting=True));self.assertEqual(region.language,'en')
  self.post('/v1/undo',{});self.assertEqual(main.store.document.region_graph.region(region.id).source_text,'manual')
 def test_text_history_does_not_copy_image_or_change_working(self):
  working=main.store.document.working.copy();mask=main.store.document.mask.copy()
  self.post(self.path,dict(text='corrected',direction='ltr'))
  self.assertEqual(set(main.store.undo[-1]),{'region_graph','active_text_id'})
  self.assertFalse(self.post('/v1/undo',{})['imagesChanged']);self.assertTrue(np.array_equal(working,main.store.document.working));self.assertTrue(np.array_equal(mask,main.store.document.mask))
 def test_invalid_language_and_english_gpu_fail_without_job(self):
  for data in [dict(language='xx'),dict(language='en',device='cuda')]:
   self.assertIn(self.client.post(self.path+'/ocr',headers=self.headers,json=data).status_code,(400,422));self.assertIsNone(main.store.job)
 def test_cancelled_request_never_launches_provider(self):
  cancel=Event();cancel.set()
  with patch.object(WindowsOCRProvider,'recognize') as provider:
   self.assertRaises(OCRCancelled,recognize,main.store.document.source,{'provider':'windows_ocr'},cancel);provider.assert_not_called()
 def test_timeout_stops_owned_worker_without_partial_proposal(self):
  from unittest.mock import MagicMock
  worker=MagicMock();worker.poll.return_value=None
  with patch.object(MangaOCRProvider,'command',return_value=['unused']),patch('mangaclean.services.ocr.subprocess.Popen',return_value=worker),patch('mangaclean.services.ocr.time.monotonic',side_effect=[0,2]),patch('mangaclean.services.ocr.stop_process') as stop:
   self.assertRaises(OCRUnavailable,MangaOCRProvider().recognize,main.store.document.source,{'device':'cpu','timeout_seconds':1},Event())
   stop.assert_called_once_with(worker)
  self.assertNotIn('ocr',self.region.provenance);self.assertEqual(self.region.source_text,'manual')
 def test_timeout_reports_worker_stage_without_progress_callback(self):
  from unittest.mock import MagicMock
  def started(*args,**kwargs):
   kwargs['stdout'].write('OCR stage: model loading\n');kwargs['stdout'].flush()
   worker=MagicMock();worker.poll.return_value=None;return worker
  with patch.object(MangaOCRProvider,'command',return_value=['unused']),patch('mangaclean.services.ocr.subprocess.Popen',side_effect=started),patch('mangaclean.services.ocr.time.monotonic',side_effect=[0,0,0,0,2]),patch('mangaclean.services.ocr.time.sleep'),patch('mangaclean.services.ocr.stop_process'):
   self.assertRaisesRegex(OCRUnavailable,'model loading',MangaOCRProvider().recognize,main.store.document.source,{'device':'cpu','timeout_seconds':1},Event())

if __name__=='__main__':unittest_main()
