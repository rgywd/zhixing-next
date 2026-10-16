"""Tag-only Android release gates, private signing, and draft-first publication.

No GitHub API writes occur until the explicit ``publish`` command. Signing inputs
are environment-only and are removed from the build process environment.
"""

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "rgywd/zhixing-next"
CERTIFICATE = "3cbb476ee642f15c807917955b15ee8f7bfe906863c9c4c3577fba0af4fad6c4"
SERVER_URL = "https://work.8-208-118-119.sslip.io/assistant"
VERSION_RE = re.compile(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\Z")
SECRETS = (
    "ANDROID_KEYSTORE_BASE64", "ANDROID_KEY_ALIAS",
    "ANDROID_STORE_PASSWORD", "ANDROID_KEY_PASSWORD",
)
UPDATE_MANIFEST = "app-update.json"


class ReleaseError(Exception):
    """Safe, actionable failure messages without remote bodies or signing data."""


def git(root, *arguments):
    result = subprocess.run(
        ["git", *arguments], cwd=root, capture_output=True, text=True, check=False,
    )
    if result.returncode:
        raise ReleaseError("Git release validation failed; fetch main and all tags first")
    return result.stdout.strip()


def version_tuple(tag):
    match = VERSION_RE.fullmatch(tag)
    if not match:
        raise ReleaseError("Release tag must be vMAJOR.MINOR.PATCH without a suffix")
    return tuple(map(int, match.groups()))


def android_version(app):
    code = app["expo"]["android"].get("versionCode")
    if type(code) is not int or not 1 <= code <= 2_100_000_000:
        raise ReleaseError("Android versionCode must be an integer between 1 and 2100000000")
    return code


def validate(root=ROOT, environ=None):
    environ = os.environ if environ is None else environ
    if environ.get("GITHUB_EVENT_NAME") != "push" or environ.get("GITHUB_REF_TYPE") != "tag":
        raise ReleaseError("Only an explicit release-tag push can publish an Android release")
    if environ.get("GITHUB_REPOSITORY") != REPOSITORY:
        raise ReleaseError("This release workflow is restricted to the application repository")
    tag = environ.get("GITHUB_REF_NAME", "")
    version = version_tuple(tag)
    package = json.loads((root / "package.json").read_text())
    app = json.loads((root / "app.json").read_text())
    lock = json.loads((root / "package-lock.json").read_text())
    name = tag[1:]
    if any(value != name for value in (
        package.get("version"), app["expo"].get("version"),
        lock.get("version"), lock.get("packages", {}).get("", {}).get("version"),
    )):
        raise ReleaseError("Tag, package.json, package-lock.json and app.json versions must agree")
    code = android_version(app)
    if app["expo"]["android"].get("package") != "dev.zhixing.next":
        raise ReleaseError("Unexpected Android application ID")
    commit = git(root, "rev-parse", "HEAD")
    pushed_sha = environ.get("GITHUB_SHA", "")
    if not re.fullmatch(r"[0-9a-f]{40}", pushed_sha):
        raise ReleaseError("The release checkout must match the pushed tag commit")
    try:
        pushed_commit = git(root, "rev-parse", f"{pushed_sha}^{{commit}}")
    except ReleaseError:
        raise ReleaseError("The release checkout must match the pushed tag commit") from None
    if pushed_commit != commit or git(root, "rev-parse", f"{tag}^{{commit}}") != commit:
        raise ReleaseError("The release checkout must match the pushed tag commit")
    git(root, "merge-base", "--is-ancestor", commit, "refs/remotes/origin/main")
    if git(root, "status", "--porcelain", "--untracked-files=normal"):
        raise ReleaseError("Release source must be a clean checkout")
    for previous in git(root, "tag", "--list", "v*").splitlines():
        if previous == tag or not VERSION_RE.fullmatch(previous):
            continue
        if version_tuple(previous) >= version:
            raise ReleaseError("A release version must be newer than every existing stable tag")
        previous_app = json.loads(git(root, "show", f"{previous}:app.json"))
        if android_version(previous_app) >= code:
            raise ReleaseError("Android versionCode must increase beyond all earlier stable tags")
    return {"tag": tag, "version": name, "version_code": code, "commit": commit}


def artifacts(environ=None):
    environ = os.environ if environ is None else environ
    runner_temp = Path(environ["RUNNER_TEMP"]).resolve()
    directory = runner_temp / "zhixing-release-artifacts"
    directory.mkdir(mode=0o700, exist_ok=True)
    return directory


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def write_private(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as destination:
        destination.write(value)


def verify_receipt(receipt, metadata, apk):
    expected = {
        "commit": metadata["commit"], "dirty": False,
        "version": metadata["version"], "version_code": metadata["version_code"],
        "application_id": "dev.zhixing.next", "architectures_requested": ["arm64-v8a"],
        "architectures_in_apk": ["arm64-v8a"], "default_server_url": SERVER_URL,
        "apk_sha256": sha256(apk),
    }
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise ReleaseError("APK build receipt does not match the verified release source")


def certificate_digest(output):
    digests = re.findall(r"^Signer #[0-9]+ certificate SHA-256 digest: ([0-9a-fA-F]+)$", output, re.MULTILINE)
    if len(digests) != 1 or digests[0].lower() != CERTIFICATE:
        raise ReleaseError("APK must use the existing official Android signing certificate")
    return digests[0].lower()


def build(root=ROOT, environ=None):
    environ = dict(os.environ if environ is None else environ)
    metadata = validate(root, environ)
    values = {name: environ.pop(name, "") for name in SECRETS}
    if any(not value for value in values.values()):
        raise ReleaseError("The four Android signing secrets must be configured")
    try:
        keystore_bytes = base64.b64decode(values[SECRETS[0]], validate=True)
    except (ValueError, base64.binascii.Error):
        raise ReleaseError("Android signing keystore is not valid base64") from None
    if not 1 <= len(keystore_bytes) <= 4 * 1024 * 1024:
        raise ReleaseError("Android signing keystore has an invalid size")
    output = artifacts(environ) / f"zhixing-next-{metadata['version']}-arm64.apk"
    # All signing files stay outside the checkout and are deleted on success or failure.
    with tempfile.TemporaryDirectory(prefix="zhixing-signing-", dir=environ["RUNNER_TEMP"]) as temporary:
        private = Path(temporary)
        private.chmod(0o700)
        keystore, signing_file = private / "release.jks", private / "signing.json"
        write_private(keystore, keystore_bytes)
        write_private(signing_file, json.dumps({
            "keystore": str(keystore), "key_alias": values["ANDROID_KEY_ALIAS"],
            "store_password": values["ANDROID_STORE_PASSWORD"],
            "key_password": values["ANDROID_KEY_PASSWORD"],
        }).encode())
        subprocess.run([
            sys.executable, str(root / "scripts/build_android_release.py"),
            "--signing-file", str(signing_file), "--architectures", "arm64-v8a",
            "--server-url", SERVER_URL, "--output", str(output),
        ], cwd=root, env=environ, check=True)
    receipt_file = output.with_suffix(".apk.build.json")
    receipt = json.loads(receipt_file.read_text())
    verify_receipt(receipt, metadata, output)
    sdk = environ.get("ANDROID_HOME") or environ.get("ANDROID_SDK_ROOT")
    if not sdk:
        raise ReleaseError("Android SDK path is required for signature verification")
    verifier = Path(sdk) / "build-tools/36.0.0/apksigner"
    verified = subprocess.run(
        [str(verifier), "verify", "--verbose", "--print-certs", str(output)],
        check=True, capture_output=True, text=True, env=environ,
    )
    receipt["signing_certificate_sha256"] = certificate_digest(verified.stdout)
    receipt["release_tag"] = metadata["tag"]
    receipt_file.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    checksums = "".join(f"{sha256(path)}  {path.name}\n" for path in (output, receipt_file))
    (output.parent / "SHA256SUMS").write_text(checksums)
    print("Signed ARM64 APK, public receipt and checksums are ready")


class GitHub:
    def __init__(self, token):
        if not token:
            raise ReleaseError("GITHUB_TOKEN is required to publish")
        self.token = token

    def request(self, method, path, body=None, *, upload=False):
        host = "uploads.github.com" if upload else "api.github.com"
        headers = {
            "Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "zhixing-next-release",
        }
        if upload:
            headers["Content-Type"] = "application/octet-stream"
            data = body
        else:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(f"https://{host}{path}", data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                content = response.read()
                return json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            if error.code == 404 and method == "GET":
                return None
            raise ReleaseError(f"GitHub release request failed (HTTP {error.code}); retry this tag run") from None
        except urllib.error.URLError:
            raise ReleaseError("GitHub release request failed; retry this tag run") from None


def update_manifest(metadata, *, apk_size, apk_sha256, notes=""):
    """Public release metadata served by an ordinary asset download, not REST."""
    tag, version = metadata["tag"], metadata["version"]
    apk_name = f"zhixing-next-{version}-arm64.apk"
    return {
        "tag_name": tag, "draft": False, "prerelease": False,
        "name": f"知行 Next {version}", "body": notes,
        "html_url": f"https://github.com/{REPOSITORY}/releases/tag/{tag}",
        "assets": [{
            "name": apk_name, "state": "uploaded", "size": apk_size,
            "browser_download_url": f"https://github.com/{REPOSITORY}/releases/download/{tag}/{apk_name}",
            "digest": f"sha256:{apk_sha256}",
        }],
    }


def remote_files(release, metadata, files):
    required = {path.name for path in files}
    assets = {asset["name"]: asset for asset in release.get("assets", [])}
    if not required.issubset(assets):
        raise ReleaseError("Published release is incomplete; do not overwrite a published version")
    # A rerun must not replace non-reproducible APK bytes or published assets.
    for name in required:
        asset = assets[name]
        if not asset.get("browser_download_url", "").startswith(
            f"https://github.com/{REPOSITORY}/releases/download/{metadata['tag']}/"
        ):
            raise ReleaseError("Unexpected release asset URL")
    receipt_name = f"zhixing-next-{metadata['version']}-arm64.apk.build.json"
    with urllib.request.urlopen(assets[receipt_name]["browser_download_url"], timeout=60) as response:
        receipt = json.load(response)
    if any(receipt.get(key) != value for key, value in {
        "commit": metadata["commit"], "version": metadata["version"],
        "version_code": metadata["version_code"], "release_tag": metadata["tag"],
        "signing_certificate_sha256": CERTIFICATE, "dirty": False,
    }.items()):
        raise ReleaseError("Published release receipt belongs to a different source or signature")
    downloaded = {}
    for name in required:
        with urllib.request.urlopen(assets[name]["browser_download_url"], timeout=120) as response:
            content = response.read()
        digest = hashlib.sha256(content).hexdigest()
        downloaded[name] = (digest, content if name in {"SHA256SUMS", UPDATE_MANIFEST} else None)
        if assets[name].get("size") != len(content):
            raise ReleaseError("Published release download size verification failed")
        if assets[name].get("digest") != f"sha256:{digest}":
            raise ReleaseError("Published release download checksum verification failed")
        if name.endswith(".apk") and receipt.get("apk_sha256") != digest:
            raise ReleaseError("Published APK and its build receipt disagree")
    apk_name = f"zhixing-next-{metadata['version']}-arm64.apk"
    sums = "".join(f"{downloaded[name][0]}  {name}\n" for name in (apk_name, receipt_name))
    if downloaded["SHA256SUMS"][1] != sums.encode():
        raise ReleaseError("Published checksums do not match the APK and build receipt")
    if UPDATE_MANIFEST in required:
        manifest = json.loads(downloaded[UPDATE_MANIFEST][1])
        if not isinstance(manifest, dict) or not isinstance(manifest.get("body"), str):
            raise ReleaseError("Published update manifest is invalid")
        expected = update_manifest(
            metadata, apk_size=assets[apk_name]["size"],
            apk_sha256=downloaded[apk_name][0], notes=manifest.get("body", ""),
        )
        if manifest != expected:
            raise ReleaseError("Published update manifest does not match the signed APK")


def publish(root=ROOT, environ=None, github=None):
    environ = os.environ if environ is None else environ
    metadata = validate(root, environ)
    directory = artifacts(environ)
    apk = directory / f"zhixing-next-{metadata['version']}-arm64.apk"
    receipt_file, checksum_file = apk.with_suffix(".apk.build.json"), directory / "SHA256SUMS"
    files = [apk, receipt_file, checksum_file]
    if any(not path.is_file() for path in files):
        raise ReleaseError("Build and verify the signed APK before publishing")
    receipt = json.loads(receipt_file.read_text())
    verify_receipt(receipt, metadata, apk)
    if receipt.get("signing_certificate_sha256") != CERTIFICATE or receipt.get("release_tag") != metadata["tag"]:
        raise ReleaseError("Signing verification receipt is missing")
    checksums = "".join(f"{sha256(path)}  {path.name}\n" for path in (apk, receipt_file))
    if checksum_file.read_text() != checksums:
        raise ReleaseError("Release asset checksums do not match")
    notes_file = root / "docs" / f"RELEASE-{metadata['version']}.md"
    notes = notes_file.read_text() if notes_file.is_file() else (
        f"知行 Next {metadata['version']}\n\n"
        "下载下方 ARM64 APK，可覆盖同签名旧版本，请勿先卸载。\n"
        "SHA256SUMS 和构建回执随安装包提供。"
    )
    manifest_file = directory / UPDATE_MANIFEST
    manifest_file.write_text(json.dumps(update_manifest(
        metadata, apk_size=apk.stat().st_size, apk_sha256=sha256(apk), notes=notes,
    ), ensure_ascii=False, indent=2) + "\n")
    files.append(manifest_file)
    github = github or GitHub(environ.get("GH_TOKEN", ""))
    prefix = f"/repos/{REPOSITORY}"
    release = github.request("GET", f"{prefix}/releases/tags/{metadata['tag']}")
    if release is not None and not release["draft"]:
        remote_files(release, metadata, files)
        print("This release is already published and its downloads are verified")
        return
    if release is None:
        release = github.request("POST", f"{prefix}/releases", {
            "tag_name": metadata["tag"], "target_commitish": metadata["commit"],
            "name": f"知行 Next {metadata['version']}", "body": notes,
            "draft": True, "prerelease": False,
        })
    release_id = release["id"]
    existing = {asset["name"]: asset for asset in release.get("assets", [])}
    for path in files:
        if path.name in existing:
            github.request("DELETE", f"{prefix}/releases/assets/{existing[path.name]['id']}")
        asset = github.request(
            "POST", f"{prefix}/releases/{release_id}/assets?name={urllib.parse.quote(path.name)}",
            path.read_bytes(), upload=True,
        )
        if asset.get("size") != path.stat().st_size or asset.get("digest") != f"sha256:{sha256(path)}":
            raise ReleaseError("Uploaded release asset checksum mismatch; draft remains unpublished")
    release = github.request("PATCH", f"{prefix}/releases/{release_id}", {"draft": False, "make_latest": "true"})
    remote_files(release, metadata, files)
    print(f"Published and download-verified: https://github.com/{REPOSITORY}/releases/tag/{metadata['tag']}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("validate", "build", "publish"))
    args = parser.parse_args()
    try:
        {"validate": validate, "build": build, "publish": publish}[args.command]()
    except (ReleaseError, subprocess.CalledProcessError, OSError, ValueError, KeyError) as error:
        # Do not echo subprocess output, remote error bodies or environment values.
        message = str(error) if isinstance(error, ReleaseError) else "Release operation failed; inspect the preceding safe build output"
        print(message, file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
