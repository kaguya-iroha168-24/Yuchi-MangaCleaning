"""Bounded Pillow worker bridge. The lightweight backend never imports Pillow/Torch."""
from collections import OrderedDict
from dataclasses import asdict
from hashlib import sha256
from pathlib import Path
from queue import Queue, Empty
from threading import RLock, Thread
import atexit
import base64
import json
import math
import os
import subprocess

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
_lock = RLock()
_session = None
_cache = OrderedDict()
_cache_bytes = 0


def renderer_stamp():
    return tuple((ROOT/path).stat().st_mtime_ns for path in ('mangaclean/services/typesetting_render.py', 'mangaclean/services/font_catalog.py', 'scripts/typesetting_worker.py'))


class TypesettingUnavailable(RuntimeError):
    pass


class Session:
    def __init__(self):
        self.stamp = renderer_stamp()
        config = json.loads((ROOT/'configs/ocr.json').read_text(encoding='utf-8'))
        python = Path(config['python'])
        if not python.is_file():
            raise TypesettingUnavailable('Existing Pillow runtime is unavailable. No installation was attempted.')
        cache = ROOT/'.cache/typesetting'
        cache.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        for key, name in {'TEMP': 'tmp', 'TMP': 'tmp', 'XDG_CACHE_HOME': 'cache', 'MPLCONFIGDIR': 'mpl'}.items():
            folder = cache/name; folder.mkdir(exist_ok=True); env[key] = str(folder)
        env.update(PYTHONDONTWRITEBYTECODE='1', PYTHONPATH='', PYTHONIOENCODING='utf-8', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
        self.log = (cache/'worker.log').open('a', encoding='utf-8')
        self.process = subprocess.Popen([str(python), '-B', '-u', str(ROOT/'scripts/typesetting_worker.py')],
            cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log,
            text=True, encoding='utf-8', creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        self.responses = Queue(maxsize=2)
        def read():
            try:
                for line in self.process.stdout:
                    self.responses.put(json.loads(line))
            except Exception as error:
                self.responses.put({'ok': False, 'error': str(error)})
            finally:
                self.responses.put({'ok': False, 'error': 'Typesetting worker exited.'})
        self.reader = Thread(target=read, daemon=True)
        self.reader.start()

    def call(self, payload):
        if self.process.poll() is not None:
            raise TypesettingUnavailable('Typesetting worker is no longer running.')
        self.process.stdin.write(json.dumps(payload, allow_nan=False)+'\n')
        self.process.stdin.flush()
        try:
            response = self.responses.get(timeout=30)
        except Empty as error:
            raise TypesettingUnavailable('Typesetting timed out; source artwork is unchanged.') from error
        if not response['ok']:
            raise TypesettingUnavailable(response.get('error', 'Typesetting failed.'))
        return response['result']

    def close(self):
        if self.process.poll() is None:
            try: self.process.stdin.close()
            except (OSError, ValueError): pass
            try: self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(self.process.pid), '/T', '/F'], capture_output=True,
                        creationflags=subprocess.CREATE_NO_WINDOW, timeout=10)
                else: self.process.kill()
                self.process.wait(timeout=5)
        if not self.process.stdin.closed: self.process.stdin.close()
        self.reader.join(timeout=1)
        self.process.stdout.close()
        self.log.close()


def close_typesetter(wait=True):
    if not wait:
        Thread(target=close_typesetter, daemon=True).start()
        return
    global _session
    with _lock:
        if _session is not None:
            _session.close(); _session = None
        clear_render_cache()


def clear_render_cache():
    global _cache_bytes
    with _lock:
        _cache.clear(); _cache_bytes = 0


atexit.register(close_typesetter)


def call(payload):
    global _session
    with _lock:
        try:
            if _session is None or _session.process.poll() is not None or _session.stamp != renderer_stamp():
                if _session is not None: _session.close()
                clear_render_cache()
                _session = Session()
            return _session.call(payload)
        except (OSError, ValueError, TypesettingUnavailable) as error:
            if _session is not None: _session.close(); _session = None
            raise TypesettingUnavailable(str(error)) from error


def available_fonts():
    return call({'action': 'fonts'})


def render_dialogue(dialogue, bubbles):
    global _cache_bytes
    values = {key: value for key, value in asdict(dialogue).items() if key not in ('id', 'source_region_id', 'bubble_id', 'x', 'y')}
    width, height = math.ceil(dialogue.width), math.ceil(dialogue.height)
    if width*height > 24_000_000:
        raise ValueError('Typography layer exceeds the native image pixel budget.')
    clip = None
    bubble = next((b for b in bubbles if b.id == dialogue.bubble_id), None)
    if bubble is not None and dialogue.auto_fit:
        x, y = math.floor(dialogue.x), math.floor(dialogue.y)
        bx, by, bw, bh = bubble.rect
        mask = np.zeros((height, width), np.uint8)
        left, top, right, bottom = max(x, bx), max(y, by), min(x+width, bx+bw), min(y+height, by+bh)
        if left < right and top < bottom:
            mask[top-y:bottom-y, left-x:right-x] = bubble.interior[top-by:bottom-by, left-bx:right-bx]
        ok, encoded = cv2.imencode('.png', mask)
        if not ok: raise ValueError('Could not encode the safe typography interior.')
        clip = base64.b64encode(encoded).decode('ascii')
    payload = {'dialogue': values, 'clip': clip}
    key = sha256((str(renderer_stamp())+json.dumps(payload, sort_keys=True, allow_nan=False)).encode()).hexdigest()
    with _lock:
        if key in _cache:
            _cache.move_to_end(key)
            return dict(_cache[key], cacheHit=True)
        result = call(payload)
        size = len(result['png'])
        if size <= 16_000_000:
            _cache[key] = result; _cache_bytes += size
            while len(_cache) > 64 or _cache_bytes > 16_000_000:
                _, removed = _cache.popitem(last=False); _cache_bytes -= len(removed['png'])
        return dict(result, cacheHit=False)


def composite(working, dialogues, bubbles):
    result = working.copy()
    for dialogue in dialogues:
        if not dialogue.visible or not dialogue.text.strip(): continue
        layer = render_dialogue(dialogue, bubbles)
        rgba = cv2.imdecode(np.frombuffer(base64.b64decode(layer['png']), np.uint8), cv2.IMREAD_UNCHANGED)
        x, y = math.floor(dialogue.x), math.floor(dialogue.y)
        h, w = rgba.shape[:2]
        left, top, right, bottom = max(0, x), max(0, y), min(result.shape[1], x+w), min(result.shape[0], y+h)
        if left >= right or top >= bottom: continue
        local = rgba[top-y:bottom-y, left-x:right-x].astype(np.uint16)
        target = result[top:bottom, left:right].astype(np.uint16)
        alpha = local[:, :, 3:4]
        result[top:bottom, left:right] = ((local[:, :, :3]*alpha + target*(255-alpha)+127)//255).astype(np.uint8)
    return result
