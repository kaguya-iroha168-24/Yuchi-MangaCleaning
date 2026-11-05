"""Capture a visible isolated PySide6 snapshot, never the old checkout in place."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
OLD=Path(r'E:\BagassZx\Yuchi Labs')
SNAPSHOT=ROOT/'.cache/shima-parity/baseline'
REPORT=Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity')
PROJECT=ROOT/'outputs/projects/page_009-20261027-082532-24d80ab0.mangaclean'


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def child():
    sys.path.insert(0,str(SNAPSHOT))
    import cv2,numpy as np,PySide6
    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QTransform
    from mangaclean.ui.main_window import MainWindow
    from mangaclean.ui.theme import apply_theme
    from mangaclean.services.project_io import load_project
    app=QApplication([])
    app.setApplicationName('Yuchi Isolated Baseline Parity')
    app.setOrganizationName('YuchiParitySnapshot')
    apply_theme(app)
    window=MainWindow()
    window.setWindowTitle('Yuchi Labs PySide6 — isolated baseline snapshot')
    # Reuse hardware evidence already measured with the approved baseline worker.
    # This comparison opens a real saved project; it does not repeat inference.
    hardware=json.loads((REPORT/'baseline-cuda-0-page_009.json').read_text())['metadata']
    window.apply_hardware_info(dict(gpu_available=True,cpu_available=True,device_name=hardware['device_name'],
                                   model_verified=True,reason='Approved baseline inference already completed in parity audit.'))
    window.detector_selector.setCurrentIndex(window.detector_selector.findData('shima_v1'))
    window.performance_selector.setCurrentIndex(window.performance_selector.findData('cpu'))
    window.set_workspace_mode('studio')
    window.resize(1366,768);window.show()
    window.load_project(str(PROJECT))
    deadline=time.monotonic()+40
    while window.job is not None and time.monotonic()<deadline:
        app.processEvents();time.sleep(.02)
    assert window.job is None and window.document.source is not None,window.status_text.text()
    loaded=load_project(PROJECT)
    assert np.array_equal(window.document.working,loaded['clean'])
    assert np.array_equal(window.document.source,loaded['source'])
    assert len(window.document.bubbles)==11
    window.set_preview('clean');window.set_bubble_overlays(True)
    rows=[]
    for width,height in ((1366,768),(1920,1080)):
        window.resize(width,height)
        for _ in range(12):app.processEvents();time.sleep(.03)
        window.linked_views._busy=True
        for view in (window.original_canvas,window.canvas):
            view._fit=False;view.setTransform(QTransform.fromScale(.25,.25))
            view.navigation_bounds();view.centerOn(1114/2,1600/2);view.zoom_changed.emit(view.zoom)
        window.linked_views._busy=False
        for _ in range(6):app.processEvents();time.sleep(.03)
        screenshot=REPORT/f'baseline-pyside-{width}-zoom25.png'
        assert window.grab().save(str(screenshot))
        rows.append(dict(requested=[width,height],actual=[window.width(),window.height()],
                         scale=window.canvas.transform().m11(),device_pixel_ratio=window.devicePixelRatioF(),screenshot=str(screenshot)))
    report=dict(passed=True,project=str(PROJECT),candidate_count=11,source_and_working_unchanged=True,
                runtime=dict(opencv=cv2.__version__,numpy=np.__version__,pyside=PySide6.__version__),views=rows,
                note='Visible Qt UI copied byte-for-byte into the Tauri workspace; original checkout/environment remain read only. Hardware probing was not repeated; previously measured baseline hardware evidence was supplied to the view.')
    (REPORT/'BASELINE_GUI.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
    window.close()
    for _ in range(20):app.processEvents();time.sleep(.02)
    print(json.dumps(report))


def parent():
    assert SNAPSHOT.resolve().is_relative_to(ROOT.resolve())
    files=list((OLD/'mangaclean/ui').rglob('*.py'))+list((OLD/'mangaclean/services').glob('*.py'))
    files+=list((OLD/'assets/fonts').rglob('*'))+[OLD/'configs/ocr.json']
    manifest=[]
    for source in files:
        if not source.is_file():continue
        target=SNAPSHOT/source.relative_to(OLD)
        target.parent.mkdir(parents=True,exist_ok=True)
        before=digest(source)
        if not target.exists():shutil.copy2(source,target)
        assert digest(target)==before,str(source)
        manifest.append(dict(source=str(source),snapshot=str(target),sha256_before=before))
    cache=SNAPSHOT/'.cache/gui-validation'
    env=os.environ.copy()
    folders={'TEMP':'tmp','TMP':'tmp','APPDATA':'appdata','LOCALAPPDATA':'localappdata',
             'QT_SHADER_CACHE_PATH':'qt-shaders','PYTHONPYCACHEPREFIX':'pycache','YUCHI_LABS_SETTINGS_DIR':'settings'}
    for key,name in folders.items():
        path=cache/name;path.mkdir(parents=True,exist_ok=True);env[key]=str(path)
    env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONPATH='',YUCHI_LABS_DETECTOR='opencv',
               MANGACLEAN_DIAGNOSTICS=str(cache/'diagnostics.jsonl'))
    result=subprocess.run([r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe','-B',str(Path(__file__).resolve()),'child'],
                          cwd=SNAPSHOT,env=env)
    for item in manifest:item['unchanged']=digest(item['source'])==item['sha256_before']
    (REPORT/'BASELINE_GUI_SOURCE_INTEGRITY.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    assert all(item['unchanged'] for item in manifest)
    raise SystemExit(result.returncode)


if __name__=='__main__':
    child() if len(sys.argv)>1 and sys.argv[1]=='child' else parent()
