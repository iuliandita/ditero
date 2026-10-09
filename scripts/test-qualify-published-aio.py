#!/usr/bin/env python3
"""Offline controls for the published package boundary; no container calls."""
import importlib.util
import io
import gzip
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("qualify", Path(__file__).with_name("qualify-published-aio.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class PackageBoundary(unittest.TestCase):
    def package(self, source, mutation=None, edit=None):
        files = {name: b"candidate bytes\n" for name in m.FILES}
        for name, data in files.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        identity = {"sourceSHA": m.SHA, "workflowRef": "iuliandita/ditero/.github/workflows/aio-experimental.yml@refs/heads/develop", "workflowRunURL": f"https://github.com/iuliandita/ditero/actions/runs/{m.RUN}"}
        files["SOURCE.json"] = json.dumps({**identity, "experimental": True, "runtimeQualified": False, "workflow": "aio-experimental.yml", "sourceFiles": {n:m.sha(files[n]) for n in m.FILES}}).encode()
        platforms = {}
        for arch in ("amd64", "arm64"):
            sbom = json.dumps({"spdxVersion": "SPDX-2.3"}).encode()
            files[f"evidence/sbom-{arch}.spdx.json"] = sbom
            platforms[arch] = {"sourceSHA": m.SHA, "platform": "linux/" + arch, "digest": "sha256:" + "a" * 64, "sbom": f"sbom-{arch}.spdx.json", "sbomSHA256": m.sha(sbom), **{k:True for k in ("registriesMatch", "scanPassed", "signed", "provenanceAttested")}}
        files["IMAGE-INVENTORY.json"] = json.dumps({**identity, "candidate": m.CANDIDATE, "repositories": ["ghcr.io/iuliandita/ditero", "docker.io/iuliandita/ditero"], "indexDigest": "sha256:" + "b" * 64, "platforms": platforms, **{k:True for k in ("indexRegistriesMatch", "indexSigned", "indexProvenanceAttested")}}).encode()
        if edit:
            edit(files)
        files["SHA256SUMS"] = "".join(f"{m.sha(data)}  {name}\n" for name,data in files.items()).encode()
        packed = io.BytesIO()
        with tarfile.open(fileobj=packed, mode="w:gz") as archive:
            for name,data in files.items():
                member = tarfile.TarInfo(name)
                member.mode = 0o755 if name.endswith("run-bundle.sh") else 0o644
                member.size = len(data)
                if mutation:
                    mutation(member)
                archive.addfile(member, io.BytesIO(data) if member.isfile() else None)
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, "w") as archive:
            archive.writestr(m.CANDIDATE + ".tar.gz", packed.getvalue())
            archive.writestr("SHA256SUMS", f"{m.sha(packed.getvalue())}  {m.CANDIDATE}.tar.gz\n")
        return raw.getvalue()

    def test_complete_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            contents, inventory = m.validate_package(self.package(source), source)
            self.assertEqual(len(contents), 12)
            self.assertEqual(set(inventory["platforms"]), {"amd64", "arm64"})

    def test_reject_link_and_traversal(self):
        def link(member):
            if member.name == "LICENSE":
                member.type = tarfile.SYMTYPE
                member.linkname = "outside"
        def traversal(member):
            if member.name == "LICENSE":
                member.name = "../LICENSE"
        for mutation in (link, traversal):
            with self.subTest(mutation=mutation.__name__), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                with self.assertRaises(ValueError):
                    m.validate_package(self.package(source, mutation), source)

    def test_candidate_mismatch(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            raw = self.package(source)
            (source / "LICENSE").write_bytes(b"changed")
            with self.assertRaises(ValueError):
                m.validate_package(raw, source)

    def test_mode_and_oversized_member(self):
        def mode(member):
            member.mode = 0o777
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            with self.assertRaises(ValueError):
                m.validate_package(self.package(source, mode), source)
        # Reject an oversized TAR declaration before its missing body is read.
        member = tarfile.TarInfo("LICENSE")
        member.mode = 0o644
        member.size = m.LIMIT + 1
        packed = gzip.compress(member.tobuf() + b"\0" * 1024)
        raw = io.BytesIO()
        with zipfile.ZipFile(raw, "w") as archive:
            archive.writestr(m.CANDIDATE + ".tar.gz", packed)
            archive.writestr("SHA256SUMS", f"{m.sha(packed)}  {m.CANDIDATE}.tar.gz\n")
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(m.GuardFailure) as caught:
                m.validate_package(raw.getvalue(), Path(directory))
            self.assertIs(caught.exception.guard, m.Guard.EXPANDED_TAR_EXCEEDS_BOUND)
            with self.assertRaises(m.GuardFailure) as caught:
                m.validate_package(b"x" * (m.LIMIT + 1), Path(directory))
            self.assertIs(caught.exception.guard, m.Guard.ARTIFACT_EXCEEDS_BOUND)

    def test_inventory_and_source_pin_rejections(self):
        def changed_inventory(files, key, value):
            doc = json.loads(files["IMAGE-INVENTORY.json"])
            doc[key] = value
            files["IMAGE-INVENTORY.json"] = json.dumps(doc).encode()
        for key,value in (("indexSigned", False), ("platforms", {}), ("indexDigest", "latest")):
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                source = Path(directory)
                raw = self.package(source, edit=lambda f:changed_inventory(f,key,value))
                with self.assertRaises(ValueError):
                    m.validate_package(raw, source)
        def wrong_pin(files):
            doc = json.loads(files["SOURCE.json"])
            doc["sourceFiles"]["LICENSE"] = "0" * 64
            files["SOURCE.json"] = json.dumps(doc).encode()
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            with self.assertRaises(ValueError):
                m.validate_package(self.package(source, edit=wrong_pin), source)

    def test_duplicate_zip_and_failed_receipt_sanitization(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            raw = self.package(source)
            out = io.BytesIO(raw)
            with zipfile.ZipFile(out, "a") as z:
                z.writestr("unexpected", b"extra")
            with self.assertRaises(ValueError):
                m.validate_package(out.getvalue(), source)
            # A failed archive is rejected before any subprocess; receipt is safe.
            import subprocess
            archive = source / "archive"
            archive.mkdir()
            (archive / "bad.zip").write_bytes(b"private-secret-payload")
            receipt = source / "receipt"
            proc = subprocess.run(["python3", "-I", str(Path(m.__file__)), "--archive-dir", str(archive), "--source", str(source), "--arch", "amd64", "--output", str(receipt)], capture_output=True)
            self.assertEqual(proc.returncode, 1)
            data = (receipt / "receipt.json").read_bytes()
            self.assertFalse(json.loads(data)["passed"])
            self.assertNotIn(b"private-secret-payload", data + proc.stdout + proc.stderr)

    def test_duplicate_json(self):
        with self.assertRaises(ValueError):
            m.strict_json(b'{"passed":true,"passed":false}')

class ReviewedRuntimeHarness(unittest.TestCase):
    def test_reviewed_pin_and_canonical_candidate_asset_binding(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory)
            candidate = source / "candidate"
            candidate.mkdir()
            (candidate / "asset").write_text("candidate assets")
            (source / "asset").write_text("CI assets")
            argv, env = m.role_runtime_command(candidate / ".." / "candidate", "immutable-image", {})
            self.assertEqual(argv, ["node", str(m.RUNTIME_HARNESS)])
            self.assertEqual(env["DITERO_AIO_TEST_IMAGE"], "immutable-image")
            self.assertEqual(env["DITERO_AIO_TEST_SOURCE"], str(candidate.resolve()))
            harness = m.RUNTIME_HARNESS.read_text()
            root = harness[harness.index("const root ="):harness.index("const project =")]
            probe = source / "tests/container/root.mjs"
            probe.parent.mkdir(parents=True)
            probe.write_text('import { fileURLToPath } from "node:url";\nimport { readFileSync } from "node:fs";\nimport { join } from "node:path";\n' + root + 'console.log(readFileSync(join(root, "asset"), "utf8"));\n')
            for binding, expected in ((env, "candidate assets"), ({}, "CI assets")):
                with self.subTest(binding=bool(binding)):
                    result = subprocess.run(["node", str(probe)], env=binding, capture_output=True, check=True)
                    self.assertEqual(result.stdout.decode().strip(), expected)

    def test_tampered_and_symlink_reviewed_harness_rejected(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            actual = root / "runtime.mjs"
            actual.write_bytes(m.RUNTIME_HARNESS.read_bytes())
            link = root / "link.mjs"
            link.symlink_to(actual)
            with patch.object(m, "RUNTIME_HARNESS", link):
                with self.assertRaises(m.GuardFailure) as caught:
                    m.role_runtime_command(root, "immutable-image", {})
                self.assertIs(caught.exception.guard, m.Guard.REVIEWED_RUNTIME_HARNESS_PIN_DIFFERS)
            actual.write_bytes(actual.read_bytes() + b"\n// changed\n")
            with patch.object(m, "RUNTIME_HARNESS", actual):
                with self.assertRaises(m.GuardFailure) as caught:
                    m.role_runtime_command(root, "immutable-image", {})
                self.assertIs(caught.exception.guard, m.Guard.REVIEWED_RUNTIME_HARNESS_PIN_DIFFERS)

    def test_actual_wrong_mount_fixture_mode_under_both_umasks(self):
        import subprocess
        harness = m.RUNTIME_HARNESS.read_text()
        fixture = harness[harness.index('\tconst wrongMountDir ='):harness.index('\tsudo(["chown", "1002:1002", wrongMountDir]);')]
        with tempfile.TemporaryDirectory() as directory:
            for mask in (0o077, 0o022):
                for corrected in (True, False):
                    with self.subTest(mask=oct(mask), corrected=corrected):
                        branch = fixture if corrected else fixture.replace('\tchmodSync(wrongMountDir, 0o755);\n', '')
                        script = 'import { mkdirSync, chmodSync, statSync } from "node:fs"; import { join } from "node:path";\n' + f'process.umask({mask}); const fixture = process.argv[1];\n' + branch + 'console.log(statSync(wrongMountDir).mode & 0o777);'
                        target = Path(directory) / f"{mask}-{corrected}"
                        target.mkdir()
                        result = subprocess.run(["node", "--input-type=module", "-e", script, str(target)], capture_output=True, check=True)
                        self.assertEqual(int(result.stdout), 0o755 if corrected or mask == 0o022 else 0o700)

class CancellationLifecycle(unittest.TestCase):
    def run_stub(self, draining=False, registration_race=False):
        import os
        import signal
        import subprocess
        import time
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            child = root / "child.py"
            child.write_text("""import os,signal,time
from pathlib import Path
root=Path(__file__).parent
(root/'pid').write_text(str(os.getpid()))
def cleanup(*_):
 time.sleep(0.35)
 (root/'cleaned').write_text('complete')
 raise SystemExit(0)
signal.signal(signal.SIGTERM,cleanup)
(root/'ready').write_text('ready')
""" + ("time.sleep(0.6)\ncleanup()\n" if draining else "while True: time.sleep(0.05)\n"))
            parent = root / "parent.py"
            parent.write_text(f"""import importlib.util,os,signal,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('qualify',{str(Path(m.__file__))!r})
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(__file__).parent
for sig in (signal.SIGTERM,signal.SIGHUP): signal.signal(sig,m.request_cancellation)
""" + ("""original=m.subprocess.Popen
def spawn(*a,**k):
 proc=original(*a,**k)
 while not (root/'ready').exists(): time.sleep(0.01)
 m.request_cancellation(signal.SIGTERM,None)
 return proc
m.subprocess.Popen=spawn
""" if registration_race else "") + f"""try:
 m.command(['python3',str(root/'child.py')],os.environ,3,cleanup_timeout=2,drain_on_cancel={draining!r})
except m.Cancelled: pass
finally:
 m.save_receipt(root,{{'passed':True}})
""")
            proc = subprocess.Popen(["python3", "-I", str(parent)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            limit = time.monotonic() + 5
            while not (root / "ready").exists() and time.monotonic() < limit:
                time.sleep(0.01)
            self.assertTrue((root / "ready").exists())
            if not registration_race:
                proc.send_signal(signal.SIGTERM)
                time.sleep(0.15)
                proc.send_signal(signal.SIGHUP)
            out, err = proc.communicate(timeout=5)
            self.assertEqual(proc.returncode, 0, err)
            self.assertTrue((root / "cleaned").exists())
            proof = json.loads((root / "receipt.json").read_bytes())
            self.assertFalse(proof["passed"])
            self.assertEqual(proof["cancellationSignal"], signal.SIGTERM)
            self.assertEqual(set(proof), {"passed", "cancellationSignal", "failureIdentifier", "exceptionType"})
            self.assertEqual(proof["failureIdentifier"], "cancelled")
            with self.assertRaises(ProcessLookupError):
                os.kill(int((root / "pid").read_text()), 0)

    def test_term_cleanup_and_repeated_signal(self):
        self.run_stub()

    def test_synchronous_harness_drains_on_cancel(self):
        self.run_stub(draining=True)

    def test_cancellation_at_child_registration(self):
        self.run_stub(registration_race=True)

class FailureDiagnostics(unittest.TestCase):
    def setUp(self):
        m.CANCELLATION = None
        m.COMMAND_DEADLINE = None

    def tearDown(self):
        m.CANCELLATION = None
        m.COMMAND_DEADLINE = None

    def test_static_guard_and_unexpected_exception_redaction(self):
        with self.assertRaises(m.GuardFailure) as caught:
            m.require(False, m.Guard.PUBLISHED_ZIP_SIZE_DIFFERS)
        self.assertEqual(m.failure_context(caught.exception)["failureIdentifier"], "published-zip-size-differs")
        hostile = "postgres://user:secret@host/private?token=credential"
        self.assertNotIn(hostile, json.dumps(m.failure_context(ValueError(hostile))))
        self.assertEqual(m.failure_context(ValueError(hostile))["failureIdentifier"], "unexpected-exception")

    def test_failed_cli_receipt_has_static_stage_and_guard(self):
        import subprocess
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "archive"
            archive.mkdir()
            (archive / "payload").write_bytes(b"secret-body")
            output = root / "output"
            result = subprocess.run(["python3", "-I", str(Path(m.__file__)), "--archive-dir", str(archive), "--source", str(root), "--arch", "amd64", "--output", str(output)], capture_output=True)
            proof = json.loads((output / "receipt.json").read_bytes())
            self.assertEqual(result.returncode, 1)
            self.assertFalse(proof["passed"])
            self.assertEqual(proof["stage"], "archive-size")
            self.assertEqual(proof["failureIdentifier"], "published-zip-size-differs")
            self.assertNotIn("secret-body", json.dumps(proof) + result.stderr.decode())

    def test_nonzero_runtime_metadata_and_hostile_output(self):
        import os
        import sys
        hostile = "postgres://credential:secret@host/private"
        context = {"stage": m.Stage.ROLE_RUNTIME.value}
        program = "import os;os.write(1,b'PASS fresh migration and API/Zero health\\nPASS secret-body\\n');os.write(2,b'AIO runtime phase failed: fresh startup\\n" + hostile + "\\nAIO runtime phase failed: secret-body\\n');raise SystemExit(7)"
        with self.assertRaises(m.GuardFailure):
            m.command([sys.executable, "-c", program, hostile], {**os.environ, "PRIVATE_SECRET": hostile}, 2, context=context)
        proof = context["command"]
        self.assertEqual(proof["exitCode"], 7)
        self.assertTrue(proof["ownedCommandReaped"])
        self.assertEqual(proof["completedPassMarkerCount"], 1)
        self.assertEqual(proof["harnessPhase"], "fresh startup")
        self.assertNotIn(hostile, json.dumps(context))
        self.assertNotIn("secret-body", json.dumps(context))

    def test_cap_and_timeout_are_distinct_and_reaped(self):
        import os
        import sys
        for program, timeout, cap, flag, guard in (
            ("import os,time;os.write(2,b'secret'*100);time.sleep(2)", 2, 16, "outputCapExceeded", "command-output-exceeds-bound"),
            ("import time;time.sleep(2)", 0.1, 1024, "timedOut", "command-deadline-exceeded"),
        ):
            with self.subTest(flag=flag):
                context = {"stage": m.Stage.ROLE_RUNTIME.value}
                with self.assertRaises((m.GuardFailure, __import__('subprocess').TimeoutExpired)):
                    m.command([sys.executable, "-c", program], os.environ, timeout, cap=cap, context=context)
                self.assertTrue(context["command"][flag])
                self.assertTrue(context["command"]["ownedCommandReaped"])
                self.assertEqual(context["command"]["failureIdentifier"], guard)
                self.assertNotIn("secret", json.dumps(context))

if __name__ == "__main__":
    unittest.main()
