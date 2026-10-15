"""Build an APK with private environment signing and a public provenance receipt."""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import xml.etree.ElementTree as ET
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit


def timestamp():
    return datetime.now(UTC).isoformat(timespec="seconds")


def source_state(root):
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain", "--untracked-files=normal"],
        cwd=root,
        check=True,
        capture_output=True,
    ).stdout
    return {"commit": commit, "dirty": bool(status)}


def public_server_url(value):
    if not value:
        return ""
    target = urlsplit(value)
    if (
        target.scheme != "https"
        or not target.hostname
        or target.username
        or target.password
        or target.query
        or target.fragment
        or any(char.isspace() for char in value)
        or "\\" in value
    ):
        raise SystemExit(
            "Default server URL must be HTTPS without credentials or query"
        )
    try:
        _ = target.port
    except ValueError:
        raise SystemExit("Default server URL has an invalid port") from None
    return value.rstrip("/")


def configured_version(root):
    package = json.loads((root / "package.json").read_text())
    app = json.loads((root / "app.json").read_text())["expo"]
    code = app["android"].get("versionCode")
    if package.get("version") != app.get("version") or not package.get("version"):
        raise SystemExit("package.json and app.json versions must agree before building")
    if type(code) is not int or not 1 <= code <= 2_100_000_000:
        raise SystemExit("Android versionCode must be an integer between 1 and 2100000000")
    return {"version": package["version"], "version_code": code, "application_id": app["android"]["package"]}


def verify_native_version(metadata, manifest, expected):
    if len(metadata.get("elements", [])) != 1:
        raise SystemExit("Expected one Android release APK output")
    element = metadata["elements"][0]
    android_attribute = "{http://schemas.android.com/apk/res/android}"
    actual = {
        "version": element.get("versionName"), "version_code": element.get("versionCode"),
        "application_id": metadata.get("applicationId"),
    }
    manifest_version = {
        "version": manifest.attrib.get(android_attribute + "versionName"),
        "version_code": manifest.attrib.get(android_attribute + "versionCode"),
        "application_id": manifest.attrib.get("package"),
    }
    if actual != expected or manifest_version != {key: str(value) for key, value in expected.items()}:
        raise SystemExit("Native APK metadata and manifest must match package.json and app.json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signing-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--architectures", default="arm64-v8a,armeabi-v7a,x86_64")
    parser.add_argument("--server-url", default="")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    expected_version = configured_version(root)
    if os.name != "nt" and args.signing_file.stat().st_mode & 0o077:
        raise SystemExit("Signing file permissions must be private (0600)")
    signing = json.loads(args.signing_file.read_text())
    env = os.environ.copy()
    # Validate inherited public configuration too: Expo embeds it in the JS bundle.
    server_url = public_server_url(
        args.server_url or env.get("EXPO_PUBLIC_ZHIXING_SERVER_URL", "")
    )
    # Pin even an empty value so Expo dotenv cannot silently inject another URL.
    env["EXPO_PUBLIC_ZHIXING_SERVER_URL"] = server_url
    architectures = args.architectures.split(",")
    if (
        not architectures
        or len(set(architectures)) != len(architectures)
        or set(architectures) - {"arm64-v8a", "armeabi-v7a", "x86", "x86_64"}
    ):
        raise SystemExit("Choose unique supported Android architectures")
    for key, field in {
        "ZHIXING_ANDROID_KEYSTORE": "keystore",
        "ZHIXING_ANDROID_STORE_PASSWORD": "store_password",
        "ZHIXING_ANDROID_KEY_ALIAS": "key_alias",
        "ZHIXING_ANDROID_KEY_PASSWORD": "key_password",
    }.items():
        if not isinstance(signing.get(field), str) or not signing[field]:
            raise SystemExit(f"Signing field missing: {field}")
        env[key] = signing[field]
    keystore = Path(signing["keystore"]).expanduser().resolve()
    if not keystore.is_file():
        raise SystemExit("Signing keystore missing")
    env["ZHIXING_ANDROID_KEYSTORE"] = str(keystore)
    started_at, source = timestamp(), source_state(root)
    subprocess.run(
        ["npx", "expo", "prebuild", "--platform", "android", "--no-install"],
        cwd=root,
        env=env,
        check=True,
    )
    subprocess.run(
        [
            "./gradlew",
            ":app:assembleRelease",
            "--no-daemon",
            "--max-workers=2",
            f"-PreactNativeArchitectures={args.architectures}",
        ],
        cwd=root / "android",
        env=env,
        check=True,
    )
    after = source_state(root)
    if after["commit"] != source["commit"]:
        raise SystemExit(
            "Source commit changed during the build; rebuild from the intended commit"
        )
    output = args.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(root / "android/app/build/outputs/apk/release/app-release.apk", output)
    metadata = json.loads(
        (
            root / "android/app/build/outputs/apk/release/output-metadata.json"
        ).read_text()
    )
    element = metadata["elements"][0]
    with zipfile.ZipFile(output) as archive:
        actual_architectures = sorted(
            {
                name.split("/")[1]
                for name in archive.namelist()
                if name.startswith("lib/") and name.endswith(".so")
            }
        )
    manifest = ET.parse(
        root
        / "android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml"
    ).getroot()
    verify_native_version(metadata, manifest, expected_version)
    sdk = manifest.find("uses-sdk")
    android_attribute = "{http://schemas.android.com/apk/res/android}"
    receipt = {
        "commit": source["commit"],
        "dirty": source["dirty"] or after["dirty"],
        "version": element["versionName"],
        "version_code": element["versionCode"],
        "application_id": metadata["applicationId"],
        "architectures_requested": architectures,
        "architectures_in_apk": actual_architectures,
        "min_sdk": int(sdk.attrib[android_attribute + "minSdkVersion"]),
        "target_sdk": int(sdk.attrib[android_attribute + "targetSdkVersion"]),
        "default_server_url": server_url,
        "apk_sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "build_started_at": started_at,
        "build_finished_at": timestamp(),
    }
    receipt_path = output.with_suffix(output.suffix + ".build.json")
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n")
    print(f"APK saved: {output}")
    print(f"Build receipt saved: {receipt_path}")


if __name__ == "__main__":
    main()
