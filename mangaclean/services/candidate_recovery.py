"""Bounded automatic proposals; primary Shima candidates are never replaced."""
from time import perf_counter
import numpy as np
from mangaclean.core.bubble_detector import detect_bubbles

def bounds(bubble):
    x,y,w,h=bubble.provenance.get('native_prediction_rect',bubble.rect)
    return x,y,x+w,y+h

def containment(a,b):
    x,y,u,v=a;xx,yy,uu,vv=b
    intersection=max(0,min(u,uu)-max(x,xx))*max(0,min(v,vv)-max(y,yy))
    return intersection/max(1,min((u-x)*(v-y),(uu-xx)*(vv-yy)))

def duplicate(a,b):
    if containment(bounds(a),bounds(b))>.8:return True
    ax,ay,aw,ah=a.rect;bx,by,bw,bh=b.rect
    x,y,u,v=max(ax,bx),max(ay,by),min(ax+aw,bx+bw),min(ay+ah,by+bh)
    if x>=u or y>=v:return False
    am=a.segmentation if a.segmentation is not None else a.interior
    bm=b.segmentation if b.segmentation is not None else b.interior
    intersection=np.count_nonzero((am[y-ay:v-ay,x-ax:u-ax]>0)&(bm[y-by:v-by,x-bx:u-bx]>0))
    return intersection/max(1,min(np.count_nonzero(am),np.count_nonzero(bm)))>.8

def recover(batch,source,working,cancel,scan,progress,cancelled):
    started=perf_counter();height,width=source.shape[:2];primary=list(batch.bubbles)
    proposals=[]
    for b in detect_bubbles(working,2):
        x,y,w,h=b.rect
        if 1.8<=h/w<=5 and min(w,h)>=24 and b.glyph_count>=2 and not any(containment((x,y,x+w,y+h),bounds(p))>.7 for p in primary):proposals.append(b)
    proposals=sorted(proposals,key=lambda b:-b.glyph_count)[:6]
    added=[];runs=[];limited=False
    for index,b in enumerate(proposals):
        if cancel.is_set():raise cancelled('Scan cancelled before secondary inference.')
        if perf_counter()-started>20:limited=True;break
        if progress:progress(.45+.45*index/max(1,len(proposals)),f'Verifying automatic region {index+1}/{len(proposals)}')
        x,y,w,h=b.rect;cw=min(width,max(320,round(width*.5)));ch=min(height,max(512,round(height*.4375)))
        cx=max(0,min(width-cw,round(x+w/2-cw/2)));cy=max(0,min(height-ch,round(y-(ch-h)/3)))
        result=scan(source[cy:cy+ch,cx:cx+cw].copy(),working[cy:cy+ch,cx:cx+cw].copy())
        runs.append({'crop':[cx,cy,cw,ch],'device':result.metadata.get('device'),'seconds':result.metadata.get('scan_total_s'),'cpu_fallback':result.metadata.get('cpu_fallback',False)})
        for candidate in result.bubbles:
            a,bb,c,d=candidate.rect;candidate.rect=(a+cx,bb+cy,c,d)
            candidate.text_regions=tuple((a+cx,bb+cy,c,d) for a,bb,c,d in candidate.text_regions)
            candidate.__dict__.pop('contours',None)
            p=dict(candidate.provenance);a,bb,c,d=p['native_prediction_rect'];p['native_prediction_rect']=[a+cx,bb+cy,c,d]
            a,bb,c,d=p['native_prediction_xyxy'];p['native_prediction_xyxy']=[a+cx,bb+cy,c+cx,d+cy];candidate.provenance=p
            if containment(bounds(candidate),(x,y,x+w,y+h))<=.7 or any(duplicate(candidate,q) for q in [*primary,*added]):continue
            if candidate.segmentation is None or not np.any(candidate.segmentation):continue
            candidate.reviewed=False;candidate.review_decision='Needs Review'
            candidate.provenance.update(secondary_detection=True,recovery_method='contour_guided_shima_v1',recovery_crop=[cx,cy,cw,ch],recovery_proposal=list(b.rect))
            added.append(candidate)
            if len(added)>=6:limited=True;break
        if len(added)>=6:break
    if cancel.is_set():raise cancelled('Scan cancelled; secondary results discarded.')
    batch.bubbles=[*primary,*added]
    batch.metadata.update(candidate_count=len(batch.bubbles),adapter_count=len(batch.bubbles),
        automatic_recovery={'experimental':True,'primary_count':len(primary),'added_count':len(added),'proposal_count':len(proposals),'runs':runs,'seconds':perf_counter()-started,'budget_limited':limited,'max_regions':6,'between_pass_budget_seconds':20})
    return batch
