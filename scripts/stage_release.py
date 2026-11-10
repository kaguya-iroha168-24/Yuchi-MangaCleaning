"""Stage a local Windows release; never installs or changes an existing runtime.

The CPU API runtime is copied. AI worker interpreters/models remain explicit
read-only external prerequisites; this is not a standalone redistributable.
"""
from pathlib import Path
from datetime import datetime
import hashlib
import json
import shutil
import subprocess
import sys
import argparse

ROOT=Path(__file__).resolve().parents[1]
SOURCE=ROOT/'src-tauri/target/release/yuchi-labs-tauri.exe'
OGKALU_MODEL=Path('models/ogkalu/detector-v4-s_int8.onnx')
OGKALU_LICENSE=Path('models/ogkalu/LICENSE.txt')
OGKALU_SHA256='5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79'


def copy_verified(source, destination):
    source, destination = Path(source), Path(destination)
    if destination.is_file() and destination.stat().st_size == source.stat().st_size:
        with source.open('rb') as a, destination.open('rb') as b:
            if hashlib.file_digest(a,'sha256').digest() == hashlib.file_digest(b,'sha256').digest():
                return str(destination)
    return shutil.copy2(source,destination)


def stage(resume=None):
    if not SOURCE.is_file():raise SystemExit('Build the release executable first.')
    target=Path(resume).resolve() if resume else ROOT/'releases'/('local-'+datetime.now().strftime('%Y%m%d-%H%M%S'))
    if target.parent != (ROOT/'releases').resolve():raise SystemExit('Staging must stay inside the releases directory.')
    target.mkdir(parents=True,exist_ok=bool(resume))
    app=target/'runtime/app';python=target/'runtime/python'
    app.mkdir(parents=True,exist_ok=bool(resume));python.mkdir(exist_ok=bool(resume))
    if not (ROOT/OGKALU_MODEL).is_file() or not (ROOT/OGKALU_LICENSE).is_file():
        raise SystemExit('Missing Ogkalu model or license in models/ogkalu.')
    ignore=shutil.ignore_patterns('__pycache__','*.pyc','.cache')
    for name in ['backend','mangaclean','configs','models']:
        shutil.copytree(ROOT/name,app/name,ignore=ignore,dirs_exist_ok=True,copy_function=copy_verified)
    (app/'scripts').mkdir(exist_ok=True)
    for name in ['yuchi_inference.py','ocr_inference.py','typesetting_worker.py','windows_ocr.ps1']:
        shutil.copyfile(ROOT/'scripts'/name,app/'scripts'/name)
    # A venv launcher alone depends on its original CPython installation.
    # Copy the actual matching CPython executable, DLLs and stdlib instead.
    base=Path(sys.base_prefix)
    for path in base.iterdir():
        if path.is_file() and (path.suffix.lower() in {'.exe','.dll'} or path.name.lower().startswith('license')):
            shutil.copyfile(path,python/path.name)
    shutil.copytree(base/'DLLs',python/'DLLs',ignore=ignore,dirs_exist_ok=True,copy_function=copy_verified)
    shutil.copytree(base/'Lib',python/'Lib',ignore=shutil.ignore_patterns('site-packages','__pycache__','*.pyc','test','tests','idlelib','tkinter','turtledemo','ensurepip'),dirs_exist_ok=True,copy_function=copy_verified)
    shutil.copytree(Path(sys.prefix)/'Lib/site-packages',python/'Lib/site-packages',ignore=ignore,dirs_exist_ok=True,copy_function=copy_verified)
    shutil.copyfile(SOURCE,target/'MangaClean.exe')
    for name in ['README.md','THIRD_PARTY_SOURCE.md']:
        shutil.copyfile(ROOT/name,app/name)
    detection=json.loads((app/'configs/detection.json').read_text())
    ocr=json.loads((app/'configs/ocr.json').read_text())
    external={'detector_python':detection['inference_python'],'shima_checkpoint':detection['shima_v1']['checkpoint'],
              'ocr_and_renderer_python':ocr['python'],'japanese_model':ocr['model_directory']}
    for path in external.values():
        if not Path(path).exists():raise SystemExit('Missing local prerequisite: '+path)
    if not (app/OGKALU_MODEL).is_file() or not (app/OGKALU_LICENSE).is_file():
        raise SystemExit('Staged Ogkalu model or Apache-2.0 license is missing.')
    with (app/OGKALU_MODEL).open('rb') as stream:
        if hashlib.file_digest(stream,'sha256').hexdigest()!=OGKALU_SHA256:
            raise SystemExit('Staged Ogkalu model checksum mismatch.')
    result=subprocess.run([str(python/'python.exe'),'-B','-I','-c','import fastapi,cv2,numpy,pydantic,onnxruntime,PIL.Image,sys; sys.path.insert(0,"runtime/app"); from mangaclean.services.ogkalu_text import _session; _session(); print(sys.prefix)'],
                          cwd=target,capture_output=True,text=True,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:raise SystemExit(result.stderr)
    if Path(result.stdout.strip()).resolve()!=python.resolve():raise SystemExit('Staged Python did not resolve its own prefix.')
    files=[]
    for path in target.rglob('*'):
        if path.is_file():
            with path.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
            files.append(dict(path=path.relative_to(target).as_posix(),bytes=path.stat().st_size,sha256=digest))
    manifest=dict(mode='LOCAL_RELEASE_WITH_EXTERNAL_AI',standalone=False,installer=False,executable='MangaClean.exe',
                  backend='runtime/app',python='runtime/python/python.exe',externalReadOnlyPrerequisites=external,
                  files=files,totalBytes=sum(f['bytes'] for f in files),pythonPrefixProbePassed=True,
                  note='No build tools, Vite or source workspace required at launch. Existing external AI interpreters/models still required. Not cleared for redistribution.')
    (target/'RELEASE_MANIFEST.json').write_text(json.dumps(manifest,indent=2))
    (target/'READ-ME-FIRST.txt').write_text('MangaClean LOCAL RELEASE\nDouble-click MangaClean.exe. Keep runtime beside it.\nNo terminal/build/dev server is needed at launch.\nAI model/interpreter locations in RELEASE_MANIFEST.json must remain available.\nThis is a local-machine release, NOT a standalone installer for another PC.\nNo system installation or environment modification was performed.\n',encoding='utf-8')
    (ROOT/'.cache/latest-release.json').write_text(json.dumps(dict(directory=str(target),executable=str(target/'MangaClean.exe'),bytes=manifest['totalBytes']),indent=2))
    print(json.dumps(dict(directory=str(target),bytes=manifest['totalBytes'],standalone=False)))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--resume')
    stage(parser.parse_args().resume)
