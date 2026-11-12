"""Shared native mask preparation, restoration and non-semantic result checks.

No detector/model calls. Geometry hints never establish that every dark pixel
is text. Uncertain proposals require review; manual masks are authoritative.
"""
from copy import deepcopy
from dataclasses import dataclass
import cv2
import numpy as np
from mangaclean.core.bubble_review import repair_empty_mask
from mangaclean.core.bubble_detector import effective_bubble_mask
from mangaclean.core.mask_processor import validate_mask, dilate_mask
from mangaclean.core.text_cleaning import selection_mask, selection_rect


@dataclass
class MaskProposal:
    bubble: object
    mask: np.ndarray
    safe: np.ndarray
    analysis: dict


def automatic_clean_safety(image, proposal, manual_mask=None):
    """Conservative pixel/geometry gate, independent of detector confidence.

    A pass permits a selected Clean action, not a semantic text-completeness
    claim. Do not regenerate approved manual data to obtain a passing score.
    """
    b=proposal.bubble;reasons=[];metrics={}
    try:
        validate_mask(proposal.mask,image.shape);validate_mask(proposal.safe,image.shape)
        x,y,w,h=b.rect
        if min(x,y)<0 or min(w,h)<8 or x+w>image.shape[1] or y+h>image.shape[0]:
            raise ValueError('Cleaning ROI is outside the native image.')
        shape=b.segmentation
        validate_mask(shape,(h,w))
        mask=proposal.mask[y:y+h,x:x+w];safe=proposal.safe[y:y+h,x:x+w]
        if np.count_nonzero(mask)!=np.count_nonzero(proposal.mask):
            reasons.append('Mask extends beyond the selected bubble ROI.')
        if not np.any(mask):reasons.append('No pending text pixels.')
        if not np.any(shape) or shape[0].any() or shape[-1].any() or shape[:,0].any() or shape[:,-1].any():
            reasons.append('Container is not enclosed within its ROI.')
        # Recompute the protected band from container geometry, not from a safe
        # mask which may have been widened to preserve manual brush additions.
        protected=cv2.erode(shape,np.ones((5,5),np.uint8),borderType=cv2.BORDER_CONSTANT,borderValue=0)
        unsafe=int(np.count_nonzero(mask & (255-protected)))
        if unsafe or np.any(mask & (255-safe)):
            reasons.append('Text mask intersects protected boundary/tail or lies outside the safe interior.')
        fraction=np.count_nonzero(mask)/max(1,np.count_nonzero(safe))
        gray=cv2.cvtColor(image[y:y+h,x:x+w],cv2.COLOR_BGR2GRAY)
        bg=gray[(safe>0)&(mask==0)]
        ink=(gray<205)&(mask>0)
        if fraction>.40:reasons.append('Mask covers an unusually large part of the interior.')
        if not bg.size or np.mean(bg>=225)<.95 or np.percentile(bg,95)-np.percentile(bg,5)>20:
            reasons.append('Unmasked interior is not confidently uniform and light.')
        if not np.any(ink):reasons.append('No removable dark strokes in this mask.')
        # Long structural strokes inside the mask are suspicious even if the
        # old automatic heuristic assigned high confidence.
        _,_,stats,_=cv2.connectedComponentsWithStats(ink.astype(np.uint8))
        if any(cw>.8*w or ch>.35*h for _,_,cw,ch,_ in stats[1:]):
            reasons.append('Mask contains a large structural stroke; inspect artwork.')
        metrics=dict(mask_pixels=int(np.count_nonzero(mask)),protected_mask_pixels=unsafe,
            masked_fraction=float(fraction),background_samples=int(bg.size),
            background_light_fraction=float(np.mean(bg>=225)) if bg.size else 0.)
    except (ValueError,TypeError) as error:
        reasons.append(str(error))
    if proposal.analysis.get('automatic_mask_confidence')!='high' or proposal.analysis.get('warnings'):
        reasons.append('Automatic mask assessment requires review.')
    if manual_mask is not None or any(b.provenance.get(k) for k in ('manual_corrected','manual_mask_approved')):
        reasons.append('Preserved manual corrections require an explicit mask preview.')
    if b.provenance.get('suggestion_needs_mask_review'):
        reasons.append('Accepted optional suggestion still requires mask review.')
    if b.review_decision=='Rejected' or b.candidate_kind in ('Possible false positive','Uncertain'):
        reasons.append('Candidate requires human detection review.')
    return dict(safe=not reasons,reasons=reasons,metrics=metrics,semantic_verification=False)


def _rectangular_envelope(gray, shape):
    contours,_=cv2.findContours(shape,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    if not contours:return None
    c=max(contours,key=cv2.contourArea);x,y,w,h=cv2.boundingRect(c)
    if cv2.contourArea(c)/max(1,(w-1)*(h-1)) < .93:return None
    lines=cv2.HoughLinesP(cv2.inRange(gray,0,185),1,np.pi/180,
        threshold=10,minLineLength=max(12,int(min(w,h)*.20)),maxLineGap=12)
    sides=set()
    if lines is not None:
        for a,b,d,e in lines.reshape(-1,4):
            dx,dy=abs(int(d-a)),abs(int(e-b))
            if dy>.30*h and dx<.09*dy:
                center=(a+d)/2
                if center<x+.18*w:sides.add('left')
                if center>x+.82*w:sides.add('right')
            if dx>.35*w and dy<.09*dx:
                center=(b+e)/2
                if center<y+.15*h:sides.add('top')
                if center>y+.85*h:sides.add('bottom')
    if len(sides)!=4:return None
    # Only a four-sided, near-rectangular container can bridge glyph notches.
    # Do not convexify arbitrary oval, connected, concave or tailed bubbles.
    hull=np.zeros_like(shape);cv2.drawContours(hull,[cv2.convexHull(c)],-1,255,cv2.FILLED)
    return hull


def _rect_ink(gray,safe,padding):
    ink=cv2.inRange(gray,0,205)&safe
    n,labels,stats,_=cv2.connectedComponentsWithStats(ink)
    h,w=gray.shape;keep=np.zeros(n,np.uint8);ids=[]
    for k in range(1,n):
        x,y,cw,ch,area=map(int,stats[k])
        if (area<2 or cw>.8*w or ch>.3*h or area>.08*w*h
                or max(cw/max(1,ch),ch/max(1,cw))>14):continue
        # A closed white surround is additional evidence, not an OCR result.
        a,b=max(0,x-3),max(0,y-3);c,d=min(w,x+cw+3),min(h,y+ch+3)
        vicinity=gray[b:d,a:c]
        if np.mean(vicinity>=205)<.35:continue
        keep[k]=255;ids.append(k)
    if len(ids)>200 or (len(ids)>40 and np.std(stats[ids,4])/max(1,np.mean(stats[ids,4]))<.12):
        return np.zeros_like(gray),0,['Repeated fine texture is ambiguous; select text manually.']
    return dilate_mask(keep[labels],padding)&safe,len(ids),[]


def boundary_ink_mask(gray, safe, padding=2):
    """Protect whole ink strokes that connect the interior to outside artwork."""
    count, labels = cv2.connectedComponents(cv2.inRange(gray, 0, 205))
    outside_labels = np.unique(labels[safe == 0])
    protected = np.zeros(count, np.uint8)
    protected[outside_labels] = 255
    protected[0] = 0
    return dilate_mask(protected[labels], max(2, padding))


def prepare_text_selection(image, rect, bubble=None, padding=2):
    x, y, w, h = selection_rect(image, rect)
    H, W = image.shape[:2]

    # Context margin around the text selection
    pad = max(14, min(36, int(max(w, h) * 0.25)))
    x0 = max(0, x - pad)
    y0 = max(0, y - pad)
    x1 = min(W, x + w + pad)
    y1 = min(H, y + h + pad)
    rw, rh = x1 - x0, y1 - y0

    roi = image[y0:y1, x0:x1]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY) if roi.ndim == 3 else roi

    otsu_val, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)
    thresh = min(205, max(40, int(otsu_val)))
    ink = cv2.inRange(gray, 0, thresh)

    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink)
    if count <= 1:
        raise ValueError('No text ink detected in this region.')

    rx0, ry0 = x - x0, y - y0
    rx1, ry1 = rx0 + w, ry0 + h

    # Separate structural boundary lineart (bubble walls, panel borders, hair, stall frames)
    # from isolated internal text glyphs
    structural = np.zeros(count, dtype=bool)
    for k in range(1, count):
        cx, cy, cw, ch, area = stats[k]
        touches_outer = (cx == 0 or cy == 0 or cx + cw >= rw or cy + ch >= rh)
        is_long = (cw >= 0.65 * rw or ch >= 0.65 * rh)
        is_large = area > 0.35 * rw * rh
        # Connected ink extending outside the box
        outside_left = max(0, rx0 - cx)
        outside_right = max(0, (cx + cw) - rx1)
        outside_top = max(0, ry0 - cy)
        outside_bottom = max(0, (cy + ch) - ry1)
        extends_outside = max(outside_left, outside_right, outside_top, outside_bottom) >= 4

        if touches_outer or is_long or is_large or extends_outside:
            structural[k] = True

    struct_mask = structural[labels].astype(np.uint8) * 255
    struct_buf = cv2.dilate(struct_mask, np.ones((5, 5), np.uint8))

    safe = np.full_like(gray, 255)
    safe[[0, -1], :] = 0
    safe[:, [0, -1]] = 0
    safe &= cv2.bitwise_not(struct_buf)
    safe &= cv2.bitwise_not(struct_mask)

    if bubble is not None:
        bx, by, bw, bh = bubble.rect
        overlap_x0 = max(0, bx - x0)
        overlap_y0 = max(0, by - y0)
        overlap_x1 = min(rw, bx + bw - x0)
        overlap_y1 = min(rh, by + bh - y0)
        if overlap_x1 > overlap_x0 and overlap_y1 > overlap_y0:
            sub_safe = np.zeros_like(safe)
            sub_interior = bubble.interior[max(0, y0 - by):max(0, y0 - by) + (overlap_y1 - overlap_y0),
                                           max(0, x0 - bx):max(0, x0 - bx) + (overlap_x1 - overlap_x0)]
            sub_safe[overlap_y0:overlap_y1, overlap_x0:overlap_x1] = sub_interior
            safe &= sub_safe

    # Extract isolated glyph components within the text box
    box_mask = np.zeros((rh, rw), dtype=np.uint8)
    box_mask[ry0:ry1, rx0:rx1] = 255

    glyphs = (~structural)[labels].astype(np.uint8) * 255
    glyphs &= box_mask
    glyphs &= cv2.bitwise_not(struct_buf)

    if not np.any(glyphs):
        raise ValueError('No removable text ink found in this selection.')

    dilated_glyphs = cv2.dilate(glyphs, np.ones((3, 3), np.uint8))
    local = dilated_glyphs & safe

    if not np.any(local):
        raise ValueError('No removable text ink found in this selection.')

    mask = np.zeros(image.shape[:2], np.uint8)
    interior = np.zeros_like(mask)
    mask[y0:y1, x0:x1] = (local > 0).astype(np.uint8) * 255
    interior[y0:y1, x0:x1] = (safe > 0).astype(np.uint8) * 255
    return mask, interior


def _segment(image,bubble,padding):
    draft=deepcopy(bubble)
    if not np.any(draft.interior):draft=repair_empty_mask(image,draft,padding)
    x,y,w,h=draft.rect;crop=image[y:y+h,x:x+w];gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
    shape=draft.segmentation if draft.segmentation is not None else draft.interior
    rect=_rectangular_envelope(gray,shape)
    warnings=[]
    if rect is not None:
        safe=cv2.erode(rect,np.ones((5,5),np.uint8),borderType=cv2.BORDER_CONSTANT,borderValue=0)
        mask,count,warnings=_rect_ink(gray,safe,padding)
        strategy='four-sided container; notch-complete text mask'
        draft.segmentation=rect;draft.interior=safe;draft.__dict__.pop('contours',None)
    else:
        safe=draft.interior.copy()
        selected=selection_mask(crop,(0,0,w,h),padding)
        mask=selected.mask&safe
        count=cv2.connectedComponents((mask>0).astype(np.uint8))[0]-1
        strategy='closed white component; glyph mask'
    # Label before clipping. Otherwise an outline crossing the predicted
    # interior looks like an isolated glyph after the safe mask cuts it apart.
    protected_ink = boundary_ink_mask(gray, safe, padding)
    protected_pixels = int(np.count_nonzero(mask & protected_ink))
    mask &= cv2.bitwise_not(protected_ink)
    n,_,ink_stats,_=cv2.connectedComponentsWithStats(cv2.inRange(gray,0,185)&safe)
    small=ink_stats[1:,4]
    if (len(small)>40 and np.median(small)<=8
            and np.std(small)/max(1,np.mean(small))<.2):
        mask.fill(0)
        warnings.append('Repeated small dots resemble screentone; automatic removal withheld. Use a manual text mask.')
    white_fraction=float(np.mean(gray[safe>0]>=205)) if np.any(safe) else 0.
    masked_fraction=float(np.count_nonzero(mask)/max(1,np.count_nonzero(safe)))
    if white_fraction<.60:warnings.append('Interior is not confidently light; artwork or tone may be present.')
    if masked_fraction>.45:warnings.append('Unusually large text mask; inspect artwork and borders.')
    if not np.any(mask):warnings.append('No reliable pending text strokes. Use mask editing; no fill will be substituted.')
    analysis=dict(strategy=strategy,automatic_mask_confidence='review' if warnings else 'high',
        warnings=warnings,mask_pixels=int(np.count_nonzero(mask)),masked_fraction=masked_fraction,
        light_fraction=white_fraction,components=int(count),protected_ink_pixels=protected_pixels,
        semantic_verification=False)
    draft.text=mask.copy()
    draft.provenance=dict(draft.provenance,mask_analysis=analysis)
    return draft,mask,safe,analysis


def prepare_bubble(image,bubble,pending,manual_mask=None,padding=2):
    validate_mask(pending,image.shape)
    x,y,w,h=bubble.rect
    validate_mask(bubble.interior,(h,w));validate_mask(bubble.text,(h,w))
    # Unknown legacy subtract-only scope cannot be safely regenerated.
    manual=(manual_mask is not None or bubble.provenance.get('manual_corrected')
        or bubble.provenance.get('manual_mask_approved'))
    approved=bubble.provenance.get('mask_approved') and np.any(pending[y:y+h,x:x+w])
    if manual or approved:
        draft=deepcopy(bubble)
        mask=pending[y:y+h,x:x+w].copy()
        safe=bubble.interior.copy()|mask
        analysis=(dict(bubble.provenance.get('mask_analysis',{})) if approved and not manual else
            dict(strategy='preserved manual mask',automatic_mask_confidence='manual',warnings=[],semantic_verification=False))
        analysis['mask_pixels']=int(np.count_nonzero(mask))
        draft.text=mask.copy();draft.provenance=dict(draft.provenance,mask_analysis=analysis)
    else:
        try:draft,mask,safe,analysis=_segment(image,bubble,padding)
        except ValueError as error:
            draft=deepcopy(bubble);mask=pending[y:y+h,x:x+w].copy();safe=bubble.interior.copy()
            analysis=dict(strategy='manual fallback required',automatic_mask_confidence='review',
                warnings=[str(error)],mask_pixels=int(np.count_nonzero(mask)),semantic_verification=False)
    full=np.zeros(image.shape[:2],np.uint8);interior=np.zeros_like(full)
    a,b,c,d=draft.rect;full[b:b+d,a:a+c]=mask;interior[b:b+d,a:a+c]=safe
    return MaskProposal(draft,full,interior,analysis)


def assess_result(before,after,mask,proposals):
    """Look for residual glyph-like ink and damage; never assert OCR completeness."""
    difference=np.any(before!=after,axis=2);checks={}
    for proposal in proposals:
        b=proposal.bubble;x,y,w,h=b.rect
        local=mask[y:y+h,x:x+w]
        safe=proposal.safe[y:y+h,x:x+w]
        crop=after[y:y+h,x:x+w];gray=cv2.cvtColor(crop,cv2.COLOR_BGR2GRAY)
        analysis=proposal.analysis
        shape=b.segmentation if b.segmentation is not None else b.interior
        before_gray=cv2.cvtColor(before[y:y+h,x:x+w],cv2.COLOR_BGR2GRAY)
        envelope=_rectangular_envelope(before_gray,shape)
        if envelope is not None:
            analysis_safe=cv2.erode(envelope,np.ones((5,5),np.uint8))
            remnants,_,_=_rect_ink(gray,analysis_safe,0)
        else:
            try:remnants=selection_mask(crop,(0,0,w,h),0).mask&safe
            except ValueError:remnants=np.zeros((h,w),np.uint8)
        residual=int(np.count_nonzero(remnants))
        near=int(np.count_nonzero(remnants & cv2.dilate(local,np.ones((11,11),np.uint8))))
        protected=(safe==0)
        damage=int(np.count_nonzero(difference[y:y+h,x:x+w]&protected&(local==0)))
        warnings=list(analysis.get('warnings',[]))
        boundary=envelope if envelope is not None else shape
        ring=cv2.dilate(boundary,np.ones((3,3),np.uint8))-cv2.erode(boundary,np.ones((3,3),np.uint8))
        boundary_damage=int(np.count_nonzero((ring>0)&(before_gray<185)&difference[y:y+h,x:x+w]))
        if boundary_damage:warnings.append(f'{boundary_damage} changed dark pixels near the container border; inspect possible damage.')
        if np.count_nonzero(local)>.45*max(1,np.count_nonzero(safe)):
            warnings.append('Applied mask unusually large relative to the safe interior.')
        if residual:warnings.append(f'{residual} possible residual ink pixels ({near} near mask edges); inspect before/after.')
        if analysis['strategy']=='preserved manual mask':warnings.append('Manual coverage requires visual result review.')
        if damage:warnings.append('Unexpected changes in protected pixels.')
        changed=int(np.count_nonzero(difference[y:y+h,x:x+w]&(local>0)))
        status='Failed' if not changed else 'Needs Result Review' if warnings else 'Cleaned'
        checks[b.id]=dict(status=status,changed_pixels=changed,potential_remnant_pixels=residual,
            remnants_near_mask=near,protected_changed_pixels=damage,border_risk_pixels=boundary_damage,warnings=warnings,
            semantic_verification=False,interpretation='Image-analysis indicators only; inspect visual result.')
    return checks


def execute(image,mask,method,radius,interior,proposals,restorer):
    validate_mask(mask,image.shape)
    if not np.any(mask):raise ValueError('No pending text mask; nothing was cleaned.')
    result=restorer(image,mask,method,radius,interior)
    if result.outside_changed_pixels:raise ValueError('Unexpected artwork changes outside the approved mask; result discarded.')
    return result,assess_result(image,result.image,mask,proposals)
