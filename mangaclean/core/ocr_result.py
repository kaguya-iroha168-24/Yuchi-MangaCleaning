"""Reviewable OCR proposals stay separate from accepted/manual source text."""
from copy import deepcopy

OCR_STATES=('Needs Review','Accepted','Rejected','Corrected','Stale')


def validate_ocr(record):
    if not isinstance(record,dict)or record.get('status')not in OCR_STATES:
        raise ValueError('Invalid OCR review state.')
    for key in('raw_text','edited_text'):
        if not isinstance(record.get(key),str)or len(record[key])>4000:
            raise ValueError('OCR proposal text must contain at most 4,000 characters.')
    confidence=record.get('confidence')
    if confidence is not None and(type(confidence)not in(int,float)or not 0<=confidence<=1):
        raise ValueError('Invalid OCR confidence; unsupported confidence must be null.')
    if not isinstance(record.get('model_id'),str)or not record.get('provider'):
        raise ValueError('OCR model provenance is missing.')
    rect=record.get('region_rect')
    if not isinstance(rect,(list,tuple))or len(rect)!=4 or any(type(v)is not int for v in rect):
        raise ValueError('OCR provenance must include native crop coordinates.')


def update_source_region(graph,identifier,key,value):
    region=graph.region(identifier)
    values={key:value};provenance=deepcopy(region.provenance)
    ocr=provenance.get('ocr')
    if ocr and key=='rect'and tuple(value)!=tuple(region.rect):
        ocr['status']='Stale';values['provenance']=provenance
    elif ocr and key=='source_text'and value!=region.source_text and ocr['status']in('Accepted','Corrected'):
        ocr.update(status='Corrected',source_manually_corrected=True)
        values['provenance']=provenance
    graph.update(identifier,**values)
