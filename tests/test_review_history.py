"""Review history must preserve metadata without copying unchanged page rasters."""
from unittest import TestCase,main as unittest_main
import numpy as np
from tests import test_ocr_g3 as ocr_fixture
from backend import main
from mangaclean.core.bubble_detector import Bubble


class ReviewHistoryTests(TestCase):
    post=ocr_fixture.OCRG3Tests.post
    def setUp(self):
        ocr_fixture.OCRG3Tests.setUp(self)
        mask=np.full((40,80),255,np.uint8)
        self.bubble=Bubble((20,20,80,40),mask,mask.copy(),confidence=.95,provenance={'origin':'controlled primary'})
        main.store.document.bubbles=[self.bubble];main.store.undo.clear();main.store.redo.clear()
        self.path='/v1/bubbles/'+self.bubble.id+'/review'
    def test_review_undo_redo_does_not_restore_or_duplicate_page_rasters(self):
        doc=main.store.document;source=doc.source;working=doc.working;mask=doc.mask
        self.post(self.path,dict(decision='Accepted',kind='Unclassified'))
        self.assertTrue('working' not in main.store.undo[-1],'Review must not snapshot an unchanged working image')
        self.assertTrue('mask' not in main.store.undo[-1],'Review must not snapshot the page mask')
        result=self.post('/v1/undo',{});self.assertFalse(result['imagesChanged'])
        self.assertEqual(doc.bubbles[0].review_decision,'Needs Review')
        result=self.post('/v1/redo',{});self.assertFalse(result['imagesChanged']);self.assertEqual(doc.bubbles[0].review_decision,'Accepted')
        self.assertIs(doc.source,source);self.assertIs(doc.working,working);self.assertIs(doc.mask,mask)
        self.assertEqual(doc.region_graph.text_regions[0].source_text,'manual')
        self.assertEqual(doc.bubbles[0].provenance,{'origin':'controlled primary'});self.assertEqual(doc.bubbles[0].confidence,.95)
    def test_decision_and_kind_roundtrip_through_multiple_history_frames(self):
        kinds=main.CANDIDATE_KINDS;kind=next(k for k in kinds if k!='Unclassified')
        self.post(self.path,dict(decision='Accepted',kind=kind));self.post(self.path,dict(decision='Rejected',kind='Unclassified'))
        for _ in range(2):self.post('/v1/undo',{})
        self.assertEqual(main.store.document.bubbles[0].review_decision,'Needs Review')
        self.post('/v1/redo',{});self.assertEqual(main.store.document.bubbles[0].candidate_kind,kind)
        self.post('/v1/redo',{});self.assertEqual(main.store.document.bubbles[0].review_decision,'Rejected')
    def test_invalid_review_does_not_allocate_history(self):
        response=self.client.post(self.path,headers=self.headers,json=dict(decision='invalid',kind='Unclassified'))
        self.assertEqual(response.status_code,400);self.assertFalse(main.store.undo)


if __name__=='__main__':unittest_main()
