use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};
use tauri::Manager;

pub fn keystore_cli() -> bool {
    if !std::env::args().any(|a| a == "--journey-keystore") {
        return false;
    }
    let configured = std::env::var("DITERO_JOURNEY_TOKEN")
        .is_ok_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
        && std::env::var_os("DITERO_JOURNEY_DIRECTORY").is_some();
    if !configured {
        eprintln!("Debug keystore probe is not configured");
        std::process::exit(2);
    }
    match keystore_metadata() {
        Ok(value) => println!("{value}"),
        Err(code) => {
            eprintln!("{code}");
            std::process::exit(2);
        }
    }
    true
}

// Read fresh OS entries in the signed app's identity, never the actor's memory.
fn keystore_metadata() -> Result<serde_json::Value, &'static str> {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    let store = crate::vault::native_store().map_err(|_| "keystore unavailable")?;
    let entry = |name: &str| {
        store
            .build("io.ditero.desktop", name, None)
            .map_err(|_| "keystore entry unavailable")
    };
    let raw = entry("native-sessions-v1")?
        .get_password()
        .map_err(|_| "keystore root unavailable")?;
    let commit: Value = serde_json::from_str(&raw).map_err(|_| "invalid keystore root")?;
    let chunks = commit["chunks"]
        .as_u64()
        .filter(|n| (1..=410).contains(n))
        .ok_or("invalid chunk count")?;
    let generation = commit["generation"]
        .as_str()
        .filter(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
        .ok_or("invalid generation")?;
    let mut bytes = Vec::new();
    for index in 0..chunks {
        let chunk = entry(&format!("native-sessions-v2-{generation}-{index}"))?
            .get_secret()
            .map_err(|_| "keystore chunk unavailable")?;
        if chunk.is_empty() || chunk.len() > 2560 || bytes.len() + chunk.len() > 1024 * 1024 {
            return Err("invalid keystore chunk");
        }
        bytes.extend(chunk);
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if commit["version"] != 2 || commit["digest"] != digest {
        return Err("keystore digest mismatch");
    }
    let snapshot: Value =
        serde_json::from_slice(&bytes).map_err(|_| "invalid keystore snapshot")?;
    let sessions = snapshot["sessions"].as_object().ok_or("invalid sessions")?;
    let credentials = snapshot["credentials"]
        .as_object()
        .ok_or("invalid credentials")?;
    let proofs = snapshot["evidence"].as_object();
    let mut fences = 0;
    for reference in sessions.values() {
        let credential = credentials
            .get(
                reference["credential"]
                    .as_str()
                    .ok_or("invalid credential reference")?,
            )
            .ok_or("missing credential")?;
        let binding = json!([
            credential["origin"],
            credential["user_id"],
            credential["device_id"],
            credential["session_id"],
            credential["token"]
        ]);
        let hash = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&binding).map_err(|_| "invalid binding")?)
        );
        match entry(&format!("request-fence-v1-{hash}"))?.get_password() {
            Ok(_) => fences += 1,
            Err(keyring_core::Error::NoEntry) => {}
            Err(_) => return Err("keystore fence unavailable"),
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "invalid clock")?
        .as_millis() as i64;
    let ready = proofs.is_some_and(|p| {
        !p.is_empty()
            && p.iter().all(|(origin, proof)| {
                proof["verified"] == true
                    && proof["pending"] == false
                    && ["name", "email", "zero", "workspace"]
                        .iter()
                        .all(|key| !proof[*key].is_null())
                    && proof["session_ref"]["credential"]
                        == snapshot["sessions"][origin]["credential"]
                    && proof["session_ref"]["expires_at"]
                        .as_str()
                        .is_some_and(|v| {
                            chrono::DateTime::parse_from_rfc3339(v)
                                .is_ok_and(|d| d.timestamp_millis() > now)
                        })
            })
    });
    Ok(
        json!({"reader":"fresh-os-keychain-read", "requestFenceCount":fences,
        "sessionCount":sessions.len(), "credentialCount":credentials.len(),
        "evidenceCount":proofs.map_or(0, |p| p.len()), "evidenceReady":fences == 0 && ready,
        "notificationCount":snapshot["notifications"].as_object().map_or(0, |p| p.len()) + snapshot["retired_notifications"].as_array().map_or(0, |p| p.len()),
        "pending":commit["pending"], "digest":digest, "blobCount":chunks}),
    )
}

// This module is excluded from every release build, and inert without both inputs.
pub fn start(app: tauri::AppHandle) -> std::io::Result<()> {
    let (Ok(directory), Ok(token)) = (
        std::env::var("DITERO_JOURNEY_DIRECTORY"),
        std::env::var("DITERO_JOURNEY_TOKEN"),
    ) else {
        return Ok(());
    };
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(std::io::Error::other("invalid journey token"));
    }
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let ready = std::path::Path::new(&directory).join("hook.json");
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(ready)?;
    write!(file, "{{\"port\":{}}}", listener.local_addr()?.port())?;
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let _ = stream.set_write_timeout(Some(Duration::from_secs(5)));
            let mut line = String::new();
            if BufReader::new((&stream).take(1024 * 1024))
                .read_line(&mut line)
                .is_err()
            {
                continue;
            }
            let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if request["token"].as_str() != Some(&token) {
                continue;
            }
            let Some(script) = request["script"].as_str() else {
                continue;
            };
            let Some(window) = app.get_webview_window("main") else {
                continue;
            };
            if script == "__journey_close__" {
                let _ = window.close();
                let _ = writeln!(stream, "true");
                continue;
            }
            let (tx, rx) = mpsc::sync_channel(1);
            let result = window.eval_with_callback(script, move |result| {
                let _ = tx.send(result);
            });
            if result.is_ok() {
                if let Ok(result) = rx.recv_timeout(Duration::from_secs(10)) {
                    let _ = writeln!(stream, "{result}");
                }
            }
        }
    });
    Ok(())
}
