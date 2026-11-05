"""Read a copy of the original v1 project and verify v2 round-trip state."""
from io import BytesIO
from pathlib import Path
import hashlib

import numpy as np
from fastapi.testclient import TestClient

from backend import main
from mangaclean.services.project_io import load_project


def check() -> None:
    fixture = Path(".cache/fixtures/legacy-copy.mangaclean")
    before_hash = hashlib.sha256(fixture.read_bytes()).hexdigest()
    source = load_project(fixture)
    client = TestClient(main.app)
    headers = {"Authorization": f"Bearer {main.TOKEN}", "Origin": "http://tauri.localhost"}
    opened = client.post("/v1/open?discard=true", headers=headers,
                         files={"file": ("legacy-copy.mangaclean", BytesIO(fixture.read_bytes()), "application/octet-stream")})
    assert opened.status_code == 200, opened.text
    assert [b.id for b in source["bubbles"]] == [b["id"] for b in opened.json()["document"]["bubbles"]]
    response = client.get("/v1/export/project", headers=headers)
    assert response.status_code == 200, response.text
    output = Path(".cache/fixtures/roundtrip-v2.mangaclean")
    output.write_bytes(response.content)
    loaded = load_project(output)
    assert np.array_equal(loaded["source"], source["source"])
    assert np.array_equal(loaded["clean"], source["clean"])
    assert np.array_equal(loaded["mask"], source["mask"])
    assert [b.id for b in loaded["bubbles"]] == [b.id for b in source["bubbles"]]
    assert [b.review_decision for b in loaded["bubbles"]] == [b.review_decision for b in source["bubbles"]]
    assert hashlib.sha256(fixture.read_bytes()).hexdigest() == before_hash
    print({"legacy_roundtrip": "passed", "bubbles": len(loaded["bubbles"]),
           "source_untouched": True, "output": str(output)})


if __name__ == "__main__":
    check()
