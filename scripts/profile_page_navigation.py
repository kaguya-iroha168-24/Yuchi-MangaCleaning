"""Isolated copied-chapter timings; no AI, desktop input or production backend."""
from pathlib import Path
from time import perf_counter
from contextlib import ExitStack
from unittest.mock import patch
import argparse
import json
import sys
import importlib.util
import os
import threading

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('fixture', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--repeat', type=int, default=1)
    parser.add_argument('--chapter-module', type=Path)
    parser.add_argument('--memory-sampler', type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    from backend import main as backend
    from mangaclean.services import chapter as module
    if args.chapter_module:
        spec = importlib.util.spec_from_file_location('mangaclean.services.navigation_baseline', args.chapter_module)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    from fastapi.testclient import TestClient
    memory_rows = []
    stop_memory = threading.Event()
    memory_thread = None
    if args.memory_sampler:
        spec = importlib.util.spec_from_file_location('navigation_memory', args.memory_sampler)
        sampler = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sampler)
        def sample_memory():
            while not stop_memory.is_set():
                rows = sampler.owned_rows(sampler.snapshot(os.getpid()), os.getpid())
                memory_rows.append(dict(time=perf_counter(), privateResidentBytes=sum(r['privateWorkingSet'] for r in rows),
                                        processes=rows))
                stop_memory.wait(.5)
        memory_thread = threading.Thread(target=sample_memory, daemon=True)
        memory_thread.start()
    chapter = module.Chapter.load(args.fixture, args.output, backend.Document)
    chapter.activate(backend.store, chapter.pages[0]['id'], flush=False)
    backend.store.chapter = chapter
    timings = []
    current = []

    def timed(label, function):
        def call(*values, **keywords):
            start = perf_counter()
            try:
                return function(*values, **keywords)
            finally:
                current.append(dict(stage=label, ms=(perf_counter() - start) * 1000))
        return call

    with ExitStack() as stack:
        for name in ('save_project', 'load_project'):
            stack.enter_context(patch.object(module, name, timed(name, getattr(module, name))))
        for name in ('flush', 'decode'):
            stack.enter_context(patch.object(module.Chapter, name, timed(name, getattr(module.Chapter, name))))
        client = TestClient(backend.app)
        headers = {'Authorization': 'Bearer ' + backend.TOKEN}
        # OS/disk caches are not flushed. First visit is not a cold-machine load.
        sequence = [1, 0, 11, 0, 1, 2, 1, 0, 1, 0, 11, 0]
        for history in (0, 4):
            if history:
                for _ in range(history):
                    backend.store.capture(('dialogues',))
                    backend.store.document.revision += 1
                    backend.store.document.dirty = True
            for index in sequence * args.repeat:
                current.clear()
                outgoing = chapter.active
                before_history = len(backend.store.undo)
                start = perf_counter()
                response = client.post('/v1/pages/' + chapter.pages[index]['id'] + '/activate', headers=headers)
                total = (perf_counter() - start) * 1000
                assert response.status_code == 200, response.status_code
                assert response.json()['document']['pageId'] == chapter.pages[index]['id']
                activation = list(current)
                image_stages = []
                # Follow the existing frontend's extra state GET and two image GETs.
                for endpoint in ('/v1/state', '/v1/image/original', '/v1/image/working'):
                    start = perf_counter()
                    image = client.get(endpoint, headers=headers)
                    assert image.status_code == 200, (endpoint, image.status_code)
                    image_stages.append(dict(endpoint=endpoint, ms=(perf_counter()-start)*1000, bytes=len(image.content)))
                row = dict(historyScenario=history, fromId=outgoing, toPage=index+1,
                           outgoingUndoFrames=before_history, activationMs=total,
                           stages=activation, requests=image_stages,
                           persistenceReused=not any(s['stage']=='save_project' for s in activation))
                timings.append(row)
                print(json.dumps(row), flush=True)
    result = dict(scope='isolated real backend on copied saved native chapter; not native click-to-presentation acceptance',
                  fixture=str(args.fixture), cases=timings,
                  cache='No explicit decoded-page cache; OS cache uncontrolled; repeated visits are warm only',
                  noAIRequested=True, limitations=['Image decoding and native presentation are not measured by this script.',
                  'Stage durations are nested; do not sum flush with its save_project children.',
                  'History=4 creates four metadata-only undo snapshots, not four new AI operations.'])
    stop_memory.set()
    if memory_thread:
        memory_thread.join(timeout=2)
    result['memorySamples'] = memory_rows
    result['memoryScope'] = 'isolated backend and its owned children, not the Tauri/WebView tree'
    (args.output/'BACKEND_BASELINE.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    backend.close_typesetter()


if __name__ == '__main__':
    main()
