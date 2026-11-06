"""Isolated local YOLO inference. This module never imports Torch/Ultralytics."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
from time import perf_counter, sleep
import atexit
import threading
from uuid import uuid4

import cv2

ROOT = Path(__file__).resolve().parents[2]


class DetectorUnavailable(RuntimeError):
    pass


_session = None
_lock = threading.Lock()
DETECTOR_IDLE_SECONDS = 60


def session_key(config):
    # Each request carries its own confidence. Reuse the same isolated model
    # process when only the optional proposal threshold changes.
    ignored={'confidence','device'}if config.get('provider')=='shima_v1'else{'confidence'}
    return json.dumps({k:v for k,v in config.items() if k not in ignored},sort_keys=True)


class InferenceSession:
    def __init__(self, config):
        self.key = session_key(config)
        self.idle_timer = None
        logs = ROOT/'.cache/inference'
        logs.mkdir(parents=True, exist_ok=True)
        self.log_path = logs/f'worker-{uuid4().hex}.log'
        self.log = self.log_path.open('w', encoding='utf-8')
        self.process = subprocess.Popen([config['inference_python'], '-B', '-u', str(ROOT/'scripts/yuchi_inference.py'),
            '--serve'], cwd=ROOT, env=process_environment(), stdin=subprocess.PIPE,
            stdout=self.log, stderr=subprocess.STDOUT, text=True, encoding='utf-8',
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def close(self):
        if self.idle_timer:
            self.idle_timer.cancel()
            self.idle_timer = None
        if self.process.poll() is None:
            try:self.process.stdin.close()
            except OSError:pass
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                if os.name=='nt':
                    subprocess.run(['taskkill','/PID',str(self.process.pid),'/T','/F'],capture_output=True,
                        creationflags=subprocess.CREATE_NO_WINDOW,timeout=10)
                else:self.process.kill()
                self.process.wait()
        self.log.close()


def close_detector(wait=True):
    if not wait:
        threading.Thread(target=close_detector, daemon=True).start()
        return
    global _session
    with _lock:
        if _session is not None:
            _session.close()
            _session = None


atexit.register(close_detector)


def read_response(path, deadline):
    """Windows may briefly deny a newly renamed file while antivirus inspects it."""
    while True:
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except (PermissionError, FileNotFoundError):
            if perf_counter() >= deadline:
                raise DetectorUnavailable('Timed out reading the local inference response.')
            sleep(.025)


def detection_config(provider=None):
    config = json.loads((ROOT/'configs/detection.json').read_text(encoding='utf-8'))
    shima = config.pop('shima_v1', {})
    provider = provider or config['default_provider']
    config.update(provider='yuchi_v4', model_name='Yuchi Fine-Tuned v4', task='detect')
    if provider == 'shima_v1':
        config.update(shima)
    return config


def process_environment(root=ROOT):
    env = os.environ.copy()
    cache = root/'.cache'
    paths = {'TEMP': cache/'tmp', 'TMP': cache/'tmp',
        'PYTHONPYCACHEPREFIX': cache/'inference-pycache', 'YOLO_CONFIG_DIR': cache/'ultralytics',
        'TORCH_HOME': cache/'torch', 'CUDA_CACHE_PATH': cache/'cuda', 'MPLCONFIGDIR': cache/'matplotlib'}
    for key, value in paths.items():
        value.mkdir(parents=True, exist_ok=True)
        env[key] = str(value)
    env.update(PYTHONPATH='', PYTHONIOENCODING='utf-8', YOLO_OFFLINE='true',
               YOLO_AUTOINSTALL='false', YOLO_VERBOSE='false')
    return env


class YuchiProcess:
    def __init__(self, config=None):
        self.config = dict(detection_config() if config is None else config)

    def predict(self, image):
        result=self._request(image)
        return result

    def probe(self):
        return self._request(action='hardware_probe')['hardware']

    def _request(self,image=None,action='infer'):
        config = self.config
        python = Path(config['inference_python'])
        checkpoint = Path(config['checkpoint'])
        if not python.is_file():
            raise DetectorUnavailable(f'Inference Python is missing: {python}')
        if not checkpoint.is_file():
            raise DetectorUnavailable(f'Detector checkpoint is missing: {checkpoint}')
        cache = ROOT/'.cache/inference'
        cache.mkdir(parents=True, exist_ok=True)
        started = perf_counter()
        with tempfile.TemporaryDirectory(prefix='scan-', dir=cache) as temp:
            folder = Path(temp)
            if image is not None:
                ok, encoded = cv2.imencode('.png', image)
                if not ok:
                    raise DetectorUnavailable('Could not encode the native image for inference.')
                (folder/'input.png').write_bytes(encoded.tobytes())
            request = dict(config, input=str(folder/'input.png'), output=str(folder/'result.json'),action=action)
            (folder/'request.json').write_text(json.dumps(request), encoding='utf-8')
            result_path = folder/'result.json'
            global _session
            with _lock:
                try:
                    key = session_key(config)
                    if _session is None or _session.key != key or _session.process.poll() is not None:
                        if _session is not None:
                            _session.close()
                        _session = InferenceSession(config)
                    session = _session
                    if session.idle_timer:
                        session.idle_timer.cancel()
                        session.idle_timer = None
                    session.process.stdin.write(json.dumps(str(folder/'request.json'))+'\n')
                    session.process.stdin.flush()
                    deadline = perf_counter()+(min(45,config['timeout_seconds'])if action=='hardware_probe'else config['timeout_seconds'])
                    while not result_path.exists():
                        if session.process.poll() is not None:
                            raise DetectorUnavailable('Inference process stopped. '+session.log_path.read_text(encoding='utf-8')[-8000:])
                        if perf_counter() >= deadline:
                            session.close()
                            _session = None
                            raise DetectorUnavailable('Detector inference timed out; choose OpenCV or retry.')
                        sleep(.025)
                    result = read_response(result_path, deadline)
                    if not result.get('ok')or (action=='hardware_probe'and result.get('hardware',{}).get('cuda_failed')):
                        session.close();_session=None
                    else:
                        def expire():
                            global _session
                            with _lock:
                                if _session is session and session.idle_timer is timer:
                                    session.close();_session=None
                        timer=threading.Timer(DETECTOR_IDLE_SECONDS,expire)
                        session.idle_timer=timer;timer.daemon=True
                        try:timer.start()
                        except RuntimeError:
                            # Housekeeping must not discard a completed prediction.
                            session.close();_session=None
                except OSError as error:
                    if _session is not None:
                        _session.close();_session=None
                    raise DetectorUnavailable(f'Detector process could not finish: {error}') from error
                except Exception:
                    if _session is not None:
                        _session.close();_session=None
                    raise
            if not result.get('ok'):
                details = result.get('traceback', '')
                kind=result.get('error_kind','inference_error')
                raise DetectorUnavailable(f"{kind.upper()}: Detector inference failed: {result.get('error', 'child process failed')}\n{details}")
            if 'metadata'in result:result['metadata']['total_process_s'] = perf_counter()-started
            if 'hardware'in result:result['hardware']['probe_total_s']=perf_counter()-started
            return result
