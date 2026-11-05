"""Case-specific recovery contracts on copies; detector/model/settings stay unchanged."""
from copy import deepcopy
from io import BytesIO
from pathlib import Path
import json
import unittest
import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services.project_io import load_project

DIAG=Path(__file__).resolve().parents[2]/'Yuchi-Diagnostics/shima-junk-fn-20261029'
FIXTURE=DIAG.parent/'mangaclean-tauri-ui07/cleaned-fixture-copy.mangaclean'
ROI=[109,699,63,27]

class JunkRecoveryTests(unittest.TestCase):
    def setUp(self):
        main.store.job=None
        self.client=TestClient(main.app)
        self.headers={'Authorization':'Bearer '+main.TOKEN}
        response=self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('page009-copy.mangaclean',BytesIO(FIXTURE.read_bytes()),'application/octet-stream')})
        self.assertEqual(response.status_code,200,response.text)
        self.bubbles=deepcopy(response.json()['document']['bubbles'])
        self.before=main.store.document.working.copy();self.source=main.store.document.source.copy()

    def post(self,path,body):
        response=self.client.post(path,headers=self.headers,json=body)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()

    def test_archived_baseline_tauri_and_confidence_are_unchanged(self):
        audit=json.loads((DIAG/'RAW_PROPOSAL_AUDIT.json').read_text())
        for device in ['cpu','cuda-0']:
            self.assertTrue(audit['baselineTauriParity'][device]['rawExactlyEqual'])
        for case in audit['cases']:
            self.assertEqual((case['above025Count'],case['keptCount']),(96,11))
            self.assertEqual(case['above025WithJunkIoU025'],0)
            self.assertLess(case['bestJunkScoreIoU025']['confidence'],.25)
            self.assertFalse(case['bestJunkScoreIoU025']['keptNMS'])
            self.assertIsNone(case['bestJunkScoreIoU025']['suppressedBy'])
        config=json.loads((Path(main.ROOT)/'configs/detection.json').read_text())
        self.assertEqual(config['confidence'],.25);self.assertEqual(config['iou'],.7)

    def test_explicit_preview_clean_undo_save_preserves_other_candidates(self):
        response=self.client.post('/v1/clean/confirm',headers=self.headers,json={'previewId':'not-reviewed'})
        self.assertEqual(response.status_code,409)
        preview=self.post('/v1/manual/preview',{'rect':ROI})
        mask=main.store.preview['mask'].copy()
        self.assertGreater(preview['maskPixels'],0)
        self.assertTrue(np.array_equal(self.before,main.store.document.working))
        permitted=np.zeros(mask.shape,bool);x,y,w,h=ROI;permitted[y:y+h,x:x+w]=True
        self.assertFalse(np.any((mask>0)&~permitted))
        cleaned=self.post('/v1/clean/confirm',{'previewId':preview['id'],'method':'Auto / Recommended'})
        after=main.store.document.working.copy();changed=np.any(after!=self.before,axis=2)
        self.assertGreater(int(changed.sum()),0)
        self.assertEqual(int(np.count_nonzero(changed&(mask==0))),0)
        self.assertTrue(np.array_equal(main.store.document.source,self.source))
        self.assertEqual(cleaned['state']['document']['bubbles'],self.bubbles)
        self.post('/v1/undo',{});self.assertTrue(np.array_equal(main.store.document.working,self.before))
        self.post('/v1/redo',{});self.assertTrue(np.array_equal(main.store.document.working,after))
        region=self.post('/v1/text-regions',{'rect':ROI,'text':'JUNK...','direction':'ltr'})['document']['textRegions'][-1]
        saved=self.post('/v1/save/project',{})
        loaded=load_project(saved['path'])
        self.assertTrue(np.array_equal(loaded['clean'],after))
        self.assertEqual(loaded['region_graph'].region(region['id']).source_text,'JUNK...')
        self.assertEqual(len(loaded['bubbles']),11)
        report={'manualROI':ROI,'maskPixels':int(np.count_nonzero(mask)),'changedPixels':int(changed.sum()),
                'outsideMaskChangedPixels':0,'candidateCountBefore':11,'candidateCountAfter':11,
                'allExistingCandidatesUnchanged':True,'sourceUnchanged':True,'undoRedoPassed':True,
                'savedProject':saved['path'],'savedManualTextRegionId':region['id']}
        (DIAG/'MANUAL_RECOVERY_API.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        cv2.imwrite(str(DIAG/'manual-recovery-mask.png'),mask)
        cv2.imwrite(str(DIAG/'manual-recovery-after.png'),after)
        cv2.imwrite(str(DIAG/'junk-before-after.png'),np.concatenate([self.before[590:800,85:390],after[590:800,85:390]],axis=1))

    def test_empty_area_cannot_clean(self):
        response=self.client.post('/v1/manual/preview',headers=self.headers,json={'rect':[120,650,20,20]})
        self.assertEqual(response.status_code,422)
        response=self.client.post('/v1/clean/confirm',headers=self.headers,json={'previewId':'empty-area-has-no-preview'})
        self.assertEqual(response.status_code,409)
        self.assertTrue(np.array_equal(self.before,main.store.document.working))

    def test_preview_becomes_stale_after_document_edit(self):
        preview=self.post('/v1/manual/preview',{'rect':ROI})
        self.post('/v1/text-regions',{'rect':ROI,'text':'JUNK...','direction':'ltr'})
        response=self.client.post('/v1/clean/confirm',headers=self.headers,json={'previewId':preview['id']})
        self.assertEqual(response.status_code,409)
        self.assertTrue(np.array_equal(self.before,main.store.document.working))

if __name__=='__main__':unittest.main()
