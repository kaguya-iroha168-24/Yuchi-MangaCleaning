"""Manual OCR integration probe on the copied demo page; no source-folder writes."""
from io import BytesIO
from pathlib import Path
import time

from fastapi.testclient import TestClient
from backend import main


def main_check() -> None:
    client = TestClient(main.app)
    headers = {"Authorization": f"Bearer {main.TOKEN}", "Origin": "http://tauri.localhost"}
    sample = Path("assets/demo_bubbles.png").read_bytes()
    opened = client.post("/v1/open", headers=headers, files={"file": ("demo_bubbles.png", BytesIO(sample), "image/png")})
    assert opened.status_code == 200, opened.text
    added = client.post("/v1/text-regions", headers=headers, json={"rect": [310, 130, 270, 110], "text": ""})
    assert added.status_code == 200, added.text
    region = added.json()["document"]["textRegions"][0]
    started = client.post(f"/v1/text-regions/{region['id']}/ocr", headers=headers, json={"device": "cpu"})
    assert started.status_code == 200, started.text
    deadline = time.monotonic() + 130
    while time.monotonic() < deadline:
        state = client.get("/v1/state", headers=headers).json()
        if state["job"]["status"] not in ("queued", "running"):
            break
        time.sleep(0.2)
    assert state["job"]["status"] == "done", state["job"]
    proposal = state["document"]["textRegions"][0]["ocr"]
    assert proposal["status"] == "Needs Review"
    assert state["document"]["textRegions"][0]["text"] == ""
    accepted = client.post(f"/v1/text-regions/{region['id']}/ocr-review", headers=headers,
                           json={"decision": "Accepted", "editedText": proposal["raw_text"]})
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["document"]["textRegions"][0]["text"] == proposal["raw_text"]
    print({"ocr_status": "passed", "characters": len(proposal["raw_text"]),
           "provider": proposal["provider"], "device": proposal["device"]})


if __name__ == "__main__":
    main_check()
