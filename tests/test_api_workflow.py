"""Focused native-pixel workflow checks using only this isolated workspace."""
from io import BytesIO
from pathlib import Path

import cv2
import numpy as np
from fastapi.testclient import TestClient

from backend import main


HEADERS = {"Authorization": f"Bearer {main.TOKEN}", "Origin": "http://tauri.localhost"}


def make_page():
    image = np.full((220, 300, 3), 245, np.uint8)
    cv2.ellipse(image, (150, 110), (100, 80), 0, 0, 360, (255, 255, 255), -1)
    cv2.ellipse(image, (150, 110), (100, 80), 0, 0, 360, (0, 0, 0), 3)
    cv2.putText(image, "YUCHI", (91, 117), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (10, 10, 10), 2)
    ok, encoded = cv2.imencode(".png", image)
    assert ok
    return image, encoded.tobytes()


def test_auth_and_native_clean_roundtrip(tmp_path: Path):
    client = TestClient(main.app)
    assert client.get("/v1/state").status_code == 401
    source, png = make_page()
    opened = client.post("/v1/open", headers=HEADERS, files={"file": ("fixture.png", BytesIO(png), "image/png")})
    assert opened.status_code == 200, opened.text
    assert opened.json()["document"]["width"] == 300
    scanned = client.post("/v1/detect", headers=HEADERS, json={"provider": "opencv", "device": "cpu"})
    assert scanned.status_code == 200, scanned.text
    import time
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        current = client.get("/v1/state", headers=HEADERS).json()
        if current["job"]["status"] not in ("queued", "running"):
            break
        time.sleep(0.05)
    assert current["job"]["status"] == "done", current
    assert current["document"]["bubbles"]
    assert client.post("/v1/detect", headers=HEADERS, json={"provider": "opencv"}).status_code == 409
    identifier = current["document"]["bubbles"][0]["id"]
    reviewed = client.post(f"/v1/bubbles/{identifier}/review", headers=HEADERS, json={"decision": "Accepted", "kind": "Bubble"})
    assert reviewed.status_code == 200, reviewed.text

    preview = client.post("/v1/manual/preview", headers=HEADERS, json={"rect": [70, 78, 160, 63]})
    assert preview.status_code == 200, preview.text
    assert preview.json()["maskPixels"] > 0
    mask = cv2.imdecode(np.frombuffer(client.get("/v1/image/preview", headers=HEADERS).content, np.uint8), cv2.IMREAD_GRAYSCALE)
    assert mask.shape == source.shape[:2]
    assert not np.any(mask[:78])
    done = client.post("/v1/clean/confirm", headers=HEADERS, json={"previewId": preview.json()["id"], "method": "Telea Inpainting"})
    assert done.status_code == 200, done.text
    assert done.json()["result"]["outsideChangedPixels"] == 0
    working = cv2.imdecode(np.frombuffer(client.get("/v1/image/working", headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.any(working != source)
    assert np.array_equal(working[mask == 0], source[mask == 0])
    original = cv2.imdecode(np.frombuffer(client.get("/v1/image/original", headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(original, source)

    assert client.post("/v1/undo", headers=HEADERS).status_code == 200
    undone = cv2.imdecode(np.frombuffer(client.get("/v1/image/working", headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(undone, source)
    assert client.post("/v1/redo", headers=HEADERS).status_code == 200
    redone = cv2.imdecode(np.frombuffer(client.get("/v1/image/working", headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(redone, working)

    project = client.get("/v1/export/project", headers=HEADERS)
    assert project.status_code == 200, project.text
    saved = tmp_path / "copy.mangaclean"
    saved.write_bytes(project.content)
    assert saved.exists()
    reloaded = client.post("/v1/open?discard=true", headers=HEADERS, files={"file": ("copy.mangaclean", BytesIO(project.content), "application/octet-stream")})
    assert reloaded.status_code == 200, reloaded.text
    assert reloaded.json()["document"]["bubbles"][0]["id"] == identifier
    after = cv2.imdecode(np.frombuffer(client.get("/v1/image/working", headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(after, working)


def test_upload_requires_explicit_discard():
    client = TestClient(main.app)
    _, png = make_page()
    with main.store.lock:
        assert main.store.document is not None
        main.store.document.dirty = True
    response = client.post("/v1/open", headers=HEADERS, files={"file": ("another.png", BytesIO(png), "image/png")})
    assert response.status_code == 409


def test_websocket_session_and_origin():
    client = TestClient(main.app)
    with client.websocket_connect("/v1/progress", headers={"Origin": "http://tauri.localhost"},
                                  subprotocols=["yuchi", main.TOKEN]) as socket:
        assert socket.accepted_subprotocol == "yuchi"
        assert socket.receive_json() is None or isinstance(main.store.job, dict)


def test_verified_save_and_export():
    from mangaclean.services.project_io import load_project
    client = TestClient(main.app)
    source, png = make_page()
    response = client.post('/v1/open?discard=true', headers=HEADERS,
                           files={'file': ('save-fixture.png', BytesIO(png), 'image/png')})
    assert response.status_code == 200
    assert response.json()['document']['savedPath'] is None
    preview = client.post('/v1/manual/preview', headers=HEADERS, json={'rect': [70, 78, 160, 63]}).json()
    cleaned = client.post('/v1/clean/confirm', headers=HEADERS,
                          json={'previewId': preview['id'], 'method': 'Telea Inpainting'})
    assert cleaned.status_code == 200, cleaned.text
    original_save = main.save_project
    def fail_save(*args, **kwargs):
        raise OSError('Simulated write failure')
    main.save_project = fail_save
    try:
        failed = client.post('/v1/save/project', headers=HEADERS)
        assert failed.status_code == 500
        state = client.get('/v1/state', headers=HEADERS).json()['document']
        assert state['dirty'] and state['savedPath'] is None
    finally:
        main.save_project = original_save
    saved = client.post('/v1/save/project', headers=HEADERS)
    assert saved.status_code == 200, saved.text
    receipt = saved.json()
    path = Path(receipt['path'])
    assert path.resolve().is_relative_to(main.ROOT.resolve()) and path.is_file()
    assert receipt['verified'] and not receipt['state']['document']['dirty']
    assert receipt['state']['document']['savedPath'] == str(path)
    loaded = load_project(path)
    assert np.array_equal(loaded['source'], source)
    expected = loaded['clean'].copy()
    exported = client.post('/v1/save/png', headers=HEADERS)
    assert exported.status_code == 200, exported.text
    assert np.array_equal(cv2.imread(exported.json()['path']), expected)
    assert client.post('/v1/save/jpeg', headers=HEADERS).status_code == 200
    assert client.post('/v1/undo', headers=HEADERS).json()['document']['dirty']
    assert client.post('/v1/save/png', headers=HEADERS).json()['state']['document']['dirty']
    reopened = client.post('/v1/open?discard=true', headers=HEADERS,
                           files={'file': (path.name, BytesIO(path.read_bytes()), 'application/octet-stream')})
    assert reopened.status_code == 200
    assert reopened.json()['document']['savedPath'] is None
    actual = cv2.imdecode(np.frombuffer(client.get('/v1/image/working', headers=HEADERS).content, np.uint8), cv2.IMREAD_COLOR)
    assert np.array_equal(actual, expected)


def test_dynamic_origin():
    client = TestClient(main.app)
    if main.DEV_PORT and not main.FRONTEND_ORIGIN:
        origin = f'http://127.0.0.1:{int(main.DEV_PORT)}'
        response = client.options('/v1/state', headers={'Origin': origin, 'Access-Control-Request-Method': 'GET'})
        assert response.headers['access-control-allow-origin'] == origin
        with client.websocket_connect('/v1/progress', headers={'Origin': origin}, subprotocols=['yuchi', main.TOKEN]) as socket:
            socket.receive_json()
    denied = client.options('/v1/state', headers={'Origin': 'http://127.0.0.1:1420', 'Access-Control-Request-Method': 'GET'})
    assert 'access-control-allow-origin' not in denied.headers


def test_native_origin_validation():
    for origin in ('http://127.0.0.1:49173', 'http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'):
        assert main.is_local_frontend_origin(origin)
    for origin in ('null', '*', 'http://localhost:49173', 'http://127.0.0.1',
                   'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:49173/path',
                   'http://user@127.0.0.1:49173', 'https://example.com', 'http://127.0.0.1:49173?query'):
        assert not main.is_local_frontend_origin(origin), origin


def test_actual_native_origin_and_auth():
    client = TestClient(main.app)
    origin = main.FRONTEND_ORIGIN or 'http://tauri.localhost'
    preflight = client.options('/v1/state', headers={'Origin': origin,
        'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization'})
    assert preflight.status_code == 200
    assert preflight.headers['access-control-allow-origin'] == origin
    assert client.get('/v1/state', headers={'Origin': origin}).status_code == 401
    assert client.get('/v1/state', headers={'Origin': origin, 'Authorization': 'Bearer wrong-session'}).status_code == 401
    authenticated = client.get('/v1/state', headers={'Origin': origin, 'Authorization': f'Bearer {main.TOKEN}'})
    assert authenticated.status_code == 200
    assert authenticated.headers['access-control-allow-origin'] == origin
    with client.websocket_connect('/v1/progress', headers={'Origin': origin}, subprotocols=['yuchi', main.TOKEN]) as socket:
        socket.receive_json()
    if main.FRONTEND_ORIGIN and main.DEV_PORT:
        stale = f'http://127.0.0.1:{int(main.DEV_PORT)}'
        if stale != origin:
            assert stale not in main.ORIGINS


def test_no_document_manual_request_is_safe():
    client = TestClient(main.app)
    main.store.document = None
    response = client.post('/v1/manual/preview', headers=HEADERS, json={'rect': [10, 10, 50, 50]})
    assert response.status_code == 409
    assert client.get('/v1/state', headers=HEADERS).status_code == 200
