"""Real local OCR request, review, correction, history and project roundtrip."""
from io import BytesIO
import json
from pathlib import Path
import sys
import time

from fastapi.testclient import TestClient
from backend import main
from mangaclean.services.project_io import load_project


def check(device):
    fixture=Path('.cache/shima-parity/fixtures/ocr-japanese-synthetic.png')
    headers={'Authorization':f'Bearer {main.TOKEN}','Origin':'http://tauri.localhost'}
    client=TestClient(main.app)
    response=client.post('/v1/open?discard=true',headers=headers,files={'file':(fixture.name,BytesIO(fixture.read_bytes()),'image/png')})
    assert response.status_code==200,response.text
    added=client.post('/v1/text-regions',headers=headers,json={'rect':[0,0,820,130],'text':'Preserved manual source'})
    assert added.status_code==200,added.text
    identifier=added.json()['document']['textRegions'][0]['id']
    started=time.monotonic()
    requested=client.post(f'/v1/text-regions/{identifier}/ocr',headers=headers,json={'device':device})
    assert requested.status_code==200,requested.text
    while time.monotonic()-started<330:
        state=client.get('/v1/state',headers=headers).json()
        if state['job']['status'] not in ('queued','running'):break
        time.sleep(.2)
    report={'device':device,'elapsed_s':time.monotonic()-started,'job':state['job'],
            'fixture':'Synthetic Japanese text in Yu Gothic, not a manga accuracy benchmark.'}
    report_dir=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity')
    output=report_dir/f'OCR-{device}.json'
    if state['job']['status']!='done':
        output.write_text(json.dumps(report,indent=2),encoding='utf-8')
        raise AssertionError(state['job'])
    region=state['document']['textRegions'][0]
    assert region['text']=='Preserved manual source'
    proposal=region['ocr'];assert proposal['confidence'] is None and proposal['status']=='Needs Review'
    expected='こんにちは。今日はいい天気です。'
    assert client.post(f'/v1/text-regions/{identifier}/ocr-review',headers=headers,json={'decision':'Accepted','editedText':expected}).status_code==409
    accepted=client.post(f'/v1/text-regions/{identifier}/ocr-review',headers=headers,json={'decision':'Accepted','editedText':expected,'replaceExisting':True})
    assert accepted.status_code==200,accepted.text
    assert client.post('/v1/undo',headers=headers).json()['document']['textRegions'][0]['text']=='Preserved manual source'
    assert client.post('/v1/redo',headers=headers).json()['document']['textRegions'][0]['text']==expected
    corrected=client.post(f'/v1/text-regions/{identifier}',headers=headers,json={'text':expected+'校正済み'})
    assert corrected.status_code==200,corrected.text
    assert corrected.json()['document']['textRegions'][0]['ocr']['status']=='Corrected'
    saved=client.post('/v1/save/project',headers=headers)
    assert saved.status_code==200,saved.text
    loaded=load_project(saved.json()['path'])['region_graph'].region(identifier)
    assert loaded.source_text==expected+'校正済み' and loaded.provenance['ocr']['raw_text']==proposal['raw_text']
    report.update(passed=True,raw_text=proposal['raw_text'],expected_text=expected,
                  exact_synthetic_text=proposal['raw_text']==expected,provider=proposal['provider'],model_id=proposal['model_id'],
                  model_sha256=proposal['model_sha256'],inference_s=proposal['inference_s'],warnings=proposal.get('warnings'),
                  project=saved.json()['path'],manual_preserved_before_review=True,undo_redo=True,roundtrip=True)
    output.write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=True))


if __name__=='__main__':check(sys.argv[1] if len(sys.argv)>1 else 'cpu')
