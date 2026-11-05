"""Local-only real manga fixtures and workflow evidence. Never mutates dataset inputs."""
from __future__ import annotations

import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import sys
import time
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DATA = Path(r'E:\BagassZx\Dataset\Manga109\extracted\Manga109_released_2026_05_21')
WORK = ROOT / '.cache/realworld-20261028'
REPORT = Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028')
BOOKS = ['MadouTaiga', 'ARMS', 'Akuhamu', 'AisazuNihaIrarenai', 'BEMADER_P', 'AppareKappore']


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write(name, data):
    REPORT.mkdir(parents=True, exist_ok=True)
    (REPORT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def prepare():
    import cv2
    import numpy as np
    WORK.mkdir(parents=True, exist_ok=True)
    REPORT.mkdir(parents=True, exist_ok=True)
    fixtures = WORK / 'fixtures'; fixtures.mkdir(exist_ok=True)
    rows = []; sheet = np.full((3 * 465, 2 * 650, 3), 235, np.uint8)
    for index, book in enumerate(BOOKS):
        source = DATA / f'images/{book}/008.jpg'
        annotation = DATA / f'annotations/{book}.xml'
        target = fixtures / f'{book}-008.jpg'
        if not target.exists(): shutil.copy2(source, target)
        assert sha(source) == sha(target)
        page = ET.parse(annotation).getroot().find('./pages/page[@index="8"]')
        texts = [dict(id=node.attrib['id'], rect=[int(node.attrib['xmin']), int(node.attrib['ymin']),
                         int(node.attrib['xmax'])-int(node.attrib['xmin']), int(node.attrib['ymax'])-int(node.attrib['ymin'])],
                      text=node.text or '') for node in page.findall('text')]
        image = cv2.imread(str(target)); h, w = image.shape[:2]
        scale = min(640 / w, 425 / h)
        thumb = cv2.resize(image, (round(w * scale), round(h * scale)))
        y, x = (index // 2)*465, (index % 2)*650
        sheet[y+30:y+30+thumb.shape[0], x:x+thumb.shape[1]] = thumb
        cv2.putText(sheet, book+' 008', (x+8,y+23), cv2.FONT_HERSHEY_SIMPLEX,.65,(0,0,0),1,cv2.LINE_AA)
        rows.append(dict(book=book, source=str(source), copy=str(target), sha256=sha(source),
                         annotation_source=str(annotation), annotation_sha256=sha(annotation), texts=texts,
                         native_size=[w,h], note='XML text regions are transcription references, not speech-bubble ground truth.'))
    cv2.imwrite(str(REPORT/'fixture-contact-sheet.jpg'),sheet)
    write('FIXTURES.json', rows)
    print(json.dumps(dict(prepared=len(rows),contact_sheet=str(REPORT/'fixture-contact-sheet.jpg'))))


def scan():
    import cv2
    from fastapi.testclient import TestClient
    from backend import main
    from mangaclean.services.yuchi_process import close_detector
    client = TestClient(main.app)
    headers = dict(Authorization='Bearer '+main.TOKEN, Origin='http://tauri.localhost')
    previous = REPORT/'SCANS.json'
    rows=json.loads(previous.read_text(encoding='utf-8')) if previous.exists() else []
    try:
        for fixture in json.loads((REPORT/'FIXTURES.json').read_text(encoding='utf-8')):
            book=fixture['book']; payload=Path(fixture['copy']).read_bytes()
            if any(row['book']==book for row in rows): continue
            opened=client.post('/v1/open?discard=true',headers=headers,files={'file':(Path(fixture['copy']).name,BytesIO(payload),'image/jpeg')})
            assert opened.status_code==200,opened.text
            start=time.monotonic()
            job=client.post('/v1/detect',headers=headers,json=dict(provider='shima_v1',device='auto'))
            assert job.status_code==200,job.text
            while time.monotonic()-start<240:
                state=client.get('/v1/state',headers=headers).json()
                if state['job']['status'] not in ('queued','running'): break
                time.sleep(.2)
            if state['job']['status']!='done':
                failure_path=REPORT/'SCAN_FAILURES.json'
                failures=json.loads(failure_path.read_text()) if failure_path.exists() else []
                failures.append(dict(book=book,job=state['job'],elapsed_s=time.monotonic()-start))
                write('SCAN_FAILURES.json',failures)
                raise AssertionError(state['job'])
            saved=client.post('/v1/save/project',headers=headers);assert saved.status_code==200,saved.text
            image=cv2.imread(fixture['copy'])
            for index,bubble in enumerate(state['document']['bubbles']):
                x,y,w,h=bubble['rect'];cv2.rectangle(image,(x,y),(x+w,y+h),(0,180,255),2)
                cv2.putText(image,str(index+1),(x,max(18,y)),cv2.FONT_HERSHEY_SIMPLEX,.55,(0,0,255),2)
            cv2.imwrite(str(REPORT/f'{book}-scan.jpg'),image)
            result=dict(book=book,elapsed_s=time.monotonic()-start,state=state,project=saved.json()['path'])
            rows.append(result);write('SCANS.json',rows)
            print(json.dumps(dict(book=book,candidates=len(state['document']['bubbles']),elapsed_s=result['elapsed_s'],project=result['project'])),flush=True)
    finally: close_detector()


def workflow():
    import cv2
    import numpy as np
    from fastapi.testclient import TestClient
    from backend import main
    from mangaclean.core.text_cleaning import AUTO
    from mangaclean.services.project_io import load_project
    selected = dict(MadouTaiga=2, ARMS=3, Akuhamu=5, AisazuNihaIrarenai=13, BEMADER_P=6, AppareKappore=1)
    client=TestClient(main.app);headers=dict(Authorization='Bearer '+main.TOKEN,Origin='http://tauri.localhost')
    rows=[];panels=[]
    for scan_case in json.loads((REPORT/'SCANS.json').read_text(encoding='utf-8')):
        book=scan_case['book'];project=Path(scan_case['project'])
        opened=client.post('/v1/open?discard=true',headers=headers,files={'file':(project.name,BytesIO(project.read_bytes()),'application/octet-stream')})
        assert opened.status_code==200,opened.text
        bubble=opened.json()['document']['bubbles'][selected[book]-1];identifier=bubble['id']
        original=main.store.document.source.copy();before=main.store.document.working.copy()
        assert np.array_equal(original,before)
        review=client.post(f'/v1/bubbles/{identifier}/review',headers=headers,json=dict(decision='Accepted'))
        assert review.status_code==200,review.text
        preview=client.post(f'/v1/bubbles/{identifier}/preview',headers=headers,json={})
        entry=dict(book=book,candidate_number=selected[book],rect=bubble['rect'],
                   reviewer='Codex visual inspection; isolated software test acceptance, not human dataset ground truth')
        if preview.status_code!=200:
            entry.update(passed=False,stage='preview',error=preview.text)
        else:
            mask=main.store.preview['mask'].copy()
            cv2.imwrite(str(REPORT/f'{book}-workflow-mask.png'),mask)
            cleaned=client.post('/v1/clean/confirm',headers=headers,json=dict(previewId=preview.json()['id'],method=AUTO,radius=3))
            if cleaned.status_code!=200:entry.update(passed=False,stage='clean',error=cleaned.text)
            else:
                working=main.store.document.working.copy()
                outside=int(np.count_nonzero(np.any(before!=working,axis=2)&(mask==0)))
                assert outside==0
                assert client.post('/v1/undo',headers=headers,json={}).status_code==200
                assert np.array_equal(main.store.document.working,before)
                assert client.post('/v1/redo',headers=headers,json={}).status_code==200
                assert np.array_equal(main.store.document.working,working)
                saved=client.post('/v1/save/project',headers=headers,json={});assert saved.status_code==200,saved.text
                loaded=load_project(saved.json()['path'])
                assert np.array_equal(loaded['source'],original) and np.array_equal(loaded['clean'],working)
                png=client.post('/v1/save/png',headers=headers,json={});assert png.status_code==200,png.text
                assert np.array_equal(cv2.imread(png.json()['path']),working)
                jpeg=client.post('/v1/save/jpeg',headers=headers,json={});assert jpeg.status_code==200,jpeg.text
                assert cv2.imread(jpeg.json()['path']).shape==working.shape
                cv2.imwrite(str(REPORT/f'{book}-workflow-clean.png'),working)
                x,y,w,h=bubble['rect'];row=np.concatenate([before[y:y+h,x:x+w],cv2.cvtColor(mask[y:y+h,x:x+w],cv2.COLOR_GRAY2BGR),working[y:y+h,x:x+w]],axis=1)
                panel=np.full((max(h,50)+30,max(w*3,600),3),235,np.uint8)
                panel[30:30+h,:w*3]=row
                cv2.putText(panel,book+'  original | mask | cleaned',(5,20),cv2.FONT_HERSHEY_SIMPLEX,.5,(0,0,0),1)
                panels.append(panel)
                entry.update(passed=True,mask_pixels=int(np.count_nonzero(mask)),outside_changed_pixels=outside,
                             result=cleaned.json()['result'],project=saved.json()['path'],png=png.json()['path'],jpeg=jpeg.json()['path'])
        rows.append(entry);write('REAL_WORKFLOWS.json',rows)
        print(json.dumps(dict(book=book,passed=entry['passed'],mask_pixels=entry.get('mask_pixels'),result=entry.get('result'))),flush=True)
    width=max(p.shape[1] for p in panels);height=sum(p.shape[0] for p in panels)
    sheet=np.full((height,width,3),235,np.uint8);y=0
    for panel in panels:sheet[y:y+panel.shape[0],:panel.shape[1]]=panel;y+=panel.shape[0]
    cv2.imwrite(str(REPORT/'cleaning-review-sheet.png'),sheet)


if __name__=='__main__':
    {'prepare':prepare,'scan':scan,'workflow':workflow}[sys.argv[1]]()
