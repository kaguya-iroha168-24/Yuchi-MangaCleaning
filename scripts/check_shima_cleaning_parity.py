"""Compare copied baseline and current cleaning on actual Shima predictions."""
from __future__ import annotations
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
REPORT=Path(r"E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity")
WORK=ROOT/'.cache/shima-parity'
DEVICE=os.environ.get('YUCHI_PARITY_DEVICE','cuda-0')
ACTUAL=os.environ.get('YUCHI_PARITY_ACTUAL')=='1'
SUFFIX=('-cpu' if DEVICE=='cpu' else '')+('-actual' if ACTUAL else '')
BASELINE_PYTHON=r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe'


def side_run(side):
    import cv2,numpy as np
    sys.path.insert(0,str(WORK/'baseline' if side=='baseline' else ROOT))
    from mangaclean.services import detection
    from mangaclean.services.yuchi_process import detection_config
    from mangaclean.services.cleaning_pipeline import prepare_bubble,execute
    from mangaclean.core.text_cleaning import restore_text,AUTO,TELEA,WHITE
    result_path=REPORT/f'{side}-{DEVICE}-page_009.json'
    if not result_path.exists():result_path=REPORT/f'{side}-cpu-page_009.json'
    raw=json.loads(result_path.read_text())
    detection.YuchiProcess.predict=lambda self,image:deepcopy(raw)
    image=cv2.imread(str(WORK/'fixtures/page_009.png'))
    batch=detection.detect('shima_v1',image,image,config=detection_config('shima_v1'))
    folder=REPORT/f'{side}-clean{SUFFIX}';folder.mkdir(exist_ok=True)
    rows=[]
    for index,bubble in enumerate(batch.bubbles):
        bubble.reviewed=True;bubble.review_decision='Accepted'
        proposal=prepare_bubble(image,bubble,np.zeros(image.shape[:2],np.uint8))
        cv2.imwrite(str(folder/f'{index}-mask.png'),proposal.mask)
        entry=dict(index=index,rect=list(bubble.rect),mask_pixels=int(np.count_nonzero(proposal.mask)),methods=[])
        if entry['mask_pixels']:
            for serial,method in enumerate((AUTO,TELEA,WHITE)):
                restored,checks=execute(image,proposal.mask,method,3,proposal.safe,[proposal],restore_text)
                cv2.imwrite(str(folder/f'{index}-{serial}.png'),restored.image)
                entry['methods'].append(dict(method=method,changed_pixels=restored.changed_pixels,
                                             outside_changed_pixels=restored.outside_changed_pixels))
        rows.append(entry)
    (REPORT/f'{side}-clean{SUFFIX}.json').write_text(json.dumps(rows,indent=2))


def main():
    import cv2,numpy as np
    gate=json.loads((REPORT/('DETECTION_PARITY_ACTUAL_RUNTIME.json' if ACTUAL else 'DETECTION_PARITY.json')).read_text())
    assert gate['all_passed'] and gate['source_unchanged'],'Detection parity must pass first'
    for side in ('baseline','tauri'):
        subprocess.run([BASELINE_PYTHON if ACTUAL and side=='baseline' else sys.executable,'-B',str(Path(__file__).resolve()),side],cwd=ROOT,check=True)
    a=json.loads((REPORT/f'baseline-clean{SUFFIX}.json').read_text());b=json.loads((REPORT/f'tauri-clean{SUFFIX}.json').read_text())
    differences=[]
    for source in sorted((REPORT/f'baseline-clean{SUFFIX}').glob('*.png')):
        target=REPORT/f'tauri-clean{SUFFIX}'/source.name
        aa=cv2.imread(str(source),cv2.IMREAD_UNCHANGED);bb=cv2.imread(str(target),cv2.IMREAD_UNCHANGED)
        differences.append(dict(file=source.name,different_pixels=int(np.count_nonzero(np.any(aa!=bb,axis=2))) if aa.ndim==3 else int(np.count_nonzero(aa!=bb))))
    result=dict(passed=a==b and all(x['different_pixels']==0 for x in differences),candidates=len(a),
                nonempty_masks=sum(x['mask_pixels']>0 for x in a),cases=a,differences=differences,
                note='Test acceptance on isolated copies only; no semantic approval or ground truth classification.')
    (REPORT/f'CLEANING_PARITY{SUFFIX.upper()}.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k not in ('cases','differences')}))
    assert result['passed']
    assert all(m['outside_changed_pixels']==0 for row in a for m in row['methods'])


if __name__=='__main__':
    if len(sys.argv)>1:side_run(sys.argv[1])
    else:main()
