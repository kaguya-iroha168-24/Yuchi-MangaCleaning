"""Non-destructive ROI edits, never a replacement segmentation algorithm."""
from copy import deepcopy
import numpy as np


def reframe_bubble(bubble, rect, shape):
    x,y,w,h=rect
    if min(x,y)<0 or min(w,h)<8 or x+w>shape[1] or y+h>shape[0]:
        raise ValueError('Keep the region inside the page, at least 8 × 8 pixels.')
    if bubble.cleaning_status not in {'Needs Review', 'Not Cleaned'} or bubble.last_before is not None:
        raise ValueError('Undo cleaning before adjusting this bubble region.')
    old_x,old_y,old_w,old_h=bubble.rect
    left,top=max(x,old_x),max(y,old_y)
    right,bottom=min(x+w,old_x+old_w),min(y+h,old_y+old_h)
    def crop(pixels):
        if pixels is None:return None
        result=np.zeros((h,w),np.uint8)
        if left<right and top<bottom:
            result[top-y:bottom-y,left-x:right-x]=pixels[top-old_y:bottom-old_y,left-old_x:right-old_x]
        return result
    result=deepcopy(bubble)
    for key in ('interior','text','segmentation'):
        setattr(result,key,crop(getattr(bubble,key)))
    if not np.any(result.segmentation if result.segmentation is not None else result.interior):
        raise ValueError('The adjusted area must intersect the detected bubble. Use manual mask correction for a different area.')
    result.rect=tuple(rect);result.__dict__.pop('contours',None)
    result.reviewed=False;result.review_decision='Needs Review'
    result.provenance=dict(result.provenance,roi_edited=True,original_roi=result.provenance.get('original_roi',list(bubble.rect)),geometry_policy='Preserve source-position segmentation; clip to edited ROI')
    result.text_regions=tuple(r for r in result.text_regions if r[0]>=x and r[1]>=y and r[0]+r[2]<=x+w and r[1]+r[3]<=y+h)
    return result
