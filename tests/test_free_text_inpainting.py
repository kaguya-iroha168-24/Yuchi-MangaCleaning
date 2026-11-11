import unittest
import numpy as np
import cv2

from mangaclean.core.text_cleaning import restore_text, AUTO, TELEA, WHITE
from mangaclean.services.cleaning_pipeline import prepare_text_selection


class TestFreeTextInpainting(unittest.TestCase):
    def test_white_bubble_preserves_white_clean(self):
        # White background with dark text
        img = np.full((100, 100, 3), 255, dtype=np.uint8)
        cv2.putText(img, "HELLO", (15, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 0), 2)
        mask, interior = prepare_text_selection(img, (10, 20, 80, 60), bubble=None)
        self.assertGreater(cv2.countNonZero(mask), 0)
        res = restore_text(img, mask, method=AUTO, interior=interior)
        self.assertEqual(res.method, WHITE)
        self.assertGreater(res.changed_pixels, 0)

    def test_free_text_on_screentone_routes_to_telea(self):
        # 40% gray / screentone background with dark text
        img = np.full((100, 100, 3), 160, dtype=np.uint8)
        cv2.putText(img, "SFX", (20, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (20, 20, 20), 2)
        mask, interior = prepare_text_selection(img, (10, 20, 80, 60), bubble=None)
        self.assertGreater(cv2.countNonZero(mask), 0)
        res = restore_text(img, mask, method=AUTO, interior=interior)
        self.assertEqual(res.method, TELEA)
        self.assertGreater(res.changed_pixels, 0)
        # Verify text was cleaned and restored close to background 160
        cleaned_crop = res.image[20:80, 10:90]
        self.assertAlmostEqual(float(np.mean(cleaned_crop)), 160.0, delta=10.0)


if __name__ == '__main__':
    unittest.main()
