"""Read the real OS store independently; emit counts and digests, never secrets."""
import ctypes as c
from datetime import datetime, timezone
import hashlib
import json
import subprocess
import sys

SERVICE = "io.ditero.desktop"


class MissingEntry(Exception):
    pass


def read_entry(account: str) -> bytes:
    if sys.platform == "win32":
        from ctypes import wintypes as w

        class Credential(c.Structure):
            _fields_ = [
                ("flags", w.DWORD), ("kind", w.DWORD), ("target", w.LPWSTR),
                ("comment", w.LPWSTR), ("written", w.FILETIME),
                ("size", w.DWORD), ("blob", c.POINTER(c.c_ubyte)),
                ("persist", w.DWORD), ("count", w.DWORD), ("attributes", c.c_void_p),
                ("alias", w.LPWSTR), ("user", w.LPWSTR),
            ]

        api = c.WinDLL("advapi32", use_last_error=True)
        pointer = c.POINTER(Credential)()
        api.CredReadW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, c.POINTER(c.POINTER(Credential))]
        if not api.CredReadW(f"{account}.{SERVICE}", 1, 0, c.byref(pointer)):
            code = c.get_last_error()
            if code == 1168:
                raise MissingEntry(account)
            raise RuntimeError(f"Credential Manager read failed: {code}")
        try:
            return c.string_at(pointer.contents.blob, pointer.contents.size)
        finally:
            api.CredFree(pointer)
    if sys.platform == "darwin":
        security = c.CDLL("/System/Library/Frameworks/Security.framework/Security")
        core = c.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
        service, user = SERVICE.encode(), account.encode()
        size, data = c.c_uint32(), c.c_void_p()
        security.SecKeychainFindGenericPassword.argtypes = [c.c_void_p, c.c_uint32, c.c_char_p, c.c_uint32, c.c_char_p, c.POINTER(c.c_uint32), c.POINTER(c.c_void_p), c.c_void_p]
        status = security.SecKeychainFindGenericPassword(None, len(service), service, len(user), user, c.byref(size), c.byref(data), None)
        if status:
            if status == -25300:
                raise MissingEntry(account)
            raise RuntimeError(f"Keychain read failed: {status}")
        try:
            return c.string_at(data, size.value)
        finally:
            security.SecKeychainItemFreeContent(None, data)
            del core
    result = subprocess.run(["secret-tool", "lookup", "service", SERVICE, "username", account], capture_output=True)
    if result.returncode == 1 and not result.stdout and not result.stderr:
        raise MissingEntry(account)
    result.check_returncode()
    return result.stdout


def inspect() -> dict:
    raw = read_entry("native-sessions-v1")
    commit = json.loads(raw.decode("utf-16-le" if sys.platform == "win32" else "utf8"))
    assert commit["version"] == 2
    chunks = [read_entry(f"native-sessions-v2-{commit['generation']}-{i}") for i in range(commit["chunks"])]
    if sys.platform not in ("win32", "darwin"):
        # secret-tool appends a newline to binary output.
        chunks = [chunk[:-1] if chunk.endswith(b"\n") else chunk for chunk in chunks]
    payload = b"".join(chunks)
    assert hashlib.sha256(payload).hexdigest() == commit["digest"], "Protected snapshot digest mismatch"
    snapshot = json.loads(payload)
    fences = 0
    for reference in snapshot["sessions"].values():
        session = snapshot["credentials"][reference["credential"]]
        binding = [session[field] for field in ("origin", "user_id", "device_id", "session_id", "token")]
        digest = hashlib.sha256(json.dumps(binding, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
        try:
            read_entry(f"request-fence-v1-{digest}")
            fences += 1
        except MissingEntry:
            pass
    return {
        "requestFenceCount": fences,
        "sessionCount": len(snapshot["sessions"]),
        "credentialCount": len(snapshot["credentials"]),
        "evidenceCount": len(snapshot.get("evidence", {})),
        "evidenceReady": fences == 0 and bool(snapshot.get("evidence")) and all(
            proof["verified"] and not proof["pending"]
            and all(proof.get(field) is not None for field in ("name", "email", "zero", "workspace"))
            and proof["session_ref"]["credential"] == snapshot["sessions"][origin]["credential"]
            and datetime.fromisoformat(proof["session_ref"]["expires_at"].replace("Z", "+00:00")) > datetime.now(timezone.utc)
            for origin, proof in snapshot.get("evidence", {}).items()
        ),
        "notificationCount": len(snapshot.get("notifications", {})) + len(snapshot.get("retired_notifications", [])),
        "pending": commit["pending"],
        "digest": commit["digest"],
        "blobCount": len(chunks),
    }


if __name__ == "__main__":
    print(json.dumps(inspect()))
