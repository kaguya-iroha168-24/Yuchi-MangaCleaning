import base64
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from time import monotonic, sleep
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
import cv2
import numpy as np

from backend import main
from backend.translation import Gemini, GOOGLE_HOST, TranslationError
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph, TextRegion
from mangaclean.services.chapter import Chapter
from mangaclean.services.project_io import load_project, save_project


class GeminiTranslation(unittest.TestCase):
    def test_two_columns_generate_two_dialogues_without_changing_bubble_or_art(self):
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        source = np.full((160, 230, 3), 255, np.uint8)
        interior = np.full((120, 190), 255, np.uint8)
        ink = np.zeros_like(interior)
        for x in (15, 32, 49, 118, 135, 152):
            for y in (20, 45, 70):
                ink[y:y+12, x:x+9] = 255
        source[20:140, 20:210][ink > 0] = 0
        bubble = Bubble((20, 20, 190, 120), interior, ink)
        graph = RegionGraph.for_legacy(source, 'joined.png')
        original = TextRegion(bubble.rect, bubble_id=bubble.id, provenance={'origin': 'automatic_bubble_text_region'})
        graph.add(original)
        main.store.document = doc = main.Document(source, source.copy(), 'joined.png',
            np.zeros(source.shape[:2], np.uint8), bubbles=[bubble], region_graph=graph)
        main.store.chapter = main.store.job = None
        main.store.undo.clear()
        main.store.redo.clear()
        with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
            self.assertEqual(client.post('/v1/translation/settings', headers=headers,
                json={'model': 'gemini-3.5-flash', 'key': 'fake-test-key-1234567'}).status_code, 200)
        try:
            with patch('backend.translation.Gemini.read_and_translate', return_value=[
                ('LEFT', 'Kiri'), ('RIGHT', 'Kanan')]) as vision:
                self.assertEqual(client.post('/v1/translation/start', headers=headers,
                    json={'pageId': graph.page_id, 'scope': 'page'}).status_code, 200)
                deadline = monotonic() + 5
                while main.store.job['status'] == 'running' and monotonic() < deadline:
                    sleep(.01)
                self.assertEqual(len(vision.call_args.args[0]), 2)
                self.assertEqual(main.store.job['status'], 'done', main.store.job)
            left, right = doc.dialogues
            self.assertEqual([left.text, right.text], ['Kiri', 'Kanan'])
            self.assertLessEqual(left.x + left.width, right.x)
            self.assertEqual((left.bubble_id, right.bubble_id), (bubble.id, bubble.id))
            self.assertEqual([r.provenance['ocr']['raw_text'] for r in doc.region_graph.text_regions], ['LEFT', 'RIGHT'])
            np.testing.assert_array_equal(doc.working, source)
            self.assertIs(doc.bubbles[0], bubble)
            self.assertEqual(client.post('/v1/undo', headers=headers).status_code, 200)
            self.assertEqual(doc.region_graph.reading_order, [original.id])
            self.assertEqual(doc.dialogues, [])
        finally:
            client.post('/v1/translation/settings', headers=headers, json={'clear': True})

    def test_vision_reads_original_crop_and_commits_ocr_with_dialogue(self):
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        source = np.full((110, 100, 3), 255, np.uint8)
        source[30:36, 32:38] = 0
        interior = np.full((86, 50), 255, np.uint8)
        bubble = Bubble((20, 10, 50, 86), interior, np.zeros_like(interior))
        graph = RegionGraph.for_legacy(source, 'vision.png')
        first = TextRegion((29, 22, 28, 62), bubble_id=bubble.id, provenance={'ocr': {'raw_text': 'Garbled'}})
        graph.add(first)
        main.store.document = doc = main.Document(source, np.full_like(source, 255), 'vision.png',
            np.zeros(source.shape[:2], np.uint8), bubbles=[bubble], region_graph=graph)
        main.store.chapter = main.store.job = None
        main.store.undo.clear()
        main.store.redo.clear()
        fixture = Mock(status=200)
        fixture.read.return_value = json.dumps({'candidates': [{'content': {'parts': [
            {'text': '[{"id":0,"source":"TEN MINUTES LATER","text":"BEBERAPA MENIT KEMUDIAN"}]'}]}}]}).encode()
        with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
            self.assertEqual(client.post('/v1/translation/settings', headers=headers,
                json={'model': 'gemini-3.5-flash', 'key': 'fake-test-key-1234567'}).status_code, 200)
        try:
            with patch('backend.translation.http.client.HTTPSConnection') as connection:
                connection.return_value.getresponse.return_value = fixture
                self.assertEqual(client.post('/v1/translation/start', headers=headers,
                    json={'pageId': graph.page_id, 'scope': 'page'}).status_code, 200)
                deadline = monotonic() + 5
                while main.store.job['status'] == 'running' and monotonic() < deadline:
                    sleep(.01)
                self.assertEqual(main.store.job['status'], 'done', main.store.job)
                parts = json.loads(connection.return_value.request.call_args.args[2])['contents'][0]['parts']
                images = [part['inlineData']['data'] for part in parts if 'inlineData' in part]
                self.assertEqual(len(images), 1)
                image = cv2.imdecode(np.frombuffer(base64.b64decode(images[0]), np.uint8), cv2.IMREAD_COLOR)
                np.testing.assert_array_equal(image, source[22:84, 29:57])
            self.assertEqual(doc.region_graph.region(first.id).provenance['ocr']['raw_text'], 'TEN MINUTES LATER')
            text, = doc.dialogues
            self.assertEqual((text.text, text.source_region_id, text.width), ('BEBERAPA MENIT KEMUDIAN', first.id, 50))
            self.assertLess(text.minimum_size, 12)
            self.assertEqual((text.family, text.weight, text.style['italic']), ('Komika Text Kaps', 700, True))
            np.testing.assert_array_equal(doc.working, np.full_like(source, 255))
            for mode in ('clean', 'overlay'):
                doc.composition = {} if mode == 'clean' else {'text_mode': 'overlay'}
                with TemporaryDirectory(dir=main.CACHE) as folder:
                    path = Path(folder) / 'translated.mangaclean'
                    save_project(path, doc.snapshot())
                    saved = load_project(BytesIO(path.read_bytes()))
                    self.assertEqual(saved['dialogues'], doc.dialogues)
                    self.assertEqual(saved['region_graph'].region(first.id).provenance['ocr']['raw_text'], 'TEN MINUTES LATER')
            self.assertEqual(client.post('/v1/undo', headers=headers).status_code, 200)
            self.assertEqual(doc.region_graph.region(first.id).provenance['ocr']['raw_text'], 'Garbled')
            self.assertEqual(doc.dialogues, [])
        finally:
            client.post('/v1/translation/settings', headers=headers, json={'clear': True})

    def test_connection_test_saves_only_a_verified_key_and_never_returns_it(self):
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        path = '/v1/translation/settings'
        main.store.job = None
        original = dict(model='gemini-3.5-flash', key='fake-existing-key-1234567')
        candidate = dict(model='gemini-3.5-flash-lite', key='AQ.fixture-replacement-12345')
        try:
            with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
                self.assertEqual(client.post(path, headers=headers, json=original).status_code, 200)
            with patch('backend.translation.Gemini.translate', side_effect=TranslationError('Gemini denied access.')):
                failed = client.post(path, headers=headers, json=candidate)
                self.assertEqual(failed.status_code, 502)
                self.assertNotIn(candidate['key'], failed.text)
                status = client.get('/v1/translation/capabilities', headers=headers).json()
                self.assertEqual(status['model'], original['model'])
            with patch('backend.translation.Gemini.translate', return_value=['Halo.']) as call:
                verified = client.post(path, headers=headers, json=candidate)
                self.assertEqual(verified.status_code, 200)
                self.assertEqual(verified.json()['model'], candidate['model'])
                self.assertNotIn(candidate['key'], verified.text)
                call.assert_called_once_with(['Hello.'])
        finally:
            client.post(path, headers=headers, json={'clear': True})
        rejected = client.post('/v1/translation/start', headers=headers, json={'pageId': 'page', 'scope': 'page'})
        self.assertEqual(rejected.status_code, 409)
        self.assertIn('Verify a Gemini API key', rejected.json()['detail'])

    def test_transport_maps_ids_and_rejects_incomplete_results(self):
        reply = Mock(status=200)
        reply.read.return_value = json.dumps({'candidates': [{'content': {'parts': [{'text': '[{"id":1,"text":"Dua"},{"id":0,"text":"Satu"}]'}]}}]}).encode()
        with patch('backend.translation.http.client.HTTPSConnection') as connection:
            client = connection.return_value
            client.getresponse.return_value = reply
            adapter = Gemini('gemini-3.5-flash', 'fake-test-key-1234567')
            self.assertEqual(adapter.translate(['One', 'Two']), ['Satu', 'Dua'])
            connection.assert_called_once_with(GOOGLE_HOST, timeout=20)
            method, url, body, headers = client.request.call_args.args
            self.assertEqual(method, 'POST')
            self.assertNotIn(adapter.key, url + body.decode() + repr(adapter))
            self.assertEqual(headers['x-goog-api-key'], adapter.key)
            with self.assertRaises(TranslationError):
                adapter.translate(['One'])

    def test_job_fills_missing_dialogue_and_preserves_user_text_and_artwork(self):
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        source = np.full((80, 100, 3), 255, np.uint8)
        graph = RegionGraph.for_legacy(source, 'translation.png')
        first = TextRegion((10, 10, 50, 40), source_text='Edited OCR')
        second = TextRegion((10, 52, 50, 20), source_text='Keep this')
        graph.add(first)
        graph.add(second)
        main.store.document = doc = main.Document(source, source.copy(), 'translation.png', np.zeros((80, 100), np.uint8), region_graph=graph,
                                                   dialogues=[main.Dialogue(text='Manual', source_region_id=second.id, x=10, y=52, width=50, height=20)])
        main.store.chapter = main.store.job = None
        main.store.undo.clear()
        main.store.redo.clear()
        self.assertEqual(client.get('/v1/translation/capabilities').status_code, 401)
        with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
            setup = client.post('/v1/translation/settings', headers=headers, json={'model': 'gemini-3.5-flash', 'key': 'fake-test-key-1234567', 'style': ''})
        self.assertEqual(setup.status_code, 200)
        self.assertEqual(setup.json()['model'], 'gemini-3.5-flash')
        self.assertTrue(setup.json()['configured'])
        self.assertEqual(setup.json()['style'], '')
        try:
            with patch('backend.translation.Gemini.translate', return_value=['OCR diterjemahkan']) as translate:
                response = client.post('/v1/translation/start', headers=headers, json={'pageId': graph.page_id, 'scope': 'page'})
                self.assertEqual(response.status_code, 200, response.text)
                deadline = monotonic() + 5
                while main.store.job['status'] == 'running' and monotonic() < deadline:
                    sleep(.01)
                self.assertEqual(main.store.job['status'], 'done', main.store.job)
                translate.assert_called_once_with(['Edited OCR'])
            self.assertEqual([(item.text, item.source_region_id) for item in doc.dialogues], [('Manual', second.id), ('OCR diterjemahkan', first.id)])
            self.assertEqual(graph.region(first.id).source_text, 'Edited OCR')
            np.testing.assert_array_equal(doc.working, source)
            self.assertEqual(client.post('/v1/undo', headers=headers).status_code, 200)
            self.assertEqual([item.text for item in doc.dialogues], ['Manual'])
        finally:
            client.post('/v1/translation/settings', headers=headers, json={'clear': True})

    def test_chapter_commits_per_page_and_cancellation_keeps_completed_pages(self):
        client = TestClient(main.app)
        headers = {'Authorization': 'Bearer ' + main.TOKEN}
        blocked, release = Event(), Event()
        main.store.job = main.store.chapter = None

        def translate(texts):
            if texts == ['Second']:
                blocked.set()
                if not release.wait(5): raise RuntimeError('Test did not release transport')
            return ['ID ' + text for text in texts]

        with TemporaryDirectory(dir=main.CACHE) as temporary:
            chapter = Chapter(Path(temporary), main.Document)
            pages = []
            for index, text in enumerate(['First', 'Second']):
                source = np.full((80, 100, 3), 200 + index, np.uint8)
                graph = RegionGraph.for_legacy(source, text + '.png')
                graph.add(TextRegion((10, 10, 60, 50), source_text=text))
                doc = main.Document(source, source.copy(), text + '.png', np.zeros((80, 100), np.uint8), region_graph=graph)
                chapter.add(doc)
                pages.append(graph.page_id)
            main.store.chapter = chapter
            chapter.activate(main.store, pages[0], flush=False)
            with patch('backend.translation.Gemini.translate', return_value=['Halo.']):
                setup = client.post('/v1/translation/settings', headers=headers, json={'model': 'gemini-3.5-flash', 'key': 'fake-test-key-1234567'})
                self.assertEqual(setup.status_code, 200)
            try:
                with patch('backend.translation.Gemini.translate', side_effect=translate):
                    result = client.post('/v1/translation/start', headers=headers, json={'pageId': pages[0], 'scope': 'chapter'})
                    self.assertEqual(result.status_code, 200, result.text)
                    self.assertTrue(blocked.wait(5), main.store.job)
                    job = result.json()['id']
                    self.assertEqual(client.post(f'/v1/jobs/{job}/cancel', headers=headers).status_code, 200)
                    release.set()
                    deadline = monotonic() + 5
                    while main.store.job['status'] == 'running' and monotonic() < deadline:
                        sleep(.01)
                    self.assertEqual(main.store.job['status'], 'cancelled', main.store.job)
                self.assertEqual(chapter.active, pages[0])
                self.assertEqual([text.text for text in main.store.document.dialogues], ['ID First'])
                chapter.activate(main.store, pages[1])
                self.assertFalse(main.store.document.dialogues)
            finally:
                release.set()
                client.post('/v1/translation/settings', headers=headers, json={'clear': True})
                main.store.chapter = None


if __name__ == '__main__':
    unittest.main()
