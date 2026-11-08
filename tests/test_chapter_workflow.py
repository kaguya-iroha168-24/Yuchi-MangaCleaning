from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from zipfile import ZipFile
from unittest.mock import patch
import json
import unittest
import cv2
import numpy as np
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services import chapter as chapter_io

class ChapterWorkflow(unittest.TestCase):
    def setUp(self):
        self.client=TestClient(main.app);self.headers={'Authorization':'Bearer '+main.TOKEN}
        main.store.job=None;main.store.document=None;main.store.chapter=None

    def post(self,path,data=None):return self.client.post(path,headers=self.headers,json=data or {})

    def import_pages(self,count=12):
        files=[]
        for index in reversed(range(1,count+1)):
            image=np.full((100,80,3),170+index,np.uint8);ok,png=cv2.imencode('.png',image)
            files.append(('files',(f'page_{index}.png',BytesIO(png.tobytes()),'image/png')))
        response=self.client.post('/v1/pages/import',headers=self.headers,files=files)
        self.assertEqual(response.status_code,200,response.text)
        return response.json()['chapter']['pages']

    def test_twelve_pages_natural_order_edit_switch_history_save_reload_export(self):
        pages=self.import_pages()
        self.assertEqual([p['name'] for p in pages],[f'page_{i}.png' for i in range(1,13)])
        self.assertEqual(len({p['id'] for p in pages}),12)
        original=main.store.document.source.copy()
        for index,text in [(0,'First corrected'),(10,'Eleventh corrected')]:
            self.assertEqual(self.post('/v1/pages/'+pages[index]['id']+'/activate').status_code,200)
            self.post('/v1/text-regions',{'rect':[10,10,30,40],'text':text,'bubbleId':None})
        self.post('/v1/pages/'+pages[0]['id']+'/activate')
        self.assertEqual(main.store.document.region_graph.text_regions[0].source_text,'First corrected')
        self.post('/v1/undo');self.assertEqual(len(main.store.document.region_graph.text_regions),0)
        self.post('/v1/redo');self.assertEqual(len(main.store.document.region_graph.text_regions),1)
        saved=self.post('/v1/save/project');self.assertEqual(saved.status_code,200,saved.text)
        path=Path(saved.json()['path']);self.assertTrue(path.is_file())
        loaded=self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('chapter.mangaclean',BytesIO(path.read_bytes()),'application/octet-stream')})
        self.assertEqual(loaded.status_code,200,loaded.text)
        self.assertEqual([p['id'] for p in loaded.json()['chapter']['pages']],[p['id'] for p in pages])
        self.post('/v1/pages/'+pages[10]['id']+'/activate')
        self.assertEqual(main.store.document.region_graph.text_regions[0].source_text,'Eleventh corrected')
        exports=self.post('/v1/pages/export',{'kind':'png','ids':[p['id'] for p in pages]})
        self.assertEqual(exports.status_code,200,exports.text)
        self.assertEqual(len(exports.json()['files']),12);self.assertEqual(exports.json()['errors'],[])
        for row in exports.json()['files']:
            self.assertTrue(Path(row['path']).is_file())
        self.post('/v1/pages/'+pages[0]['id']+'/activate');np.testing.assert_array_equal(main.store.document.source,original)

    def test_repeated_filenames_still_have_distinct_ids_and_invalid_switch_is_safe(self):
        pages=self.import_pages(10);before=main.store.document.region_graph.page_id
        self.assertEqual(self.post('/v1/pages/'+'0'*32+'/activate').status_code,404)
        self.assertEqual(main.store.document.region_graph.page_id,before)
        image=np.full((20,20,3),255,np.uint8);_,png=cv2.imencode('.png',image)
        response=self.client.post('/v1/pages/import?append=true',headers=self.headers,files=[('files',('page_1.png',BytesIO(png.tobytes()),'image/png'))])
        self.assertEqual(response.status_code,200,response.text)
        ids=[p['id'] for p in response.json()['chapter']['pages']];self.assertEqual(len(ids),11);self.assertEqual(len(set(ids)),11)

    def test_append_identical_image_keeps_old_page_id_and_rolls_back_invalid_batch(self):
        [first] = self.import_pages(1)
        _, png = cv2.imencode('.png', main.store.document.source)
        def append(*items):
            return self.client.post('/v1/pages/import?append=true', headers=self.headers,
                files=[('files', (name, payload, 'image/png')) for name, payload in items])
        invalid = append(('page_1.png', png.tobytes()), ('page_2.png', b'bad data'))
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual([row['id'] for row in main.store.chapter.pages], [first['id']])
        valid = append(('page_1.png', png.tobytes()))
        self.assertEqual(valid.status_code, 200, valid.text)
        ids = [row['id'] for row in valid.json()['chapter']['pages']]
        self.assertEqual(ids[0], first['id'])
        self.assertEqual(len(set(ids)), 2)
        self.assertEqual(main.store.document.region_graph.page_id, first['id'])

    def test_reopen_reuses_verified_page_bytes_without_reencoding(self):
        self.import_pages(2)
        main.store.document.composition = {'text_mode':'overlay'}
        main.store.document.revision += 1
        with TemporaryDirectory(dir=main.CACHE) as folder:
            path = Path(folder) / 'saved.mangaclean'
            main.store.chapter.save(main.store,path)
            with patch.object(chapter_io,'save_project',side_effect=AssertionError('Unnecessary chapter reencode')):
                loaded = chapter_io.Chapter.load(path,folder,main.Document)
            with ZipFile(path) as archive:
                manifest = json.loads(archive.read('manifest.json'))
                for row in manifest['pages']:
                    self.assertEqual((loaded.folder/(row['id']+'.mangaclean')).read_bytes(),archive.read(row['entry']))
            self.assertEqual(loaded.decode(loaded.initial_active).composition, {'text_mode':'overlay'})

    def test_twenty_pages_and_linked_dialogue_history_remain_page_local(self):
        pages=self.import_pages(20)
        self.assertEqual(len(main.store.chapter.pages),20)
        source=self.post('/v1/text-regions',{'rect':[10,10,30,40],'text':'source','bubbleId':None}).json()['document']['textRegions'][0]
        dialogue=self.post('/v1/dialogues',{'x':10,'y':10,'width':30,'height':40,'text':'Indonesia','source_region_id':source['id']})
        self.assertEqual(dialogue.status_code,200,dialogue.text)
        self.assertEqual(self.post('/v1/pages/'+pages[19]['id']+'/activate').status_code,200)
        self.assertEqual(len(main.store.document.dialogues),0)
        switched=self.post('/v1/pages/'+pages[0]['id']+'/activate')
        self.assertEqual(switched.status_code,200,switched.text)
        self.assertEqual(main.store.document.dialogues[0].text,'Indonesia')
        self.post('/v1/undo');self.assertEqual(len(main.store.document.dialogues),0)
        self.post('/v1/undo');self.assertEqual(len(main.store.document.region_graph.text_regions),0)
        self.post('/v1/redo');self.post('/v1/redo')
        self.assertEqual(main.store.document.dialogues[0].source_region_id,source['id'])

    def test_clean_pixels_survive_repeated_chapter_reload_and_switch(self):
        pages=self.import_pages(2)
        original=main.store.document.source.copy()
        main.store.document.working[20:25,30:36]=255
        main.store.document.revision+=1;main.store.document.dirty=True
        expected=main.store.document.working.copy()
        for _ in range(2):
            saved=self.post('/v1/save/project')
            self.assertEqual(saved.status_code,200,saved.text)
            path=Path(saved.json()['path'])
            loaded=self.client.post('/v1/open?discard=true',headers=self.headers,files={'file':('chapter.mangaclean',BytesIO(path.read_bytes()),'application/octet-stream')})
            self.assertEqual(loaded.status_code,200,loaded.text)
            self.post('/v1/pages/'+pages[1]['id']+'/activate')
            self.post('/v1/pages/'+pages[0]['id']+'/activate')
            np.testing.assert_array_equal(main.store.document.working,expected)
            np.testing.assert_array_equal(main.store.document.source,original)

if __name__=='__main__':unittest.main()
