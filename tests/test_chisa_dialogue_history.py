"""Existing API keeps case and its local fitting floor in one reversible edit."""
import unittest
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.core.region_graph import RegionGraph

class ChisaDialogueHistoryTests(unittest.TestCase):
    def test_case_and_minimum_are_undone_together_without_touching_artwork(self):
        source=np.full((180,120,3),255,np.uint8)
        main.store.document=main.Document(source,source.copy(),'owned.png',np.zeros((180,120),np.uint8),region_graph=RegionGraph.for_legacy(source,'owned.png'))
        main.store.job=None;main.store.preview=None;main.store.undo.clear();main.store.redo.clear()
        client=TestClient(main.app);headers={'Authorization':'Bearer '+main.TOKEN}
        def post(path,payload=None):
            response=client.post(path,headers=headers,json=payload or {})
            self.assertEqual(response.status_code,200,response.text);return response.json()
        text=post('/v1/dialogues',dict(text='Aduh Aku Sangat Gugup',width=100,height=150,size=32,minimum_size=12))['document']['dialogues'][0]
        post('/v1/dialogues/'+text['id'],dict(text='ADUH AKU SANGAT GUGUP',minimum_size=10))
        undone=post('/v1/undo')['document']['dialogues'][0]
        self.assertEqual(undone['text'],text['text']);self.assertEqual(undone['minimum_size'],12)
        redone=post('/v1/redo')['document']['dialogues'][0]
        self.assertEqual(redone['text'],'ADUH AKU SANGAT GUGUP');self.assertEqual(redone['minimum_size'],10);self.assertEqual(redone['size'],32)
        np.testing.assert_array_equal(main.store.document.source,source);np.testing.assert_array_equal(main.store.document.working,source)
        self.assertFalse(np.any(main.store.document.mask))

if __name__=='__main__':unittest.main()
