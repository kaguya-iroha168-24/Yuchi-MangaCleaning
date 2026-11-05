"""UI-07 contracts on fixture copies; no inference, original workspace writes or installs."""
from dataclasses import asdict
from io import BytesIO
from pathlib import Path
import base64
import json
import sys
import unittest
import zipfile

import cv2
import numpy as np
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import main
from mangaclean.services import typesetting
from mangaclean.services.project_io import load_project

DIAG = ROOT.parent/'Yuchi-Diagnostics/mangaclean-tauri-ui07'


class TypesettingTests(unittest.TestCase):
    @classmethod
    def tearDownClass(cls):
        typesetting.close_typesetter()

    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'Authorization': 'Bearer '+main.TOKEN, 'Origin': 'http://tauri.localhost'}
        main.store.job = None
        self.open(DIAG/'cleaned-fixture-copy.mangaclean')
        self.before = main.store.document.working.copy()
        self.source = main.store.document.source.copy()
        self.mask = main.store.document.mask.copy()
        self.graph = main.store.document.region_graph.to_dict()

    def open(self, path):
        response = self.client.post('/v1/open?discard=true', headers=self.headers,
            files={'file': (path.name, BytesIO(path.read_bytes()), 'application/octet-stream')})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['document']

    def post(self, path, payload=None):
        response = self.client.post(path, headers=self.headers, json=payload or {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def create(self, **fields):
        payload = dict(text='YUCHI\nLABS', x=937, y=73, width=123, height=239, size=32, padding=8)
        payload.update(fields)
        return self.post('/v1/dialogues', payload)['document']['dialogues'][-1]

    def preview(self, values):
        return self.post('/v1/typography/preview', dict(pageId=main.store.document.region_graph.page_id,
            dialogue={key: value for key, value in values.items() if key != 'id'}))

    def assert_artwork_untouched(self):
        doc = main.store.document
        self.assertTrue(np.array_equal(doc.source, self.source))
        self.assertTrue(np.array_equal(doc.working, self.before))
        self.assertTrue(np.array_equal(doc.mask, self.mask))
        self.assertEqual(doc.region_graph.to_dict(), self.graph)

    def test_properties_save_reload_v3_and_separate_source(self):
        identifier = main.store.document.region_graph.text_regions[0].id
        text = self.create(source_region_id=identifier, family='Arial', weight=700, size=28, color='#C02030', alignment='right', minimum_size=10, padding=9)
        saved = self.post('/v1/save/project')
        with zipfile.ZipFile(saved['path']) as package:
            self.assertIsNone(package.testzip())
            self.assertEqual(json.loads(package.read('manifest.json'))['version'], 3)
        loaded = load_project(saved['path'])
        self.assertEqual(asdict(loaded['dialogues'][0]), text)
        self.assertEqual(loaded['region_graph'].to_dict(), self.graph)
        self.assertTrue(np.array_equal(loaded['source'], self.source))
        self.assertTrue(np.array_equal(loaded['clean'], self.before))
        self.assert_artwork_untouched()

    def test_raw_ocr_and_manual_source_are_not_typography_fields(self):
        self.open(DIAG/'ocr-corrected-copy.mangaclean')
        graph = main.store.document.region_graph.to_dict()
        region = main.store.document.region_graph.text_regions[0]
        self.create(text='New typeset dialogue', x=1450, y=800, width=120, height=200, source_region_id=region.id)
        self.assertEqual(main.store.document.region_graph.to_dict(), graph)
        self.assertEqual(main.store.document.region_graph.region(region.id).provenance['ocr']['raw_text'], '何そのカッコ')
        self.assertEqual(main.store.document.region_graph.region(region.id).source_text, '何そのカッコ！ UI-06')
        saved = self.post('/v1/save/project')
        self.assertEqual(load_project(saved['path'])['region_graph'].to_dict(), graph)

    def test_invalid_update_is_atomic(self):
        text = self.create()
        revision = main.store.document.revision
        for change in [dict(size=2), dict(weight=True), dict(color='red'), dict(x=-1), dict(width=100000), dict(padding=-1), dict(source_region_id='missing'), dict(alignment='diagonal'), dict(extra=True)]:
            response = self.client.post('/v1/dialogues/'+text['id'], headers=self.headers, json=dict(text='must not save', **change))
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(main.store.document.revision, revision)
            self.assertEqual(asdict(main.store.document.dialogues[0]), text)
        self.assert_artwork_untouched()

    def test_metadata_history_and_mixed_raster_history(self):
        text = self.create()
        self.assertNotIn('working', main.store.undo[-1])
        main.store.capture()
        main.store.document.working = self.before.copy()
        main.store.document.working[10, 10] = [10, 20, 30]
        changed = main.store.document.working.copy()
        self.post('/v1/dialogues/'+text['id'], dict(text='Updated', color='#FF0000'))
        self.post('/v1/undo'); self.assertEqual(main.store.document.dialogues[0].text, text['text'])
        self.assertTrue(np.array_equal(main.store.document.working, changed))
        self.post('/v1/undo'); self.assertTrue(np.array_equal(main.store.document.working, self.before))
        self.post('/v1/undo'); self.assertEqual(main.store.document.dialogues, [])
        self.post('/v1/redo'); self.post('/v1/redo'); self.post('/v1/redo')
        self.assertEqual(main.store.document.dialogues[0].text, 'Updated')
        self.assertTrue(np.array_equal(main.store.document.working, changed))

    def test_delete_and_restore_all_properties(self):
        text = self.create(family='Arial', weight=700, color='#0044DD', alignment='left', auto_fit=False, padding=11)
        self.post('/v1/dialogues/'+text['id']+'/delete')
        self.assertEqual(main.store.document.dialogues, [])
        self.post('/v1/undo'); self.assertEqual(asdict(main.store.document.dialogues[0]), text)
        self.post('/v1/redo'); self.assertEqual(main.store.document.dialogues, [])
        self.assert_artwork_untouched()

    def test_fonts_fallback_cache_and_stateless_preview(self):
        info = self.client.get('/v1/typography/fonts', headers=self.headers).json()
        self.assertFalse(info['aiImported'])
        self.assertTrue(any(font['family'] == 'Segoe UI' for font in info['fonts']))
        text = self.create(family='UI07 Missing Font', text='何そのカッコ', width=160, height=180, x=900)
        revision = main.store.document.revision
        layer = self.preview(text)
        self.assertTrue(layer['warnings'])
        self.assertNotEqual(layer['resolvedFamily'], text['family'])
        again = self.preview(dict(text, x=901))
        self.assertTrue(again['cacheHit'])
        self.assertEqual(again['png'], layer['png'])
        self.assertEqual(main.store.document.revision, revision)
        self.assertEqual(main.store.document.dialogues[0].family, 'UI07 Missing Font')
        self.assert_artwork_untouched()

    def test_auto_fit_safe_interior_and_overflow(self):
        bubble = main.store.document.bubbles[0]
        x, y, w, h = bubble.rect
        text = self.create(x=x, y=y, width=w, height=h, bubble_id=bubble.id, text='SAFE TEXT', size=72, minimum_size=8)
        layer = self.preview(text)
        self.assertLessEqual(layer['effectiveSize'], 72)
        self.assertFalse(layer['overflow'])
        pixels = cv2.imdecode(np.frombuffer(base64.b64decode(layer['png']), np.uint8), cv2.IMREAD_UNCHANGED)
        ink = pixels[:, :, 3] > 0
        self.assertGreater(int(ink.sum()), 0)
        self.assertEqual(int(np.count_nonzero(ink & (bubble.interior == 0))), 0)
        overflow = self.preview(dict(text, text='OVERFLOW '*100, size=20, minimum_size=20))
        self.assertTrue(overflow['overflow'])
        self.assertTrue(any('overflow' in warning.lower() for warning in overflow['warnings']))
        self.assert_artwork_untouched()

    def test_real_font_weight_size_alignment_and_color_change_raster(self):
        text = self.create(x=100, y=200, width=300, height=200, text='TYPE', size=28, auto_fit=False, alignment='left')
        def decoded(fields):
            layer = self.preview(fields)
            pixels = cv2.imdecode(np.frombuffer(base64.b64decode(layer['png']), np.uint8), cv2.IMREAD_UNCHANGED)
            return layer, pixels, cv2.boundingRect(cv2.findNonZero(pixels[:, :, 3]))
        regular, pixels, left = decoded(text)
        bold, bold_pixels, _ = decoded(dict(text, weight=700))
        self.assertEqual(bold['resolvedWeight'], 700)
        self.assertFalse(np.array_equal(pixels, bold_pixels))
        larger, _, size_box = decoded(dict(text, size=48))
        self.assertEqual(larger['effectiveSize'], 48)
        self.assertGreater(size_box[3], left[3])
        _, _, middle = decoded(dict(text, alignment='center'))
        _, _, right = decoded(dict(text, alignment='right'))
        self.assertLess(left[0], middle[0]); self.assertLess(middle[0], right[0])
        _, blue, _ = decoded(dict(text, color='#0000FF'))
        self.assertTrue(np.any((blue[:, :, 0] == 255) & (blue[:, :, 3] > 0)))
        _, arial, _ = decoded(dict(text, family='Arial'))
        self.assertFalse(np.array_equal(pixels, arial))
        self.assert_artwork_untouched()

    def test_auto_fit_preserves_words_when_smaller_font_fits(self):
        text = self.create(text='HELLO', width=80, height=150, size=32, minimum_size=8)
        layer = self.preview(text)
        self.assertLess(layer['effectiveSize'], 32)
        self.assertFalse(layer['overflow'])
        self.assertFalse(any('long word' in warning.lower() for warning in layer['warnings']))
        self.assert_artwork_untouched()

    def test_preview_composite_png_jpeg_native_resolution(self):
        self.create(color='#E01020', weight=700, text='UI07 TEXT', alignment='left')
        response = self.client.get('/v1/image/composite', headers=self.headers)
        self.assertEqual(response.status_code, 200, response.text)
        preview = cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)
        changed = np.any(preview != self.before, axis=2)
        self.assertGreater(int(changed.sum()), 0)
        permitted = np.zeros(changed.shape, bool); permitted[73:312, 937:1060] = True
        self.assertEqual(int(np.count_nonzero(changed & ~permitted)), 0)
        self.assertTrue(np.any(preview[:, :, 2].astype(int) - preview[:, :, 0].astype(int) > 100))
        png = self.post('/v1/save/png'); actual = cv2.imread(png['path'])
        self.assertTrue(np.array_equal(actual, preview))
        jpeg = self.post('/v1/save/jpeg'); actual = cv2.imread(jpeg['path'])
        _, encoded = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 95])
        self.assertTrue(np.array_equal(actual, cv2.imdecode(encoded, cv2.IMREAD_COLOR)))
        self.assert_artwork_untouched()

    def test_legacy_v1_v2_are_read_without_modifying_inputs(self):
        source = DIAG/'cleaned-fixture-copy.mangaclean'
        original = source.read_bytes()
        doc = self.open(source)
        self.assertEqual(doc['dialogues'], [])
        copy = BytesIO()
        with zipfile.ZipFile(BytesIO(original)) as old, zipfile.ZipFile(copy, 'w') as legacy:
            for name in old.namelist():
                data = old.read(name)
                if name == 'manifest.json':
                    manifest = json.loads(data); manifest['version'] = 1; manifest.pop('region_graph')
                    data = json.dumps(manifest).encode()
                legacy.writestr(name, data)
        response = self.client.post('/v1/open?discard=true', headers=self.headers, files={'file': ('legacy-copy.mangaclean', BytesIO(copy.getvalue()), 'application/octet-stream')})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(np.array_equal(main.store.document.source, self.source))
        self.assertTrue(np.array_equal(main.store.document.working, self.before))
        self.assertEqual(source.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
