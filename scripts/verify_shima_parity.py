"""Freeze read-only source copies, then compare inference and domain adapters."""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
OLD = Path(r"E:\BagassZx\Yuchi Labs")
REPORT = Path(r"E:\BagassZx\Yuchi-Diagnostics\mangaclean-tauri-migration\shima-parity")
WORK = ROOT / ".cache/shima-parity"
ACTUAL = os.environ.get('YUCHI_PARITY_ACTUAL') == '1'
BASELINE_PYTHON = r'E:\BagassZx\DemoClean\.venv\Scripts\python.exe'


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def prepare():
    sys.path.insert(0, str(ROOT))
    import cv2
    from mangaclean.services.project_io import load_project
    from mangaclean.services.yuchi_process import detection_config
    baseline = WORK / "baseline"
    REPORT.mkdir(parents=True, exist_ok=True)
    WORK.mkdir(parents=True, exist_ok=True)
    paths = [p.relative_to(OLD) for p in (OLD / "mangaclean/core").glob("*.py")]
    paths += [Path("mangaclean/__init__.py"), Path("mangaclean/services/__init__.py"),
              *[Path("mangaclean/services") / name for name in
                ("detection.py", "yuchi_process.py", "cleaning_pipeline.py", "project_io.py", "image_io.py")],
              Path("scripts/yuchi_inference.py"), Path("configs/detection.json")]
    manifest = []
    for relative in paths:
        source = OLD / relative
        target = baseline / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists(): shutil.copy2(source, target)
        if digest(source) != digest(target): raise ValueError(f"Baseline snapshot mismatch: {relative}")
        manifest.append({"source": str(source), "snapshot": str(target), "sha256": digest(source),
                         "tauri_equal": (ROOT / relative).is_file() and digest(ROOT / relative) == digest(source)})
    (baseline / "ATTRIBUTION.txt").write_text("Controlled read-only snapshot of Yuchi Labs PySide6 domain and inference modules.\nOriginal attribution and source headers are preserved. No old application runtime is launched.\n", encoding="utf-8")
    config = detection_config("shima_v1")
    manifest.append({"source": config["checkpoint"], "sha256": digest(config["checkpoint"]), "checkpoint": True})
    original = load_project(ROOT / ".cache/fixtures/legacy-copy.mangaclean")["source"]
    fixtures = WORK / "fixtures"
    fixtures.mkdir(exist_ok=True)
    for name in ("page_009.png", "page_009-copy-a.png", "page_009-copy-b.png"):
        path = fixtures / name
        if not path.exists(): path.write_bytes(cv2.imencode(".png", original)[1].tobytes())
    plan = dict(baseline=str(baseline), tauri=str(ROOT), output=str(REPORT), config=config,
                fixtures=[str(p) for p in sorted(fixtures.glob("page_*.png"))])
    (WORK / "plan.json").write_text(json.dumps(plan, indent=2), encoding="utf-8")
    (REPORT / "SOURCE_SNAPSHOT.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(json.dumps({"prepared": True, "files": len(manifest), "fixtures": len(plan["fixtures"])}))


def domain(side, result_path, image_path, output):
    import cv2
    import numpy as np
    sys.path.insert(0, str(WORK / "baseline" if side == "baseline" else ROOT))
    from mangaclean.services import detection
    from mangaclean.services.yuchi_process import detection_config
    result = json.loads(Path(result_path).read_text(encoding="utf-8"))
    image = cv2.imread(image_path)
    detection.YuchiProcess.predict = lambda self, image: deepcopy(result)
    batch = detection.detect("shima_v1", image, image, config=detection_config("shima_v1"))
    entries, arrays = [], {}
    for index, bubble in enumerate(batch.bubbles):
        entries.append(dict(rect=list(bubble.rect), confidence=bubble.confidence, native=bubble.provenance["native_prediction_rect"],
                            review=bubble.review_decision, kind=bubble.candidate_kind))
        arrays[f"shape_{index}"] = bubble.full_segmentation(image.shape)
        arrays[f"text_{index}"] = bubble.text
        arrays[f"interior_{index}"] = bubble.interior
    Path(output).write_text(json.dumps(entries), encoding="utf-8")
    np.savez_compressed(str(output) + ".npz", **arrays)
    Path(str(output) + ".runtime.json").write_text(json.dumps({"python": sys.version, "opencv": cv2.__version__, "numpy": np.__version__}))


def compare():
    import cv2
    import numpy as np
    plan = json.loads((WORK / "plan.json").read_text())
    rows = []
    for baseline_file in sorted(REPORT.glob("baseline-*.json")):
        if not re.fullmatch(r'baseline-(cpu|cuda-0)-page_[\w-]+\.json', baseline_file.name): continue
        suffix = baseline_file.name.removeprefix("baseline-")
        target_file = REPORT / ("tauri-" + suffix)
        a = json.loads(baseline_file.read_text()); b = json.loads(target_file.read_text())
        image_name = suffix.split("-page_", 1)[1].removesuffix(".json")
        fixture = str(WORK / "fixtures" / ("page_" + image_name + ".png"))
        raw_a = np.load(a["audit"]["raw_path"])["prediction"]
        raw_b = np.load(b["audit"]["raw_path"])["prediction"]
        max_box = max((abs(x-y) for pa,pb in zip(a["predictions"], b["predictions"]) for x,y in zip(pa["xyxy"],pb["xyxy"])), default=0)
        mask_diff = 0
        for pa, pb in zip(a["predictions"], b["predictions"]):
            if pa["mask_bounds"] != pb["mask_bounds"]: mask_diff += 1; continue
            if pa["mask_png"] != pb["mask_png"]:
                aa=cv2.imdecode(np.frombuffer(base64.b64decode(pa["mask_png"]),np.uint8),0)
                bb=cv2.imdecode(np.frombuffer(base64.b64decode(pb["mask_png"]),np.uint8),0)
                mask_diff += int(np.count_nonzero(aa != bb))
        outputs = []
        for side, result in (("baseline",baseline_file),("tauri",target_file)):
            output = REPORT / (f"{side}-{suffix}.actual-domain" if ACTUAL else f"{side}-{suffix}.domain")
            subprocess.run([BASELINE_PYTHON if ACTUAL and side == "baseline" else sys.executable,"-B",str(Path(__file__).resolve()),"domain",side,str(result),fixture,str(output)], cwd=ROOT, check=True)
            outputs.append(output)
        da, db = (json.loads(p.read_text()) for p in outputs)
        arrays_a, arrays_b = (np.load(str(p)+".npz") for p in outputs)
        adapted_diff = sum(int(np.count_nonzero(arrays_a[k] != arrays_b[k])) for k in arrays_a.files)
        row = dict(case=suffix.removesuffix(".json"), raw_shape=a["audit"]["raw_shape"],
                   raw_above_confidence=a["audit"]["raw_above_confidence"], post_nms=len(a["predictions"]),
                   raw_max_abs=float(np.max(np.abs(raw_a-raw_b))), native_box_max_abs=max_box,
                   container_mask_different_pixels=mask_diff, adapter_different_pixels=adapted_diff,
                   adapter_candidates_equal=da==db, displayed_count=len(db),
                   letterbox_equal=a["audit"]["letterbox_sha256"]==b["audit"]["letterbox_sha256"],
                   settings={k:a["metadata"][k] for k in ("checkpoint_sha256","confidence","iou","image_size","device","precision")})
        row["passed"] = (row["raw_max_abs"]==0 and max_box==0 and mask_diff==0 and adapted_diff==0 and da==db
                         and row["letterbox_equal"] and len(a["predictions"])==len(b["predictions"])==len(db))
        rows.append(row)
    if not rows: raise ValueError("No completed inference cases to compare")
    protected = json.loads((REPORT / "SOURCE_SNAPSHOT.json").read_text())
    unchanged = all(digest(item["source"])==item["sha256"] for item in protected)
    report = dict(all_passed=all(r["passed"] for r in rows), source_unchanged=unchanged, cases=rows,
                  note="Raw values are observed before NMS. Post-NMS predictions, domain candidates, and UI payload are distinct stages. No candidate is classified as false positive by this comparison.")
    (REPORT / ("DETECTION_PARITY_ACTUAL_RUNTIME.json" if ACTUAL else "DETECTION_PARITY.json")).write_text(json.dumps(report,indent=2),encoding="utf-8")
    print(json.dumps(report))
    if not report["all_passed"] or not unchanged: raise SystemExit(1)


if __name__ == "__main__":
    command = sys.argv[1]
    if command == "prepare": prepare()
    elif command == "compare": compare()
    elif command == "domain": domain(*sys.argv[2:])
