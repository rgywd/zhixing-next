"""Snapshot explicitly configured skills before mounting them read-only."""

import hashlib
from pathlib import Path

from .resources import _atomic_write


def skill_bundle(settings):
    source = settings.execution.skills_dir
    if source is None:
        return None, None
    source = source.expanduser().resolve()
    if (
        not source.is_dir()
        or source == Path.home()
        or source == Path("/")
        or settings.data_dir.is_relative_to(source)
    ):
        raise ValueError("skills_dir must be a dedicated directory outside service data")
    files = []
    total = 0
    for path in sorted(source.rglob("*")):
        if path.is_symlink():
            raise ValueError("Skill bundles cannot contain symbolic links")
        if path.is_file():
            if len(files) >= 300 or path.stat().st_size > 1024 * 1024:
                raise ValueError("Skill bundle exceeds file limits")
            content = path.read_bytes()
            total += len(content)
            if total > 10 * 1024 * 1024:
                raise ValueError("Skill bundle exceeds 10 MiB")
            files.append((path.relative_to(source), content))
    if not any(path.name == "SKILL.md" and len(path.parts) == 2 for path, _ in files):
        raise ValueError("skills_dir needs a <skill-name>/SKILL.md entry")
    digest = hashlib.sha256()
    for path, content in files:
        digest.update(str(path).encode() + b"\0" + hashlib.sha256(content).digest())
    identifier = digest.hexdigest()
    target = settings.data_dir / "skill-bundles" / identifier
    for path, content in files:
        destination = target / path
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            _atomic_write(destination, content)
        elif destination.read_bytes() != content:
            raise ValueError("Saved skill bundle was modified")
    return target, identifier
