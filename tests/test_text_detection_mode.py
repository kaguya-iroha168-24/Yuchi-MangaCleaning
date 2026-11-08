import unittest
from threading import Event
from time import monotonic, sleep
from unittest.mock import patch

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph, TextRegion


class TextDetectionMode(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'Authorization': 'Bearer ' + main.TOKEN}
        main.store.chapter = main.store.job = None
        main.store.undo.clear()
        main.store.redo.clear()
        source = np.full((160, 230, 3), 255, np.uint8)
        interior = np.full((120, 190), 255, np.uint8)
        ink = np.zeros_like(interior)
        for x in (15, 32, 49, 118, 135, 152):
            for y in (20, 45, 70):
                ink[y:y+12, x:x+9] = 255
        source[20:140, 20:210][ink > 0] = 0
        self.bubble = Bubble((20, 20, 190, 120), interior, ink)
        graph = RegionGraph.for_legacy(source, 'text-mode.png')
        self.doc = main.Document(source, np.full_like(source, 255), 'text-mode.png',
                                 np.zeros(source.shape[:2], np.uint8), bubbles=[self.bubble], region_graph=graph)
        main.store.document = self.doc
        self.boxes = [((35, 40, 44, 62), .91), ((138, 40, 44, 62), .87)]
        detector = patch('mangaclean.services.text_regions.detect_text_bubbles', return_value=self.boxes)
        self.detect = detector.start()
        self.addCleanup(detector.stop)

    def post(self, route, payload=None):
        result = self.client.post(route, headers=self.headers, json=payload or {})
        self.assertEqual(result.status_code, 200, result.text)
        return result

    def wait(self, status='done'):
        deadline = monotonic() + 5
        while main.store.job['status'] == 'running' and monotonic() < deadline:
            sleep(.01)
        self.assertEqual(main.store.job['status'], status, main.store.job)

    def test_tight_boxes_use_original_ink_and_do_not_change_cleaning(self):
        with patch.object(main, 'detect_with_fallback', side_effect=AssertionError('No bubble detector')):
            self.post('/v1/detect-text')
            self.wait()
            left, right = self.doc.region_graph.text_regions
            self.assertIs(self.detect.call_args.args[0], self.doc.source)
            self.assertEqual([left.rect, right.rect], [box for box, _ in self.boxes])
            self.assertEqual(left.provenance['detector'], 'ogkalu_v4_s_int8')
            self.assertEqual(left.provenance['confidence'], .91)
            self.assertLessEqual(left.rect[0] + left.rect[2], right.rect[0])
            self.assertLess(left.rect[2], self.bubble.rect[2] / 2)
            self.assertLess(right.rect[3], self.bubble.rect[3])
            self.assertEqual([left.bubble_id, right.bubble_id], [self.bubble.id] * 2)
            self.assertIs(self.doc.bubbles[0], self.bubble)
            self.assertTrue(np.all(self.doc.working == 255))
            self.assertFalse(self.doc.mask.any())
            self.post('/v1/detect-text')
            self.wait()
            self.assertEqual([r.id for r in self.doc.region_graph.text_regions], [left.id, right.id])
            self.post('/v1/undo')
            self.assertFalse(self.doc.region_graph.text_regions)

    def test_replaces_legacy_automatic_boxes_and_retains_edited_text(self):
        graph = self.doc.region_graph
        graph.add(TextRegion(rect=(3, 3, 9, 9), provenance={'origin': 'automatic_text_detection'}))
        edited = TextRegion(rect=(34, 39, 46, 64), bubble_id=self.bubble.id, source_text='Edited',
                            provenance={'origin': 'automatic_text_detection'})
        graph.add(edited)
        self.post('/v1/detect-text')
        self.wait()
        kept, new = self.doc.region_graph.text_regions
        self.assertEqual((kept.id, kept.source_text), (edited.id, 'Edited'))
        self.assertEqual(new.rect, self.boxes[1][0])

    def test_cancellation_during_model_run_keeps_existing_regions(self):
        graph = self.doc.region_graph
        graph.add(TextRegion(rect=(3, 3, 9, 9), provenance={'origin': 'automatic_text_detection'}))
        entered, release = Event(), Event()

        def detect(_):
            entered.set()
            if not release.wait(5):
                raise TimeoutError('Test did not release the detector')
            return self.boxes

        self.detect.side_effect = detect
        job = self.post('/v1/detect-text').json()
        try:
            self.assertTrue(entered.wait(2))
            self.post(f'/v1/jobs/{job["id"]}/cancel')
        finally:
            release.set()
        self.wait('cancelled')
        self.assertIs(self.doc.region_graph, graph)

    def test_translate_selected_text_sends_one_crop(self):
        self.post('/v1/detect-text')
        self.wait()
        _, selected = self.doc.region_graph.text_regions
        with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
            self.post('/v1/translation/settings', {'model': 'gemini-3.5-flash', 'key': 'fake-test-key-1234567'})
        try:
            with patch('backend.translation.Gemini.read_and_translate', return_value=[('RIGHT', 'Kanan')]) as vision:
                self.post('/v1/translation/start', {'pageId': self.doc.region_graph.page_id,
                          'scope': 'text', 'regionId': selected.id})
                self.wait()
                crop, = vision.call_args.args[0]
            x, y, w, h = selected.rect
            np.testing.assert_array_equal(crop, self.doc.source[y:y+h, x:x+w])
            layer, = self.doc.dialogues
            self.assertEqual((layer.source_region_id, layer.text), (selected.id, 'Kanan'))
        finally:
            self.post('/v1/translation/settings', {'clear': True})
