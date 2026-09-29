"""Run-local Playwright session. Communication stays inside the execution container."""

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

SOCKET = "/tmp/zhixing-browser.sock"


def serve():
    from playwright.sync_api import sync_playwright

    Path("/tmp/home").mkdir(exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, args=["--disable-dev-shm-usage"])
        context = browser.new_context(
            accept_downloads=True, viewport={"width": 1280, "height": 900}
        )
        page = context.new_page()
        page.set_default_timeout(15000)
        server = socket.socket(socket.AF_UNIX)
        server.bind(SOCKET)
        os.chmod(SOCKET, 0o600)
        server.listen(4)
        downloads = Path("/workspace/downloads")
        downloads.mkdir(exist_ok=True)
        while True:
            connection, _ = server.accept()
            with connection, connection.makefile("rwb") as stream:
                try:
                    request = json.loads(stream.readline(65536))
                    action = request["action"]
                    if action == "navigate":
                        from urllib.parse import urlsplit

                        parsed = urlsplit(request["url"])
                        assert (
                            parsed.scheme in {"http", "https"}
                            and parsed.hostname
                            and not parsed.username
                            and not parsed.password
                        ), "Use an HTTP(S) URL without credentials"
                        page.goto(request["url"], wait_until="domcontentloaded")
                    elif action == "click":
                        page.locator(request["selector"]).click()
                    elif action == "fill":
                        page.locator(request["selector"]).fill(request["text"])
                    elif action == "download":
                        with page.expect_download() as event:
                            page.locator(request["selector"]).click()
                        download = event.value
                        from uuid import uuid4

                        target = downloads / (
                            uuid4().hex + "-" + Path(download.suggested_filename).name
                        )
                        download.save_as(target)
                    elif action not in {"snapshot", "screenshot"}:
                        raise ValueError("Unknown browser action")
                    screenshot = "/workspace/browser-preview.png"
                    page.screenshot(path=screenshot, full_page=False)
                    result = {
                        "url": page.url,
                        "title": page.title(),
                        "snapshot": page.locator("body").aria_snapshot()[:8000],
                        "text": page.locator("body").inner_text()[:6000],
                        "screenshot": screenshot,
                    }
                    if action == "download":
                        result["download"] = str(target)
                    stream.write((json.dumps(result, ensure_ascii=False) + "\n").encode())
                except Exception as exc:
                    stream.write((json.dumps({"error": str(exc)[:1500]}) + "\n").encode())
                stream.flush()


def request(payload):
    if not Path(SOCKET).exists():
        subprocess.Popen(
            [sys.executable, __file__, "--serve"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
    deadline = time.monotonic() + 15
    while not Path(SOCKET).exists():
        if time.monotonic() > deadline:
            raise RuntimeError("Browser failed to start")
        time.sleep(0.1)
    with socket.socket(socket.AF_UNIX) as client:
        client.settimeout(45)
        client.connect(SOCKET)
        client.sendall((payload + "\n").encode())
        with client.makefile("rb") as stream:
            print(stream.readline(262144).decode())


if __name__ == "__main__":
    if sys.argv[1] == "--serve":
        serve()
    else:
        request(sys.argv[1])
