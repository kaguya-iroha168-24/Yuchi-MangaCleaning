"""Optional discovery proposals; model confidence is never a review decision."""
from copy import deepcopy
import hashlib
import json


def inactive_suggestion(bubble):
    info=bubble.provenance.get('suggestion')
    return bool(info and (info.get('stale') or info.get('state')!='accepted' or bubble.review_decision=='Rejected'))


def context_key(source_hash,config):
    settings={k:config[k] for k in ('checkpoint_sha256','image_size','iou','max_detections','device')}
    settings.update(source_hash=source_hash,primary_confidence=.25,suggestion_confidence=.20)
    return hashlib.sha256(json.dumps(settings,sort_keys=True).encode()).hexdigest()


def primary_run(runs,config):
    return next((run for run in reversed(runs) if run.get('provider')=='yuchi_v4'
        and run.get('confidence')==.25 and run.get('checkpoint_sha256')==config['checkpoint_sha256']
        and run.get('image_size')==config['image_size'] and run.get('iou')==config['iou']
        and run.get('max_detections',200)==config['max_detections']
        and run.get('requested_device','auto')==config['device']),None)


def prediction_rect(bubble):
    if bubble.provenance.get('manual_corrected') and not bubble.provenance.get('suggestion'):return bubble.rect
    values=bubble.provenance.get('native_prediction_xyxy')
    if values is not None:
        x,y,a,b=values
        return x,y,a-x,b-y
    return bubble.provenance.get('native_prediction_rect',bubble.rect)


def overlap(a,b):
    x,y,w,h=a;u,v,sw,sh=b
    intersection=max(0,min(x+w,u+sw)-max(x,u))*max(0,min(y+h,v+sh)-max(y,v))
    return intersection/max(1,w*h+sw*sh-intersection),intersection/max(1,w*h)


def redundant_partial(candidate,existing):
    """Strict same-width/height fragment rule, not a general overlap filter."""
    a=prediction_rect(candidate);b=prediction_rect(existing);iou,contained=overlap(a,b)
    if iou>=.9:return True
    if existing.provenance.get('manual_corrected') or existing.method.startswith('Manual'):return False
    if existing.provenance.get('provider')!='yuchi_v4' or contained<.95 or iou<.35:return False
    x,y,w,h=a;u,v,sw,sh=b
    vertical=(min(w,sw)/max(w,sw)>=.8 and abs(x-u)<=max(3,.1*sw)
        and abs(x+w-u-sw)<=max(3,.1*sw))
    horizontal=(min(h,sh)/max(h,sh)>=.8 and abs(y-v)<=max(3,.1*sh)
        and abs(y+h-v-sh)<=max(3,.1*sh))
    return vertical or horizontal


def plan_suggestions(existing,batch,key):
    """Return append-only drafts and diagnostic records; never touch page masks."""
    additions=[];records=[]
    serial=max((b.provenance.get('suggestion',{}).get('serial',0) for b in existing),default=0)
    low=[b for b in batch.bubbles if .20<=b.confidence<.25]
    for candidate in low:
        reason=None;related=None;ambiguous=[]
        for old in existing+additions:
            info=old.provenance.get('suggestion')
            if info and info.get('key')!=key and inactive_suggestion(old):continue
            iou,_=overlap(prediction_rect(candidate),prediction_rect(old))
            if info and iou>=.85:
                reason='previous_rejection' if old.review_decision=='Rejected' else 'already_proposed'
                related=old.id;break
            if redundant_partial(candidate,old):
                reason='redundant_suggestion_fragment' if info and inactive_suggestion(old) else 'redundant_partial'
                related=old.id;break
            if iou>.15:ambiguous.append(old.id)
        if reason is None and len(existing)+len(additions)>=200:reason='capacity_limit'
        if reason is None:
            serial+=1;fresh=deepcopy(candidate)
            fresh.reviewed=False;fresh.review_decision='Needs Review';fresh.cleaning_status='Needs Review'
            fresh.cleaning_message='Suggestion inactive. Accept explicitly, then preview the text mask.'
            fresh.provenance=dict(fresh.provenance,suggestion=dict(key=key,serial=serial,
                state='pending',stale=False,overlap_review=ambiguous),suggestion_needs_mask_review=True)
            if ambiguous:fresh.candidate_kind='Uncertain'
            additions.append(fresh);reason='overlap_review' if ambiguous else 'suggested'
            related=fresh.id
        records.append(dict(rect=list(prediction_rect(candidate)),confidence=candidate.confidence,
            decision=reason,related_id=related))
    return additions,dict(raw_final_count=len(batch.bubbles),low_confidence_count=len(low),
        added_suggestions=len(additions),redundant_count=sum(r['decision'].startswith('redundant_') for r in records),
        primary_redundant_count=sum(r['decision']=='redundant_partial' for r in records),
        suggestion_redundant_count=sum(r['decision']=='redundant_suggestion_fragment' for r in records),
        repeated_count=sum(r['decision'] in ('already_proposed','previous_rejection') for r in records),
        records=records,key=key,operation='find_more')
