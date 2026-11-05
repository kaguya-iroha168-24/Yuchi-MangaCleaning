"""Audit retained parity artifacts without repeating inference or modifying inputs."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import subprocess
import sys

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration')
PARITY = REPORT / 'shima-parity'
sys.path.insert(0, str(ROOT))
from mangaclean.services.project_io import load_project


def read(name):
    return json.loads((PARITY / name).read_text(encoding='utf-8'))


def digest(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def difference(a, b):
    assert a.shape == b.shape
    return int(np.count_nonzero(np.any(a != b, axis=2) if a.ndim == 3 else a != b))


def main():
    subprocess.run([sys.executable, '-B', str(ROOT / 'scripts/check_source_integrity.py')], check=True)
    manifests = []
    for name, key in [('SOURCE_SNAPSHOT.json', 'sha256'),
                      ('BASELINE_GUI_SOURCE_INTEGRITY.json', 'sha256_before')]:
        for entry in read(name):
            after = digest(entry['source'])
            manifests.append(dict(path=entry['source'], before=entry[key], after=after,
                                  unchanged=after == entry[key]))
    config = json.loads((ROOT / 'configs/ocr.json').read_text())
    model = Path(config['model_directory'])
    for entry in json.loads((model / 'LOCAL_MANIFEST.json').read_text())['files']:
        after = digest(model / entry['name'])
        manifests.append(dict(path=str(model / entry['name']), before=entry['sha256'], after=after,
                              unchanged=after == entry['sha256']))
    assert all(entry['unchanged'] for entry in manifests)

    probe = subprocess.run([r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe', '-B', '-c',
                            'import cv2,numpy,sys,json;print(json.dumps(dict(python=sys.executable,opencv=cv2.__version__,numpy=numpy.__version__)))'],
                           check=True, capture_output=True, text=True)
    runtime = dict(baseline=json.loads(probe.stdout),
                   tauri=dict(python=sys.executable, opencv=cv2.__version__, numpy=np.__version__))
    detection = read('DETECTION_PARITY_ACTUAL_RUNTIME.json')
    assert detection['all_passed'] and detection['source_unchanged']
    cleaning = {}
    for name in ['CLEANING_PARITY-ACTUAL.json', 'CLEANING_PARITY-CPU-ACTUAL.json']:
        entry = read(name)
        assert entry['passed'] and all(row['different_pixels'] == 0 for row in entry['differences'])
        assert all(method['outside_changed_pixels'] == 0 for row in entry['cases'] for method in row['methods'])
        cleaning[name] = dict(candidates=entry['candidates'], masks=entry['nonempty_masks'],
                              artifacts=len(entry['differences']), max_different_pixels=0)

    project = ROOT / 'outputs/projects/page_009-20261027-082532-24d80ab0.mangaclean'
    document = load_project(project)
    source = cv2.imread(str(ROOT / '.cache/shima-parity/fixtures/page_009.png'))
    expected = cv2.imread(str(PARITY / 'baseline-clean-cpu-actual/0-0.png'))
    expected_mask = cv2.imread(str(PARITY / 'baseline-clean-cpu-actual/0-mask.png'), 0)
    applied_mask = np.zeros(source.shape[:2], np.uint8)
    for bubble in document['bubbles']:
        if bubble.last_applied_mask is not None:
            x, y, w, h = bubble.rect
            applied_mask[y:y+h, x:x+w] |= bubble.last_applied_mask
    exported = cv2.imread(str(ROOT / 'outputs/exports/page_009-20261027-082555-04bbce6b.png'))
    native = dict(project=str(project), candidates=len(document['bubbles']),
                  source_different_pixels=difference(source, document['source']),
                  clean_vs_actual_baseline_different_pixels=difference(expected, document['clean']),
                  applied_mask_different_pixels=difference(expected_mask, applied_mask),
                  png_different_pixels=difference(exported, document['clean']),
                  mask_pixels=int(np.count_nonzero(applied_mask)),
                  pending_mask_pixels=int(np.count_nonzero(document['mask'])),
                  changed_pixels=difference(source, document['clean']),
                  outside_mask_changed_pixels=int(np.count_nonzero(np.any(source != document['clean'], axis=2) & (applied_mask == 0))))
    assert native['candidates'] == 11 and native['mask_pixels'] == 8953
    assert all(value == 0 for key, value in native.items() if 'different_pixels' in key or key == 'outside_mask_changed_pixels')
    ocr = {device: read(f'OCR-{device}.json') for device in ['cpu', 'cuda']}
    assert all(entry['passed'] and entry['exact_synthetic_text'] for entry in ocr.values())
    assert read('CPU_FALLBACK_REAL.json')['passed'] and read('GUI_WORKFLOW.json')['passed']
    report = dict(passed=True, runtime=runtime, detector_pairs=len(detection['cases']),
                  cleaning=cleaning, native=native, protected_files=manifests,
                  protected_files_unchanged=True, baseline_gui=read('BASELINE_GUI.json'),
                  scope='Retained actual inference and GUI artifacts; no inference, training, or baseline mutation performed by this audit.')
    destination = PARITY / 'FINAL_EVIDENCE_AUDIT.json'
    destination.write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(dict(passed=True, detector_pairs=len(detection['cases']), runtime=runtime,
                          cleaning=cleaning, native=native, protected_files=len(manifests))))


if __name__ == '__main__':
    main()
