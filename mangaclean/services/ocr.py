"""Modular local OCR boundary. Never imports Torch or downloads a model in the GUI."""
from pathlib import Path
from hashlib import sha256
import json,os,re,subprocess,tempfile,time,unicodedata
import atexit
from contextlib import contextmanager
from threading import RLock,Thread,Timer
from typing import Protocol
from uuid import uuid4

import cv2

ROOT=Path(__file__).resolve().parents[2]
RUNTIME_IDLE_SECONDS=10
_runtime_lock=RLock()
_runtimes={}


class OCRCancelled(RuntimeError):
    pass


class OCRUnavailable(RuntimeError):
    pass


class OCRProvider(Protocol):
    def recognize(self,crop,config,cancel): ...


def ocr_config():
    return json.loads((ROOT/'configs/ocr.json').read_text(encoding='utf-8'))


def crop_region(source,rect):
    if len(rect)!=4 or any(type(v)is not int for v in rect):
        raise ValueError('OCR requires native integer coordinates.')
    x,y,w,h=rect
    if min(x,y)<0 or min(w,h)<2 or x+w>source.shape[1]or y+h>source.shape[0]:
        raise ValueError('OCR region is empty, too small, or outside the native image.')
    return source[y:y+h,x:x+w].copy()


def source_text_digest(text):
    return sha256(text.encode('utf-8')).hexdigest()


def stop_process(process):
    if process.poll()is not None:return
    if os.name=='nt':
        # The Windows venv launcher owns a child interpreter. Stop only this
        # request's owned process tree, never other Python/editor processes.
        subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW,timeout=10)
    else:process.kill()
    process.wait(timeout=10)


class _Runtime:
    """Keep each OCR host alive only for a short burst of requests."""
    def __init__(self,command,key,env,log_path,serve_flag):
        self.key=key;self.log_path=log_path;self.timer=None
        self.log=log_path.open('w',encoding='utf-8')
        try:
            self.process=subprocess.Popen([*command,serve_flag],cwd=ROOT,env=env,stdin=subprocess.PIPE,
                stdout=self.log,stderr=subprocess.STDOUT,text=True,encoding='utf-8',
                creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt'else 0)
        except BaseException:self.log.close();raise
    def close(self,graceful=False):
        if self.timer:self.timer.cancel()
        try:
            if graceful and self.process.poll()is None:
                try:self.process.stdin.close();self.process.wait(timeout=1)
                except (OSError,ValueError,subprocess.TimeoutExpired):pass
            stop_process(self.process)
        finally:
            if self.process.stdin and not self.process.stdin.closed:self.process.stdin.close()
            self.log.close()


def close_ocr(wait=True):
    if not wait:
        Thread(target=close_ocr,daemon=True).start();return
    with _runtime_lock:
        for serve_flag in tuple(_runtimes):
            _runtimes.pop(serve_flag).close()


@contextmanager
def _request_process(command,request,config,env,log_path,serve_flag,script):
    with _runtime_lock:
        key=(tuple(command),config['device'],config.get('model_directory'),script.stat().st_mtime_ns)
        runtime=_runtimes.get(serve_flag)
        fresh=runtime is None or runtime.key!=key or runtime.process.poll()is not None
        if fresh:
            if runtime is not None:_runtimes.pop(serve_flag).close()
            runtime=_Runtime(command,key,env,log_path,serve_flag)
            _runtimes[serve_flag]=runtime
        if runtime.timer:runtime.timer.cancel();runtime.timer=None
        try:
            offset=0 if fresh else runtime.log_path.stat().st_size
            runtime.process.stdin.write(str(request)+'\n');runtime.process.stdin.flush()
            yield runtime.process,runtime.log_path,offset
        except BaseException:
            _runtimes.pop(serve_flag).close();raise
        else:
            def expire():
                with _runtime_lock:
                    if _runtimes.get(serve_flag) is runtime and runtime.timer is timer:
                        _runtimes.pop(serve_flag).close(graceful=True)
            timer=Timer(RUNTIME_IDLE_SECONDS,expire);runtime.timer=timer;timer.daemon=True;timer.start()


atexit.register(close_ocr)


class MangaOCRProvider:
    script=ROOT/'scripts/ocr_inference.py'
    serve_flag='--serve'

    def command(self,config):
        python=Path(config['python']);model=Path(config['model_directory'])
        if not python.is_file():raise OCRUnavailable('OCR environment is missing. Manual transcription is still available.')
        if not(model/'LOCAL_MANIFEST.json').is_file():raise OCRUnavailable('Local Manga OCR model is missing. No automatic download was attempted.')
        return [str(python),'-B',str(self.script)]

    def recognize(self,crop,config,cancel,on_progress=None):
        command=self.command(config)
        if config['device']not in('cpu','cuda'):raise ValueError('Choose CPU or CUDA for OCR.')
        cache=ROOT/'.cache/ocr';cache.mkdir(exist_ok=True,parents=True)
        env=os.environ.copy()
        for key,name in {'TEMP':'tmp','TMP':'tmp','HF_HOME':'huggingface','MPLCONFIGDIR':'mpl','TORCH_HOME':'torch',
            'XDG_CACHE_HOME':'cache','CUDA_CACHE_PATH':'cuda','TRITON_CACHE_DIR':'triton','TORCHINDUCTOR_CACHE_DIR':'inductor'}.items():
            folder=cache/name;folder.mkdir(exist_ok=True);env[key]=str(folder)
        env.update(PYTHONDONTWRITEBYTECODE='1',HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',PYTHONIOENCODING='utf-8',TOKENIZERS_PARALLELISM='false')
        with tempfile.TemporaryDirectory(prefix='request-',dir=cache)as temp:
            folder=Path(temp);image=folder/'crop.png';result=folder/'result.json';request=folder/'request.json'
            ok,encoded=cv2.imencode('.png',crop)
            if not ok:raise ValueError('Could not encode the selected source region.')
            image.write_bytes(encoded.tobytes())
            request.write_text(json.dumps(dict(config,input=str(image),output=str(result))),encoding='utf-8')
            logs=cache/'logs';logs.mkdir(exist_ok=True)
            log_path=logs/(uuid4().hex+'.log')
            with _request_process(command,request,config,env,log_path,self.serve_flag,self.script)as(process,log_path,log_offset):
                end=time.monotonic()+config['timeout_seconds']
                last_stage=None;next_log=0
                while True:
                    if cancel.is_set():raise OCRCancelled('OCR cancelled. Existing source transcription is unchanged.')
                    if time.monotonic()>end:raise OCRUnavailable('OCR timed out during '+(last_stage or 'worker execution; last stage unavailable')+'. Source transcription is unchanged; retry or transcribe manually.')
                    if result.is_file():
                        try:
                            response=json.loads(result.read_text(encoding='utf-8'))
                            break
                        except PermissionError:
                            # Windows can briefly expose the renamed file before it can be opened.
                            pass
                    elif process.poll() is not None:
                        raise OCRUnavailable('OCR worker failed: '+log_path.read_text(encoding='utf-8')[-5000:])
                    if time.monotonic()>=next_log:
                        next_log=time.monotonic()+.3
                        with log_path.open(encoding='utf-8',errors='replace')as log:log.seek(log_offset);lines=log.read().splitlines()
                        stages=[line.removeprefix('OCR stage: ') for line in lines if line.startswith('OCR stage: ')]
                        if stages and stages[-1]!=last_stage:
                            last_stage=stages[-1]
                            if on_progress:on_progress(last_stage)
                    time.sleep(.03)
                if cancel.is_set():raise OCRCancelled('OCR cancelled. Existing source transcription is unchanged.')
                if not response.get('ok'):raise OCRUnavailable(response.get('error','OCR failed.')+'\n'+response.get('traceback',''))
                return dict(response['result'],log_path=str(log_path))


class WindowsOCRProvider(MangaOCRProvider):
    script=ROOT/'scripts/windows_ocr.ps1'
    serve_flag='-Serve'

    def command(self,config):
        if os.name!='nt':raise OCRUnavailable('English Windows OCR is unavailable on this platform.')
        if config['device']!='cpu':raise ValueError('English Windows OCR uses CPU.')
        python=Path(os.environ.get('WINDIR',r'C:\Windows'))/'System32/WindowsPowerShell/v1.0/powershell.exe'
        if not python.is_file():raise OCRUnavailable('Windows OCR host is unavailable. No installation was attempted.')
        return [str(python),'-NoProfile','-NonInteractive','-File',str(self.script)]

    def recognize(self,crop,config,cancel,on_progress=None):
        started=time.monotonic()
        # Scale recognition copies only; page pixels, mask and export resolution stay native.
        scale=max(1,min(3,2000//max(crop.shape[:2])))
        prepared=cv2.resize(crop,None,fx=scale,fy=scale,interpolation=cv2.INTER_CUBIC) if scale>1 else crop
        config=dict(config,timeout_seconds=min(config['timeout_seconds'],30))
        if on_progress:on_progress('preparing English crop; Windows OCR CPU')
        result=super().recognize(prepared,config,cancel,on_progress)
        return dict(result,source_crop_size=[crop.shape[1],crop.shape[0]],recognition_scale=scale,request_duration_s=time.monotonic()-started)


class AutoOCRProvider:
    """Sequential local routing; unknown confidence always requires human review."""
    def recognize(self,crop,config,cancel,on_progress=None):
        started=time.monotonic();light={};error=None
        def progress(_stage):
            if on_progress:on_progress('Recognizing source text offline…')
        if on_progress:on_progress('Preparing automatic text recognition…')
        try:
            light=WindowsOCRProvider().recognize(crop,dict(config,device='cpu'),cancel,progress)
        except OCRUnavailable as failure:
            error=str(failure).splitlines()[0][:500]
        if cancel.is_set():raise OCRCancelled('OCR cancelled before language fallback.')
        # This is a routing heuristic, never a confidence score or an accepted transcription.
        probe=unicodedata.normalize('NFKC',light.get('text',''))
        letters=sum(c.isalpha() for c in probe)
        latin=sum(c.isascii() and c.isalpha() for c in probe)
        readable=bool(re.search(r'[A-Za-z]{3,}',probe)) and latin/max(1,letters)>=.8
        routing=dict(mode='auto',requires_review=True,lightweight_text=light.get('text',''),
                     lightweight_error=error,reason='plausible_latin_proposal' if readable else 'empty_or_ambiguous_lightweight_proposal')
        if readable:result=light
        else:
            remaining=config['timeout_seconds']-(time.monotonic()-started)
            if remaining<=0:raise OCRUnavailable('Automatic OCR timed out before fallback. Source transcription is unchanged.')
            result=MangaOCRProvider().recognize(crop,dict(config,timeout_seconds=remaining),cancel,progress)
        if cancel.is_set():raise OCRCancelled('OCR cancelled. Source transcription is unchanged.')
        return dict(result,routing=routing,request_duration_s=time.monotonic()-started)


PROVIDERS={'manga_ocr':MangaOCRProvider,'windows_ocr':WindowsOCRProvider,'auto':AutoOCRProvider}


def recognize(crop,config,cancel,on_progress=None):
    if cancel.is_set():raise OCRCancelled('OCR cancelled before starting.')
    gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    if int(gray.max())-int(gray.min())<2:
        raise OCRUnavailable('Selected source area is nearly uniform. Adjust the text region or transcribe manually.')
    if config['provider']not in PROVIDERS:raise OCRUnavailable('Unsupported OCR provider. Manual transcription remains available.')
    return PROVIDERS[config['provider']]().recognize(crop,config,cancel,on_progress)
