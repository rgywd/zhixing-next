"""A successful text read delivers the entire bounded file, including its end."""

import pytest

from zhixing_next.config import Settings
from zhixing_next.tool_errors import ToolFailure
from zhixing_next.tools import MAX_FILE_BYTES, create_file_tools


def text_reader(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    settings = Settings(data_dir=tmp_path / "state", workspace_root=workspace)
    reader = next(tool for tool in create_file_tools(settings, workspace) if tool.name == "read_text_file")
    return workspace, reader


@pytest.mark.parametrize("size", [0, 13, MAX_FILE_BYTES])
def test_complete_file_receipt_has_no_missing_tail_or_continuation(tmp_path, size):
    workspace, reader = text_reader(tmp_path)
    # Multibyte first/last characters exercise the byte limit and prevent a
    # prefix-only reader from accidentally passing a content-size check.
    content = "首" + "x" * (size - 6) + "尾" if size else ""
    (workspace / "evidence.txt").write_text(content, encoding="utf-8")
    receipt = reader.invoke({"path": "evidence.txt"})
    assert receipt["content"] == content
    assert receipt["bytes"] == size
    assert receipt["complete"] is True and receipt["truncated"] is False
    assert receipt["next_start"] is None


def test_oversized_utf8_text_fails_instead_of_pretending_a_prefix_is_complete(tmp_path):
    workspace, reader = text_reader(tmp_path)
    # Fewer than 256K characters can still exceed the 256KiB byte bound.
    (workspace / "large.txt").write_text("字" * (MAX_FILE_BYTES // 3 + 1), encoding="utf-8")
    with pytest.raises(ToolFailure) as error:
        reader.invoke({"path": "large.txt"})
    assert error.value.receipt["code"] == "file_too_large"
    assert not error.value.receipt["retryable"]


def test_model_visible_text_reader_has_only_a_path_and_no_paging_contract(tmp_path):
    _, reader = text_reader(tmp_path)
    assert set(reader.args_schema.model_fields) == {"path"}
    assert "there are no pages or continuation arguments" in reader.description
    assert "Oversized files fail without returning a partial file" in reader.description
