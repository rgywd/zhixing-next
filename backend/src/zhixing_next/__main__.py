"""Local development supervisor: real API and worker in separate processes."""

import argparse
import subprocess
import sys
import time

from .config import load_settings


def main():
    parser = argparse.ArgumentParser(description="Start the local Zhixing API and worker")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    if not load_settings().api_token:
        parser.error("Set ZHIXING_API_TOKEN before starting the service")
    children = []
    try:
        commands = [
            [sys.executable, "-m", "uvicorn", "zhixing_next.api:create_app", "--factory",
             "--host", "127.0.0.1", "--port", str(args.port), "--no-access-log"],
            [sys.executable, "-m", "zhixing_next.worker"],
        ]
        for command in commands:
            children.append(subprocess.Popen(command))
        print(f"知行 API: http://127.0.0.1:{args.port} (Ctrl+C stops API and worker)", flush=True)
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
        code = next(child.returncode for child in children if child.returncode is not None)
        raise SystemExit(code or 1)
    except KeyboardInterrupt:
        pass
    finally:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()


if __name__ == "__main__":
    main()
