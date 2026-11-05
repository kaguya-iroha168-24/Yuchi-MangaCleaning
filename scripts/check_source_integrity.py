"""Verify that the read-only source files still match the migration baseline."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


BASELINE = {
    r"E:\BagassZx\Yuchi Labs\main.py": "8C541C5907D6392C8E72D68536C0CF196B31AEEB199C9321C8DE2419BAAC7E9F",
    r"E:\BagassZx\Yuchi Labs\configs\detection.json": "CB815F53AEE579F49245D8FFBD86172A2979299F603F711943796ED12D37A1C8",
    r"E:\BagassZx\Yuchi Labs\configs\ocr.json": "75D2157276C78E195F682777A2FDD3EACCA5A4D7E4B7A25FD1257A293388FEC6",
    r"E:\BagassZx\Yuchi Labs\mangaclean\services\cleaning_pipeline.py": "5BB6644DA51346CE4FD4360C140500649137A4724E64FA277C79D52D3C1F469F",
    r"E:\BagassZx\Yuchi Labs\page.mangaclean": "FF53D9BE71705F1A8220E27C8AFBF832E430F8B7D1236A072884D16292DB5822",
    r"E:\BagassZx\Models\MangaLens\best.pt": "4028152940F7C910F40192F46EDE3B3F6C7129E5C76849C324D3564F8AC50198",
}


def digest(path: Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest().upper()


def main() -> int:
    files = []
    for name, before in BASELINE.items():
        path = Path(name)
        after = digest(path) if path.is_file() else None
        files.append({"path": name, "before_sha256": before, "after_sha256": after, "unchanged": before == after})
    report = {
        "checked_at_utc": datetime.now(timezone.utc).isoformat(),
        "baseline_note": "Initial hashes were recorded before migration edits.",
        "all_unchanged": all(item["unchanged"] for item in files),
        "files": files,
    }
    destination = Path(r"E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\SOURCE_INTEGRITY.json")
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"all_unchanged": report["all_unchanged"], "checked": len(files), "report": str(destination)}))
    return 0 if report["all_unchanged"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
