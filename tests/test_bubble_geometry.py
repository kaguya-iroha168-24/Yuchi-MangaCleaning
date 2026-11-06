"""ROI editing preserves existing segmentation in original page coordinates."""
import unittest
import numpy as np
from mangaclean.core.bubble_detector import Bubble
from mangaclean.services.bubble_geometry import reframe_bubble

class GeometryTests(unittest.TestCase):
    def bubble(self):
        mask=np.zeros((20,20),np.uint8);mask[3:17,3:17]=255
        return Bubble((10,10,20,20),mask.copy(),mask.copy(),segmentation=mask.copy())

    def test_reframe_preserves_page_pixels_and_original(self):
        old=self.bubble();new=reframe_bubble(old,(8,8,24,24),(60,60,3))
        np.testing.assert_array_equal(new.full_segmentation((60,60)),old.full_segmentation((60,60)))
        self.assertEqual(old.rect,(10,10,20,20))
        self.assertEqual(new.review_decision,'Needs Review')
        self.assertFalse(new.reviewed)
        self.assertEqual(new.id,old.id)

    def test_crop_only_intersects_existing_shape(self):
        old=self.bubble();new=reframe_bubble(old,(14,14,10,10),(60,60,3))
        self.assertFalse(np.any(new.full_segmentation((60,60)) & (255-old.full_segmentation((60,60)))))

    def test_invalid_empty_and_cleaned_edits_are_rejected(self):
        for rect in [(-1,0,20,20),(0,0,1,20),(50,50,20,20),(35,35,10,10)]:
            with self.assertRaises(ValueError):reframe_bubble(self.bubble(),rect,(60,60,3))
        bubble=self.bubble();bubble.cleaning_status='Cleaned'
        with self.assertRaises(ValueError):reframe_bubble(bubble,(8,8,24,24),(60,60,3))

if __name__=='__main__':unittest.main()
