"""Prove the native close regression fails when handshake settlement is removed."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

root = Path.cwd()
source = root / "apps/desktop/src-tauri/src/host.rs"
original = source.read_bytes()
block = b"""    if !socket.is_open.load(Ordering::SeqCst) {
        // Let the existing 20-second handshake classify trust before cancellation.
        let _ = tokio::time::timeout(Duration::from_secs(21), &mut socket.handshake).await;
    }
"""
assert original.count(block) == 1, "Close mutation premise changed"
command = ["cargo", "test", "--locked", "--manifest-path", "apps/desktop/src-tauri/Cargo.toml", "--target", os.environ["DESKTOP_TARGET"], "normal_close_settles_pending_handshakes_without_clearing_refusals"]
evidence = Path(os.environ["RUNNER_TEMP"]) / "desktop-journeys/evidence"
evidence.mkdir(parents=True, exist_ok=True)
try:
    source.write_bytes(original.replace(block, b""))
    assert source.read_bytes() != original
    mutant = subprocess.run(command, capture_output=True, text=True, timeout=180)
    output = mutant.stdout + mutant.stderr
    (evidence / "close-mutant.log").write_text(output)
    assert mutant.returncode != 0 and "normal close returns before handshake classification" in output, "Mutation did not reach the expected refusal-fence assertion"
finally:
    source.write_bytes(original)
assert source.read_bytes() == original, "Native source restoration failed"
fixed = subprocess.run(command, capture_output=True, text=True, timeout=180)
(evidence / "close-restored.log").write_text(fixed.stdout + fixed.stderr)
assert fixed.returncode == 0, "Restored close regression failed"
(evidence / "close-mutation.json").write_text(json.dumps({"mutantExit": mutant.returncode, "restoredExit": fixed.returncode, "sourceRestored": True, "sourceSha256": hashlib.sha256(original).hexdigest()}))
