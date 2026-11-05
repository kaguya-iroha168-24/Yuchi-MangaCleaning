"""Machine-local detector preferences and device policy; no Torch in the GUI."""
from hashlib import sha256
from pathlib import Path
import json,os,platform,tempfile

MODES=('auto','cpu','gpu')


def settings_path():
    root=Path(os.environ.get('YUCHI_LABS_SETTINGS_DIR',str(Path(__file__).resolve().parents[2]/'.cache/settings')))
    machine=sha256(platform.node().casefold().encode()).hexdigest()[:16]
    return root/f'detection-device-{machine}.json'


def load_mode():
    try:
        mode=json.loads(settings_path().read_text(encoding='utf-8'))['shima_mode']
        return mode if mode in MODES else 'auto'
    except (OSError,ValueError,KeyError,TypeError):return 'auto'


def save_mode(mode):
    if mode not in MODES:raise ValueError('Unknown detector performance mode.')
    target=settings_path();target.parent.mkdir(parents=True,exist_ok=True)
    fd,name=tempfile.mkstemp(dir=target.parent,prefix='.device-',suffix='.tmp');os.close(fd)
    try:
        Path(name).write_text(json.dumps({'version':1,'shima_mode':mode}),encoding='utf-8')
        os.replace(name,target)
    finally:
        if Path(name).exists():Path(name).unlink()


def resolve_device(mode,hardware):
    if mode not in MODES:raise ValueError('Unknown detector performance mode.')
    if mode=='cpu':return 'cpu'
    if hardware is None:raise ValueError('CUDA compatibility is still being checked. Choose CPU or wait.')
    if not hardware.get('cpu_available',True):raise ValueError('Shima runtime is unavailable; choose OpenCV or repair the runtime.')
    available=hardware.get('gpu_available')is True
    if mode=='gpu'and not available:raise ValueError('GPU unavailable — CPU only. CUDA did not pass the runtime/model check.')
    return 'cuda:0'if available else 'cpu'


def probe_runtime(config):
    from .yuchi_process import YuchiProcess
    try:return YuchiProcess(config).probe()
    except Exception as error:
        message=str(error)
        unusable=any(token in message for token in('Inference Python is missing','checkpoint is missing',"No module named 'torch'"))
        return dict(gpu_available=False,cpu_available=not unusable,device_name='CPU',reason=message.splitlines()[0][:400])
