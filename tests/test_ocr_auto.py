"""One OCR action, bounded sequential routing and automatic candidate crops."""
from threading import Event
from unittest import TestCase,main as unittest_main
from unittest.mock import patch
import numpy as np
from mangaclean.services.ocr import recognize,OCRCancelled,OCRUnavailable
from tests.test_ocr_g3 import OCRG3Tests
from backend import main

class RoutingTests(TestCase):
 def setUp(self):
  self.crop=np.zeros((20,50,3),np.uint8);self.crop[0]=255;self.config=dict(provider='auto',device='cpu',timeout_seconds=30);self.cancel=Event()
 def test_readable_latin_probe_avoids_heavy_runtime(self):
  with patch('mangaclean.services.ocr.WindowsOCRProvider.recognize',return_value=dict(text='JUNK...',provider='windows_ocr',model_id='native',confidence=None)),patch('mangaclean.services.ocr.MangaOCRProvider.recognize') as heavy:
   result=recognize(self.crop,self.config,self.cancel);self.assertEqual(result['text'],'JUNK...');heavy.assert_not_called();self.assertTrue(result['routing']['requires_review'])
 def test_empty_probe_uses_japanese_and_preserves_pilot(self):
  with patch('mangaclean.services.ocr.WindowsOCRProvider.recognize',return_value=dict(text='',provider='windows_ocr')),patch('mangaclean.services.ocr.MangaOCRProvider.recognize',return_value=dict(text='こんにちは',provider='manga_ocr',model_id='existing',confidence=None)) as heavy:
   result=recognize(self.crop,self.config,self.cancel);self.assertEqual(result['text'],'こんにちは');heavy.assert_called_once();self.assertEqual(result['routing']['lightweight_text'],'')
 def test_cancel_between_routes_never_starts_heavy_runtime(self):
  def pilot(*args):self.cancel.set();return {'text':''}
  with patch('mangaclean.services.ocr.WindowsOCRProvider.recognize',side_effect=pilot),patch('mangaclean.services.ocr.MangaOCRProvider.recognize') as heavy:
   self.assertRaises(OCRCancelled,recognize,self.crop,self.config,self.cancel);heavy.assert_not_called()
 def test_missing_lightweight_capability_falls_back_without_installing(self):
  with patch('mangaclean.services.ocr.WindowsOCRProvider.recognize',side_effect=OCRUnavailable('Not installed')),patch('mangaclean.services.ocr.MangaOCRProvider.recognize',return_value=dict(text='日本',language='ja')) as heavy:
   result=recognize(self.crop,self.config,self.cancel);heavy.assert_called_once();self.assertEqual(result['routing']['lightweight_error'],'Not installed')
 def test_non_latin_and_punctuation_are_not_english_evidence(self):
  for probe in ['...','123','こんにちは ABC 日本語']:
   with self.subTest(probe=probe),patch('mangaclean.services.ocr.WindowsOCRProvider.recognize',return_value=dict(text=probe)),patch('mangaclean.services.ocr.MangaOCRProvider.recognize',return_value=dict(text='日本',language='ja')) as heavy:
    result=recognize(self.crop,self.config,self.cancel);heavy.assert_called_once();self.assertEqual(result['routing']['lightweight_text'],probe)

class CandidateOCRTests(OCRG3Tests):
 def test_candidate_creates_linked_region_without_manual_drawing(self):
  from mangaclean.core.bubble_detector import Bubble
  main.store.document.region_graph.text_regions.clear();main.store.document.region_graph.reading_order.clear()
  mask=np.ones((60,100),np.uint8)*255;bubble=Bubble((20,20,100,60),mask,mask,text_regions=((30,35,50,20),));main.store.document.bubbles=[bubble]
  def fake(crop,config,cancel,on_progress=None):return dict(text='HELLO',provider='fixture',model_id='test',language='en',confidence=None)
  with patch('backend.main.recognize',side_effect=fake):
   result=self.post('/v1/bubbles/'+bubble.id+'/ocr',dict(device='cpu'))
   self.assertIn('regionId',result)
   import time
   deadline=time.monotonic()+2
   while main.store.job['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.01)
  region=main.store.document.region_graph.region(result['regionId']);self.assertEqual(region.bubble_id,bubble.id);self.assertEqual(region.provenance['origin'],'automatic_bubble_text_region');self.assertEqual(region.source_text,'');self.assertEqual(region.provenance['ocr']['status'],'Needs Review');self.assertEqual(bubble.review_decision,'Needs Review')
 def test_multiple_linked_regions_require_explicit_selection(self):
  from mangaclean.core.bubble_detector import Bubble
  from mangaclean.core.region_graph import TextRegion
  mask=np.ones((60,100),np.uint8)*255;bubble=Bubble((20,20,100,60),mask,mask);main.store.document.bubbles=[bubble]
  self.region.bubble_id=bubble.id;main.store.document.region_graph.add(TextRegion((25,25,20,20),bubble_id=bubble.id))
  count=len(main.store.document.region_graph.text_regions);revision=main.store.document.revision
  response=self.client.post('/v1/bubbles/'+bubble.id+'/ocr',headers=self.headers,json={})
  self.assertEqual(response.status_code,409);self.assertEqual(main.store.document.revision,revision);self.assertEqual(len(main.store.document.region_graph.text_regions),count);self.assertIsNone(main.store.job)
 def test_failed_automatic_ocr_preserves_artwork_mask_and_review(self):
  from mangaclean.core.bubble_detector import Bubble
  import time
  main.store.document.region_graph.text_regions.clear();main.store.document.region_graph.reading_order.clear()
  mask=np.ones((60,100),np.uint8)*255;bubble=Bubble((20,20,100,60),mask,mask);main.store.document.bubbles=[bubble]
  original=main.store.document.source.copy();working=main.store.document.working.copy();cleaning=main.store.document.mask.copy()
  with patch('backend.main.recognize',side_effect=OCRUnavailable('fixture failure')):
   result=self.post('/v1/bubbles/'+bubble.id+'/ocr',{})
   deadline=time.monotonic()+2
   while main.store.job['status'] in ('queued','running') and time.monotonic()<deadline:time.sleep(.01)
  self.assertEqual(main.store.job['status'],'failed');region=main.store.document.region_graph.region(result['regionId']);self.assertNotIn('ocr',region.provenance);self.assertEqual(region.source_text,'')
  self.assertTrue(np.array_equal(original,main.store.document.source));self.assertTrue(np.array_equal(working,main.store.document.working));self.assertTrue(np.array_equal(cleaning,main.store.document.mask));self.assertEqual(bubble.review_decision,'Needs Review')

if __name__=='__main__':unittest_main()
