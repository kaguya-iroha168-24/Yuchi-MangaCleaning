"""Navigation may reuse persisted snapshots, never discard edits or history."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
import unittest
import numpy as np
from backend.main import Document, Store
from mangaclean.core.dialogue import Dialogue
from mangaclean.core.region_graph import RegionGraph
from mangaclean.services.chapter import Chapter
from mangaclean.services import chapter as codec


class NavigationPersistence(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parents[1] / '.cache'
        self.temp = TemporaryDirectory(dir=root, prefix='navigation-test-')
        self.addCleanup(self.temp.cleanup)
        self.chapter = Chapter(self.temp.name, Document)
        self.store = Store()
        self.ids = []
        for n in range(3):
            image = np.full((80, 60, 3), 180+n, np.uint8)
            doc = Document(image, image.copy(), f'page_{n+1:03}.png',
                           np.zeros(image.shape[:2], np.uint8),
                           region_graph=RegionGraph.for_legacy(image, f'page_{n+1:03}.png'))
            self.ids.append(self.chapter.add(doc))
        self.chapter.activate(self.store, self.ids[0], flush=False)

    def edit(self, text):
        self.store.capture(('dialogues',))
        self.store.document.dialogues = [Dialogue(text=text, width=30, height=40)]
        self.store.document.revision += 1
        self.store.document.dirty = True

    def test_no_history_unchanged_navigation_does_not_reencode(self):
        with patch.object(codec, 'save_project', wraps=codec.save_project) as writes:
            for index in (1, 0, 2, 0, 1, 0):
                self.chapter.activate(self.store, self.ids[index])
                self.assertEqual(self.store.document.region_graph.page_id, self.ids[index])
            self.assertEqual(writes.call_count, 0)

    def test_four_frames_persist_once_then_survive_switch_undo_redo(self):
        original = self.store.document.source.copy()
        for n in range(4):
            self.edit(str(n))
        with patch.object(codec, 'save_project', wraps=codec.save_project) as writes:
            self.chapter.activate(self.store, self.ids[1])
            self.assertEqual(writes.call_count, 5)
            self.chapter.activate(self.store, self.ids[0])
            self.assertEqual(self.store.document.dialogues[0].text, '3')
            self.assertEqual(len(self.store.undo), 4)
            for _ in range(3):
                self.chapter.activate(self.store, self.ids[1])
                self.chapter.activate(self.store, self.ids[0])
            self.assertEqual(writes.call_count, 5)
        for expected in ('2', '1', '0', None):
            self.store.redo.append(self.store.frame())
            self.store.restore(self.store.undo.pop())
            self.assertEqual(self.store.document.dialogues[0].text if self.store.document.dialogues else None, expected)
        for _ in range(4):
            self.store.undo.append(self.store.frame())
            self.store.restore(self.store.redo.pop())
        self.assertEqual(self.store.document.dialogues[0].text, '3')
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.assertEqual(len(self.store.undo), 4)
        np.testing.assert_array_equal(self.store.document.source, original)

    def test_new_edit_invalidates_even_when_page_was_already_dirty(self):
        self.edit('first')
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.edit('second')
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.assertEqual(self.store.document.dialogues[0].text, 'second')
        self.assertEqual(len(self.store.undo), 2)

    def test_page_summary_exposes_the_revision_used_to_validate_a_cached_preview(self):
        self.edit('committed')
        self.assertEqual(self.chapter.summary(self.store)['pages'][0]['revision'], 1)
        self.chapter.activate(self.store, self.ids[1])
        self.assertEqual([page['revision'] for page in self.chapter.summary(self.store)['pages']], [1, 0, 0])

    def test_history_only_change_invalidates_stamp(self):
        self.store.capture(('dialogues',))
        with patch.object(codec, 'save_project', wraps=codec.save_project) as writes:
            self.chapter.flush(self.store)
            self.assertEqual(writes.call_count, 2)

    def test_more_than_four_edits_keep_existing_bounded_history(self):
        for n in range(7):
            self.edit(str(n))
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.assertEqual(len(self.store.undo), 4)
        self.assertEqual(self.store.document.dialogues[0].text, '6')
        self.store.restore(self.store.undo.pop())
        self.assertEqual(self.store.document.dialogues[0].text, '5')

    def test_redo_survives_navigation_after_undo(self):
        self.edit('first')
        self.edit('second')
        self.store.redo.append(self.store.frame())
        self.store.restore(self.store.undo.pop())
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.assertEqual(self.store.document.dialogues[0].text, 'first')
        self.assertEqual(len(self.store.redo), 1)
        self.store.undo.append(self.store.frame())
        self.store.restore(self.store.redo.pop())
        self.assertEqual(self.store.document.dialogues[0].text, 'second')

    def test_metadata_only_save_state_updates_without_reencoding_pixels(self):
        self.store.document.dirty = True
        self.store.document.saved_path = 'new-location.mangaclean'
        with patch.object(codec, 'save_project', wraps=codec.save_project) as writes:
            self.chapter.flush(self.store)
            self.assertEqual(writes.call_count, 0)
        row = self.chapter.row(self.ids[0])
        self.assertTrue(row['dirty'])
        self.assertEqual(row['savedPath'], 'new-location.mangaclean')

    def test_failed_flush_retries_without_marking_new_snapshot_persisted(self):
        self.edit('retry')
        with patch.object(codec, 'save_project', side_effect=OSError('simulated write failure')):
            with self.assertRaises(OSError):
                self.chapter.activate(self.store, self.ids[1])
        self.assertEqual(self.chapter.active, self.ids[0])
        self.assertEqual(self.store.document.dialogues[0].text, 'retry')
        self.chapter.activate(self.store, self.ids[1])
        self.chapter.activate(self.store, self.ids[0])
        self.assertEqual(self.store.document.dialogues[0].text, 'retry')

    def test_save_reload_keeps_content_and_existing_history_semantics(self):
        self.edit('saved')
        target = Path(self.temp.name) / 'copy.mangaclean'
        self.chapter.save(self.store, target)
        loaded = Chapter.load(target, self.temp.name, Document)
        loaded.activate(self.store, loaded.initial_active, flush=False)
        self.assertEqual(self.store.document.dialogues[0].text, 'saved')
        # Existing chapter files persist edits, not an application Undo session.
        self.assertEqual(len(self.store.undo), 0)
        with patch.object(codec, 'save_project', wraps=codec.save_project) as writes:
            loaded.activate(self.store, self.ids[1])
            self.assertEqual(writes.call_count, 0)


if __name__ == '__main__':
    unittest.main()
