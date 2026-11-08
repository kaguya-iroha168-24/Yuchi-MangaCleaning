from __future__ import annotations

import argparse
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field, asdict, replace
from datetime import datetime, timezone
from hashlib import sha256
import os
import re
from pathlib import Path
import secrets
import threading
from time import time
from uuid import uuid4
from typing import Literal
from urllib.parse import urlsplit

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field, StrictBool, StrictInt
from starlette.background import BackgroundTask

from mangaclean.core.bubble_detector import estimate_bubble
from mangaclean.core.bubble_review import CANDIDATE_KINDS, REVIEW_DECISIONS
from mangaclean.core.region_graph import RegionGraph, TextRegion
from mangaclean.core.dialogue import Dialogue, manga_lettering
from mangaclean.core.composition import page_composition
from mangaclean.core.ocr_result import update_source_region
from mangaclean.core.text_cleaning import AUTO, TELEA, WHITE, restore_text, selection_mask
from mangaclean.services.bubble_geometry import reframe_bubble
from mangaclean.services.cleaning_pipeline import automatic_clean_safety, execute, prepare_bubble, prepare_text_selection
from mangaclean.services.detection import OPENCV, SHIMA, detect
from mangaclean.services.detection_runtime import DetectionCancelled, detect_with_fallback
from mangaclean.services.image_io import read_image, write_image
from mangaclean.services.ocr import OCRCancelled, close_ocr, crop_region, ocr_config, recognize, source_text_digest
from mangaclean.services.project_io import load_project, save_project
from mangaclean.services.chapter import chapter_manifest
from backend.chapter_routes import chapter_state, open_chapter, save_chapter
from mangaclean.services.yuchi_process import close_detector, detection_config, warm_detector
from mangaclean.services.typesetting import available_fonts, render_dialogue, composite_page, dialogue_cover_rect, page_artwork, clear_render_cache, close_typesetter, TypesettingUnavailable
from mangaclean.services.export_preflight import dialogue_export_issues, write_verified_image

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
TOKEN = os.environ.get("YUCHI_TAURI_TOKEN") or secrets.token_urlsafe(32)
ORIGINS = {"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}
DEV_PORT = os.environ.get("YUCHI_DEV_PORT", "")
FRONTEND_ORIGIN = os.environ.get("YUCHI_FRONTEND_ORIGIN", "")


def is_local_frontend_origin(value: str) -> bool:
    if value in {"http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"}:
        return True
    try:
        url = urlsplit(value)
        return (url.scheme == "http" and url.hostname == "127.0.0.1"
                and url.port is not None and 1 <= url.port <= 65535
                and value == f"http://127.0.0.1:{url.port}")
    except ValueError:
        return False


if FRONTEND_ORIGIN:
    if not is_local_frontend_origin(FRONTEND_ORIGIN):
        raise RuntimeError("Invalid native frontend origin")
    ORIGINS.add(FRONTEND_ORIGIN)
elif DEV_PORT.isdigit() and 1 <= int(DEV_PORT) <= 65535:
    ORIGINS.add(f"http://127.0.0.1:{int(DEV_PORT)}")

app = FastAPI(title="Yuchi Labs Tauri local API", version="1.0", docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(CORSMiddleware, allow_origins=sorted(ORIGINS), allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"], expose_headers=["Content-Disposition"], allow_credentials=False)
server = None
detector_startup_cancel = threading.Event()


@dataclass
class Document:
    source: np.ndarray
    working: np.ndarray
    source_name: str
    mask: np.ndarray
    manual_mask: np.ndarray | None = None
    bubbles: list = field(default_factory=list)
    dialogues: list = field(default_factory=list)
    detection_runs: list = field(default_factory=list)
    region_graph: RegionGraph | None = None
    active_text_id: str | None = None
    project_name: str | None = None
    dirty: bool = False
    saved_path: str | None = None
    revision: int = 0
    composition: dict = field(default_factory=dict)

    def snapshot(self) -> dict:
        return dict(source=self.source, clean=self.working if self.revision or self.project_name else None,
                    source_name=self.source_name, mask=self.mask, manual_mask=self.manual_mask,
                    bubbles=self.bubbles, dialogues=self.dialogues, detection_runs=self.detection_runs,
                    region_graph=self.region_graph, active_text_id=self.active_text_id, composition=self.composition)


class Store:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.document: Document | None = None
        self.undo: deque = deque(maxlen=4)
        self.redo: deque = deque(maxlen=4)
        self.preview: dict | None = None
        self.job: dict | None = None
        self.cancel = threading.Event()
        self.cancel_requested_job: str | None = None

    def capture(self, keys=None) -> None:
        self.undo.append(self.frame(keys))
        self.redo.clear()

    def frame(self, keys=None) -> dict:
        doc = self.require()
        return {key: deepcopy(getattr(doc, key)) for key in (keys if keys is not None else ('working', 'mask', 'manual_mask', 'bubbles',
                'region_graph', 'dialogues', 'detection_runs', 'active_text_id', 'composition'))}

    def restore(self, frame: dict) -> None:
        doc = self.require()
        for key, value in frame.items(): setattr(doc, key, value)
        doc.revision += 1
        doc.dirty = True
        self.preview = None

    def require(self) -> Document:
        if self.document is None:
            raise HTTPException(409, "Buka gambar atau proyek dahulu.")
        return self.document


store = Store()


def require_auth(authorization: str | None = Header(default=None)) -> None:
    if authorization != f"Bearer {TOKEN}":
        raise HTTPException(401, "Sesi lokal tidak valid.")


def encode_png(image: np.ndarray) -> bytes:
    ok, payload = cv2.imencode(".png", image)
    if not ok:
        raise HTTPException(500, "Gambar tidak dapat dikodekan.")
    return payload.tobytes()


def public_state() -> dict:
    doc = store.document
    if doc is None:
        return {"schema": 1, "document": None, "job": store.job}
    return {"schema": 1, "document": {
        "sourceName": doc.source_name, "projectName": doc.project_name, "width": int(doc.source.shape[1]),
        "height": int(doc.source.shape[0]), "revision": doc.revision, "dirty": doc.dirty, "savedPath": doc.saved_path,
        "bubbles": [{"id": b.id, "rect": list(b.rect), "confidence": b.confidence,
                     "source": {SHIMA: "Shima V1", "yuchi_v4": "Yuchi Fine-Tuned v4", OPENCV: "OpenCV", "manual_region": "Manual bubble region"}.get(b.provenance.get("provider"), "Loaded project / detector unknown"),
                     "manualRegion": b.provenance.get('manual_region') is True,
                     "hasAppliedMask": b.last_applied_mask is not None or b.last_before is not None,
                     "review": b.review_decision, "excluded": bool(b.provenance.get("excluded")), "kind": b.candidate_kind, "cleaning": b.cleaning_status,
                     "message": b.cleaning_message, "predictionRect": b.provenance.get('native_prediction_rect'),
                     "containerPixels": int(np.count_nonzero(b.segmentation)) if b.segmentation is not None else 0,
                     "textRegions": [list(r) for r in b.text_regions]} for b in doc.bubbles],
        "textRegions": [{"id": r.id, "rect": list(r.rect), "text": r.source_text,
                         "origin": r.provenance.get('origin'),
                         "sourceEdited": bool(r.source_text or r.provenance.get('source_manually_corrected')),
                         "bubbleId": r.bubble_id, "kind": r.kind, "direction": r.direction,
                         "ocr": deepcopy(r.provenance.get("ocr"))} for r in doc.region_graph.text_regions],
        "pageId": doc.region_graph.page_id, "dialogues": [asdict(text) for text in doc.dialogues], "composition": doc.composition,
        "readingOrder": list(doc.region_graph.reading_order), "detectionRuns": doc.detection_runs[-3:],
        "canUndo": bool(store.undo), "canRedo": bool(store.redo),
    }, "job": store.job, "chapter": chapter_state(store)}


def check_idle(editing=False) -> None:
    if store.job and store.job["status"] in ("queued", "running") and not (editing and store.job.get("editingAllowed")):
        raise HTTPException(409, "Tunggu pekerjaan aktif selesai.")


async def bounded_upload(upload: UploadFile, limit: int) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".mangaclean"}:
        raise HTTPException(400, "Format berkas tidak didukung.")
    folder = CACHE / "uploads"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / f"{uuid4().hex}{suffix}"
    count = 0
    try:
        with path.open("wb") as target:
            while chunk := await upload.read(1024 * 1024):
                count += len(chunk)
                if count > limit:
                    raise HTTPException(413, "Berkas terlalu besar.")
                target.write(chunk)
        return path
    except Exception:
        path.unlink(missing_ok=True)
        raise


@app.get("/v1/health", dependencies=[])
def health(request: Request):
    require_auth(request.headers.get("authorization"))
    return {"ok": True, "schema": 1, "identity": "Yuchi Labs Tauri", "pid": os.getpid()}


@app.post("/v1/shutdown")
def shutdown(request: Request):
    require_auth(request.headers.get("authorization"))
    if server is None: raise HTTPException(409, "Server lifecycle is not managed in this process.")
    store.cancel.set()
    detector_startup_cancel.set()
    server.should_exit = True
    close_typesetter(wait=False)
    close_ocr(wait=False)
    return {"ok": True}


@app.get("/v1/state")
def state(request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        return public_state()


@app.post("/v1/open")
async def open_file(request: Request, file: UploadFile):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle()
        if store.document and (store.document.dirty or (chapter_state(store) or {}).get("dirty")) and request.query_params.get("discard") != "true":
            raise HTTPException(409, "Perubahan belum disimpan. Konfirmasi sebelum membuka berkas lain.")
    suffix = Path(file.filename or "").suffix.lower()
    path = await bounded_upload(file, 300_000_000 if suffix == ".mangaclean" else 100_000_000)
    try:
        if suffix == ".mangaclean" and chapter_manifest(path):
            with store.lock:
                check_idle();open_chapter(__import__("types").SimpleNamespace(**globals()),path);return public_state()
        if suffix == ".mangaclean":
            data = load_project(path)
            source = data["source"]
            doc = Document(source=source, working=data["clean"] if data["clean"] is not None else source.copy(),
                           source_name=data["path"], mask=data["mask"], manual_mask=data["manual_mask"],
                           bubbles=data["bubbles"], dialogues=data["dialogues"], region_graph=data["region_graph"],
                           active_text_id=data["active_text_id"], detection_runs=data["detection_runs"], composition=data['composition'],
                           project_name=Path(file.filename or "project.mangaclean").name)
        else:
            source = read_image(path)
            name = Path(file.filename or "page.png").name
            doc = Document(source=source, working=source.copy(), source_name=name,
                           mask=np.zeros(source.shape[:2], np.uint8), region_graph=RegionGraph.for_legacy(source, name))
        with store.lock:
            store.document = doc
            store.chapter = None
            store.undo.clear(); store.redo.clear(); store.preview = None
            clear_render_cache()
            return public_state()
    except (ValueError, OSError, KeyError) as error:
        raise HTTPException(400, str(error)) from error
    finally:
        path.unlink(missing_ok=True)


@app.get("/v1/image/{kind}")
def image(kind: str, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        doc = store.require()
        if kind == "original": payload = encode_png(doc.source)
        elif kind == "working": payload = encode_png(page_artwork(doc))
        elif kind == "composite":
            try: payload = encode_png(composite_page(doc))
            except (ValueError, TypesettingUnavailable) as error: raise HTTPException(422, str(error)) from error
        elif kind == "mask": payload = encode_png(doc.mask)
        elif kind == "containers":
            overlay = np.zeros((*doc.source.shape[:2], 4), np.uint8)
            for bubble in doc.bubbles:
                if bubble.segmentation is None: continue
                x, y, w, h = bubble.rect
                shape = bubble.segmentation
                local = overlay[y:y+h, x:x+w]
                local[shape > 0, :3] = (151, 208, 102)
                local[shape > 0, 3] = 26
                ring = cv2.morphologyEx(shape, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
                local[ring > 0, 3] = 180
            payload = encode_png(overlay)
        elif kind == "preview" and store.preview: payload = encode_png(store.preview["mask"])
        elif kind == "preview-overlay" and store.preview:
            mask = store.preview["mask"]
            overlay = np.zeros((*mask.shape, 4), np.uint8)
            overlay[:, :, :3] = (151, 208, 102)
            overlay[:, :, 3] = np.where(mask > 0, 175, 0).astype(np.uint8)
            payload = encode_png(overlay)
        else: raise HTTPException(404, "Aset tidak tersedia.")
    return Response(payload, media_type="image/png", headers={"Cache-Control": "no-store"})


class DetectRequest(BaseModel):
    provider: str = SHIMA
    device: str = "auto"


def run_detect(job_id: str, revision: int, source: np.ndarray, working: np.ndarray, provider: str, device: str) -> None:
    with store.lock:
        if store.job and store.job["id"] == job_id: store.job.update(status="running", progress=0.1)
    try:
        def fallback(reason):
            with store.lock:
                if store.job and store.job['id'] == job_id:
                    store.job.update(message='CUDA gagal; mencoba CPU dengan pengaturan yang sama.', progress=0.35)
        def scan_progress(value, message):
            with store.lock:
                if store.job and store.job['id'] == job_id:
                    store.job.update(progress=value, message=message)
        batch = detect_with_fallback(provider, source, working, device, store.cancel, fallback, on_progress=scan_progress)
        batch.metadata.setdefault('post_nms_count', len(batch.bubbles))
        batch.metadata['displayed_count'] = len(batch.bubbles)
        with store.lock:
            if not store.job or store.job["id"] != job_id: return
            if store.job.get("cancelRequested") or store.document is None or store.document.revision != revision:
                store.job.update(status="cancelled", progress=1)
                return
            store.capture()
            doc = store.require()
            doc.bubbles = batch.bubbles
            doc.mask = np.zeros(source.shape[:2], np.uint8)
            doc.manual_mask = None
            doc.detection_runs.append(batch.metadata)
            doc.revision += 1; doc.dirty = True
            store.preview = None
            store.job.update(status="done", progress=1, result={"count": len(batch.bubbles), "metadata": batch.metadata})
    except DetectionCancelled:
        with store.lock:
            if store.job and store.job['id'] == job_id: store.job.update(status='cancelled', progress=1)
    except Exception as error:
        with store.lock:
            if store.job and store.job["id"] == job_id:
                store.job.update(status="failed", progress=1, error=str(error).splitlines()[0][:500])


@app.post("/v1/detect")
def start_detect(payload: DetectRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    if payload.provider not in {SHIMA, OPENCV} or payload.device not in {"auto", "cpu", "cuda:0"}:
        raise HTTPException(400, "Model atau device tidak didukung.")
    with store.lock:
        check_idle()
        doc = store.require()
        if doc.bubbles or np.any(doc.mask) or doc.region_graph.text_regions:
            raise HTTPException(409, "Scan ulang berisiko mengganti review dan mask. Buka salinan gambar baru untuk scan ulang.")
        job_id = uuid4().hex
        store.cancel.clear()
        store.job = {"id": job_id, "type": "detect", "status": "queued", "progress": 0, "cancelRequested": False}
        thread = threading.Thread(target=run_detect, args=(job_id, doc.revision, doc.source.copy(), doc.working.copy(), payload.provider, payload.device), daemon=True)
        thread.start()
        return store.job


@app.post("/v1/jobs/{job_id}/cancel")
def cancel_job(job_id: str, request: Request):
    require_auth(request.headers.get("authorization"))
    if not store.job or store.job['id'] != job_id: raise HTTPException(404, "Pekerjaan tidak ditemukan.")
    # A job-specific marker can be observed during a locked pixel operation;
    # an old cancellation cannot signal a newer job's shared event.
    store.cancel_requested_job = job_id
    with store.lock:
        if not store.job or store.job["id"] != job_id: raise HTTPException(404, "Pekerjaan tidak ditemukan.")
        store.job["cancelRequested"] = True
        store.cancel.set()
        return store.job


@app.websocket("/v1/progress")
async def progress(socket: WebSocket):
    protocols = [value.strip() for value in socket.headers.get("sec-websocket-protocol", "").split(",")]
    if socket.headers.get("origin") not in ORIGINS or TOKEN not in protocols or "yuchi" not in protocols:
        await socket.close(code=1008)
        return
    await socket.accept(subprotocol="yuchi")
    import asyncio
    try:
        while True:
            with store.lock: current = dict(store.job) if store.job else None
            await socket.send_json(current)
            await asyncio.sleep(0.25)
    except WebSocketDisconnect:
        pass


class ReviewRequest(BaseModel):
    decision: str
    kind: str = "Unclassified"


def bubble_by_id(identifier: str):
    doc = store.require()
    bubble = next((b for b in doc.bubbles if b.id == identifier), None)
    if bubble is None: raise HTTPException(404, "Kandidat tidak ditemukan.")
    return bubble


@app.post("/v1/bubbles/{identifier}/review")
def review(identifier: str, payload: ReviewRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    if payload.decision not in REVIEW_DECISIONS or payload.kind not in CANDIDATE_KINDS:
        raise HTTPException(400, "Keputusan review tidak valid.")
    with store.lock:
        check_idle(); doc = store.require(); bubble = bubble_by_id(identifier)
        store.capture(('bubbles',))
        bubble.review_decision = payload.decision
        bubble.reviewed = payload.decision == "Accepted"
        bubble.candidate_kind = payload.kind
        doc.revision += 1; doc.dirty = True; store.preview = None
        return public_state()


class BubbleGeometryRequest(BaseModel):
    rect: tuple[StrictInt, StrictInt, StrictInt, StrictInt]


class ActivePageRequest(BaseModel):
    pageId: str


class ManualBubbleRequest(BubbleGeometryRequest, ActivePageRequest):
    pass


@app.post('/v1/bubbles/manual')
def add_manual_bubble(payload: ManualBubbleRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle()
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id:
            raise HTTPException(409, 'Page changed before the bubble could be added.')
        x, y, width, height = payload.rect
        if min(x, y) < 0 or min(width, height) < 8 or x + width > doc.source.shape[1] or y + height > doc.source.shape[0]:
            raise HTTPException(422, 'Keep the bubble inside the page, at least 8 × 8 pixels.')
        if len(doc.bubbles) >= 200:
            raise HTTPException(422, 'This page already has 200 bubble regions.')
        try:
            bubble = estimate_bubble(doc.source, payload.rect, manual=True)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        bubble.provenance = {'provider': 'manual_region', 'manual_region': True}
        store.capture(('bubbles',))
        doc.bubbles = [*doc.bubbles, bubble]
        doc.revision += 1; doc.dirty = True; store.preview = None
        return public_state()


@app.post('/v1/bubbles/{identifier}/delete-manual')
def delete_manual_bubble(identifier: str, payload: ActivePageRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle()
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id:
            raise HTTPException(409, 'Page changed before the bubble could be deleted.')
        bubble = bubble_by_id(identifier)
        if bubble.provenance.get('manual_region') is not True:
            raise HTTPException(422, 'Only manually added bubble regions can be deleted.')
        if bubble.last_applied_mask is not None or bubble.last_before is not None:
            raise HTTPException(422, 'Undo cleaning before deleting this manual bubble region.')
        bubbles = [item for item in doc.bubbles if item.id != identifier]
        graph = doc.region_graph.detached({item.id for item in bubbles})
        try:
            graph.validate(doc.source.shape, bubbles)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        if any(text.locked and text.bubble_id == identifier for text in doc.dialogues):
            raise HTTPException(409, 'Unlock linked dialogue layers before deleting this region.')
        dialogues = [replace(text, bubble_id=None) if text.bubble_id == identifier else text for text in doc.dialogues]
        store.capture(('bubbles', 'region_graph', 'dialogues'))
        doc.bubbles = bubbles; doc.region_graph = graph; doc.dialogues = dialogues
        doc.revision += 1; doc.dirty = True; store.preview = None
        return public_state()


@app.post('/v1/bubbles/{identifier}/geometry')
def edit_bubble_geometry(identifier: str, payload: BubbleGeometryRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc=store.require(); bubble=bubble_by_id(identifier)
        try:
            replacement=reframe_bubble(bubble,payload.rect,doc.source.shape)
            graph=deepcopy(doc.region_graph)
            for region in graph.text_regions:
                if region.bubble_id==identifier:
                    update_source_region(graph,region.id,'rect',payload.rect)
            bubbles=[replacement if b.id==identifier else b for b in doc.bubbles]
            graph.validate(doc.source.shape,bubbles)
        except ValueError as error:raise HTTPException(422,str(error)) from error
        store.capture(('bubbles','region_graph'))
        doc.bubbles=bubbles;doc.region_graph=graph
        doc.revision+=1;doc.dirty=True;store.preview=None
        return public_state()


class ManualRequest(BaseModel):
    rect: tuple[int, int, int, int]


def prepare_preview(mask: np.ndarray, safe: np.ndarray, analysis: dict, bubble_id: str | None, proposal=None, *, healing=False) -> dict:
    doc = store.require()
    if doc.composition.get('artwork_locked'): raise HTTPException(409, 'Unlock the working artwork to clean or heal it.')
    if not healing and not np.any(mask): raise HTTPException(422, "Mask kosong; perbaiki area pilihan.")
    token = uuid4().hex
    store.preview = {"id": token, "revision": doc.revision, "mask": mask, "safe": safe,
                     "analysis": analysis, "bubbleId": bubble_id, "proposal": proposal, "healing": healing,
                     "bubbleIds": [bubble_id] if bubble_id else [], "proposals": [proposal] if proposal is not None else []}
    return {"id": token, "revision": doc.revision, "maskPixels": int(np.count_nonzero(mask)),
            "analysis": analysis, "bubbleId": bubble_id}


class HealingRequest(ActivePageRequest):
    rect: tuple[StrictInt, StrictInt, StrictInt, StrictInt] | None = None
    bubbleId: str | None = None


@app.post('/v1/healing/preview')
def prepare_healing(payload: HealingRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle()
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id:
            raise HTTPException(409, 'Page changed before the healing mask could be prepared.')
        if (payload.rect is None) == (payload.bubbleId is None):
            raise HTTPException(422, 'Choose a bubble or draw one explicit healing area.')
        bubble = bubble_by_id(payload.bubbleId) if payload.bubbleId is not None else None
        x, y, width, height = bubble.rect if bubble else payload.rect
        if min(x, y) < 0 or min(width, height) < 8 or x + width > doc.source.shape[1] or y + height > doc.source.shape[0]:
            raise HTTPException(422, 'Keep the healing area inside the page, at least 8 × 8 pixels.')
        safe = np.zeros_like(doc.mask)
        if bubble:
            if bubble.provenance.get('excluded'):
                raise HTTPException(422, 'Select a bubble that is not excluded.')
            shape = bubble.segmentation if bubble.segmentation is not None else bubble.interior
            protected = cv2.erode(shape, np.ones((5, 5), np.uint8), borderType=cv2.BORDER_CONSTANT, borderValue=0)
            safe[y:y + height, x:x + width] = protected & bubble.interior
            if not np.any(safe):
                raise HTTPException(422, 'This bubble has no safe interior. Draw a smaller explicit healing area.')
        else:
            safe[y:y + height, x:x + width] = 255
        mask = np.zeros_like(safe)
        analysis = {'strategy': 'manual healing strokes', 'warnings': [], 'semantic_verification': False}
        return prepare_preview(mask, safe, analysis, payload.bubbleId, healing=True)


class MaskEditRequest(BaseModel):
    previewId: str
    mode: str
    radius: int = Field(default=5, ge=1, le=80)
    points: list[tuple[int, int]] = Field(min_length=1, max_length=2000)


@app.post('/v1/preview/edit')
def edit_preview(payload: MaskEditRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    if payload.mode not in {'add', 'erase'}: raise HTTPException(422, 'Mode brush tidak valid.')
    with store.lock:
        check_idle(editing=True); doc = store.require(); preview = store.preview
        if preview is None or payload.previewId != preview['id'] or preview['revision'] != doc.revision:
            raise HTTPException(409, 'Preview mask sudah tidak berlaku.')
        if preview.get('textRegionId') and payload.mode == 'add':
            raise HTTPException(422, 'A text-only cleaning mask can be reduced, but cannot be expanded. Adjust the text box for a new mask.')
        height, width = doc.source.shape[:2]
        if any(not (0 <= x < width and 0 <= y < height) for x, y in payload.points):
            raise HTTPException(422, 'Brush berada di luar koordinat native.')
        stroke = np.zeros((height, width), np.uint8)
        for point in payload.points: cv2.circle(stroke, point, payload.radius, 255, -1)
        for a, b in zip(payload.points, payload.points[1:]): cv2.line(stroke, a, b, 255, payload.radius * 2 + 1)
        clipped = int(np.count_nonzero(stroke & (255-preview['safe'])))
        stroke &= preview['safe']
        mask = preview['mask'].copy()
        mask[stroke > 0] = 255 if payload.mode == 'add' else 0
        preview['mask'] = mask
        preview['analysis'] = dict(preview['analysis'], manually_edited=True, clipped_brush_pixels=clipped,
                                   mask_pixels=int(np.count_nonzero(mask)), semantic_verification=False)
        preview['analysis']['warnings'] = list(dict.fromkeys([*preview['analysis'].get('warnings', []),
                                            'Manual text-mask edit; inspect the cleaned result.']))
        if preview['proposal'] is not None:
            preview['proposal'] = deepcopy(preview['proposal'])
            preview['proposal'].mask = mask.copy()
            preview['proposal'].analysis = dict(preview['analysis'])
        edited_proposals = []
        for proposal in preview['proposals']:
            proposal = deepcopy(proposal)
            proposal.mask = mask & proposal.safe
            proposal.analysis = dict(preview['analysis'])
            edited_proposals.append(proposal)
        preview['proposals'] = edited_proposals
        return {'id': preview['id'], 'revision': doc.revision, 'maskPixels': int(np.count_nonzero(mask)),
                'analysis': preview['analysis'], 'bubbleId': preview['bubbleId'], 'textRegionId': preview.get('textRegionId')}


@app.post("/v1/bubbles/{identifier}/preview")
def preview_bubble(identifier: str, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True); doc = store.require(); bubble = bubble_by_id(identifier)
        try:
            proposal = prepare_bubble(doc.working, bubble, doc.mask, doc.manual_mask)
            safety = automatic_clean_safety(doc.working, proposal, doc.manual_mask)
            return prepare_preview(proposal.mask, proposal.safe, dict(proposal.analysis, safety=safety), identifier, proposal)
        except ValueError as error: raise HTTPException(422, str(error)) from error


class BatchPreviewRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


@app.post('/v1/bubbles/preview')
def preview_batch(payload: BatchPreviewRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        if len(set(payload.ids)) != len(payload.ids): raise HTTPException(422, 'ID kandidat duplikat.')
        bubbles = [bubble_by_id(identifier) for identifier in payload.ids]
        try: proposals = [prepare_bubble(doc.working, b, doc.mask, doc.manual_mask) for b in bubbles]
        except ValueError as error: raise HTTPException(422, str(error)) from error
        if any(not np.any(p.mask) for p in proposals): raise HTTPException(422, 'Salah satu kandidat tidak memiliki text-mask; periksa satu per satu.')
        mask = np.zeros_like(doc.mask); safe = np.zeros_like(doc.mask); warnings = []
        for proposal in proposals:
            mask |= proposal.mask; safe |= proposal.safe
            warnings.extend(proposal.analysis.get('warnings', []))
        result = prepare_preview(mask, safe, {'strategy': 'selected accepted candidates', 'warnings': warnings,
                                 'candidate_count': len(bubbles), 'semantic_verification': False}, None)
        store.preview['bubbleIds'] = list(payload.ids); store.preview['proposals'] = proposals
        return result


@app.post("/v1/manual/preview")
def preview_manual(payload: ManualRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        try:
            selection = selection_mask(doc.working, payload.rect)
        except ValueError as error: raise HTTPException(422, str(error)) from error
        x, y, w, h = selection.rect
        mask = np.zeros(doc.source.shape[:2], np.uint8)
        mask[y:y+h, x:x+w] = selection.mask
        safe = np.zeros_like(mask); safe[y:y+h, x:x+w] = 255
        return prepare_preview(mask, safe,
                               {"strategy": "manual text selection", "warnings": [], "semantic_verification": False}, None)


@app.post('/v1/text-regions/{identifier}/preview')
def preview_text_region(identifier: str, payload: ActivePageRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True)
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id:
            raise HTTPException(409, 'The selected text belongs to a different page.')
        region = doc.region_graph.region(identifier)
        if region is None:
            raise HTTPException(404, 'Text region not found.')
        bubble = bubble_by_id(region.bubble_id) if region.bubble_id else None
        try:
            mask, safe = prepare_text_selection(doc.working, region.rect, bubble)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        result = prepare_preview(mask, safe, {'strategy': 'selected text glyphs', 'warnings': [],
                                              'semantic_verification': False}, None)
        store.preview['textRegionId'] = identifier
        return dict(result, textRegionId=identifier)


class CleanRequest(BaseModel):
    previewId: str
    method: str = AUTO
    radius: float = Field(default=3, ge=1, le=12)


def apply_clean(payload: CleanRequest, check_cancel=None):
    """Commit a validated mask under store.lock; shared by explicit and queued cleaning."""
    if payload.method not in {AUTO, TELEA, WHITE}: raise HTTPException(400, "Metode cleaning tidak valid.")
    doc = store.require(); preview = store.preview
    if doc.composition.get('artwork_locked'): raise HTTPException(409, 'Unlock the working artwork to clean or heal it.')
    if preview is None or preview["id"] != payload.previewId or preview["revision"] != doc.revision:
        raise HTTPException(409, "Pratinjau sudah tidak berlaku. Siapkan ulang mask.")
    bubbles = [bubble_by_id(identifier) for identifier in preview['bubbleIds']]
    healing = preview.get('healing', False)
    text_only = bool(preview.get('textRegionId'))
    mask = preview["mask"].copy(); before = doc.working.copy()
    try:
        result, checks = execute(before, mask, payload.method, payload.radius,
                                 preview['safe'] if bubbles or healing or text_only else None,
                                 preview['proposals'], restore_text)
    except ValueError as error: raise HTTPException(422, str(error)) from error
    if result.changed_pixels == 0: raise HTTPException(422, "Tidak ada piksel berubah.")
    if check_cancel is not None: check_cancel()
    if healing or text_only:
        store.capture(('working', 'mask', 'bubbles') if bubbles else ('working', 'mask'))
    else:
        store.capture()
    doc.working = result.image
    doc.mask[mask > 0] = 0
    for bubble in bubbles:
        x, y, w, h = bubble.rect
        bubble.last_applied_mask = mask[y:y+h, x:x+w].copy()
        bubble.last_before = before[y:y+h, x:x+w].copy()
        check = checks.get(bubble.id, {"status": "Needs Result Review", "warnings": ["Periksa hasil secara visual."]})
        bubble.cleaning_status = check["status"]
        bubble.cleaning_message = " ".join(check.get("warnings", []))
        bubble.provenance = dict(bubble.provenance, result_assessment=check, mask_approved=False,
                                 last_mask_edit=dict(preview['analysis']) if preview['analysis'].get('manually_edited') else None)
    if not bubbles and not healing and not text_only:
        if doc.manual_mask is None: doc.manual_mask = np.zeros_like(mask)
    doc.revision += 1; doc.dirty = True; store.preview = None
    return {"state": public_state(), "result": {"method": result.method, "maskedPixels": result.masked_pixels,
            "changedPixels": result.changed_pixels, "outsideChangedPixels": result.outside_changed_pixels,
            "checks": checks}}


@app.post("/v1/clean/confirm")
def clean(payload: CleanRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True)
        return apply_clean(payload)


@app.post("/v1/undo")
def undo(request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        if not store.undo: raise HTTPException(409, "Tidak ada perubahan untuk di-undo.")
        frame = store.undo.pop()
        store.redo.append(store.frame(frame.keys()))
        store.restore(frame)
        return dict(public_state(), imagesChanged='working' in frame or 'composition' in frame)


@app.post("/v1/redo")
def redo(request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        if not store.redo: raise HTTPException(409, "Tidak ada perubahan untuk di-redo.")
        frame = store.redo.pop()
        store.undo.append(store.frame(frame.keys()))
        store.restore(frame)
        return dict(public_state(), imagesChanged='working' in frame or 'composition' in frame)


def validated_dialogue(values, doc, existing=None):
    allowed = set(Dialogue.__dataclass_fields__) - {'id', 'locked'}
    if set(values) - allowed:
        raise ValueError('Unknown typography properties.')
    text = replace(existing, **values) if existing else Dialogue(**values)
    text.validate()
    if min(text.x, text.y) < 0 or text.x + text.width > doc.source.shape[1] or text.y + text.height > doc.source.shape[0]:
        raise ValueError('Dialogue must be inside the native page.')
    if text.minimum_size > text.size:
        raise ValueError('Minimum font size cannot exceed preferred size.')
    if text.bubble_id is not None and not any(b.id == text.bubble_id for b in doc.bubbles):
        raise ValueError('Dialogue references a missing bubble.')
    if text.source_region_id is not None and doc.region_graph.region(text.source_region_id) is None:
        raise ValueError('Dialogue references a missing source TextRegion.')
    return text


@app.get('/v1/typography/fonts')
def typography_fonts(request: Request):
    require_auth(request.headers.get('authorization'))
    try: return available_fonts()
    except TypesettingUnavailable as error: raise HTTPException(503, str(error)) from error


@app.post('/v1/typography/preview')
def typography_preview(payload: dict, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        doc = store.require()
        if payload.get('pageId') != doc.region_graph.page_id:
            raise HTTPException(409, 'Page changed; discard the old typography preview.')
        try:
            values = payload.get('dialogue', {})
            if not isinstance(values, dict): raise ValueError('Dialogue preview must be an object.')
            # Public dialogue snapshots can include the lock. Raster preview never mutates it.
            text = validated_dialogue({key: value for key, value in values.items() if key != 'locked'}, doc)
            preset = manga_lettering(text.width, text.height, doc.source.shape, text.style) if payload.get('preset') == 'manga' else None
            if preset is not None:
                text = validated_dialogue(preset, doc, text)
            bubbles = list(doc.bubbles)
            overlay = doc.composition.get('text_mode') == 'overlay'
            cover = dialogue_cover_rect(doc, text)
        except (ValueError, TypeError) as error: raise HTTPException(422, str(error)) from error
    try:
        result = render_dialogue(text, bubbles, cover, overlay=True) if overlay else render_dialogue(text, bubbles)
        return {**result, 'presetPatch': preset} if preset is not None else result
    except (ValueError, TypesettingUnavailable) as error: raise HTTPException(422, str(error)) from error


@app.post('/v1/dialogues')
def add_dialogue(payload: dict, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        if len(doc.dialogues) >= 200: raise HTTPException(422, 'At most 200 editable text layers are supported.')
        try: text = validated_dialogue(payload, doc)
        except (ValueError, TypeError) as error: raise HTTPException(422, str(error)) from error
        store.capture(('dialogues', 'active_text_id'))
        doc.dialogues.append(text); doc.active_text_id = text.id
        doc.revision += 1; doc.dirty = True
        return public_state()


@app.post('/v1/dialogues/{identifier}/delete')
def delete_dialogue(identifier: str, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        target = next((text for text in doc.dialogues if text.id == identifier), None)
        if target is None: raise HTTPException(404, 'Dialogue not found.')
        if target.locked: raise HTTPException(409, 'Unlock this dialogue layer before deleting it.')
        store.capture(('dialogues', 'active_text_id'))
        doc.dialogues = [text for text in doc.dialogues if text.id != identifier]
        if doc.active_text_id == identifier: doc.active_text_id = None
        doc.revision += 1; doc.dirty = True
        return public_state()


@app.post('/v1/dialogues/{identifier}')
def edit_dialogue(identifier: str, payload: dict, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        original = next((text for text in doc.dialogues if text.id == identifier), None)
        if original is None: raise HTTPException(404, 'Dialogue not found.')
        if original.locked: raise HTTPException(409, 'Unlock this dialogue layer before editing it.')
        if not payload: raise HTTPException(422, 'Choose typography properties to edit.')
        try: text = validated_dialogue(payload, doc, original)
        except (ValueError, TypeError) as error: raise HTTPException(422, str(error)) from error
        if asdict(text) == asdict(original): return public_state()
        store.capture(('dialogues', 'active_text_id'))
        doc.dialogues[doc.dialogues.index(original)] = text; doc.active_text_id = text.id
        doc.revision += 1; doc.dirty = True
        return public_state()


class CompositionRequest(ActivePageRequest):
    settings: dict


@app.post('/v1/composition')
def edit_composition(payload: CompositionRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True)
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id: raise HTTPException(409, 'The active page changed.')
        try: next_settings = page_composition({**doc.composition, **payload.settings})
        except ValueError as error: raise HTTPException(422, str(error)) from error
        pixels_changed = any(next_settings.get(key) != doc.composition.get(key) for key in ('artwork', 'brightness', 'contrast', 'text_mode'))
        adjustments_changed = any(next_settings.get(key) != doc.composition.get(key) for key in ('brightness', 'contrast'))
        if adjustments_changed and doc.composition.get('artwork_locked') and next_settings.get('artwork_locked'):
            raise HTTPException(409, 'Unlock the working artwork before adjusting it.')
        if next_settings != doc.composition:
            store.capture(('composition',))
            doc.composition = next_settings
            doc.revision += 1; doc.dirty = True; store.preview = None
        return dict(public_state(), imagesChanged=pixels_changed)


class LayerRequest(ActivePageRequest):
    locked: StrictBool | None = None
    visible: StrictBool | None = None
    move: Literal['up', 'down'] | None = None


@app.post('/v1/layers/{identifier}')
def edit_layer(identifier: str, payload: LayerRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True)
        doc = store.require()
        if payload.pageId != doc.region_graph.page_id: raise HTTPException(409, 'The active page changed.')
        index = next((index for index, text in enumerate(doc.dialogues) if text.id == identifier), None)
        if index is None: raise HTTPException(404, 'Dialogue not found.')
        current = doc.dialogues[index]
        changes = payload.model_dump(exclude_none=True, include={'locked', 'visible'})
        updated = replace(current, **changes)
        destination = index
        if payload.move:
            if updated.locked: raise HTTPException(409, 'Unlock this dialogue layer before moving it.')
            destination = min(len(doc.dialogues)-1, max(0, index + (1 if payload.move == 'up' else -1)))
        if updated != current or destination != index:
            store.capture(('dialogues',))
            doc.dialogues.pop(index)
            doc.dialogues.insert(destination, updated)
            doc.revision += 1; doc.dirty = True; store.preview = None
        return public_state()


class TextRequest(BaseModel):
    rect: tuple[int, int, int, int]
    text: str = Field(max_length=20000)
    bubbleId: str | None = None


@app.post("/v1/text-regions")
def add_text(payload: TextRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        try:
            graph = deepcopy(doc.region_graph)
            region = TextRegion(rect=payload.rect, source_text=payload.text, bubble_id=payload.bubbleId)
            graph.add(region)
            graph.validate(doc.source.shape, doc.bubbles)
            store.capture(('region_graph', 'active_text_id'))
            doc.region_graph = graph
            doc.revision += 1; doc.dirty = True
            return public_state()
        except ValueError as error:
            raise HTTPException(422, str(error)) from error


class TextCorrection(BaseModel):
    text: str | None = Field(default=None, max_length=20000)
    rect: tuple[StrictInt, StrictInt, StrictInt, StrictInt] | None = None
    direction: Literal['unspecified', 'ltr', 'rtl', 'vertical'] | None = None


@app.post('/v1/text-regions/{identifier}')
def correct_text(identifier: str, payload: TextCorrection, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require()
        if doc.region_graph.region(identifier) is None: raise HTTPException(404, 'TextRegion tidak ditemukan.')
        if payload.text is None and payload.rect is None and payload.direction is None:
            raise HTTPException(422, 'Pilih transkripsi, batas crop, atau arah baca untuk diedit.')
        graph = deepcopy(doc.region_graph)
        try:
            if payload.text is not None:
                update_source_region(graph, identifier, 'source_text', payload.text)
                graph.region(identifier).provenance['source_manually_corrected']=True
            if payload.rect is not None: update_source_region(graph, identifier, 'rect', payload.rect)
            if payload.direction is not None: update_source_region(graph, identifier, 'direction', payload.direction)
            graph.validate(doc.source.shape, doc.bubbles)
        except ValueError as error: raise HTTPException(422, str(error)) from error
        store.capture(('region_graph', 'active_text_id')); doc.region_graph = graph
        doc.revision += 1; doc.dirty = True
        return public_state()


class ReadingOrderRequest(BaseModel):
    ids: list[str] = Field(max_length=200)


@app.post('/v1/reading-order')
def reorder_text(payload: ReadingOrderRequest, request: Request):
    require_auth(request.headers.get('authorization'))
    with store.lock:
        check_idle(editing=True); doc = store.require(); graph = deepcopy(doc.region_graph)
        graph.reading_order = list(payload.ids)
        try: graph.validate(doc.source.shape, doc.bubbles)
        except ValueError as error: raise HTTPException(422, str(error)) from error
        store.capture(('region_graph', 'active_text_id')); doc.region_graph = graph
        doc.revision += 1; doc.dirty = True
        return public_state()


class OCRRequest(BaseModel):
    device: str = "cpu"
    language: Literal['auto', 'ja', 'en'] = 'auto'


def run_ocr(job_id: str, revision: int, identifier: str, rect: tuple[int, int, int, int],
            crop: np.ndarray, previous_text: str, device: str, language: str = 'auto') -> None:
    with store.lock:
        if store.job and store.job["id"] == job_id: store.job.update(status="running", progress=0.1)
    try:
        close_detector()
        config = ocr_config()
        config["device"] = device
        config['provider'] = {'auto':'auto','en':'windows_ocr','ja':'manga_ocr'}[language]
        def ocr_progress(stage):
            with store.lock:
                if store.job and store.job['id'] == job_id: store.job['message'] = stage
        result = recognize(crop, config, store.cancel, on_progress=ocr_progress)
        with store.lock:
            if not store.job or store.job["id"] != job_id: return
            if store.cancel.is_set() or store.document is None or store.document.revision != revision:
                store.job.update(status="cancelled", progress=1)
                return
            doc = store.require()
            graph = deepcopy(doc.region_graph)
            region = graph.region(identifier)
            if region is None or tuple(region.rect) != rect:
                store.job.update(status="cancelled", progress=1)
                return
            data = dict(result)
            raw = data.pop("text")
            proposal = dict(data, status="Needs Review", raw_text=raw, edited_text=raw,
                            region_rect=list(rect), source_text_at_request_sha256=source_text_digest(previous_text),
                            source_crop_sha256=sha256(crop.tobytes()).hexdigest(),
                            recognized_at=datetime.now(timezone.utc).isoformat(), requested_direction=region.direction)
            region.provenance = dict(region.provenance, ocr=proposal)
            graph.validate(doc.source.shape, doc.bubbles)
            store.capture(('region_graph', 'active_text_id'))
            doc.region_graph = graph
            doc.revision += 1; doc.dirty = True
            store.job.update(status="done", progress=1, result={"regionId": identifier})
    except OCRCancelled:
        with store.lock:
            if store.job and store.job["id"] == job_id: store.job.update(status="cancelled", progress=1)
    except Exception as error:
        with store.lock:
            if store.job and store.job["id"] == job_id:
                store.job.update(status="failed", progress=1, error=str(error).splitlines()[0][:500])


@app.post("/v1/text-regions/{identifier}/ocr")
def start_ocr(identifier: str, payload: OCRRequest, request: Request):
    require_auth(request.headers.get("authorization"))
    if payload.device not in {"cpu", "cuda"}: raise HTTPException(400, "Device OCR tidak valid.")
    if payload.language == 'en' and payload.device != 'cpu': raise HTTPException(400, 'English Windows OCR uses CPU.')
    with store.lock:
        check_idle(); doc = store.require()
        region = doc.region_graph.region(identifier)
        if region is None: raise HTTPException(404, "TextRegion tidak ditemukan.")
        try: crop = crop_region(doc.source, tuple(region.rect))
        except ValueError as error: raise HTTPException(422, str(error)) from error
        job_id = uuid4().hex
        store.cancel = threading.Event()
        store.job = {"id": job_id, "type": "ocr", "status": "queued", "progress": 0, "cancelRequested": False}
        threading.Thread(target=run_ocr, args=(job_id, doc.revision, identifier, tuple(region.rect), crop,
                                              region.source_text, payload.device, payload.language), daemon=True).start()
        return store.job


@app.post('/v1/bubbles/{identifier}/ocr')
def start_bubble_ocr(identifier: str, payload: OCRRequest, request: Request):
    """Reuse detected native text regions; keep original pixels and review decisions intact."""
    require_auth(request.headers.get('authorization'))
    if payload.device not in {'cpu','cuda'} or (payload.language=='en' and payload.device!='cpu'):
        raise HTTPException(400,'Device OCR tidak valid.')
    with store.lock:
        check_idle();doc=store.require();bubble=next((b for b in doc.bubbles if b.id==identifier),None)
        if bubble is None:raise HTTPException(404,'Bubble tidak ditemukan.')
        linked=[r for r in doc.region_graph.text_regions if r.bubble_id==identifier]
        if len(linked)>1:raise HTTPException(409,'Pilih TextRegion yang ingin dikenali; bubble ini memiliki beberapa region.')
        if linked:region=linked[0]
        else:
            x,y,w,h=bubble.rect
            regions=[r for r in bubble.text_regions if r[2]>0 and r[3]>0 and r[0]>=x and r[1]>=y and r[0]+r[2]<=x+w and r[1]+r[3]<=y+h]
            if regions:
                left=min(r[0] for r in regions);top=min(r[1] for r in regions)
                right=max(r[0]+r[2] for r in regions);bottom=max(r[1]+r[3] for r in regions)
                margin=max(4,round(min(w,h)*.08))
                left=max(x,left-margin);top=max(y,top-margin);right=min(x+w,right+margin);bottom=min(y+h,bottom+margin)
                rect=(left,top,right-left,bottom-top)
            else:rect=tuple(bubble.rect)
            region=TextRegion(rect=rect,source_text='',bubble_id=identifier,
                provenance=dict(origin='automatic_bubble_text_region',crop_method='detected_text_union' if regions else 'bubble_roi_fallback',requires_review=True))
            graph=deepcopy(doc.region_graph);graph.add(region)
            try:graph.validate(doc.source.shape,doc.bubbles);crop_region(doc.source,rect)
            except ValueError as error:raise HTTPException(422,str(error)) from error
            store.capture(('region_graph','active_text_id'));doc.region_graph=graph;doc.revision+=1;doc.dirty=True
        job=start_ocr(region.id,payload,request)
        return dict(job,regionId=region.id)


class OCRDecision(BaseModel):
    decision: str
    editedText: str = Field(default="", max_length=4000)
    replaceExisting: bool = False


@app.post("/v1/text-regions/{identifier}/ocr-review")
def review_ocr(identifier: str, payload: OCRDecision, request: Request):
    require_auth(request.headers.get("authorization"))
    if payload.decision not in {"Accepted", "Rejected"}: raise HTTPException(400, "Keputusan OCR tidak valid.")
    with store.lock:
        check_idle(); doc = store.require(); region = doc.region_graph.region(identifier)
        if region is None: raise HTTPException(404, "TextRegion tidak ditemukan.")
        proposal = region.provenance.get("ocr")
        if not proposal or proposal["status"] != "Needs Review" or tuple(proposal["region_rect"]) != tuple(region.rect):
            raise HTTPException(409, "Proposal OCR sudah tidak berlaku.")
        if payload.decision == "Accepted" and not payload.editedText.strip():
            raise HTTPException(422, "Teks OCR kosong; koreksi atau tolak proposal.")
        if payload.decision == 'Accepted' and region.source_text and region.source_text != payload.editedText and not payload.replaceExisting:
            raise HTTPException(409, 'Konfirmasi penggantian transkripsi yang sudah tersimpan.')
        store.capture(('region_graph', 'active_text_id'))
        proposal = dict(proposal, status=payload.decision, edited_text=payload.editedText)
        region.provenance = dict(region.provenance, ocr=proposal)
        if payload.decision == "Accepted":
            region.source_text = payload.editedText
            region.language = 'en' if proposal.get('language') == 'en' else 'ja'
            region.provenance["source_origin"] = "ocr_accepted"
        doc.region_graph.validate(doc.source.shape, doc.bubbles)
        doc.revision += 1; doc.dirty = True
        return public_state()


def require_export_ready(doc):
    issues = dialogue_export_issues(doc)
    if issues:
        raise HTTPException(422, dict(code='typesetting_preflight',
            message='Ekspor diblokir: perbaiki Dialogue berikut. Save Project tetap tersedia.',
            pageName=doc.source_name, pageId=doc.region_graph.page_id, pageNumber=1,
            revision=doc.revision, issues=issues))


@app.post("/v1/save/{kind}")
def persist(kind: str, request: Request):
    """Create a verified output copy within this application's own workspace."""
    require_auth(request.headers.get("authorization"))
    if kind not in {"project", "png", "jpeg"}:
        raise HTTPException(404, "Format penyimpanan tidak didukung.")
    with store.lock:
        check_idle(); doc = store.require()
        if kind == 'project' and getattr(store,'chapter',None) and len(store.chapter.pages)>1:
            return save_chapter(__import__("types").SimpleNamespace(**globals()))
        if kind != 'project': require_export_ready(doc)
        folder = ROOT / "outputs" / ("projects" if kind == "project" else "exports")
        folder.mkdir(parents=True, exist_ok=True)
        if not folder.resolve().is_relative_to(ROOT.resolve()):
            raise HTTPException(500, "Direktori output berada di luar workspace Tauri.")
        stem = re.sub(r"[^A-Za-z0-9_-]+", "-", Path(doc.source_name).stem).strip("-")[:70] or "page"
        extension = {"project": ".mangaclean", "png": ".png", "jpeg": ".jpg"}[kind]
        path = folder / f"{stem}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}-{uuid4().hex[:8]}{extension}"
        try:
            if kind == "project":
                save_project(path, deepcopy(doc.snapshot()))
                loaded = load_project(path)
                working = loaded["clean"] if loaded["clean"] is not None else loaded["source"]
                if not (np.array_equal(loaded["source"], doc.source) and np.array_equal(working, doc.working)
                        and np.array_equal(loaded["mask"], doc.mask)
                        and loaded["region_graph"].to_dict() == doc.region_graph.to_dict()
                        and [asdict(text) for text in loaded['dialogues']] == [asdict(text) for text in doc.dialogues]
                        and loaded['composition'] == doc.composition
                        and [b.id for b in loaded["bubbles"]] == [b.id for b in doc.bubbles]
                        and [b.review_decision for b in loaded["bubbles"]] == [b.review_decision for b in doc.bubbles]):
                    raise ValueError("Verifikasi round-trip project gagal.")
            else:
                rendered = composite_page(doc)
                digest, byte_count = write_verified_image(path, rendered)
            if kind == 'project':
                with path.open("rb+") as persisted:
                    os.fsync(persisted.fileno())
                digest = sha256(path.read_bytes()).hexdigest()
                byte_count = path.stat().st_size
        except (OSError, ValueError, KeyError, TypesettingUnavailable) as error:
            raise HTTPException(500, f"Berkas belum terverifikasi tersimpan: {error}") from error
        if kind == "project":
            doc.saved_path = str(path)
            doc.project_name = path.name
            doc.dirty = False
        return {"path": str(path), "sha256": digest, "bytes": byte_count,
                "revision": doc.revision, "verified": True, "state": public_state()}


@app.get("/v1/export/{kind}")
def export(kind: str, request: Request):
    require_auth(request.headers.get("authorization"))
    with store.lock:
        check_idle(); doc = store.require()
        folder = CACHE / "exports"; folder.mkdir(exist_ok=True)
        if kind == "project":
            name = Path(doc.source_name).stem + ".mangaclean"
            path = folder / f"{uuid4().hex}.mangaclean"
            try: save_project(path, deepcopy(doc.snapshot()))
            except ValueError as error: raise HTTPException(422, str(error)) from error
            # Browser downloads cannot prove the user actually saved the file.
            media = "application/octet-stream"
        elif kind in {"png", "jpeg"}:
            require_export_ready(doc)
            extension = ".png" if kind == "png" else ".jpg"
            name = Path(doc.source_name).stem + "-clean" + extension
            path = folder / f"{uuid4().hex}{extension}"
            try: write_verified_image(path, composite_page(doc))
            except (OSError, ValueError, TypesettingUnavailable) as error: raise HTTPException(422, str(error)) from error
            media = "image/png" if kind == "png" else "image/jpeg"
        else: raise HTTPException(404, "Format ekspor tidak didukung.")
        return FileResponse(path, media_type=media, filename=name, background=BackgroundTask(path.unlink, missing_ok=True))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535: parser.error("Invalid port")
    import uvicorn
    global server
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=args.port, access_log=False))
    threading.Thread(target=warm_detector, args=(detector_startup_cancel,), daemon=True).start()
    try: server.run()
    finally:
        detector_startup_cancel.set()
        store.cancel.set()
        close_ocr()
        close_typesetter()
        close_detector()


from backend.chapter_routes import register as register_chapter_routes
register_chapter_routes(globals())
from backend.workflow import register as register_workflow
register_workflow(globals())
from backend.translation import register as register_translation
register_translation(globals())

if __name__ == "__main__":
    main()
