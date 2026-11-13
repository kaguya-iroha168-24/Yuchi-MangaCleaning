import unittest
from fastapi.testclient import TestClient
import numpy as np

from backend import main
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.dialogue import Dialogue
from mangaclean.core.region_graph import RegionGraph, TextRegion
from mangaclean.services.manga_order import smart_split_text, sort_items_manga_rtl


class MangaOrderAlgorithmTests(unittest.TestCase):
    def test_sort_items_manga_rtl_panel_bands_and_stacked_columns(self):
        # Band 1 (top y ~ 20..180):
        #   Col R (x=420): r_single
        #   Col M (x=220): m_top (y=20..80), m_bot (y=95..160) stacked vertically
        #   Col L (x=30):  l_single
        # Band 2 (bottom y ~ 260..360):
        #   Col R (x=390): b_right
        #   Col L (x=50):  b_left
        items = [
            ('l_single', (30, 35, 110, 120)),
            ('b_left', (50, 270, 120, 90)),
            ('m_bot', (225, 95, 115, 70)),
            ('r_single', (420, 25, 110, 130)),
            ('b_right', (390, 260, 130, 95)),
            ('m_top', (220, 20, 120, 65)),
        ]
        ordered = sort_items_manga_rtl(items, lambda item: item[1])
        self.assertEqual(
            [item[0] for item in ordered],
            ['r_single', 'm_top', 'm_bot', 'l_single', 'b_right', 'b_left'],
        )

    def test_smart_split_text_variants(self):
        self.assertEqual(
            smart_split_text('First line\nSecond line\nThird line'),
            ('First line\nSecond line', 'Third line'),
        )
        self.assertEqual(
            smart_split_text('Wait! Where are you going? Stop right there.'),
            ('Wait! Where are you going?', 'Stop right there.'),
        )
        self.assertEqual(smart_split_text('Single unbroken bubble'), ('Single unbroken bubble', ''))
        self.assertEqual(smart_split_text('   '), ('', ''))


class MangaQolApiTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.headers = {'Authorization': 'Bearer ' + main.TOKEN}
        source = np.full((500, 600, 3), 255, np.uint8)
        m1 = np.zeros((80, 100), np.uint8)
        m1[10:70, 10:90] = 255
        m2 = np.zeros((80, 100), np.uint8)
        m2[10:70, 10:90] = 255
        m3 = np.zeros((90, 200), np.uint8)
        m3[10:80, 10:190] = 255

        # Intentionally out of RTL order: left (x=40), right (x=440), bottom (y=300)
        self.b_left = Bubble((40, 30, 100, 80), m1.copy(), m1.copy(), segmentation=m1.copy())
        self.b_right = Bubble((440, 35, 100, 80), m2.copy(), m2.copy(), segmentation=m2.copy())
        self.b_bottom = Bubble((200, 300, 200, 90), m3.copy(), m3.copy(), segmentation=m3.copy())

        graph = RegionGraph.for_legacy(source, 'page1.png')
        self.r_left = TextRegion((40, 30, 100, 80), source_text='Left text.', bubble_id=self.b_left.id)
        self.r_right = TextRegion((440, 35, 100, 80), source_text='Right text!', bubble_id=self.b_right.id)
        self.r_bottom = TextRegion((200, 300, 200, 90), source_text='First part! Second part?', bubble_id=self.b_bottom.id)
        graph.text_regions = [self.r_left, self.r_right, self.r_bottom]
        graph.reading_order = [self.r_left.id, self.r_right.id, self.r_bottom.id]

        self.d_left = Dialogue(x=40, y=30, width=100, height=80, text='Left dialogue.', bubble_id=self.b_left.id, source_region_id=self.r_left.id)
        self.d_right = Dialogue(x=440, y=35, width=100, height=80, text='Right dialogue!', bubble_id=self.b_right.id, source_region_id=self.r_right.id)
        self.d_bottom = Dialogue(x=200, y=300, width=200, height=90, text='One? Two!', bubble_id=self.b_bottom.id, source_region_id=self.r_bottom.id, auto_fit=True)

        self.doc = main.Document(
            source,
            source.copy(),
            'page1.png',
            np.zeros((500, 600), np.uint8),
            bubbles=[self.b_left, self.b_right, self.b_bottom],
            region_graph=graph,
            dialogues=[self.d_left, self.d_right, self.d_bottom],
        )
        self.page_id = graph.page_id
        main.store.document = self.doc
        main.store.job = None
        main.store.preview = None
        main.store.undo.clear()
        main.store.redo.clear()

    def post(self, path, data=None):
        return self.client.post(path, headers=self.headers, json=data or {})

    def test_sort_rtl_and_custom_reorder_with_undo_redo(self):
        res = self.post('/v1/bubbles/sort-rtl', {'pageId': self.page_id})
        self.assertEqual(res.status_code, 200, res.text)
        doc = main.store.document
        self.assertEqual([b.id for b in doc.bubbles], [self.b_right.id, self.b_left.id, self.b_bottom.id])
        self.assertEqual(doc.region_graph.reading_order, [self.r_right.id, self.r_left.id, self.r_bottom.id])
        self.assertEqual([d.id for d in doc.dialogues], [self.d_right.id, self.d_left.id, self.d_bottom.id])

        # Invalid reorder list returns 422
        bad = self.post('/v1/bubbles/reorder', {'pageId': self.page_id, 'ids': [self.b_right.id]})
        self.assertEqual(bad.status_code, 422)

        # Custom click-to-reorder sequence
        custom = self.post('/v1/bubbles/reorder', {
            'pageId': self.page_id,
            'ids': [self.b_bottom.id, self.b_right.id, self.b_left.id],
        })
        self.assertEqual(custom.status_code, 200, custom.text)
        self.assertEqual([b.id for b in doc.bubbles], [self.b_bottom.id, self.b_right.id, self.b_left.id])
        self.assertEqual(doc.region_graph.reading_order, [self.r_bottom.id, self.r_right.id, self.r_left.id])

        # Undo restores RTL sort, second undo restores initial unsorted order
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual([b.id for b in main.store.document.bubbles], [self.b_right.id, self.b_left.id, self.b_bottom.id])
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual([b.id for b in main.store.document.bubbles], [self.b_left.id, self.b_right.id, self.b_bottom.id])
        self.assertEqual(self.post('/v1/redo').status_code, 200)
        self.assertEqual([b.id for b in main.store.document.bubbles], [self.b_right.id, self.b_left.id, self.b_bottom.id])

    def test_bubble_merge_split_expand_and_undo(self):
        # Merge b_left and b_right (RTL puts Right first!)
        merge_res = self.post('/v1/bubbles/merge', {
            'pageId': self.page_id,
            'ids': [self.b_left.id, self.b_right.id],
        })
        self.assertEqual(merge_res.status_code, 200, merge_res.text)
        merged_id = merge_res.json()['mergedId']
        doc = main.store.document
        self.assertEqual(len(doc.bubbles), 2)
        merged_bubble = next(b for b in doc.bubbles if b.id == merged_id)
        # Union rect covers x=40..540 (w=500), y=30..115 (h=85)
        self.assertEqual(merged_bubble.rect, (40, 30, 500, 85))
        self.assertEqual(merged_bubble.interior.shape, (85, 500))
        self.assertEqual(merged_bubble.text.shape, (85, 500))
        merged_region = next(r for r in doc.region_graph.text_regions if r.bubble_id == merged_id)
        self.assertEqual(merged_region.source_text, 'Right text!\nLeft text.')
        merged_dlg = next(d for d in doc.dialogues if d.bubble_id == merged_id)
        self.assertEqual(merged_dlg.text, 'Right dialogue! Left dialogue.')

        # Undo restores both bubbles and texts atomically
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual(len(main.store.document.bubbles), 3)
        self.assertEqual({b.id for b in main.store.document.bubbles}, {self.b_left.id, self.b_right.id, self.b_bottom.id})

        # Split wide bottom bubble (200x90) vertically into Right (#1 RTL) and Left (#2 RTL)
        split_res = self.post('/v1/bubbles/split', {'pageId': self.page_id, 'id': self.b_bottom.id})
        self.assertEqual(split_res.status_code, 200, split_res.text)
        split_data = split_res.json()
        id1, id2 = split_data['splitIds']
        doc = main.store.document
        self.assertEqual(len(doc.bubbles), 4)
        b1 = next(b for b in doc.bubbles if b.id == id1)
        b2 = next(b for b in doc.bubbles if b.id == id2)
        self.assertGreater(b1.rect[0], b2.rect[0])  # b1 is Right half (RTL 1st), b2 is Left half (RTL 2nd)
        self.assertEqual(b1.rect[0] - (b2.rect[0] + b2.rect[2]), 4)  # 4px gap
        r1 = next(r for r in doc.region_graph.text_regions if r.bubble_id == id1)
        r2 = next(r for r in doc.region_graph.text_regions if r.bubble_id == id2)
        self.assertEqual((r1.source_text, r2.source_text), ('First part!', 'Second part?'))
        d1 = next(d for d in doc.dialogues if d.bubble_id == id1)
        d2 = next(d for d in doc.dialogues if d.bubble_id == id2)
        self.assertEqual((d1.text, d2.text), ('One?', 'Two!'))
        self.assertEqual(split_data['focusId'], id1)

        # Undo split
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertEqual(len(main.store.document.bubbles), 3)

        # Split bubble whose text stays in Box 1 -> focusId focuses Box 2 for immediate entry
        split_single = self.post('/v1/bubbles/split', {'pageId': self.page_id, 'id': self.b_left.id})
        self.assertEqual(split_single.status_code, 200, split_single.text)
        self.assertEqual(split_single.json()['focusId'], split_single.json()['splitIds'][1])
        self.assertEqual(self.post('/v1/undo').status_code, 200)

        # Expand bubble by 15%
        exp_res = self.post(f'/v1/bubbles/{self.b_left.id}/expand', {'pageId': self.page_id, 'paddingRatio': 0.15})
        self.assertEqual(exp_res.status_code, 200, exp_res.text)
        exp_rect = exp_res.json()['rect']
        self.assertGreater(exp_rect[2], 100)
        self.assertGreater(exp_rect[3], 80)

    def test_text_regions_merge_split_expand_and_auto_fit_batch(self):
        # Text-region expand
        exp = self.post(f'/v1/text-regions/{self.r_bottom.id}/expand', {'pageId': self.page_id, 'paddingRatio': 0.15})
        self.assertEqual(exp.status_code, 200, exp.text)
        self.assertGreater(exp.json()['rect'][2], 200)

        # Batch auto-fit updates unlocked auto_fit dialogue and clamps minimum_size
        fit_res = self.post('/v1/dialogues/auto-fit-batch', {
            'pageId': self.page_id,
            'updates': [
                {'id': self.d_bottom.id, 'size': 12, 'minimum_size': 14},
            ],
        })
        self.assertEqual(fit_res.status_code, 200, fit_res.text)
        d_bot = next(d for d in main.store.document.dialogues if d.id == self.d_bottom.id)
        self.assertEqual((d_bot.size, d_bot.minimum_size), (12, 12))

        # Split free text region (unlink first to test pure TextRegion split + merge)
        r_tall = TextRegion((10, 200, 60, 140), source_text='Top\nBottom')
        main.store.document.region_graph.add(r_tall)
        main.store.document.region_graph.validate(main.store.document.source.shape, main.store.document.bubbles)
        split_tr = self.post('/v1/text-regions/split', {'pageId': self.page_id, 'id': r_tall.id})
        self.assertEqual(split_tr.status_code, 200, split_tr.text)
        tr1_id, tr2_id = split_tr.json()['splitIds']
        tr1 = main.store.document.region_graph.region(tr1_id)
        tr2 = main.store.document.region_graph.region(tr2_id)
        self.assertLess(tr1.rect[1], tr2.rect[1])  # tall box splits horizontally: Top 1st, Bottom 2nd
        self.assertEqual((tr1.source_text, tr2.source_text), ('Top', 'Bottom'))

        merge_tr = self.post('/v1/text-regions/merge', {'pageId': self.page_id, 'ids': [tr2_id, tr1_id]})
        self.assertEqual(merge_tr.status_code, 200, merge_tr.text)
        merged_tr = main.store.document.region_graph.region(merge_tr.json()['mergedId'])
        self.assertEqual(merged_tr.source_text, 'Top\nBottom')

        # Undo merge -> restores split regions
        self.assertEqual(self.post('/v1/undo').status_code, 200)
        self.assertIsNotNone(main.store.document.region_graph.region(tr1_id))
        self.assertIsNotNone(main.store.document.region_graph.region(tr2_id))


if __name__ == '__main__':
    unittest.main()
