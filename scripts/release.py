#!/usr/bin/env python3
"""Validate release sources, package deployment files, and publish complete downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent.parent


def command(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def metadata() -> dict:
    data = json.loads((ROOT / "release.json").read_text())
    if not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?", data["version"]):
        raise ValueError("Invalid release version")
    if type(data["androidVersionCode"]) is not int or not 1 <= data["androidVersionCode"] <= 2100000000:
        raise ValueError("Invalid Android version code")
    if not re.fullmatch(r"[0-9a-f]{64}", data.get("androidSigningCertificateSha256", "")):
        raise ValueError("Invalid retained Android signing certificate fingerprint")
    return data


def prepare() -> None:
    data = metadata()
    tag = os.environ["TAG"]
    version = data["version"]
    if tag != f"v{version}":
        raise ValueError("The tag does not match release.json")
    if command("git", "cat-file", "-t", f"refs/tags/{tag}") != "tag":
        raise ValueError("An annotated release tag is required")
    sha = command("git", "rev-parse", "HEAD")
    if os.environ["WORKFLOW_SHA"] != sha:
        raise ValueError("Dispatch the release workflow at the tag ref so provenance and build sources agree")
    if command("git", "rev-parse", f"refs/tags/{tag}^{{commit}}") != sha:
        raise ValueError("Checkout does not match the release tag")
    prerelease = version.startswith("0.") or "-" in version
    branch = "develop" if prerelease else "main"
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, f"origin/{branch}"], cwd=ROOT, check=True)
    repo = os.environ["REPO"]
    releases = json.loads(command("gh", "api", f"repos/{repo}/releases", "--paginate", "--slurp"))
    if any(release["tag_name"] == tag and not release["draft"] for page in releases for release in page):
        raise ValueError("Release is already public; its versioned images and downloads must not be rebuilt")
    for workflow in ("ci.yml", "security.yml", "android.yml", "desktop.yml", "release-checks.yml"):
        runs = json.loads(command("gh", "api", f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100"))["workflow_runs"]
        eligible = [run for run in runs if run["event"] == "push" and run["head_branch"] == branch]
        if not eligible or max(eligible, key=lambda run: run["id"])["conclusion"] != "success":
            raise ValueError(f"Latest {workflow} push run for {sha} on {branch} must pass first")
    dockerhub = os.environ.get("DOCKERHUB_ENABLED", "true")
    if dockerhub not in ("true", "false"):
        raise ValueError("DITERO_DOCKERHUB_ENABLED must be true or false")
    if dockerhub == "true" and not all(os.environ.get(name) for name in ("DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN")):
        raise ValueError("Docker Hub publication requires DOCKERHUB_USERNAME and DOCKERHUB_TOKEN")
    values = {"sha": sha, "tag": tag, "version": version, "prerelease": str(prerelease).lower(), "android-code": data["androidVersionCode"], "dockerhub": dockerhub}
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def deployment(output: Path) -> None:
    version = metadata()["version"]
    chart = ROOT / "deploy/helm/ditero"
    source = (chart / "Chart.yaml").read_text()
    values = (chart / "values.yaml").read_text()
    for key in ("version", "appVersion"):
        if not re.search(rf'(?m)^{key}:\s*"?{re.escape(version)}"?\s*$', source):
            raise ValueError(f"Helm {key} does not match release.json")
    for tag in (version, f"{version}-zero"):
        if not re.search(rf'(?m)^\s+tag:\s*"?{re.escape(tag)}"?\s*$', values):
            raise ValueError("Helm image tags do not match release.json")
    kustomize = ROOT / "deploy/kustomize"
    for component, suffix in (("app", ""), ("zero", "-zero")):
        manifest = (kustomize / "base" / f"ditero-{component}-deployment.yaml").read_text()
        if not re.search(rf"(?m)^\s+image: ghcr\.io/iuliandita/ditero:{re.escape(version + suffix)}\s*$", manifest):
            raise ValueError("Kustomize image tags do not match release.json")
    output.mkdir(parents=True, exist_ok=True)
    subprocess.run(["helm", "package", "deploy/helm/ditero", "--version", version, "--app-version", version, "--destination", str(output)], cwd=ROOT, check=True)
    files = ("docker-compose.yml", "postgres-init.sh", "secret-file.sh")
    with tarfile.open(output / f"ditero-{version}-compose.tar.gz", "w:gz") as archive:
        for name in files:
            archive.add(ROOT / "deploy/docker" / name, arcname=f"ditero-{version}/compose/{name}")
        for name in ("RELEASING.md", "LICENSE"):
            archive.add(ROOT / name, arcname=f"ditero-{version}/{name}")

    with tarfile.open(output / f"ditero-{version}-kustomize.tar.gz", "w:gz") as archive:
        files = (
            "README.md", "base/kustomization.yaml", "base/name-reference.yaml", "base/app.env",
            "base/namespace.yaml", "base/ditero-app-deployment.yaml",
            "base/ditero-app-service.yaml", "base/ditero-app-persistentvolumeclaim.yaml",
            "base/ditero-zero-deployment.yaml", "base/ditero-zero-service.yaml",
            "base/ditero-zero-persistentvolumeclaim.yaml",
            "cnpg/README.md", "cnpg/kustomization.yaml", "cnpg/cluster.yaml",
            "cnpg/name-reference.yaml", "cnpg/roles.sql",
        )
        for name in files:
            archive.add(kustomize / name, arcname=f"ditero-{version}/deploy/kustomize/{name}", recursive=False)
        for name in ("RELEASING.md", "LICENSE", "docs/runbooks/database-roles.md"):
            archive.add(ROOT / name, arcname=f"ditero-{version}/{name}")


def expected_assets(version: str) -> set[str]:
    suffixes = (
        "linux-x64-unsigned.deb", "linux-x64-unsigned.AppImage",
        "windows-x64-unsigned.exe", "macos-arm64-adhoc.dmg",
        "android-independent-universal-signed.apk", "android-independent-universal-signed.aab",
        "compose.tar.gz", "kustomize.tar.gz", "sbom-alpine.spdx.json", "sbom-debian.spdx.json", "sbom-zero.spdx.json",
        "image-alpine.txt", "image-debian.txt", "image-zero.txt",
    )
    return {f"ditero-{version}-{suffix}" for suffix in suffixes} | {f"ditero-{version}.tgz"}


def verify_downloads(output: Path, version: str) -> set[str]:
    expected = expected_assets(version)
    actual = {path.name for path in output.iterdir()}
    if actual != expected:
        raise ValueError(f"Release asset mismatch: missing={sorted(expected - actual)}, extra={sorted(actual - expected)}")
    for name in expected:
        path = output / name
        if not path.is_file() or path.is_symlink() or not path.stat().st_size:
            raise ValueError(f"Empty or invalid asset: {name}")
    return expected


def publish(output: Path) -> None:
    version = metadata()["version"]
    names = verify_downloads(output, version)
    tag, repo, sha = (os.environ[name] for name in ("TAG", "REPO", "RELEASE_SHA"))
    if tag != f"v{version}" or command("git", "rev-parse", "HEAD") != sha:
        raise ValueError("Release source identity mismatch")
    remote = command("git", "ls-remote", "origin", f"refs/tags/{tag}^{{}}")
    if remote.split()[0] != sha:
        raise ValueError("Remote annotated tag changed since preparation")
    sums = []
    digests = {}
    for name in sorted(names):
        with (output / name).open("rb") as stream:
            digests[name] = hashlib.file_digest(stream, "sha256").hexdigest()
            sums.append(f"{digests[name]}  {name}\n")
    (output / "SHA256SUMS.txt").write_text("".join(sums))
    digests["SHA256SUMS.txt"] = hashlib.sha256((output / "SHA256SUMS.txt").read_bytes()).hexdigest()
    names.add("SHA256SUMS.txt")
    prerelease = version.startswith("0.") or "-" in version
    notes = f"""Ditero {version} is an experimental alpha for self-hosted testing. Back up your database and attachments before upgrading.

Server: multi-architecture amd64/arm64 Alpine app, Debian app, and Zero images at `ghcr.io/{repo}:{version}`, `:{version}-debian`, and `:{version}-zero`. See the image digest files and SPDX SBOMs. Images are signed with keyless cosign; verify the release workflow identity before deployment.

Deployment: the Helm chart uses external PostgreSQL with logical replication and an existing Secret; see the README inside the chart. The Kustomize archive provides app and Zero manifests for external PostgreSQL; its guide describes local rendering and the remaining cluster qualification. The Compose archive includes the bundled database initialization files. Set `DITERO_IMAGE_TAG={version}` when running Compose.

Desktop: Linux x86_64 DEB/AppImage, unsigned Windows x86_64 installer, and ad-hoc signed macOS Apple Silicon DMG. Windows and macOS downloads have no trusted publisher signature or notarization. Native qualification, general deep links and automatic updates remain incomplete.

Android: signed independent APK and AAB, with UnifiedPush and no Google SDK configuration. The AAB is for distribution tooling, not direct installation. Broader device qualification remains open; no store distribution is configured.

Verify downloads with `sha256sum -c SHA256SUMS.txt`. Checksums verify downloaded bytes; they do not replace platform signing or runtime qualification. This prerelease does not move latest or stable image channels.
"""
    if os.environ.get("DOCKERHUB_ENABLED") == "true":
        notes += f"\nThe same versioned server images also publish to `docker.io/iuliandita/ditero`.\n"
    else:
        notes += "\nDocker Hub publication is not configured for this release.\n"
    releases = json.loads(command("gh", "api", f"repos/{repo}/releases", "--paginate", "--slurp"))
    existing = next((release for page in releases for release in page if release["tag_name"] == tag), None)
    if existing and not existing["draft"]:
        raise ValueError("Release is already public; create a new version instead of replacing downloads")
    with tempfile.TemporaryDirectory() as directory:
        note_path = Path(directory) / "notes.md"
        note_path.write_text(notes)
        if existing is None:
            args = ["gh", "release", "create", tag, "--repo", repo, "--verify-tag", "--draft", "--title", f"Ditero {version}", "--notes-file", str(note_path)]
            if prerelease:
                args.append("--prerelease")
            subprocess.run(args, cwd=ROOT, check=True)
        else:
            if {asset["name"] for asset in existing["assets"]} - names:
                raise ValueError("Draft has unexpected assets; inspect it before publishing")
            subprocess.run(["gh", "release", "edit", tag, "--repo", repo, "--notes-file", str(note_path)], cwd=ROOT, check=True)
    subprocess.run(["gh", "release", "upload", tag, "--repo", repo, "--clobber", *(str(output / name) for name in sorted(names))], cwd=ROOT, check=True)
    assets = json.loads(command("gh", "release", "view", tag, "--repo", repo, "--json", "assets"))["assets"]
    if {asset["name"] for asset in assets} != names or any(asset["size"] != (output / asset["name"]).stat().st_size for asset in assets):
        raise ValueError("Uploaded release asset inventory or size mismatch")
    if any(asset.get("digest") != f"sha256:{digests[asset['name']]}" for asset in assets):
        raise ValueError("GitHub upload digests do not match the local release downloads")
    args = ["gh", "release", "edit", tag, "--repo", repo, "--draft=false", f"--prerelease={str(prerelease).lower()}"]
    if prerelease:
        args.append("--latest=false")
    subprocess.run(args, cwd=ROOT, check=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prepare", "deployment", "publish", "check"])
    parser.add_argument("--output", type=Path, default=Path("release-downloads"))
    args = parser.parse_args()
    if args.command == "check":
        print(metadata()["version"])
    elif args.command == "prepare":
        prepare()
    elif args.command == "deployment":
        deployment(args.output)
    else:
        publish(args.output)
