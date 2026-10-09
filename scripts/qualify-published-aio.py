#!/usr/bin/env python3
"""Qualify one existing AIO publication on a disposable native Docker host."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import selectors
import signal
import stat
import subprocess
import tarfile
import tempfile
import time
import zipfile

SHA = "792ecf49ea1500f360a965a656bec5e43cb93303"
RUN = 37883668165
ARTIFACT = 11595876327
ZIP_SHA = "974a69b462179fa3e6456627b32d996f924d11c464af683ed9ef17f54369297d"
CANDIDATE = f"aio-experimental-{SHA}-{RUN}-1"
LIMIT = 25_000_000
FILES = ("deploy/docker/aio/run-bundle.sh", "deploy/docker/aio/compose.yml",
         "deploy/docker/aio/README.md", "LICENSE", "docs/runbooks/deployment-settings.md",
         "docs/runbooks/database-roles.md", "docs/runbooks/encryption.md")
TESTS = {"aio-runtime.mjs": "045dc4cd8a40ead1cd9eea10f6dd9f0c4c2215a96abd62df57df9ab0be81d50a",
         "aio-wrapper-runtime.mjs": "b2d97c8311728528a5ae791236509cc50e7da539d826f222af5b2740d03b8530"}
COMMAND_DEADLINE = None
CANCELLATION = None

class Cancelled(Exception):
    pass

def request_cancellation(signum, _frame):
    global CANCELLATION
    if CANCELLATION is None:
        CANCELLATION = signum

def check_cancellation():
    if CANCELLATION is not None:
        raise Cancelled("Parent cancellation requested")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")

def require(value, message):
    if not value:
        raise ValueError(message)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, "Duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)

def validate_package(raw, source):
    require(len(raw) <= LIMIT, "Artifact exceeds bound")
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        names = {CANDIDATE + ".tar.gz", "SHA256SUMS"}
        require(len(members) == 2 and {m.filename for m in members} == names, "Exact ZIP members required")
        require(sum(m.file_size for m in members) <= LIMIT, "Expanded ZIP exceeds bound")
        require(all(not m.is_dir() and stat.S_IFMT(m.external_attr >> 16) in (0, stat.S_IFREG) for m in members), "Regular ZIP members required")
        packed = archive.read(CANDIDATE + ".tar.gz")
        require(archive.read("SHA256SUMS") == f"{sha(packed)}  {CANDIDATE}.tar.gz\n".encode(), "Outer checksum differs")
    expected = set(FILES) | {"SOURCE.json", "IMAGE-INVENTORY.json", "SHA256SUMS",
                            "evidence/sbom-amd64.spdx.json", "evidence/sbom-arm64.spdx.json"}
    contents = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r|gz") as archive:
        for member in archive:
            require(member.name in expected and member.name not in contents, "Exact unique TAR members required")
            require(member.isfile() and member.mode == (0o755 if member.name.endswith("run-bundle.sh") else 0o644), "Regular TAR member/mode required")
            total += member.size
            require(0 <= member.size <= LIMIT and total <= LIMIT, "Expanded TAR exceeds bound")
            data = archive.extractfile(member).read()
            require(len(data) == member.size, "TAR size differs")
            contents[member.name] = data
    require(set(contents) == expected, "Twelve TAR members required")
    sums = {}
    for line in contents["SHA256SUMS"].decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match and match[2] not in sums, "Unique checksum records required")
        sums[match[2]] = match[1]
    require(set(sums) == expected - {"SHA256SUMS"} and all(sha(contents[n]) == h for n, h in sums.items()), "Inner checksum closure differs")
    declaration = strict_json(contents["SOURCE.json"])
    inventory = strict_json(contents["IMAGE-INVENTORY.json"])
    for doc in (declaration, inventory):
        require(doc["sourceSHA"] == SHA and doc["workflowRef"] == "iuliandita/ditero/.github/workflows/aio-experimental.yml@refs/heads/develop" and doc["workflowRunURL"] == f"https://github.com/iuliandita/ditero/actions/runs/{RUN}", "Publication identity differs")
    require(declaration["experimental"] is True and declaration["runtimeQualified"] is False and declaration["workflow"] == "aio-experimental.yml", "Experimental source contract differs")
    require(set(declaration["sourceFiles"]) == set(FILES), "Seven source pins required")
    for name in FILES:
        path = source / name
        require(path.is_file() and not path.is_symlink() and path.read_bytes() == contents[name] and sha(contents[name]) == declaration["sourceFiles"][name], "Candidate source bytes differ")
    require(inventory["candidate"] == CANDIDATE and inventory["repositories"] == ["ghcr.io/iuliandita/ditero", "docker.io/iuliandita/ditero"] and DIGEST.fullmatch(inventory["indexDigest"]), "Immutable inventory differs")
    require(all(inventory[k] is True for k in ("indexRegistriesMatch", "indexSigned", "indexProvenanceAttested")) and set(inventory["platforms"]) == {"amd64", "arm64"}, "Incomplete inventory")
    for arch, row in inventory["platforms"].items():
        require(row["sourceSHA"] == SHA and row["platform"] == "linux/" + arch and DIGEST.fullmatch(row["digest"]) and row["sbom"] == f"sbom-{arch}.spdx.json", "Platform identity differs")
        require(all(row[k] is True for k in ("registriesMatch", "scanPassed", "signed", "provenanceAttested")), "Incomplete platform evidence")
        data = contents["evidence/" + row["sbom"]]
        require(sha(data) == row["sbomSHA256"] and strict_json(data)["spdxVersion"].startswith("SPDX-"), "SPDX bytes differ")
    return contents, inventory

def command(argv, env, timeout, cap=2 * 1024**2, cleanup_timeout=30, drain_on_cancel=False):
    check_cancellation()
    require(COMMAND_DEADLINE is None or COMMAND_DEADLINE - time.monotonic() >= timeout + cleanup_timeout + 10,
            "Insufficient window for phase and full cleanup reserve")
    proc = None
    deadline = time.monotonic() + timeout
    streams = selectors.DefaultSelector()
    data = {"stdout": bytearray(), "stderr": bytearray()}
    try:
        # The signal handler records intent without raising between spawn and
        # registration; finally owns the child from the instant Popen returns.
        proc = subprocess.Popen(argv, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr)):
            streams.register(stream, selectors.EVENT_READ, name)
        deadline = time.monotonic() + timeout
        while streams.get_map():
            check_cancellation()
            require(time.monotonic() < deadline, "Command deadline exceeded")
            for key, _ in streams.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                data[key.data].extend(chunk)
                require(sum(map(len, data.values())) <= cap, "Command output exceeds bound")
        check_cancellation()
        require(proc.wait(timeout=max(0.1, deadline - time.monotonic())) == 0, "Command failed; runtime output withheld")
        return bytes(data["stdout"])
    finally:
        streams.close()
        if proc is not None:
            if proc.poll() is None:
                # Harness cleanup belongs to its parent; signaling the whole
                # group here would also interrupt its owned cleanup children.
                draining = drain_on_cancel and CANCELLATION is not None
                if not draining:
                    try:
                        proc.send_signal(signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                try:
                    # The synchronous role harness has no signal handler. Let
                    # its fixed phase deadline reach its existing finally.
                    proc.wait(timeout=max(0.1, deadline - time.monotonic()) if draining else cleanup_timeout)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait(timeout=10)
            for stream in (proc.stdout, proc.stderr):
                if stream is not None:
                    stream.close()

def save_receipt(output, receipt):
    if CANCELLATION is not None:
        receipt.update(passed=False, cancellationSignal=CANCELLATION)
    (output / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")

def main():
    global COMMAND_DEADLINE
    COMMAND_DEADLINE = time.monotonic() + 65 * 60
    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, request_cancellation)
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive-dir", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--arch", choices=("amd64", "arm64"), required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    require(not args.output.exists(), "Fresh receipt directory required")
    args.output.mkdir(mode=0o700)
    receipt = {"passed": False, "sourceSHA": SHA, "candidate": CANDIDATE, "run": RUN,
               "attempt": 1, "artifactID": ARTIFACT, "arch": args.arch,
               "scope": "Published native role/runtime and wrapper lifecycle only; no backup/restore qualification",
               "failureVolumeLifetime": "Retained failed volumes exist only until the hosted runner is decommissioned"}
    try:
        archives = list(args.archive_dir.iterdir())
        require(len(archives) == 1 and archives[0].is_file() and not archives[0].is_symlink(), "One downloaded ZIP required")
        require(archives[0].stat().st_size == 781800, "Published ZIP size differs")
        raw = archives[0].read_bytes()
        require(sha(raw) == ZIP_SHA, "Published ZIP digest differs")
        contents, inventory = validate_package(raw, args.source)
        for name, digest in TESTS.items():
            path = args.source / "tests/container" / name
            require(path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == digest, "Candidate runtime test pin differs")
        require(platform.machine() == {"amd64": "x86_64", "arm64": "aarch64"}[args.arch], "Native host architecture required")
        with tempfile.TemporaryDirectory(prefix="ditero-aio-qualification-") as temporary:
            root = Path(temporary)
            config = root / "docker-auth"
            config.mkdir(mode=0o700)
            (config / "config.json").write_text('{"auths":{}}')
            env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL") if k in os.environ}
            env.update(HOME=str(root), DOCKER_CONFIG=str(config))
            require(command(["git", "-C", str(args.source), "rev-parse", "HEAD"], env, 15).decode().strip() == SHA, "Exact candidate checkout required")
            require(command(["docker", "info", "--format", "{{.Architecture}}"], env, 30).decode().strip() in {"amd64": ("x86_64", "amd64"), "arm64": ("aarch64", "arm64")}[args.arch], "Native Docker architecture required")
            command(["sudo", "-n", "true"], env, 15)
            image = "ghcr.io/iuliandita/ditero@" + inventory["platforms"][args.arch]["digest"]
            manifest = strict_json(command(["docker", "manifest", "inspect", image], env, 60))
            require(manifest.get("schemaVersion") == 2 and isinstance(manifest.get("layers"), list), "Platform manifest required")
            layers = manifest["layers"] + [manifest["config"]]
            require(all(type(x.get("size")) is int and 0 < x["size"] <= 8 * 1024**3 and DIGEST.fullmatch(x["digest"]) for x in layers), "Bounded image descriptors required")
            payload = sum(x["size"] for x in layers)
            require(payload <= 8 * 1024**3, "Image payload exceeds 8 GiB")
            store = command(["docker", "info", "--format", "{{.DockerRootDir}}"], env, 30).decode().strip()
            required = 3 * payload + 2 * 1024**3
            for directory in (Path(store), root):
                fs = os.statvfs(directory)
                require(fs.f_bavail * fs.f_frsize >= required, "Insufficient measured image/runtime headroom")
            command(["docker", "pull", "--platform", "linux/" + args.arch, image], env, 300)
            loaded = strict_json(command(["docker", "image", "inspect", image], env, 30))[0]
            require(loaded["Architecture"] == args.arch and loaded["Os"] == "linux" and image in loaded["RepoDigests"] and loaded["Config"]["Labels"]["org.opencontainers.image.revision"] == SHA and loaded["Config"]["Labels"]["ditero.channel"] == "aio-experimental", "Loaded publication identity differs")
            package = root / "package"
            package.mkdir()
            for name, data in contents.items():
                path = package / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o755 if name.endswith("run-bundle.sh") else 0o644)
            runtime = command(["node", str(args.source / "tests/container/aio-runtime.mjs")], {**env, "DITERO_AIO_TEST_IMAGE": image}, 16 * 60, cleanup_timeout=180, drain_on_cancel=True)
            require(re.search(rb"^AIO actual runtime: [1-9][0-9]* checks passed$", runtime, re.MULTILINE), "Pinned runtime final completion required")
            receipt.update(runtimeExitStatus=0, image=image, imageID=loaded["Id"], payloadBytes=payload, runtimeOutputSHA256=sha(runtime), runtimeOutputBytes=len(runtime))
            wrapper = command(["node", str(args.source / "tests/container/aio-wrapper-runtime.mjs"), str(package / "deploy/docker/aio"), image], env, 31 * 60, cleanup_timeout=300)
            match = re.search(rb"^Packaged wrapper receipt: (.+)/receipt.json$", wrapper, re.MULTILINE)
            require(match, "Actual wrapper receipt required")
            fixture = Path(os.fsdecode(match[1]))
            require(fixture.parent == Path(tempfile.gettempdir()) and fixture.name.startswith("ditero-aio-wrapper-") and not fixture.is_symlink(), "Owned wrapper receipt path required")
            proof = strict_json((fixture / "receipt.json").read_bytes())
            require(proof["passed"] is True and proof["exitStatus"] == 0 and proof.get("interruption") is None and proof["image"] == image and proof["imageID"] == loaded["Id"] and proof["sourceSHA"] == SHA and [x["kind"] for x in proof["cases"]] == ["TERM", "HUP", "health"] and all(x["passed"] is True and x["cleanupPassed"] is True and not x["retainedVolumes"] for x in proof["cases"]), "Wrapper qualification/cleanup incomplete")
            receipt.update(passed=True, wrapperReceiptSHA256=sha((fixture / "receipt.json").read_bytes()), wrapperCases=[{k:row[k] for k in ("kind", "passed", "cleanupPassed", "wrapperExit", "monitorSourceSHA256")} for row in proof["cases"]], testSourcePins=TESTS)
    finally:
        save_receipt(args.output, receipt)
    check_cancellation()
    print("Published native AIO qualification passed")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Published AIO qualification failed: " + type(error).__name__ + "; raw output withheld", file=__import__("sys").stderr)
        raise SystemExit(128 + CANCELLATION if CANCELLATION is not None else 1)
