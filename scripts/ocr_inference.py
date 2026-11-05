"""One offline Manga OCR request in an isolated environment; no UI/model training."""
from pathlib import Path
from time import perf_counter
import sys,json,hashlib,traceback,os


def main(request_path=None):
    request=json.loads(Path(request_path or sys.argv[1]).read_text(encoding='utf-8'));output=Path(request['output'])
    start=perf_counter()
    timings={};phase='startup';phase_start=start
    def stage(name):
        nonlocal phase,phase_start
        now=perf_counter();timings[phase]=now-phase_start;phase=name;phase_start=now
        print('OCR stage: '+name,file=sys.stderr,flush=True)
    try:
        stage('runtime import')
        import torch
        from PIL import Image
        from transformers import ViTImageProcessor,AutoTokenizer,StoppingCriteria
        from manga_ocr.ocr import MangaOcrModel,post_process
        import importlib.metadata
        model_dir=Path(request['model_directory'])
        manifest=json.loads((model_dir/'LOCAL_MANIFEST.json').read_text(encoding='utf-8'))
        stage('model integrity verification')
        for entry in manifest['files']:
            p=model_dir/entry['name']
            with p.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
            if digest!=entry['sha256']:
                raise ValueError('OCR model integrity check failed: '+entry['name'])
        device=request['device']
        if device=='cpu':torch.set_num_threads(min(4,os.cpu_count()or 1))
        def guard():
            if device!='cuda':return None
            free,total=torch.cuda.mem_get_info()
            values=dict(allocated_gib=torch.cuda.memory_allocated()/1024**3,
                reserved_gib=torch.cuda.memory_reserved()/1024**3,peak_reserved_gib=torch.cuda.max_memory_reserved()/1024**3,free_gib=free/1024**3)
            if values['peak_reserved_gib']>request['max_reserved_gib']or values['free_gib']<request['min_free_gib']:
                raise RuntimeError('OCR VRAM safety limit reached. Choose CPU and retry; no automatic GPU retry.')
            return values
        if device=='cuda':
            if not torch.cuda.is_available():raise RuntimeError('CUDA is not available. Choose CPU for OCR.')
            guard()
            total=torch.cuda.get_device_properties(0).total_memory
            torch.cuda.set_per_process_memory_fraction(min(.7,request['max_reserved_gib']*1024**3/total))
        stage('model loading')
        processor=ViTImageProcessor.from_pretrained(model_dir,local_files_only=True)
        tokenizer=AutoTokenizer.from_pretrained(model_dir,tokenizer_type='bert-japanese',local_files_only=True,trust_remote_code=False)
        model=MangaOcrModel.from_pretrained(model_dir,local_files_only=True).eval().to(device)
        memory=guard()
        stage('preprocessing')
        with Image.open(request['input'])as source:image=source.convert('L').convert('RGB')
        warnings=['Model confidence is unavailable; human review is required.',
                  'Inspect small, rotated or mixed text; OCR can invent text on ambiguous crops.']
        if min(image.size)<24:warnings.append('Small text crop; recognition may be unreliable.')
        x=processor(image,return_tensors='pt').pixel_values.to(device)
        infer_start=perf_counter()
        class MemoryBudget(StoppingCriteria):
            def __call__(self,input_ids,scores,**kwargs):
                guard()
                return False
        stage('recognition')
        with torch.inference_mode():tokens=model.generate(x,max_length=300,do_sample=False,stopping_criteria=[MemoryBudget()])
        memory=guard()
        if not torch.isfinite(x).all():raise RuntimeError('Non-finite OCR input.')
        stage('postprocessing')
        decoded=tokenizer.decode(tokens[0],skip_special_tokens=True);text=post_process(decoded)
        if tokens.shape[-1]>=300:warnings.append('Generation reached the token limit; inspect possible truncation.')
        if not text:warnings.append('OCR returned empty text. Keep manual transcription.')
        stage('complete')
        result=dict(text=text,decoded_text=decoded,confidence=None,provider='manga_ocr',language='ja',model_id=manifest['repo'],
            model_revision=manifest['revision'],model_sha256=next(v['sha256']for v in manifest['files']if v['name']=='pytorch_model.bin'),
            package_version=importlib.metadata.version('manga-ocr'),transformers_version=importlib.metadata.version('transformers'),
            torch_version=torch.__version__,device=device,duration_s=perf_counter()-start,inference_s=perf_counter()-infer_start,
            crop_size=list(image.size),normalization='manga_ocr.post_process',warnings=warnings,GPU=memory,timings_s=timings)
        payload=dict(ok=True,result=result)
    except Exception as error:payload=dict(ok=False,error=str(error),traceback=traceback.format_exc())
    temp=output.with_suffix('.tmp');temp.write_text(json.dumps(payload,ensure_ascii=False),encoding='utf-8');temp.replace(output)


if __name__=='__main__':
    if '--serve' in sys.argv:
        import gc
        for request_path in sys.stdin:
            if request_path.strip():
                main(request_path.strip());gc.collect()
                torch=sys.modules.get('torch')
                if torch is not None and torch.cuda.is_initialized():torch.cuda.empty_cache()
    else:main()
