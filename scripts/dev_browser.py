"""Development browser harness; children and caches stay inside this workspace."""
from __future__ import annotations

import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
TEMP = CACHE / "tmp"
TEMP.mkdir(exist_ok=True)


def stop(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()


def main() -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        frontend_port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = os.environ.copy()
    env.update(YUCHI_TAURI_TOKEN=token, VITE_YUCHI_TOKEN=token, YUCHI_DEV_PORT=str(frontend_port),
               VITE_YUCHI_API=f"http://127.0.0.1:{port}",
               npm_config_cache=str(CACHE / "npm"), TEMP=str(TEMP), TMP=str(TEMP),
               PYTHONPYCACHEPREFIX=str(CACHE / "pycache"),
               YUCHI_LABS_SETTINGS_DIR=str(CACHE / "settings"))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    backend = subprocess.Popen([sys.executable, "-B", "-m", "backend.main", "--port", str(port)],
                               cwd=ROOT, env=env, creationflags=flags)
    frontend = subprocess.Popen(["npm.cmd" if os.name == "nt" else "npm", "run", "dev", "--", "--port", str(frontend_port), "--strictPort"],
                                cwd=ROOT, env=env, creationflags=flags)
    print(f"Browser preview: http://127.0.0.1:{frontend_port}/", flush=True)
    try:
        while backend.poll() is None and frontend.poll() is None:
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop(frontend)
        stop(backend)


if __name__ == "__main__":
    main()
