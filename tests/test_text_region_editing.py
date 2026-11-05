"""New crop/direction editing contract; no inference or old parity tests."""
from io import BytesIO
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services.project_io import load_project


class TextRegionEditing(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = dict(Authorization='Bearer '+main.TOKEN, Origin='http://tauri.localhost')
        main.store.job = None
        fixture = ROOT/'.cache/realworld-20261028/fixtures/Akuhamu-008.jpg'
        response = self.client.post('/v1/open?discard=true', headers=self.headers,
                                   files={'file':(fixture.name,BytesIO(fixture.read_bytes()),'image/jpeg')})
        self.assertEqual(response.status_code,200)
        added = self.post('/v1/text-regions', dict(rect=[1518,861,41,136],text='manual'))
        self.identifier = added.json()['document']['textRegions'][0]['id']
        self.path = '/v1/text-regions/'+self.identifier

    def post(self,path,data): return self.client.post(path,headers=self.headers,json=data)
    def region(self): return main.store.document.region_graph.region(self.identifier)

    def test_crop_stales_proposal_and_roundtrips_history(self):
        self.region().provenance['ocr']=dict(status='Needs Review',raw_text='retained raw',edited_text='retained raw',
                confidence=None,model_id='controlled-contract-fixture',provider='test',region_rect=[1518,861,41,136])
        response=self.post(self.path,dict(rect=[1516,859,45,140],direction='vertical'))
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(self.region().provenance['ocr']['status'],'Stale')
        self.assertEqual(self.region().provenance['ocr']['raw_text'],'retained raw')
        self.assertEqual(response.json()['document']['textRegions'][0]['direction'],'vertical')
        self.assertEqual(self.post(self.path+'/ocr-review',dict(decision='Accepted',editedText='x')).status_code,409)
        self.post('/v1/undo',{})
        self.assertEqual(tuple(self.region().rect),(1518,861,41,136))
        self.assertEqual(self.region().provenance['ocr']['status'],'Needs Review')
        self.post('/v1/redo',{})
        self.assertEqual(self.region().direction,'vertical')
        saved=self.post('/v1/save/project',{})
        self.assertEqual(saved.status_code,200,saved.text)
        loaded=load_project(saved.json()['path'])['region_graph'].region(self.identifier)
        self.assertEqual(tuple(loaded.rect),(1516,859,45,140))
        self.assertEqual(loaded.direction,'vertical')
        self.assertEqual(loaded.provenance['ocr']['raw_text'],'retained raw')

    def test_invalid_geometry_is_atomic(self):
        revision=main.store.document.revision
        for rect in [[-1,0,10,10],[0,0,0,1],[1600,0,100,10],[True,0,10,10],[1.5,0,10,10]]:
            response=self.post(self.path,dict(text='must not commit',rect=rect))
            self.assertEqual(response.status_code,422,(rect,response.text))
            self.assertEqual(self.region().source_text,'manual')
            self.assertEqual(main.store.document.revision,revision)
        self.assertEqual(self.post(self.path,{}).status_code,422)
        self.assertEqual(self.post(self.path,dict(direction='sideways')).status_code,422)

    def test_direction_and_correction_preserve_source_pixels(self):
        before=main.store.document.source.copy();working=main.store.document.working.copy()
        self.assertEqual(self.post(self.path,dict(direction='vertical')).status_code,200)
        self.assertEqual(self.post(self.path,dict(text='corrected')).status_code,200)
        import numpy as np
        self.assertTrue(np.array_equal(before,main.store.document.source))
        self.assertTrue(np.array_equal(working,main.store.document.working))
        self.assertEqual(self.region().source_text,'corrected')


if __name__=='__main__':
    result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(TextRegionEditing))
    report=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028\TEXT_REGION_REGRESSION.json')
    report.write_text(json.dumps(dict(tests=result.testsRun,failures=len(result.failures),errors=len(result.errors),
                                     passed=result.wasSuccessful(),scope='New crop/direction editing only; controlled OCR provenance fixture.'),indent=2))
    raise SystemExit(0 if result.wasSuccessful() else 1)
