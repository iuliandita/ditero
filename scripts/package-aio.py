#!/usr/bin/env python3
"""Package the experimental bundle without changing tagged release assets."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
REPOSITORIES = ("ghcr.io/iuliandita/ditero", "docker.io/iuliandita/ditero")
REQUIRED = ("ci.yml", "security.yml", "android.yml", "desktop.yml", "release-checks.yml")
FILES = ("deploy/docker/aio/run-bundle.sh", "deploy/docker/aio/compose.yml",
         "deploy/docker/aio/README.md", "LICENSE", "docs/runbooks/deployment-settings.md",
         "docs/runbooks/database-roles.md", "docs/runbooks/encryption.md")

def require(value, message):
    if not value:
        raise ValueError(message)

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def checked_sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[0-9a-f]{40}", value), "Expected full lowercase commit SHA")
    return value

def digest(value):
    require(isinstance(value, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", value), "Expected immutable image digest")
    return value

def validate_runs(runs, sha):
    eligible = [r for r in runs if r.get("event") == "push" and r.get("head_branch") == "develop" and r.get("head_sha") == sha]
    require(eligible and max(eligible, key=lambda r: (r["run_number"], r.get("run_attempt", 1)))["conclusion"] == "success", "Latest same-SHA develop push must pass")

def source_gate(sha, workflow_sha, repo):
    checked_sha(sha)
    require(repo == "iuliandita/ditero", "Unexpected publication repository")
    require(sha == workflow_sha, "Dispatch ref and explicit source SHA must agree")
    def run(*args):
        return subprocess.check_output(args, cwd=ROOT, text=True).strip()
    require(run("git", "rev-parse", "HEAD") == sha, "Checkout SHA mismatch")
    subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/develop"], cwd=ROOT, check=True)
    for workflow in REQUIRED:
        pages = json.loads(run("gh", "api", f"repos/{repo}/actions/workflows/{workflow}/runs?head_sha={sha}&per_page=100", "--paginate", "--slurp"))
        validate_runs([r for page in pages for r in page["workflow_runs"]], sha)

def validate_inventory(data, sha):
    checked_sha(sha)
    require(data.get("sourceSHA") == sha, "Inventory source mismatch")
    require(re.fullmatch(r"aio-experimental-" + sha + r"-[1-9][0-9]*-[1-9][0-9]*", data.get("candidate", "")), "Unique experimental candidate required")
    require(data.get("repositories") == list(REPOSITORIES), "Both approved registries required")
    require(re.fullmatch(r"https://github.com/iuliandita/ditero/actions/runs/[1-9][0-9]*", data.get("workflowRunURL", "")), "Workflow run identity required")
    require(re.fullmatch(r"iuliandita/ditero/\.github/workflows/aio-experimental\.yml@refs/(?:heads|tags)/[A-Za-z0-9_./-]+", data.get("workflowRef", "")), "Workflow signing identity required")
    digest(data.get("indexDigest"))
    require(set(data.get("platforms", {})) == {"amd64", "arm64"}, "Both platforms required")
    for arch, row in data["platforms"].items():
        require(row.get("sourceSHA") == sha and row.get("platform") == "linux/" + arch, "Platform identity mismatch")
        digest(row.get("digest"))
        require(row.get("registriesMatch") is True and row.get("scanPassed") is True, "Platform scan and registry parity required")
        require(row.get("sbom") == f"sbom-{arch}.spdx.json", "Unexpected SBOM name")
        require(row.get("signed") is True and row.get("provenanceAttested") is True, "Platform signing and provenance required")
    require(data.get("indexRegistriesMatch") is True and data.get("indexSigned") is True and data.get("indexProvenanceAttested") is True, "Index evidence incomplete")

def package(root, sha, inventory, evidence, output):
    validate_inventory(inventory, sha)
    require(not output.exists(), "Output already exists; no replay")
    members = {}
    for name in FILES:
        path = root / name
        require(path.is_file() and not path.is_symlink(), "Missing regular package source: " + name)
        members[name] = path.read_bytes()
    for arch, row in inventory["platforms"].items():
        name = row["sbom"]
        path = evidence / name
        require(path.is_file() and not path.is_symlink(), "Missing SBOM")
        payload = path.read_bytes()
        sbom = json.loads(payload)
        require(sbom.get("spdxVersion", "").startswith("SPDX-"), "Invalid SPDX SBOM")
        require(sha256(payload) == row.get("sbomSHA256"), "SBOM byte mismatch")
        members["evidence/" + name] = payload
    members["IMAGE-INVENTORY.json"] = (json.dumps(inventory, indent=2, sort_keys=True) + "\n").encode()
    members["SOURCE.json"] = (json.dumps({"sourceSHA": sha, "experimental": True, "runtimeQualified": False,
        "workflow": "aio-experimental.yml", "workflowRunURL": inventory["workflowRunURL"], "workflowRef": inventory["workflowRef"], "sourceFiles": {n: sha256(members[n]) for n in FILES}}, indent=2, sort_keys=True) + "\n").encode()
    members["SHA256SUMS"] = "".join(f"{sha256(data)}  {name}\n" for name, data in sorted(members.items())).encode()
    output.mkdir(parents=True)
    archive = output / (inventory["candidate"] + ".tar.gz")
    with tarfile.open(archive, "w:gz", format=tarfile.PAX_FORMAT) as tar:
        for name, data in sorted(members.items()):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o755 if name.endswith("run-bundle.sh") else 0o644
            info.mtime = 0
            tar.addfile(info, io.BytesIO(data))
    (output / "SHA256SUMS").write_text(f"{sha256(archive.read_bytes())}  {archive.name}\n")
    return archive

def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    gate = sub.add_parser("check-source")
    gate.add_argument("--sha", required=True)
    gate.add_argument("--workflow-sha", required=True)
    gate.add_argument("--repo", required=True)
    pack = sub.add_parser("package")
    pack.add_argument("--sha", required=True)
    pack.add_argument("--inventory", type=Path, required=True)
    pack.add_argument("--evidence", type=Path, required=True)
    pack.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "check-source":
        source_gate(args.sha, args.workflow_sha, args.repo)
    else:
        checked_sha(args.sha)
        require(subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip() == args.sha, "Package checkout SHA mismatch")
        for name in FILES:
            committed = subprocess.check_output(["git", "show", f"{args.sha}:{name}"], cwd=ROOT)
            require((ROOT / name).read_bytes() == committed, "Package source differs from checked commit")
        package(ROOT, args.sha, json.loads(args.inventory.read_text()), args.evidence, args.output)

if __name__ == "__main__":
    main()
