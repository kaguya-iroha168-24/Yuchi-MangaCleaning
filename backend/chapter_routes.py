"""Chapter routes around the established single-page editor and codecs."""
from pathlib import Path
from contextlib import nullcontext
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from uuid import uuid4
from hashlib import sha256
import json
import os
import re
from fastapi import HTTPException, Request, UploadFile, Response
from pydantic import BaseModel, Field
from mangaclean.services.chapter import Chapter, natural_key
from mangaclean.services.export_preflight import write_verified_image


def chapter_state(store):
    chapter=getattr(store,'chapter',None)
    if not chapter or not store.document or chapter.active!=store.document.region_graph.page_id:return None
    return chapter.summary(store)


def open_chapter(m,path):
    chapter=Chapter.load(path,m.CACHE,m.Document)
    chapter.activate(m.store,chapter.initial_active,flush=False)
    m.store.chapter=chapter;m.store.preview=None;m.clear_render_cache()


def save_chapter(m):
    chapter=m.store.chapter
    folder=m.ROOT/'outputs/projects';folder.mkdir(parents=True,exist_ok=True)
    path=folder/('chapter-'+uuid4().hex+'.mangaclean')
    chapter.save(m.store,path)
    return dict(path=str(path),sha256=sha256(path.read_bytes()).hexdigest(),bytes=path.stat().st_size,
                revision=m.store.document.revision,verified=True,state=m.public_state())


class ExportPages(BaseModel):
    kind: str='png'
    ids: list[str]=Field(default_factory=list,max_length=200)


class OpenPathPayload(BaseModel):
    path: str
    discard: bool = False


class SaveManifestPayload(BaseModel):
    folderPath: str
    manifest: dict


def register(namespace):
    m=SimpleNamespace(**namespace)
    app,store=m.app,m.store
    store.chapter=None

    @app.post('/v1/open-path')
    def open_disk_path(payload: OpenPathPayload, request: Request):
        m.require_auth(request.headers.get('authorization'))
        target = Path(payload.path)
        if not target.exists():
            raise HTTPException(404, f'File or folder not found: {payload.path}')
        with store.lock:
            m.check_idle()
            if not payload.discard and store.document and (store.document.dirty or (chapter_state(store) or {}).get('dirty')):
                raise HTTPException(409, 'Save current project or discard changes before opening another project.')
            # 1. If it's a chapter package or single-page project .mangaclean file
            if target.is_file() and target.suffix.lower() == '.mangaclean':
                if chapter_manifest(target):
                    open_chapter(m, target)
                    return m.public_state()
                else:
                    data = m.load_project(target)
                    source = data["source"]
                    doc = m.Document(source=source, working=data["clean"] if data["clean"] is not None else source.copy(),
                                   source_name=data["path"], mask=data["mask"], manual_mask=data["manual_mask"],
                                   bubbles=data["bubbles"], dialogues=data["dialogues"], region_graph=data["region_graph"],
                                   active_text_id=data["active_text_id"], detection_runs=data["detection_runs"], composition=data['composition'],
                                   project_name=target.name)
                    store.document = doc
                    store.chapter = None
                    store.undo.clear(); store.redo.clear(); store.preview = None
                    m.clear_render_cache()
                    return m.public_state()

            # 2. If it's a single image file
            if target.is_file() and target.suffix.lower() in {'.png', '.jpg', '.jpeg'}:
                source = m.read_image(target)
                name = target.name
                doc = m.Document(source=source, working=source.copy(), source_name=name,
                               mask=m.np.zeros(source.shape[:2], m.np.uint8), region_graph=m.RegionGraph.for_legacy(source, name))
                store.document = doc
                store.chapter = None
                store.undo.clear(); store.redo.clear(); store.preview = None
                m.clear_render_cache()
                return m.public_state()

            # 3. If it's a directory
            if target.is_dir():
                mc_files = [f for f in target.glob('*.mangaclean') if f.is_file()]
                for mc in mc_files:
                    if chapter_manifest(mc):
                        open_chapter(m, mc)
                        return m.public_state()

                images = [f for f in target.iterdir() if f.is_file() and f.suffix.lower() in {'.png', '.jpg', '.jpeg'}]
                if not images:
                    raise HTTPException(422, 'No PNG or JPEG images found in that folder.')
                images.sort(key=lambda f: natural_key(f.name))
                if len(images) > 200:
                    images = images[:200]

                chapter = Chapter(m.CACHE, m.Document)
                for img_path in images:
                    source = m.read_image(img_path)
                    graph = m.RegionGraph.for_legacy(source, img_path.name)
                    doc = m.Document(source, source.copy(), img_path.name, m.np.zeros(source.shape[:2], m.np.uint8), region_graph=graph, dirty=False)
                    chapter.add(doc, raw=True)
                    if not hasattr(chapter, "_doc_cache"): chapter._doc_cache = {}
                    chapter._doc_cache[graph.page_id] = doc

                chapter.activate(store, chapter.pages[0]['id'], flush=False)
                store.chapter = chapter
                store.preview = None
                m.clear_render_cache()
                return m.public_state()

            raise HTTPException(422, 'Unsupported file or folder format.')

    @app.post('/v1/chapter/save-manifest')
    def save_manifest(payload: SaveManifestPayload, request: Request):
        m.require_auth(request.headers.get('authorization'))
        folder = Path(payload.folderPath)
        if not folder.exists() or not folder.is_dir():
            folder = m.ROOT / 'outputs/projects'
            folder.mkdir(parents=True, exist_ok=True)
        manifest_file = folder / 'project.mangaclean.json'
        try:
            manifest_file.write_text(json.dumps(payload.manifest, indent=2), encoding='utf-8')
            return dict(ok=True, path=str(manifest_file))
        except Exception as e:
            return dict(ok=False, error=str(e))

    @app.post('/v1/pages/import')
    async def import_pages(request: Request,files: list[UploadFile]):
        m.require_auth(request.headers.get('authorization'))
        if not 1<=len(files)<=200:raise HTTPException(422,'Select 1–200 pages.')
        append=request.query_params.get('append')=='true'
        paths=[]
        with store.lock:
            m.check_idle()
            if not append and store.document and (store.document.dirty or (chapter_state(store) or {}).get('dirty')) and request.query_params.get('discard')!='true':
                raise HTTPException(409,'Save the current project before replacing its pages.')
            identity=(id(store.document),store.document.revision if store.document else 0)
        try:
            for file in sorted(files,key=lambda f:natural_key(f.filename or '')):
                if Path(file.filename or '').suffix.lower() not in {'.png','.jpg','.jpeg'}:raise HTTPException(422,'Chapter import supports PNG/JPEG only.')
                paths.append((Path(file.filename).name,await m.bounded_upload(file,100_000_000)))
            with store.lock:
                m.check_idle()
                if identity!=(id(store.document),store.document.revision if store.document else 0):raise HTTPException(409,'The current page changed during import. Retry.')
                existing=getattr(store,'chapter',None) if append else None
                chapter=existing
                if not chapter:
                    chapter=Chapter(m.CACHE,m.Document)
                    if append and store.document:
                        chapter.active=chapter.add(store.document)
                        chapter.pages[-1]['dirty']=store.document.dirty
                if len(chapter.pages)+len(paths)>200:raise HTTPException(422,'Chapter supports at most 200 pages.')
                # Validate every input before changing the live chapter. Decoded
                # images are released on each iteration, not retained as a list.
                with (TemporaryDirectory(dir=m.CACHE) if existing else nullcontext(m.CACHE)) as folder:
                    staged=Chapter(folder,m.Document) if existing else chapter
                    reserved={page['id'] for page in chapter.pages}
                    for name,path in paths:
                        source=m.read_image(path)
                        graph=m.RegionGraph.for_legacy(source,name)
                        if graph.page_id in reserved:graph.page_id=uuid4().hex
                        doc=m.Document(source,source.copy(),name,m.np.zeros(source.shape[:2],m.np.uint8),region_graph=graph,dirty=True)
                        staged.add(doc,raw=True)
                        if not hasattr(chapter, "_doc_cache"): chapter._doc_cache = {}
                        chapter._doc_cache[graph.page_id] = doc
                    if existing:
                        linked=[]
                        try:
                            for page in staged.pages:
                                filename=page['id']+'.mangaclean';target=chapter.folder/filename
                                os.link(staged.folder/filename,target);linked.append(target)
                        except OSError:
                            for target in linked:target.unlink(missing_ok=True)
                            raise
                        chapter.pages.extend(staged.pages)
                if chapter.active is None:chapter.activate(store,chapter.pages[0]['id'],flush=False)
                store.chapter=chapter
                store.preview=None;m.clear_render_cache()
                return m.public_state()
        except (ValueError,OSError,KeyError) as error:raise HTTPException(422,str(error)) from error
        finally:
            for _,path in paths:path.unlink(missing_ok=True)

    @app.get('/v1/pages/{identifier}/image/{kind}')
    def page_image(identifier: str, kind: str, request: Request):
        m.require_auth(request.headers.get('authorization'))
        with store.lock:
            chapter = getattr(store, 'chapter', None)
            if not chapter or not any(p['id'] == identifier for p in chapter.pages):
                raise HTTPException(404, 'Page not found.')
            if chapter.active == identifier and store.document is not None:
                doc = store.document
            else:
                if not hasattr(chapter, '_doc_cache'): chapter._doc_cache = {}
                doc = chapter._doc_cache.get(identifier) or chapter.decode(identifier)
                chapter._doc_cache[identifier] = doc
            if kind == 'original':
                if getattr(doc, '_encoded_source_id', None) == id(doc.source) and hasattr(doc, '_encoded_source'):
                    payload = doc._encoded_source
                else:
                    payload = m.encode_png(doc.source)
                    doc._encoded_source = payload
                    doc._encoded_source_id = id(doc.source)
            elif kind == 'working':
                artwork = m.page_artwork(doc)
                if artwork is doc.source or (doc.revision == 0 and not getattr(doc, 'composition', None)):
                    if getattr(doc, '_encoded_source_id', None) == id(doc.source) and hasattr(doc, '_encoded_source'):
                        payload = doc._encoded_source
                    else:
                        payload = m.encode_png(doc.source)
                        doc._encoded_source = payload
                        doc._encoded_source_id = id(doc.source)
                else:
                    working_key = (doc.revision, id(doc.working), str(getattr(doc, 'composition', None)))
                    if getattr(doc, '_encoded_working_key', None) == working_key and hasattr(doc, '_encoded_working'):
                        payload = doc._encoded_working
                    else:
                        payload = m.encode_png(artwork)
                        doc._encoded_working = payload
                        doc._encoded_working_key = working_key
            else:
                raise HTTPException(400, 'Invalid image kind.')
            return Response(payload, media_type='image/png', headers={'Cache-Control': 'no-store'})

    @app.post('/v1/pages/{identifier}/activate')
    def activate_page(identifier: str,request: Request):
        m.require_auth(request.headers.get('authorization'))
        with store.lock:
            m.check_idle();chapter=getattr(store,'chapter',None)
            if not chapter or not any(p['id']==identifier for p in chapter.pages):raise HTTPException(404,'Page not found.')
            try:chapter.activate(store,identifier)
            except (ValueError,OSError) as error:raise HTTPException(422,str(error)) from error
            m.clear_render_cache();return m.public_state()

    @app.post('/v1/pages/export')
    def export_pages(payload: ExportPages,request: Request):
        m.require_auth(request.headers.get('authorization'))
        if payload.kind not in {'png','jpeg'}:raise HTTPException(422,'Choose PNG or JPEG.')
        with store.lock:
            m.check_idle();chapter=getattr(store,'chapter',None)
            if not chapter:raise HTTPException(409,'Open a chapter first.')
            ids=payload.ids or [p['id'] for p in chapter.pages]
            if len(set(ids))!=len(ids) or any(not any(p['id']==i for p in chapter.pages) for i in ids):raise HTTPException(422,'Invalid page selection.')
            chapter.flush(store)
            folder=m.ROOT/'outputs/exports'/('chapter-'+uuid4().hex);folder.mkdir(parents=True)
            written=[];errors=[]
            for index,page in enumerate(chapter.pages,1):
                if page['id'] not in ids:continue
                try:
                    doc=store.document if page['id']==chapter.active else chapter.decode(page['id'])
                    m.require_export_ready(doc)
                    image=m.composite_page(doc)
                    stem=re.sub(r'[^A-Za-z0-9_-]+','-',Path(page['name']).stem)[:70] or 'page'
                    path=folder/f'{index:03d}-{stem}.{ "png" if payload.kind=="png" else "jpg" }'
                    if path.exists():raise FileExistsError('Export file already exists.')
                    digest,size=write_verified_image(path,image)
                    written.append(dict(pageId=page['id'],path=str(path),sha256=digest,bytes=size))
                except (ValueError,OSError,m.TypesettingUnavailable,HTTPException) as error:
                    errors.append(dict(pageId=page['id'],message=str(getattr(error,'detail',error))))
            return dict(directory=str(folder),files=written,errors=errors,verified=not errors,state=m.public_state())

    @app.post('/v1/bubbles/{identifier}/exclude')
    def exclude_bubble(identifier: str,request: Request):
        m.require_auth(request.headers.get('authorization'))
        with store.lock:
            m.check_idle(editing=True);doc=store.require();bubble=m.bubble_by_id(identifier)
            store.capture(('bubbles',));bubble.provenance=dict(bubble.provenance,excluded=True)
            doc.revision+=1;doc.dirty=True;store.preview=None
            return m.public_state()
