from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph, TextRegion
from mangaclean.services.project_io import save_project,load_project

class BubbleGeometryAPI(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app)
        self.headers={'Authorization':'Bearer '+main.TOKEN}
        source=np.full((80,80,3),255,np.uint8)
        mask=np.zeros((20,20),np.uint8);mask[3:17,3:17]=255
        b=Bubble((10,10,20,20),mask.copy(),mask.copy(),segmentation=mask.copy())
        graph=RegionGraph.for_legacy(source,'owned.png')
        region=TextRegion((10,10,20,20),bubble_id=b.id,source_text='manual',provenance={'ocr':{'raw_text':'RAW','edited_text':'RAW','status':'Needs Review','model_id':'controlled-test','provider':'test','region_rect':[10,10,20,20]}})
        graph.text_regions.append(region);graph.reading_order.append(region.id)
        main.store.document=main.Document(source,source.copy(),'owned.png',np.zeros((80,80),np.uint8),bubbles=[b],region_graph=graph)
        main.store.job=None;main.store.undo.clear();main.store.redo.clear()
        self.b=b;self.region=region;self.path=f'/v1/bubbles/{b.id}/geometry'

    def post(self,path,data=None):return self.client.post(path,headers=self.headers,json=data or {})

    def test_history_persistence_and_preview_invalidation(self):
        main.store.preview={'id':'old-mask'}
        response=self.post(self.path,{'rect':[8,8,24,24]})
        self.assertEqual(response.status_code,200,response.text)
        self.assertIsNone(main.store.preview)
        doc=main.store.document
        self.assertEqual(doc.region_graph.region(self.region.id).provenance['ocr']['status'],'Stale')
        self.assertEqual(doc.region_graph.region(self.region.id).source_text,'manual')
        self.assertEqual(doc.region_graph.region(self.region.id).provenance['ocr']['raw_text'],'RAW')
        self.assertEqual(self.post('/v1/clean/confirm',{'previewId':'old-mask'}).status_code,409)
        self.post('/v1/undo');self.assertEqual(main.store.document.bubbles[0].rect,(10,10,20,20))
        self.post('/v1/redo');self.assertEqual(main.store.document.bubbles[0].rect,(8,8,24,24))
        folder=Path(__file__).resolve().parents[1]/'.cache/sumi-hikari'
        with TemporaryDirectory(dir=folder) as temporary:
            path=Path(temporary)/'copy.mangaclean';save_project(path,main.store.document.snapshot())
            loaded=load_project(path);self.assertEqual(loaded['bubbles'][0].rect,(8,8,24,24))
            np.testing.assert_array_equal(loaded['source'],doc.source)
        np.testing.assert_array_equal(doc.source,doc.working)

    def test_rejection_is_atomic_and_authenticated(self):
        for rect in [[-1,0,20,20],[35,35,10,10],[True,10,20,20]]:
            self.assertEqual(self.post(self.path,{'rect':rect}).status_code,422)
            self.assertEqual(main.store.document.revision,0)
            self.assertEqual(main.store.document.bubbles[0].rect,(10,10,20,20))
        self.assertEqual(self.client.post(self.path,json={'rect':[8,8,24,24]}).status_code,401)

if __name__=='__main__':unittest.main()
