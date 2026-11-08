from pathlib import Path
from tempfile import TemporaryDirectory
from time import monotonic, sleep
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from fastapi.testclient import TestClient

from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph
from mangaclean.services.project_io import load_project, save_project


class ManualBubble(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'Authorization': 'Bearer ' + main.TOKEN}
        self.source = np.full((80, 80, 3), 255, np.uint8)
        self.source[30:34, 30:38] = 0
        self.graph = RegionGraph.for_legacy(self.source, 'manual.png')
        main.store.document = main.Document(self.source, self.source.copy(), 'manual.png',
                                            np.zeros((80, 80), np.uint8), region_graph=self.graph)
        main.store.job = main.store.preview = main.store.chapter = None
        main.store.undo.clear()
        main.store.redo.clear()

    def post(self, path, **body):
        return self.client.post(path, headers=self.headers, json={'pageId': self.graph.page_id, **body})

    def test_create_resize_save_and_delete_without_touching_source_or_text(self):
        result = self.post('/v1/bubbles/manual', rect=[12, 12, 40, 40])
        self.assertEqual(result.status_code, 200, result.text)
        doc = main.store.document
        identifier = result.json()['document']['bubbles'][0]['id']
        self.assertTrue(result.json()['document']['bubbles'][0]['manualRegion'])
        self.assertEqual(doc.bubbles[0].id, identifier)
        self.assertEqual(self.post(f'/v1/bubbles/{identifier}/geometry', rect=[13, 13, 38, 38]).status_code, 200)
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual(doc.bubbles[0].rect, (12, 12, 40, 40))
        self.assertEqual(self.post('/v1/redo').status_code, 200)
        self.assertEqual(doc.bubbles[0].rect, (13, 13, 38, 38))
        region = main.TextRegion((20, 20, 20, 20), bubble_id=identifier, source_text='Source text')
        doc.region_graph.add(region)
        dialogue = main.Dialogue(text='Dialog', bubble_id=identifier, source_region_id=region.id,
                                 x=20, y=20, width=30, height=25)
        doc.dialogues.append(dialogue)
        with TemporaryDirectory(dir=main.CACHE) as temporary:
            path = Path(temporary) / 'manual.mangaclean'
            save_project(path, doc.snapshot())
            loaded = load_project(path)
        self.assertTrue(loaded['bubbles'][0].provenance['manual_region'])
        self.assertEqual(loaded['bubbles'][0].id, identifier)
        self.assertEqual(self.post(f'/v1/bubbles/{identifier}/delete-manual').status_code, 200)
        self.assertFalse(doc.bubbles)
        self.assertEqual(doc.region_graph.region(region.id).source_text, 'Source text')
        self.assertIsNone(doc.region_graph.region(region.id).bubble_id)
        self.assertEqual(doc.dialogues[0].text, 'Dialog')
        self.assertEqual(doc.dialogues[0].source_region_id, region.id)
        self.assertIsNone(doc.dialogues[0].bubble_id)
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual(doc.dialogues[0].bubble_id, identifier)
        self.assertEqual(self.post('/v1/redo').status_code, 200)
        self.assertFalse(doc.bubbles)
        np.testing.assert_array_equal(doc.source, self.source)
        np.testing.assert_array_equal(doc.working, self.source)
        self.assertFalse(np.any(doc.mask))

    def test_reject_stale_page_invalid_rect_and_detected_deletion(self):
        self.assertEqual(self.post('/v1/bubbles/manual', pageId='other', rect=[0, 0, 32, 32]).status_code, 409)
        self.assertEqual(self.post('/v1/bubbles/manual', rect=[0, 0, 81, 80]).status_code, 422)
        doc = main.store.document
        mask = np.ones((8, 8), np.uint8) * 255
        detected = Bubble((0, 0, 8, 8), mask, mask)
        doc.bubbles = [detected]
        self.assertEqual(self.post(f'/v1/bubbles/{detected.id}/delete-manual').status_code, 422)
        self.assertEqual(self.client.post('/v1/bubbles/manual', json={'pageId': self.graph.page_id, 'rect': [0, 0, 8, 8]}).status_code, 401)
        self.assertEqual(doc.revision, 0)
        self.assertFalse(main.store.undo)

    def test_first_scan_detects_and_preserves_existing_manual_region(self):
        created = self.post('/v1/bubbles/manual', rect=[12, 12, 40, 40]).json()['document']['bubbles'][0]
        mask = np.ones((12, 12), np.uint8) * 255
        detected = Bubble((60, 60, 12, 12), mask, mask)
        with patch.object(main, 'detect_with_fallback', return_value=SimpleNamespace(bubbles=[detected], metadata={})) as detect, \
                patch.object(main, 'recognize', return_value=dict(text='TEST', provider='fixture', model_id='fixture')):
            self.assertEqual(self.post('/v1/scan-detect', provider='opencv', device='cpu').status_code, 200)
            deadline = monotonic() + 5
            while main.store.job['status'] in ('queued', 'running') and monotonic() < deadline:
                sleep(.01)
            self.assertEqual(main.store.job['status'], 'done', main.store.job)
            detect.assert_called_once()
        self.assertEqual([b.id for b in main.store.document.bubbles], [created['id'], detected.id])

    def test_box_healing_outside_bubbles_clips_strokes_and_saves_through_v3(self):
        stale = self.post('/v1/healing/preview', pageId='other', rect=[25, 25, 20, 20])
        self.assertEqual(stale.status_code, 409)
        prepared = self.post('/v1/healing/preview', rect=[25, 25, 20, 20])
        self.assertEqual(prepared.status_code, 200, prepared.text)
        token = prepared.json()['id']
        self.assertEqual(prepared.json()['maskPixels'], 0)
        clean = lambda: self.post('/v1/clean/confirm', previewId=token, method='Telea Inpainting')
        self.assertEqual(clean().status_code, 422)
        self.assertFalse(main.store.undo)
        points = [[5, 5], [34, 31]]
        stroke = self.post('/v1/preview/edit', previewId=token, mode='add', points=points, radius=5)
        self.assertEqual(stroke.status_code, 200, stroke.text)
        self.assertGreater(stroke.json()['analysis']['clipped_brush_pixels'], 0)
        mask = main.store.preview['mask'].copy()
        self.assertEqual(np.count_nonzero(mask), np.count_nonzero(mask[25:45, 25:45]))
        applied = clean()
        self.assertEqual(applied.status_code, 200, applied.text)
        self.assertEqual(applied.json()['result']['outsideChangedPixels'], 0)
        doc = main.store.document
        self.assertIsNone(doc.manual_mask)
        np.testing.assert_array_equal(doc.working[mask == 0], self.source[mask == 0])
        np.testing.assert_array_equal(doc.source, self.source)
        healed = doc.working.copy()
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        np.testing.assert_array_equal(doc.working, self.source)
        self.assertEqual(self.post('/v1/redo').status_code, 200)
        np.testing.assert_array_equal(doc.working, healed)
        with TemporaryDirectory(dir=main.CACHE) as temporary:
            path = Path(temporary) / 'healed.mangaclean'
            save_project(path, doc.snapshot())
            loaded = load_project(path)
        np.testing.assert_array_equal(loaded['source'], self.source)
        np.testing.assert_array_equal(loaded['clean'], healed)


if __name__ == '__main__':
    unittest.main()
