"""Focused real-fixture ROI regression, no detection/OCR or original-file writes."""
from pathlib import Path
from io import BytesIO
import unittest
import numpy as np
from fastapi.testclient import TestClient
from backend import main

FIXTURE=Path(__file__).resolve().parents[2]/'Yuchi-Diagnostics/chisa-features-20261107/fixtures/geometry-copy.mangaclean'

@unittest.skipUnless(FIXTURE.is_file(),'Local copied fixture not available')
class RealGeometryBasisTests(unittest.TestCase):
    def test_regrown_page009_region_keeps_bottom_text_and_cleaning_remains_mask_bounded(self):
        client=TestClient(main.app);headers={'Authorization':'Bearer '+main.TOKEN}
        main.store.job=None
        opened=client.post('/v1/open?discard=true',headers=headers,files={'file':('copy.mangaclean',BytesIO(FIXTURE.read_bytes()),'application/octet-stream')})
        self.assertEqual(opened.status_code,200,opened.text)
        doc=main.store.document;original_source=doc.source.copy();before=doc.working.copy();identifier=doc.bubbles[2].id
        old_seg=doc.bubbles[2].full_segmentation(doc.source.shape[:2]);path=f'/v1/bubbles/{identifier}/geometry'
        for height in [152,229]:
            response=client.post(path,headers=headers,json={'rect':[227,519,138,height]})
            self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(int(np.count_nonzero(doc.bubbles[2].text)),7560)
        preview=client.post(f'/v1/bubbles/{identifier}/preview',headers=headers,json={})
        self.assertEqual(preview.status_code,200,preview.text)
        mask=main.store.preview['mask'].copy()
        self.assertGreater(np.count_nonzero(mask[519+152:519+229,227:227+138]),0,'SEEN BEFORE must not disappear after shrinking and expanding')
        self.assertFalse(np.any((mask>0)&(main.store.preview['safe']==0)))
        self.assertFalse(np.any((doc.bubbles[2].full_segmentation(doc.source.shape[:2])>0)&(old_seg==0)))
        cleaned=client.post('/v1/clean/confirm',headers=headers,json={'previewId':preview.json()['id']})
        self.assertEqual(cleaned.status_code,200,cleaned.text)
        self.assertEqual(cleaned.json()['result']['outsideChangedPixels'],0)
        self.assertGreater(cleaned.json()['result']['changedPixels'],0)
        np.testing.assert_array_equal(doc.source,original_source)
        changed=np.any(doc.working!=before,axis=2);self.assertFalse(np.any(changed&(mask==0)))
        self.assertEqual(client.post('/v1/undo',headers=headers).status_code,200)
        np.testing.assert_array_equal(doc.working,before)
        self.assertEqual(client.post('/v1/redo',headers=headers).status_code,200)
        self.assertFalse(np.any(np.any(doc.working!=before,axis=2)&(mask==0)))

if __name__=='__main__':unittest.main()
