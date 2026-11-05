"""Launch an unmodified original-app copy with all writable paths separated."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OLD = Path(r'E:\BagassZx\Yuchi Labs')
WORK = ROOT / '.cache/realworld-20261028/pyside-original-copy'
REPORT = Path(r'E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\realworld-20261028')


def digest(path): return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    WORK.mkdir(parents=True, exist_ok=True)
    files = [OLD/'main.py']
    for folder in ['mangaclean', 'assets', 'configs', 'scripts']:
        files.extend(p for p in (OLD/folder).rglob('*') if p.is_file() and '__pycache__' not in p.parts
                     and p.suffix.lower() in ['.py', '.json', '.svg', '.ttf', '.otf', '.txt', '.md', '.png', '.ico'])
    files.extend(p for p in OLD.glob('*') if p.is_file() and ('license' in p.name.lower() or 'notice' in p.name.lower()))
    manifest=[]
    for source in files:
        target=WORK/source.relative_to(OLD);target.parent.mkdir(parents=True,exist_ok=True)
        before=digest(source)
        if not target.exists(): shutil.copy2(source,target)
        assert digest(target)==before,str(source)
        manifest.append(dict(source=str(source),copy=str(target),before_sha256=before))
    env=os.environ.copy()
    for key,name in dict(TEMP='tmp',TMP='tmp',APPDATA='appdata',LOCALAPPDATA='localappdata',
                         QT_SHADER_CACHE_PATH='qt',YUCHI_LABS_SETTINGS_DIR='settings',
                         PYTHONPYCACHEPREFIX='pycache').items():
        path=WORK/'.cache'/name;path.mkdir(parents=True,exist_ok=True);env[key]=str(path)
    env.update(PYTHONDONTWRITEBYTECODE='1',PYTHONPATH='',
               MANGACLEAN_DIAGNOSTICS=str(WORK/'.cache/diagnostics.jsonl'))
    log=(REPORT/'pyside-native.log').open('w',encoding='utf-8')
    process=subprocess.Popen([r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe','-B',str(WORK/'main.py')],
                             cwd=WORK,env=env,stdout=log,stderr=subprocess.STDOUT,
                             creationflags=subprocess.CREATE_NO_WINDOW)
    (REPORT/'PYSIDE_LAUNCH.json').write_text(json.dumps(dict(pid=process.pid,root=str(WORK),
             interpreter=r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe',
             original_entrypoint_sha256=digest(OLD/'main.py'),
             note='Unmodified main.py and app modules, copied for testing; no widget/method mocking.',
             writable_environment={key:env[key] for key in ['TEMP','APPDATA','LOCALAPPDATA','YUCHI_LABS_SETTINGS_DIR']}),indent=2))
    print(json.dumps(dict(pyside_pid=process.pid,source_copy=str(WORK))),flush=True)
    try: code=process.wait()
    finally:
        log.close()
        for entry in manifest:
            entry['after_sha256']=digest(Path(entry['source']))
            entry['unchanged']=entry['before_sha256']==entry['after_sha256']
        (REPORT/'PYSIDE_SOURCE_INTEGRITY.json').write_text(json.dumps(manifest,indent=2))
        assert all(entry['unchanged'] for entry in manifest)
    raise SystemExit(code)


if __name__=='__main__': main()
