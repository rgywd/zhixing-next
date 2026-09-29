"""Publish immutable deliverables only after real file/format checks."""

import json
import shlex

from langchain_core.tools import tool

from .resources import capture_file


def create_artifact_tool(settings, run, sandbox, emit):
    @tool
    async def publish_artifact(path: str) -> dict:
        """Validate and publish a completed workspace file to the conversation as a downloadable artifact. Render documents and inspect their pages with view_image before publishing; structural checks do not prove visual quality."""
        relative = path.removeprefix("/workspace/")
        # Check host scope before running a validator or making a resource snapshot.
        from .files import read_file
        from .store import Store

        read_file(settings, Store(settings).workspace_for(run["conversation_id"]), relative)
        result = await sandbox.aexecute(
            "python /opt/zhixing/verify.py " + shlex.quote("/workspace/" + relative)
        )
        if result.exit_code:
            raise ValueError("Artifact validation failed: " + result.output[-2000:])
        verification = json.loads(result.output)
        resource = capture_file(settings, run["conversation_id"], relative)
        if verification["sha256"] != resource["sha256"]:
            raise ValueError("Artifact changed after validation; validate again")
        await emit("artifact", {"resource": resource, "verification": verification})
        return {"resource": resource, "verification": verification}

    return publish_artifact
