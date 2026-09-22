"""Avoid the multi-connection WAL reset race on older bundled SQLite runtimes."""

import sqlite3


def safe_journal_mode(version: tuple[int, int, int] | None = None) -> str:
    version = version or sqlite3.sqlite_version_info
    patched = (
        version >= (3, 51, 3)
        or (3, 50, 7) <= version < (3, 51, 0)
        or (3, 44, 6) <= version < (3, 45, 0)
    )
    return "WAL" if patched else "DELETE"
