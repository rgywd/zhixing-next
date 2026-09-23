"""Install deployment credentials from stdin without printing or storing a copy."""

import json
import os
import re
import sys
import tempfile
from pathlib import Path

DESTINATION = Path("/etc/zhixing-next/service.env")
SAFE_VALUE = re.compile(r"[A-Za-z0-9._~:/+\-]+\Z")


def main() -> None:
    if os.geteuid() != 0:
        raise SystemExit("Run as root")
    values = json.load(sys.stdin)
    if set(values) != {"api_key", "api_token"}:
        raise SystemExit("Expected api_key and api_token")
    api_key, api_token = values["api_key"], values["api_token"]
    if not all(isinstance(value, str) and SAFE_VALUE.fullmatch(value) for value in values.values()):
        raise SystemExit("Credentials contain unsupported characters")
    if len(api_key) < 8 or len(api_token) < 24:
        raise SystemExit("Credentials are too short")
    content = (
        f"ZHIXING_BAILIAN_API_KEY={api_key}\n"
        f"ZHIXING_API_TOKEN={api_token}\n"
    )
    os.umask(0o077)
    temporary_name = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="ascii", dir=DESTINATION.parent, delete=False
        ) as temporary:
            temporary_name = temporary.name
            temporary.write(content)
            temporary.flush()
            os.fsync(temporary.fileno())
        os.chmod(temporary_name, 0o600)
        os.replace(temporary_name, DESTINATION)
    finally:
        if temporary_name is not None:
            Path(temporary_name).unlink(missing_ok=True)
    print("Credentials installed with mode 0600")


if __name__ == "__main__":
    main()
