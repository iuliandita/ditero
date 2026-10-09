#!/usr/bin/env python3
"""Offline archive and publication-gate controls; no registry or build calls."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import sys
sys.dont_write_bytecode = True

SPEC = importlib.util.spec_from_file_location("package_aio", Path(__file__).with_name("package-aio.py"))
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)
SHA = "a" * 40

class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.evidence = self.root / "evidence"
        self.evidence.mkdir()
        for name in m.FILES:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(("source " + name).encode())
        self.inventory = {"sourceSHA": SHA, "candidate": f"aio-experimental-{SHA}-123-1", "repositories": list(m.REPOSITORIES),
            "workflowRunURL": "https://github.com/iuliandita/ditero/actions/runs/123", "workflowRef": "iuliandita/ditero/.github/workflows/aio-experimental.yml@refs/heads/develop",
            "indexDigest": "sha256:" + "b" * 64, "indexRegistriesMatch": True, "indexSigned": True,
            "indexProvenanceAttested": True, "platforms": {}}
        for arch in ("amd64", "arm64"):
            name = f"sbom-{arch}.spdx.json"
            payload = json.dumps({"spdxVersion": "SPDX-2.3", "name": arch}).encode()
            (self.evidence / name).write_bytes(payload)
            self.inventory["platforms"][arch] = {"sourceSHA": SHA, "platform": "linux/" + arch,
                "digest": "sha256:" + ("c" if arch == "amd64" else "d") * 64,
                "registriesMatch": True, "scanPassed": True, "signed": True, "provenanceAttested": True,
                "sbom": name, "sbomSHA256": hashlib.sha256(payload).hexdigest()}
    def package(self):
        return m.package(self.root, SHA, self.inventory, self.evidence, self.root / "out")
    def test_archive_bytes_and_checksum_closure(self):
        archive = self.package()
        with tarfile.open(archive) as tar:
            members = {x.name: tar.extractfile(x).read() for x in tar.getmembers()}
            self.assertEqual(set(members), set(m.FILES) | {"IMAGE-INVENTORY.json", "SOURCE.json", "SHA256SUMS", "evidence/sbom-amd64.spdx.json", "evidence/sbom-arm64.spdx.json"})
            self.assertEqual(tar.getmember("deploy/docker/aio/run-bundle.sh").mode, 0o755)
            for name in m.FILES:
                self.assertEqual(members[name], (self.root / name).read_bytes())
            for line in members["SHA256SUMS"].decode().splitlines():
                digest, name = line.split("  ")
                self.assertEqual(digest, hashlib.sha256(members[name]).hexdigest())
            source = json.loads(members["SOURCE.json"])
            self.assertEqual(source["sourceSHA"], SHA)
            self.assertFalse(source["runtimeQualified"])
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(), (archive.parent / "SHA256SUMS").read_text())
    def test_output_no_replay(self):
        self.package()
        with self.assertRaises(ValueError): self.package()
    def test_missing_source(self):
        (self.root / m.FILES[0]).unlink()
        with self.assertRaises(ValueError): self.package()
    def test_symlink_source(self):
        path = self.root / m.FILES[0]
        path.unlink();path.symlink_to(self.root / "LICENSE")
        with self.assertRaises(ValueError): self.package()
    def test_sbom_changed_bytes(self):
        (self.evidence / "sbom-arm64.spdx.json").write_text("{}")
        with self.assertRaises(ValueError): self.package()
    def test_inventory_denials(self):
        changes = [lambda x:x.update(sourceSHA="e"*40), lambda x:x.update(candidate="latest"),
            lambda x:x.update(indexDigest="nightly"), lambda x:x.update(repositories=list(m.REPOSITORIES[:1])),
            lambda x:x["platforms"].pop("arm64"), lambda x:x.update(indexSigned=False),
            lambda x:x.update(indexProvenanceAttested=False)]
        for key in ("scanPassed", "signed", "registriesMatch", "provenanceAttested"):
            changes.append(lambda x,key=key:x["platforms"]["arm64"].update({key:False}))
        changes.append(lambda x:x["platforms"]["amd64"].update(sbom="../outside"))
        for change in changes:
            with self.subTest(change=change):
                bad=copy.deepcopy(self.inventory);change(bad)
                with self.assertRaises(ValueError):m.validate_inventory(bad,SHA)
    def test_same_sha_current_required_runs(self):
        good={"id":1,"run_number":1,"run_attempt":1,"head_sha":SHA,"event":"push","head_branch":"develop","conclusion":"success"}
        m.validate_runs([good],SHA)
        for bad in ({**good,"run_number":2,"conclusion":"failure"},{**good,"run_attempt":2,"conclusion":None}):
            with self.assertRaises(ValueError):m.validate_runs([good,bad],SHA)
        for change in ({"head_sha":"f"*40},{"event":"pull_request"},{"head_branch":"main"}):
            with self.assertRaises(ValueError):m.validate_runs([{**good,**change}],SHA)
    def test_full_sha_only(self):
        for value in ("HEAD", "develop", "a"*7, "A"*40, "a"*40+";bad"):
            with self.assertRaises(ValueError):m.checked_sha(value)
    def test_source_gate_checks_all_required_workflows(self):
        good={"run_number":1,"run_attempt":1,"head_sha":SHA,"event":"push","head_branch":"develop","conclusion":"success"}
        def output(args, **kwargs):
            if args[:2] == ("git", "rev-parse"):return SHA
            self.assertEqual(args[0:2], ("gh", "api"))
            return json.dumps([{"workflow_runs":[good]}])
        with patch.object(m.subprocess,"check_output",side_effect=output) as calls, patch.object(m.subprocess,"run") as ancestor:
            m.source_gate(SHA,SHA,"iuliandita/ditero")
            self.assertEqual(calls.call_count,1+len(m.REQUIRED))
            ancestor.assert_called_once()
        for workflow_sha,repo in (("f"*40,"iuliandita/ditero"),(SHA,"other/repo")):
            with patch.object(m.subprocess,"check_output") as calls:
                with self.assertRaises(ValueError):m.source_gate(SHA,workflow_sha,repo)
                calls.assert_not_called()
    def test_workflow_privilege_and_platform_contract(self):
        source=(m.ROOT / ".github/workflows/aio-experimental.yml").read_text()
        self.assertIn("if: github.event_name == 'workflow_dispatch'",source)
        self.assertIn("arch: [amd64, arm64]",source)
        self.assertIn("needs: [prepare, platform]",source)
        self.assertNotIn("pull_request_target",source)
        self.assertNotIn("latest:",source)
        self.assertNotIn("scripts/release.py",source)
        self.assertIn("name: aio-platform-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.arch }}",source)

if __name__ == "__main__":
    unittest.main()
