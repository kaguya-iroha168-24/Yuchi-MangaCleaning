"""Non-destructive ROI edits, never a replacement segmentation algorithm."""
from copy import deepcopy
import base64
import json
import struct
import cv2
import numpy as np


def _geometry_basis(bubble, shape):
    """Use existing bounded JSON provenance; never replace the segmentation model."""
    basis=bubble.provenance.get('geometry_basis_v1')
    if basis is None:
        basis={'rect':list(bubble.rect),'text_regions':[list(r) for r in bubble.text_regions]}
        for key in ('interior','text','segmentation'):
            pixels=getattr(bubble,key)
            if pixels is None and key=='segmentation':basis[key]=None;continue
            if pixels is None or pixels.dtype!=np.uint8 or pixels.shape!=(bubble.rect[3],bubble.rect[2]):
                raise ValueError('Invalid source geometry mask; ROI is unchanged.')
            ok,encoded=cv2.imencode('.png',pixels)
            if not ok:raise ValueError('Cannot preserve the source geometry mask.')
            basis[key]=base64.b64encode(encoded).decode('ascii')
    if not isinstance(basis,dict) or set(basis)!={'rect','text_regions','interior','text','segmentation'}:
        raise ValueError('Invalid saved geometry basis; ROI is unchanged.')
    try:
        if len(json.dumps(dict(bubble.provenance,geometry_basis_v1=basis)))>20_000:
            raise ValueError('Source masks exceed the current project metadata budget; ROI is unchanged. A new mask-asset extension is required for this region.')
    except TypeError as error:raise ValueError('Invalid saved geometry metadata.') from error
    rect=basis['rect']
    if not isinstance(rect,(list,tuple)) or len(rect)!=4 or any(type(v) is not int for v in rect):raise ValueError('Invalid geometry basis coordinates.')
    x,y,w,h=rect
    if min(x,y)<0 or min(w,h)<1 or x+w>shape[1] or y+h>shape[0] or w*h>24_000_000:
        raise ValueError('Geometry basis exceeds the source image bounds.')
    regions=basis['text_regions']
    if not isinstance(regions,list) or any(not isinstance(r,(list,tuple)) or len(r)!=4 or any(type(v) is not int for v in r) for r in regions):
        raise ValueError('Invalid geometry basis text regions.')
    if any(min(r[0],r[1])<0 or min(r[2],r[3])<1 or r[0]+r[2]>shape[1] or r[1]+r[3]>shape[0] for r in regions):
        raise ValueError('Geometry basis text regions exceed the source image bounds.')
    pixels={}
    for key in ('interior','text','segmentation'):
        value=basis[key]
        if value is None and key=='segmentation':pixels[key]=None;continue
        if not isinstance(value,str):raise ValueError('Invalid geometry basis image.')
        encoded=base64.b64decode(value,validate=True)
        if len(encoded)<33 or encoded[:8]!=b'\x89PNG\r\n\x1a\n' or struct.unpack('>II',encoded[16:24])!=(w,h):
            raise ValueError('Geometry basis PNG dimensions do not match the source ROI.')
        image=cv2.imdecode(np.frombuffer(encoded,np.uint8),cv2.IMREAD_UNCHANGED)
        if image is None or image.dtype!=np.uint8 or image.shape!=(h,w):raise ValueError('Invalid geometry basis mask.')
        pixels[key]=image
    return basis,pixels


def reframe_bubble(bubble, rect, shape):
    x,y,w,h=rect
    if min(x,y)<0 or min(w,h)<8 or x+w>shape[1] or y+h>shape[0]:
        raise ValueError('Keep the region inside the page, at least 8 × 8 pixels.')
    if bubble.cleaning_status not in {'Needs Review', 'Not Cleaned'} or bubble.last_before is not None:
        raise ValueError('Undo cleaning before adjusting this bubble region.')
    basis,pixels=_geometry_basis(bubble,shape)
    old_x,old_y,old_w,old_h=basis['rect']
    left,top=max(x,old_x),max(y,old_y)
    right,bottom=min(x+w,old_x+old_w),min(y+h,old_y+old_h)
    def crop(source):
        if source is None:return None
        result=np.zeros((h,w),np.uint8)
        if left<right and top<bottom:
            result[top-y:bottom-y,left-x:right-x]=source[top-old_y:bottom-old_y,left-old_x:right-old_x]
        return result
    result=deepcopy(bubble)
    for key in ('interior','text','segmentation'):
        setattr(result,key,crop(pixels[key]))
    if not np.any(result.segmentation if result.segmentation is not None else result.interior):
        raise ValueError('The adjusted area must intersect the detected bubble. Use manual mask correction for a different area.')
    result.rect=tuple(rect);result.__dict__.pop('contours',None)
    result.reviewed=False;result.review_decision='Needs Review'
    result.provenance=dict(result.provenance,roi_edited=True,original_roi=result.provenance.get('original_roi',list(bubble.rect)),geometry_basis_v1=deepcopy(basis),geometry_policy='Preserve immutable source-position masks; derive a clipped ROI view')
    if len(json.dumps(result.provenance))>20_000:
        raise ValueError('Preserved geometry metadata exceeds the current project limit; ROI is unchanged.')
    result.text_regions=tuple(tuple(r) for r in basis['text_regions'] if r[0]>=x and r[1]>=y and r[0]+r[2]<=x+w and r[1]+r[3]<=y+h)
    return result
