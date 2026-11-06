"""Detected candidates are usable without approval; mask safety remains mandatory."""
from io import BytesIO
import time
import unittest
import numpy as np
from fastapi.testclient import TestClient
from backend import main
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

    def test_optional_mask_brush_does_not_require_candidate_acceptance(self):
        preview=self.post(f'/v1/bubbles/{self.bubble.id}/preview').json()
        edited=self.post('/v1/preview/edit',{'previewId':preview['id'],'mode':'add','radius':3,'points':[[0,0]]})
        self.assertEqual(edited.status_code,200,edited.text)
        self.assertEqual(self.bubble.review_decision,'Needs Review')
        self.assertGreater(edited.json()['analysis']['clipped_brush_pixels'],0)
        stale=self.post('/v1/preview/edit',{'previewId':'stale','mode':'add','radius':3,'points':[[0,0]]})
        self.assertEqual(stale.status_code,409)

if __name__=='__main__':unittest.main()
