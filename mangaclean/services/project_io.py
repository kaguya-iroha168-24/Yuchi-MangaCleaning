"""Portable local package: JSON manifest + lossless PNG assets; no extraction."""
from dataclasses import asdict
from pathlib import Path
import json
import os
import tempfile
import zipfile
import struct

import cv2
import numpy as np

from mangaclean.core.bubble_detector import Bubble
from mangaclean.core.dialogue import Dialogue
from mangaclean.core.composition import page_composition, typography_style
from mangaclean.core.mask_processor import validate_mask, validate_image
from mangaclean.core.bubble_review import REVIEW_DECISIONS, CANDIDATE_KINDS, CLEANING_STATES
from mangaclean.core.region_graph import RegionGraph, image_digest


def save_project(path, snapshot, overwrite=False, *, fast_raster=False):
    target = Path(path)
    if target.exists() and not overwrite:
        raise FileExistsError('Project exists; choose a new name or confirm replacement.')
    graph = snapshot.get('region_graph')
    if graph is None:
        graph = RegionGraph.for_legacy(snapshot['source'], Path(snapshot['source_name']).name)
    graph.validate(snapshot['source'].shape, snapshot['bubbles'])
    graph_data = graph.to_dict()
    graph_data['source_sha256'] = image_digest(snapshot['source'])
    if graph.source_sha256 is not None and graph.source_sha256 != graph_data['source_sha256']:
        raise ValueError('Source image does not match the region graph fingerprint.')
    composition = page_composition(snapshot.get('composition', {}))
    styles, locks, dialogues = {}, [], []
    for text in snapshot['dialogues']:
        text.validate()
        if text.source_region_id is not None and graph.region(text.source_region_id) is None:
            raise ValueError('Dialogue references a missing source TextRegion.')
        row = asdict(text)
        if style := row.pop('style'): styles[text.id] = style
        if row.pop('locked'): locks.append(text.id)
        dialogues.append(row)
    if styles: composition['typography'] = styles
    if locks: composition['locked_dialogues'] = locks
    manifest = {'format':'MangaClean', 'version':4 if composition else 3, 'source_name':Path(snapshot['source_name']).name,
                'clean_present':snapshot['clean'] is not None, 'bubbles':[], 'dialogues':dialogues,
                'active_text_id':snapshot.get('active_text_id'),
                'detection_runs':snapshot.get('detection_runs', [])[-10:], 'region_graph':graph_data}
    if composition: manifest['composition'] = composition
    handle, temp = tempfile.mkstemp(prefix='.mangaclean-', suffix='.tmp', dir=target.parent)
    os.close(handle)
    def encode_png(array):
        ok, encoded = cv2.imencode('.png', array)
        if not ok: raise ValueError('Could not encode project image.')
        return encoded.tobytes()
    def png(package, name, array):
        package.writestr(name, encode_png(array))
    try:
        with zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as package:
            original = encode_png(snapshot['source'])
            working = encode_png(snapshot['clean']) if snapshot['clean'] is not None else original
            compression = zipfile.ZIP_STORED if fast_raster else zipfile.ZIP_DEFLATED
            package.writestr('original.png', original, compress_type=compression)
            package.writestr('working.png', working, compress_type=compression)
            png(package,'mask.png',snapshot['mask'])
            if snapshot['manual_mask'] is not None:
                png(package,'manual.png',snapshot['manual_mask'])
            for n, bubble in enumerate(snapshot['bubbles']):
                manifest['bubbles'].append({'id':bubble.id, 'rect':list(bubble.rect), 'reviewed':bubble.reviewed,
                    'method':bubble.method, 'glyph_count':bubble.glyph_count,
                    'segmented':bubble.segmentation is not None,'shape_status':bubble.shape_status,
                    'text_regions':list(bubble.text_regions),'confidence':bubble.confidence,
                    'provenance':bubble.provenance, 'review_decision':bubble.review_decision,
                    'candidate_kind':bubble.candidate_kind, 'cleaning_status':bubble.cleaning_status,
                    'cleaning_message':bubble.cleaning_message})
                for key in ('last_applied_mask','last_before'):
                    pixels=getattr(bubble,key)
                    if pixels is not None:png(package,f'bubbles/{n}/{key}.png',pixels)
                png(package,f'bubbles/{n}/interior.png',bubble.interior)
                png(package,f'bubbles/{n}/text.png',bubble.text)
                if bubble.segmentation is not None:png(package,f'bubbles/{n}/shape.png',bubble.segmentation)
            encoded_manifest=json.dumps(manifest,ensure_ascii=False,allow_nan=False).encode('utf-8')
            if len(encoded_manifest)>2_000_000:
                raise ValueError('Project metadata exceeds the supported manifest size.')
            package.writestr('manifest.json',encoded_manifest)
        if overwrite:
            os.replace(temp,target)
        else:
            os.link(temp,target)  # atomic no-clobber creation on local NTFS
        return target
    finally:
        if os.path.exists(temp): os.unlink(temp)


def load_project(path):
    try:
        with zipfile.ZipFile(path) as package:
            infos = package.infolist()
            if len(infos)>1010 or sum(i.file_size for i in infos)>300_000_000:
                raise ValueError('Project package is too large.')
            if len({i.filename for i in infos})!=len(infos):
                raise ValueError('Duplicate project assets; refusing an ambiguous migration.')
            def read(name, limit=100_000_000):
                try: info=package.getinfo(name)
                except KeyError: raise ValueError(f'Missing project asset: {name}') from None
                if info.file_size>limit: raise ValueError('Project asset exceeds the size limit.')
                return package.read(name)
            manifest=json.loads(read('manifest.json',2_000_000))
            if not isinstance(manifest,dict):raise ValueError('Project manifest must be an object.')
            if manifest.get('format')!='MangaClean' or type(manifest.get('version')) is not int or manifest['version'] not in (1,2,3,4):
                raise ValueError('Unsupported MangaClean project format/version.')
            allowed={'format','version','source_name','clean_present','bubbles','dialogues','active_text_id','detection_runs','region_graph'}
            if manifest['version'] == 4: allowed.add('composition')
            if set(manifest)-allowed:
                raise ValueError('Unknown project metadata; refusing a potentially lossy migration.')
            def image(name):
                data=read(name)
                if len(data)<24 or data[:8]!=b'\x89PNG\r\n\x1a\n':raise ValueError('Project images must be PNG assets.')
                width,height=struct.unpack('>II',data[16:24])
                if min(width,height)<1 or width*height>24_000_000:raise ValueError('Project PNG exceeds the image size limit.')
                result=cv2.imdecode(np.frombuffer(data,np.uint8),cv2.IMREAD_UNCHANGED)
                if result is None or result.shape[0]*result.shape[1]>24_000_000:
                    raise ValueError(f'Invalid or oversized project image: {name}')
                return result
            source=image('original.png'); working=image('working.png'); mask=image('mask.png')
            validate_image(source); validate_image(working); validate_mask(mask,source.shape)
            if working.shape!=source.shape: raise ValueError('Working image dimensions do not match original.')
            manual=image('manual.png') if 'manual.png' in package.namelist() else None
            if manual is not None: validate_mask(manual,source.shape)
            if len(manifest['bubbles'])>200 or len(manifest['dialogues'])>200:
                raise ValueError('Project supports at most 200 bubbles and 200 text objects.')
            known_assets={'manifest.json','original.png','working.png','mask.png','manual.png'}
            for n in range(len(manifest['bubbles'])):
                known_assets.update(f'bubbles/{n}/{key}.png' for key in ('interior','text','shape','last_applied_mask','last_before'))
            if any(not i.is_dir() and i.filename not in known_assets for i in infos):
                raise ValueError('Unknown project assets; refusing a potentially lossy migration.')
            bubbles=[]
            for n, entry in enumerate(manifest['bubbles']):
                allowed_bubble={'id','rect','reviewed','method','glyph_count','segmented','shape_status','text_regions',
                    'confidence','provenance','review_decision','candidate_kind','cleaning_status','cleaning_message'}
                if set(entry)-allowed_bubble:
                    raise ValueError('Unknown bubble metadata; refusing a potentially lossy migration.')
                x,y,w,h=entry['rect']
                if any(type(v) is not int for v in (x,y,w,h)) or min(x,y)<0 or min(w,h)<8 or x+w>source.shape[1] or y+h>source.shape[0]:
                    raise ValueError('Invalid project bubble coordinates.')
                interior=image(f'bubbles/{n}/interior.png'); text=image(f'bubbles/{n}/text.png')
                validate_mask(interior,(h,w)); validate_mask(text,(h,w))
                segmentation=image(f'bubbles/{n}/shape.png') if entry.get('segmented') else None
                if segmentation is not None:
                    validate_mask(segmentation,(h,w))
                    if np.any(interior & (255-segmentation)):
                        raise ValueError('Safe interior extends outside the bubble shape.')
                regions=tuple(tuple(r) for r in entry.get('text_regions',()))
                if any(len(r)!=4 or any(type(v) is not int for v in r) or min(r[2:])<1 or r[0]<x or r[1]<y or r[0]+r[2]>x+w or r[1]+r[3]>y+h for r in regions):
                    raise ValueError('Invalid associated text regions.')
                confidence=entry.get('confidence')
                if confidence is not None and (type(confidence) not in (int,float) or not 0 <= confidence <= 1):
                    raise ValueError('Invalid model confidence in project.')
                provenance=entry.get('provenance',{})
                if not isinstance(provenance,dict) or len(json.dumps(provenance))>20_000:
                    raise ValueError('Invalid detection provenance in project.')
                suggestion=provenance.get('suggestion')
                if suggestion is not None:
                    if (not isinstance(suggestion,dict) or not isinstance(suggestion.get('key'),str)
                            or not 1<=len(suggestion['key'])<=128
                            or type(suggestion.get('serial')) is not int or not 1<=suggestion['serial']<=1_000_000
                            or suggestion.get('state') not in ('pending','accepted','rejected')
                            or type(suggestion.get('stale',False)) is not bool):
                        raise ValueError('Invalid optional suggestion review data.')
                decision=entry.get('review_decision','Accepted' if entry['reviewed'] else 'Needs Review')
                kind=entry.get('candidate_kind','Unclassified')
                status=entry.get('cleaning_status','Needs Review')
                message=entry.get('cleaning_message','')
                if decision not in REVIEW_DECISIONS or kind not in CANDIDATE_KINDS or status not in CLEANING_STATES:
                    raise ValueError('Invalid candidate review or cleaning status.')
                if not isinstance(message,str) or len(message)>2000:
                    raise ValueError('Invalid cleaning message.')
                if decision=='Rejected' and entry['reviewed']:
                    raise ValueError('Rejected candidates cannot be accepted for cleaning.')
                if status in ('Processing','Cleaning'):status='Needs Mask Review'
                bubbles.append(Bubble((x,y,w,h),interior,text,method=str(entry['method']),
                    reviewed=bool(entry['reviewed']),glyph_count=int(entry['glyph_count']),id=str(entry['id']),
                    segmentation=segmentation,text_regions=regions,shape_status=str(entry.get('shape_status','Legacy interior; verify shape')),
                    confidence=confidence,provenance=provenance,review_decision=decision,
                    candidate_kind=kind,cleaning_status=status,cleaning_message=message))
                for key in ('last_applied_mask','last_before'):
                    name=f'bubbles/{n}/{key}.png'
                    if name in package.namelist():
                        pixels=image(name)
                        if key=='last_applied_mask':validate_mask(pixels,(h,w))
                        else:
                            validate_image(pixels)
                            if pixels.shape[:2]!=(h,w):raise ValueError('Invalid result-review crop dimensions.')
                        setattr(bubbles[-1],key,pixels)
            if any({'style', 'locked'} & entry.keys() for entry in manifest['dialogues'] if isinstance(entry, dict)):
                raise ValueError('Extended dialogue properties belong in project composition.')
            dialogues=[Dialogue(**entry) for entry in manifest['dialogues']]
            ids=[b.id for b in bubbles]
            text_ids=[t.id for t in dialogues]
            if len(set(ids))!=len(ids) or len(set(text_ids))!=len(text_ids):
                raise ValueError('Duplicate object IDs in project.')
            composition = manifest.get('composition', {})
            if not isinstance(composition, dict): raise ValueError('Invalid project composition.')
            styles = composition.pop('typography', {})
            locks = composition.pop('locked_dialogues', [])
            composition = page_composition(composition)
            if (not isinstance(styles, dict) or set(styles) - set(text_ids) or not isinstance(locks, list)
                    or any(not isinstance(key, str) or key not in text_ids for key in locks) or len(set(locks)) != len(locks)):
                raise ValueError('Composition references an invalid dialogue.')
            for t in dialogues:
                t.style = typography_style(styles.get(t.id, {}))
                t.locked = t.id in locks
                t.validate()
                if not isinstance(t.id,str) or not t.id or len(t.id)>100:
                    raise ValueError('Invalid text ID.')
                if t.bubble_id not in ids: t.bubble_id=None
            runs=manifest.get('detection_runs',[])
            if not isinstance(runs,list) or len(runs)>10 or any(not isinstance(run,dict) for run in runs):
                raise ValueError('Invalid detector history in project.')
            if manifest['version'] in (2,3,4) or 'region_graph' in manifest:
                graph=RegionGraph.from_dict(manifest['region_graph'],source.shape,bubbles)
                if graph.source_sha256!=image_digest(source):
                    raise ValueError('Source image does not match the region graph fingerprint.')
            else:
                graph=RegionGraph.for_legacy(source,Path(manifest['source_name']).name)
            for text in dialogues:
                if text.source_region_id is not None and graph.region(text.source_region_id) is None:
                    raise ValueError('Dialogue references a missing source TextRegion.')
            return {'source':source,'clean':working if manifest['clean_present'] else None,
                    'mask':mask,'manual_mask':manual,'bubbles':bubbles,'dialogues':dialogues,
                    'path':Path(manifest['source_name']).name,'active_text_id':manifest.get('active_text_id'),
                    'detection_runs':runs,'region_graph':graph,'composition':composition}
    except (zipfile.BadZipFile,json.JSONDecodeError,KeyError,TypeError,OverflowError) as error:
        raise ValueError(f'Invalid MangaClean project: {error}') from error
