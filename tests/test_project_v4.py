from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile

import cv2
from fastapi.testclient import TestClient
import numpy as np

from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.dialogue import Dialogue
from mangaclean.core.region_graph import RegionGraph
from mangaclean.services.chapter import Chapter
from mangaclean.services.project_io import load_project, save_project


class OptionalV4(unittest.TestCase):
    def document(self, name='page.png'):
        source = np.full((100, 120, 3), 80, np.uint8)
        return main.Document(source, source.copy(), name, np.zeros(source.shape[:2], np.uint8),
                             region_graph=RegionGraph.for_legacy(source, name),
                             dialogues=[Dialogue(text='Hello', width=100, height=80)])

    def test_v3_defaults_and_v4_copy_round_trip(self):
        doc = self.document()
        with TemporaryDirectory(dir=main.CACHE) as folder:
            original = Path(folder) / 'original.mangaclean'
            extended = Path(folder) / 'extended.mangaclean'
            save_project(original, doc.snapshot())
            before = original.read_bytes()
            with zipfile.ZipFile(original) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(manifest['version'], 3)
                self.assertNotIn('style', manifest['dialogues'][0])
            doc.dialogues[0].style = {'italic': True, 'rotation': 15, 'stroke_width': 2}
            doc.dialogues[0].locked = True
            doc.composition = {'brightness': 12, 'artwork': 'original'}
            save_project(extended, doc.snapshot())
            with zipfile.ZipFile(extended) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                self.assertEqual(manifest['version'], 4)
                self.assertEqual(manifest['composition']['typography'][doc.dialogues[0].id]['rotation'], 15)
            loaded = load_project(extended)
            self.assertEqual(loaded['dialogues'], doc.dialogues)
            self.assertEqual(loaded['composition'], doc.composition)
            np.testing.assert_array_equal(loaded['source'], doc.source)
            self.assertEqual(original.read_bytes(), before)
            self.assertEqual(load_project(BytesIO(before))['composition'], {})

    def test_invalid_or_unknown_styles_are_rejected(self):
        doc = self.document()
        doc.dialogues[0].style = {'rotation': 361}
        with TemporaryDirectory(dir=main.CACHE) as folder:
            path = Path(folder) / 'invalid.mangaclean'
            with self.assertRaises(ValueError):
                save_project(path, doc.snapshot())
            self.assertFalse(path.exists())

    def test_text_cover_affects_composite_only_when_translated_dialogue_is_visible(self):
        doc = self.document()
        doc.working.fill(120)
        doc.revision = 1
        interior = np.zeros((76, 90), np.uint8)
        cv2.ellipse(interior, (45, 38), (41, 34), 0, 0, 360, 255, -1)
        bubble = Bubble((10, 2, 90, 76), interior, np.zeros_like(interior))
        doc.bubbles = [bubble]
        region = main.TextRegion((14, 22, 66, 34), bubble_id=bubble.id, source_text='Source line')
        doc.region_graph.add(region)
        dialogue = doc.dialogues[0]
        dialogue.source_region_id = region.id
        dialogue.bubble_id = bubble.id
        dialogue.text = 'Hai'
        dialogue.size = 14
        dialogue.minimum_size = 10
        dialogue.auto_fit = False
        doc.composition = {'text_mode': 'overlay'}
        layer = main.render_dialogue(dialogue, doc.bubbles, main.dialogue_cover_rect(doc, dialogue), overlay=True)
        self.assertEqual(layer['coverRect'], region.rect)
        output = main.composite_page(doc)
        bound = bubble.full_segmentation(doc.source.shape) > 0
        self.assertGreater(np.count_nonzero(np.any(output != doc.source, axis=2)), 100)
        np.testing.assert_array_equal(output[~bound], doc.source[~bound])
        np.testing.assert_array_equal(output[22,14], doc.source[22,14])
        self.assertTrue(layer['coverPng'])
        np.testing.assert_array_equal(doc.working, np.full_like(doc.working,120))
        dialogue.visible = False
        self.assertIsNone(main.dialogue_cover_rect(doc, dialogue))
        np.testing.assert_array_equal(main.composite_page(doc), doc.source)
        dialogue.visible = True
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        main.store.document = doc
        main.store.chapter = main.store.job = main.store.preview = None
        main.store.undo.clear(); main.store.redo.clear()
        with TemporaryDirectory(dir=main.CACHE) as folder, patch.object(main, 'ROOT', Path(folder)):
            png = client.post('/v1/save/png', headers=headers)
            jpeg = client.post('/v1/save/jpeg', headers=headers)
            saved = client.post('/v1/save/project', headers=headers)
            for response in (png, jpeg, saved):
                self.assertEqual(response.status_code, 200, response.text)
            np.testing.assert_array_equal(cv2.imread(png.json()['path']), output)
            ok, expected = cv2.imencode('.jpg', output, [cv2.IMWRITE_JPEG_QUALITY, 95])
            self.assertTrue(ok)
            self.assertEqual(Path(jpeg.json()['path']).read_bytes(), expected.tobytes())
            path = Path(saved.json()['path'])
            self.assertEqual(load_project(path)['composition'], {'text_mode':'overlay'})
            reopened = client.post('/v1/open?discard=true', headers=headers,
                                   files={'file': (path.name, path.read_bytes(), 'application/octet-stream')})
            self.assertEqual(reopened.status_code, 200, reopened.text)
            np.testing.assert_array_equal(main.composite_page(main.store.document), output)

    def test_mixed_chapter_and_page_history_round_trip(self):
        first, second = self.document('first.png'), self.document('second.png')
        store = main.Store()
        with TemporaryDirectory(dir=main.CACHE) as folder:
            chapter = Chapter(folder, main.Document)
            a, b = chapter.add(first), chapter.add(second)
            chapter.activate(store, a, flush=False)
            store.capture(('composition',))
            store.document.composition = {'contrast': 25}
            store.document.revision += 1
            chapter.activate(store, b)
            chapter.activate(store, a)
            self.assertEqual(store.document.composition, {'contrast': 25})
            self.assertEqual(store.undo[-1]['composition'], {})
            path = Path(folder) / 'mixed.mangaclean'
            chapter.save(store, path)
            reopened = Chapter.load(path, folder, main.Document)
            self.assertEqual(reopened.decode(a).composition, {'contrast': 25})
            self.assertEqual(reopened.decode(b).composition, {})

    def test_editing_layer_routes_undo_and_export_use_the_same_composition(self):
        doc = self.document()
        doc.working.fill(100)
        doc.dialogues[0].size = 20
        doc.dialogues.append(Dialogue(text='Hello', width=100, height=80, size=20, color='#ff0000'))
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        page = doc.region_graph.page_id
        first, second = [text.id for text in doc.dialogues]
        main.store.document = doc
        main.store.chapter = main.store.job = main.store.preview = None
        main.store.undo.clear(); main.store.redo.clear()

        def post(route, **body):
            return client.post(route, headers=headers, json=body)

        def image(kind):
            response = client.get('/v1/image/' + kind, headers=headers)
            self.assertEqual(response.status_code, 200, response.text[:300])
            return cv2.imdecode(np.frombuffer(response.content, np.uint8), cv2.IMREAD_COLOR)

        self.assertEqual(post(f'/v1/dialogues/{first}', style={'italic': True, 'stroke_width': 1}).status_code, 200)
        before = image('composite')
        self.assertEqual(post(f'/v1/layers/{first}', pageId=page, move='up').status_code, 200)
        self.assertEqual([text.id for text in doc.dialogues], [second, first])
        self.assertFalse(np.array_equal(before, image('composite')))
        self.assertEqual(post(f'/v1/layers/{first}', pageId=page, locked=True).status_code, 200)
        self.assertEqual(post(f'/v1/dialogues/{first}', text='overwrite').status_code, 409)
        self.assertEqual(post(f'/v1/dialogues/{first}/delete').status_code, 409)
        self.assertEqual(post(f'/v1/layers/{first}', pageId='stale', visible=False).status_code, 409)

        settings = dict(brightness=20, contrast=25, artwork='original')
        self.assertTrue(post('/v1/composition', pageId=page, settings=settings).json()['imagesChanged'])
        adjusted = image('working')
        self.assertFalse(np.array_equal(adjusted, doc.source))
        np.testing.assert_array_equal(image('original'), np.full_like(doc.source, 80))
        np.testing.assert_array_equal(doc.working, np.full_like(doc.working, 100))
        self.assertTrue(post('/v1/undo').json()['imagesChanged'])
        np.testing.assert_array_equal(image('working'), doc.working)
        self.assertTrue(post('/v1/redo').json()['imagesChanged'])
        np.testing.assert_array_equal(image('working'), adjusted)

        with TemporaryDirectory(dir=main.CACHE) as folder, patch.object(main, 'ROOT', Path(folder)):
            preview = image('composite')
            png = post('/v1/save/png')
            jpeg = post('/v1/save/jpeg')
            self.assertEqual(png.status_code, 200, png.text)
            self.assertEqual(jpeg.status_code, 200, jpeg.text)
            np.testing.assert_array_equal(cv2.imread(png.json()['path']), preview)
            ok, encoded = cv2.imencode('.jpg', preview, [cv2.IMWRITE_JPEG_QUALITY, 95])
            self.assertTrue(ok)
            self.assertEqual(Path(jpeg.json()['path']).read_bytes(), encoded.tobytes())
            project = post('/v1/save/project')
            self.assertEqual(project.status_code, 200, project.text)
            path = Path(project.json()['path'])
            self.assertEqual(load_project(path)['composition'], settings)
            reopened = client.post('/v1/open?discard=true', headers=headers,
                                   files={'file': (path.name, path.read_bytes(), 'application/octet-stream')})
            self.assertEqual(reopened.status_code, 200, reopened.text)
            np.testing.assert_array_equal(image('composite'), preview)
