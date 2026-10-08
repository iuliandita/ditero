#!/usr/bin/env python3
"""Validate release sources, package deployment files, and publish complete downloads."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import ipaddress
from urllib.parse import urlsplit, urlunsplit, unquote

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
    subprocess.run([sys.executable, "-I", str(ROOT / "scripts/docs-release.py"), "--head", sha],
                   cwd=ROOT, check=True, timeout=180)
    dockerhub = os.environ.get("DOCKERHUB_ENABLED", "true")
    if dockerhub not in ("true", "false"):
        raise ValueError("DITERO_DOCKERHUB_ENABLED must be true or false")
    if dockerhub == "true" and not all(os.environ.get(name) for name in ("DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN")):
        raise ValueError("Docker Hub publication requires DOCKERHUB_USERNAME and DOCKERHUB_TOKEN")
    values = {"sha": sha, "tag": tag, "version": version, "prerelease": str(prerelease).lower(), "android-code": data["androidVersionCode"], "dockerhub": dockerhub}
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        for key, value in values.items():
            output.write(f"{key}={value}\n")


def deployment_guides(version: str) -> None:
    guides = {
        "deploy/helm/ditero/README.md": (
            (r"The chart version is `([^`]+)`", [version]),
            (r"Images default to `ghcr\.io/iuliandita/ditero:([^`]+)` and\s*`ghcr\.io/iuliandita/ditero:([^`]+)`", [(version, f"{version}-zero")]),
        ),
        "deploy/kustomize/README.md": (
            (r"(?m)^  newTag: (\S+)$", [version]),
            (r"(?m)^      value: docker\.io/iuliandita/ditero:(\S+)$", [f"{version}-zero"]),
        ),
    }
    for name, examples in guides.items():
        source = (ROOT / name).read_text()
        for pattern, expected in examples:
            if re.findall(pattern, source) != expected:
                raise ValueError(f"Packaged deployment guide {name} does not match release.json")


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
    deployment_guides(version)
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
        for name in ("RELEASING.md", "LICENSE", "docs/runbooks/database-roles.md", "docs/runbooks/database-tls.md"):
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


def strict_json(raw: bytes):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(raw.decode("utf-8"), object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Invalid JSON constant")))


def runtime_notice_records(manifest):
    def fields(value, expected):
        if not isinstance(value, dict) or set(value) != set(expected):
            raise ValueError("Invalid runtime notice fields")
    def string(value, pattern, limit):
        if not isinstance(value, str) or len(value) > limit or not re.fullmatch(pattern, value):
            raise ValueError("Invalid runtime notice value")
    fields(manifest, ("schema", "identity", "incomplete", "texts", "unresolved", "sourceRelink"))
    if type(manifest["schema"]) is not int or manifest["schema"] != 1 or manifest["incomplete"] is not True:
        raise ValueError("Runtime notice qualification must remain incomplete")
    identity = {"bunVersion": "1.4.2", "bunRevision": "744846f844374847c902b5e7fd59b4342a51ef99",
                "target": "bun-linux-x64", "runtimeArchiveSha256": "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
                "webkitCommit": "2e2aa2290fac856d6f451ceacb58f7f5b44dd057"}
    if manifest["identity"] != identity:
        raise ValueError("Runtime notice identity mismatch")
    texts = manifest["texts"]
    if not isinstance(texts, list) or not 1 <= len(texts) <= 512:
        raise ValueError("Invalid runtime notice text inventory")
    unresolved = manifest["unresolved"]
    if not isinstance(unresolved, list) or len(unresolved) > 128:
        raise ValueError("Invalid runtime notice unresolved inventory")
    for item in unresolved:
        fields(item, ("component", "reason"))
        for key, limit in (("component", 200), ("reason", 2048)):
            if not isinstance(item[key], str) or not 1 <= len(item[key]) <= limit:
                raise ValueError("Invalid unresolved notice")
    fields(manifest["sourceRelink"], ("source", "relink"))
    records = []
    for item in texts + [item for item in manifest["sourceRelink"].values() if item is not None]:
        is_text = len(records) < len(texts)
        fields(item, ("path", "sha256", "origin", "license", "selection") if is_text else ("path", "sha256", "origin"))
        string(item["path"], r"notices/runtime/(?:[A-Za-z0-9_+-][A-Za-z0-9_.+-]*/)*[A-Za-z0-9_+-][A-Za-z0-9_.+-]*", 240)
        if any(part in (".", "..") for part in item["path"].split("/")) or item["path"] == "notices/runtime/manifest.json":
            raise ValueError("Invalid runtime notice path")
        string(item["sha256"], r"[a-f0-9]{64}", 64)
        origin = item["origin"]
        fields(origin, ("url", "revision"))
        string(origin["revision"], r"(?:[a-f0-9]{40}|[a-f0-9]{64}|[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)", 2048)
        url = origin["url"]
        if not isinstance(url, str) or len(url) > 2048 or re.search(r"[\x00-\x20\x7f\\{}]", url):
            raise ValueError("Invalid runtime notice origin")
        parsed = urlsplit(url)
        # WHATWG treats numeric final host labels as IPv4, including legacy spellings.
        host = parsed.hostname or ""
        final_label = host.rstrip(".").split(".")[-1]
        if re.fullmatch(r"(?:[0-9]+|0[xX][0-9a-fA-F]+)", final_label):
            try:
                address = ipaddress.IPv4Address(host)
            except ipaddress.AddressValueError as error:
                raise ValueError("Noncanonical runtime notice IPv4 origin") from error
            if str(address) != host:
                raise ValueError("Noncanonical runtime notice IPv4 origin")
        parts = unquote(parsed.path).split("/")
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username is not None or parsed.password is not None or parsed.query or parsed.fragment
                or parsed.hostname != parsed.hostname.lower() or parsed.netloc != parsed.netloc.lower()
                or parsed.port == 443 or urlunsplit(parsed) != url or any(part in (".", "..") for part in parts)
                or any(part.lower() in ("main", "master", "head", "latest", "nightly") for part in parts)
                or not any(part in (origin["revision"], "v" + origin["revision"]) for part in parsed.path.split("/"))):
            raise ValueError("Runtime notice origin must be immutable")
        if is_text:
            string(item["license"], r"[A-Za-z0-9().+ -]+", 120)
            if item["selection"] not in ("target", "build-host", "conservative-extra"):
                raise ValueError("Invalid runtime notice selection")
        records.append(item)
    if len(records) > 512 or len({item["path"] for item in records}) != len(records):
        raise ValueError("Duplicate runtime notice path")
    return records


def verify_clients_candidate(path: Path, version: str, source_sha: str) -> None:
    prefix = f"ditero-{version}-clients-linux-x64"
    clients = ("ditero", "ditero-mcp", "ditero-tui")
    required = {"BUILDINFO.json", "LICENSE", "REBUILD.md", "notices/Bun-LICENSE.md", "notices/runtime/manifest.json"}
    required |= {f"bin/{name}" for name in clients} | {f"relink/{name}.js" for name in clients}
    with tarfile.open(path) as archive:
        members = archive.getmembers()
        if len(members) > 512 or sum(member.size for member in members) > 512 * 1024 * 1024:
            raise ValueError("Client archive exceeds unpacked size bound")
        files = {}
        seen_members = set()
        for member in members:
            identity = member.name.rstrip("/")
            if identity in seen_members:
                raise ValueError("Duplicate client archive member")
            seen_members.add(identity)
            parts = member.name.split("/")
            if parts[0] != prefix or any(part in (".", "..") or part.startswith(".") for part in parts):
                raise ValueError("Unexpected client archive path")
            if not (member.isfile() or member.isdir()):
                raise ValueError("Client archive contains a link or special file")
            relative = "/".join(parts[1:])
            if member.isfile():
                if relative in files or member.size == 0:
                    raise ValueError("Client archive contains duplicate or empty files")
                files[relative] = member
        if not required <= files.keys():
            raise ValueError("Client archive is missing required files")
        if files["BUILDINFO.json"].size > 65536:
            raise ValueError("Client build identity exceeds size bound")
        info = strict_json(archive.extractfile(files["BUILDINFO.json"]).read())
        if not isinstance(info, dict) or type(info.get("sourceDirty")) is not bool or type(info.get("apiVersion")) is not int:
            raise ValueError("Invalid client build identity")
        if (info.get("version"), info.get("sourceSha"), info.get("target"), info.get("apiVersion"), info.get("clients")) != (version, source_sha, "bun-linux-x64", 1, list(clients)):
            raise ValueError("Client archive source identity mismatch")
        if info.get("runtimeNoticesComplete") is not False:
            raise ValueError("Candidate must declare incomplete runtime notice qualification")
        if info.get("bunVersion") != "1.4.2" or info.get("bunRevision") != "744846f844374847c902b5e7fd59b4342a51ef99" or info.get("runtimeArchiveSha256") != "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913":
            raise ValueError("Client archive runtime identity mismatch")
        manifest_member = files["notices/runtime/manifest.json"]
        if manifest_member.size > 65536:
            raise ValueError("Runtime notice manifest size limit")
        manifest_raw = archive.extractfile(manifest_member).read()
        if info.get("runtimeNoticesManifestSha256") != hashlib.sha256(manifest_raw).hexdigest():
            raise ValueError("Runtime notice manifest hash mismatch")
        manifest = strict_json(manifest_raw)
        records = runtime_notice_records(manifest)
        expected_runtime = {item["path"] for item in records} | {"notices/runtime/manifest.json"}
        actual_runtime = {name for name in files if name.startswith("notices/runtime/")}
        if actual_runtime != expected_runtime:
            raise ValueError("Runtime notice file inventory mismatch")
        runtime_total = 0
        for item in records:
            member = files[item["path"]]
            runtime_total += member.size
            if member.size > 8 * 1024 * 1024 or runtime_total > 512 * 1024 * 1024:
                raise ValueError("Runtime notice size limit")
            raw = archive.extractfile(member).read()
            if hashlib.sha256(raw).hexdigest() != item["sha256"]:
                raise ValueError("Runtime notice text hash mismatch")
            content = raw.decode("utf-8")
            if "\0" in content:
                raise ValueError("Invalid runtime notice text")
            if item in manifest["texts"]:
                if re.search(r"(?:\[(?:year|copyright holder|name of author|insert[^\]]*)\]|<copyright[^>]*>|^\s*(?:TODO|TBD|PLACEHOLDER)\s*$)", content, re.I | re.M):
                    raise ValueError("Placeholder runtime notice")
                if not re.search(r"(?:^\s*(?:\*\s*)?copyright\s*(?:\(c\)|©)?\s*(?:[0-9]{4}|[A-Z])|public domain)", content, re.I | re.M) or not re.search(r"permission|redistribution|license|licence|SPDX", content, re.I):
                    raise ValueError("Missing runtime notice header or grant")
        dependencies = info.get("dependencies")
        if not isinstance(dependencies, list) or not dependencies or len(dependencies) > 100 or any(not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9@_+.-]{1,200}", name) or ".." in name for name in dependencies) or len(set(dependencies)) != len(dependencies):
            raise ValueError("Invalid client dependency notice inventory")
        allowed_directories = {prefix, f"{prefix}/bin", f"{prefix}/relink", f"{prefix}/notices"} | {f"{prefix}/notices/{dependency}" for dependency in dependencies}
        for name in expected_runtime:
            parent = Path(prefix) / name
            for ancestor in parent.parents:
                if str(ancestor) == ".":
                    break
                allowed_directories.add(str(ancestor))
        if any(member.isdir() and member.name.rstrip("/") not in allowed_directories for member in members):
            raise ValueError("Unexpected client archive directory")
        for name, member in files.items():
            if name in required or name in expected_runtime:
                continue
            parts = name.split("/")
            if len(parts) != 3 or parts[0] != "notices" or parts[1] not in dependencies or not re.fullmatch(r"(?i)(?:licen[sc]e|copying|notice)(?:[.-].*)?", parts[2]):
                raise ValueError("Unexpected client archive file")
        for dependency in dependencies:
            if not any(name.startswith(f"notices/{dependency}/") for name in files):
                raise ValueError("Missing client dependency notices")
        for client in clients:
            member = files[f"bin/{client}"]
            header = archive.extractfile(member).read(20)
            if not member.mode & 0o111 or header[:6] != b"\x7fELF\x02\x01" or header[18:20] != b"\x3e\x00":
                raise ValueError("Client binary is not executable Linux x64 ELF")


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
    parser.add_argument("command", choices=["prepare", "deployment", "publish", "check", "clients"])
    parser.add_argument("--output", type=Path, default=Path("release-downloads"))
    args = parser.parse_args()
    if args.command == "check":
        print(metadata()["version"])
    elif args.command == "clients":
        version = metadata()["version"]
        verify_clients_candidate(args.output / f"ditero-{version}-clients-linux-x64.tar.gz", version, command("git", "rev-parse", "HEAD"))
    elif args.command == "prepare":
        prepare()
    elif args.command == "deployment":
        deployment(args.output)
    else:
        publish(args.output)
