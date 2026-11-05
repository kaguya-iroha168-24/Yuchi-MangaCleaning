"""Read-only checkpoint inference worker, executed with the existing research Python."""
import contextlib
import hashlib
import json
from pathlib import Path
import sys
from time import perf_counter
import traceback
import os
import base64
import gc

_MODEL = None
_MODEL_KEY = None


def release_model():
    global _MODEL,_MODEL_KEY
    _MODEL=None;_MODEL_KEY=None;gc.collect()
    torch=sys.modules.get('torch')
    try:
        if torch is not None and torch.cuda.is_available():torch.cuda.empty_cache()
    except Exception:pass


def error_kind(error):
    message=str(error).lower()
    if 'outofmemory'in type(error).__name__.lower()or ('cuda'in message and 'out of memory'in message):return 'cuda_oom'
    if 'vram safety'in message:return 'cuda_memory'
    if any(s in message for s in ('cuda','cudnn','cublas','nvidia','no kernel image')):return 'cuda_error'
    return 'inference_error'


def validate_class_names(names, segment):
    valid=(len(names)==1 and 0 in names and
        (names[0].lower()in('balloon','bubble')if segment else'bubble'in names[0].lower()))
    if not valid:raise ValueError(f'Unrecognized model class mapping: {names}')


def gpu_guard(torch, device):
    if device == 'cpu':return {}
    torch.cuda.synchronize(device)
    free,total=torch.cuda.mem_get_info(device)
    values=dict(allocated_gib=torch.cuda.memory_allocated(device)/2**30,
        reserved_gib=torch.cuda.memory_reserved(device)/2**30,
        peak_reserved_gib=torch.cuda.max_memory_reserved(device)/2**30,free_gib=free/2**30)
    if values['peak_reserved_gib']>min(13,total/2**30-1.5)or values['free_gib']<1.5:
        raise RuntimeError('Inference VRAM safety budget exceeded; no automatic retry or resolution change.')
    return values


def segment_native(model,image,request,device):
    """Same FP32 native-logit reconstruction as C05; CPU masks bound GPU use."""
    import cv2,numpy as np,torch
    from ultralytics.data.augment import LetterBox
    from ultralytics.utils import ops,nms
    size=request['image_size'];gpu_guard(torch,device)
    padded=LetterBox((size,size),auto=False,scale_fill=False,scaleup=True,stride=32)(image=image)
    tensor=torch.from_numpy(np.ascontiguousarray(padded[:,:,::-1].transpose(2,0,1))).to(device).float().div_(255).unsqueeze(0)
    with torch.inference_mode():
        raw=model.model(tensor,augment=False)
        gpu_guard(torch,device)
        if isinstance(raw[0],(tuple,list)):prediction,proto=raw[0]
        else:prediction=raw[0];proto=raw[1][-1]if isinstance(raw[1],(tuple,list))else raw[1]
        if not torch.isfinite(prediction).all()or not torch.isfinite(proto).all():
            raise ValueError('Nonfinite segmentation inference output.')
        det=nms.non_max_suppression(prediction.clone(),conf_thres=request['confidence'],iou_thres=request['iou'],classes=[0],
            agnostic=False,multi_label=False,max_det=request['max_detections'],nc=1,max_time_img=3,max_nms=30000,end2end=False)[0]
        boxes=ops.scale_boxes((size,size),det[:,:4].clone(),image.shape).cpu()
        prototypes=proto[0].float().cpu();coefficients=det[:,6:].float().cpu();scores=det[:,4].float().cpu()
        predictions=[]
        for start in range(0,len(boxes),8):
            masks=ops.process_mask_native(prototypes,coefficients[start:start+8],boxes[start:start+8],image.shape[:2]).numpy()>0
            for j,mask in enumerate(masks,start):
                if mask.any():
                    ys,xs=np.where(mask);x,y,w,h=int(xs.min()),int(ys.min()),int(xs.max()-xs.min()+1),int(ys.max()-ys.min()+1)
                    ok,encoded=cv2.imencode('.png',mask[y:y+h,x:x+w].astype(np.uint8)*255)
                    if not ok:raise ValueError('Could not encode native container mask.')
                    payload=base64.b64encode(encoded.tobytes()).decode('ascii')
                else:x=y=w=h=0;payload=''
                predictions.append(dict(xyxy=boxes[j].tolist(),confidence=float(scores[j]),class_id=0,mask_bounds=[x,y,w,h],mask_png=payload))
    return predictions


def sha256(path):
    value = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024*1024), b''):
            value.update(block)
    return value.hexdigest()


def infer(request):
    global _MODEL, _MODEL_KEY
    import cv2
    import numpy as np
    import torch
    import ultralytics
    from ultralytics import YOLO

    checkpoint = Path(request['checkpoint']).resolve(strict=True)
    checksum = sha256(checkpoint)
    if checksum != request['checkpoint_sha256']:
        raise ValueError('Checkpoint hash differs from the configured approved model.')
    image = cv2.imdecode(np.frombuffer(Path(request['input']).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError('Invalid native inference image.')
    device = request['device']
    if device == 'auto':
        device = 'cuda:0' if torch.cuda.is_available() else 'cpu'
    if device in (0,'0','cuda'):device='cuda:0'
    if device not in('cpu','cuda:0'):raise ValueError('Only CPU or NVIDIA CUDA device 0 is supported.')
    cuda = device != 'cpu'
    if not cuda and request.get('task')=='segment':torch.set_num_threads(min(4,os.cpu_count()or 1))
    if cuda:
        if not torch.cuda.is_available():raise RuntimeError('CUDA is unavailable in the selected inference runtime.')
        torch.cuda.set_device(device)
        torch.cuda.init()
        if _MODEL is None:torch.cuda.reset_peak_memory_stats(device)
    started = perf_counter()
    key = (str(checkpoint), checksum, str(device))
    same_weights=_MODEL is not None and _MODEL_KEY[:2]==key[:2]
    device_changed=same_weights and _MODEL_KEY[2]!=key[2]
    cached = same_weights and (_MODEL_KEY==key or request.get('task')=='segment')
    if device_changed and request.get('task')=='segment':
        _MODEL.model.float().to(device).eval();_MODEL_KEY=key
        if device=='cpu'and torch.cuda.is_available():torch.cuda.empty_cache()
    if not cached:
        release_model()
        _MODEL = YOLO(str(checkpoint), task=request.get('task','detect'))
        if request.get('task')=='segment':
            _MODEL.model.float().to(device).eval()
            torch.backends.cudnn.benchmark=False
            torch.backends.cudnn.allow_tf32=False
            torch.backends.cuda.matmul.allow_tf32=False
        _MODEL_KEY = key
    model = _MODEL
    loaded_path = Path(model.ckpt_path).resolve()
    if loaded_path != checkpoint:
        raise ValueError('The loader did not use the approved checkpoint path.')
    architecture = dict(model.model.yaml)
    yaml_name = Path(str(architecture.get('yaml_file', ''))).name.lower()
    explicit_s = (architecture.get('width_multiple') == .5 and architecture.get('depth_multiple') == .33)
    segment=request.get('task')=='segment'
    if segment and (model.task!='segment' or architecture.get('scale')!='n' or type(model.model.model[-1]).__name__!='Segment'):
        raise ValueError('Expected the approved YOLO11n-seg checkpoint.')
    if not segment and not (architecture.get('scale') == 's' or yaml_name == 'yolov8s.yaml' or explicit_s):
        raise ValueError(f'Expected YOLOv8s architecture; loaded YAML {architecture}')
    names = {int(k): str(v) for k, v in model.names.items()}
    validate_class_names(names,segment)
    load_s = perf_counter()-started
    if cuda:
        torch.cuda.synchronize(device)
    started = perf_counter()
    if segment:
        predictions=segment_native(model,image,request,device)
        output_shape=list(image.shape[:2]);speed={}
    else:
        with torch.inference_mode():
            result = model.predict(source=image, device=device, conf=request['confidence'],
                iou=request['iou'], imgsz=request['image_size'], max_det=request['max_detections'],
                classes=[0], save=False, save_txt=False, save_conf=False, save_crop=False,
                show=False, verbose=False, half=False, augment=False)[0]
        if tuple(result.orig_shape) != image.shape[:2]:
            raise ValueError('Detector native image shape does not match its input.')
        output_shape=list(result.orig_shape);speed=result.speed
        predictions = []
        for box, confidence, category in zip(result.boxes.xyxy.cpu().tolist(),
                result.boxes.conf.cpu().tolist(), result.boxes.cls.cpu().tolist()):
            predictions.append(dict(xyxy=box, confidence=confidence, class_id=int(category)))
    if cuda:
        torch.cuda.synchronize(device)
    predict_s = perf_counter()-started
    metadata = dict(provider=request.get('provider','yuchi_v4'), model_name=request.get('model_name','Yuchi Fine-Tuned v4'),
        checkpoint=str(checkpoint), loaded_checkpoint=str(loaded_path), checkpoint_sha256=checksum,
        architecture_scale=architecture.get('scale'), architecture_yaml=architecture.get('yaml_file'),
        architecture_variant='YOLO11n-seg'if segment else'YOLOv8s', width_multiple=architecture.get('width_multiple'),
        depth_multiple=architecture.get('depth_multiple'),
        parameters=sum(p.numel() for p in model.model.parameters()), names=names,
        input_shape=list(image.shape), output_shape=output_shape, device=str(device),
        input_pixels_sha256=hashlib.sha256(image.tobytes()).hexdigest(),
        device_name=torch.cuda.get_device_name(device) if cuda else 'CPU',
        model_reused=cached,device_changed=device_changed,cpu_threads=torch.get_num_threads(),
        load_s=load_s, predict_s=predict_s, framework_speed_ms=speed,
        torch_version=torch.__version__, ultralytics_version=ultralytics.__version__,
        confidence=request['confidence'], iou=request['iou'], image_size=request['image_size'],
        vram_peak_mb=torch.cuda.max_memory_allocated(device)/1024**2 if cuda else None,
        checkpoint_readonly_verified=sha256(checkpoint) == checksum)
    if segment:
        metadata.update(task='segment',precision='FP32',batch=1,rect=False,fuse=False,
            model_provenance=request['model_provenance'],GPU=gpu_guard(torch,device),
            native_mask_processing='process_mask_native: inverse letterbox logits, bilinear upsample before >0 threshold; crop native bbox; no morphology')
    return dict(ok=True, predictions=predictions, metadata=metadata)


def probe_hardware(request):
    import torch,cv2,numpy as np
    hardware=dict(cpu_available=True,gpu_available=False,device_name='CPU',torch_version=torch.__version__,cuda_build=torch.version.cuda)
    try:available=torch.cuda.is_available()
    except Exception as error:
        hardware.update(reason=str(error).splitlines()[0][:400],cuda_failed=True)
        return dict(ok=True,hardware=hardware)
    if not available:
        hardware['reason']='GPU unavailable — CPU only. CUDA is not available in this runtime.'
        return dict(ok=True,hardware=hardware)
    try:
        # Real approved-model forward/NMS/native masks, not an NVIDIA name check.
        path=Path(request['output']).parent/'cuda-probe.png'
        path.write_bytes(cv2.imencode('.png',np.full((request['image_size'],request['image_size'],3),255,np.uint8))[1].tobytes())
        result=infer(dict(request,input=str(path),device='cuda:0'))
        hardware.update(gpu_available=True,device_name=result['metadata']['device_name'],reason='CUDA runtime and Shima model check passed.',
            model_verified=True,checkpoint_sha256=result['metadata']['checkpoint_sha256'],GPU=result['metadata'].get('GPU'),
            probe_load_s=result['metadata']['load_s'],probe_predict_s=result['metadata']['predict_s'])
    except Exception as error:
        hardware.update(cuda_failed=True,reason=str(error).splitlines()[0][:400],error_kind=error_kind(error))
        release_model()
    return dict(ok=True,hardware=hardware)


def handle(path):
    request = json.loads(Path(path).read_text(encoding='utf-8'))
    try:
        # Keep stdout/stderr separate from the structured output file.
        with contextlib.redirect_stdout(sys.stderr):
            result = probe_hardware(request)if request.get('action')=='hardware_probe'else infer(request)
    except Exception as error:
        result = dict(ok=False, error=str(error), traceback=traceback.format_exc(),error_kind=error_kind(error))
        release_model()
    target = Path(request['output'])
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(result, allow_nan=False), encoding='utf-8')
    os.replace(temporary, target)
    return 0 if result['ok'] else 1


def main():
    if sys.argv[1] == '--serve':
        for line in sys.stdin:
            if line.strip():
                handle(json.loads(line))
        return 0
    return handle(sys.argv[1])


if __name__ == '__main__':
    raise SystemExit(main())
