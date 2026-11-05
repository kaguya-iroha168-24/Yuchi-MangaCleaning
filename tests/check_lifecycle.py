"""Check authenticated dynamic-port startup and graceful backend cleanup."""
import os
from pathlib import Path
import secrets
import socket
import subprocess
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def check() -> None:
    root = Path(__file__).resolve().parents[1]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token = secrets.token_urlsafe(32)
    env = os.environ.copy()
    cache = root / ".cache"
    env.update(YUCHI_TAURI_TOKEN=token, PYTHONPYCACHEPREFIX=str(cache / "pycache"),
               TEMP=str(cache / "tmp"), TMP=str(cache / "tmp"))
    flags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    log_path = cache / "lifecycle-probe.log"
    log = log_path.open("w", encoding="utf-8")
    process = subprocess.Popen([sys.executable, "-B", "-m", "backend.main", "--port", str(port)],
                               cwd=root, env=env, creationflags=flags, stdout=log, stderr=subprocess.STDOUT)
    base = f"http://127.0.0.1:{port}"
    try:
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise AssertionError(f"Backend exited early: {log_path.read_text(encoding='utf-8')[-2000:]}")
            try:
                response = urlopen(Request(base + "/v1/health", headers={"Authorization": "Bearer " + token}), timeout=1)
                assert b'"identity":"Yuchi Labs Tauri"' in response.read()
                break
            except (URLError, TimeoutError):
                time.sleep(.1)
        else:
            raise AssertionError(f"Backend did not become healthy: {log_path.read_text(encoding='utf-8')[-2000:]}")
        try:
            urlopen(Request(base + "/v1/shutdown", method="POST"), timeout=2)
            raise AssertionError("Unauthenticated shutdown succeeded")
        except HTTPError as error:
            assert error.code == 401
        response = urlopen(Request(base + "/v1/shutdown", method="POST", headers={"Authorization": "Bearer " + token}), timeout=2)
        assert response.status == 200
        assert process.wait(timeout=8) == 0
        print({"lifecycle": "passed", "dynamic_port": True, "unauthorized_shutdown": 401, "graceful_exit": 0})
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        log.close()


if __name__ == "__main__":
    check()
