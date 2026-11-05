"""Observe unmodified baseline/Tauri workers without changing inference outputs."""
from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import sys


def main():
    import numpy as np
    import torch
    from ultralytics.data.augment import LetterBox
    from ultralytics.utils import nms

    plan = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    context = {}
    original_letterbox = LetterBox.__call__
    original_nms = nms.non_max_suppression

    def letterbox(self, *args, **kwargs):
        result = original_letterbox(self, *args, **kwargs)
        if isinstance(result, np.ndarray):
            context["letterbox_shape"] = list(result.shape)
            context["letterbox_sha256"] = hashlib.sha256(result.tobytes()).hexdigest()
        return result

    def observed_nms(prediction, *args, **kwargs):
        raw = prediction.detach().float().cpu().numpy().copy()
        np.savez_compressed(context["raw_path"], prediction=raw)
        context["raw_shape"] = list(raw.shape)
        context["raw_sha256"] = hashlib.sha256(raw.tobytes()).hexdigest()
        context["raw_above_confidence"] = int(np.count_nonzero(raw[:, 4, :] >= kwargs["conf_thres"]))
        context["nms_arguments"] = dict(kwargs)
        result = original_nms(prediction, *args, **kwargs)
        context["post_nms_count"] = int(len(result[0]))
        context["post_nms_sha256"] = hashlib.sha256(result[0].detach().cpu().numpy().tobytes()).hexdigest()
        return result

    LetterBox.__call__ = letterbox
    nms.non_max_suppression = observed_nms
    available = torch.cuda.is_available()
    devices = ["cpu"] + (["cuda:0"] if available else [])
    for side in ("baseline", "tauri"):
        root = Path(plan[side])
        spec = importlib.util.spec_from_file_location(f"{side}_worker", root / "scripts/yuchi_inference.py")
        worker = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(worker)
        for device in devices:
            for fixture in plan["fixtures"]:
                stem = f"{side}-{device.replace(':', '-')}-{Path(fixture).stem}"
                context.clear()
                context["raw_path"] = str(Path(plan["output"]) / f"{stem}-raw.npz")
                request = dict(plan["config"], input=fixture, device=device)
                result = worker.infer(request)
                result["audit"] = dict(context)
                (Path(plan["output"]) / f"{stem}.json").write_text(json.dumps(result), encoding="utf-8")
                print(json.dumps({"side": side, "device": device, "fixture": Path(fixture).name,
                                  "count": len(result["predictions"]), "predict_s": result["metadata"]["predict_s"]}), flush=True)
            worker.release_model()
        worker.release_model()
    print(json.dumps({"complete": True, "devices": devices}), flush=True)


if __name__ == "__main__":
    main()
