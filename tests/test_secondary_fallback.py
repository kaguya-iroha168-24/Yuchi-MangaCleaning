"""Fault injection only: no model loading, inference, original files or benchmarks."""
from copy import deepcopy
from io import BytesIO
from threading import Event
from unittest import TestCase, main as unittest_main
from unittest.mock import patch
import os
import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.services.detection import DetectionBatch
from mangaclean.services.detection_runtime import detect_with_fallback, DetectionCancelled

class SecondaryFallbackTests(TestCase):
    def setUp(self):
        self.image=np.full((128,128,3),255,np.uint8)
        mask=np.ones((20,10),np.uint8)*255
        self.primary=DetectionBatch([Bubble((80,80,10,20),mask.copy(),mask.copy(),confidence=.8)],
                                    {'device':'cpu','candidate_count':1,'post_nms_count':1,'nested':{'value':[1]}})
        self.cancel=Event()

    def run_scan(self):
        return detect_with_fallback('shima_v1',self.image,self.image,'cpu',self.cancel,
                                    runner=lambda *a,**kw:self.primary)

    def assert_primary(self,result):
        self.assertIs(result,self.primary)
        self.assertEqual(len(result.bubbles),1)
        self.assertEqual(result.bubbles[0].rect,(80,80,10,20))
        self.assertTrue(np.all(result.bubbles[0].text==255))
        self.assertEqual(result.metadata['nested'],{'value':[1]})
        self.assertTrue(result.metadata['automatic_recovery']['fallback_to_primary'])

    def test_timeout_and_exception_preserve_primary(self):
        for error in [TimeoutError('secondary timeout'),RuntimeError('secondary failed'),ValueError('invalid secondary result')]:
            with self.subTest(error=type(error).__name__),patch('mangaclean.services.candidate_recovery.recover',side_effect=error):
                result=self.run_scan();self.assert_primary(result)
                self.assertEqual(result.metadata['automatic_recovery']['error_kind'],type(error).__name__)

    def test_partial_candidate_and_metadata_mutations_do_not_leak(self):
        identifier=self.primary.bubbles[0].id
        def corrupt(batch,*args):
            batch.bubbles[0].rect=(0,0,10,20);batch.bubbles[0].text[:]=0
            batch.bubbles.append(deepcopy(batch.bubbles[0]));batch.metadata['nested']['value'].append(2)
            raise RuntimeError('failure after partial recovery')
        with patch('mangaclean.services.candidate_recovery.recover',side_effect=corrupt):self.assert_primary(self.run_scan())
        self.assertEqual(self.primary.bubbles[0].id,identifier)

    def test_cancel_is_not_converted_to_success(self):
        with patch('mangaclean.services.candidate_recovery.recover',side_effect=DetectionCancelled('cancel')):
            with self.assertRaises(DetectionCancelled):self.run_scan()
        self.assertNotIn('automatic_recovery',self.primary.metadata)

    def test_cancel_wins_over_timeout_and_late_success(self):
        for fail in [True,False]:
            self.cancel.clear()
            def finish(batch,*args):
                self.cancel.set()
                if fail:raise TimeoutError('cancel raced timeout')
                return batch
            with self.subTest(fail=fail),patch('mangaclean.services.candidate_recovery.recover',side_effect=finish):
                with self.assertRaises(DetectionCancelled):self.run_scan()

    def test_cancel_before_primary_runs_nothing(self):
        self.cancel.set()
        with patch('mangaclean.services.candidate_recovery.recover') as recovery:
            with self.assertRaises(DetectionCancelled):self.run_scan()
            recovery.assert_not_called()

    def test_empty_secondary_real_recovery_is_success_without_additions(self):
        mask=np.ones((40,20),np.uint8)*255
        proposal=Bubble((5,5,20,40),mask,mask,glyph_count=3)
        calls=[]
        def runner(*args,**kwargs):
            calls.append(1)
            return self.primary if len(calls)==1 else DetectionBatch([],{'device':'cpu'})
        # min side must satisfy the unchanged experimental proposal policy.
        proposal.rect=(5,5,24,48)
        with patch('mangaclean.services.candidate_recovery.detect_bubbles',return_value=[proposal]):
            result=detect_with_fallback('shima_v1',self.image,self.image,'cpu',self.cancel,runner=runner,recovery_enabled=True)
        self.assertEqual(len(calls),2)
        self.assertEqual([b.id for b in result.bubbles],[b.id for b in self.primary.bubbles])
        self.assertEqual(result.metadata['automatic_recovery']['added_count'],0)
        self.assertNotIn('fallback_to_primary',result.metadata['automatic_recovery'])

    def test_standard_default_enters_isolated_recovery_without_test_flag(self):
        with patch.dict(os.environ,{},clear=True),patch('mangaclean.services.candidate_recovery.recover',side_effect=lambda batch,*args:batch) as recovery:
            result=detect_with_fallback('shima_v1',self.image,self.image,'cpu',self.cancel,runner=lambda *a,**kw:self.primary)
            recovery.assert_called_once()
            self.assertIsNot(result,self.primary)
            self.assertEqual([b.id for b in result.bubbles],[b.id for b in self.primary.bubbles])

    def test_explicit_primary_only_never_enters_recovery(self):
        with patch.dict(os.environ,{},clear=True),patch('mangaclean.services.candidate_recovery.recover') as recovery:
            result=detect_with_fallback('shima_v1',self.image,self.image,'cpu',self.cancel,runner=lambda *a,**kw:self.primary,recovery_enabled=False)
            self.assertIs(result,self.primary);recovery.assert_not_called()

    def test_primary_failure_still_fails(self):
        with self.assertRaisesRegex(RuntimeError,'primary failed'):
            detect_with_fallback('shima_v1',self.image,self.image,'cpu',self.cancel,
                runner=lambda *a,**kw:(_ for _ in ()).throw(RuntimeError('primary failed')),recovery_enabled=True)

    def test_editor_commit_and_cancellation_are_atomic(self):
        client=TestClient(main.app);headers={'Authorization':'Bearer '+main.TOKEN}
        png=cv2.imencode('.png',self.image)[1].tobytes()
        for condition in ['timeout','exception','cancel']:
            with self.subTest(condition=condition):
                main.store.job=None;main.store.cancel.clear()
                response=client.post('/v1/open?discard=true',headers=headers,files={'file':('synthetic-copy.png',BytesIO(png),'image/png')})
                self.assertEqual(response.status_code,200,response.text)
                doc=main.store.document;before_graph=doc.region_graph.to_dict();revision=doc.revision;undo=len(main.store.undo)
                def recovery(*args):
                    if condition=='cancel':raise DetectionCancelled('cancel')
                    raise TimeoutError('timeout') if condition=='timeout' else RuntimeError('exception')
                def integrated(*args,**kwargs):
                    return detect_with_fallback('shima_v1',args[1],args[2],'cpu',main.store.cancel,
                        runner=lambda *a,**kw:deepcopy(self.primary))
                main.store.job={'id':'fault-job','status':'queued'}
                with patch('backend.main.detect_with_fallback',side_effect=integrated),patch('mangaclean.services.candidate_recovery.recover',side_effect=recovery):
                    main.run_detect('fault-job',revision,doc.source.copy(),doc.working.copy(),'shima_v1','cpu')
                self.assertEqual(main.store.job['status'],'cancelled' if condition=='cancel' else 'done')
                self.assertTrue(np.array_equal(doc.source,self.image));self.assertTrue(np.array_equal(doc.working,self.image))
                self.assertFalse(np.any(doc.mask));self.assertEqual(doc.region_graph.to_dict(),before_graph)
                self.assertEqual(doc.revision,revision+(condition!='cancel'))
                self.assertEqual(len(main.store.undo),undo+(condition!='cancel'))
                self.assertEqual(len(doc.bubbles),0 if condition=='cancel' else 1)
                if condition!='cancel':
                    self.assertEqual(doc.detection_runs[-1]['automatic_recovery']['added_count'],0)
                    r=client.post('/v1/undo',headers=headers,json={});self.assertEqual(r.status_code,200)
                    self.assertEqual(doc.bubbles,[])

if __name__=='__main__':unittest_main()
