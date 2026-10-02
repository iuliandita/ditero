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
        match op.as_str() {
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
            "save.cancelPending" => {
                exact(&body, &[])?;
                let mut entries = self.entries.lock().unwrap();
                let ids: Vec<_> = entries
                    .iter()
                    .filter(|(_, cap)| {
                        cap.kind == "save.pick" && !cap.ready && cap.context.matches(&context)
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
            "attachment.cancel" | "stage.cancel" | "save.cancel" => {
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
                if !cap.context.matches(&context) {
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
            "upload.write" | "upload.finish" | "download.read" | "stage.write" | "stage.read"
            | "stage.rewind" | "save.write" | "save.finish" => {
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
                if !cap.context.matches(&context) {
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
