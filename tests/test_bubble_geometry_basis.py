"""Repeated ROI edits retain a bounded, lossless source-position mask basis."""
from pathlib import Path
from tempfile import TemporaryDirectory
import json,unittest
import numpy as np
from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.region_graph import RegionGraph
from mangaclean.services.bubble_geometry import reframe_bubble
from mangaclean.services.project_io import save_project,load_project

class GeometryBasisTests(unittest.TestCase):
    def bubble(self):
        mask=np.zeros((30,20),np.uint8);mask[2:10,3:17]=255;mask[20:28,3:17]=255
        return Bubble((10,10,20,30),mask.copy(),mask.copy(),segmentation=mask.copy(),text_regions=((13,12,14,8),(13,30,14,8)))

    def test_shrink_then_expand_restores_both_text_lobes_without_new_segmentation(self):
        original=self.bubble();short=reframe_bubble(original,(10,10,20,15),(60,60,3))
        restored=reframe_bubble(short,original.rect,(60,60,3))
        for key in ['interior','text','segmentation']:np.testing.assert_array_equal(getattr(restored,key),getattr(original,key))
        self.assertEqual(restored.text_regions,original.text_regions);self.assertEqual(restored.id,original.id)
        self.assertNotIn('geometry_basis_v1',original.provenance)

    def test_lossless_basis_survives_existing_project_codec_and_bounds_never_expand_source_mask(self):
        source=np.full((60,60,3),255,np.uint8);original=self.bubble()
        short=reframe_bubble(original,(10,10,20,15),source.shape)
        root=Path(__file__).resolve().parents[1]/'.cache/chisa-geometry-basis';root.mkdir(parents=True,exist_ok=True)
        with TemporaryDirectory(dir=root) as folder:
            path=Path(folder)/'fixture-copy.mangaclean'
            save_project(path,dict(source=source,clean=source.copy(),mask=np.zeros((60,60),np.uint8),manual_mask=None,bubbles=[short],dialogues=[],region_graph=RegionGraph.for_legacy(source,'owned.png'),source_name='owned.png'))
            saved=load_project(path)['bubbles'][0]
        expanded=reframe_bubble(saved,(8,8,24,36),source.shape)
        np.testing.assert_array_equal(expanded.full_segmentation(source.shape[:2]),original.full_segmentation(source.shape[:2]))
        self.assertLessEqual(len(json.dumps(expanded.provenance)),20_000)

    def test_malformed_basis_is_rejected_instead_of_silently_cropping_again(self):
        original=self.bubble();original.provenance['geometry_basis_v1']={'rect':[10,10,20,30],'interior':'invalid','text':'invalid','segmentation':None,'text_regions':[]}
        with self.assertRaises(ValueError):reframe_bubble(original,(8,8,24,36),(60,60,3))
        self.assertEqual(original.rect,(10,10,20,30))

    def test_final_provenance_budget_is_checked_before_committing_a_geometry_edit(self):
        seed=reframe_bubble(self.bubble(),(10,10,20,30),(60,60,3))
        for key in ['roi_edited','original_roi','geometry_policy']:seed.provenance.pop(key)
        seed.provenance['padding']=''
        seed.provenance['padding']='x'*(19990-len(json.dumps(seed.provenance)))
        self.assertLessEqual(len(json.dumps(seed.provenance)),20_000)
        with self.assertRaises(ValueError):reframe_bubble(seed,(8,8,24,36),(60,60,3))

    def test_basis_preserves_uint8_values_without_binarizing_them(self):
        original=self.bubble();original.segmentation[:]=np.arange(600,dtype=np.uint16).reshape(30,20)%256
        short=reframe_bubble(original,(10,10,20,15),(60,60,3))
        restored=reframe_bubble(short,original.rect,(60,60,3))
        np.testing.assert_array_equal(restored.segmentation,original.segmentation)

if __name__=='__main__':unittest.main()
