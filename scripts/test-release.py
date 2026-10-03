#!/usr/bin/env python3
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import shutil
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_complete_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for name in release.expected_assets("0.0.1-alpha.1"):
                (output / name).write_bytes(b"artifact")
            self.assertEqual(release.verify_downloads(output, "0.0.1-alpha.1"), release.expected_assets("0.0.1-alpha.1"))
            (output / "unexpected.txt").write_bytes(b"extra")
            with self.assertRaisesRegex(ValueError, "extra="):
                release.verify_downloads(output, "0.0.1-alpha.1")

    def test_missing_and_empty_downloads(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            with self.assertRaisesRegex(ValueError, "missing="):
                release.verify_downloads(output, "0.0.1-alpha.1")
            for name in release.expected_assets("0.0.1-alpha.1"):
                (output / name).touch()
            with self.assertRaisesRegex(ValueError, "Empty or invalid"):
                release.verify_downloads(output, "0.0.1-alpha.1")

    def test_prepare_requires_latest_same_commit_success(self):
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env = {"TAG": "v0.0.1-alpha.1", "REPO": "owner/repo", "WORKFLOW_SHA": sha, "DOCKERHUB_ENABLED": "false", "GITHUB_OUTPUT": str(output)}
            runs = [{"id": 1, "event": "push", "head_branch": "develop", "conclusion": "success"}]
            def command(*args):
                if args[0] == "gh":
                    if args[-1] == "--slurp":
                        return "[[]]"
                    self.assertIn(f"head_sha={sha}", args[-1])
                    return json.dumps({"workflow_runs": runs})
                if args[1] == "cat-file":
                    return "tag"
                return sha
            with patch.dict(os.environ, env), patch.object(release, "command", side_effect=command), patch.object(release.subprocess, "run") as run:
                release.prepare()
                self.assertIn(f"sha={sha}", output.read_text())
                run.assert_called_once_with(["git", "merge-base", "--is-ancestor", sha, "origin/develop"], cwd=release.ROOT, check=True)
                runs.append({"id": 2, "event": "push", "head_branch": "develop", "conclusion": "failure"})
                with self.assertRaisesRegex(ValueError, "must pass first"):
                    release.prepare()

    def test_public_release_rejected_before_any_build(self):
        sha = "a" * 40
        def command(*args):
            if args[0] == "gh":
                return json.dumps([[{"tag_name": "v0.0.1-alpha.1", "draft": False}]])
            return "tag" if args[1] == "cat-file" else sha
        with patch.dict(os.environ, {"TAG": "v0.0.1-alpha.1", "REPO": "owner/repo", "WORKFLOW_SHA": sha}), patch.object(release, "command", side_effect=command), patch.object(release.subprocess, "run"):
            with self.assertRaisesRegex(ValueError, "already public"):
                release.prepare()

    def test_dispatch_provenance_must_match_source(self):
        def command(*args):
            return "tag" if args[1] == "cat-file" else "a" * 40
        with patch.dict(os.environ, {"TAG": "v0.0.1-alpha.1", "WORKFLOW_SHA": "b" * 40}), patch.object(release, "command", side_effect=command):
            with self.assertRaisesRegex(ValueError, "provenance"):
                release.prepare()

    def test_publish_requires_matching_uploaded_bytes(self):
        sha = "a" * 40
        for corrupted in (True, False):
            with self.subTest(corrupted=corrupted), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                for name in release.expected_assets("0.0.1-alpha.1"):
                    (output / name).write_bytes(b"artifact")
                def command(*args):
                    if args[0] == "git":
                        return f"{sha}\trefs/tags/v0.0.1-alpha.1^{{}}" if args[1] == "ls-remote" else sha
                    if args[1] == "api":
                        return "[[]]"
                    assets = [{"name": path.name, "size": path.stat().st_size, "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"} for path in output.iterdir()]
                    if corrupted:
                        assets[0]["digest"] = "sha256:" + "0" * 64
                    return json.dumps({"assets": assets})
                env = {"TAG": "v0.0.1-alpha.1", "REPO": "owner/repo", "RELEASE_SHA": sha}
                with patch.dict(os.environ, env), patch.object(release, "command", side_effect=command), patch.object(release.subprocess, "run") as run:
                    if corrupted:
                        with self.assertRaisesRegex(ValueError, "upload digests"):
                            release.publish(output)
                    else:
                        release.publish(output)
                    published = any("--draft=false" in call.args[0] for call in run.call_args_list)
                    self.assertEqual(published, not corrupted)

    def test_deployment_requires_matching_kustomize_images(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)), patch.object(release, "metadata", return_value={"version": "0.0.1-alpha.1"}), patch.object(release.subprocess, "run") as run:
            root = Path(directory)
            chart = root / "deploy/helm/ditero"
            chart.mkdir(parents=True)
            (chart / "Chart.yaml").write_text("version: 0.0.1-alpha.1\nappVersion: 0.0.1-alpha.1\n")
            (chart / "values.yaml").write_text("  tag: 0.0.1-alpha.1\n  tag: 0.0.1-alpha.1-zero\n")
            base = root / "deploy/kustomize/base"
            base.mkdir(parents=True)
            (base / "ditero-app-deployment.yaml").write_text("  image: ghcr.io/iuliandita/ditero:0.0.1-alpha.1\n")
            (base / "ditero-zero-deployment.yaml").write_text("  image: ghcr.io/iuliandita/ditero:nightly-zero\n")
            with self.assertRaisesRegex(ValueError, "Kustomize image tags"):
                release.deployment(root / "output")
            run.assert_not_called()

    def test_kustomize_archive_excludes_operator_files(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release.subprocess, "run"):
            root = Path(directory)
            shutil.copytree(release.ROOT / "deploy", root / "deploy")
            for name in ("RELEASING.md", "LICENSE", "docs/runbooks/database-roles.md"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(release.ROOT / name, target)
            local = root / "deploy/kustomize/overlay"
            local.mkdir()
            (local / "private.env").write_text("PRIVATE=must-not-ship")
            (root / "deploy/kustomize/base/private.env").write_text("PRIVATE=must-not-ship")
            with patch.object(release, "ROOT", root), patch.object(release, "metadata", return_value={"version": "0.0.1-alpha.1"}):
                release.deployment(root / "output")
            with tarfile.open(root / "output/ditero-0.0.1-alpha.1-kustomize.tar.gz") as archive:
                names = archive.getnames()
                self.assertFalse(any("private.env" in name or "/overlay/" in name for name in names))
                self.assertIn("ditero-0.0.1-alpha.1/deploy/kustomize/base/name-reference.yaml", names)
                self.assertIn("ditero-0.0.1-alpha.1/deploy/kustomize/README.md", names)

    def test_metadata_rejects_unsafe_version_and_code(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            for version, code in (("0.0.1;echo bad", 1), ("0.0.1-alpha.1", 0), ("0.0.1-alpha.1", True)):
                (Path(directory) / "release.json").write_text(json.dumps({"version": version, "androidVersionCode": code}))
                with self.assertRaises(ValueError):
                    release.metadata()


if __name__ == "__main__":
    unittest.main()
