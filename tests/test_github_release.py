"""Offline release regression; never runs Actions, publishes or reads real keys."""

import contextlib
import hashlib
import importlib.util
import io
import json
import subprocess
import tempfile
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from unittest.mock import patch


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).resolve().parents[1] / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


release = load("github_release", "github_release.py")
builder = load("build_android_release", "build_android_release.py")


class GitFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.git("init", "-b", "main")
        self.git("config", "user.name", "Release fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.manifests("0.2.2", 4)
        self.commit()
        self.git("tag", "v0.2.2")
        self.manifests("0.2.3", 5)
        self.commit()
        self.git("tag", "v0.2.3")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.environ = {
            "GITHUB_EVENT_NAME": "push", "GITHUB_REF_TYPE": "tag",
            "GITHUB_REF_NAME": "v0.2.3", "GITHUB_REPOSITORY": release.REPOSITORY,
            "GITHUB_SHA": self.git("rev-parse", "HEAD"), "RUNNER_TEMP": str(self.root / "runner"),
        }
        Path(self.environ["RUNNER_TEMP"]).mkdir()
        (self.root / ".gitignore").write_text("runner/\n")
        self.commit()
        self.git("tag", "-f", "v0.2.3")
        self.git("update-ref", "refs/remotes/origin/main", "HEAD")
        self.environ["GITHUB_SHA"] = self.git("rev-parse", "HEAD")

    def git(self, *arguments):
        return subprocess.run(["git", *arguments], cwd=self.root, capture_output=True, check=True, text=True).stdout.strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "--allow-empty", "-m", "fixture")

    def manifests(self, version, code):
        (self.root / "package.json").write_text(json.dumps({"version": version}))
        (self.root / "app.json").write_text(json.dumps({"expo": {
            "version": version, "android": {"versionCode": code, "package": "dev.zhixing.next"},
        }}))
        (self.root / "package-lock.json").write_text(json.dumps({"version": version, "packages": {"": {"version": version}}}))

    def validate(self, **changes):
        return release.validate(self.root, {**self.environ, **changes})


class ReleaseValidation(GitFixture):
    def test_clean_tag_from_main_with_increasing_code_is_accepted(self):
        self.assertEqual(self.validate(), {
            "tag": "v0.2.3", "version": "0.2.3", "version_code": 5,
            "commit": self.environ["GITHUB_SHA"],
        })

    def test_annotated_tag_object_resolves_to_the_same_source_commit(self):
        self.git("tag", "-f", "-a", "v0.2.3", "-m", "fixture release")
        metadata = self.validate(GITHUB_SHA=self.git("rev-parse", "v0.2.3"))
        self.assertEqual(metadata["commit"], self.environ["GITHUB_SHA"])

    def test_non_release_events_and_other_repositories_are_rejected(self):
        for values in ({"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_EVENT_NAME": "workflow_dispatch"},
                       {"GITHUB_REF_TYPE": "branch"}, {"GITHUB_REPOSITORY": "other/repo"}):
            with self.subTest(values=values), self.assertRaises(release.ReleaseError):
                self.validate(**values)

    def test_only_canonical_stable_semver_tags_are_accepted(self):
        for tag in ("v1.2.3-rc1", "v1.2", "v01.2.3", "1.2.3", "v1.2.3/extra", "v1.2.3\n"):
            with self.subTest(tag=tag), self.assertRaises(release.ReleaseError):
                self.validate(GITHUB_REF_NAME=tag)

    def test_all_manifest_versions_must_match_tag(self):
        for filename in ("package.json", "package-lock.json", "app.json"):
            path = self.root / filename
            original = path.read_text()
            path.write_text(original.replace("0.2.3", "0.2.4"))
            with self.subTest(filename=filename), self.assertRaisesRegex(release.ReleaseError, "versions must agree"):
                self.validate()
            path.write_text(original)

    def test_version_code_must_be_integer_and_increase(self):
        for code in (True, 0, -1, 2_100_000_001, 4, 3):
            self.manifests("0.2.3", code)
            self.commit()
            self.git("tag", "-f", "v0.2.3")
            self.git("update-ref", "refs/remotes/origin/main", "HEAD")
            with self.subTest(code=code), self.assertRaises(release.ReleaseError):
                self.validate(GITHUB_SHA=self.git("rev-parse", "HEAD"))

    def test_source_commit_must_match_tag_and_main_ancestry(self):
        with self.assertRaisesRegex(release.ReleaseError, "checkout must match"):
            self.validate(GITHUB_SHA="0" * 40)
        self.git("update-ref", "refs/remotes/origin/main", "v0.2.2")
        with self.assertRaisesRegex(release.ReleaseError, "fetch main"):
            self.validate()

    def test_dirty_or_older_release_cannot_publish(self):
        (self.root / "untracked").write_text("fixture")
        with self.assertRaisesRegex(release.ReleaseError, "clean checkout"):
            self.validate()
        (self.root / "untracked").unlink()
        self.git("tag", "v0.3.0")
        with self.assertRaisesRegex(release.ReleaseError, "newer"):
            self.validate()


class ReleaseBuild(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.metadata = {"tag": "v0.2.3", "version": "0.2.3", "version_code": 5, "commit": "a" * 40}
        self.environ = {"RUNNER_TEMP": str(self.root), "ANDROID_HOME": "/synthetic-sdk",
                        "ANDROID_KEYSTORE_BASE64": "ZmljdGlvbmFs", "ANDROID_KEY_ALIAS": "fixture-alias",
                        "ANDROID_STORE_PASSWORD": "fictional-store", "ANDROID_KEY_PASSWORD": "fictional-key"}

    def receipt(self, apk):
        return {**{key: value for key, value in self.metadata.items() if key != "tag"},
                "dirty": False, "application_id": "dev.zhixing.next",
                "architectures_requested": ["arm64-v8a"], "architectures_in_apk": ["arm64-v8a"],
                "default_server_url": release.SERVER_URL, "apk_sha256": release.sha256(apk)}

    def synthetic_build(self, arguments, **kwargs):
        if "--signing-file" in arguments:
            signing_file = Path(arguments[arguments.index("--signing-file") + 1])
            signing = json.loads(signing_file.read_text())
            self.assertEqual(signing_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(signing["keystore"]).stat().st_mode & 0o777, 0o600)
            self.assertEqual(signing["store_password"], "fictional-store")
            self.assertFalse(set(release.SECRETS) & set(kwargs["env"]))
            self.signing_directory = signing_file.parent
            output = Path(arguments[arguments.index("--output") + 1])
            output.write_bytes(b"fictional APK")
            output.with_suffix(".apk.build.json").write_text(json.dumps(self.receipt(output)))
            return subprocess.CompletedProcess(arguments, 0)
        return subprocess.CompletedProcess(arguments, 0, stdout=f"Signer #1 certificate SHA-256 digest: {release.CERTIFICATE}\n")

    def build(self, runner=None):
        with patch.object(release, "validate", return_value=self.metadata), patch.object(
            release.subprocess, "run", side_effect=runner or self.synthetic_build,
        ), contextlib.redirect_stdout(io.StringIO()):
            release.build(self.root, self.environ)

    def test_signing_is_private_not_in_build_env_and_removed_after_success(self):
        self.build()
        self.assertFalse(self.signing_directory.exists())
        output = release.artifacts(self.environ)
        self.assertEqual({path.name for path in output.iterdir()}, {
            "zhixing-next-0.2.3-arm64.apk", "zhixing-next-0.2.3-arm64.apk.build.json", "SHA256SUMS",
        })
        text = "".join(path.read_text() for path in output.iterdir())
        for secret in self.environ.values():
            if secret in {str(self.root), "/synthetic-sdk"}:
                continue
            self.assertNotIn(secret, text)

    def test_signing_temporary_files_are_removed_on_build_failure(self):
        def fail(arguments, **kwargs):
            self.synthetic_build(arguments, **kwargs)
            raise subprocess.CalledProcessError(1, ["synthetic-build"])
        with self.assertRaises(subprocess.CalledProcessError):
            self.build(fail)
        self.assertFalse(self.signing_directory.exists())

    def test_missing_and_malformed_secret_is_rejected_without_build(self):
        for value in ("", "not-base64", ""):
            self.environ["ANDROID_KEYSTORE_BASE64"] = value
            with self.assertRaises(release.ReleaseError):
                self.build()
        self.assertFalse(list(self.root.glob("zhixing-signing-*")))

    def test_wrong_multiple_or_missing_certificate_is_rejected(self):
        for output in ("", "Signer #1 certificate SHA-256 digest: " + "0" * 64,
                       "\n".join(f"Signer #{n} certificate SHA-256 digest: {release.CERTIFICATE}" for n in (1, 2))):
            with self.subTest(output=output), self.assertRaises(release.ReleaseError):
                release.certificate_digest(output)

    def test_receipt_rejects_dirty_wrong_source_version_or_apk(self):
        apk = self.root / "fixture.apk"
        apk.write_bytes(b"fictional")
        for key, value in (("dirty", True), ("commit", "wrong"), ("version_code", 4),
                           ("architectures_in_apk", ["x86_64"]), ("apk_sha256", "wrong")):
            receipt = self.receipt(apk)
            receipt[key] = value
            with self.subTest(key=key), self.assertRaises(release.ReleaseError):
                release.verify_receipt(receipt, self.metadata, apk)


class NativeVersions(unittest.TestCase):
    def test_manifest_and_actual_apk_must_match_source(self):
        expected = {"version": "0.2.3", "version_code": 5, "application_id": "dev.zhixing.next"}
        metadata = {"elements": [{"versionName": "0.2.3", "versionCode": 5}], "applicationId": "dev.zhixing.next"}
        manifest = ET.fromstring('<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.zhixing.next" android:versionName="0.2.3" android:versionCode="5" />')
        builder.verify_native_version(metadata, manifest, expected)
        metadata["elements"][0]["versionName"] = "0.2.2"
        with self.assertRaises(SystemExit):
            builder.verify_native_version(metadata, manifest, expected)
        metadata["elements"][0]["versionName"] = "0.2.3"
        manifest.set("{http://schemas.android.com/apk/res/android}versionCode", "4")
        with self.assertRaises(SystemExit):
            builder.verify_native_version(metadata, manifest, expected)


class ReleasePublish(ReleaseBuild):
    def setUp(self):
        super().setUp()
        self.build()
        self.calls, self.uploads = [], {}
        self.existing, self.wrong_digest = None, False

    def request(self, method, path, body=None, upload=False):
        self.calls.append((method, path, body, upload))
        if method == "GET":
            return self.existing
        if method == "POST" and path.endswith("/releases"):
            self.assertTrue(body["draft"])
            return {"id": 1, "draft": True, "assets": []}
        if upload:
            name = path.split("?name=")[1]
            self.uploads[name] = body
            return {"id": len(self.uploads), "size": len(body), "digest": "sha256:" + ("wrong" if self.wrong_digest else hashlib.sha256(body).hexdigest())}
        if method == "PATCH":
            self.assertEqual(len(self.uploads), 4)
            return self.published()
        return None

    def published(self):
        return {"id": 1, "draft": False, "assets": [
            {"name": name, "size": len(body), "state": "uploaded", "digest": "sha256:" + hashlib.sha256(body).hexdigest(),
             "browser_download_url": f"https://github.com/{release.REPOSITORY}/releases/download/v0.2.3/{name}"}
            for name, body in self.uploads.items()
        ]}

    def download(self, url, **_kwargs):
        return io.BytesIO(self.uploads[url.rsplit("/", 1)[1]])

    def publish(self):
        with patch.object(release, "validate", return_value=self.metadata), patch.object(
            release.urllib.request, "urlopen", side_effect=self.download,
        ), contextlib.redirect_stdout(io.StringIO()):
            release.publish(self.root, self.environ, github=self)

    def test_release_is_draft_until_every_upload_is_verified(self):
        self.publish()
        mutations = [call for call in self.calls if call[0] != "GET"]
        self.assertEqual([call[0] for call in mutations], ["POST", "POST", "POST", "POST", "POST", "PATCH"])
        self.assertEqual(mutations[-1][2], {"draft": False, "make_latest": "true"})

    def test_failed_upload_keeps_draft_unpublished(self):
        self.wrong_digest = True
        with self.assertRaisesRegex(release.ReleaseError, "draft remains unpublished"):
            self.publish()
        self.assertFalse(any(call[0] == "PATCH" for call in self.calls))

    def test_existing_draft_can_replace_its_partial_assets(self):
        self.existing = {"id": 1, "draft": True, "assets": [{"name": "SHA256SUMS", "id": 7}]}
        self.publish()
        self.assertTrue(any(call[0] == "DELETE" and call[1].endswith("/7") for call in self.calls))

    def test_published_release_is_verified_without_replacing_assets(self):
        self.publish()
        self.existing = self.published()
        self.calls.clear()
        self.publish()
        self.assertEqual([call[0] for call in self.calls], ["GET"])

    def test_corrupt_local_checksums_never_write_to_github(self):
        (release.artifacts(self.environ) / "SHA256SUMS").write_text("incorrect")
        with self.assertRaisesRegex(release.ReleaseError, "checksums do not match"):
            self.publish()
        self.assertFalse(self.calls)

    def test_corrupt_published_download_fails_verification(self):
        self.publish()
        self.existing = self.published()
        self.uploads["zhixing-next-0.2.3-arm64.apk"] = b"corrupt"
        self.calls.clear()
        with self.assertRaisesRegex(release.ReleaseError, "verification|checksum"):
            self.publish()
        self.assertEqual([call[0] for call in self.calls], ["GET"])

    def test_static_manifest_matches_the_signed_apk_and_official_download(self):
        self.publish()
        manifest = json.loads(self.uploads[release.UPDATE_MANIFEST])
        apk_name = "zhixing-next-0.2.3-arm64.apk"
        self.assertFalse(manifest["draft"])
        self.assertFalse(manifest["prerelease"])
        self.assertEqual(manifest["tag_name"], "v0.2.3")
        self.assertEqual(manifest["html_url"], "https://github.com/rgywd/zhixing-next/releases/tag/v0.2.3")
        self.assertEqual(manifest["assets"], [{
            "name": apk_name, "state": "uploaded", "size": len(self.uploads[apk_name]),
            "browser_download_url": f"https://github.com/rgywd/zhixing-next/releases/download/v0.2.3/{apk_name}",
            "digest": "sha256:" + hashlib.sha256(self.uploads[apk_name]).hexdigest(),
        }])

    def test_valid_json_manifest_cannot_point_to_a_different_apk(self):
        self.publish()
        manifest = json.loads(self.uploads[release.UPDATE_MANIFEST])
        manifest["assets"][0]["browser_download_url"] = "https://example.com/untrusted.apk"
        self.uploads[release.UPDATE_MANIFEST] = json.dumps(manifest).encode()
        self.existing = self.published()
        self.calls.clear()
        with self.assertRaisesRegex(release.ReleaseError, "manifest does not match"):
            self.publish()
        self.assertEqual([call[0] for call in self.calls], ["GET"])

    def test_missing_static_manifest_does_not_count_as_a_complete_release(self):
        self.publish()
        self.uploads.pop(release.UPDATE_MANIFEST)
        self.existing = self.published()
        self.calls.clear()
        with self.assertRaisesRegex(release.ReleaseError, "incomplete"):
            self.publish()
        self.assertEqual([call[0] for call in self.calls], ["GET"])


class ReleaseWorkflow(unittest.TestCase):
    def test_actions_only_trigger_on_release_tags_and_signing_has_limited_scope(self):
        root = Path(__file__).resolve().parents[1]
        workflows = list((root / ".github/workflows").glob("*.yml"))
        self.assertEqual([path.name for path in workflows], ["release.yml"])
        source = workflows[0].read_text()
        self.assertIn('tags:\n      - "v*.*.*"', source)
        for forbidden in ("pull_request:", "workflow_dispatch:", "schedule:", "release:"):
            self.assertNotIn(forbidden, source)
        self.assertEqual(source.count("${{ secrets.ANDROID_"), 4)
        self.assertIn("needs: verify", source)
        self.assertIn("persist-credentials: false", source)
        self.assertIn("python3 scripts/github_release.py publish", source)


if __name__ == "__main__":
    unittest.main()
