"""One-time, WAL-safe legacy export. Does not start a Python service or change the source.

python3 scripts/export-dsh-business.py --database /path/app.sqlite --output /private/path/business.json
The adjacent .sqlite snapshot preserves all legacy data, including retired features.
"""
import argparse
import hashlib
import json
import os
import sqlite3
from pathlib import Path

TABLES = ["finance_observations", "finance_budgets", "finance_transactions", "finance_mutations", "health_state",
          "health_rules", "health_meals", "health_weights", "health_steps", "health_recommendations",
          "health_feedback", "health_writes", "health_mutations", "life_events", "life_receipts"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    os.umask(0o077)
    target = args.output.resolve()
    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    snapshot = target.with_suffix(".sqlite")
    if target.exists() or snapshot.exists():
        parser.error("Use a new destination; existing backups are never overwritten")
    with (
        sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as source,
        sqlite3.connect(snapshot) as backup,
    ):
        source.backup(backup)
    with sqlite3.connect(snapshot) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Snapshot integrity check failed")
        tables = {name: [dict(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY rowid')] for name in TABLES}
        columns = {row["name"] for row in db.execute("PRAGMA table_info(finance_transactions)")}
        if not {"date_precision", "date_start", "date_end", "coverage_start", "coverage_end"} <= columns:
            raise RuntimeError("Upgrade an isolated snapshot with the archived backend migrations before exporting")
        canonical = json.dumps(tables, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(canonical.encode()).hexdigest()
        output = {"format": "zhixing-business-export-v1", "tables": tables, "sha256": digest,
                  "counts": {name: len(rows) for name, rows in tables.items()}, "source_schema": db.execute("PRAGMA user_version").fetchone()[0]}
        with target.open("x") as file:
            json.dump(output, file, ensure_ascii=False)
    print(json.dumps({"snapshot": str(snapshot), "export": str(target), "sha256": digest, "counts": output["counts"]}))


if __name__ == "__main__":
    main()
