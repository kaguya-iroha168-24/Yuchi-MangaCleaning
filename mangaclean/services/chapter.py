"""Disk-backed chapter; only the current page/history is decoded in the editor.

Chapter v1 embeds existing single-page v3 packages. No pickle or archive path
extraction is used. Old single-page readers/writers remain unchanged.
"""
from pathlib import Path
from uuid import uuid4
from copy import copy
import base64
import hashlib
import json
import os
import re
import shutil
import zipfile
import cv2
from .project_io import save_project, load_project


def natural_key(name):
    return [(1,int(part)) if part.isdigit() else (0,part.casefold()) for part in re.split(r'(\d+)',name)]


def chapter_manifest(path):
    if not zipfile.is_zipfile(path):return None
    with zipfile.ZipFile(path) as archive:
        entry=archive.getinfo('manifest.json')
        if entry.file_size>2_000_000:raise ValueError('Project manifest is too large.')
        manifest=json.loads(archive.read(entry))
        return manifest if manifest.get('format')=='MangaCleanChapter' else None


class Chapter:
    def __init__(self, cache, document_type):
        self.id=uuid4().hex;self.folder=Path(cache)/('chapter-'+self.id)
        self.folder.mkdir(parents=True,exist_ok=False)
        self.pages=[];self.active=None;self.document_type=document_type;self.saved_path=None

    def row(self, identifier):
        return next(p for p in self.pages if p['id']==identifier)

    def add(self, doc):
        if len(self.pages)>=200:raise ValueError('A chapter supports at most 200 pages.')
        identifier=doc.region_graph.page_id
        if any(p['id']==identifier for p in self.pages):
            doc.region_graph.page_id=identifier=uuid4().hex
        height,width=doc.source.shape[:2]
        thumb=cv2.resize(doc.source,(max(1,round(width*min(160/width,200/height))),max(1,round(height*min(160/width,200/height)))))
        ok,png=cv2.imencode('.png',thumb)
        if not ok:raise ValueError('Thumbnail encoding failed.')
        page=dict(id=identifier,name=Path(doc.source_name).name,width=width,height=height,
                  dirty=True,revision=doc.revision,bubbles=len(doc.bubbles),savedPath=None,
                  thumbnail=base64.b64encode(png).decode('ascii'),undo=[],redo=[])
        save_project(self.folder/(identifier+'.mangaclean'),dict(doc.snapshot(),clean=doc.working))
        self.pages.append(page)
        return identifier

    def flush(self, store):
        if self.active is None:return
        doc=store.require();page=self.row(self.active)
        if doc.region_graph.page_id!=self.active:raise ValueError('Active page identity mismatch.')
        save_project(self.folder/(self.active+'.mangaclean'),dict(doc.snapshot(),clean=doc.working),overwrite=True)
        page.update(dirty=doc.dirty,revision=doc.revision,bubbles=len(doc.bubbles),savedPath=doc.saved_path)
        for key in ('undo','redo'):
            frames=list(getattr(store,key));page[key]=['']*len(frames)
            snapshot=copy(dict(doc.snapshot(),clean=doc.working))
            # Partial undo frames must be composed backwards. Combining an old
            # graph with today's later dialogue could otherwise break its IDs.
            for index in range(len(frames)-1,-1,-1):
                frame=frames[index]
                snapshot.update({('clean' if name=='working' else name):value for name,value in frame.items()})
                name=f'{self.active}-{key}-{index}.mangaclean'
                save_project(self.folder/name,snapshot,overwrite=True);page[key][index]=name

    def decode(self, identifier):
        page=self.row(identifier);data=load_project(self.folder/(identifier+'.mangaclean'))
        if data['region_graph'].page_id!=identifier:raise ValueError('Page package identity mismatch.')
        source=data['source']
        return self.document_type(source=source,working=data['clean'] if data['clean'] is not None else source.copy(),
            source_name=page['name'],mask=data['mask'],manual_mask=data['manual_mask'],bubbles=data['bubbles'],
            dialogues=data['dialogues'],region_graph=data['region_graph'],active_text_id=data['active_text_id'],
            detection_runs=data['detection_runs'],dirty=page['dirty'],revision=page['revision'],saved_path=page.get('savedPath'))

    def activate(self, store, identifier, flush=True):
        self.row(identifier)
        if identifier==self.active and store.document is not None:return
        if flush:self.flush(store)
        doc=self.decode(identifier);histories={}
        for key in ('undo','redo'):
            histories[key]=[]
            for name in self.row(identifier)[key]:
                data=load_project(self.folder/name)
                histories[key].append(dict(working=data['clean'] if data['clean'] is not None else data['source'],
                    mask=data['mask'],manual_mask=data['manual_mask'],bubbles=data['bubbles'],dialogues=data['dialogues'],
                    region_graph=data['region_graph'],active_text_id=data['active_text_id'],detection_runs=data['detection_runs']))
        store.document=doc;self.active=identifier;store.preview=None
        for key,frames in histories.items():
            getattr(store,key).clear();getattr(store,key).extend(frames)

    def summary(self, store):
        pages=[]
        for page in self.pages:
            item={k:v for k,v in page.items() if k not in {'undo','redo','revision','savedPath'}}
            item['saved']=bool(page.get('savedPath') and Path(page['savedPath']).is_file())
            if page['id']==self.active:
                item.update(dirty=store.document.dirty,bubbles=len(store.document.bubbles),saved=bool(store.document.saved_path and Path(store.document.saved_path).is_file()))
            pages.append(item)
        return dict(id=self.id,activePageId=self.active,pages=pages,dirty=any(p['dirty'] for p in pages),savedPath=self.saved_path)

    def save(self, store, path):
        self.flush(store);path=Path(path)
        if path.exists():raise FileExistsError('Choose a new chapter filename.')
        entries=[]
        temporary=path.with_name(path.name+'.'+uuid4().hex+'.tmp')
        try:
            with zipfile.ZipFile(temporary,'w',zipfile.ZIP_STORED) as archive:
                for page in self.pages:
                    source=self.folder/(page['id']+'.mangaclean');name='pages/'+source.name
                    with source.open('rb') as stream:digest=hashlib.file_digest(stream,'sha256').hexdigest()
                    archive.write(source,name);entries.append(dict(id=page['id'],name=page['name'],entry=name,sha256=digest))
                archive.writestr('manifest.json',json.dumps(dict(format='MangaCleanChapter',version=1,id=self.id,active=self.active,pages=entries)))
            with zipfile.ZipFile(temporary) as archive:
                for page in entries:
                    with archive.open(page['entry']) as stream:
                        if hashlib.file_digest(stream,'sha256').hexdigest()!=page['sha256']:raise ValueError('Chapter verification failed.')
            with temporary.open('rb+') as stream:os.fsync(stream.fileno())
            os.replace(temporary,path)
        finally:
            if temporary.exists():temporary.unlink()
        self.saved_path=str(path)
        for page in self.pages:page.update(dirty=False,savedPath=str(path))
        store.document.dirty=False;store.document.saved_path=str(path)

    @classmethod
    def load(cls,path,cache,document_type):
        manifest=chapter_manifest(path)
        if not manifest or manifest.get('version')!=1:raise ValueError('Unsupported chapter project.')
        pages=manifest.get('pages',[])
        if not 1<=len(pages)<=200:raise ValueError('Invalid chapter size.')
        ids=[page.get('id','') for page in pages]
        if len(set(ids))!=len(ids) or any(not re.fullmatch('[a-f0-9]{32}',p) for p in ids):raise ValueError('Invalid page IDs.')
        if manifest.get('active') not in ids:raise ValueError('Invalid active page.')
        chapter=cls(cache,document_type)
        with zipfile.ZipFile(path) as archive:
            total=0
            for page in pages:
                expected='pages/'+page['id']+'.mangaclean'
                if page['entry']!=expected:raise ValueError('Invalid page entry.')
                entry=archive.getinfo(expected);total+=entry.file_size
                if entry.file_size>300_000_000 or total>2_000_000_000:raise ValueError('Chapter exceeds bounded loading limit.')
                temporary=chapter.folder/(page['id']+'.incoming')
                with archive.open(entry) as source,temporary.open('wb') as output:shutil.copyfileobj(source,output,1024*1024)
                with temporary.open('rb') as stream:
                    if hashlib.file_digest(stream,'sha256').hexdigest()!=page['sha256']:raise ValueError('Page checksum mismatch.')
                data=load_project(temporary)
                if data['region_graph'].page_id!=page['id']:raise ValueError('Page identity mismatch.')
                doc=document_type(source=data['source'],working=data['clean'] if data['clean'] is not None else data['source'].copy(),
                    source_name=page['name'],mask=data['mask'],manual_mask=data['manual_mask'],bubbles=data['bubbles'],
                    dialogues=data['dialogues'],region_graph=data['region_graph'],active_text_id=data['active_text_id'],detection_runs=data['detection_runs'])
                chapter.add(doc);chapter.pages[-1]['dirty']=False
                temporary.unlink()
        # Upload staging paths are transient, not proof of a persisted user copy.
        chapter.id=manifest['id'];chapter.saved_path=None
        chapter.initial_active=manifest['active']
        return chapter
