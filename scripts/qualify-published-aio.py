#!/usr/bin/env python3
"""Qualify one existing AIO publication on a disposable native Docker host."""
import argparse
from enum import Enum
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

class Guard(str, Enum):
    ACTUAL_WRAPPER_RECEIPT_REQUIRED = "actual-wrapper-receipt-required"
    ARTIFACT_EXCEEDS_BOUND = "artifact-exceeds-bound"
    BOUNDED_IMAGE_DESCRIPTORS_REQUIRED = "bounded-image-descriptors-required"
    CANDIDATE_RUNTIME_TEST_PIN_DIFFERS = "candidate-runtime-test-pin-differs"
    CANDIDATE_SOURCE_BYTES_DIFFER = "candidate-source-bytes-differ"
    COMMAND_DEADLINE_EXCEEDED = "command-deadline-exceeded"
    COMMAND_FAILED_RUNTIME_OUTPUT_WITHHELD = "command-failed-runtime-output-withheld"
    COMMAND_OUTPUT_EXCEEDS_BOUND = "command-output-exceeds-bound"
    DUPLICATE_JSON_KEY = "duplicate-json-key"
    EXACT_ZIP_MEMBERS_REQUIRED = "exact-zip-members-required"
    EXACT_CANDIDATE_CHECKOUT_REQUIRED = "exact-candidate-checkout-required"
    EXACT_UNIQUE_TAR_MEMBERS_REQUIRED = "exact-unique-tar-members-required"
    EXPANDED_TAR_EXCEEDS_BOUND = "expanded-tar-exceeds-bound"
    EXPANDED_ZIP_EXCEEDS_BOUND = "expanded-zip-exceeds-bound"
    EXPERIMENTAL_SOURCE_CONTRACT_DIFFERS = "experimental-source-contract-differs"
    FRESH_RECEIPT_DIRECTORY_REQUIRED = "fresh-receipt-directory-required"
    IMAGE_PAYLOAD_EXCEEDS_8_GIB = "image-payload-exceeds-8-gib"
    IMMUTABLE_INVENTORY_DIFFERS = "immutable-inventory-differs"
    INCOMPLETE_INVENTORY = "incomplete-inventory"
    INCOMPLETE_PLATFORM_EVIDENCE = "incomplete-platform-evidence"
    INNER_CHECKSUM_CLOSURE_DIFFERS = "inner-checksum-closure-differs"
    INSUFFICIENT_MEASURED_IMAGE_RUNTIME_HEADROOM = "insufficient-measured-image-runtime-headroom"
    INSUFFICIENT_WINDOW_FOR_PHASE_AND_FULL_CLEANUP_RESERVE = "insufficient-window-for-phase-and-full-cleanup-reserve"
    LOADED_PUBLICATION_IDENTITY_DIFFERS = "loaded-publication-identity-differs"
    NATIVE_DOCKER_ARCHITECTURE_REQUIRED = "native-docker-architecture-required"
    NATIVE_HOST_ARCHITECTURE_REQUIRED = "native-host-architecture-required"
    ONE_DOWNLOADED_ZIP_REQUIRED = "one-downloaded-zip-required"
    OUTER_CHECKSUM_DIFFERS = "outer-checksum-differs"
    OWNED_WRAPPER_RECEIPT_PATH_REQUIRED = "owned-wrapper-receipt-path-required"
    PINNED_RUNTIME_FINAL_COMPLETION_REQUIRED = "pinned-runtime-final-completion-required"
    PLATFORM_IDENTITY_DIFFERS = "platform-identity-differs"
    PLATFORM_MANIFEST_REQUIRED = "platform-manifest-required"
    PUBLICATION_IDENTITY_DIFFERS = "publication-identity-differs"
    PUBLISHED_ZIP_DIGEST_DIFFERS = "published-zip-digest-differs"
    PUBLISHED_ZIP_SIZE_DIFFERS = "published-zip-size-differs"
    REGULAR_TAR_MEMBER_MODE_REQUIRED = "regular-tar-member-mode-required"
    REGULAR_ZIP_MEMBERS_REQUIRED = "regular-zip-members-required"
    SPDX_BYTES_DIFFER = "spdx-bytes-differ"
    SEVEN_SOURCE_PINS_REQUIRED = "seven-source-pins-required"
    TAR_SIZE_DIFFERS = "tar-size-differs"
    TWELVE_TAR_MEMBERS_REQUIRED = "twelve-tar-members-required"
    UNIQUE_CHECKSUM_RECORDS_REQUIRED = "unique-checksum-records-required"
    WRAPPER_QUALIFICATION_CLEANUP_INCOMPLETE = "wrapper-qualification-cleanup-incomplete"

    UNEXPECTED_EXCEPTION = "unexpected-exception"
    CANCELLED = "cancelled"

class Stage(str, Enum):
    ARCHIVE_SHAPE = "archive-shape"
    ARCHIVE_SIZE = "archive-size"
    ARCHIVE_SHA = "archive-sha"
    PACKAGE_VALIDATION = "package-validation"
    TEST_SOURCE_PINS = "test-source-pins"
    NATIVE_HOST = "native-host"
    CANDIDATE_CHECKOUT = "candidate-checkout"
    NATIVE_DOCKER = "native-docker"
    SUDO_CAPABILITY = "sudo-capability"
    PLATFORM_MANIFEST = "platform-manifest"
    CAPACITY_CHECK = "capacity-check"
    IMAGE_PULL = "image-pull"
    IMAGE_INSPECT = "image-inspect"
    PACKAGE_EXTRACTION = "package-extraction"
    ROLE_RUNTIME = "role-runtime"
    WRAPPER_RUNTIME = "wrapper-runtime"
    WRAPPER_PROOF = "wrapper-proof"
    COMPLETE = "complete"

class GuardFailure(ValueError):
    def __init__(self, guard):
        self.guard = guard
        super().__init__(guard.value)

def failure_context(error):
    guard = error.guard if isinstance(error, GuardFailure) else Guard.CANCELLED if isinstance(error, Cancelled) else Guard.UNEXPECTED_EXCEPTION
    known = (ValueError, KeyError, TypeError, OSError, UnicodeError, subprocess.TimeoutExpired)
    kind = "GuardFailure" if isinstance(error, GuardFailure) else "Cancelled" if isinstance(error, Cancelled) else next((c.__name__ for c in known if isinstance(error, c)), "UnexpectedError")
    return {"failureIdentifier": guard.value, "exceptionType": kind}

def runtime_progress(stdout, stderr):
    phases = {"prepare", "fresh startup", "retained restart", "scoped unsafe-input rejection", "essential child failure", "retained credential bytes and metadata", "scoped cleanup"}
    markers = {"fresh migration and API/Zero health", "retained restart identity, migrations and attachment bytes", "essential API child failure exits guardian", "missing-credential-file", "wrong-credential-owner", "wrong-data-mount-owner"}
    markers.update(f"{role} image and security configuration" for role in ("postgres", "migrate", "api", "zero"))
    markers.update(f"{role} {check}" for role in ("postgres", "api", "zero") for check in ("actual UID/groups/capabilities and readonly root", "fresh volume ownership"))
    allowed = {("PASS " + name).encode() for name in markers}
    result = {"completedPassMarkerCount": len(set(stdout.splitlines()) & allowed)}
    for line in stderr.splitlines():
        prefix = b"AIO runtime phase failed: "
        if line.startswith(prefix):
            phase = line[len(prefix):].decode("ascii", "replace")
            if phase in phases:
                result["harnessPhase"] = phase
    return result

def require(value, guard):
    if not isinstance(guard, Guard):
        raise GuardFailure(Guard.UNEXPECTED_EXCEPTION)
    if not value:
        raise GuardFailure(guard)

def sha(data):
    return hashlib.sha256(data).hexdigest()

def strict_json(data):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, Guard.DUPLICATE_JSON_KEY)
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=unique)

def validate_package(raw, source):
    require(len(raw) <= LIMIT, Guard.ARTIFACT_EXCEEDS_BOUND)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        names = {CANDIDATE + ".tar.gz", "SHA256SUMS"}
        require(len(members) == 2 and {m.filename for m in members} == names, Guard.EXACT_ZIP_MEMBERS_REQUIRED)
        require(sum(m.file_size for m in members) <= LIMIT, Guard.EXPANDED_ZIP_EXCEEDS_BOUND)
        require(all(not m.is_dir() and stat.S_IFMT(m.external_attr >> 16) in (0, stat.S_IFREG) for m in members), Guard.REGULAR_ZIP_MEMBERS_REQUIRED)
        packed = archive.read(CANDIDATE + ".tar.gz")
        require(archive.read("SHA256SUMS") == f"{sha(packed)}  {CANDIDATE}.tar.gz\n".encode(), Guard.OUTER_CHECKSUM_DIFFERS)
    expected = set(FILES) | {"SOURCE.json", "IMAGE-INVENTORY.json", "SHA256SUMS",
                            "evidence/sbom-amd64.spdx.json", "evidence/sbom-arm64.spdx.json"}
    contents = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(packed), mode="r|gz") as archive:
        for member in archive:
            require(member.name in expected and member.name not in contents, Guard.EXACT_UNIQUE_TAR_MEMBERS_REQUIRED)
            require(member.isfile() and member.mode == (0o755 if member.name.endswith("run-bundle.sh") else 0o644), Guard.REGULAR_TAR_MEMBER_MODE_REQUIRED)
            total += member.size
            require(0 <= member.size <= LIMIT and total <= LIMIT, Guard.EXPANDED_TAR_EXCEEDS_BOUND)
            data = archive.extractfile(member).read()
            require(len(data) == member.size, Guard.TAR_SIZE_DIFFERS)
            contents[member.name] = data
    require(set(contents) == expected, Guard.TWELVE_TAR_MEMBERS_REQUIRED)
    sums = {}
    for line in contents["SHA256SUMS"].decode().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  (.+)", line)
        require(match and match[2] not in sums, Guard.UNIQUE_CHECKSUM_RECORDS_REQUIRED)
        sums[match[2]] = match[1]
    require(set(sums) == expected - {"SHA256SUMS"} and all(sha(contents[n]) == h for n, h in sums.items()), Guard.INNER_CHECKSUM_CLOSURE_DIFFERS)
    declaration = strict_json(contents["SOURCE.json"])
    inventory = strict_json(contents["IMAGE-INVENTORY.json"])
    for doc in (declaration, inventory):
        require(doc["sourceSHA"] == SHA and doc["workflowRef"] == "iuliandita/ditero/.github/workflows/aio-experimental.yml@refs/heads/develop" and doc["workflowRunURL"] == f"https://github.com/iuliandita/ditero/actions/runs/{RUN}", Guard.PUBLICATION_IDENTITY_DIFFERS)
    require(declaration["experimental"] is True and declaration["runtimeQualified"] is False and declaration["workflow"] == "aio-experimental.yml", Guard.EXPERIMENTAL_SOURCE_CONTRACT_DIFFERS)
    require(set(declaration["sourceFiles"]) == set(FILES), Guard.SEVEN_SOURCE_PINS_REQUIRED)
    for name in FILES:
        path = source / name
        require(path.is_file() and not path.is_symlink() and path.read_bytes() == contents[name] and sha(contents[name]) == declaration["sourceFiles"][name], Guard.CANDIDATE_SOURCE_BYTES_DIFFER)
    require(inventory["candidate"] == CANDIDATE and inventory["repositories"] == ["ghcr.io/iuliandita/ditero", "docker.io/iuliandita/ditero"] and DIGEST.fullmatch(inventory["indexDigest"]), Guard.IMMUTABLE_INVENTORY_DIFFERS)
    require(all(inventory[k] is True for k in ("indexRegistriesMatch", "indexSigned", "indexProvenanceAttested")) and set(inventory["platforms"]) == {"amd64", "arm64"}, Guard.INCOMPLETE_INVENTORY)
    for arch, row in inventory["platforms"].items():
        require(row["sourceSHA"] == SHA and row["platform"] == "linux/" + arch and DIGEST.fullmatch(row["digest"]) and row["sbom"] == f"sbom-{arch}.spdx.json", Guard.PLATFORM_IDENTITY_DIFFERS)
        require(all(row[k] is True for k in ("registriesMatch", "scanPassed", "signed", "provenanceAttested")), Guard.INCOMPLETE_PLATFORM_EVIDENCE)
        data = contents["evidence/" + row["sbom"]]
        require(sha(data) == row["sbomSHA256"] and strict_json(data)["spdxVersion"].startswith("SPDX-"), Guard.SPDX_BYTES_DIFFER)
    return contents, inventory

def command(argv, env, timeout, cap=2 * 1024**2, cleanup_timeout=30, drain_on_cancel=False, context=None):
    metadata = {"exitCode": None, "timedOut": False, "outputCapExceeded": False, "cancelled": False, "ownedCommandReaped": False, "stdoutBytes": 0, "stderrBytes": 0}
    if context is not None:
        metadata["stage"] = next((stage.value for stage in Stage if stage.value == context.get("stage")), None)
        context["command"] = metadata
    check_cancellation()
    require(COMMAND_DEADLINE is None or COMMAND_DEADLINE - time.monotonic() >= timeout + cleanup_timeout + 10,
            Guard.INSUFFICIENT_WINDOW_FOR_PHASE_AND_FULL_CLEANUP_RESERVE)
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
            require(time.monotonic() < deadline, Guard.COMMAND_DEADLINE_EXCEEDED)
            for key, _ in streams.select(min(0.1, max(0, deadline - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    streams.unregister(key.fileobj)
                    continue
                data[key.data].extend(chunk)
                require(sum(map(len, data.values())) <= cap, Guard.COMMAND_OUTPUT_EXCEEDS_BOUND)
        check_cancellation()
        require(proc.wait(timeout=max(0.1, deadline - time.monotonic())) == 0, Guard.COMMAND_FAILED_RUNTIME_OUTPUT_WITHHELD)
        return bytes(data["stdout"])
    except BaseException as error:
        metadata.update(failure_context(error))
        metadata["timedOut"] = isinstance(error, subprocess.TimeoutExpired) or isinstance(error, GuardFailure) and error.guard == Guard.COMMAND_DEADLINE_EXCEEDED
        metadata["outputCapExceeded"] = isinstance(error, GuardFailure) and error.guard == Guard.COMMAND_OUTPUT_EXCEEDS_BOUND
        raise
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
        metadata.update(exitCode=proc.returncode if proc is not None else None,
                        cancelled=CANCELLATION is not None, ownedCommandReaped=proc is not None and proc.poll() is not None,
                        stdoutBytes=len(data["stdout"]), stderrBytes=len(data["stderr"]))
        if context is not None and context.get("stage") == Stage.ROLE_RUNTIME.value:
            metadata.update(runtime_progress(bytes(data["stdout"]), bytes(data["stderr"])))

def save_receipt(output, receipt):
    if CANCELLATION is not None:
        receipt.update(passed=False, cancellationSignal=CANCELLATION, failureIdentifier=Guard.CANCELLED.value, exceptionType="Cancelled")
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
    require(not args.output.exists(), Guard.FRESH_RECEIPT_DIRECTORY_REQUIRED)
    args.output.mkdir(mode=0o700)
    receipt = {"passed": False, "sourceSHA": SHA, "candidate": CANDIDATE, "run": RUN,
               "stage": Stage.ARCHIVE_SHAPE.value,
               "attempt": 1, "artifactID": ARTIFACT, "arch": args.arch,
               "scope": "Published native role/runtime and wrapper lifecycle only; no backup/restore qualification",
               "failureVolumeLifetime": "Retained failed volumes exist only until the hosted runner is decommissioned"}
    try:
        receipt["stage"] = Stage.ARCHIVE_SHAPE.value
        archives = list(args.archive_dir.iterdir())
        require(len(archives) == 1 and archives[0].is_file() and not archives[0].is_symlink(), Guard.ONE_DOWNLOADED_ZIP_REQUIRED)
        receipt["stage"] = Stage.ARCHIVE_SIZE.value
        require(archives[0].stat().st_size == 781800, Guard.PUBLISHED_ZIP_SIZE_DIFFERS)
        receipt["stage"] = Stage.ARCHIVE_SHA.value
        raw = archives[0].read_bytes()
        require(sha(raw) == ZIP_SHA, Guard.PUBLISHED_ZIP_DIGEST_DIFFERS)
        receipt["stage"] = Stage.PACKAGE_VALIDATION.value
        contents, inventory = validate_package(raw, args.source)
        receipt["stage"] = Stage.TEST_SOURCE_PINS.value
        for name, digest in TESTS.items():
            path = args.source / "tests/container" / name
            require(path.is_file() and not path.is_symlink() and sha(path.read_bytes()) == digest, Guard.CANDIDATE_RUNTIME_TEST_PIN_DIFFERS)
        receipt["stage"] = Stage.NATIVE_HOST.value
        require(platform.machine() == {"amd64": "x86_64", "arm64": "aarch64"}[args.arch], Guard.NATIVE_HOST_ARCHITECTURE_REQUIRED)
        with tempfile.TemporaryDirectory(prefix="ditero-aio-qualification-") as temporary:
            root = Path(temporary)
            config = root / "docker-auth"
            config.mkdir(mode=0o700)
            (config / "config.json").write_text('{"auths":{}}')
            env = {k: os.environ[k] for k in ("PATH", "LANG", "LC_ALL") if k in os.environ}
            env.update(HOME=str(root), DOCKER_CONFIG=str(config))
            receipt["stage"] = Stage.CANDIDATE_CHECKOUT.value
            require(command(["git", "-C", str(args.source), "rev-parse", "HEAD"], env, 15, context=receipt).decode().strip() == SHA, Guard.EXACT_CANDIDATE_CHECKOUT_REQUIRED)
            receipt["stage"] = Stage.NATIVE_DOCKER.value
            require(command(["docker", "info", "--format", "{{.Architecture}}"], env, 30, context=receipt).decode().strip() in {"amd64": ("x86_64", "amd64"), "arm64": ("aarch64", "arm64")}[args.arch], Guard.NATIVE_DOCKER_ARCHITECTURE_REQUIRED)
            receipt["stage"] = Stage.SUDO_CAPABILITY.value
            command(["sudo", "-n", "true"], env, 15, context=receipt)
            image = "ghcr.io/iuliandita/ditero@" + inventory["platforms"][args.arch]["digest"]
            receipt["stage"] = Stage.PLATFORM_MANIFEST.value
            manifest = strict_json(command(["docker", "manifest", "inspect", image], env, 60, context=receipt))
            require(manifest.get("schemaVersion") == 2 and isinstance(manifest.get("layers"), list), Guard.PLATFORM_MANIFEST_REQUIRED)
            layers = manifest["layers"] + [manifest["config"]]
            require(all(type(x.get("size")) is int and 0 < x["size"] <= 8 * 1024**3 and DIGEST.fullmatch(x["digest"]) for x in layers), Guard.BOUNDED_IMAGE_DESCRIPTORS_REQUIRED)
            payload = sum(x["size"] for x in layers)
            require(payload <= 8 * 1024**3, Guard.IMAGE_PAYLOAD_EXCEEDS_8_GIB)
            receipt["stage"] = Stage.CAPACITY_CHECK.value
            store = command(["docker", "info", "--format", "{{.DockerRootDir}}"], env, 30, context=receipt).decode().strip()
            required = 3 * payload + 2 * 1024**3
            for directory in (Path(store), root):
                fs = os.statvfs(directory)
                require(fs.f_bavail * fs.f_frsize >= required, Guard.INSUFFICIENT_MEASURED_IMAGE_RUNTIME_HEADROOM)
            receipt["stage"] = Stage.IMAGE_PULL.value
            command(["docker", "pull", "--platform", "linux/" + args.arch, image], env, 300, context=receipt)
            receipt["stage"] = Stage.IMAGE_INSPECT.value
            loaded = strict_json(command(["docker", "image", "inspect", image], env, 30, context=receipt))[0]
            require(loaded["Architecture"] == args.arch and loaded["Os"] == "linux" and image in loaded["RepoDigests"] and loaded["Config"]["Labels"]["org.opencontainers.image.revision"] == SHA and loaded["Config"]["Labels"]["ditero.channel"] == "aio-experimental", Guard.LOADED_PUBLICATION_IDENTITY_DIFFERS)
            receipt["stage"] = Stage.PACKAGE_EXTRACTION.value
            package = root / "package"
            package.mkdir()
            for name, data in contents.items():
                path = package / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                path.chmod(0o755 if name.endswith("run-bundle.sh") else 0o644)
            receipt["stage"] = Stage.ROLE_RUNTIME.value
            runtime = command(["node", str(args.source / "tests/container/aio-runtime.mjs")], {**env, "DITERO_AIO_TEST_IMAGE": image}, 16 * 60, cleanup_timeout=180, drain_on_cancel=True, context=receipt)
            require(re.search(rb"^AIO actual runtime: [1-9][0-9]* checks passed$", runtime, re.MULTILINE), Guard.PINNED_RUNTIME_FINAL_COMPLETION_REQUIRED)
            receipt.update(runtimeExitStatus=0, image=image, imageID=loaded["Id"], payloadBytes=payload, runtimeOutputSHA256=sha(runtime), runtimeOutputBytes=len(runtime))
            receipt["stage"] = Stage.WRAPPER_RUNTIME.value
            wrapper = command(["node", str(args.source / "tests/container/aio-wrapper-runtime.mjs"), str(package / "deploy/docker/aio"), image], env, 31 * 60, cleanup_timeout=300, context=receipt)
            receipt["stage"] = Stage.WRAPPER_PROOF.value
            match = re.search(rb"^Packaged wrapper receipt: (.+)/receipt.json$", wrapper, re.MULTILINE)
            require(match, Guard.ACTUAL_WRAPPER_RECEIPT_REQUIRED)
            fixture = Path(os.fsdecode(match[1]))
            require(fixture.parent == Path(tempfile.gettempdir()) and fixture.name.startswith("ditero-aio-wrapper-") and not fixture.is_symlink(), Guard.OWNED_WRAPPER_RECEIPT_PATH_REQUIRED)
            proof = strict_json((fixture / "receipt.json").read_bytes())
            require(proof["passed"] is True and proof["exitStatus"] == 0 and proof.get("interruption") is None and proof["image"] == image and proof["imageID"] == loaded["Id"] and proof["sourceSHA"] == SHA and [x["kind"] for x in proof["cases"]] == ["TERM", "HUP", "health"] and all(x["passed"] is True and x["cleanupPassed"] is True and not x["retainedVolumes"] for x in proof["cases"]), Guard.WRAPPER_QUALIFICATION_CLEANUP_INCOMPLETE)
            receipt.update(passed=True, wrapperReceiptSHA256=sha((fixture / "receipt.json").read_bytes()), wrapperCases=[{k:row[k] for k in ("kind", "passed", "cleanupPassed", "wrapperExit", "monitorSourceSHA256")} for row in proof["cases"]], testSourcePins=TESTS)
        receipt["stage"] = Stage.COMPLETE.value
    except BaseException as error:
        receipt.update(passed=False, **failure_context(error))
        raise
    finally:
        save_receipt(args.output, receipt)
    check_cancellation()
    print("Published native AIO qualification passed")

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print("Published AIO qualification failed: " + failure_context(error)["failureIdentifier"] + "; raw output withheld", file=__import__("sys").stderr)
        raise SystemExit(128 + CANCELLATION if CANCELLATION is not None else 1)
