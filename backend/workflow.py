"""One bounded Scan & Detect queue. Detection, OCR and cleaning stay distinct."""
from copy import deepcopy
from hashlib import sha256
from types import SimpleNamespace
from typing import Literal
from uuid import uuid4
import json
import threading
from fastapi import HTTPException, Request
from pydantic import BaseModel, Field
from backend.automatic_processing import clean_page
from mangaclean.services.text_regions import locate_text, merge_text_candidates


class ScanRequest(BaseModel):
    provider: str='shima_v1'
    device: str='auto'
    ids: list[str]=Field(default_factory=list,max_length=200)
    retry_ocr: bool=False
    automatic_clean: bool=False
    detect_only: bool=False
    skip_ocr: bool=False
    output_mode: Literal['clean', 'overlay']='clean'


def bubble_text_rect(bubble):
    x,y,w,h=bubble.rect
    regions=[r for r in bubble.text_regions if r[2]>0 and r[3]>0 and r[0]>=x and r[1]>=y and r[0]+r[2]<=x+w and r[1]+r[3]<=y+h]
    if not regions:return tuple(bubble.rect)
    margin=max(4,round(min(w,h)*.08))
    left=max(x,min(r[0] for r in regions)-margin);top=max(y,min(r[1] for r in regions)-margin)
    right=min(x+w,max(r[0]+r[2] for r in regions)+margin);bottom=min(y+h,max(r[1]+r[3] for r in regions)+margin)
    return left,top,right-left,bottom-top


def register(namespace):
    m=SimpleNamespace(**namespace);store=m.store

    def check(job,page_id=None):
        if not store.job or store.job['id']!=job:raise m.DetectionCancelled('Cancelled')
        if store.cancel_requested_job==job:store.cancel.set()
        if store.cancel.is_set():raise m.DetectionCancelled('Cancelled')
        if page_id is not None and (not store.document or store.document.region_graph.page_id!=page_id):raise m.DetectionCancelled('Page changed')

    def run(job,payload,ids,chapter,original,output_mode,text_only):
        failures=[];detected=0;reused=0;recognized=0;cached=0;version=0
        processed=0;cleaned=0;skipped=0;already=0;page_results=[];text_regions=0
        def record_failure(page_id,error,region_id=None):
            item=dict(pageId=page_id,stage=store.job.get('stage','unknown'),errorKind=type(error).__name__,error=str(error).splitlines()[0][:300] if str(error) else type(error).__name__)
            if region_id is not None:item['regionId']=region_id
            failures.append(item)
            try:(m.CACHE/'last-scan-failure.json').write_text(json.dumps(dict(jobId=job,**item)),encoding='utf-8')
            except OSError:pass  # Diagnostic I/O must never replace the original failure.
        try:
            for page_number,page_id in enumerate(ids):
                with store.lock:
                    check(job)
                    if chapter:chapter.activate(store,page_id);m.clear_render_cache()
                    check(job,page_id);doc=store.require()
                    store.job.update(stage='detect',currentPageId=page_id,editingAllowed=False,message=f'Processing page {page_number+1} of {len(ids)} · detecting',progress=page_number/len(ids))
                    if text_only:
                        store.job['message'] = f'Locating text on page {page_number+1} of {len(ids)}'
                        source, bubbles = doc.source, tuple(doc.bubbles)
                if text_only:
                    try:
                        candidates = list(locate_text(source, bubbles))
                        with store.lock:
                            check(job, page_id)
                            doc = store.require()
                            graph = deepcopy(doc.region_graph)
                            count = merge_text_candidates(graph, candidates, doc.dialogues)
                            graph.validate(doc.source.shape, doc.bubbles)
                            if graph != doc.region_graph:
                                store.capture(('region_graph',))
                                doc.region_graph = graph
                                doc.revision += 1
                                doc.dirty = True
                                store.preview = None
                            text_regions += count
                            processed += 1
                    except (m.OCRCancelled, m.DetectionCancelled):
                        raise
                    except Exception as error:
                        record_failure(page_id, error)
                    continue
                with store.lock:
                    check(job, page_id)
                    doc = store.require()
                    manual_bubbles=[bubble for bubble in doc.bubbles if bubble.provenance.get('manual_region') is True]
                    needs_detection=len(manual_bubbles)==len(doc.bubbles)
                    if needs_detection:
                        config=m.detection_config(m.SHIMA) if payload.provider==m.SHIMA else {}
                        source_digest=sha256(m.np.ascontiguousarray(doc.source)).hexdigest()
                        identity=sha256((source_digest+json.dumps(dict(provider=payload.provider,device=payload.device,config=config),sort_keys=True)).encode()).hexdigest()
                        needs_detection=not any(r.get('cache_key')==identity for r in doc.detection_runs)
                    source=doc.source.copy() if needs_detection else None
                    working=doc.working.copy() if needs_detection else None
                try:
                    if needs_detection:
                        batch=namespace['detect_with_fallback'](payload.provider,source,working,payload.device,store.cancel)
                        with store.lock:
                            check(job,page_id);doc=store.require();store.capture()
                            doc.bubbles=[*manual_bubbles, *batch.bubbles[:200-len(manual_bubbles)]] if manual_bubbles else batch.bubbles
                            batch.metadata.update(cache_key=identity,displayed_count=len(doc.bubbles))
                            doc.detection_runs.append(batch.metadata);doc.revision+=1;doc.dirty=True;store.preview=None;detected+=1
                    else:reused+=1
                    with store.lock:
                        check(job,page_id);doc=store.require();graph=deepcopy(doc.region_graph)
                        for bubble in doc.bubbles:
                            if bubble.provenance.get('excluded'):continue
                            if not any(r.bubble_id==bubble.id for r in graph.text_regions):
                                graph.add(m.TextRegion(rect=bubble_text_rect(bubble),bubble_id=bubble.id,provenance=dict(origin='automatic_bubble_text_region')))
                        graph.validate(doc.source.shape,doc.bubbles)
                        if len(graph.text_regions)!=len(doc.region_graph.text_regions):
                            if not needs_detection:
                                store.capture(('region_graph',));doc.revision+=1;doc.dirty=True;store.preview=None
                            doc.region_graph=graph
                        if payload.detect_only:
                            processed+=1
                            continue
                        region_ids=[] if payload.skip_ocr else [r.id for r in graph.text_regions if not r.bubble_id or not next((b.provenance.get('excluded') for b in doc.bubbles if b.id==r.bubble_id),False)]
                        if not payload.skip_ocr:
                            version+=1
                            store.job.update(stage='ocr',editingAllowed=len(ids)==1 and not payload.automatic_clean,currentPageId=page_id,result=dict(stateVersion=version),message=f'Processing page {page_number+1} of {len(ids)} · text recognition')
                    for index,identifier in enumerate(region_ids):
                        with store.lock:
                            check(job,page_id);doc=store.require();region=doc.region_graph.region(identifier)
                            if region is None:continue
                            if region.bubble_id and any(b.id==region.bubble_id and b.provenance.get('excluded') for b in doc.bubbles):continue
                            rect=tuple(region.rect);crop=m.crop_region(doc.source,rect);config=m.ocr_config();config['provider']='auto'
                            crop_digest=sha256(crop.tobytes()).hexdigest()
                            key=sha256((crop_digest+json.dumps(dict(rect=rect,config=config),sort_keys=True)).encode()).hexdigest()
                            previous=region.provenance.get('ocr');previous_text=region.source_text
                            valid=bool(previous and previous.get('status')!='Stale' and tuple(previous.get('region_rect',()))==rect
                                and previous.get('raw_text') is not None and previous.get('source_crop_sha256',crop_digest)==crop_digest
                                and previous.get('cache_key',key)==key)
                            if valid and not payload.retry_ocr:cached+=1;continue
                            store.job.update(message=f'Page {page_number+1}/{len(ids)} · text {index+1}/{len(region_ids)}',progress=(page_number+(index+1)/max(1,len(region_ids)))/len(ids))
                        try:
                            m.close_detector()
                            result=namespace['recognize'](crop,config,store.cancel)
                            with store.lock:
                                check(job,page_id);doc=store.require();current=doc.region_graph.region(identifier)
                                if current is None or tuple(current.rect)!=rect:continue
                                if current.bubble_id and any(b.id==current.bubble_id and b.provenance.get('excluded') for b in doc.bubbles):continue
                                data=dict(result);raw=data.pop('text')
                                graph=deepcopy(doc.region_graph);updated=graph.region(identifier)
                                updated.provenance=dict(updated.provenance,ocr=dict(data,status='Needs Review',raw_text=raw,edited_text=raw,
                                    region_rect=list(rect),source_crop_sha256=crop_digest,source_text_at_request_sha256=m.source_text_digest(previous_text),cache_key=key))
                                graph.validate(doc.source.shape,doc.bubbles);doc.region_graph=graph;doc.revision+=1;doc.dirty=True
                                # OCR metadata cannot make an unchanged cleaning mask stale.
                                if store.preview is not None:store.preview['revision']=doc.revision
                                recognized+=1;version+=1;store.job['result']=dict(stateVersion=version)
                        except (m.OCRCancelled,m.DetectionCancelled):raise
                        except Exception as error:record_failure(page_id,error,identifier)
                    with store.lock:
                        check(job,page_id);doc=store.require()
                        if output_mode and doc.composition.get('text_mode', 'clean') != output_mode:
                            store.capture(('composition',))
                            doc.composition = m.page_composition({**doc.composition, 'text_mode': output_mode})
                            doc.revision += 1; doc.dirty = True; store.preview = None
                        if payload.automatic_clean:
                            store.job.update(stage='clean',editingAllowed=False,message=f'Processing page {page_number+1} of {len(ids)} · cleaning')
                            summary=clean_page(m,lambda:check(job,page_id))
                            cleaned+=len(summary['cleanedIds']);skipped+=len(summary['skipped']);already+=len(summary['alreadyProcessedIds'])
                            page_results.append(dict(pageId=page_id,cleaned=len(summary['cleanedIds']),skipped=len(summary['skipped']),alreadyProcessed=len(summary['alreadyProcessedIds'])))
                            if summary.get('failure'):record_failure(page_id,RuntimeError(summary['failure']))
                        processed+=1
                except (m.OCRCancelled,m.DetectionCancelled):raise
                except Exception as error:record_failure(page_id,error)
                with store.lock:
                    if chapter:chapter.flush(store)
            with store.lock:
                check(job)
                if chapter:chapter.flush(store);chapter.activate(store,original);m.clear_render_cache()
                failed=bool(failures and not (processed if text_only else detected or reused))
                status='failed' if failed else 'done'
                if failed:store.job['error']=('Scan could not locate text: ' if text_only else 'Scan could not detect bubbles: ')+failures[0]['error']
                try:
                    (m.CACHE/'last-scan-result.json').write_text(json.dumps(dict(jobId=job,status=status,detectedPages=detected,reusedPages=reused,recognizedRegions=recognized,cachedRegions=cached,errorCount=len(failures),processedPages=processed,cleanedRegions=cleaned,skippedRegions=skipped,alreadyProcessedRegions=already)),encoding='utf-8')
                except OSError:pass
                store.job.update(status=status,stage='done',editingAllowed=False,progress=1,result=dict(detectedPages=detected,reusedPages=reused,recognizedRegions=recognized,cachedRegions=cached,failures=failures,processedPages=processed,attemptedPages=len(ids),cleanedRegions=cleaned,skippedRegions=skipped,alreadyProcessedRegions=already,pages=page_results,translationStatus='unavailable' if payload.automatic_clean else None,outputMode=output_mode))
                if text_only:
                    store.job['result']['textRegionsDetected'] = text_regions
        except (m.OCRCancelled,m.DetectionCancelled):
            with store.lock:
                if chapter and getattr(store,'chapter',None) is chapter:
                    chapter.flush(store);chapter.activate(store,original);m.clear_render_cache()
                if store.job and store.job['id']==job:store.job.update(status='cancelled',editingAllowed=False,progress=1,result=dict(failures=failures,processedPages=processed,cleanedRegions=cleaned,skippedRegions=skipped))
        except Exception as error:
            with store.lock:
                if store.job and store.job['id']==job:store.job.update(status='failed',editingAllowed=False,error=str(error).splitlines()[0][:300])

    def start(payload, request, output_mode, *, text_only=False):
        m.require_auth(request.headers.get('authorization'))
        if payload.provider not in {m.SHIMA,m.OPENCV} or payload.device not in {'auto','cpu','cuda:0'}:raise HTTPException(422,'Invalid detector or device.')
        with store.lock:
            m.check_idle();doc=store.require();chapter=getattr(store,'chapter',None);original=doc.region_graph.page_id
            ids=payload.ids or [original]
            allowed=[p['id'] for p in chapter.pages] if chapter else [original]
            if len(set(ids))!=len(ids) or any(i not in allowed for i in ids):raise HTTPException(422,'Invalid pages.')
            job=uuid4().hex;store.cancel.clear()
            kind='detect-text' if text_only else 'detect-bubbles' if payload.detect_only else 'process' if output_mode else 'scan-detect'
            store.job=dict(id=job,type=kind,status='running',stage='detect',editingAllowed=False,progress=0,cancelRequested=False)
            threading.Thread(target=run,args=(job,payload,ids,chapter,original,output_mode,text_only),daemon=True).start()
            return store.job

    @m.app.post('/v1/scan-detect')
    def scan(payload: ScanRequest,request: Request):
        return start(payload, request, 'clean' if payload.automatic_clean and not payload.detect_only else None)

    @m.app.post('/v1/process')
    def process(payload: ScanRequest,request: Request):
        return start(payload.model_copy(update={'automatic_clean': payload.output_mode == 'clean', 'detect_only': False}), request, payload.output_mode)

    @m.app.post('/v1/detect-text')
    def detect_text(payload: ScanRequest, request: Request):
        return start(payload, request, None, text_only=True)
