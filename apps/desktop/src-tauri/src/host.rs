use crate::{
    attachments::{self, Transfers},
    protocol::{self, Result, MAX_BODY, MAX_SEND},
    vault::{self, Registry, Session, SystemVault, Vault},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{SinkExt, StreamExt};
use rand::{rngs::OsRng, RngCore};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::Channel, webview::NewWindowResponse, Manager, State, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest,
    http::HeaderValue,
    protocol::{frame::coding::CloseCode, CloseFrame, Message},
};

struct ProcessLock {
    _file: std::fs::File,
}
pub struct Host {
    tx: mpsc::Sender<Work>,
    clock: Arc<AtomicU64>,
    page: Arc<AtomicU64>,
    files: Transfers,
}
enum Work {
    Attach(Channel<String>, u64, oneshot::Sender<Result<u64>>),
    Post(String, u64),
    Drain(oneshot::Sender<()>),
    Ended(u64, u64),
    FileReply(attachments::Context, u64, Result<Value>),
}
struct Pending {
    grant: String,
    verifier: String,
}
struct Socket {
    is_open: Arc<AtomicBool>,
    tx: mpsc::Sender<Message>,
    task: tauri::async_runtime::JoinHandle<()>,
}
struct Actor {
    tx: mpsc::Sender<Work>,
    channel: Option<Channel<String>>,
    clock: Arc<AtomicU64>,
    gen: u64,
    ready: bool,
    page: u64,
    http: reqwest::Client,
    file_http: reqwest::Client,
    vault: Box<dyn Vault>,
    registry: Registry,
    origin: Option<String>,
    session: Option<Session>,
    handle: String,
    jwt: String,
    jwt_exp: u64,
    zero: Option<String>,
    pending: Option<Pending>,
    sockets: HashMap<u64, Socket>,
    files: Transfers,
    pages: Arc<AtomicU64>,
    #[cfg(test)]
    responses: std::collections::VecDeque<(u16, String, bool)>,
    #[cfg(test)]
    requests: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
}
fn random(n: usize) -> String {
    let mut bytes = vec![0; n];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn trusted(window: &WebviewWindow) -> Result<()> {
    let url = window.url().map_err(|_| "refused-window")?;
    if window.label() != "main" || !bundled(&url) {
        return Err("refused-window");
    }
    Ok(())
}
fn bundled(url: &url::Url) -> bool {
    url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost")))
}
#[tauri::command]
async fn native_attach(
    window: WebviewWindow,
    host: State<'_, Host>,
    channel: Channel<String>,
) -> Result<u64> {
    trusted(&window)?;
    let page = {
        let _guard = host.files.retirement();
        let page = host.page.fetch_add(1, Ordering::SeqCst) + 1;
        host.clock.fetch_add(1, Ordering::SeqCst);
        page
    };
    let (tx, rx) = oneshot::channel();
    host.tx
        .send(Work::Attach(channel, page, tx))
        .await
        .map_err(|_| "closed")?;
    rx.await.map_err(|_| "closed")?
}
#[tauri::command]
fn native_post(
    window: WebviewWindow,
    host: State<'_, Host>,
    message: String,
    page: u64,
) -> Result<()> {
    trusted(&window)?;
    if host.page.load(Ordering::SeqCst) != page {
        return Err("stale-page");
    }
    if message.len() > 2 * 1024 * 1024 {
        return Err("invalid-message");
    }
    host.tx
        .try_send(Work::Post(message, page))
        .map_err(|_| "busy")
}
#[tauri::command]
async fn native_drain(window: WebviewWindow, host: State<'_, Host>, page: u64) -> Result<()> {
    trusted(&window)?;
    if host.page.load(Ordering::SeqCst) != page {
        return Err("stale-page");
    }
    {
        let _guard = host.files.retirement();
        host.clock.fetch_add(1, Ordering::SeqCst);
    }
    let (tx, rx) = oneshot::channel();
    host.tx.send(Work::Drain(tx)).await.map_err(|_| "closed")?;
    rx.await.map_err(|_| "closed")
}
pub fn run() {
    let (tx, rx) = mpsc::channel(32);
    let http = reqwest::Client::builder()
        .tls_backend_native()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .referer(false)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(25))
        .build()
        .expect("native HTTPS client");
    let file_http = reqwest::Client::builder()
        .tls_backend_native()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .referer(false)
        .connect_timeout(Duration::from_secs(10))
        .read_timeout(Duration::from_secs(15))
        .build()
        .expect("native streaming HTTPS client");
    let clock = Arc::new(AtomicU64::new(0));
    let page = Arc::new(AtomicU64::new(0));
    let mut actor = Actor {
        tx: tx.clone(),
        channel: None,
        clock: clock.clone(),
        gen: 0,
        ready: false,
        page: 0,
        http,
        file_http,
        vault: Box::new(SystemVault),
        registry: Registry::default(),
        origin: None,
        session: None,
        handle: String::new(),
        jwt: String::new(),
        jwt_exp: 0,
        zero: None,
        pending: None,
        sockets: HashMap::new(),
        files: Transfers::default(),
        pages: page.clone(),
        #[cfg(test)]
        responses: Default::default(),
        #[cfg(test)]
        requests: Default::default(),
    };

    tauri::Builder::default()
        .manage(Host {
            tx,
            clock,
            page,
            files: actor.files.clone(),
        })
        .invoke_handler(tauri::generate_handler![
            native_attach,
            native_post,
            native_drain
        ])
        .setup(move |app| {
            actor
                .files
                .set_root(app.path().app_cache_dir()?.join("ciphertext-stages"));
            let data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data)?;
            let lock = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(data.join("native-session.lock"))?;
            lock.try_lock().map_err(std::io::Error::other)?;
            app.manage(ProcessLock { _file: lock });
            tauri::async_runtime::spawn(actor.run(rx));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Ditero")
                .inner_size(1100., 800.)
                .on_navigation(bundled)
                .on_new_window(|_, _| NewWindowResponse::Deny)
                .on_download(|_, _| false)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime");
}
impl Actor {
    async fn run(mut self, mut rx: mpsc::Receiver<Work>) {
        while let Some(work) = rx.recv().await {
            match work {
                Work::Attach(channel, page, ack) => {
                    self.drain();
                    self.page = page;
                    self.channel = Some(channel);
                    let result = self.vault.load().map(|r| {
                        self.registry = r;
                        page
                    });
                    let _ = ack.send(result);
                }
                Work::Drain(ack) => {
                    self.drain();
                    let _ = ack.send(());
                }
                Work::Ended(gen, cid) => {
                    if gen == self.gen {
                        self.sockets.remove(&cid);
                    }
                }
                Work::FileReply(context, rid, result) => self.file_reply(context, rid, result),
                Work::Post(raw, page) => {
                    if self.page != page || self.clock.load(Ordering::SeqCst) != self.gen {
                        continue;
                    }
                    let parsed = protocol::parse(&raw);
                    let rid = parsed
                        .as_ref()
                        .ok()
                        .and_then(|v| v.get("rid"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    if let Ok(v) = &parsed {
                        if v.get("op")
                            .and_then(Value::as_str)
                            .is_some_and(protocol::file_operation)
                        {
                            let result = self.file_post(v, raw.len(), rid);
                            if let Err(code) = result {
                                self.emit(json!({"t":"reply","rid":rid,"ok":false,"code":code}));
                            }
                            continue;
                        }
                    }
                    let cid = parsed.as_ref().ok().and_then(|v| v.get("cid")).cloned();
                    let outcome = match parsed {
                        Ok(v) => self.post(&v, raw.len()).await,
                        Err(e) => Err(e),
                    };
                    let mut reply = match outcome {
                        Ok(v) => v,
                        Err(code) => json!({"ok":false,"code":code}),
                    };
                    reply["t"] = json!("reply");
                    reply["rid"] = json!(rid);
                    if let Some(cid) = cid {
                        reply["cid"] = cid;
                    }
                    self.emit(reply);
                }
            }
        }
        self.drain();
    }
    fn emit(&self, v: Value) {
        if let Some(c) = &self.channel {
            let _ = c.send(v.to_string());
        }
    }
    fn advance(&mut self) {
        let _guard = self.files.retirement();
        self.gen = self.clock.fetch_add(1, Ordering::SeqCst) + 1;
    }
    fn drain(&mut self) {
        self.advance();
        self.files.cancel_all();
        for (_, s) in self.sockets.drain() {
            s.task.abort();
        }
        self.ready = false;
        self.pending = None;
        self.jwt.clear();
        self.jwt_exp = 0;
        self.handle.clear();
        self.session = None;
        self.zero = None;
    }
    fn drop_memory(&mut self) {
        self.files.cancel_all();
        for (cid, s) in self.sockets.drain() {
            s.task.abort();
            if let Some(c) = &self.channel {
                let _=c.send(json!({"t":"ws","gen":self.gen,"cid":cid,"e":"close","code":1006,"reason":"","clean":false}).to_string());
            }
        }
        self.session = None;
        self.handle.clear();
        self.jwt.clear();
        self.jwt_exp = 0;
    }
    fn snapshot(&self) -> Value {
        json!({"ok":true,"gen":self.gen,"server":self.origin.as_ref().map(|o|json!({"origin":o,"queryUrl":format!("{o}/api/zero/query"),"mutateUrl":format!("{o}/api/zero/mutate")})),"session":self.meta(),"exchanging":false,"revoking":false,"grantPending":self.pending.is_some()})
    }
    fn meta(&self) -> Value {
        self.session.as_ref().map(|s|json!({"scope":s.scope(),"userId":s.user_id,"deviceId":s.device_id,"authHandle":self.handle,"expiresAt":s.expires_at,"tokenReady":!self.jwt.is_empty(),"jwtExp":self.jwt_exp})).unwrap_or(Value::Null)
    }
    fn install(&mut self, s: Option<Session>) {
        self.drop_memory();
        self.session = s;
        self.handle = if self.session.is_some() {
            random(protocol::HANDLE_BYTES)
        } else {
            String::new()
        };
    }
    fn persist(&mut self, next: Registry) -> Result<()> {
        self.vault.save(&next)?;
        self.registry = next;
        Ok(())
    }
    async fn call_unfenced(
        &mut self,
        origin: &str,
        path: &str,
        post: bool,
        body: Option<&str>,
        token: Option<&str>,
    ) -> Result<(u16, String)> {
        #[cfg(test)]
        {
            let _ = (&self.http, post, body);
            self.requests.lock().unwrap().push((
                origin.into(),
                path.into(),
                token.map(str::to_owned),
            ));
            if let Some((status, body, retire)) = self.responses.pop_front() {
                if retire {
                    self.clock.fetch_add(1, Ordering::SeqCst);
                }
                return Ok((status, body));
            }
            panic!("unexpected native HTTP request");
        }
        #[cfg(not(test))]
        {
            let url = format!("{origin}{path}");
            let mut request = if post {
                self.http.post(&url)
            } else {
                self.http.get(&url)
            }
            .header("Accept", "application/json");
            if let Some(t) = token {
                request = request.bearer_auth(t);
            }
            if post {
                request = request
                    .header("Content-Type", "application/json")
                    .body(body.unwrap_or("{}").to_string());
            }
            let mut response = request.send().await.map_err(|_| "network")?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
                if bytes.len() + chunk.len() > MAX_BODY {
                    return Err("invalid-response");
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok((
                status,
                String::from_utf8(bytes).map_err(|_| "invalid-response")?,
            ))
        }
    }
    async fn call(
        &mut self,
        origin: &str,
        path: &str,
        post: bool,
        body: Option<&str>,
        token: Option<&str>,
    ) -> Result<(u16, String)> {
        let response = self.call_unfenced(origin, path, post, body, token).await?;
        self.current()?;
        Ok(response)
    }
    fn current(&self) -> Result<()> {
        if self.clock.load(Ordering::SeqCst) != self.gen {
            Err("cancelled")
        } else {
            Ok(())
        }
    }
    async fn authed(
        &mut self,
        path: &str,
        post: bool,
        body: Option<&str>,
        clear: bool,
    ) -> Result<(u16, String)> {
        let s = self.session.clone().ok_or("no-session")?;
        let result = self
            .call(&s.origin, path, post, body, Some(&s.token))
            .await?;
        if clear && unauthorized(result.0, &result.1) {
            let mut next = self.registry.clone();
            vault::remove_session(&mut next, &s);
            let _ = self.persist(next);
            self.drop_memory();
            return Err("unauthorized");
        }
        Ok(result)
    }
    fn file_reply(&mut self, context: attachments::Context, rid: u64, result: Result<Value>) {
        if context.gen != self.gen || context.page != self.page || self.current().is_err() {
            return;
        }
        if !self.session.as_ref().is_some_and(|s| {
            s.session_id == context.session.session_id
                && s.token == context.session.token
                && s.origin == context.session.origin
        }) {
            return;
        }
        let mut reply = match result {
            Ok(value) => value,
            Err(code) => json!({"ok":false,"code":code}),
        };
        if reply.get("status").and_then(Value::as_u64) == Some(401)
            && reply
                .get("body")
                .and_then(Value::as_str)
                .is_some_and(|body| unauthorized(401, body))
        {
            let mut next = self.registry.clone();
            vault::remove_session(&mut next, &context.session);
            let _ = self.persist(next);
            self.drop_memory();
        }
        reply["t"] = json!("reply");
        reply["rid"] = json!(rid);
        self.emit(reply);
    }
    fn file_post(&mut self, v: &Value, size: usize, rid: u64) -> Result<()> {
        let op = protocol::string(v, "op")?;
        if size
            > if protocol::file_chunk(op) {
                65536
            } else if op == "attachment.reserve" {
                2 * 1024 * 1024
            } else {
                8192
            }
            || !self.ready
            || v.get("gen").and_then(Value::as_u64) != Some(self.gen)
        {
            return Err("invalid-message");
        }
        let map = v.as_object().ok_or("invalid-message")?;
        if map
            .keys()
            .any(|key| !["op", "rid", "gen", "body"].contains(&key.as_str()))
        {
            return Err("invalid-message");
        }
        let context = attachments::Context::new(
            self.gen,
            self.page,
            self.session.clone().ok_or("no-session")?,
            self.clock.clone(),
            self.pages.clone(),
        );
        let captured = context.clone();
        let tx = self.tx.clone();
        self.files.dispatch(
            context,
            if matches!(
                protocol::string(v, "op")?,
                "upload.begin" | "download.begin"
            ) {
                self.file_http.clone()
            } else {
                self.http.clone()
            },
            v.clone(),
            Arc::new(move |result| {
                let tx = tx.clone();
                let context = captured.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = tx.send(Work::FileReply(context, rid, result)).await;
                });
            }),
        )
    }
    async fn post(&mut self, v: &Value, size: usize) -> Result<Value> {
        let map = v.as_object().ok_or("invalid-message")?;
        let op = protocol::string(v, "op")?;
        if map.keys().any(|k| {
            ![
                "op", "rid", "cid", "gen", "id", "body", "origin", "url", "protocol", "data",
                "code", "reason",
            ]
            .contains(&k.as_str())
        }) || !v
            .get("rid")
            .and_then(Value::as_u64)
            .is_some_and(|n| n > 0 && n <= 0x7fffffff)
        {
            return Err("invalid-message");
        }
        if size
            > if op == "ws.send" || op == "ws.open" {
                MAX_SEND + 8192
            } else if op.starts_with("e2e.") {
                MAX_BODY + 8192
            } else {
                8192
            }
        {
            return Err("invalid-message");
        }
        if op == "hello" {
            self.drain();
            self.origin = self.registry.selected.clone();
            self.install(
                self.origin
                    .as_ref()
                    .and_then(|o| self.registry.sessions.get(o))
                    .cloned(),
            );
            self.ready = true;
            return Ok(self.snapshot());
        }
        if !self.ready
            || (op != "state.read" && v.get("gen").and_then(Value::as_u64) != Some(self.gen))
        {
            return Err("stale-generation");
        }
        match op {
            "state.read" => Ok(self.snapshot()),
            "server.select" => {
                if !self.sockets.is_empty() {
                    return Err("busy");
                }
                let origin = protocol::origin(protocol::string(v, "origin")?)?;
                if self.origin.as_ref() != Some(&origin) {
                    let mut next = self.registry.clone();
                    next.selected = Some(origin.clone());
                    self.persist(next)?;
                    self.advance();
                    self.origin = Some(origin.clone());
                    self.pending = None;
                    self.zero = None;
                    self.install(self.registry.sessions.get(&origin).cloned());
                }
                Ok(self.snapshot())
            }
            "config.read" => {
                let origin = self.origin.clone().ok_or("no-server")?;
                let (status, raw) = self.call(&origin, "/api/config", false, None, None).await?;
                if status != 200 {
                    return Err("config-refused");
                }
                let config = protocol::parse(&raw)?;
                let zero = protocol::endpoint(protocol::string(&config, "zeroURL")?)?;
                self.zero = Some(zero.clone());
                Ok(
                    json!({"ok":true,"origin":origin,"zeroURL":zero,"queryUrl":format!("{origin}/api/zero/query"),"mutateUrl":format!("{origin}/api/zero/mutate")}),
                )
            }
            "grant" => {
                let origin = self.origin.clone().ok_or("no-server")?;
                let verifier = random(32);
                let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
                let body =
                    json!({"challenge":challenge,"deviceLabel":"Ditero desktop"}).to_string();
                let (status, raw) = self
                    .call(&origin, "/api/native/grants", true, Some(&body), None)
                    .await?;
                if status != 200 {
                    return Err("grant-refused");
                }
                let out = protocol::parse(&raw)?;
                let grant = protocol::string(&out, "grantId")?.to_string();
                let expires = protocol::string(&out, "expiresAt")?.to_string();
                if !protocol::canonical_id(&grant) || !vault::valid_expiry(&expires) {
                    return Err("invalid-response");
                }
                let authorize = format!("{origin}/native/authorize?grantId={grant}");
                self.pending = Some(Pending { grant, verifier });
                Ok(json!({"ok":true,"authorizeUrl":authorize,"expiresAt":expires}))
            }
            "browser" => {
                let p = self.pending.as_ref().ok_or("no-pending-grant")?;
                let origin = self.origin.as_ref().ok_or("no-server")?;
                open_browser(&format!("{origin}/native/authorize?grantId={}", p.grant))?;
                Ok(json!({"ok":true}))
            }
            "complete" => self.complete().await,
            "session.read" => {
                let (status, raw) = self
                    .authed("/api/native/session", false, None, true)
                    .await?;
                if status != 200 {
                    return Err("session-refused");
                }
                let out = protocol::parse(&raw)?;
                let s = self.session.as_ref().ok_or("no-session")?;
                verify_session(&out, s)?;
                let expiry = protocol::string(&out, "expiresAt")?;
                if !vault::valid_expiry(expiry) {
                    return Err("invalid-response");
                }
                Ok(
                    json!({"ok":true,"scope":s.scope(),"userId":s.user_id,"deviceId":s.device_id,"expiresAt":expiry}),
                )
            }
            "profile.read" => {
                let (status, raw) = self
                    .authed("/api/native/profile", false, None, true)
                    .await?;
                if status != 200 {
                    return Err("profile-refused");
                }
                let out = protocol::parse(&raw)?;
                let s = self.session.as_ref().ok_or("no-session")?;
                let name = protocol::string(&out, "name")?;
                let email = protocol::string(&out, "email")?;
                if protocol::string(&out, "id")? != s.user_id
                    || name.len() > 512
                    || email.len() > 512
                {
                    return Err("invalid-response");
                }
                Ok(json!({"ok":true,"id":s.user_id,"name":name,"email":email}))
            }
            "bootstrap.ensure" => {
                let (status, raw) = self
                    .authed("/api/native/bootstrap", true, None, true)
                    .await?;
                if status != 200 {
                    return Err("bootstrap-refused");
                }
                let out = protocol::parse(&raw)?;
                let workspace = protocol::string(&out, "workspaceId")?;
                if !protocol::id(workspace) {
                    return Err("invalid-response");
                }
                Ok(json!({"ok":true,"workspaceId":workspace}))
            }
            "refresh" => {
                let (status, raw) = self.authed("/api/native/token", false, None, true).await?;
                if status != 200 {
                    return Err("token-refused");
                }
                let out = protocol::parse(&raw)?;
                let token = protocol::string(&out, "token")?;
                let parts: Vec<_> = token.split('.').collect();
                if token.len() > 768
                    || parts.len() != 3
                    || parts.iter().any(|s| {
                        s.is_empty()
                            || !s
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
                    })
                {
                    return Err("jwt-rejected");
                }
                let claims = URL_SAFE_NO_PAD
                    .decode(parts[1])
                    .map_err(|_| "jwt-rejected")?;
                let claims =
                    protocol::parse(std::str::from_utf8(&claims).map_err(|_| "jwt-rejected")?)?;
                self.jwt_exp = claims
                    .get("exp")
                    .and_then(Value::as_u64)
                    .ok_or("jwt-rejected")?;
                self.jwt = token.to_string();
                Ok(json!({"ok":true,"refreshedAt":now(),"jwtExp":self.jwt_exp}))
            }
            "session.revoke" => self.revoke().await,
            "forget" => {
                let mut next = self.registry.clone();
                if let Some(s) = &self.session {
                    vault::remove_session(&mut next, s);
                }
                let result = self.persist(next);
                self.pending = None;
                self.drop_memory();
                result?;
                Ok(json!({"ok":true}))
            }
            "ws.open" => self.socket_open(v).await,
            "ws.send" => {
                let cid = v
                    .get("cid")
                    .and_then(Value::as_u64)
                    .ok_or("invalid-socket")?;
                let raw = protocol::string(v, "data")?;
                if raw.len() > MAX_SEND {
                    return Err("invalid-frame");
                }
                let origin = self.origin.as_ref().ok_or("no-server")?;
                let data = match protocol::filter_frame(raw, origin, &self.handle, &self.jwt) {
                    Ok(v) => v,
                    Err(e) => {
                        self.close_socket(cid);
                        return Err(e);
                    }
                };
                let socket = self.sockets.get(&cid).ok_or("invalid-socket")?;
                if !socket.is_open.load(Ordering::SeqCst) {
                    return Err("not-open");
                }
                if socket.tx.try_send(Message::Text(data.into())).is_err() {
                    self.close_socket(cid);
                    return Err("send-failed");
                }
                Ok(json!({"ok":true}))
            }
            "ws.close" => {
                let cid = v
                    .get("cid")
                    .and_then(Value::as_u64)
                    .ok_or("invalid-socket")?;
                let code = v.get("code").and_then(Value::as_u64).unwrap_or(1000);
                let reason = v.get("reason").and_then(Value::as_str).unwrap_or("");
                if !(code == 1000 || (3000..=4999).contains(&code)) || reason.len() > 123 {
                    return Err("invalid-close");
                }
                let socket = self.sockets.get(&cid).ok_or("invalid-socket")?;
                if !socket.is_open.load(Ordering::SeqCst) {
                    self.close_socket(cid);
                    return Ok(json!({"ok":true}));
                }
                if socket
                    .tx
                    .try_send(Message::Close(Some(CloseFrame {
                        code: CloseCode::from(code as u16),
                        reason: reason.to_string().into(),
                    })))
                    .is_err()
                {
                    self.close_socket(cid);
                    return Err("send-failed");
                }
                Ok(json!({"ok":true}))
            }
            op if op.starts_with("e2e.") => {
                let (post, path, body) = protocol::e2e(v)?;
                let (status, raw) = self.authed(&path, post, body.as_deref(), false).await?;
                let parsed = protocol::parse(&raw).is_ok();
                if (200..300).contains(&status) && !parsed {
                    return Err("invalid-response");
                }
                Ok(
                    json!({"ok":(200..300).contains(&status)&&parsed,"status":status,"body":if parsed{Some(raw)}else{None},"code":format!("http-{status}")}),
                )
            }
            _ => Err("unknown-op"),
        }
    }
    async fn complete(&mut self) -> Result<Value> {
        let origin = self.origin.clone().ok_or("no-server")?;
        let p = self.pending.as_ref().ok_or("no-pending-grant")?;
        let body = json!({"grantId":p.grant,"verifier":p.verifier}).to_string();
        // Exchange can mint a credential after the attached page retires. Read the
        // response before applying the generation fence so that credential can be revoked.
        let (status, raw) = self
            .call_unfenced(
                &origin,
                "/api/native/grants/exchange",
                true,
                Some(&body),
                None,
            )
            .await?;
        if status == 200 {
            self.pending = None;
        }
        if status == 409 {
            self.current()?;
            return Ok(json!({"ok":true,"state":"pending"}));
        }
        if status == 400 {
            self.pending = None;
        }
        if status != 200 {
            return Err("exchange-refused");
        }
        let out = protocol::parse(&raw)?;
        let token = protocol::string(&out, "token")?.to_owned();
        if !valid_token(&token) {
            return Err("invalid-response");
        }
        let result = self.install_exchange(&origin, &token, &out).await;
        if result.is_err() {
            // Captured origin/token cleanup must outlive UI retirement and must not
            // remove a previous account's credentials from the protected registry.
            let cleanup = self
                .call_unfenced(
                    &origin,
                    "/api/native/session/revoke",
                    true,
                    None,
                    Some(&token),
                )
                .await;
            if !cleanup.is_ok_and(|(status, raw)| revoke_accepted(status, &raw)) {
                return Err("cleanup-failed");
            }
        }
        result
    }
    async fn install_exchange(&mut self, origin: &str, token: &str, out: &Value) -> Result<Value> {
        self.current()?;
        let s = Session {
            origin: origin.into(),
            token: token.into(),
            session_id: protocol::string(out, "sessionId")?.into(),
            user_id: protocol::string(out, "userId")?.into(),
            device_id: protocol::string(out, "deviceId")?.into(),
            expires_at: protocol::string(out, "expiresAt")?.into(),
        };
        if !s.valid() {
            return Err("invalid-response");
        }
        let (status, raw) = self
            .call(origin, "/api/native/session", false, None, Some(token))
            .await?;
        if status != 200 {
            return Err("verify-failed");
        }
        verify_session(&protocol::parse(&raw)?, &s)?;
        self.current()?;
        let mut next = self.registry.clone();
        next.sessions.insert(origin.into(), s.clone());
        self.vault.save(&next)?;
        if let Err(error) = self.current() {
            self.vault.save(&self.registry)?;
            return Err(error);
        }
        self.registry = next;
        self.install(Some(s));
        Ok(json!({"ok":true,"state":"signed-in","session":self.meta()}))
    }
    async fn revoke(&mut self) -> Result<Value> {
        self.files.cancel_all();
        let s = self.session.clone().ok_or("no-session")?;
        let (status, raw) = self
            .call(
                &s.origin,
                "/api/native/session/revoke",
                true,
                None,
                Some(&s.token),
            )
            .await?;
        let unusable = unauthorized(status, &raw);
        let revoked = status == 200
            && protocol::parse(&raw).is_ok_and(|v| v.get("revoked") == Some(&Value::Bool(true)));
        if !unusable && !revoked {
            return Err("revoke-refused");
        }
        let mut next = self.registry.clone();
        vault::remove_session(&mut next, &s);
        let result = self.persist(next);
        self.drop_memory();
        if result.is_err() {
            return Ok(
                json!({"ok":false,"code":"storage-failed","remoteRevoked":revoked,"alreadyUnusable":unusable}),
            );
        }
        Ok(json!({"ok":true,"remoteRevoked":revoked,"alreadyUnusable":unusable}))
    }
    fn close_socket(&mut self, cid: u64) {
        if let Some(s) = self.sockets.remove(&cid) {
            s.task.abort();
            self.emit(json!({"t":"ws","gen":self.gen,"cid":cid,"e":"close","code":1006,"reason":"","clean":false}));
        }
    }
    async fn socket_open(&mut self, v: &Value) -> Result<Value> {
        let cid = v
            .get("cid")
            .and_then(Value::as_u64)
            .filter(|n| *n > 0 && *n <= 0x7fffffff)
            .ok_or("invalid-socket")?;
        if self.sockets.len() >= 4 || self.sockets.contains_key(&cid) {
            return Err("invalid-socket");
        }
        if self.session.is_none() || self.jwt.is_empty() {
            return Err("no-token");
        }
        let target = protocol::socket_target(
            protocol::string(v, "url")?,
            self.zero.as_ref().ok_or("no-config")?,
        )?;
        let protocol = protocol::splice_protocol(
            protocol::string(v, "protocol")?,
            self.origin.as_ref().ok_or("no-server")?,
            &self.handle,
            &self.jwt,
        )?;
        let mut request = target.into_client_request().map_err(|_| "invalid-url")?;
        request.headers_mut().insert(
            "Sec-WebSocket-Protocol",
            HeaderValue::from_str(&protocol).map_err(|_| "invalid-protocol")?,
        );
        let (channel, gen, clock, owner) = (
            self.channel.clone().ok_or("closed")?,
            self.gen,
            self.clock.clone(),
            self.tx.clone(),
        );
        let (tx, mut rx) = mpsc::channel::<Message>(16);
        let is_open = Arc::new(AtomicBool::new(false));
        let open_flag = is_open.clone();
        let task = tauri::async_runtime::spawn(async move {
            let emit = |kind: &str, fields: Value| {
                if clock.load(Ordering::SeqCst) == gen {
                    let mut event = json!({"t":"ws","gen":gen,"cid":cid,"e":kind});
                    for (k, v) in fields.as_object().unwrap() {
                        event[k] = v.clone();
                    }
                    let _ = channel.send(event.to_string());
                }
            };
            let config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig::default()
                .max_message_size(Some(MAX_SEND))
                .max_frame_size(Some(MAX_SEND));
            let opened = tokio::time::timeout(
                Duration::from_secs(20),
                tokio_tungstenite::connect_async_with_config(request, Some(config), false),
            )
            .await;
            let mut clean = false;
            let mut code = 1006;
            if let Ok(Ok((mut socket, _))) = opened {
                open_flag.store(true, Ordering::SeqCst);
                emit("open", json!({}));
                loop {
                    tokio::select! {
                     outbound=rx.recv()=>{match outbound{Some(message)=>{
                        let closing = matches!(message, Message::Close(_));
                        if bounded_write(socket.send(message), Duration::from_secs(5)).await.is_err(){break;}
                        if closing {
                            let terminal = tokio::time::timeout(Duration::from_secs(5), async {
                                while let Some(frame) = socket.next().await {
                                    match frame {
                                        Ok(Message::Close(frame)) => return Some(frame.map(|f| u16::from(f.code)).unwrap_or(1000)),
                                        Err(_) => return None,
                                        _ => {},
                                    }
                                }
                                None
                            }).await;
                            if let Ok(Some(close_code)) = terminal { clean = true; code = close_code; }
                            break;
                        }
                    },None=>break}},
                     inbound=socket.next()=>{match inbound{Some(Ok(Message::Text(text)))=>emit("message",json!({"data":text.as_str()})),Some(Ok(Message::Close(frame)))=>{if bounded_write(socket.close(None), Duration::from_secs(5)).await.is_ok(){clean=true;code=frame.map(|f|u16::from(f.code)).unwrap_or(1000);}break;},Some(Ok(Message::Binary(_)))=>{let _=bounded_write(socket.close(Some(CloseFrame{code:CloseCode::Unsupported,reason:"text only".into()})), Duration::from_secs(5)).await;break;},Some(Ok(_))=>{},_=>break}}
                    }
                }
            }
            if !clean {
                emit("error", json!({"kind":"network"}));
            }
            emit("close", json!({"code":code,"reason":"","clean":clean}));
            let _ = owner.send(Work::Ended(gen, cid)).await;
        });
        self.sockets.insert(cid, Socket { tx, task, is_open });
        Ok(json!({"ok":true}))
    }
}
async fn bounded_write<E>(
    write: impl std::future::Future<Output = std::result::Result<(), E>>,
    budget: Duration,
) -> std::result::Result<(), ()> {
    tokio::time::timeout(budget, write)
        .await
        .map_err(|_| ())?
        .map_err(|_| ())
}
fn unauthorized(status: u16, raw: &str) -> bool {
    status == 401
        && protocol::parse(raw).is_ok_and(|v| {
            v.as_object().is_some_and(|m| {
                m.len() == 1 && m.get("code").and_then(Value::as_str) == Some("unauthorized")
            })
        })
}
fn revoke_accepted(status: u16, raw: &str) -> bool {
    unauthorized(status, raw)
        || (status == 200
            && protocol::parse(raw).is_ok_and(|v| v.get("revoked") == Some(&Value::Bool(true))))
}
fn valid_token(token: &str) -> bool {
    !token.is_empty()
        && token.len() <= 512
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
}
fn verify_session(v: &Value, s: &Session) -> Result<()> {
    if protocol::string(v, "userId")? != s.user_id
        || protocol::string(v, "sessionId")? != s.session_id
        || protocol::string(v, "deviceId")? != s.device_id
    {
        return Err("verify-failed");
    }
    Ok(())
}
fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    let mut command = std::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    command
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "no-browser")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct TestVault {
        value: Mutex<Registry>,
        reject: bool,
    }
    impl Vault for TestVault {
        fn load(&self) -> Result<Registry> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn save(&self, registry: &Registry) -> Result<()> {
            if self.reject {
                return Err("storage-failed");
            }
            *self.value.lock().unwrap() = registry.clone();
            Ok(())
        }
    }
    fn actor(reject: bool) -> Actor {
        let (tx, _) = mpsc::channel(32);
        Actor {
            tx,
            channel: None,
            clock: Arc::new(AtomicU64::new(1)),
            gen: 1,
            ready: true,
            page: 1,
            http: reqwest::Client::new(),
            file_http: reqwest::Client::new(),
            vault: Box::new(TestVault {
                value: Mutex::new(Registry::default()),
                reject,
            }),
            registry: Registry::default(),
            origin: None,
            session: None,
            handle: String::new(),
            jwt: String::new(),
            jwt_exp: 0,
            zero: None,
            pending: None,
            sockets: HashMap::new(),
            files: Transfers::default(),
            pages: Arc::new(AtomicU64::new(1)),
            #[cfg(test)]
            responses: Default::default(),
            #[cfg(test)]
            requests: Default::default(),
        }
    }
    #[tokio::test]
    async fn stalled_socket_writes_and_close_flushes_terminate_within_the_budget() {
        use std::{
            pin::Pin,
            task::{Context, Poll},
        };
        struct Stalled;
        impl futures_util::Sink<Message> for Stalled {
            type Error = ();
            fn poll_ready(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<std::result::Result<(), ()>> {
                Poll::Ready(Ok(()))
            }
            fn start_send(self: Pin<&mut Self>, _: Message) -> std::result::Result<(), ()> {
                Ok(())
            }
            fn poll_flush(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<std::result::Result<(), ()>> {
                Poll::Pending
            }
            fn poll_close(
                self: Pin<&mut Self>,
                _: &mut Context<'_>,
            ) -> Poll<std::result::Result<(), ()>> {
                Poll::Pending
            }
        }
        let mut socket = Stalled;
        for message in [Message::Text("payload".into()), Message::Close(None)] {
            assert_eq!(
                bounded_write(socket.send(message), Duration::from_millis(10)).await,
                Err(())
            );
        }
        assert_eq!(
            bounded_write(socket.close(), Duration::from_millis(10)).await,
            Err(())
        );
    }
    fn session() -> Session {
        Session {
            origin: "https://a.example".into(),
            token: "previous-token".into(),
            session_id: "previous-session".into(),
            user_id: "u1".into(),
            device_id: "d1".into(),
            expires_at: "2026-12-01T00:00:00Z".into(),
        }
    }
    #[tokio::test]
    async fn unknown_401_keeps_authority_but_exact_native_unauthorized_retires_it() {
        for raw in [
            "<html>proxy refused</html>",
            r#"{"code":"unauthorized","extra":true}"#,
            r#"{"code":"other"}"#,
        ] {
            let mut host = actor(false);
            let s = session();
            host.registry.sessions.insert(s.origin.clone(), s.clone());
            host.install(Some(s));
            host.responses.push_back((401, raw.into(), false));
            assert_eq!(
                host.authed("/api/native/session", false, None, true).await,
                Ok((401, raw.into()))
            );
            assert!(host.session.is_some());
            assert_eq!(host.registry.sessions.len(), 1);
            host.responses.push_back((401, raw.into(), false));
            assert_eq!(host.revoke().await, Err("revoke-refused"));
            assert!(host.session.is_some());
        }
        let mut host = actor(false);
        let s = session();
        host.registry.sessions.insert(s.origin.clone(), s.clone());
        host.install(Some(s));
        host.responses
            .push_back((401, r#"{"code":"unauthorized"}"#.into(), false));
        assert_eq!(
            host.authed("/api/native/session", false, None, true).await,
            Err("unauthorized")
        );
        assert!(host.session.is_none());
        assert!(host.registry.sessions.is_empty());
    }
    #[tokio::test]
    async fn minted_credentials_are_revoked_after_retirement_verification_or_storage_failure() {
        for failure in ["retired", "verification", "storage", "metadata"] {
            let mut host = actor(failure == "storage");
            let old = session();
            host.origin = Some(old.origin.clone());
            host.registry
                .sessions
                .insert(old.origin.clone(), old.clone());
            host.install(Some(old.clone()));
            host.pending = Some(Pending {
                grant: "grant".into(),
                verifier: "verifier".into(),
            });
            let mut minted = json!({"token":"minted-token","sessionId":"new-session","userId":"u2","deviceId":"d2","expiresAt":"2026-12-01T00:00:00Z"});
            if failure == "metadata" {
                minted.as_object_mut().unwrap().remove("userId");
            }
            host.responses
                .push_back((200, minted.to_string(), failure == "retired"));
            if failure == "verification" || failure == "storage" {
                host.responses.push_back((200, json!({"sessionId":"new-session","userId":if failure == "verification" {"wrong"} else {"u2"},"deviceId":"d2"}).to_string(), false));
            }
            host.responses
                .push_back((200, r#"{"revoked":true}"#.into(), false));
            assert!(host.complete().await.is_err());
            assert_eq!(host.registry.sessions[&old.origin].token, old.token);
            assert_eq!(host.session.as_ref().unwrap().token, old.token);
            assert!(host.pending.is_none());
            let requests = host.requests.lock().unwrap();
            assert_eq!(
                requests.last().unwrap(),
                &(
                    old.origin.clone(),
                    "/api/native/session/revoke".into(),
                    Some("minted-token".into())
                )
            );
            assert!(host.responses.is_empty());
        }
    }
    #[tokio::test]
    async fn storage_failure_preserves_selected_account_and_credentials_never_enter_snapshot() {
        let mut host = actor(true);
        let session = Session {
            origin: "https://a.example".into(),
            token: "native-only-bearer".into(),
            session_id: "s1".into(),
            user_id: "u1".into(),
            device_id: "d1".into(),
            expires_at: "2026-12-01T00:00:00Z".into(),
        };
        host.origin = Some(session.origin.clone());
        host.install(Some(session));
        host.jwt = "native-only-jwt".into();
        host.pending = Some(Pending {
            grant: "grant".into(),
            verifier: "native-only-verifier".into(),
        });
        let snapshot = host.snapshot().to_string();
        for secret in [
            "native-only-bearer",
            "native-only-jwt",
            "native-only-verifier",
        ] {
            assert!(!snapshot.contains(secret));
        }
        let result = host
            .post(
                &json!({"op":"server.select","rid":1,"gen":1,"origin":"https://b.example"}),
                100,
            )
            .await;
        assert_eq!(result, Err("storage-failed"));
        assert_eq!(host.origin.as_deref(), Some("https://a.example"));
        assert_eq!(host.session.as_ref().unwrap().user_id, "u1");
    }
    #[tokio::test]
    async fn old_generations_and_unknown_network_operations_are_refused() {
        let mut host = actor(false);
        assert_eq!(
            host.post(
                &json!({"op":"server.select","rid":1,"gen":0,"origin":"https://b.example"}),
                100
            )
            .await,
            Err("stale-generation")
        );
        assert_eq!(
            host.post(
                &json!({"op":"fetch","rid":2,"gen":1,"url":"https://b.example"}),
                100
            )
            .await,
            Err("unknown-op")
        );
        host.advance();
        assert_eq!(
            host.post(&json!({"op":"profile.read","rid":3,"gen":1}), 100)
                .await,
            Err("stale-generation")
        );
        for raw in [
            "https://example.com",
            "http://localhost",
            "tauri://evil/index.html",
            "tauri://localhost@evil/",
        ] {
            assert!(!bundled(&url::Url::parse(raw).unwrap()));
        }
        assert!(bundled(
            &url::Url::parse("tauri://localhost/index.html").unwrap()
        ));
    }
    #[tokio::test]
    async fn refused_native_send_terminates_the_socket_instead_of_stranding_server_switch() {
        let mut host = actor(false);
        host.origin = Some("https://a.example".into());
        host.handle = "handle".into();
        host.jwt = "native-jwt".into();
        let (tx, _rx) = mpsc::channel(1);
        tx.try_send(Message::Text("queued".into())).unwrap();
        let task = tauri::async_runtime::spawn(std::future::pending());
        host.sockets.insert(
            1,
            Socket {
                tx,
                task,
                is_open: Arc::new(AtomicBool::new(true)),
            },
        );
        let result = host
            .post(
                &json!({"op":"ws.send","rid":1,"gen":1,"cid":1,"data":"[\"ping\",{}]"}),
                100,
            )
            .await;
        assert_eq!(result, Err("send-failed"));
        assert!(host.sockets.is_empty());
    }
    #[tokio::test]
    async fn file_refusals_retire_only_the_exact_current_native_session() {
        let mut host = actor(false);
        let original = session();
        host.registry
            .sessions
            .insert(original.origin.clone(), original.clone());
        host.install(Some(original.clone()));
        let captured = attachments::Context::new(
            host.gen,
            host.page,
            original.clone(),
            host.clock.clone(),
            host.pages.clone(),
        );
        host.file_reply(
            captured.clone(),
            1,
            Ok(json!({"ok":false,"status":401,"body":r#"{"code":"unauthorized","gateway":true}"#})),
        );
        assert!(host.session.is_some());
        assert_eq!(host.registry.sessions.len(), 1);
        let mut stale = captured.clone();
        stale.page += 1;
        host.file_reply(
            stale,
            2,
            Ok(json!({"ok":false,"status":401,"body":r#"{"code":"unauthorized"}"#})),
        );
        assert!(host.session.is_some());
        host.file_reply(
            captured,
            3,
            Ok(json!({"ok":false,"status":401,"body":r#"{"code":"unauthorized"}"#})),
        );
        assert!(host.session.is_none());
        assert!(host.registry.sessions.is_empty());
    }
}
