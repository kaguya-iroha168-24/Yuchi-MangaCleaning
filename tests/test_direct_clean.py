"""Detected candidates are usable without approval; mask safety remains mandatory."""
from io import BytesIO
import time
import unittest
import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.core.bubble_detector import Bubble
from tests.test_api_workflow import make_page

class DirectClean(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app);self.headers={'Authorization':'Bearer '+main.TOKEN}
        main.store.job=None
        source,png=make_page()
        self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('owned.png',BytesIO(png),'image/png')})
        self.post('/v1/detect',{'provider':'opencv','device':'cpu'})
        deadline=time.monotonic()+10
        while main.store.job['status'] in {'queued','running'} and time.monotonic()<deadline:time.sleep(.02)
        self.assertEqual(main.store.job['status'],'done')
        self.bubble=main.store.document.bubbles[0]

    def post(self,path,body=None):return self.client.post(path,headers=self.headers,json=body or {})

    def test_needs_review_can_preview_and_clean_without_accepting(self):
        self.assertEqual(self.bubble.review_decision,'Needs Review')
        result=self.post(f'/v1/bubbles/{self.bubble.id}/preview')
        self.assertEqual(result.status_code,200,result.text)
        mask=main.store.preview['mask'].copy();before=main.store.document.working.copy()
        cleaned=self.post('/v1/clean/confirm',{'previewId':result.json()['id'],'method':'Telea Inpainting'})
        self.assertEqual(cleaned.status_code,200,cleaned.text)
        self.assertEqual(cleaned.json()['result']['outsideChangedPixels'],0)
        np.testing.assert_array_equal(main.store.document.working[mask==0],before[mask==0])
        np.testing.assert_array_equal(main.store.document.source,before)
        self.assertEqual(self.bubble.review_decision,'Needs Review')

    def test_invalid_preview_is_still_rejected(self):
        self.assertEqual(self.post('/v1/clean/confirm',{'previewId':'stale'}).status_code,409)

    def test_clean_preserves_outline_that_curves_into_the_detected_interior(self):
        shape = np.zeros((130, 175), np.uint8)
        cv2.rectangle(shape, (8, 8), (140, 120), 255, -1)
        source = np.full((*shape.shape, 3), 255, np.uint8)
        cv2.rectangle(source, (8, 8), (163, 120), (0, 0, 0), 2)
        outline = np.zeros_like(shape)
        cv2.polylines(outline, [np.array([(152, 8), (144, 47), (136, 63), (144, 82), (152, 120)])],
                      False, 255, 2)
        source[outline > 0] = 0
        cv2.putText(source, 'TALK', (28, 58), cv2.FONT_HERSHEY_SIMPLEX, .8, (0, 0, 0), 2)
        bubble = Bubble((0, 0, 175, 130), cv2.erode(shape, np.ones((5, 5), np.uint8)),
                        np.zeros_like(shape), segmentation=shape)
        proposal = main.prepare_bubble(source, bubble, np.zeros_like(shape))
        self.assertFalse(np.any(proposal.mask & outline))
        result = main.restore_text(source, proposal.mask, main.WHITE, interior=proposal.safe)
        np.testing.assert_array_equal(result.image[outline > 0], source[outline > 0])
        self.assertGreater(result.changed_pixels, 100)
        self.assertEqual(result.outside_changed_pixels, 0)

    def test_optional_mask_brush_does_not_require_candidate_acceptance(self):
        preview=self.post(f'/v1/bubbles/{self.bubble.id}/preview').json()
        edited=self.post('/v1/preview/edit',{'previewId':preview['id'],'mode':'add','radius':3,'points':[[0,0]]})
        self.assertEqual(edited.status_code,200,edited.text)
        self.assertEqual(self.bubble.review_decision,'Needs Review')
        self.assertGreater(edited.json()['analysis']['clipped_brush_pixels'],0)
        stale=self.post('/v1/preview/edit',{'previewId':'stale','mode':'add','radius':3,'points':[[0,0]]})
        self.assertEqual(stale.status_code,409)


class SelectedTextClean(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'Authorization': 'Bearer ' + main.TOKEN}
        source = np.full((125, 175, 3), 255, np.uint8)
        self.outline = np.zeros(source.shape[:2], np.uint8)
        cv2.polylines(self.outline, [np.array([(20, 3), (35, 58), (21, 120)])], False, 255, 2)
        cv2.line(self.outline, (42, 80), (121, 80), 255, 2)
        source[self.outline > 0] = 0
        self.ink = np.zeros_like(self.outline)
        cv2.putText(self.ink, 'TALK', (45, 65), cv2.FONT_HERSHEY_SIMPLEX, .8, 255, 2)
        source[self.ink > 0] = 0
        self.source = source
        main.store.job = None
        _, png = cv2.imencode('.png', source)
        result = self.client.post('/v1/open?discard=true', headers=self.headers, files={'file':('owned.png', png.tobytes(),'image/png')})
        self.page_id = result.json()['document']['pageId']
        self.region = self.post('/v1/text-regions', {'rect':[28, 28, 104, 65], 'text':'TALK'}).json()['document']['textRegions'][0]

    def post(self, route, body=None):
        return self.client.post(route, headers=self.headers, json=body or {})

    def preview(self, page_id=None):
        return self.post(f"/v1/text-regions/{self.region['id']}/preview", {'pageId': page_id or self.page_id})

    def test_cleans_selected_ink_preserves_art_and_supports_undo_redo(self):
        result = self.preview()
        self.assertEqual(result.status_code, 200, result.text)
        preview = result.json()
        mask = main.store.preview['mask'].copy()
        self.assertFalse(np.any(mask & self.outline))
        self.assertFalse(np.any((self.ink > 0) & (mask == 0)))
        brush = self.post('/v1/preview/edit', {'previewId':preview['id'], 'mode':'add', 'points':[[45, 80]]})
        self.assertEqual(brush.status_code, 422, brush.text)
        cleaned = self.post('/v1/clean/confirm', {'previewId':preview['id']})
        self.assertEqual(cleaned.status_code, 200, cleaned.text)
        doc = main.store.document
        np.testing.assert_array_equal(doc.working[mask == 0], self.source[mask == 0])
        self.assertTrue(np.all(doc.working[self.ink > 0] >= 245))
        np.testing.assert_array_equal(doc.source, self.source)
        self.assertIsNone(doc.manual_mask)
        after = doc.working.copy()
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        np.testing.assert_array_equal(doc.working, self.source)
        self.assertEqual(self.post('/v1/redo').status_code, 200)
        np.testing.assert_array_equal(doc.working, after)
        self.assertEqual(cleaned.json()['state']['document']['textRegions'][0], self.region)

    def test_wrong_page_and_dark_artwork_are_rejected_without_changes(self):
        self.assertEqual(self.preview('wrong-page').status_code, 409)
        doc = main.store.document
        doc.working[28:93, 28:132] = 30
        before = doc.working.copy()
        self.assertEqual(self.preview().status_code, 422)
        np.testing.assert_array_equal(doc.working, before)

if __name__=='__main__':unittest.main()
