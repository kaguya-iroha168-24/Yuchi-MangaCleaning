"""Focused integration checks for repaired layout, using copied UI-07 fixtures."""
from dataclasses import asdict
import unittest
from tests import test_typesetting as existing
from backend import main
from mangaclean.services import typesetting


class RepairTests(unittest.TestCase):
    setUp = existing.TypesettingTests.setUp
    open = existing.TypesettingTests.open
    post = existing.TypesettingTests.post
    create = existing.TypesettingTests.create
    preview = existing.TypesettingTests.preview
    assert_artwork_untouched = existing.TypesettingTests.assert_artwork_untouched

    @classmethod
    def tearDownClass(cls):
        typesetting.close_typesetter()

    def test_two_fonts_persist_and_render_differently_without_auto_fit(self):
        a = self.create(text='MangaClean', family='Arial', size=28, width=300, x=800, auto_fit=False)
        first = self.preview(a)
        b = self.post('/v1/dialogues/'+a['id'], dict(family='Times New Roman'))['document']['dialogues'][0]
        second = self.preview(b)
        self.assertNotEqual(first['png'], second['png'])
        self.assertEqual((first['effectiveSize'], second['effectiveSize']), (28, 28))
        self.assertEqual(second['resolvedFamily'], 'Times New Roman')
        saved = self.post('/v1/save/project')
        loaded = self.open(__import__('pathlib').Path(saved['path']))
        self.assertEqual(loaded['dialogues'][0], b)
        self.assertEqual(self.preview(b)['png'], second['png'])
        self.assert_artwork_untouched()

    def test_multi_layer_edit_undo_redo_preserves_other_layer_and_provenance(self):
        bubble = main.store.document.bubbles[0]
        a = self.create(text='Kaktus', bubble_id=bubble.id, family='Arial')
        b = self.create(text='LAYER B', bubble_id=bubble.id, family='Times New Roman', auto_fit=False)
        provenance = [dict(item.provenance) for item in main.store.document.bubbles]
        self.post('/v1/dialogues/'+b['id'], dict(size=47, weight=700, color='#BB2200', alignment='right'))
        self.assertEqual(asdict(main.store.document.dialogues[0]), a)
        self.assertEqual(main.store.document.dialogues[1].size, 47)
        self.post('/v1/undo'); self.assertEqual(asdict(main.store.document.dialogues[1]), b)
        self.post('/v1/redo'); self.assertEqual(main.store.document.dialogues[1].size, 47)
        saved = self.post('/v1/save/project')
        loaded = self.open(__import__('pathlib').Path(saved['path']))
        self.assertEqual(loaded['dialogues'][0], a)
        self.assertEqual(loaded['dialogues'][1]['weight'], 700)
        self.assertEqual([item.provenance for item in main.store.document.bubbles], provenance)
        self.assert_artwork_untouched()


if __name__ == '__main__':
    unittest.main()
