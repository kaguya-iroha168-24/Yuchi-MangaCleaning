"""Evaluate real manga crops against copied transcription references; no dataset edits."""
from io import BytesIO
import json
from pathlib import Path
import sys
import time
import unicodedata

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import cv2
from fastapi.testclient import TestClient
from backend import main
from mangaclean.services.project_io import load_project

REPORT=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028')


def distance(a,b):
    previous=list(range(len(b)+1))
    for i,aa in enumerate(a,1):
        row=[i]
        for j,bb in enumerate(b,1):row.append(min(row[-1]+1,previous[j]+1,previous[j-1]+(aa!=bb)))
        previous=row
    return previous[-1]


def normalized(text):return ''.join(unicodedata.normalize('NFKC',text).split())


def main_check():
    fixtures=json.loads((REPORT/'FIXTURES.json').read_text(encoding='utf-8'))
    madou=next(f for f in fixtures if f['book']=='MadouTaiga')
    outside=next(t for t in madou['texts'] if t['id']=='0003a57f')
    fixtures.append(dict(madou,book='MadouTaiga-outside',texts=[outside]))
    aku=next(f for f in fixtures if f['book']=='Akuhamu')
    node=aku['texts'][0];x,y,w,h=node['rect'];image=cv2.imread(aku['copy'])
    rotated=cv2.rotate(image[y:y+h,x:x+w],cv2.ROTATE_90_CLOCKWISE)
    rotated_path=ROOT/'.cache/realworld-20261028/fixtures/Akuhamu-real-crop-rotated90.png'
    cv2.imwrite(str(rotated_path),rotated)
    fixtures.append(dict(aku,book='Akuhamu-rotated90',copy=str(rotated_path),
                         texts=[dict(node,rect=[0,0,rotated.shape[1],rotated.shape[0]])]))
    client=TestClient(main.app)
    headers=dict(Authorization='Bearer '+main.TOKEN,Origin='http://tauri.localhost')
    rows=[];output=REPORT/'REAL_OCR.json'
    if output.exists():rows=json.loads(output.read_text(encoding='utf-8'))
    for fixture in fixtures:
        if any(row['book']==fixture['book'] for row in rows):continue
        node=fixture['texts'][0];path=Path(fixture['copy'])
        response=client.post('/v1/open?discard=true',headers=headers,files={'file':(path.name,BytesIO(path.read_bytes()),'image/jpeg')})
        assert response.status_code==200,response.text
        region=client.post('/v1/text-regions',headers=headers,json=dict(rect=node['rect'],text=''))
        assert region.status_code==200,region.text
        identifier=region.json()['document']['textRegions'][0]['id']
        direction='unspecified' if fixture['book'].endswith('rotated90') else 'vertical'
        edited=client.post('/v1/text-regions/'+identifier,headers=headers,json=dict(direction=direction))
        assert edited.status_code==200,edited.text
        x,y,w,h=node['rect'];image=cv2.imread(str(path))
        cv2.imwrite(str(REPORT/f"{fixture['book']}-ocr-crop.png"),image[y:y+h,x:x+w])
        started=time.monotonic()
        request=client.post(f'/v1/text-regions/{identifier}/ocr',headers=headers,json=dict(device='cuda'))
        assert request.status_code==200,request.text
        while time.monotonic()-started<330:
            state=client.get('/v1/state',headers=headers).json()
            if state['job']['status'] not in ('running','queued'):break
            time.sleep(.3)
        entry=dict(book=fixture['book'],reference_id=node['id'],rect=node['rect'],reference=node['text'],
                   source_direction='Real vertical crop rotated90 clockwise as an orientation stress case' if direction=='unspecified' else 'vertical Japanese columns, native unrotated crop',job=state['job'],elapsed_s=time.monotonic()-started)
        if state['job']['status']=='done':
            proposal=state['document']['textRegions'][0]['ocr'];raw=proposal['raw_text']
            reference=normalized(node['text']);prediction=normalized(raw)
            entry.update(raw_text=raw,normalized_reference=reference,normalized_prediction=prediction,
                         edits=distance(reference,prediction),reference_characters=len(reference),
                         character_error_rate=distance(reference,prediction)/max(1,len(reference)),
                         raw_edits=distance(node['text'],raw),normalization='Unicode NFKC + remove whitespace only',
                         confidence=proposal['confidence'],manual_text_preserved=state['document']['textRegions'][0]['text']=='')
            # Explicit test correction from the separate reference, never inferred ground truth.
            review=client.post(f'/v1/text-regions/{identifier}/ocr-review',headers=headers,
                               json=dict(decision='Accepted',editedText=node['text'],replaceExisting=False))
            assert review.status_code==200,review.text
            moved=[x,y,w-1,h-1]
            edited=client.post('/v1/text-regions/'+identifier,headers=headers,json=dict(rect=moved,direction=direction))
            assert edited.status_code==200,edited.text
            assert edited.json()['document']['textRegions'][0]['ocr']['status']=='Stale'
            assert client.post('/v1/undo',headers=headers,json={}).status_code==200
            saved=client.post('/v1/save/project',headers=headers,json={})
            assert saved.status_code==200,saved.text
            loaded=load_project(saved.json()['path'])['region_graph'].region(identifier)
            assert loaded.source_text==node['text'] and loaded.provenance['ocr']['raw_text']==raw
            assert loaded.direction==direction
            entry.update(correction_and_crop_stale_undo_roundtrip=True,project=saved.json()['path'])
        rows.append(entry);output.write_text(json.dumps(rows,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
        print(json.dumps({k:v for k,v in entry.items() if k in ['book','elapsed_s','character_error_rate','edits','reference_characters','job']},ensure_ascii=True),flush=True)
        if state['job']['status']!='done':break


if __name__=='__main__':main_check()
