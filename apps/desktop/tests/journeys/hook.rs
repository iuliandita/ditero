use std::{
    io::{BufRead, BufReader, Read, Write},
    net::TcpListener,
    sync::mpsc,
    time::Duration,
};
use tauri::Manager;

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
