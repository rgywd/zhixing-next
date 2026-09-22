import io
import os
import zipfile

import pytest

from zhixing_next.config import PathGrant, Settings
from zhixing_next.tools import MAX_FILE_BYTES, FileAccess, capability_status


def test_physical_file_grants_and_atomic_writes(tmp_path):
    workspace = tmp_path / "data" / "workspaces" / "project"
    workspace.mkdir(parents=True)
    reference = tmp_path / "reference"
    reference.mkdir()
    (reference / "notes.txt").write_text("source", encoding="utf-8")
    export = tmp_path / "export"
    export.mkdir()
    settings = Settings(
        data_dir=tmp_path / "data",
        workspace_root=workspace.parent,
        grants=[PathGrant(path=reference), PathGrant(path=export, writable=True)],
    )
    access = FileAccess(settings, workspace)
    assert access.read_text(str(reference / "notes.txt"))["content"] == "source"
    with pytest.raises(PermissionError):
        access.write_text(str(reference / "notes.txt"), "not allowed", overwrite=True)
    access.write_text("result.txt", "hello")
    with pytest.raises(FileExistsError):
        access.write_text("result.txt", "lost update")
    access.write_text("result.txt", "updated", overwrite=True)
    assert access.read_text("result.txt")["content"] == "updated"
    access.write_text(str(export / "result.txt"), "artifact")
    assert (export / "result.txt").read_text() == "artifact"
    assert not list(workspace.glob(".zhixing-*.tmp"))
    assert not capability_status(settings)["execution_available"]


def test_denies_private_data_traversal_and_oversize(tmp_path):
    workspace = tmp_path / "data" / "workspaces" / "project"
    workspace.mkdir(parents=True)
    config = tmp_path / "service.toml"
    config.write_text("private")
    settings = Settings(
        data_dir=tmp_path / "data",
        workspace_root=workspace.parent,
        config_file=config,
        grants=[PathGrant(path=tmp_path, writable=True)],
    )
    access = FileAccess(settings, workspace)
    for forbidden in [
        "../other.txt",
        ".env",
        ".env.production",
        ".ssh/id_ed25519",
        str(config),
        str(settings.data_dir / "app.sqlite"),
        "secret.pem",
    ]:
        with pytest.raises(PermissionError):
            access.write_text(forbidden, "denied")
    with pytest.raises(ValueError):
        access.write_text("large.txt", "x" * (MAX_FILE_BYTES + 1))
    (workspace / "large.txt").write_bytes(b"x" * (MAX_FILE_BYTES + 1))
    with pytest.raises(ValueError):
        access.read_text("large.txt")
    (workspace / ".env").write_text("secret")
    assert ".env" not in {entry["name"] for entry in access.list_directory()["entries"]}
    if os.name == "nt":
        for alias in [".npmrc.", "credentials.json ", "NUL", "file.txt:secret"]:
            with pytest.raises(PermissionError):
                access.read_text(alias)


def test_denies_hardlinks_and_symlink_escape(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("ungranted")
    access = FileAccess(Settings(data_dir=tmp_path / "data", workspace_root=workspace), workspace)
    os.link(outside, workspace / "hard.txt")
    with pytest.raises(PermissionError):
        access.read_text("hard.txt")
    try:
        (workspace / "symlink.txt").symlink_to(outside)
    except OSError:
        return  # Windows hosts without symlink privilege still exercise hardlink denial.
    with pytest.raises(PermissionError):
        access.read_text("symlink.txt")
    with pytest.raises(PermissionError):
        access.write_text("symlink.txt", "overwrite outside", overwrite=True)
    assert outside.read_text() == "ungranted"


def test_docx_extraction_pagination_and_archive_limits(tmp_path):
    workspace = tmp_path / "project"
    workspace.mkdir()
    access = FileAccess(Settings(data_dir=tmp_path / "data", workspace_root=workspace), workspace)
    with zipfile.ZipFile(
        workspace / "notes.docx", "w", compression=zipfile.ZIP_DEFLATED
    ) as archive:
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>first</w:t></w:r></w:p><w:p><w:r><w:t>second</w:t></w:r></w:p></w:body></w:document>',
        )
    result = access.read_document("notes.docx", start=2, count=1)
    assert result["unit"] == "paragraph" and result["total_units"] == 2
    assert result["items"] == [{"number": 2, "text": "second", "truncated": False}]
    assert result["next_start"] is None
    with zipfile.ZipFile(workspace / "bomb.docx", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"x" * (5 * 1024 * 1024 + 1))
    with pytest.raises(ValueError):
        access.read_document("bomb.docx")


def test_pdf_extraction_has_page_evidence_and_ocr_limit(tmp_path):
    from pypdf import PdfWriter
    from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

    workspace = tmp_path / "project"
    workspace.mkdir()
    writer = PdfWriter()
    page = writer.add_blank_page(width=300, height=300)
    page[NameObject("/Resources")] = DictionaryObject(
        {
            NameObject("/Font"): DictionaryObject(
                {
                    NameObject("/F1"): DictionaryObject(
                        {
                            NameObject("/Type"): NameObject("/Font"),
                            NameObject("/Subtype"): NameObject("/Type1"),
                            NameObject("/BaseFont"): NameObject("/Helvetica"),
                        }
                    )
                }
            )
        }
    )
    stream = DecodedStreamObject()
    stream.set_data(b"BT /F1 12 Tf 10 250 Td (PDF evidence) Tj ET")
    page[NameObject("/Contents")] = writer._add_object(stream)
    writer.add_blank_page(width=300, height=300)
    data = io.BytesIO()
    writer.write(data)
    access = FileAccess(Settings(data_dir=tmp_path / "data", workspace_root=workspace), workspace)
    access.write_bytes("source.pdf", data.getvalue())
    result = access.read_document("source.pdf")
    assert result["unit"] == "page" and result["total_units"] == 2
    assert result["items"][0]["text"] == "PDF evidence"
    assert result["items"][1]["text"] == ""
    assert "OCR" in result["note"]
