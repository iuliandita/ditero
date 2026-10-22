#!/usr/bin/env python3
import io
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import tempfile
import shutil
import subprocess
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_all_desktop_installer_targets_are_required(self):
        version = "0.0.1-beta.1"
        desktop = {
            "linux-x64-unsigned.deb", "linux-x64-unsigned.rpm", "linux-x64-unsigned.AppImage",
            "windows-x64-unsigned.exe", "windows-arm64-unsigned.exe",
            "macos-arm64-adhoc.dmg", "macos-x64-adhoc.dmg",
        }
        expected = release.expected_assets(version)
        self.assertTrue({f"ditero-{version}-{name}" for name in desktop} <= expected)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for name in expected:
                (output / name).write_bytes(b"artifact")
            for name in desktop:
                with self.subTest(name=name):
                    path = output / f"ditero-{version}-{name}"
                    path.unlink()
                    with self.assertRaisesRegex(ValueError, "missing="):
                        release.verify_downloads(output, version)
                    path.write_bytes(b"artifact")

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
        version = release.metadata()["version"]
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env = {"TAG": f"v{version}", "REPO": "owner/repo", "WORKFLOW_SHA": sha, "DOCKERHUB_ENABLED": "false", "GITHUB_OUTPUT": str(output)}
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
                self.assertEqual(run.call_count, 2)
                run.assert_any_call(["git", "merge-base", "--is-ancestor", sha, "origin/develop"], cwd=release.ROOT, check=True)
                run.assert_any_call([release.sys.executable, "-I", str(release.ROOT / "scripts/docs-release.py"), "--head", sha], cwd=release.ROOT, check=True, timeout=180)
                runs.append({"id": 2, "event": "push", "head_branch": "develop", "conclusion": "failure"})
                with self.assertRaisesRegex(ValueError, "must pass first"):
                    release.prepare()

    def test_public_release_rejected_before_any_build(self):
        version = release.metadata()["version"]
        sha = "a" * 40
        def command(*args):
            if args[0] == "gh":
                return json.dumps([[{"tag_name": f"v{version}", "draft": False}]])
            return "tag" if args[1] == "cat-file" else sha
        with patch.dict(os.environ, {"TAG": f"v{version}", "REPO": "owner/repo", "WORKFLOW_SHA": sha}), patch.object(release, "command", side_effect=command), patch.object(release.subprocess, "run"):
            with self.assertRaisesRegex(ValueError, "already public"):
                release.prepare()

    def test_dispatch_provenance_must_match_source(self):
        version = release.metadata()["version"]
        def command(*args):
            return "tag" if args[1] == "cat-file" else "a" * 40
        with patch.dict(os.environ, {"TAG": f"v{version}", "WORKFLOW_SHA": "b" * 40}), patch.object(release, "command", side_effect=command):
            with self.assertRaisesRegex(ValueError, "provenance"):
                release.prepare()

    def test_publish_requires_matching_uploaded_bytes(self):
        version = release.metadata()["version"]
        sha = "a" * 40
        for corrupted in (True, False):
            with self.subTest(corrupted=corrupted), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                for name in release.expected_assets(version):
                    (output / name).write_bytes(b"artifact")
                def command(*args):
                    if args[0] == "git":
                        return f"{sha}\trefs/tags/v{version}^{{}}" if args[1] == "ls-remote" else sha
                    if args[1] == "api":
                        return "[[]]"
                    assets = [{"name": path.name, "size": path.stat().st_size, "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"} for path in output.iterdir()]
                    if corrupted:
                        assets[0]["digest"] = "sha256:" + "0" * 64
                    return json.dumps({"assets": assets})
                env = {"TAG": f"v{version}", "REPO": "owner/repo", "RELEASE_SHA": sha}
                with patch.dict(os.environ, env), patch.object(release, "command", side_effect=command), patch.object(release, "verify_clients"), patch.object(release.subprocess, "run") as run:
                    if corrupted:
                        with self.assertRaisesRegex(ValueError, "upload digests"):
                            release.publish(output)
                    else:
                        release.publish(output)
                    published = any("--draft=false" in call.args[0] for call in run.call_args_list)
                    self.assertEqual(published, not corrupted)

    def test_publish_requires_the_clients_attestation_and_documents_the_same_check(self):
        version = release.metadata()["version"]
        sha = "a" * 40
        archive_name = f"ditero-{version}-clients.tar.gz"
        for attested in (False, True):
            with self.subTest(attested=attested), tempfile.TemporaryDirectory() as directory:
                output = Path(directory)
                for name in release.expected_assets(version):
                    (output / name).write_bytes(b"artifact")
                notes = []
                def command(*args):
                    if args[0] == "git":
                        return f"{sha}\trefs/tags/v{version}^{{}}" if args[1] == "ls-remote" else sha
                    if args[1] == "api":
                        return "[[]]"
                    assets = [{"name": path.name, "size": path.stat().st_size, "digest": f"sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"} for path in output.iterdir()]
                    return json.dumps({"assets": assets})
                def run(args, **kwargs):
                    if args[:3] == ["gh", "attestation", "verify"]:
                        self.assertEqual(args, release.clients_attestation_args(str(output / archive_name), "owner/repo", sha))
                        if not attested:
                            raise subprocess.CalledProcessError(1, args)
                    elif "--notes-file" in args:
                        notes.append(Path(args[args.index("--notes-file") + 1]).read_text())
                env = {"TAG": f"v{version}", "REPO": "owner/repo", "RELEASE_SHA": sha}
                with patch.dict(os.environ, env), patch.object(release, "command", side_effect=command), patch.object(release, "verify_clients"), patch.object(release.subprocess, "run", side_effect=run) as mock_run:
                    if not attested:
                        with self.assertRaises(subprocess.CalledProcessError):
                            release.publish(output)
                        self.assertFalse(any(call.args[0][:3] == ["gh", "release", "create"] for call in mock_run.call_args_list))
                        continue
                    release.publish(output)
                self.assertEqual(len(notes), 1)
                documented = " ".join(release.clients_attestation_args(archive_name, "owner/repo", sha))
                self.assertIn(f"`{documented}`", notes[0])
                self.assertNotIn("no keyless signature", notes[0])

    def test_release_workflow_attests_the_clients_archive_before_publish(self):
        text = (release.ROOT / ".github/workflows/release.yml").read_text()
        clients = text[text.index("\n  clients:\n"):text.index("\n  docker-zero:")]
        self.assertIn("uses: actions/attest-build-provenance@", clients)
        self.assertIn("subject-path: out/clients/*-clients.tar.gz", clients)
        self.assertIn("id-token: write", clients)
        self.assertIn("attestations: write", clients)
        publish = text[text.index("\n  publish:\n"):]
        self.assertRegex(publish, r"needs: \[[^\]]*\bclients\b[^\]]*\]")

    def bundle_archive(self, path, source_sha, mutate=None, **changes):
        version = "0.0.1-alpha.1"
        prefix = f"ditero-{version}-clients"
        minimum = release.minimum_bun()
        banner = release.CLIENT_SHEBANG + f'{{const m=[{minimum.replace(".", ",")}];}}\n/*! ditero-package: zod@4.4.3 */\nconsole.log("bundle");\n'.encode()
        notice = ("=" * 72 + "\nzod@4.4.3 (MIT)\n" + "=" * 72 + "\n\nLICENSE\n\nMIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n").encode()
        info = {"version": version, "sourceSha": source_sha, "sourceDirty": False, "target": "bun",
                "apiVersion": 1, "minimumBun": minimum, "buildBun": "1.4.2", "clients": list(release.CLIENT_BUNDLES),
                "dependencies": ["zod@4.4.3"]}
        info.update(changes)
        files = {name: banner for name in release.CLIENT_BUNDLES}
        files.update({"THIRD_PARTY_NOTICES.txt": notice, "LICENSE": b"license", "BUILDINFO.json": json.dumps(info).encode()})
        files["SHA256SUMS"] = "".join(f"{hashlib.sha256(content).hexdigest()}  {name}\n" for name, content in files.items()).encode()
        if mutate:
            mutate(files)
        with tarfile.open(path, "w:gz") as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(f"{prefix}/{name}")
                member.size = len(content)
                member.mode = 0o755 if name in release.CLIENT_BUNDLES else 0o644
                archive.addfile(member, io.BytesIO(content))

    def test_client_bundles_require_every_bundle_checksum_and_notice(self):
        sha = "a" * 40
        banner = release.CLIENT_SHEBANG + b"{const m=[%s]}\n/*! ditero-package: zod@4.4.3 */\n" % release.minimum_bun().replace(".", ",").encode()
        leaks = {
            "home path": b'const d="/home/builder/ditero/src";\n',
            "macOS home path": b'const d="/Users/builder/ditero";\n',
            "private address": b'const u="http://192.168.1.20:3000";\n',
            "private hostname": b'const u="https://db.corp.local/";\n',
            "environment file": b"DATABASE_URL=postgres://u:pw@db/app\nDITERO_ENCRYPTION_KEY=abcdef0123\n",
            "private key": b"-----BEGIN OPENSSH PRIVATE KEY-----\n",
            "token": b'const t="ghp_' + b"a1" * 20 + b'";\n',
        }
        def rehash(files):
            files["SHA256SUMS"] = "".join(f"{hashlib.sha256(files[name]).hexdigest()}  {name}\n" for name in release.CLIENT_FILES if name != "SHA256SUMS" and name in files).encode()
        def drop(name, hashed=True):
            def mutation(files):
                del files[name]
                if hashed:
                    rehash(files)
            return mutation
        def replace(name, content):
            def mutation(files):
                files[name] = content
                rehash(files)
            return mutation
        def sums_without(name):
            def mutation(files):
                files["SHA256SUMS"] = b"".join(line for line in files["SHA256SUMS"].splitlines(True) if not line.endswith(f"  {name}\n".encode()))
            return mutation
        def stale_sum(files):
            files["ditero-cli.js"] += b"tampered"
        info = lambda files: json.loads(files["BUILDINFO.json"])
        def set_info(**changes):
            def mutation(files):
                files["BUILDINFO.json"] = json.dumps({**info(files), **changes}).encode()
                rehash(files)
            return mutation
        rejected = {
            "missing bundle": drop("ditero-mcp.js"),
            "missing notices": drop("THIRD_PARTY_NOTICES.txt"),
            "missing checksum list": drop("SHA256SUMS", hashed=False),
            "checksum omits bundle": sums_without("ditero-tui.js"),
            "checksum omits notices": sums_without("THIRD_PARTY_NOTICES.txt"),
            "modified bundle": stale_sum,
            "no shebang": replace("ditero-cli.js", b"console.log(1)\n"),
            "unrestricted shebang": replace("ditero-cli.js", b"#!/usr/bin/env bun\n{const m=[%s]}\n" % release.minimum_bun().replace(".", ",").encode()),
            "no minimum check": replace("ditero-cli.js", release.CLIENT_SHEBANG + b"console.log(1)\n"),
            "source map": replace("ditero-cli.js", release.CLIENT_SHEBANG + b'{const m=[%s]}\n//# sourceMappingURL=x.map\n' % release.minimum_bun().replace(".", ",").encode()),
            "notice without text": replace("THIRD_PARTY_NOTICES.txt", ("=" * 72 + "\nzod@4.4.3 (MIT)\n" + "=" * 72 + "\n\n").encode()),
            "notice for another package": replace("THIRD_PARTY_NOTICES.txt", ("=" * 72 + "\nother@1.0.0 (MIT)\n" + "=" * 72 + "\n\n" + "MIT License permission " * 10).encode()),
            "undeclared dependency": set_info(dependencies=["zod@4.4.3", "extra@1.0.0"]),
            "dirty source": set_info(sourceDirty=True),
            "wrong commit": set_info(sourceSha="b" * 40),
            "wrong minimum": set_info(minimumBun="1.0.0"),
            "wrong target": set_info(target="bun-linux-x64"),
            "extra file": lambda files: files.update({"private.env": b"secret"}),
            "no building Bun version": set_info(buildBun=None),
            "bundle without package markers": replace("ditero-tui.js", release.CLIENT_SHEBANG + b"{const m=[%s]}\n" % release.minimum_bun().replace(".", ",").encode()),
            "bundle with code from a package missing in the notices": replace("ditero-mcp.js", banner + b"/*! ditero-package: ajv@8.18.0 */\n"),
            "bundle with a package missing from the dependency inventory": replace("ditero-cli.js", banner + b"/*! ditero-package: extra@1.0.0 */\n"),
            **{f"{label} in a bundle": replace("ditero-cli.js", banner + leak) for label, leak in leaks.items()},
            "absolute path in the build identity": set_info(note="/home/runner/work/ditero"),
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clients.tar.gz"
            self.bundle_archive(path, sha)
            release.verify_clients(path, "0.0.1-alpha.1", sha)
            for name, mutation in rejected.items():
                with self.subTest(name):
                    self.bundle_archive(path, sha, mutation)
                    with self.assertRaises(ValueError):
                        release.verify_clients(path, "0.0.1-alpha.1", sha)
            self.bundle_archive(path, sha, sourceDirty=True)
            release.verify_clients(path, "0.0.1-alpha.1", sha, allow_dirty=True)

    def test_client_bundle_archive_rejects_links_and_unexpected_paths(self):
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            source, path = Path(directory) / "source.tar.gz", Path(directory) / "clients.tar"
            self.bundle_archive(source, sha)
            for name, kind in (("link", tarfile.SYMTYPE), ("nested/file", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE), (".hidden", tarfile.REGTYPE), ("ditero-cli.js", tarfile.REGTYPE)):
                with self.subTest(name=name), tarfile.open(source) as original, tarfile.open(path, "w") as archive:
                    for member in original.getmembers():
                        archive.addfile(member, original.extractfile(member))
                    member = tarfile.TarInfo(f"ditero-0.0.1-alpha.1-clients/{name}")
                    member.type = kind
                    member.linkname = "outside"
                    member.size = 1 if kind == tarfile.REGTYPE else 0
                    archive.addfile(member, io.BytesIO(b"x") if member.size else None)
                with self.assertRaises(ValueError):
                    release.verify_clients(path, "0.0.1-alpha.1", sha)

    def test_publish_refuses_a_release_with_an_invalid_client_archive(self):
        version = release.metadata()["version"]
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for name in release.expected_assets(version):
                (output / name).write_bytes(b"artifact")
            def command(*args):
                return sha
            env = {"TAG": f"v{version}", "REPO": "owner/repo", "RELEASE_SHA": sha}
            with patch.dict(os.environ, env), patch.object(release, "command", side_effect=command), patch.object(release.subprocess, "run") as run:
                with self.assertRaises(tarfile.ReadError):
                    release.publish(output)
                run.assert_not_called()

    def client_archive(self, path, source_sha, **changes):
        version = "0.0.1-alpha.1"
        prefix = f"ditero-{version}-clients-linux-x64"
        info = {"version": version, "sourceSha": source_sha, "sourceDirty": False,
                "target": "bun-linux-x64", "apiVersion": 1,
                "clients": ["ditero", "ditero-mcp", "ditero-tui"],
                "bunVersion": "1.4.2", "bunRevision": "744846f844374847c902b5e7fd59b4342a51ef99",
                "runtimeArchiveSha256": "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
                "dependencies": ["zod@4.4.3"], "runtimeNoticesComplete": False}
        notice = b"Copyright (c) 2026 Fixture authors\nPermission is hereby granted under this fixture license.\n"
        manifest = {"schema": 1, "identity": {
            "bunVersion": info["bunVersion"], "bunRevision": info["bunRevision"],
            "target": info["target"], "runtimeArchiveSha256": info["runtimeArchiveSha256"],
            "webkitCommit": "2e2aa2290fac856d6f451ceacb58f7f5b44dd057"},
            "incomplete": True, "texts": [{"path": "notices/runtime/fixture/LICENSE",
                "sha256": hashlib.sha256(notice).hexdigest(), "license": "MIT", "selection": "conservative-extra",
                "origin": {"url": "https://example.org/source/" + "a" * 40 + "/LICENSE", "revision": "a" * 40}}],
            "unresolved": [{"component": "fixture", "reason": "Not production notice coverage"}],
            "sourceRelink": {"source": None, "relink": None}}
        manifest_raw = json.dumps(manifest).encode()
        info["runtimeNoticesManifestSha256"] = hashlib.sha256(manifest_raw).hexdigest()
        info.update(changes)
        files = {"BUILDINFO.json": json.dumps(info).encode(), "LICENSE": b"license", "REBUILD.md": b"instructions", "notices/Bun-LICENSE.md": b"runtime notice", "notices/zod@4.4.3/LICENSE": b"license"}
        files["notices/runtime/manifest.json"] = manifest_raw
        files["notices/runtime/fixture/LICENSE"] = notice
        for name in info["clients"]:
            files[f"bin/{name}"] = b"\x7fELF\x02\x01" + bytes(12) + b"\x3e\x00"
            files[f"relink/{name}.js"] = b"console.log('fixture')"
        with tarfile.open(path, "w:gz") as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(f"{prefix}/{name}")
                member.size = len(content)
                member.mode = 0o755 if name.startswith("bin/") else 0o644
                archive.addfile(member, io.BytesIO(content))

    def test_extracted_candidate_contains_verified_runtime_source_notices(self):
        # Check committed bytes so local CRLF files cannot hide Git normalization.
        committed = subprocess.run(
            ["git", "archive", "HEAD", "vendor/client-runtime-notices"],
            cwd=release.ROOT, check=True, capture_output=True,
        ).stdout
        with tarfile.open(fileobj=io.BytesIO(committed)) as archive:
            retained = {
                member.name.removeprefix("vendor/client-runtime-notices/"): archive.extractfile(member).read()
                for member in archive.getmembers() if member.isfile()
            }
        raw = retained["manifest.json"]
        manifest = json.loads(raw)
        required = {
            "bun/FormatStackTraceForJS-NOTICE.txt", "bun/clap-LICENSE",
            "native/boringssl/LICENSE", "native/brotli/LICENSE", "native/cares/LICENSE.md",
            "native/hdrhistogram/LICENSE.txt", "native/highway/LICENSE", "native/libarchive/COPYING",
            "native/libjpeg-turbo/README.ijg", "native/libjpeg-turbo/LICENSE.md", "native/libwebp/COPYING",
            "native/lshpack/LICENSE", "native/lsqpack/LICENSE", "native/lsquic/LICENSE.chrome",
            "native/picohttpparser/source-notices.txt", "native/tinycc/COPYING",
            "native/zlib/LICENSE.md", "native/zstd/LICENSE",
        }
        records = {item["path"]: item for item in manifest["texts"]}
        self.assertTrue({"notices/runtime/" + path for path in required} <= records.keys())
        with tempfile.TemporaryDirectory() as directory:
            original = Path(directory) / "original.tar.gz"
            candidate = Path(directory) / "candidate.tar.gz"
            sha = "a" * 40
            self.client_archive(original, sha)
            def include_notices(files):
                for name in list(files):
                    if name.startswith("notices/runtime/"):
                        del files[name]
                files["notices/runtime/manifest.json"] = raw
                for name in records:
                    files[name] = retained[name.removeprefix("notices/runtime/")]
                info = json.loads(files["BUILDINFO.json"])
                info["runtimeNoticesManifestSha256"] = hashlib.sha256(raw).hexdigest()
                files["BUILDINFO.json"] = json.dumps(info).encode()
            self.mutate_runtime_archive(original, candidate, include_notices)
            release.verify_standalone_candidate(candidate, "0.0.1-alpha.1", sha)
            destination = Path(directory) / "extracted"
            with tarfile.open(candidate) as archive:
                archive.extractall(destination, filter="data")
            package = destination / "ditero-0.0.1-alpha.1-clients-linux-x64"
            for name, record in records.items():
                with self.subTest(path=name):
                    self.assertEqual(hashlib.sha256((package / name).read_bytes()).hexdigest(), record["sha256"])
            self.assertTrue(manifest["incomplete"])
            self.assertTrue(any(item["component"] == "Bun" for item in manifest["unresolved"]))

    def test_candidate_requires_exact_source_runtime_and_incomplete_notice_marker(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clients.tar.gz"
            sha = "a" * 40
            self.client_archive(path, sha)
            release.verify_standalone_candidate(path, "0.0.1-alpha.1", sha)
            self.client_archive(path, sha, sourceDirty=True)
            release.verify_standalone_candidate(path, "0.0.1-alpha.1", sha)
            for changes in ({"runtimeNoticesComplete": True}, {"sourceDirty": 0}, {"sourceSha": "b" * 40}, {"bunRevision": "b" * 40}, {"runtimeArchiveSha256": "b" * 64}, {"target": "bun-linux-arm64"}, {"apiVersion": True}, {"dependencies": ["private.env"]}):
                with self.subTest(changes=changes):
                    self.client_archive(path, sha, **changes)
                    with self.assertRaises(ValueError):
                        release.verify_standalone_candidate(path, "0.0.1-alpha.1", sha)

    def test_client_archive_rejects_unexpected_paths_and_links(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "clients.tar"
            source = Path(directory) / "source.tar.gz"
            sha = "a" * 40
            self.client_archive(source, sha)
            for name, kind in (("private.env", tarfile.REGTYPE), ("bin/other", tarfile.REGTYPE), ("notices/zod@4.4.3/private.env", tarfile.REGTYPE), ("bin/link", tarfile.SYMTYPE), ("notices/runtime/fixture/link", tarfile.SYMTYPE), ("notices/runtime/fixture/EXTRA", tarfile.REGTYPE), ("../escape", tarfile.REGTYPE)):
                with self.subTest(name=name), tarfile.open(source) as original, tarfile.open(path, "w") as archive:
                    for member in original.getmembers():
                        archive.addfile(member, original.extractfile(member))
                    member = tarfile.TarInfo(f"ditero-0.0.1-alpha.1-clients-linux-x64/{name}")
                    member.type = kind
                    member.linkname = "outside"
                    member.size = 1 if kind == tarfile.REGTYPE else 0
                    archive.addfile(member, io.BytesIO(b"x") if member.size else None)
                with self.assertRaises(ValueError):
                    release.verify_standalone_candidate(path, "0.0.1-alpha.1", sha)

    def mutate_runtime_archive(self, source, destination, mutation):
        prefix = "ditero-0.0.1-alpha.1-clients-linux-x64/"
        with tarfile.open(source) as archive:
            files = {member.name.removeprefix(prefix): archive.extractfile(member).read() for member in archive.getmembers()}
        mutation(files)
        with tarfile.open(destination, "w:gz") as archive:
            for name, content in files.items():
                member = tarfile.TarInfo(prefix + name)
                member.size = len(content)
                member.mode = 0o755 if name.startswith("bin/") else 0o644
                archive.addfile(member, io.BytesIO(content))

    def test_runtime_manifest_mutations_rejected_even_when_buildinfo_rehashed(self):
        def change(files, mutation):
            manifest = json.loads(files["notices/runtime/manifest.json"])
            mutation(manifest)
            raw = json.dumps(manifest).encode()
            files["notices/runtime/manifest.json"] = raw
            info = json.loads(files["BUILDINFO.json"])
            info["runtimeNoticesManifestSha256"] = hashlib.sha256(raw).hexdigest()
            files["BUILDINFO.json"] = json.dumps(info).encode()
        mutations = [
            lambda m: m.update(incomplete=False),
            lambda m: m.update(schema=True),
            lambda m: m.update(unknown=1),
            lambda m: m.pop("unresolved"),
            lambda m: m["identity"].update(target="bun-linux-arm64"),
            lambda m: m["identity"].update(extra="unknown"),
            lambda m: m["texts"].append(m["texts"][0].copy()),
            lambda m: m["texts"][0].update(sha256="b" * 64),
            lambda m: m["texts"][0].update(path="notices/runtime/../LICENSE"),
            lambda m: m["texts"][0].update(selection="guessed"),
            lambda m: m["texts"][0].update(license=""),
            lambda m: m["texts"][0]["origin"].update(url="https://example.org/main/LICENSE"),
            lambda m: m["texts"][0]["origin"].update(url="https://@h/" + "a" * 40 + "/LICENSE"),
            lambda m: m["texts"][0]["origin"].update(url="https://h/" + "a" * 40 + "/a{b"),
            lambda m: m["texts"][0]["origin"].update(url="https://0x7f.1/" + "a" * 40 + "/LICENSE"),
            lambda m: m["sourceRelink"].update(source={"path": "notices/runtime/source.json", "sha256": "a" * 64,
                "origin": m["texts"][0]["origin"]}),
        ]
        with tempfile.TemporaryDirectory() as directory:
            source, changed = Path(directory) / "source.tar.gz", Path(directory) / "changed.tar.gz"
            self.client_archive(source, "a" * 40)
            for index, mutation in enumerate(mutations):
                with self.subTest(index=index):
                    self.mutate_runtime_archive(source, changed, lambda files: change(files, mutation))
                    with self.assertRaises(ValueError):
                        release.verify_standalone_candidate(changed, "0.0.1-alpha.1", "a" * 40)

    def test_runtime_archive_partition_and_duplicate_json_refusals(self):
        def duplicate(files, name):
            raw = files[name]
            files[name] = raw[:-1] + b',"incomplete":true,"incomplete":true}'
            if name.endswith("manifest.json"):
                info = json.loads(files["BUILDINFO.json"])
                info["runtimeNoticesManifestSha256"] = hashlib.sha256(files[name]).hexdigest()
                files["BUILDINFO.json"] = json.dumps(info).encode()
        mutations = [
            lambda f: f.pop("notices/runtime/fixture/LICENSE"),
            lambda f: f.update({"notices/runtime/fixture/EXTRA": b"extra"}),
            lambda f: f.update({"notices/runtime/fixture/LICENSE": b"changed"}),
            lambda f: f.update({"notices/runtime/manifest.json": b"{}"}),
            lambda f: duplicate(f, "notices/runtime/manifest.json"),
            lambda f: duplicate(f, "BUILDINFO.json"),
        ]
        with tempfile.TemporaryDirectory() as directory:
            source, changed = Path(directory) / "source.tar.gz", Path(directory) / "changed.tar.gz"
            self.client_archive(source, "a" * 40)
            for index, mutation in enumerate(mutations):
                with self.subTest(index=index):
                    self.mutate_runtime_archive(source, changed, mutation)
                    with self.assertRaises(ValueError):
                        release.verify_standalone_candidate(changed, "0.0.1-alpha.1", "a" * 40)

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

    def test_deployment_rejects_stale_packaged_guide_examples(self):
        version = release.metadata()["version"]
        guides = ("deploy/helm/ditero/README.md", "deploy/kustomize/README.md")
        mutations = (
            (guides[0], f"The chart version is `{version}`"),
            (guides[0], f"ghcr.io/iuliandita/ditero:{version}`"),
            (guides[0], f"ghcr.io/iuliandita/ditero:{version}-zero`"),
            (guides[1], f"- name: ghcr.io/iuliandita/ditero:{version}\n"),
            (guides[1], f"- name: ghcr.io/iuliandita/ditero:{version}-zero\n"),
            (guides[1], f"newTag: {version}\n"),
            (guides[1], f"newTag: {version}-zero\n"),
        )
        with tempfile.TemporaryDirectory() as directory, patch.object(release.subprocess, "run") as run:
            root = Path(directory)
            shutil.copytree(release.ROOT / "deploy", root / "deploy")
            shutil.copyfile(release.ROOT / "release.json", root / "release.json")
            originals = {name: (root / name).read_text() for name in guides}
            with patch.object(release, "ROOT", root):
                for name in guides:
                    with (root / name).open("a") as guide:
                        guide.write("\nHistorical release: `0.0.1-alpha.1`.\n")
                release.deployment_guides(version)
                for name, example in mutations:
                    with self.subTest(example=example):
                        self.assertEqual(originals[name].count(example), 1)
                        (root / name).write_text(originals[name].replace(example, example.replace(version, "0.0.0-alpha.1")))
                        with self.assertRaisesRegex(ValueError, "Packaged deployment guide"):
                            release.deployment(root / "output")
                        self.assertFalse((root / "output").exists())
                        run.assert_not_called()
                        (root / name).write_text(originals[name])

    def test_kustomize_archive_excludes_operator_files(self):
        version = release.metadata()["version"]
        with tempfile.TemporaryDirectory() as directory, patch.object(release.subprocess, "run"):
            root = Path(directory)
            shutil.copytree(release.ROOT / "deploy", root / "deploy")
            for name in ("RELEASING.md", "LICENSE", "docs/runbooks/database-roles.md", "docs/runbooks/database-tls.md"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(release.ROOT / name, target)
            local = root / "deploy/kustomize/overlay"
            local.mkdir()
            (local / "private.env").write_text("PRIVATE=must-not-ship")
            (root / "deploy/kustomize/base/private.env").write_text("PRIVATE=must-not-ship")
            (root / "deploy/kustomize/cnpg/private.env").write_text("PRIVATE=must-not-ship")
            with patch.object(release, "ROOT", root), patch.object(release, "metadata", return_value={"version": version}):
                release.deployment(root / "output")
            with tarfile.open(root / f"output/ditero-{version}-kustomize.tar.gz") as archive:
                names = archive.getnames()
                self.assertFalse(any("private.env" in name or "/overlay/" in name for name in names))
                self.assertIn(f"ditero-{version}/deploy/kustomize/base/name-reference.yaml", names)
                self.assertIn(f"ditero-{version}/deploy/kustomize/README.md", names)
                self.assertIn(f"ditero-{version}/deploy/kustomize/cnpg/roles.sql", names)
                self.assertIn(f"ditero-{version}/deploy/kustomize/cnpg/cluster.yaml", names)
                self.assertIn(f"ditero-{version}/docs/runbooks/database-tls.md", names)
                guide = archive.extractfile(f"ditero-{version}/docs/runbooks/database-tls.md").read().decode()
                self.assertIn("NODE_EXTRA_CA_CERTS", guide)
                roles = archive.extractfile(f"ditero-{version}/docs/runbooks/database-roles.md").read().decode()
                self.assertIn("(database-tls.md)", roles)
                readme = archive.extractfile(f"ditero-{version}/deploy/kustomize/cnpg/README.md").read().decode()
                self.assertIn("https://github.com/iuliandita/ditero/blob/develop/docs/runbooks/backup-restore.md", readme)

    def test_metadata_rejects_unsafe_version_and_code(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(release, "ROOT", Path(directory)):
            for version, code in (("0.0.1;echo bad", 1), ("0.0.1-alpha.1", 0), ("0.0.1-alpha.1", True)):
                (Path(directory) / "release.json").write_text(json.dumps({"version": version, "androidVersionCode": code}))
                with self.assertRaises(ValueError):
                    release.metadata()


if __name__ == "__main__":
    unittest.main()
