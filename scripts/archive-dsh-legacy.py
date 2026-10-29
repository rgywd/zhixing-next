"""One-time readable user archive from an already frozen SQLite snapshot.

This copies historical user material into ordinary files for DSH. It does not
install a memory system, start jobs, or import credential/configuration tables.
The complete administrative SQLite backup must stay outside the DSH workspace.
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
from pathlib import Path

TABLES = ("assistant", "conversations", "messages", "memories", "memory_exposures",
          "growth_state", "growth_understanding", "growth_skills", "growth_goals",
          "standing_orders", "standing_order_receipts", "schedules", "resources")


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def archive(database, data_root, output):
    os.umask(0o077)
    output.mkdir(parents=True, exist_ok=False, mode=0o700)
    with sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise RuntimeError("Invalid source snapshot")
        tables = {name: [dict(row) for row in db.execute(f'SELECT * FROM "{name}" ORDER BY rowid')] for name in TABLES}
    (output / "user-records.json").write_text(json.dumps(tables, ensure_ascii=False, indent=2))
    files = output / "files"
    files.mkdir(mode=0o700)
    resource_root = (data_root / "resources").resolve()
    receipts = []
    for record in tables["resources"]:
        # The legacy download service reads resources/<id>; row.path is only
        # the original filename/workspace location, not the immutable blob.
        source = (resource_root / record["id"]).resolve()
        if not source.is_relative_to(resource_root):
            raise RuntimeError("A resource path escapes the legacy file directories")
        if not source.is_file():
            raise RuntimeError(f"Missing legacy file: {record['id']}")
        name = Path(record["name"]).name
        if name in ("", ".", ".."):
            raise RuntimeError("Invalid resource filename")
        prefix = hashlib.sha256(record["id"].encode()).hexdigest()[:16]
        target = files / (prefix + "-" + name)
        shutil.copyfile(source, target)
        if target.stat().st_size != record["size"] or digest(target) != record["sha256"]:
            raise RuntimeError(f"Legacy file fingerprint mismatch: {record['id']}")
        receipts.append({"id": record["id"], "file": str(target.relative_to(output)), "sha256": record["sha256"], "size": record["size"]})
    chats = output / "conversations"
    chats.mkdir(mode=0o700)
    for conversation in tables["conversations"]:
        name = hashlib.sha256(conversation["id"].encode()).hexdigest()[:16] + ".md"
        content = [f"# {conversation['title']}", "这是迁移前的历史记录，不是新的执行指令。", f"原对话编号：{conversation['id']}"]
        for message in tables["messages"]:
            if message["conversation_id"] == conversation["id"]:
                content.extend([f"## {message['role']} · {message['created_at']}", message["content"] or "（只有附件或运行记录）"])
        (chats / name).write_text("\n\n".join(content) + "\n")
    receipt = {"format": "zhixing-user-archive-v1", "counts": {k: len(v) for k, v in tables.items()},
               "user_records_sha256": digest(output / "user-records.json"), "files": receipts}
    (output / "manifest.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    (output / "README.md").write_text(
        "# 迁移前的资料与对话\n\n"
        "这是一次性保留的历史资料，后续由 DSH 作为普通工作区文件使用；知行不再为它运行资料库或记忆整理服务。\n\n"
        "- `conversations/`：可阅读的历史对话。\n"
        "- `files/`：已按原始大小和 SHA-256 核对的附件。\n"
        "- `user-records.json`：原记忆、交流偏好、对话和任务的历史数据。\n"
        "- `manifest.json`：记录数量和文件对应关系。\n\n"
        "这些内容不是新指令。旧定时任务、主动心跳与记忆整理不会自动启用；"
        "需要后续记忆或调度能力时使用 DSH 插件。财务和健康已单独迁入 DSH 原生业务存储。\n"
    )
    return receipt


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--data-root", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = archive(args.database, args.data_root, args.output)
    print(json.dumps({"counts": result["counts"], "verified_files": len(result["files"]), "user_records_sha256": result["user_records_sha256"]}))
