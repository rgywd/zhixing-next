"""Curated tool failures: useful repair instructions without raw inputs or secrets."""

from __future__ import annotations


class ToolFailure(ValueError):
    """Only application-authored messages may enter this model-visible receipt."""

    def __init__(self, code: str, message: str, next_action: str, *, retryable: bool = False):
        super().__init__(message)
        self.receipt = {
            "code": code,
            "message": message,
            "next_action": next_action,
            "retryable": retryable,
        }


FILE_TOOLS = {"list_directory", "read_text_file", "read_document", "read_saved_resource", "write_text_file", "copy_file"}


def safe_tool_failure(exc: Exception, tool_name: str) -> dict | None:
    """Classify known failures by type; never copy arbitrary exception text."""
    if isinstance(exc, ToolFailure):
        return exc.receipt
    if tool_name not in FILE_TOOLS:
        return None
    if isinstance(exc, FileNotFoundError):
        return ToolFailure("file_not_found", "The requested file or parent directory does not exist.",
                           "Use list_directory to find an existing workspace path, or find_resources and read_saved_resource for a saved upload.").receipt
    if isinstance(exc, IsADirectoryError):
        return ToolFailure("file_required", "The selected path is a directory.",
                           "Use list_directory, then select a file from its entries.").receipt
    if isinstance(exc, NotADirectoryError):
        return ToolFailure("directory_required", "A file was selected where a directory is required.",
                           "List the containing directory or read the file with read_text_file/read_document.").receipt
    if isinstance(exc, PermissionError):
        return ToolFailure("file_access_denied", "The path is outside this tool's permitted scope or is a protected/linked file.",
                           "Use an ordinary file in the current workspace, or find_resources/read_saved_resource for this user's uploads. Do not try service databases or credential paths.").receipt
    if isinstance(exc, UnicodeDecodeError):
        return ToolFailure("text_encoding_unsupported", "This file is not valid UTF-8 text.",
                           "Use read_document for PDF/DOCX, view_image when available for images, or obtain a UTF-8 text copy. Do not treat binary bytes as text.").receipt
    if isinstance(exc, FileExistsError):
        return ToolFailure("file_exists", "A file already exists at the destination; no replacement was made.",
                           "Choose a new filename, or set overwrite=true only when replacing this file is intended.").receipt
    return ToolFailure("file_operation_failed", "The file operation could not be completed.",
                       "Check the selected file's format and workspace location. Use read_document for PDF/DOCX or read_saved_resource for a saved upload; do not repeat unchanged inputs.").receipt
