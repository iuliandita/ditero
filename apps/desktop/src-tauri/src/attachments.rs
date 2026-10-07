use crate::{
    protocol::{self, Result},
    vault::Session,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use futures_util::StreamExt;
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt},
    sync::mpsc,
};

pub const CHUNK: usize = 32768;
const ARCHIVE_LIMIT: usize = 32 * 1024 * 1024;
const STAGE_LIMIT: u64 = 512 * 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);
pub type Completion = Arc<dyn Fn(Result<Value>) + Send + Sync>;
#[derive(Clone)]
pub struct Context {
    pub gen: u64,
    pub page: u64,
    pub session: Session,
    pub clock: Arc<AtomicU64>,
    pub pages: Arc<AtomicU64>,
    epoch: Option<(Arc<AtomicU64>, u64)>,
    commit: Option<Arc<Mutex<()>>>,
    cancelled: Arc<AtomicBool>,
}
impl Context {
    pub fn new(
        gen: u64,
        page: u64,
        session: Session,
        clock: Arc<AtomicU64>,
        pages: Arc<AtomicU64>,
    ) -> Self {
        Self {
            gen,
            page,
            session,
            clock,
            pages,
            epoch: None,
            commit: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    fn current(&self) -> Result<()> {
        if !self.cancelled.load(Ordering::SeqCst)
            && self.clock.load(Ordering::SeqCst) == self.gen
            && self.pages.load(Ordering::SeqCst) == self.page
            && self
                .epoch
                .as_ref()
                .is_none_or(|(clock, generation)| clock.load(Ordering::SeqCst) == *generation)
        {
            Ok(())
        } else {
            Err("cancelled")
        }
    }
    async fn retired(&self) {
        loop {
            if self.current().is_err() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    fn matches(&self, other: &Self) -> bool {
        self.gen == other.gen
            && self.page == other.page
            && self.session.session_id == other.session.session_id
            && self.session.scope() == other.session.scope()
            && self.session.token == other.session.token
    }
}
struct Command {
    op: String,
    body: Value,
    done: Completion,
}
struct Capability {
    context: Context,
    tx: mpsc::Sender<Command>,
    task: tauri::async_runtime::JoinHandle<()>,
    busy: bool,
    pending: Option<Completion>,
    kind: String,
    ready: bool,
}
#[derive(Clone, Default)]
pub struct Transfers {
    entries: Arc<Mutex<HashMap<String, Capability>>>,
    root: PathBuf,
    epoch: Arc<AtomicU64>,
    commit: Arc<Mutex<()>>,
}
fn random() -> String {
    let mut b = [0; 24];
    OsRng.fill_bytes(&mut b);
    STANDARD.encode(b).replace('+', "-").replace('/', "_")
}
fn exact(body: &Value, fields: &[&str]) -> Result<()> {
    let m = body.as_object().ok_or("invalid-body")?;
    if m.len() != fields.len() || fields.iter().any(|k| !m.contains_key(*k)) {
        Err("invalid-body")
    } else {
        Ok(())
    }
}
fn number(v: &Value, key: &str) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n <= 9_007_199_254_740_991)
        .ok_or("invalid-body")
}
fn chunk(v: &Value) -> Result<Vec<u8>> {
    let s = protocol::string(v, "data")?;
    if s.len() > CHUNK.div_ceil(3) * 4 {
        return Err("chunk-too-large");
    }
    let bytes = STANDARD.decode(s).map_err(|_| "invalid-base64")?;
    if bytes.is_empty() || bytes.len() > CHUNK || STANDARD.encode(&bytes) != s {
        return Err("invalid-chunk");
    }
    Ok(bytes)
}
fn target(body: &Value, action: &str) -> Result<String> {
    let id = protocol::string(body, "attachmentId")?;
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    {
        return Err("invalid-id");
    }
    let thumbnail = body
        .get("thumbnail")
        .and_then(Value::as_bool)
        .ok_or("invalid-body")?;
    Ok(format!(
        "/api/native/attachments/{id}/{}",
        if thumbnail { "thumbnail" } else { action }
    ))
}
fn filename(body: &Value) -> Result<String> {
    exact(body, &["filename"])?;
    let s = protocol::string(body, "filename")?;
    if s.is_empty()
        || s.len() > 255
        || s == "."
        || s == ".."
        || s.chars().any(|c| c.is_control() || "/\\:".contains(c))
    {
        return Err("invalid-filename");
    }
    Ok(s.to_string())
}
async fn response(mut response: reqwest::Response) -> Result<Value> {
    let status = response.status().as_u16();
    let mut raw = Vec::new();
    while let Some(b) = response.chunk().await.map_err(|_| "network")? {
        if raw.len() + b.len() > 65536 {
            return Err("invalid-response");
        }
        raw.extend_from_slice(&b);
    }
    let raw = String::from_utf8(raw).map_err(|_| "invalid-response")?;
    let valid = protocol::parse(&raw).is_ok();
    Ok(
        json!({"ok":(200..300).contains(&status)&&valid,"status":status,"body":if valid{Some(raw)}else{None}}),
    )
}

impl Transfers {
    pub fn set_root(&mut self, root: PathBuf) {
        self.root = root;
    }
    pub fn retirement(&self) -> std::sync::MutexGuard<'_, ()> {
        self.commit.lock().unwrap()
    }
    pub fn cancel_all(&self) {
        {
            let _guard = self.retirement();
            self.epoch.fetch_add(1, Ordering::SeqCst);
        }
        let caps: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, cap)| cap)
            .collect();
        for cap in caps {
            cap.task.abort();
            if let Some(pending) = cap.pending {
                pending(Err("cancelled"));
            }
        }
    }
    pub fn dispatch(
        &self,
        mut context: Context,
        http: reqwest::Client,
        v: Value,
        done: Completion,
    ) -> Result<()> {
        context.epoch = Some((self.epoch.clone(), self.epoch.load(Ordering::SeqCst)));
        context.commit = Some(self.commit.clone());
        context.current()?;
        let op = protocol::string(&v, "op")?.to_string();
        let body = v.get("body").cloned().unwrap_or(json!({}));
        if op.starts_with("attachment.")
            && matches!(
                op.as_str(),
                "attachment.config"
                    | "attachment.reserve"
                    | "attachment.finalize"
                    | "attachment.abort"
                    | "attachment.delete"
            )
        {
            let (post, path, payload) = protocol::attachment(&v)?;
            return self.begin(context, op, body, done, move |ctx, _, _, _| {
                Box::pin(async move {
                    let mut request = if post {
                        http.post(format!("{}{path}", ctx.session.origin))
                    } else {
                        http.get(format!("{}{path}", ctx.session.origin))
                    }
                    .bearer_auth(&ctx.session.token)
                    .header("Accept", "application/json");
                    if let Some(payload) = payload {
                        request = request
                            .header("Content-Type", "application/json")
                            .body(payload);
                    }
                    response(request.send().await.map_err(|_| "network")?).await
                })
            });
        }
        if (op.starts_with("archive.export.") || op.starts_with("archive.input."))
            && !cfg!(target_os = "linux")
        {
            return Err("unknown-op");
        }
        match op.as_str() {
            "archive.input.pick" => {
                exact(&body, &["kind"])?;
                let kind = protocol::string(&body, "kind")?;
                if !matches!(kind, "content" | "archive") {
                    return Err("invalid-body");
                }
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(archive_input(ctx, id, rx, ready))
                })
            }
            "archive.export.begin" => {
                exact(&body, &[])?;
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(archive_export(ctx, http, id, rx, ready))
                })
            }
            "upload.begin" => {
                exact(&body, &["attachmentId", "thumbnail", "bytes"])?;
                let path = target(&body, "upload")?;
                let bytes = number(&body, "bytes")?;
                if bytes == 0 {
                    return Err("invalid-body");
                }
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(upload(ctx, http, path, bytes, id, rx, ready))
                })
            }
            "download.begin" => {
                exact(&body, &["attachmentId", "thumbnail"])?;
                let path = target(&body, "download")?;
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(download(ctx, http, path, id, rx, ready))
                })
            }
            "stage.begin" => {
                let fields = if body.get("bytes").is_some() {
                    &["bytes"][..]
                } else {
                    &[][..]
                };
                exact(&body, fields)?;
                let bytes = if fields.is_empty() {
                    None
                } else {
                    Some(number(&body, "bytes")?)
                };
                if bytes.is_some_and(|b| b == 0 || b > STAGE_LIMIT) {
                    return Err("stage-too-large");
                }
                let root = self.root.clone();
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(stage(ctx, root, bytes, id, rx, ready))
                })
            }
            "save.pick" => {
                let filename = filename(&body)?;
                self.begin(context, op, body, done, move |ctx, id, rx, ready| {
                    Box::pin(save(ctx, filename, id, rx, ready))
                })
            }
            "save.cancelPending"
            | "archive.export.cancelPending"
            | "archive.input.cancelPending" => {
                exact(&body, &[])?;
                let mut entries = self.entries.lock().unwrap();
                let ids: Vec<_> = entries
                    .iter()
                    .filter(|(_, cap)| {
                        cap.kind
                            == if op == "save.cancelPending" {
                                "save.pick"
                            } else if op == "archive.input.cancelPending" {
                                "archive.input.pick"
                            } else {
                                "archive.export.begin"
                            }
                            && !cap.ready
                            && cap.context.matches(&context)
                    })
                    .map(|(id, _)| id.clone())
                    .collect();
                let caps: Vec<_> = ids
                    .into_iter()
                    .filter_map(|id| entries.remove(&id))
                    .collect();
                drop(entries);
                for cap in caps {
                    cap.task.abort();
                    if let Some(pending) = cap.pending {
                        pending(Err("cancelled"));
                    }
                }
                done(Ok(json!({"ok":true})));
                Ok(())
            }
            "attachment.cancel" | "stage.cancel" | "save.cancel" | "archive.input.cancel" => {
                let key = if op == "save.cancel" {
                    "saveId"
                } else if op == "stage.cancel" {
                    "stageId"
                } else {
                    "transferId"
                };
                exact(&body, &[key])?;
                let id = protocol::string(&body, key)?;
                let mut entries = self.entries.lock().unwrap();
                let cap = entries.get(id).ok_or("invalid-transfer")?;
                if !cap.context.matches(&context)
                    || (op == "archive.input.cancel" && cap.kind != "archive.input.pick")
                {
                    return Err("invalid-transfer");
                }
                let cap = entries.remove(id).unwrap();
                drop(entries);
                {
                    let _guard = self.retirement();
                    cap.context.cancelled.store(true, Ordering::SeqCst);
                }
                cap.task.abort();
                if let Some(pending) = cap.pending {
                    pending(Err("cancelled"));
                }
                done(Ok(json!({"ok":true})));
                Ok(())
            }
            "archive.export.read"
            | "archive.input.read"
            | "upload.write"
            | "upload.finish"
            | "download.read"
            | "stage.write"
            | "stage.read"
            | "stage.rewind"
            | "save.write"
            | "save.finish" => {
                let key = if op.starts_with("save.") {
                    "saveId"
                } else if op.starts_with("stage.") {
                    "stageId"
                } else {
                    "transferId"
                };
                let id = protocol::string(&body, key)?;
                let fields = if op.ends_with(".write") {
                    vec![key, "seq", "data"]
                } else if op == "stage.rewind" {
                    vec![key]
                } else {
                    vec![key, "seq"]
                };
                exact(&body, &fields)?;
                if op.ends_with(".write") {
                    chunk(&body)?;
                }
                if op != "stage.rewind" {
                    number(&body, "seq")?;
                }
                let mut entries = self.entries.lock().unwrap();
                let cap = entries.get_mut(id).ok_or("invalid-transfer")?;
                if !cap.context.matches(&context)
                    || (op == "archive.input.read" && cap.kind != "archive.input.pick")
                {
                    return Err("invalid-transfer");
                }
                if cap.busy {
                    return Err("busy");
                }
                cap.busy = true;
                let entries_ref = self.entries.clone();
                let id = id.to_string();
                let ack: Completion = Arc::new(move |result| {
                    if let Some(cap) = entries_ref.lock().unwrap().get_mut(&id) {
                        cap.busy = false;
                        cap.pending = None;
                    }
                    done(result);
                });
                cap.pending = Some(ack.clone());
                cap.tx
                    .try_send(Command {
                        op,
                        body,
                        done: ack,
                    })
                    .map_err(|_| "busy")
            }
            _ => Err("unknown-op"),
        }
    }
    fn begin<F>(
        &self,
        mut context: Context,
        op: String,
        _body: Value,
        done: Completion,
        run: F,
    ) -> Result<()>
    where
        F: FnOnce(
                Context,
                String,
                mpsc::Receiver<Command>,
                Completion,
            )
                -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value>> + Send>>
            + Send
            + 'static,
    {
        let mut entries = self.entries.lock().unwrap();
        if op == "archive.export.begin"
            && entries
                .values()
                .any(|cap| cap.kind == op && cap.context.matches(&context))
        {
            return Err("busy");
        }
        if entries.len() >= 4 {
            return Err("too-many-transfers");
        }
        context.current()?;
        context.cancelled = Arc::new(AtomicBool::new(false));
        let id = random();
        let (tx, rx) = mpsc::channel(1);
        let shared = self.entries.clone();
        let task_id = id.clone();
        let ctx = context.clone();
        let ready_id = id.clone();
        let ready_entries = shared.clone();
        let initial = done.clone();
        let ready: Completion = Arc::new(move |result| {
            if let Some(cap) = ready_entries.lock().unwrap().get_mut(&ready_id) {
                cap.busy = false;
                cap.pending = None;
                cap.ready = true;
            }
            initial(result);
        });
        let pending = done.clone();
        let task = tauri::async_runtime::spawn(async move {
            let outcome = tokio::select! { result=run(ctx.clone(), task_id.clone(), rx, ready)=>result, _=ctx.retired()=>Err("cancelled") };
            let cap = shared.lock().unwrap().remove(&task_id);
            if let Some(pending) = cap.and_then(|cap| cap.pending) {
                pending(outcome);
            }
        });
        entries.insert(
            id,
            Capability {
                context,
                tx,
                task,
                busy: true,
                pending: Some(pending),
                kind: op,
                ready: false,
            },
        );
        Ok(())
    }
}

struct Temporary {
    path: PathBuf,
    file: Option<tokio::fs::File>,
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let path = std::mem::take(&mut self.path);
        let file = self.file.take();
        tauri::async_runtime::spawn(async move {
            if let Some(mut file) = file {
                if file.shutdown().await.is_err() {
                    eprintln!("native temporary file close failed");
                }
                drop(file);
            }
            if !path.as_os_str().is_empty() {
                if let Err(error) = tokio::fs::remove_file(path).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        eprintln!("native temporary file cleanup failed");
                    }
                }
            }
        });
    }
}
async fn private_file(path: PathBuf) -> Result<Temporary> {
    let mut options = tokio::fs::OpenOptions::new();
    options.create_new(true).read(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options.open(&path).await.map_err(|_| "file-unavailable")?;
    Ok(Temporary {
        path,
        file: Some(file),
    })
}
async fn command(rx: &mut mpsc::Receiver<Command>) -> Result<Command> {
    tokio::time::timeout(DEADLINE, rx.recv())
        .await
        .map_err(|_| "transfer-timeout")?
        .ok_or("cancelled")
}
fn sequence(body: &Value, expected: u64) -> Result<()> {
    if number(body, "seq")? == expected {
        Ok(())
    } else {
        Err("invalid-sequence")
    }
}
async fn stage(
    ctx: Context,
    root: PathBuf,
    bytes: Option<u64>,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    let root = root.join(format!("{:x}", Sha256::digest(ctx.session.scope())));
    tokio::fs::create_dir_all(&root)
        .await
        .map_err(|_| "stage-unavailable")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|_| "stage-unavailable")?;
    }
    let mut cleanup = private_file(root.join(format!("stage-{id}"))).await?;
    let file = cleanup.file.as_mut().unwrap();
    ctx.current()?;
    ready(Ok(json!({"ok":true,"stageId":id})));
    let mut written = 0;
    let mut write_seq = 0;
    let mut read_seq = 0;
    let mut rewinds = 0;
    loop {
        let c = command(&mut rx).await?;
        ctx.current()?;
        let result = tokio::time::timeout(DEADLINE, async {
            match c.op.as_str() {
                "stage.write" if rewinds == 0 => {
                    sequence(&c.body, write_seq)?;
                    let b = chunk(&c.body)?;
                    let next = written + b.len() as u64;
                    if next > bytes.unwrap_or(STAGE_LIMIT) {
                        return Err("stage-too-large");
                    }
                    file.write_all(&b).await.map_err(|_| "file-write-failed")?;
                    written = next;
                    write_seq += 1;
                    Ok(json!({"ok":true}))
                }
                "stage.rewind" if rewinds < 2 => {
                    if bytes.is_some_and(|n| n != written) {
                        return Err("incomplete-stage");
                    }
                    file.flush().await.map_err(|_| "file-write-failed")?;
                    file.seek(std::io::SeekFrom::Start(0))
                        .await
                        .map_err(|_| "file-read-failed")?;
                    read_seq = 0;
                    rewinds += 1;
                    Ok(json!({"ok":true}))
                }
                "stage.read" if rewinds > 0 => {
                    sequence(&c.body, read_seq)?;
                    let mut b = vec![0; CHUNK];
                    let n = file.read(&mut b).await.map_err(|_| "file-read-failed")?;
                    b.truncate(n);
                    read_seq += 1;
                    Ok(json!({"ok":true,"data":STANDARD.encode(b),"eof":n == 0}))
                }
                _ => Err("invalid-transfer-operation"),
            }
        })
        .await
        .unwrap_or(Err("transfer-timeout"));
        let stop = result.is_err();
        (c.done)(result);
        if stop {
            return Err("transfer-failed");
        }
    }
}
async fn save(
    ctx: Context,
    filename: String,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    let selected = tokio::time::timeout(
        Duration::from_secs(300),
        rfd::AsyncFileDialog::new()
            .set_file_name(filename)
            .save_file(),
    )
    .await
    .map_err(|_| "picker-timeout")?
    .ok_or("cancelled")?;
    ctx.current()?;
    let path = selected.path().to_path_buf();
    let parent = path.parent().ok_or("invalid-file")?;
    let mut cleanup = private_file(parent.join(format!(".ditero-{id}.part"))).await?;
    let file = cleanup.file.as_mut().unwrap();
    ctx.current()?;
    ready(Ok(json!({"ok":true,"saveId":id})));
    let mut seq = 0;
    let mut written = 0u64;
    let mut started = false;
    loop {
        // The complete integrity pass runs before the first plaintext write.
        // Native retirement/cancel still ends this pending destination immediately.
        let c = if started {
            command(&mut rx).await?
        } else {
            rx.recv().await.ok_or("cancelled")?
        };
        started = true;
        ctx.current()?;
        let result = tokio::time::timeout(DEADLINE, async {
            sequence(&c.body, seq)?;
            match c.op.as_str() {
                "save.write" => {
                    let data = chunk(&c.body)?;
                    if written + data.len() as u64 > STAGE_LIMIT {
                        return Err("save-too-large");
                    }
                    written += data.len() as u64;
                    file.write_all(&data)
                        .await
                        .map_err(|_| "file-write-failed")?;
                    seq += 1;
                    Ok(json!({"ok":true}))
                }
                "save.finish" => {
                    file.sync_all().await.map_err(|_| "file-write-failed")?;
                    let commit = ctx.commit.as_ref().ok_or("cancelled")?.clone();
                    let _guard = commit.lock().unwrap();
                    ctx.current()?;
                    // Linearize the selected-file commit with native retirement.
                    std::fs::rename(&cleanup.path, &path).map_err(|_| "file-write-failed")?;
                    cleanup.path = PathBuf::new();
                    Ok(json!({"ok":true}))
                }
                _ => Err("invalid-transfer-operation"),
            }
        })
        .await
        .unwrap_or(Err("transfer-timeout"));
        let stop = result.is_err() || c.op == "save.finish";
        (c.done)(result);
        if stop {
            return Ok(json!({"ok":true}));
        }
    }
}
struct AbortTask(tauri::async_runtime::JoinHandle<Result<Value>>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
async fn queue_chunk(
    sender: &mpsc::Sender<Vec<u8>>,
    network: &mut AbortTask,
    data: Vec<u8>,
) -> Result<Option<Value>> {
    tokio::select! {
     reply = &mut network.0 => reply.map_err(|_| "network")?.map(Some),
     sent = sender.send(data) => {
      if sent.is_err() { (&mut network.0).await.map_err(|_| "network")?.map(Some) } else { Ok(None) }
     }
    }
}
async fn upload(
    ctx: Context,
    http: reqwest::Client,
    path: String,
    bytes: u64,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    let (tx, body_rx) = mpsc::channel::<Vec<u8>>(1);
    let stream = futures_util::stream::unfold(body_rx, |mut rx| async {
        rx.recv()
            .await
            .map(|bytes| (Ok::<_, std::io::Error>(bytes), rx))
    });
    let request = http
        .post(format!("{}{path}", ctx.session.origin))
        .bearer_auth(&ctx.session.token)
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", bytes)
        .body(reqwest::Body::wrap_stream(stream));
    let mut network = AbortTask(tauri::async_runtime::spawn(async move {
        response(request.send().await.map_err(|_| "network")?).await
    }));
    ready(Ok(json!({"ok":true,"transferId":id})));
    let mut seq = 0;
    let mut written = 0;
    let mut tx = Some(tx);
    loop {
        let c = command(&mut rx).await?;
        ctx.current()?;
        let result = tokio::time::timeout(DEADLINE, async {
            sequence(&c.body, seq)?;
            match c.op.as_str() {
                "upload.write" => {
                    let b = chunk(&c.body)?;
                    if written + b.len() as u64 > bytes {
                        return Err("upload-too-large");
                    }
                    let n = b.len() as u64;
                    let sender = tx.as_ref().ok_or("closed")?;
                    if let Some(reply) = queue_chunk(sender, &mut network, b).await? {
                        return Ok(reply);
                    }
                    written += n;
                    seq += 1;
                    Ok(json!({"ok":true}))
                }
                "upload.finish" => {
                    if written != bytes {
                        return Err("incomplete-upload");
                    }
                    tx.take();
                    tokio::time::timeout(DEADLINE, &mut network.0)
                        .await
                        .map_err(|_| "transfer-timeout")?
                        .map_err(|_| "network")?
                }
                _ => Err("invalid-transfer-operation"),
            }
        })
        .await
        .unwrap_or(Err("transfer-timeout"));
        let stop = result.is_err()
            || result.as_ref().is_ok_and(|v| v.get("status").is_some())
            || c.op == "upload.finish";
        (c.done)(result);
        if stop {
            return Ok(json!({"ok":true}));
        }
    }
}
async fn download(
    ctx: Context,
    http: reqwest::Client,
    path: String,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    let response = http
        .get(format!("{}{path}", ctx.session.origin))
        .bearer_auth(&ctx.session.token)
        .send()
        .await
        .map_err(|_| "network")?;
    let status = response.status().as_u16();
    if !(200..300).contains(&status) {
        return response_error(response, ready).await;
    }
    let bytes = response.content_length();
    ready(Ok(
        json!({"ok":true,"transferId":id,"status":status,"bytes":bytes}),
    ));
    let stream = response
        .bytes_stream()
        .map(|chunk| chunk.map_err(std::io::Error::other));
    futures_util::pin_mut!(stream);
    let mut reader = tokio_util::io::StreamReader::new(stream);
    let mut seq = 0;
    let mut seen = 0;
    loop {
        let c = command(&mut rx).await?;
        ctx.current()?;
        let result = tokio::time::timeout(DEADLINE, async {
            if c.op != "download.read" {
                return Err("invalid-transfer-operation");
            }
            sequence(&c.body, seq)?;
            let mut data = vec![0; CHUNK];
            let n = tokio::time::timeout(DEADLINE, reader.read(&mut data))
                .await
                .map_err(|_| "transfer-timeout")?
                .map_err(|_| "network")?;
            data.truncate(n);
            seen += n as u64;
            if bytes.is_some_and(|expected| seen > expected) {
                return Err("invalid-response");
            }
            let eof = n == 0;
            if eof && bytes.is_some_and(|expected| seen != expected) {
                return Err("incomplete-download");
            }
            let data = STANDARD.encode(data);
            seq += 1;
            Ok(json!({"ok":true,"data":data,"eof":eof}))
        })
        .await
        .unwrap_or(Err("transfer-timeout"));
        let stop = result
            .as_ref()
            .map_or(true, |v| v.get("eof") == Some(&Value::Bool(true)));
        (c.done)(result);
        if stop {
            return Ok(json!({"ok":true}));
        }
    }
}
fn append_archive(raw: &mut Vec<u8>, bytes: &[u8]) -> Result<()> {
    if bytes.len() > ARCHIVE_LIMIT.saturating_sub(raw.len()) {
        return Err("archive-too-large");
    }
    raw.extend_from_slice(bytes);
    Ok(())
}
async fn archive_export(
    ctx: Context,
    http: reqwest::Client,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    let bytes = tokio::time::timeout(DEADLINE, async {
        let mut response = http
            .get(format!(
                "{}/api/native/portability/export",
                ctx.session.origin
            ))
            .bearer_auth(&ctx.session.token)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|_| "network")?;
        let status = response.status().as_u16();
        if status != 200 {
            let body = if status == 401 {
                let reply = crate::attachments::response(response).await?;
                reply
                    .get("body")
                    .and_then(Value::as_str)
                    .filter(|raw| {
                        protocol::parse(raw).is_ok_and(|v| v == json!({"code":"unauthorized"}))
                    })
                    .map(str::to_string)
            } else {
                None
            };
            ready(Ok(json!({"ok":false,"status":status,"body":body})));
            return Err("archive-export-refused");
        }
        if response
            .content_length()
            .is_some_and(|n| n > ARCHIVE_LIMIT as u64)
        {
            return Err("archive-too-large");
        }
        if response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_none_or(|v| v.split(';').next().unwrap_or("").trim() != "application/json")
        {
            return Err("invalid-response");
        }
        let mut raw = Vec::new();
        while let Some(bytes) = response.chunk().await.map_err(|_| "network")? {
            ctx.current()?;
            append_archive(&mut raw, &bytes)?;
        }
        ctx.current()?;
        String::from_utf8(raw)
            .map(String::into_bytes)
            .map_err(|_| "invalid-response")
    })
    .await
    .map_err(|_| "transfer-timeout")??;
    ready(Ok(json!({"ok":true,"transferId":id,"bytes":bytes.len()})));
    let mut seq = 0;
    let mut offset = 0;
    loop {
        let c = command(&mut rx).await?;
        ctx.current()?;
        if c.op != "archive.export.read" {
            return Err("invalid-transfer-operation");
        }
        sequence(&c.body, seq)?;
        let end = (offset + CHUNK).min(bytes.len());
        let eof = end == offset;
        (c.done)(Ok(
            json!({"ok":true,"data":STANDARD.encode(&bytes[offset..end]),"eof":eof}),
        ));
        if eof {
            return Ok(json!({"ok":true}));
        }
        offset = end;
        seq += 1;
    }
}
async fn archive_input(
    ctx: Context,
    id: String,
    rx: mpsc::Receiver<Command>,
    ready: Completion,
) -> Result<Value> {
    archive_input_selected(ctx, id, rx, ready, async {
        rfd::AsyncFileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file()
            .await
            .map(|file| file.path().to_path_buf())
            .ok_or("cancelled")
    })
    .await
}
async fn archive_input_selected(
    ctx: Context,
    id: String,
    mut rx: mpsc::Receiver<Command>,
    ready: Completion,
    selected: impl std::future::Future<Output = Result<PathBuf>>,
) -> Result<Value> {
    ctx.current()?;
    let path = tokio::time::timeout(Duration::from_secs(300), selected)
        .await
        .map_err(|_| "picker-timeout")??;
    ctx.current()?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| filename(&json!({"filename":name})).ok())
        .unwrap_or_else(|| "archive.json".into());
    let bytes = tokio::time::timeout(DEADLINE, archive_input_bytes(&ctx, &path))
        .await
        .map_err(|_| "transfer-timeout")??;
    ctx.current()?;
    ready(Ok(
        json!({"ok":true,"transferId":id,"bytes":bytes.len(),"name":name}),
    ));
    let mut seq = 0;
    let mut offset = 0;
    loop {
        let c = command(&mut rx).await?;
        ctx.current()?;
        if c.op != "archive.input.read" {
            return Err("invalid-transfer-operation");
        }
        sequence(&c.body, seq)?;
        let end = (offset + CHUNK).min(bytes.len());
        let eof = end == offset;
        (c.done)(Ok(
            json!({"ok":true,"data":STANDARD.encode(&bytes[offset..end]),"eof":eof}),
        ));
        if eof {
            return Ok(json!({"ok":true}));
        }
        offset = end;
        seq += 1;
    }
}
async fn archive_input_bytes(ctx: &Context, path: &std::path::Path) -> Result<Vec<u8>> {
    ctx.current()?;
    let mut options = tokio::fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "linux")]
    // O_NONBLOCK | O_NOFOLLOW: a chooser-path replacement cannot block on a FIFO or follow a link.
    options.custom_flags(0o4000 | 0o400000);
    let mut file = options.open(path).await.map_err(|_| "file-unavailable")?;
    if !file
        .metadata()
        .await
        .map_err(|_| "file-unavailable")?
        .is_file()
    {
        return Err("invalid-file");
    }
    let mut bytes = Vec::new();
    let mut chunk = vec![0; CHUNK];
    loop {
        ctx.current()?;
        let n = file
            .read(&mut chunk)
            .await
            .map_err(|_| "file-unavailable")?;
        ctx.current()?;
        if n == 0 {
            break;
        }
        append_archive(&mut bytes, &chunk[..n])?;
    }
    std::str::from_utf8(&bytes).map_err(|_| "invalid-utf8")?;
    Ok(bytes)
}
async fn response_error(reply: reqwest::Response, ready: Completion) -> Result<Value> {
    let result = response(reply).await;
    ready(result.clone());
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::oneshot;
    fn context() -> Context {
        Context {
            gen: 1,
            page: 1,
            clock: Arc::new(AtomicU64::new(1)),
            pages: Arc::new(AtomicU64::new(1)),
            session: Session {
                origin: "https://one.example".into(),
                token: "native-only-token".into(),
                session_id: "session1".into(),
                user_id: "same-user".into(),
                device_id: "device1".into(),
                expires_at: "2099-01-01T00:00:00Z".into(),
            },
            epoch: None,
            commit: None,
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }
    fn completion() -> (Completion, oneshot::Receiver<Result<Value>>) {
        let (tx, rx) = oneshot::channel();
        let tx = Mutex::new(Some(tx));
        (
            Arc::new(move |v| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(v);
                }
            }),
            rx,
        )
    }
    async fn call(files: &Transfers, ctx: &Context, op: &str, body: Value) -> Result<Value> {
        let (done, rx) = completion();
        files.dispatch(
            ctx.clone(),
            reqwest::Client::new(),
            json!({"op":op,"body":body}),
            done,
        )?;
        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .unwrap()
            .unwrap()
    }
    async fn until(mut predicate: impl FnMut() -> bool) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while !predicate() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
    #[cfg(target_os = "linux")]
    async fn selected_input(files: &Transfers, ctx: &Context, path: PathBuf) -> Result<Value> {
        let (done, rx) = completion();
        let mut ctx = ctx.clone();
        ctx.epoch = Some((files.epoch.clone(), files.epoch.load(Ordering::SeqCst)));
        files.begin(
            ctx,
            "archive.input.pick".into(),
            json!({}),
            done,
            move |ctx, id, rx, ready| {
                Box::pin(archive_input_selected(ctx, id, rx, ready, async move {
                    Ok(path)
                }))
            },
        )?;
        tokio::time::timeout(Duration::from_secs(3), rx)
            .await
            .unwrap()
            .unwrap()
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_input_snapshot_is_immutable_owned_chunked_and_retired() {
        let root = std::env::temp_dir().join(format!("archive-input-{}", random()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("private:name.json");
        let bytes = "é".repeat(CHUNK + 3).into_bytes();
        std::fs::write(&path, &bytes).unwrap();
        let files = Transfers::default();
        let ctx = context();
        let ready = selected_input(&files, &ctx, path.clone()).await.unwrap();
        assert_eq!(ready["bytes"], bytes.len());
        assert_eq!(ready["name"], "archive.json");
        assert!(!ready.to_string().contains(root.to_str().unwrap()));
        let id = ready["transferId"].as_str().unwrap();
        std::fs::write(&path, b"changed after selection").unwrap();
        for dimension in 0..6 {
            let mut foreign = ctx.clone();
            match dimension {
                0 => foreign.session.origin = "https://two.example".into(),
                1 => foreign.session.user_id = "other-user".into(),
                2 => foreign.session.session_id = "other-session".into(),
                3 => foreign.session.token = "other-token".into(),
                4 => {
                    foreign.gen = 2;
                    foreign.clock = Arc::new(AtomicU64::new(2));
                }
                _ => {
                    foreign.page = 2;
                    foreign.pages = Arc::new(AtomicU64::new(2));
                }
            }
            assert_eq!(
                call(
                    &files,
                    &foreign,
                    "archive.input.read",
                    json!({"transferId":id,"seq":0})
                )
                .await,
                Err("invalid-transfer")
            );
        }
        let mut actual = Vec::new();
        for seq in 0..4 {
            let chunk = call(
                &files,
                &ctx,
                "archive.input.read",
                json!({"transferId":id,"seq":seq}),
            )
            .await
            .unwrap();
            let data = chunk["data"].as_str().unwrap();
            let decoded = STANDARD.decode(data).unwrap();
            assert_eq!(STANDARD.encode(&decoded), data);
            assert!(decoded.len() <= CHUNK);
            if seq == 3 {
                assert_eq!(chunk["eof"], true);
                assert!(decoded.is_empty());
            } else {
                assert_eq!(chunk["eof"], false);
                actual.extend(decoded);
            }
        }
        assert_eq!(actual, bytes);
        until(|| files.entries.lock().unwrap().is_empty()).await;
        assert_eq!(
            call(
                &files,
                &ctx,
                "archive.input.read",
                json!({"transferId":id,"seq":4})
            )
            .await,
            Err("invalid-transfer")
        );
        let ready = selected_input(&files, &ctx, path.clone()).await.unwrap();
        let id = ready["transferId"].as_str().unwrap();
        assert_eq!(
            call(
                &files,
                &ctx,
                "archive.input.read",
                json!({"transferId":id,"seq":1})
            )
            .await,
            Err("invalid-sequence")
        );
        until(|| files.entries.lock().unwrap().is_empty()).await;
        let ready = selected_input(&files, &ctx, root.join("private:name.json"))
            .await
            .unwrap();
        files.cancel_all();
        assert_eq!(
            call(
                &files,
                &ctx,
                "archive.input.read",
                json!({"transferId":ready["transferId"],"seq":0})
            )
            .await,
            Err("invalid-transfer")
        );
        std::fs::write(&path, b"").unwrap();
        let ready = selected_input(&files, &ctx, path.clone()).await.unwrap();
        assert_eq!(ready["bytes"], 0);
        let id = ready["transferId"].as_str().unwrap();
        let empty = call(
            &files,
            &ctx,
            "archive.input.read",
            json!({"transferId":id,"seq":0}),
        )
        .await
        .unwrap();
        assert_eq!(empty, json!({"ok":true,"data":"","eof":true}));
        until(|| files.entries.lock().unwrap().is_empty()).await;
        let ready = selected_input(&files, &ctx, path).await.unwrap();
        let id = ready["transferId"].as_str().unwrap();
        let mut foreign = ctx.clone();
        foreign.session.user_id = "other-user".into();
        assert_eq!(
            call(
                &files,
                &foreign,
                "archive.input.cancel",
                json!({"transferId":id})
            )
            .await,
            Err("invalid-transfer")
        );
        call(
            &files,
            &ctx,
            "archive.input.cancel",
            json!({"transferId":id}),
        )
        .await
        .unwrap();
        assert!(files.entries.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_input_rejects_special_files_invalid_utf8_and_observed_oversize() {
        let root = std::env::temp_dir().join(format!("archive-input-{}", random()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("archive.json");
        let files = Transfers::default();
        let ctx = context();
        for path in [root.clone(), PathBuf::from("/dev/null")] {
            assert_eq!(
                selected_input(&files, &ctx, path).await,
                Err("invalid-file")
            );
            until(|| files.entries.lock().unwrap().is_empty()).await;
        }
        std::fs::write(&path, [0xff]).unwrap();
        assert_eq!(
            selected_input(&files, &ctx, path.clone()).await,
            Err("invalid-utf8")
        );
        until(|| files.entries.lock().unwrap().is_empty()).await;
        let link = root.join("link.json");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert_eq!(
            selected_input(&files, &ctx, link).await,
            Err("file-unavailable")
        );
        until(|| files.entries.lock().unwrap().is_empty()).await;
        std::fs::write(&path, vec![b' '; ARCHIVE_LIMIT]).unwrap();
        assert_eq!(
            archive_input_bytes(&ctx, &path).await.unwrap().len(),
            ARCHIVE_LIMIT
        );
        use std::io::Write;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b" ")
            .unwrap();
        assert_eq!(
            selected_input(&files, &ctx, path).await,
            Err("archive-too-large")
        );
        until(|| files.entries.lock().unwrap().is_empty()).await;
        for body in [
            json!({"kind":"invalid"}),
            json!({"kind":"archive","path":"/tmp/file"}),
            json!({"kind":"content","url":"https://one.example"}),
        ] {
            assert_eq!(
                call(&files, &ctx, "archive.input.pick", body).await,
                Err("invalid-body")
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_input_pending_cancellation_and_capacity_are_scoped() {
        let files = Transfers::default();
        let ctx = context();
        let mut pending = Vec::new();
        let mut selections = Vec::new();
        for _ in 0..4 {
            let (selection, selected) = oneshot::channel::<PathBuf>();
            let (done, rx) = completion();
            files
                .begin(
                    ctx.clone(),
                    "archive.input.pick".into(),
                    json!({}),
                    done,
                    move |ctx, id, rx, ready| {
                        Box::pin(archive_input_selected(ctx, id, rx, ready, async move {
                            selected.await.map_err(|_| "cancelled")
                        }))
                    },
                )
                .unwrap();
            pending.push(rx);
            selections.push(selection);
        }
        let (done, _) = completion();
        assert_eq!(
            files.begin(
                ctx.clone(),
                "archive.input.pick".into(),
                json!({}),
                done,
                |_, _, _, _| Box::pin(std::future::pending())
            ),
            Err("too-many-transfers")
        );
        let mut foreign = ctx.clone();
        foreign.session.user_id = "other-user".into();
        call(&files, &foreign, "archive.input.cancelPending", json!({}))
            .await
            .unwrap();
        assert_eq!(files.entries.lock().unwrap().len(), 4);
        call(&files, &ctx, "archive.input.cancelPending", json!({}))
            .await
            .unwrap();
        for rx in pending {
            assert_eq!(rx.await.unwrap(), Err("cancelled"));
        }
        until(|| selections.iter().all(oneshot::Sender::is_closed)).await;
        assert!(files.entries.lock().unwrap().is_empty());
    }
    fn archive_server(
        reply: Vec<u8>,
        delay: Duration,
    ) -> (String, std::thread::JoinHandle<()>, Arc<AtomicBool>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let accepted = Arc::new(AtomicBool::new(false));
        let observed = accepted.clone();
        let task = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let n = socket.read(&mut request).unwrap();
            assert!(std::str::from_utf8(&request[..n])
                .unwrap()
                .starts_with("GET /api/native/portability/export HTTP/1.1"));
            observed.store(true, Ordering::SeqCst);
            std::thread::sleep(delay);
            let _ = socket.write_all(&reply);
        });
        (origin, task, accepted)
    }
    #[cfg(not(target_os = "linux"))]
    #[tokio::test]
    async fn archive_export_operations_are_unavailable_off_linux() {
        let files = Transfers::default();
        let ctx = context();
        for op in [
            "archive.export.begin",
            "archive.export.read",
            "archive.export.cancelPending",
            "archive.input.pick",
            "archive.input.read",
            "archive.input.cancelPending",
            "archive.input.cancel",
        ] {
            let (done, mut rx) = completion();
            assert_eq!(
                files.dispatch(
                    ctx.clone(),
                    reqwest::Client::new(),
                    json!({"op": op, "body": {}}),
                    done,
                ),
                Err("unknown-op")
            );
            assert!(matches!(
                rx.try_recv(),
                Err(oneshot::error::TryRecvError::Closed)
            ));
        }
    }
    #[test]
    fn archive_bound_rejects_before_extending() {
        let mut bytes = vec![0; ARCHIVE_LIMIT];
        assert_eq!(append_archive(&mut bytes, &[1]), Err("archive-too-large"));
        assert_eq!(bytes.len(), ARCHIVE_LIMIT);
        assert!(append_archive(&mut bytes, &[]).is_ok());
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_export_chunks_exact_utf8_and_rejects_foreign_owner() {
        let raw = format!("{{\"text\":\"{}\"}}", "x".repeat(CHUNK) + "😀");
        let reply = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", raw.len(), raw).into_bytes();
        let (origin, server, _) = archive_server(reply, Duration::ZERO);
        let mut ctx = context();
        ctx.session.origin = origin;
        let files = Transfers::default();
        let begun = call(&files, &ctx, "archive.export.begin", json!({}))
            .await
            .unwrap();
        let id = begun["transferId"].as_str().unwrap();
        assert_eq!(begun["bytes"], raw.len());
        let mut foreign = ctx.clone();
        foreign.session.token = "replacement".into();
        assert_eq!(
            call(
                &files,
                &foreign,
                "archive.export.read",
                json!({"transferId":id,"seq":0})
            )
            .await,
            Err("invalid-transfer")
        );
        assert_eq!(
            call(&files, &ctx, "archive.export.begin", json!({})).await,
            Err("busy")
        );
        let mut actual = Vec::new();
        for seq in 0..4 {
            let next = call(
                &files,
                &ctx,
                "archive.export.read",
                json!({"transferId":id,"seq":seq}),
            )
            .await
            .unwrap();
            let chunk = STANDARD.decode(next["data"].as_str().unwrap()).unwrap();
            assert!(chunk.len() <= CHUNK);
            actual.extend(chunk);
            if next["eof"] == true {
                break;
            }
        }
        assert_eq!(actual, raw.as_bytes());
        server.join().unwrap();
        assert_eq!(
            call(
                &files,
                &ctx,
                "archive.export.begin",
                json!({"url":"https://other.example"})
            )
            .await,
            Err("invalid-body")
        );
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_export_rejects_oversize_invalid_utf8_and_redirect() {
        for (reply, error) in [
            (format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", ARCHIVE_LIMIT + 1).into_bytes(), Some("archive-too-large")),
            ([b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 1\r\n\r\n".as_slice(), &[255]].concat(), Some("invalid-response")),
            (b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/private\r\nContent-Length: 0\r\n\r\n".to_vec(), None),
        ] {
            let (origin, server, _) = archive_server(reply, Duration::ZERO);
            let mut ctx = context(); ctx.session.origin = origin;
            let files = Transfers::default();
            let (done, rx) = completion();
            files.dispatch(ctx, reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).build().unwrap(), json!({"op":"archive.export.begin","body":{}}), done).unwrap();
            let result = rx.await.unwrap();
            if let Some(error) = error { assert_eq!(result, Err(error)); } else { assert_eq!(result.unwrap()["status"], 302); }
            server.join().unwrap();
        }
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn archive_pending_cancel_is_owner_bound_and_retirement_releases_read() {
        for retire in [false, true] {
            use std::io::{Read, Write};
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let origin = format!("http://{}", listener.local_addr().unwrap());
            let (accepted, observed) = oneshot::channel();
            let (release, held) = std::sync::mpsc::channel();
            let server = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                let n = socket.read(&mut request).unwrap();
                assert!(std::str::from_utf8(&request[..n])
                    .unwrap()
                    .starts_with("GET /api/native/portability/export HTTP/1.1"));
                accepted.send(()).unwrap();
                let _ = held.recv();
                let _ = socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}");
            });
            let mut ctx = context();
            ctx.session.origin = origin;
            let files = Transfers::default();
            let (done, rx) = completion();
            files
                .dispatch(
                    ctx.clone(),
                    reqwest::Client::new(),
                    json!({"op":"archive.export.begin","body":{}}),
                    done,
                )
                .unwrap();
            tokio::time::timeout(Duration::from_secs(3), observed)
                .await
                .unwrap()
                .unwrap();
            let mut foreign = ctx.clone();
            foreign.session.token = "other".into();
            call(&files, &foreign, "archive.export.cancelPending", json!({}))
                .await
                .unwrap();
            assert_eq!(files.entries.lock().unwrap().len(), 1);
            if retire {
                files.cancel_all();
            } else {
                call(&files, &ctx, "archive.export.cancelPending", json!({}))
                    .await
                    .unwrap();
            }
            release.send(()).unwrap();
            assert_eq!(rx.await.unwrap(), Err("cancelled"));
            assert!(files.entries.lock().unwrap().is_empty());
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn stages_stream_two_integrity_passes_and_reject_foreign_scope_and_sequences() {
        let ctx = context();
        let root = std::env::temp_dir().join(format!("ditero-stage-test-{}", random()));
        let mut files = Transfers::default();
        files.set_root(root.clone());
        let bytes: Vec<u8> = (0..(CHUNK * 3 + 17)).map(|i| (i % 251) as u8).collect();
        let stage = call(&files, &ctx, "stage.begin", json!({"bytes":bytes.len()}))
            .await
            .unwrap();
        let id = stage["stageId"].as_str().unwrap();
        let path = root
            .join(format!("{:x}", Sha256::digest(ctx.session.scope())))
            .join(format!("stage-{id}"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        for (seq, b) in bytes.chunks(CHUNK).enumerate() {
            call(
                &files,
                &ctx,
                "stage.write",
                json!({"stageId":id,"seq":seq,"data":STANDARD.encode(b)}),
            )
            .await
            .unwrap();
        }
        let mut foreign = ctx.clone();
        foreign.session.origin = "https://two.example".into();
        assert_eq!(
            call(&files, &foreign, "stage.rewind", json!({"stageId":id})).await,
            Err("invalid-transfer")
        );
        for _ in 0..2 {
            call(&files, &ctx, "stage.rewind", json!({"stageId":id}))
                .await
                .unwrap();
            let mut output = Vec::new();
            let mut seq = 0;
            loop {
                let read = call(&files, &ctx, "stage.read", json!({"stageId":id,"seq":seq}))
                    .await
                    .unwrap();
                let b = STANDARD.decode(read["data"].as_str().unwrap()).unwrap();
                assert!(b.len() <= CHUNK);
                output.extend(b);
                seq += 1;
                if read["eof"] == true {
                    break;
                }
            }
            assert_eq!(output, bytes);
        }
        assert_eq!(
            call(&files, &ctx, "stage.rewind", json!({"stageId":id})).await,
            Err("invalid-transfer-operation")
        );
        until(|| !path.exists()).await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn retirement_and_explicit_cancel_remove_private_stages_and_release_capacity() {
        let ctx = context();
        let root = std::env::temp_dir().join(format!("ditero-stage-test-{}", random()));
        let mut files = Transfers::default();
        files.set_root(root.clone());
        let mut ids = Vec::new();
        for _ in 0..4 {
            ids.push(
                call(&files, &ctx, "stage.begin", json!({})).await.unwrap()["stageId"]
                    .as_str()
                    .unwrap()
                    .to_string(),
            );
        }
        assert_eq!(
            call(&files, &ctx, "stage.begin", json!({})).await,
            Err("too-many-transfers")
        );
        call(&files, &ctx, "stage.cancel", json!({"stageId":ids[0]}))
            .await
            .unwrap();
        assert_eq!(
            call(
                &files,
                &ctx,
                "stage.read",
                json!({"stageId":ids[0],"seq":0})
            )
            .await,
            Err("invalid-transfer")
        );
        call(&files, &ctx, "stage.begin", json!({})).await.unwrap();
        ctx.clock.store(2, Ordering::SeqCst);
        until(|| files.entries.lock().unwrap().is_empty()).await;
        let scoped = root.join(format!("{:x}", Sha256::digest(ctx.session.scope())));
        until(|| std::fs::read_dir(&scoped).unwrap().next().is_none()).await;
        assert_eq!(
            call(&files, &ctx, "stage.begin", json!({})).await,
            Err("cancelled")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn invalid_sequence_closes_stage_and_bounds_and_paths_fail_before_io() {
        let ctx = context();
        let root = std::env::temp_dir().join(format!("ditero-stage-test-{}", random()));
        let mut files = Transfers::default();
        files.set_root(root.clone());
        let stage = call(&files, &ctx, "stage.begin", json!({"bytes":1}))
            .await
            .unwrap();
        let id = stage["stageId"].as_str().unwrap();
        assert_eq!(
            call(
                &files,
                &ctx,
                "stage.write",
                json!({"stageId":id,"seq":1,"data":"AQ=="})
            )
            .await,
            Err("invalid-sequence")
        );
        until(|| files.entries.lock().unwrap().is_empty()).await;
        assert_eq!(
            call(
                &files,
                &ctx,
                "upload.begin",
                json!({"attachmentId":"../secret","thumbnail":false,"bytes":1})
            )
            .await,
            Err("invalid-id")
        );
        assert_eq!(
            call(&files, &ctx, "save.pick", json!({"filename":"/tmp/secret"})).await,
            Err("invalid-filename")
        );
        assert!(chunk(&json!({"data":STANDARD.encode(vec![0; CHUNK+1])})).is_err());
        assert!(chunk(&json!({"data":"AR=="})).is_err());
        assert_eq!(
            call(&files, &ctx, "stage.begin", json!({"bytes":STAGE_LIMIT+1})).await,
            Err("stage-too-large")
        );
        until(|| {
            std::fs::read_dir(root.join(format!("{:x}", Sha256::digest(ctx.session.scope()))))
                .unwrap()
                .next()
                .is_none()
        })
        .await;
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cancel_pending_picker_aborts_waiter_without_touching_other_scoped_work() {
        struct Dropped(Arc<std::sync::atomic::AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let ctx = context();
        let files = Transfers::default();
        let dropped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = dropped.clone();
        let (done, rx) = completion();
        files
            .begin(
                ctx.clone(),
                "save.pick".into(),
                json!({}),
                done,
                move |_, _, _, _| {
                    Box::pin(async move {
                        let _drop = Dropped(flag);
                        std::future::pending::<Result<Value>>().await
                    })
                },
            )
            .unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut foreign = ctx.clone();
        foreign.session.origin = "https://two.example".into();
        call(&files, &foreign, "save.cancelPending", json!({}))
            .await
            .unwrap();
        assert_eq!(files.entries.lock().unwrap().len(), 1);
        call(&files, &ctx, "save.cancelPending", json!({}))
            .await
            .unwrap();
        assert_eq!(rx.await.unwrap(), Err("cancelled"));
        until(|| dropped.load(Ordering::SeqCst)).await;
        assert!(files.entries.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn early_upload_refusals_preserve_native_and_gateway_status_and_body() {
        for raw in [r#"{"code":"unauthorized"}"#, r#"{"gateway":"unavailable"}"#] {
            let (tx, rx) = mpsc::channel(1);
            drop(rx);
            let expected = json!({"ok":false,"status":401,"body":raw});
            let response = expected.clone();
            let mut network = AbortTask(tauri::async_runtime::spawn(async move { Ok(response) }));
            assert_eq!(
                queue_chunk(&tx, &mut network, vec![1]).await,
                Ok(Some(expected))
            );
        }
    }
}
