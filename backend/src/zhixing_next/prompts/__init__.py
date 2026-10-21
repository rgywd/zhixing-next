"""Product persona shared by the main and configured specialist assistants."""

from pathlib import Path

ZHIXING_BASE_PROMPT = Path(__file__).with_name("zhixing.md").read_text(encoding="utf-8").strip()
MEMORY_ORGANIZER_PROMPT = Path(__file__).with_name("memory.md").read_text(encoding="utf-8").strip()
