"""Automation uses existing native cleaning gates and one reversible commit."""
import importlib
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np

from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph
from mangaclean.services.project_io import load_project, save_project


class AutomaticProcessingTests(unittest.TestCase):
    def setUp(self):
        self.store_patch = patch.object(main, 'store', main.Store())
        self.store_patch.start()
        self.addCleanup(self.store_patch.stop)
        source = np.full((140, 390, 3), 245, np.uint8)
        bubbles = []
        for index, x in enumerate((15, 140, 265)):
            shape = np.zeros((100, 110), np.uint8)
            cv2.ellipse(shape, (55, 50), (48, 43), 0, 0, 360, 255, -1)
            source[20:120, x:x+110][shape > 0] = 255
            cv2.putText(source, 'HI', (x+40, 77), cv2.FONT_HERSHEY_SIMPLEX, .55, (10, 10, 10), 1)
            interior = cv2.erode(shape, np.ones((7, 7), np.uint8))
            bubbles.append(Bubble((x, 20, 110, 100), interior, np.zeros_like(shape),
                                  id=f'bubble-{index}', segmentation=shape))
        main.store.document = main.Document(source, source.copy(), 'synthetic.png',
            np.zeros(source.shape[:2], np.uint8), bubbles=bubbles,
            region_graph=RegionGraph.for_legacy(source, 'synthetic.png'))
        self.doc = main.store.document

    def run_clean(self, check_cancel=lambda: None):
        self.assertIsNotNone(importlib.util.find_spec('backend.automatic_processing'),
                             'Automatic page cleaning helper is missing')
        module = importlib.import_module('backend.automatic_processing')
        with main.store.lock:
            return module.clean_page(SimpleNamespace(**vars(main)), check_cancel)

    def test_safe_needs_review_candidates_clean_in_one_undo_without_acceptance(self):
        before = self.doc.source.copy()
        original_ids = [bubble.id for bubble in self.doc.bubbles]
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], original_ids)
        self.assertEqual(summary['skipped'], [])
        self.assertEqual(summary['alreadyProcessedIds'], [])
        self.assertEqual(len(main.store.undo), 1)
        self.assertEqual(summary['result']['outsideChangedPixels'], 0)
        union = np.zeros(before.shape[:2], np.uint8)
        for bubble in self.doc.bubbles:
            self.assertEqual(bubble.review_decision, 'Needs Review')
            self.assertFalse(bubble.reviewed)
            self.assertFalse(bubble.provenance['automatic_processing']['semantic_verification'])
            x, y, w, h = bubble.rect
            self.assertIsNotNone(bubble.last_applied_mask)
            union[y:y+h, x:x+w] |= bubble.last_applied_mask
        self.assertTrue(np.any(self.doc.working != before))
        np.testing.assert_array_equal(self.doc.working[union == 0], before[union == 0])
        np.testing.assert_array_equal(self.doc.source, before)
        self.assertEqual([bubble.id for bubble in self.doc.bubbles], original_ids)
        self.assertIsNone(main.store.preview)

    def test_mixed_candidates_skip_unsafe_and_excluded_without_touching_their_pixels(self):
        self.doc.bubbles[1].provenance['manual_corrected'] = True
        self.doc.bubbles[2].provenance['excluded'] = True
        before = self.doc.working.copy()
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], ['bubble-0'])
        self.assertEqual([item['id'] for item in summary['skipped']], ['bubble-1', 'bubble-2'])
        self.assertTrue(all(item['reasons'] for item in summary['skipped']))
        np.testing.assert_array_equal(self.doc.working[:, 140:], before[:, 140:])
        self.assertEqual(len(main.store.undo), 1)

    def test_unsafe_only_pass_preserves_pixels_masks_and_review(self):
        for bubble in self.doc.bubbles:
            bubble.candidate_kind = 'Uncertain'
        before = self.doc.working.copy()
        pending = self.doc.mask.copy()
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], [])
        self.assertEqual(len(summary['skipped']), 3)
        np.testing.assert_array_equal(self.doc.working, before)
        np.testing.assert_array_equal(self.doc.mask, pending)
        self.assertTrue(all(b.review_decision == 'Needs Review' for b in self.doc.bubbles))
        revision = self.doc.revision
        undo_count = len(main.store.undo)
        self.run_clean()
        self.assertEqual(self.doc.revision, revision)
        self.assertEqual(len(main.store.undo), undo_count)

    def test_empty_ink_candidate_is_skipped_and_does_not_block_safe_neighbor(self):
        bubble = self.doc.bubbles[1]
        x, y, w, h = bubble.rect
        self.doc.source[y:y+h, x:x+w][bubble.segmentation > 0] = 255
        self.doc.working = self.doc.source.copy()
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], ['bubble-0', 'bubble-2'])
        self.assertEqual([item['id'] for item in summary['skipped']], ['bubble-1'])
        self.assertEqual(summary['alreadyProcessedIds'], [])
        self.assertIsNone(bubble.last_applied_mask)
        np.testing.assert_array_equal(self.doc.working[y:y+h, x:x+w], self.doc.source[y:y+h, x:x+w])

    def test_global_manual_mask_is_preserved_and_withholds_automatic_cleaning(self):
        self.doc.manual_mask = np.zeros_like(self.doc.mask)
        self.doc.manual_mask[60:62, 57:59] = 255
        before = self.doc.working.copy()
        manual = self.doc.manual_mask.copy()
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], [])
        self.assertEqual(len(summary['skipped']), 3)
        np.testing.assert_array_equal(self.doc.working, before)
        np.testing.assert_array_equal(self.doc.manual_mask, manual)

    def test_recovered_container_requiring_confirmation_is_skipped_without_widening_scope(self):
        bubble = self.doc.bubbles[0]
        cv2.ellipse(self.doc.source, (70, 70), (48, 43), 0, 0, 360, (0, 0, 0), 2)
        self.doc.working = self.doc.source.copy()
        bubble.interior.fill(0)
        original_rect = bubble.rect
        proposal = main.prepare_bubble(self.doc.working, bubble, self.doc.mask)
        self.assertNotEqual(proposal.bubble.rect, original_rect)
        self.assertTrue(proposal.bubble.provenance['mask_recovery']['requires_confirmation'])
        self.assertTrue(main.automatic_clean_safety(self.doc.working, proposal)['safe'])
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], ['bubble-1', 'bubble-2'])
        self.assertEqual([item['id'] for item in summary['skipped']], ['bubble-0'])
        self.assertEqual(bubble.rect, original_rect)
        self.assertIsNone(bubble.last_applied_mask)
        np.testing.assert_array_equal(self.doc.working[:, :125], self.doc.source[:, :125])

    def test_cancellation_after_preview_leaves_the_transaction_uncommitted(self):
        before = main.store.frame()
        class Cancelled(Exception):
            pass
        def cancel_before_commit():
            if main.store.preview is not None:
                raise Cancelled('Cancelled before commit')
        with self.assertRaises(Cancelled):
            self.run_clean(cancel_before_commit)
        np.testing.assert_array_equal(self.doc.working, before['working'])
        np.testing.assert_array_equal(self.doc.mask, before['mask'])
        self.assertEqual([b.provenance for b in self.doc.bubbles], [b.provenance for b in before['bubbles']])
        self.assertEqual(self.doc.revision, 0)
        self.assertFalse(main.store.undo)
        self.assertIsNone(main.store.preview)

    def test_cancellation_during_restoration_discards_the_uncommitted_image(self):
        before = main.store.frame()
        restorer = main.restore_text
        def restore_then_cancel(*args, **kwargs):
            result = restorer(*args, **kwargs)
            main.store.cancel.set()
            return result
        def check_cancel():
            if main.store.cancel.is_set():
                raise main.DetectionCancelled('Cancelled during restoration')
        with patch.object(main, 'restore_text', side_effect=restore_then_cancel):
            with self.assertRaises(main.DetectionCancelled):
                self.run_clean(check_cancel)
        np.testing.assert_array_equal(self.doc.working, self.doc.source)
        np.testing.assert_array_equal(self.doc.mask, before['mask'])
        self.assertEqual([b.provenance for b in self.doc.bubbles], [b.provenance for b in before['bubbles']])
        self.assertEqual(self.doc.revision, 0)
        self.assertFalse(main.store.undo)
        self.assertIsNone(main.store.preview)

    def test_repeat_clean_reports_already_processed_without_another_transaction(self):
        self.run_clean()
        revision = self.doc.revision
        image = self.doc.working.copy()
        undo_count = len(main.store.undo)
        summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], [])
        self.assertEqual(summary['alreadyProcessedIds'], ['bubble-0', 'bubble-1', 'bubble-2'])
        self.assertEqual(summary['skipped'], [])
        self.assertEqual(self.doc.revision, revision)
        self.assertEqual(len(main.store.undo), undo_count)
        np.testing.assert_array_equal(self.doc.working, image)

    def test_batch_execute_rejection_discards_every_proposal_and_reports_failure(self):
        before = main.store.frame()
        with patch.object(main, 'restore_text', side_effect=ValueError('Synthetic restoration rejection')):
            summary = self.run_clean()
        self.assertEqual(summary['cleanedIds'], [])
        self.assertEqual(len(summary['skipped']), 3)
        self.assertIn('Synthetic restoration rejection', summary['failure'])
        np.testing.assert_array_equal(self.doc.working, before['working'])
        self.assertEqual([b.provenance for b in self.doc.bubbles], [b.provenance for b in before['bubbles']])
        self.assertEqual(self.doc.revision, 0)
        self.assertFalse(main.store.undo)
        self.assertIsNone(main.store.preview)

    def test_one_undo_redo_restores_all_page_cleaning_and_processing_provenance(self):
        source = self.doc.source.copy()
        self.run_clean()
        cleaned = self.doc.working.copy()
        request = SimpleNamespace(headers={'authorization': 'Bearer ' + main.TOKEN})
        main.undo(request)
        np.testing.assert_array_equal(self.doc.working, source)
        self.assertTrue(all('automatic_processing' not in b.provenance for b in self.doc.bubbles))
        self.assertFalse(main.store.undo)
        main.redo(request)
        np.testing.assert_array_equal(self.doc.working, cleaned)
        self.assertTrue(all(b.provenance['automatic_processing']['status'] == 'cleaned' for b in self.doc.bubbles))

    def test_existing_project_format_roundtrip_preserves_processing_records_and_masks(self):
        self.doc.bubbles[1].provenance['manual_corrected'] = True
        self.run_clean()
        with TemporaryDirectory(dir=main.CACHE) as folder:
            path = Path(folder) / 'automatic.mangaclean'
            save_project(path, self.doc.snapshot())
            loaded = load_project(path)
        np.testing.assert_array_equal(loaded['source'], self.doc.source)
        np.testing.assert_array_equal(loaded['clean'], self.doc.working)
        for actual, expected in zip(loaded['bubbles'], self.doc.bubbles):
            self.assertEqual(actual.id, expected.id)
            self.assertEqual(actual.provenance, expected.provenance)
            self.assertEqual(actual.review_decision, 'Needs Review')
            if expected.last_applied_mask is not None:
                np.testing.assert_array_equal(actual.last_applied_mask, expected.last_applied_mask)


if __name__ == '__main__':
    unittest.main()
