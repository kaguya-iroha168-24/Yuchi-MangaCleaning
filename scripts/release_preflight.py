"""Read-only release inventory. Never builds, installs, or changes shared runtimes."""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT=Path(__file__).resolve().parents[1]
REPORT=ROOT/'.cache'
OGKALU_SHA256='5fe9e4f576e49d4e7e8b0e029d6d3cdc252abd4694113e1cae120e62c931ea79'


def digest(path):
    value=hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b''):value.update(chunk)
    return value.hexdigest()


def main():
    tauri=json.loads((ROOT/'src-tauri/tauri.conf.json').read_text(encoding='utf-8'))
    ocr=json.loads((ROOT/'configs/ocr.json').read_text(encoding='utf-8'))
    detection=json.loads((ROOT/'configs/detection.json').read_text(encoding='utf-8'))
    rust=(ROOT/'src-tauri/src/lib.rs').read_text(encoding='utf-8')
    model=Path(ocr['model_directory']);manifest=json.loads((model/'LOCAL_MANIFEST.json').read_text(encoding='utf-8'))
    models=[]
    for row in manifest['files']:
        after=digest(model/row['name'])
        models.append(dict(path=str(model/row['name']),expected_sha256=row['sha256'],after_sha256=after,unchanged=after==row['sha256']))
    assert all(row['unchanged'] for row in models)
    shima=detection['shima_v1'];after=digest(Path(shima['checkpoint']))
    assert after==shima['checkpoint_sha256']
    models.append(dict(path=shima['checkpoint'],expected_sha256=shima['checkpoint_sha256'],after_sha256=after,unchanged=True))
    ogkalu=ROOT/'models/ogkalu/detector-v4-s_int8.onnx';ogkalu_license=ROOT/'models/ogkalu/LICENSE.txt'
    assert ogkalu.is_file() and ogkalu_license.is_file()
    after=digest(ogkalu)
    assert after==OGKALU_SHA256
    models.append(dict(path=str(ogkalu),expected_sha256=OGKALU_SHA256,after_sha256=after,unchanged=True))
    backend_python=ROOT/'.venv-standalone/Scripts/python.exe'
    probe=subprocess.run([str(backend_python),'-B','-I','-c','import onnxruntime,PIL.Image,sys; sys.path.insert(0,str(r"'+str(ROOT)+'")); from mangaclean.services.ogkalu_text import _session; _session()'],
                         cwd=ROOT,capture_output=True,text=True)
    assert probe.returncode==0,probe.stderr
    preflight=dict(status='Blocked',validation_gate_passed=False,bundle_active=tauri['bundle']['active'],
        development_exe=str(ROOT/'src-tauri/target/debug/yuchi-labs-tauri.exe'),
        development_exe_exists=(ROOT/'src-tauri/target/debug/yuchi-labs-tauri.exe').is_file(),
        bundled_sidecars=tauri['bundle'].get('externalBin',[]),
        backend_python=str(ROOT/'.venv-standalone/Scripts/python.exe'),
        venv_base_configuration=(ROOT/'.venv-standalone/pyvenv.cfg').read_text(encoding='utf-8'),
        inference_python=detection['inference_python'],ocr_python=ocr['python'],protected_model_files=models,
        blockers=[
            dict(component='Validation gate',issue='Exact native1366x768/1920x1080 acceptance and diverse patterned-art cleaning not complete; cold-start timeout recorded.'),
            dict(component='Executable relocation',issue='Rust derives backend root from compile-time CARGO_MANIFEST_DIR.' if 'CARGO_MANIFEST_DIR' in rust else 'Requires relocation test.'),
            dict(component='Python/AI sidecars',issue='Venv uses existing C: CPython; detector/OCR interpreters point to shared E: environments. No bundled independent executable.'),
            dict(component='Model resources',issue='Existing model locations are absolute; manifest/hash verification works, but portable resource configuration and redistribution rights are unverified.'),
            dict(component='Writable data',issue='Caches/outputs currently under development workspace; installed read-only application files need a separate per-user data root.'),
            dict(component='Startup diagnostics',issue='Rust discards backend stdout/stderr; packaged missing DLL/runtime failures need retained local logs and actionable UI errors.'),
            dict(component='Installer acceptance',issue='Bundling disabled; no clean-machine offline, WebView2 prerequisite, missing-model, corrupt-model, multi-instance or forced-exit installer test.')],
        working=['Dynamic authenticated loopback backend','Owned process cleanup tested','Offline local model integrity','Verified project/export copies'],
        changes_performed='Inventory and hash checks only. No training, Git, dependency install, cache removal, installer or model modification.')
    (REPORT/'RELEASE_PREFLIGHT.json').write_text(json.dumps(preflight,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(dict(status=preflight['status'],development_exe_exists=preflight['development_exe_exists'],protected_model_files=len(models),all_model_hashes_unchanged=True,blockers=len(preflight['blockers']))))


if __name__=='__main__':main()
