"""Bounded process supervisor, run only inside the disposable sandbox."""

import json
import os
import selectors
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path("/tmp/zhixing-processes")
LIMIT = 65536


def save(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value))
    temporary.replace(path)


def supervise(identifier, command, timeout):
    folder = ROOT / identifier
    stopped = False

    def stop(*_):
        nonlocal stopped
        stopped = True

    signal.signal(signal.SIGTERM, stop)
    process = subprocess.Popen(
        command,
        shell=True,
        start_new_session=True,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started = time.monotonic()
    state = "running"
    output = bytearray()
    total = 0
    save(
        folder / "state.json",
        {"pid": os.getpid(), "state": state, "exit_code": None, "truncated": False},
    )
    while process.poll() is None or selector.get_map():
        if stopped or time.monotonic() - started >= timeout:
            state = "stopped" if stopped else "timed_out"
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        for key, _ in selector.select(0.1):
            data = os.read(key.fd, 8192)
            if data:
                total += len(data)
                output.extend(data)
                del output[:-LIMIT]
                (folder / "output").write_bytes(output)
            else:
                selector.unregister(key.fileobj)
        if state != "running" and process.poll() is not None:
            break
    code = process.wait()
    # A shell can exit while a descendant remains alive with closed output.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    save(
        folder / "state.json",
        {
            "pid": os.getpid(),
            "state": "completed" if state == "running" else state,
            "exit_code": code,
            "truncated": total > LIMIT,
        },
    )


def main():
    action, identifier = sys.argv[1:3]
    if not identifier.isalnum():
        raise ValueError("Invalid process identifier")
    folder = ROOT / identifier
    if action == "supervise":
        data = json.loads(sys.stdin.read())
        supervise(identifier, data["command"], data["timeout"])
        return
    if action == "start":
        folder.mkdir(parents=True, exist_ok=False)
        data = sys.stdin.buffer.read()
        save(folder / "state.json", {"state": "starting", "exit_code": None})
        child = subprocess.Popen(
            [sys.executable, __file__, "supervise", identifier],
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        child.stdin.write(data)
        child.stdin.close()
    elif action == "stop":
        state = json.loads((folder / "state.json").read_text())
        if state["state"] == "running":
            try:
                os.kill(state["pid"], signal.SIGTERM)
            except ProcessLookupError:
                pass
    state = json.loads((folder / "state.json").read_text())
    raw = (folder / "output").read_bytes() if (folder / "output").exists() else b""
    state["output"] = raw[-8000:].decode(errors="replace")
    state["truncated"] = state.get("truncated", False) or len(raw) > 8000
    print(json.dumps(state))


if __name__ == "__main__":
    main()
