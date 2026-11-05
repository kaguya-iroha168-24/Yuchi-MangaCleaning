"""Audit this phase's retained artifacts and protected sources without inference."""
import hashlib
import json
from pathlib import Path
import sys

import cv2
import numpy as np

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from mangaclean.services.project_io import load_project

REPORT=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028')


def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def read(name):return json.loads((REPORT/name).read_text(encoding='utf-8-sig'))
def pixels(a,b):
    assert a.shape==b.shape
    return int(np.count_nonzero(np.any(a!=b,axis=2) if a.ndim==3 else a!=b))


def audit():
    protected=[]
    for fixture in read('FIXTURES.json'):
        protected.extend([dict(path=fixture['source'],before=fixture['sha256'],after=sha(fixture['source'])),
                          dict(path=fixture['annotation_source'],before=fixture['annotation_sha256'],after=sha(fixture['annotation_source']))])
        assert sha(fixture['copy'])==fixture['sha256']
    for entry in protected:entry['unchanged']=entry['before']==entry['after']
    assert all(entry['unchanged'] for entry in protected)
    workflow=read('REAL_WORKFLOWS.json');assert len(workflow)==6 and all(row['passed'] for row in workflow)
    for row in workflow:assert row['outside_changed_pixels']==0
    native_clean=load_project(ROOT/'outputs/projects/Akuhamu-008-20261027-174012-4f9eec90.mangaclean')
    expected=load_project(next(row['project'] for row in workflow if row['book']=='Akuhamu'))
    assert pixels(native_clean['source'],expected['source'])==0 and pixels(native_clean['clean'],expected['clean'])==0
    a=native_clean['bubbles'][4];b=expected['bubbles'][4]
    assert pixels(a.last_applied_mask,b.last_applied_mask)==0
    native_ocr_path=ROOT/'outputs/projects/Akuhamu-008-20261027-174726-0e2b7f79.mangaclean'
    native_ocr=load_project(native_ocr_path)
    region=native_ocr['region_graph'].text_regions[0]
    assert tuple(region.rect)==(1517,860,43,138) and region.direction=='vertical'
    assert region.provenance['ocr']['status']=='Stale'
    assert region.source_text==region.provenance['ocr']['raw_text']
    source=cv2.imread(str(ROOT/'.cache/realworld-20261028/fixtures/Akuhamu-008.jpg'))
    assert pixels(native_ocr['source'],source)==0 and pixels(native_ocr['clean'],source)==0
    base=ROOT/'outputs/projects/page_009-20261027-082532-24d80ab0.mangaclean'
    fixture_root=ROOT/'.cache/realworld-20261028/projects'
    for name in ['pyside-coexist.mangaclean','tauri-coexist.mangaclean']:assert sha(fixture_root/name)==sha(base)
    pyside_saved=load_project(fixture_root/'pyside-coexist-saved.mangaclean');original=load_project(base)
    assert pixels(pyside_saved['source'],original['source'])==0 and pixels(pyside_saved['clean'],original['clean'])==0
    screenshots=[]
    for image in REPORT.glob('native-*.png'):
        # Native tool captures are JPEG; retain their actual format without re-encoding.
        if image.read_bytes()[:2]==b'\xff\xd8':
            target=image.with_suffix('.jpg')
            assert image.resolve().is_relative_to(REPORT.resolve()) and not target.exists()
            image.rename(target)
    for image in REPORT.glob('native-*.jpg'):
        pixels_image=cv2.imread(str(image));assert pixels_image is not None
        screenshots.append(dict(path=str(image),capture_size=[pixels_image.shape[1],pixels_image.shape[0]],encoding='JPEG from native capture tool'))
    ocr=read('REAL_OCR.json');assert len(ocr)==8 and all(row['job']['status']=='done' for row in ocr)
    normal=ocr[:6]
    summary=dict(passed=True,protected_inputs=protected,scanned_pages=len(read('SCANS.json')),
                 candidates=sum(len(row['state']['document']['bubbles']) for row in read('SCANS.json')),
                 workflow_cases=len(workflow),native_clean_vs_api_different_pixels=0,native_applied_mask_different_pixels=0,
                 native_ocr_project=str(native_ocr_path),native_crop=list(region.rect),native_ocr_status='Stale',
                 native_source_and_working_preserved=True,pyside_saved_copy_pixels_preserved=True,
                 original_project_copies_unchanged=True,screenshots=screenshots,
                 ocr=dict(cases=len(ocr),native_vertical_bubble_cases=len(normal),
                          bubble_edits=sum(row['edits'] for row in normal),bubble_reference_characters=sum(row['reference_characters'] for row in normal),
                          exact_normalized_bubble_cases=sum(row['edits']==0 for row in normal),
                          outside_case=ocr[6],rotated_case=ocr[7]),
                 note='Audits retained outputs only. Does not rerun parity, inference, or legacy regressions.')
    (REPORT/'OUTPUT_AUDIT.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({key:value for key,value in summary.items() if key not in ['ocr','protected_inputs','screenshots']},ensure_ascii=True))


if __name__=='__main__':audit()
