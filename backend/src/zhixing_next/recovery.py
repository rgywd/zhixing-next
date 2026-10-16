"""Read-only evidence that a failed run has a checkpoint of its own."""

import sqlite3

from langgraph.checkpoint.serde.jsonplus import JsonPlusSerializer


def has_run_checkpoint(settings, run):
    path = settings.data_dir / "checkpoints.sqlite"
    if not path.is_file():
        return False
    try:
        with sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) as db:
            row = db.execute(
                "SELECT type,checkpoint FROM checkpoints WHERE thread_id=? AND checkpoint_ns='' ORDER BY checkpoint_id DESC LIMIT 1",
                (run["conversation_id"],),
            ).fetchone()
        if row is None:
            return False
        checkpoint = JsonPlusSerializer().loads_typed(row)
        if not isinstance(checkpoint, dict):
            return False
        values = checkpoint.get("channel_values", {})
        return isinstance(values, dict) and values.get("active_run_id") == run["id"] and isinstance(values.get("recovery_fingerprint"), str) and bool(values["recovery_fingerprint"])
    except Exception:
        # Corrupt local recovery data must not prevent recording the failure.
        return False
