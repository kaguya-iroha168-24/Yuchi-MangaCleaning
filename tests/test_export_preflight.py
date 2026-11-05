"""Focused export gates with actual worker and non-destructive copied projects."""
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest

import numpy as np
from tests import test_typesetting as previous
from backend import main
from mangaclean.services import typesetting, export_preflight


class PreflightTests(unittest.TestCase):
    setUp = previous.TypesettingTests.setUp
    open = previous.TypesettingTests.open
    post = previous.TypesettingTests.post
    create = previous.TypesettingTests.create
    preview = previous.TypesettingTests.preview
    assert_artwork_untouched = previous.TypesettingTests.assert_artwork_untouched

    @classmethod
    def tearDownClass(cls):
        typesetting.close_typesetter()

    def attempt(self, kind, download=False):
        return self.client.get('/v1/export/'+kind, headers=self.headers) if download else self.client.post('/v1/save/'+kind, headers=self.headers)

    def overflow(self, **fields):
        return self.create(text='Kaktus', width=25, height=150, size=47, minimum_size=16, **fields)

    def test_all_four_image_routes_block_before_files_and_list_every_issue(self):
        a, b = self.overflow(), self.overflow()
        project_before = [asdict(t) for t in main.store.document.dialogues]
        revision = main.store.document.revision
        folders = [main.ROOT/'outputs/exports', main.CACHE/'exports']
        before = [set(folder.iterdir()) if folder.exists() else set() for folder in folders]
        for kind in ['png','jpeg']:
            for download in [False,True]:
                response = self.attempt(kind, download)
                self.assertEqual(response.status_code, 422, response.text)
                detail = response.json()['detail']
                self.assertEqual(detail['code'], 'typesetting_preflight')
                self.assertEqual({i['dialogueId'] for i in detail['issues']}, {a['id'],b['id']})
                self.assertTrue(all(i['code']=='overflow' for i in detail['issues']))
                self.assertEqual(detail['pageName'], 'page_009.png')
                self.assertEqual(detail['revision'], revision)
                self.assertNotIn('verified', response.json())
        for folder, old in zip(folders, before):
            self.assertEqual(set(folder.iterdir()) if folder.exists() else set(), old)
        self.assertEqual([asdict(t) for t in main.store.document.dialogues], project_before)
        self.assert_artwork_untouched()

    def test_save_project_history_and_repair_then_png_jpeg(self):
        text = self.overflow()
        self.assertTrue(self.preview(text)['overflow'])
        self.assertEqual(self.attempt('png').status_code, 422)
        saved = self.post('/v1/save/project')
        self.assertTrue(saved['verified'])
        reopened = self.open(Path(saved['path']))
        self.assertEqual(reopened['dialogues'][0], text)
        self.post('/v1/dialogues/'+text['id'], dict(x=800, width=250, height=200, size=28))
        self.post('/v1/undo'); self.assertEqual(self.attempt('png').status_code,422)
        self.post('/v1/redo')
        fixed = asdict(main.store.document.dialogues[0])
        self.assertFalse(self.preview(fixed)['overflow'])
        for kind in ['png','jpeg']:
            result = self.attempt(kind)
            self.assertEqual(result.status_code,200,result.text)
            self.assertTrue(result.json()['verified'])
            download = self.attempt(kind,True)
            self.assertEqual(download.status_code,200)
            self.assertTrue(download.content)
        self.assert_artwork_untouched()

    def test_hidden_empty_whitespace_and_no_dialogue_do_not_need_renderer(self):
        self.overflow(visible=False)
        self.create(text='')
        self.create(text=' \n\t ')
        with patch.object(export_preflight,'render_dialogue',side_effect=AssertionError('Unexpected preflight render')), patch.object(typesetting,'render_dialogue',side_effect=AssertionError('Unexpected composite render')):
            for kind in ['png','jpeg']:
                response = self.attempt(kind)
                self.assertEqual(response.status_code,200,response.text)
        self.assert_artwork_untouched()

    def test_renderer_failure_missing_ink_and_missing_glyphs_have_specific_diagnostics(self):
        text = self.create(text='Visible', auto_fit=False)
        actual = self.preview(text)
        for layer, code in [(dict(actual,warnings=['Some glyphs are missing from available fonts.']), 'missing_glyphs'), (self.preview(dict(text,text='')), 'missing_ink')]:
            with patch.object(export_preflight,'render_dialogue',return_value=layer):
                response = self.attempt('png')
            self.assertEqual(response.status_code,422)
            self.assertEqual(response.json()['detail']['issues'][0]['code'], code)
        with patch.object(export_preflight,'render_dialogue',side_effect=typesetting.TypesettingUnavailable('Font worker unavailable')):
            issue = self.attempt('jpeg').json()['detail']['issues'][0]
            self.assertEqual(issue['code'],'render_error')
            self.assertIsNone(issue['resolvedSize'])
            self.assertEqual(issue['requestedSize'],text['size'])

    def test_valid_font_fallback_is_not_failure_and_candidate_is_identifiable(self):
        bubble=main.store.document.bubbles[0]
        self.create(text='SAFE', family='Missing requested family', auto_fit=False, x=800, width=250)
        self.assertEqual(self.attempt('png').status_code,200)
        bad=self.overflow(bubble_id=bubble.id)
        issue=self.attempt('png').json()['detail']['issues'][-1]
        self.assertEqual(issue['dialogueId'],bad['id'])
        self.assertEqual(issue['bubbleId'],bubble.id)
        self.assertEqual(issue['candidateNumber'],1)

    def test_late_io_failure_does_not_publish_output(self):
        self.create(text='SAFE', x=800, width=250, auto_fit=False)
        folder=main.ROOT/'outputs/exports';before=set(folder.iterdir())
        with patch.object(main,'write_verified_image',side_effect=OSError('Disk failure')):
            self.assertEqual(self.attempt('png').status_code,500)
        self.assertEqual(set(folder.iterdir()),before)
        self.assert_artwork_untouched()

    def test_transactional_writer_no_overwrite_no_partial_and_decode_failure_cleanup(self):
        self.assertTrue(main.CACHE.resolve().is_relative_to(main.ROOT.resolve()))
        with TemporaryDirectory(dir=main.CACHE) as directory:
            folder=Path(directory);self.assertTrue(folder.resolve().is_relative_to(main.ROOT.resolve()))
            target=folder/'previous.png';target.write_bytes(b'keep previous')
            with self.assertRaises(OSError):export_preflight.write_verified_image(target,self.before)
            self.assertEqual(target.read_bytes(),b'keep previous')
            self.assertEqual([p.name for p in folder.iterdir()],['previous.png'])
            target=folder/'new.png'
            def fail_after_write(path,image):path.write_bytes(b'partial');raise OSError('Disk full')
            with patch.object(export_preflight,'write_image',side_effect=fail_after_write):
                with self.assertRaises(OSError):export_preflight.write_verified_image(target,self.before)
            self.assertFalse(target.exists());self.assertEqual(len(list(folder.iterdir())),1)
            with patch.object(export_preflight,'read_image',side_effect=ValueError('Decode failed')):
                with self.assertRaises(ValueError):export_preflight.write_verified_image(target,self.before)
            self.assertFalse(target.exists());self.assertEqual(len(list(folder.iterdir())),1)


if __name__=='__main__':unittest.main()
