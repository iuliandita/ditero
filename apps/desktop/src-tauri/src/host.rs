use crate::{
    attachments::{self, Transfers},
    deep_links::{self, TaskLink},
    notifications::{self, Event as NotificationEvent},
    offline::{self, Evidence},
    protocol::{self, Result, MAX_BODY, MAX_SEND},
    request_fence::Fences,
    vault::{self, DesktopRegistration, Registry, Session, SystemVault, Vault},
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
    link_epoch: Arc<AtomicU64>,
    links_verified: Arc<AtomicBool>,
}
enum Work {
    Attach(Channel<String>, u64, oneshot::Sender<Result<u64>>),
    Post(String, u64),
    Drain(oneshot::Sender<()>),
    Ended(u64, u64),
    FileReply(attachments::Context, u64, Result<Value>),
    Notification(NotificationEvent),
    NotificationCleaned(DesktopRegistration),
    TaskLink(Option<TaskLink>, u64, u64, u64),
}
struct ColdLink {
    link: TaskLink,
    session: Session,
    page: u64,
    awaiting_hello: bool,
}
struct TaskLinkOpen {
    session: Session,
    gen: u64,
    page: u64,
    handle: String,
    token: String,
    task_id: Option<String>,
}
struct NotificationTap {
    owner: notifications::Owner,
    notification: String,
    token: String,
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
    fences: Arc<Fences>,
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
    push: Option<notifications::Receiver>,
    push_tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
    push_state: &'static str,
    verified: bool,
    tap: Option<NotificationTap>,
    startup_link: Option<TaskLink>,
    cold_link: Option<ColdLink>,
    task_link: Option<TaskLinkOpen>,
    link_refused: bool,
    attached: bool,
    link_epoch: Arc<AtomicU64>,
    links_verified: Arc<AtomicBool>,
    app: Option<tauri::AppHandle>,
    #[cfg(test)]
    responses: std::collections::VecDeque<(u16, String, bool)>,
    #[cfg(test)]
    requests: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
    #[cfg(test)]
    push_supported: bool,
}
fn capture_link_ingress(epoch: &AtomicU64, verified: &AtomicBool) -> Option<u64> {
    let captured = epoch.load(Ordering::SeqCst);
    verified.load(Ordering::SeqCst).then_some(captured)
}
fn retire_link_ingress(epoch: &AtomicU64, verified: &AtomicBool, between: impl FnOnce()) {
    verified.store(false, Ordering::SeqCst);
    between();
    epoch.fetch_add(1, Ordering::SeqCst);
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
    let link_epoch = Arc::new(AtomicU64::new(0));
    let links_verified = Arc::new(AtomicBool::new(false));
    #[cfg(target_os = "linux")]
    let startup = deep_links::arguments(std::env::args());
    #[cfg(not(target_os = "linux"))]
    let startup: Result<Option<TaskLink>> = Ok(None);
    let link_refused = startup.is_err();
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
        fences: Fences::new(vault::native_store),
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
        push: None,
        push_tasks: Vec::new(),
        push_state: "disabled",
        verified: false,
        tap: None,
        startup_link: startup.ok().flatten(),
        cold_link: None,
        task_link: None,
        link_refused,
        attached: false,
        link_epoch: link_epoch.clone(),
        links_verified: links_verified.clone(),
        app: None,
        #[cfg(test)]
        responses: Default::default(),
        #[cfg(test)]
        requests: Default::default(),
        #[cfg(test)]
        push_supported: true,
    };

    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        let request = match deep_links::arguments(args) {
            Ok(None) => return,
            Ok(Some(link)) => Some(link),
            Err(_) => None,
        };
        let host = app.state::<Host>();
        let Some(epoch) = capture_link_ingress(&host.link_epoch, &host.links_verified) else {
            return;
        };
        let gen = host.clock.load(Ordering::SeqCst);
        let page = host.page.load(Ordering::SeqCst);
        if host
            .tx
            .try_send(Work::TaskLink(request, gen, page, epoch))
            .is_err()
        {
            eprintln!("Desktop link refused: busy");
        }
    }));
    builder
        .manage(Host {
            tx,
            clock,
            page,
            files: actor.files.clone(),
            link_epoch,
            links_verified,
        })
        .invoke_handler(tauri::generate_handler![
            native_attach,
            native_post,
            native_drain
        ])
        .setup(move |app| {
            actor.app = Some(app.handle().clone());
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
            #[cfg(all(debug_assertions, target_os = "macos"))]
            crate::journeys::start(app.handle().clone())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("desktop runtime");
}
impl Actor {
    fn attach(&mut self, channel: Channel<String>, page: u64) -> Result<u64> {
        let startup = if !self.attached {
            self.startup_link.take()
        } else {
            None
        };
        let refused = !self.attached && self.link_refused;
        self.attached = true;
        self.drain();
        self.page = page;
        self.channel = Some(channel);
        self.vault.load().map(|r| {
            self.registry = r;
            self.link_refused = refused;
            if let Some(link) = startup {
                self.capture_cold_link(link);
            }
            page
        })
    }
    async fn run(mut self, mut rx: mpsc::Receiver<Work>) {
        while let Some(work) = rx.recv().await {
            match work {
                Work::Attach(channel, page, ack) => {
                    let result = self.attach(channel, page);
                    let _ = ack.send(result);
                }
                Work::Drain(ack) => {
                    self.drain();
                    if !notifications::drain(
                        std::mem::take(&mut self.push_tasks),
                        Duration::from_secs(3),
                    )
                    .await
                    {
                        eprintln!("notification withdrawal unconfirmed");
                    }
                    let _ = ack.send(());
                }
                Work::TaskLink(link, gen, page, epoch) => {
                    self.receive_task_link(link, gen, page, epoch)
                }
                Work::Notification(event) => self.notification_event(event),
                Work::NotificationCleaned(registration) => self.notification_cleaned(&registration),
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
        self.clear_task_links();
        self.stop_notifications();
        self.verified = false;
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
        self.clear_task_links();
        self.stop_notifications();
        self.verified = false;
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
        json!({"ok":true,"gen":self.gen,"server":self.origin.as_ref().map(|o|json!({"origin":o,"queryUrl":format!("{o}/api/zero/query"),"mutateUrl":format!("{o}/api/zero/mutate")})),"session":self.meta(),"exchanging":false,"revoking":false,"grantPending":self.pending.is_some(),"archiveExport":cfg!(target_os = "linux"),"archiveInput":cfg!(target_os = "linux"),"archiveMigration":cfg!(target_os = "linux"),"taskLinks":cfg!(target_os = "linux"),"linkRefused":self.link_refused})
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
    fn stop_notifications(&mut self) {
        if let Some(receiver) = self.push.take() {
            receiver.owner.cancel();
            self.push_tasks.push(receiver.task);
        }
        self.tap = None;
    }
    fn clear_task_links(&mut self) {
        retire_link_ingress(&self.link_epoch, &self.links_verified, || {});
        self.startup_link = None;
        self.cold_link = None;
        self.task_link = None;
        self.link_refused = false;
    }
    fn capture_cold_link(&mut self, link: TaskLink) {
        let session = self
            .registry
            .selected
            .as_ref()
            .and_then(|origin| self.registry.sessions.get(origin))
            .filter(|session| session.origin == link.origin)
            .cloned();
        if let Some(session) = session {
            self.cold_link = Some(ColdLink {
                link,
                session,
                page: self.page,
                awaiting_hello: true,
            });
        } else {
            self.link_refused = true;
        }
    }
    fn bind_cold_link(&mut self) {
        let Some(cold) = self.cold_link.take() else {
            return;
        };
        if self.verified
            && cold.page == self.page
            && self
                .session
                .as_ref()
                .is_some_and(|session| vault::same_session(session, &cold.session))
        {
            self.receive_task_link(
                Some(cold.link),
                self.gen,
                self.page,
                self.link_epoch.load(Ordering::SeqCst),
            );
        } else {
            self.link_refused = true;
        }
    }
    fn task_link_current(&self, link: &TaskLinkOpen) -> bool {
        self.verified
            && self.ready
            && self.gen == link.gen
            && self.page == link.page
            && self.current().is_ok()
            && self.pages.load(Ordering::SeqCst) == link.page
            && self.handle == link.handle
            && self
                .session
                .as_ref()
                .is_some_and(|session| vault::same_session(session, &link.session))
            && self.origin.as_ref() == Some(&link.session.origin)
            && self.registry.selected.as_ref() == Some(&link.session.origin)
    }
    fn receive_task_link(&mut self, link: Option<TaskLink>, gen: u64, page: u64, epoch: u64) {
        if epoch != self.link_epoch.load(Ordering::SeqCst)
            || gen != self.gen
            || page != self.page
            || !self.links_verified.load(Ordering::SeqCst)
            || !self.verified
            || !self.ready
            || self.current().is_err()
            || self.pages.load(Ordering::SeqCst) != page
        {
            return;
        }
        let Some(session) = self.session.clone() else {
            return;
        };
        if self
            .task_link
            .as_ref()
            .is_some_and(|pending| self.task_link_current(pending))
        {
            self.emit(json!({"t":"link.open","gen":self.gen}));
            eprintln!("Desktop link refused: busy");
            return;
        }
        let task_id = link
            .filter(|link| link.origin == session.origin)
            .map(|link| link.task_id);
        let pending = TaskLinkOpen {
            session,
            gen,
            page,
            handle: self.handle.clone(),
            token: random(24),
            task_id,
        };
        if !self.task_link_current(&pending) {
            return;
        }
        self.task_link = Some(pending);
        self.emit(json!({"t":"link.open","gen":self.gen}));
        if let Some(window) = self
            .task_link
            .as_ref()
            .filter(|link| link.task_id.is_some())
            .and(self.app.as_ref())
            .as_ref()
            .and_then(|app| app.get_webview_window("main"))
        {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
    fn link_post(&mut self, v: &Value) -> Result<Value> {
        let op = protocol::string(v, "op")?;
        let fields: &[&str] = if op == "link.dismiss" {
            &["op", "rid", "gen", "id", "body"]
        } else {
            &["op", "rid", "gen", "id"]
        };
        if !notifications::exact(v, fields) {
            return Err("invalid-message");
        }
        if !self.verified || self.session.is_none() {
            return Err("no-session");
        }
        if protocol::string(v, "id")? != self.handle {
            return Err("invalid-message");
        }
        if self.current().is_err() || self.pages.load(Ordering::SeqCst) != self.page {
            return Err("cancelled");
        }
        if self
            .task_link
            .as_ref()
            .is_some_and(|link| !self.task_link_current(link))
        {
            self.task_link = None;
        }
        if op == "link.read" {
            return Ok(
                json!({"ok":true,"open":self.task_link.as_ref().map(|link| json!({"token":link.token,"taskId":link.task_id}))}),
            );
        }
        if op == "link.retire" {
            self.clear_task_links();
            return Ok(json!({"ok":true}));
        }
        if !notifications::exact(&v["body"], &["token"]) {
            return Err("invalid-message");
        }
        let token = protocol::string(&v["body"], "token")?;
        if self
            .task_link
            .as_ref()
            .is_some_and(|link| link.token == token)
        {
            self.task_link = None;
        }
        Ok(json!({"ok":true}))
    }
    fn notification_current(&self, owner: &notifications::Owner) -> bool {
        self.verified
            && self
                .session
                .as_ref()
                .is_some_and(|s| owner.matches(s, &self.handle, self.gen, self.page))
            && self
                .registry
                .notifications
                .get(&owner.registration.session.origin)
                .is_some_and(|r| {
                    r.registration_id == owner.registration.registration_id
                        && vault::same_session(&r.session, &owner.registration.session)
                })
    }
    fn retire_finished_receiver(&mut self) -> bool {
        if self
            .push
            .as_ref()
            .is_some_and(|r| r.finished.load(Ordering::SeqCst))
        {
            self.stop_notifications();
            true
        } else {
            false
        }
    }
    fn start_notifications(&mut self) {
        if !self.verified || self.push.is_some() {
            return;
        }
        let Some(session) = &self.session else {
            return;
        };
        let Some(registration) = self
            .registry
            .notifications
            .get(&session.origin)
            .filter(|r| vault::same_session(&r.session, session))
            .cloned()
        else {
            self.push_state = if self.registry.retired_notifications.is_empty() {
                "disabled"
            } else {
                "cleanup-pending"
            };
            return;
        };
        let owner = notifications::Owner {
            locale: Arc::new(std::sync::RwLock::new(registration.locale.clone())),
            registration,
            gen: self.gen,
            page: self.page,
            handle: self.handle.clone(),
            clock: self.clock.clone(),
            pages: self.pages.clone(),
            retired: Arc::new(AtomicBool::new(false)),
            wake: Arc::new(tokio::sync::Notify::new()),
        };
        let (events, mut receive) = mpsc::channel(32);
        let tx = self.tx.clone();
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receive.recv().await {
                if tx.try_send(Work::Notification(event)).is_err() {
                    break;
                }
            }
        });
        self.push = Some(notifications::start(
            owner,
            self.http.clone(),
            events,
            self.fences.clone(),
        ));
        self.push_state = "active";
    }
    fn cleanup_notifications(&mut self) {
        for registration in self.registry.retired_notifications.clone() {
            let http = self.http.clone();
            let tx = self.tx.clone();
            let fences = self.fences.clone();
            tauri::async_runtime::spawn(async move {
                let result = notifications::request(
                    &fences,
                    &http,
                    &registration.session,
                    "unregister",
                    Some(json!({"registrationId":registration.registration_id})),
                )
                .await;
                if result.is_ok_and(|(status, v)| notifications::cleanup_terminal(status, &v)) {
                    let _ = tx.try_send(Work::NotificationCleaned(registration));
                }
            });
        }
    }
    fn notification_cleaned(&mut self, registration: &DesktopRegistration) {
        let mut next = self.registry.clone();
        let previous = next.retired_notifications.len();
        next.retired_notifications.retain(|r| {
            r.registration_id != registration.registration_id
                || !vault::same_session(&r.session, &registration.session)
        });
        if previous == next.retired_notifications.len() {
            return;
        }
        if self.persist(next).is_err() {
            self.push_state = "storage-failed";
            return;
        }
        if self.push_state == "cleanup-pending" && self.registry.retired_notifications.is_empty() {
            self.push_state = if self.session.is_none() || !self.verified {
                "no-session"
            } else if self.session.as_ref().is_some_and(|s| {
                self.registry
                    .notifications
                    .get(&s.origin)
                    .is_some_and(|r| vault::same_session(&r.session, s))
            }) {
                "active"
            } else {
                "disabled"
            };
        }
    }
    fn update_notification_locale(&mut self, locale: &str) -> Result<()> {
        let Some(session) = &self.session else {
            return Ok(());
        };
        let Some(record) = self
            .registry
            .notifications
            .get(&session.origin)
            .filter(|r| vault::same_session(&r.session, session))
        else {
            return Ok(());
        };
        if record.locale == locale {
            return Ok(());
        }
        let mut next = self.registry.clone();
        next.notifications.get_mut(&session.origin).unwrap().locale = locale.into();
        self.persist(next)?;
        if let Some(receiver) = &self.push {
            *receiver
                .owner
                .locale
                .write()
                .map_err(|_| "storage-failed")? = locale.into();
        }
        Ok(())
    }
    async fn notification_supported(&self) -> bool {
        #[cfg(test)]
        {
            self.push_supported
        }
        #[cfg(not(test))]
        {
            notifications::supported().await
        }
    }
    fn retire_in(next: &mut Registry, session: &Session) -> Result<()> {
        if next
            .notifications
            .get(&session.origin)
            .is_some_and(|r| vault::same_session(&r.session, session))
        {
            if next.retired_notifications.len() >= 64 {
                return Err("storage-failed");
            }
            let r = next.notifications.remove(&session.origin).unwrap();
            next.retired_notifications.push(r);
        }
        Ok(())
    }
    fn notification_event(&mut self, event: NotificationEvent) {
        match event {
            NotificationEvent::Accepted(owner, notification, reply) => {
                let mut accepted = false;
                if self.notification_current(&owner) {
                    let mut next = self.registry.clone();
                    let r = next
                        .notifications
                        .get_mut(&owner.registration.session.origin)
                        .unwrap();
                    if r.receipts.len() < 128 && !r.seen.contains(&notification) {
                        while r.seen.len() >= 256 {
                            if let Some(i) = r.seen.iter().position(|id| !r.receipts.contains(id)) {
                                r.seen.remove(i);
                            } else {
                                break;
                            }
                        }
                        r.seen.push(notification.clone());
                        r.receipts.push(notification);
                        accepted = self.persist(next).is_ok();
                    }
                    if !accepted {
                        self.push_state = "storage-failed";
                        self.stop_notifications();
                    }
                }
                let _ = reply.send(accepted);
            }
            NotificationEvent::Received(owner, notification) => {
                if !self.notification_current(&owner) {
                    return;
                }
                let mut next = self.registry.clone();
                next.notifications
                    .get_mut(&owner.registration.session.origin)
                    .unwrap()
                    .receipts
                    .retain(|id| id != &notification);
                if self.persist(next).is_err() {
                    self.push_state = "storage-failed";
                    self.stop_notifications();
                }
            }
            NotificationEvent::Action(owner, notification) => {
                if !self.notification_current(&owner)
                    || !self.registry.notifications[&owner.registration.session.origin]
                        .seen
                        .contains(&notification)
                {
                    return;
                }
                self.tap = Some(NotificationTap {
                    owner: owner.clone(),
                    notification,
                    token: random(24),
                });
                self.emit(json!({"t":"push.open","gen":self.gen}));
                if let Some(app) = &self.app {
                    let app = app.clone();
                    let main = app.clone();
                    let (tx, rx) = oneshot::channel();
                    if app
                        .run_on_main_thread(move || {
                            let result = if owner.current() {
                                main.get_webview_window("main")
                                    .ok_or("closed")
                                    .and_then(|window| {
                                        window.show().map_err(|_| "focus-failed")?;
                                        window.unminimize().map_err(|_| "focus-failed")?;
                                        window.set_focus().map_err(|_| "focus-failed")
                                    })
                            } else {
                                Err("cancelled")
                            };
                            let _ = tx.send(result);
                        })
                        .is_ok()
                    {
                        self.push_tasks
                            .push(tauri::async_runtime::spawn(async move {
                                let _ = tokio::time::timeout(Duration::from_secs(3), rx).await;
                            }));
                    }
                }
            }
            NotificationEvent::State(owner, state) => {
                if self.notification_current(&owner) {
                    self.push_state = state;
                }
            }
            NotificationEvent::Stopped(owner, state) => {
                if self
                    .push
                    .as_ref()
                    .is_some_and(|r| Arc::ptr_eq(&r.owner.retired, &owner.retired))
                    && self.verified
                    && self
                        .session
                        .as_ref()
                        .is_some_and(|s| vault::same_session(s, &owner.registration.session))
                    && owner.handle == self.handle
                    && owner.gen == self.gen
                    && owner.page == self.page
                    && self.current().is_ok()
                    && self.pages.load(Ordering::SeqCst) == self.page
                {
                    self.push_state = state;
                    self.tap = None;
                }
            }
            NotificationEvent::Unauthorized(owner) => {
                if !self.notification_current(&owner) {
                    return;
                }
                self.refuse_session(&owner.registration.session);
                self.push_state = "no-session";
                self.emit(json!({"t":"session-refused","gen":self.gen,"authHandle":owner.handle}));
            }
        }
    }
    fn push_reply(&self) -> Value {
        json!({"ok":true,"state":self.push_state,"permission":if matches!(self.push_state,"unsupported"|"denied"|"no-session") {"denied"} else {"granted"},"provider":"desktop"})
    }
    async fn push_post(&mut self, v: &Value) -> Result<Value> {
        let op = protocol::string(v, "op")?;
        let fields: &[&str] = if op == "push.dismissOpen" {
            &["op", "rid", "gen", "id", "body"]
        } else if v.get("locale").is_some()
            && matches!(op, "push.state" | "push.enable" | "push.permission")
        {
            &["op", "rid", "gen", "id", "locale"]
        } else {
            &["op", "rid", "gen", "id"]
        };
        if !notifications::exact(v, fields) {
            return Err("invalid-message");
        }
        let locale = match v.get("locale") {
            Some(value) => value.as_str().ok_or("invalid-message")?,
            None => "en",
        };
        if !["en", "de", "es", "fr", "ro", "ar"].contains(&locale) {
            return Err("invalid-message");
        }
        if self.session.is_none() || !self.verified {
            if matches!(op, "push.state" | "push.permission" | "push.enable") {
                self.push_state = "no-session";
                return Ok(self.push_reply());
            }
            return Err("no-session");
        }
        if protocol::string(v, "id")? != self.handle {
            return Err("invalid-message");
        }
        if op == "push.open" {
            let Some(tap) = &self.tap else {
                return Ok(json!({"ok":true,"open":null}));
            };
            if !self.notification_current(&tap.owner) {
                self.tap = None;
                return Ok(json!({"ok":true,"open":null}));
            }
            let token = tap.token.clone();
            let owner = tap.owner.clone();
            let body = json!({"notificationId":tap.notification,"registrationId":tap.owner.registration.registration_id}).to_string();
            let (status, raw) = self
                .authed("/api/native/push/open", true, Some(&body), true)
                .await?;
            if !self.notification_current(&owner)
                || !self.tap.as_ref().is_some_and(|t| t.token == token)
            {
                return Err("cancelled");
            }
            if status == 404 {
                self.tap = None;
                return Err("notification-unavailable");
            }
            if status != 200 {
                return Err("network");
            }
            let out = protocol::parse(&raw)?;
            if !notifications::exact(&out, &["target"]) {
                return Err("invalid-response");
            }
            return Ok(
                json!({"ok":true,"open":{"token":token,"target":notifications::target(&out["target"])?}}),
            );
        }
        if op == "push.dismissOpen" {
            if !notifications::exact(&v["body"], &["token"]) {
                return Err("invalid-message");
            }
            let token = protocol::string(&v["body"], "token")?;
            if self.tap.as_ref().is_some_and(|t| t.token == token) {
                self.tap = None;
            }
            return Ok(json!({"ok":true}));
        }
        if op == "push.disable" {
            let session = self.session.clone().unwrap();
            let verified = self.verified;
            self.stop_notifications();
            self.verified = verified;
            let mut next = self.registry.clone();
            Self::retire_in(&mut next, &session)?;
            if self.persist(next).is_err() {
                self.push_state = "storage-failed";
                return Ok(self.push_reply());
            }
            self.push_state = if self.registry.retired_notifications.is_empty() {
                "disabled"
            } else {
                "cleanup-pending"
            };
            self.cleanup_notifications();
            return Ok(self.push_reply());
        }
        if !matches!(op, "push.state" | "push.enable" | "push.permission") {
            return Err("unknown-op");
        }
        if v.get("locale").is_some() && self.update_notification_locale(locale).is_err() {
            self.push_state = "storage-failed";
            return Ok(self.push_reply());
        }
        if !self.notification_supported().await {
            self.stop_notifications();
            self.push_state = "unsupported";
            return Ok(self.push_reply());
        }
        self.current()?;
        if self.push_state == "unsupported" {
            self.stop_notifications();
        }
        self.retire_finished_receiver();
        self.start_notifications();
        if op != "push.enable" {
            return Ok(self.push_reply());
        }
        let session = self.session.clone().unwrap();
        if self
            .registry
            .notifications
            .get(&session.origin)
            .is_some_and(|r| vault::same_session(&r.session, &session))
        {
            self.start_notifications();
            return Ok(self.push_reply());
        }
        self.push_state = "enabling";
        let (status, raw) = self
            .authed("/api/native/push/desktop/config", false, None, true)
            .await?;
        let config = protocol::parse(&raw)?;
        if status != 200
            || !notifications::exact(&config, &["deliveryReady"])
            || config["deliveryReady"] != true
        {
            self.push_state = "server-unavailable";
            return Ok(self.push_reply());
        }
        let (status, raw) = self
            .authed("/api/native/push/desktop/register", true, Some("{}"), true)
            .await?;
        let out = protocol::parse(&raw)?;
        if status != 200
            || !notifications::exact(&out, &["registrationId", "provider"])
            || out["provider"] != "desktop"
            || !out["registrationId"].as_str().is_some_and(protocol::id)
        {
            self.push_state = "registration-failed";
            return Ok(self.push_reply());
        }
        let registration = DesktopRegistration {
            session: session.clone(),
            registration_id: out["registrationId"].as_str().unwrap().to_owned(),
            seen: Vec::new(),
            receipts: Vec::new(),
            locale: locale.into(),
        };
        let mut next = self.registry.clone();
        next.notifications
            .insert(session.origin, registration.clone());
        if self.persist(next).is_err() {
            self.push_state = "storage-failed";
            let http = self.http.clone();
            let fences = self.fences.clone();
            self.push_tasks
                .push(tauri::async_runtime::spawn(async move {
                    let _ = notifications::request(
                        &fences,
                        &http,
                        &registration.session,
                        "unregister",
                        Some(json!({"registrationId":registration.registration_id})),
                    )
                    .await;
                }));
            return Ok(self.push_reply());
        }
        self.start_notifications();
        self.cleanup_notifications();
        Ok(self.push_reply())
    }
    async fn call_unfenced(
        &mut self,
        origin: &str,
        path: &str,
        post: bool,
        body: Option<&str>,
        token: Option<&str>,
    ) -> Result<(u16, String)> {
        let guard = self
            .registry
            .sessions
            .get(origin)
            .filter(|s| Some(s.token.as_str()) == token)
            .map(|s| self.fences.begin(s))
            .transpose()?;
        let response = self.call_transport(origin, path, post, body, token).await;
        if let Some(guard) = guard {
            guard.complete(match &response {
                Ok((status, _)) => !matches!(status, 401 | 403),
                Err(code) => *code == "network",
            })?;
        }
        response
    }
    async fn call_transport(
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
                return match status {
                    0 => Err("network"),
                    1 => Err("transport-refused"),
                    2 => Err("invalid-response"),
                    _ => Ok((status, body)),
                };
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
            let mut response = request
                .send()
                .await
                .map_err(|e| offline::transport_error(&e))?;
            let status = response.status().as_u16();
            let mut bytes = Vec::new();
            while let Some(chunk) = response.chunk().await.map_err(|_| "invalid-response")? {
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
            self.refuse_session(&s);
            return Err("unauthorized");
        }
        Ok(result)
    }
    fn refuse_session(&mut self, session: &Session) {
        let _ = self.fences.refuse(session);
        let mut next = self.registry.clone();
        if let Some(proof) = next.evidence.get_mut(&session.origin) {
            proof.pending = true;
        }
        let _ = self.persist(next.clone());
        let _ = Self::retire_in(&mut next, session);
        vault::remove_session(&mut next, session);
        let _ = self.persist(next);
        self.drop_memory();
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
            self.refuse_session(&context.session);
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
            } else if matches!(
                op,
                "archive.migration.reserve" | "archive.migration.recover"
            ) {
                protocol::MIGRATION_BODY + 4096
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
        let mut context = attachments::Context::new(
            self.gen,
            self.page,
            self.session.clone().ok_or("no-session")?,
            self.clock.clone(),
            self.pages.clone(),
        );
        context.fences = Some(self.fences.clone());
        let captured = context.clone();
        let tx = self.tx.clone();
        self.files.dispatch(
            context,
            if matches!(
                protocol::string(v, "op")?,
                "upload.begin"
                    | "download.begin"
                    | "archive.export.begin"
                    | "archive.migration.upload.begin"
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
    fn settings_url(&self, v: &Value) -> Result<String> {
        self.current()?;
        let fields = v.as_object().ok_or("invalid-message")?;
        let body = v
            .get("body")
            .and_then(Value::as_object)
            .ok_or("invalid-message")?;
        if fields
            .keys()
            .any(|key| !["op", "rid", "gen", "id", "body"].contains(&key.as_str()))
            || body.len() != 1
        {
            return Err("invalid-message");
        }
        let session = self.session.as_ref().ok_or("no-session")?;
        if !self.verified
            || self.origin.as_ref() != Some(&session.origin)
            || protocol::string(v, "id")? != self.handle
        {
            return Err("stale-generation");
        }
        let section = protocol::string(&v["body"], "section")?;
        if !matches!(
            section,
            "notifications" | "security" | "access-tokens" | "calendar-feeds" | "data" | "danger"
        ) {
            return Err("invalid-settings");
        }
        if protocol::origin(&session.origin).as_ref() != Ok(&session.origin) {
            return Err("invalid-origin");
        }
        Ok(format!("{}/settings/{section}", session.origin))
    }
    async fn post(&mut self, v: &Value, size: usize) -> Result<Value> {
        let map = v.as_object().ok_or("invalid-message")?;
        let op = protocol::string(v, "op")?;
        if map.keys().any(|k| {
            ![
                "op", "rid", "cid", "gen", "id", "body", "origin", "url", "protocol", "data",
                "code", "reason", "locale",
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
            // Only the first hello may carry a cold intent through initial restoration.
            let cold = self
                .cold_link
                .take()
                .filter(|cold| cold.awaiting_hello && cold.page == self.page);
            let refused = self.link_refused;
            self.drain();
            self.origin = self.registry.selected.clone();
            self.install(
                self.origin
                    .as_ref()
                    .and_then(|o| self.registry.sessions.get(o))
                    .cloned(),
            );
            self.cold_link = cold.map(|mut cold| {
                cold.awaiting_hello = false;
                cold
            });
            self.link_refused = refused;
            self.ready = true;
            return Ok(self.snapshot());
        }
        if !self.ready
            || (op != "state.read" && v.get("gen").and_then(Value::as_u64) != Some(self.gen))
        {
            return Err("stale-generation");
        }
        match op {
            op if op.starts_with("push.") => self.push_post(v).await,
            "link.read" | "link.dismiss" | "link.retire" if cfg!(target_os = "linux") => {
                self.link_post(v)
            }
            "state.read" => Ok(self.snapshot()),
            "server.select" => {
                self.clear_task_links();
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
                self.links_verified.store(self.verified, Ordering::SeqCst);
                Ok(self.snapshot())
            }
            "config.read" => self.config_read().await,
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
                open_browser(&format!("{origin}/native/authorize?grantId={}", p.grant)).await?;
                Ok(json!({"ok":true}))
            }
            "settings.open" => {
                let url = self.settings_url(v)?;
                open_browser(&url).await?;
                Ok(json!({"ok":true}))
            }
            "complete" => self.complete().await,
            "session.read" | "profile.read" | "bootstrap.ensure" | "refresh" => {
                self.session_post(op).await
            }
            "session.revoke" => self.revoke().await,
            "forget" => {
                let mut next = self.registry.clone();
                if let Some(s) = &self.session {
                    Self::retire_in(&mut next, s)?;
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
    async fn config_read(&mut self) -> Result<Value> {
        let origin = self.origin.clone().ok_or("no-server")?;
        let captured = self.session.clone();
        let cached = captured.as_ref().and_then(|s| self.evidence(s));
        let was_pending = captured
            .as_ref()
            .and_then(|s| self.registry.evidence.get(&s.origin))
            .is_some_and(|p| p.pending);
        if let Some(s) = &captured {
            let mut next = self.registry.clone();
            let proof = next
                .evidence
                .entry(s.origin.clone())
                .or_insert_with(|| Evidence::new(s.clone()));
            proof.pending = true;
            self.persist(next)?;
            self.current()?;
        }
        let response = self.call(&origin, "/api/config", false, None, None).await;
        self.current()?;
        let zero = match response {
            Err("network")
                if cached.as_ref().is_some_and(|p| {
                    captured.as_ref().is_some_and(|s| {
                        self.owned(s) && p.ready(s, now()) && self.fences.allowed(s)
                    })
                }) =>
            {
                cached.as_ref().unwrap().zero.clone().unwrap()
            }
            Err(error) => return Err(error),
            Ok((status, raw)) => {
                if status != 200 {
                    return Err("config-refused");
                }
                protocol::endpoint(protocol::string(&protocol::parse(&raw)?, "zeroURL")?)?
            }
        };
        if let Some(s) = &captured {
            if !self.owned(s) {
                return Err("cancelled");
            }
            let mut next = self.registry.clone();
            let proof = next.evidence.get_mut(&s.origin).ok_or("no-session")?;
            proof.zero = Some(zero.clone());
            proof.pending = was_pending;
            self.persist(next)?;
            self.current()?;
        }
        self.zero = Some(zero.clone());
        Ok(
            json!({"ok":true,"origin":origin,"zeroURL":zero,"queryUrl":format!("{origin}/api/zero/query"),"mutateUrl":format!("{origin}/api/zero/mutate")}),
        )
    }
    fn evidence(&self, session: &Session) -> Option<Evidence> {
        self.registry
            .evidence
            .get(&session.origin)
            .filter(|proof| proof.ready(session, now()) && self.fences.allowed(session))
            .cloned()
    }
    fn owned(&self, captured: &Session) -> bool {
        self.current().is_ok()
            && self.origin.as_ref() == Some(&captured.origin)
            && self
                .session
                .as_ref()
                .is_some_and(|s| vault::same_session(s, captured))
    }
    async fn session_post(&mut self, op: &str) -> Result<Value> {
        let captured = self.session.clone().ok_or("no-session")?;
        let cached = self.evidence(&captured);
        let mut next = self.registry.clone();
        let proof = next
            .evidence
            .entry(captured.origin.clone())
            .or_insert_with(|| Evidence::new(captured.clone()));
        if !vault::same_session(&proof.session, &captured) {
            *proof = Evidence::new(captured.clone());
        }
        // Commit before I/O. Refusal, interruption, or failed cleanup must not
        // resurrect the previously verified record on the next cold launch.
        let was_pending = proof.pending;
        proof.pending = true;
        self.persist(next)?;
        self.current()?;
        let revision = self.fences.revision(&captured)?;
        let result = self.session_online(op).await;
        if !self.owned(&captured) {
            return if matches!(result, Err("unauthorized")) {
                Err("unauthorized")
            } else {
                Err("cancelled")
            };
        }
        let reply = match result {
            Ok(reply) => reply,
            Err("network")
                if cached.as_ref().is_some_and(|p| {
                    p.ready(&captured, now()) && self.fences.allowed(&captured)
                }) =>
            {
                let proof = cached.unwrap();
                let mut next = self.registry.clone();
                next.evidence.insert(captured.origin.clone(), proof.clone());
                self.persist(next)?;
                self.current()?;
                if op == "session.read" {
                    self.verified = true;
                    self.links_verified.store(true, Ordering::SeqCst);
                    self.bind_cold_link();
                }
                return match op {
                    "session.read" => Ok(
                        json!({"ok":true,"scope":captured.scope(),"userId":captured.user_id,"deviceId":captured.device_id,"expiresAt":captured.expires_at}),
                    ),
                    "profile.read" => Ok(
                        json!({"ok":true,"id":captured.user_id,"name":proof.name,"email":proof.email}),
                    ),
                    "bootstrap.ensure" => Ok(json!({"ok":true,"workspaceId":proof.workspace})),
                    "refresh" => Err("offline-ready"),
                    _ => Err("unknown-op"),
                };
            }
            Err(error) => {
                self.verified = false;
                self.links_verified.store(false, Ordering::SeqCst);
                return Err(error);
            }
        };
        let mut next = self.registry.clone();
        let proof = next
            .evidence
            .get_mut(&captured.origin)
            .ok_or("no-session")?;
        match op {
            "session.read" => {
                let expiry = protocol::string(&reply, "expiresAt")?.to_owned();
                proof.session.expires_at = expiry.clone();
                proof.verified = true;
                next.sessions
                    .get_mut(&captured.origin)
                    .ok_or("no-session")?
                    .expires_at = expiry;
            }
            "profile.read" => {
                proof.name = Some(protocol::string(&reply, "name")?.into());
                proof.email = Some(protocol::string(&reply, "email")?.into());
            }
            "bootstrap.ensure" => {
                proof.workspace = Some(protocol::string(&reply, "workspaceId")?.into())
            }
            _ => {}
        }
        // Only a fresh session verification can recover invalid/interrupted evidence.
        proof.pending = op != "session.read" && was_pending;
        let expiry = proof.session.expires_at.clone();
        self.persist(next)?;
        self.current()?;
        if op == "session.read" {
            self.fences.verified(&captured, revision)?;
            self.session.as_mut().ok_or("no-session")?.expires_at = expiry;
            self.verified = true;
            self.links_verified.store(true, Ordering::SeqCst);
            self.bind_cold_link();
            self.start_notifications();
            self.cleanup_notifications();
        }
        Ok(reply)
    }
    async fn session_online(&mut self, op: &str) -> Result<Value> {
        match op {
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
                if !offline::unexpired(expiry, now()) {
                    return Err("invalid-response");
                }
                let reply = json!({"ok":true,"scope":s.scope(),"userId":s.user_id,"deviceId":s.device_id,"expiresAt":expiry});
                Ok(reply)
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
                let expiry = claims
                    .get("exp")
                    .and_then(Value::as_u64)
                    .filter(|expiry| *expiry > now() / 1000)
                    .ok_or("jwt-rejected")?;
                self.jwt_exp = expiry;
                self.jwt = token.to_string();
                Ok(json!({"ok":true,"refreshedAt":now(),"jwtExp":self.jwt_exp}))
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
        if let Some(old) = next.sessions.get(origin).cloned() {
            if !vault::same_session(&old, &s) {
                Self::retire_in(&mut next, &old)?;
            }
        }
        next.evidence.remove(origin);
        next.sessions.insert(origin.into(), s.clone());
        self.vault.save(&next)?;
        if let Err(error) = self.current() {
            self.vault.save(&self.registry)?;
            return Err(error);
        }
        self.registry = next;
        self.install(Some(s));
        self.verified = true;
        self.links_verified.store(true, Ordering::SeqCst);
        self.start_notifications();
        self.cleanup_notifications();
        Ok(json!({"ok":true,"state":"signed-in","session":self.meta()}))
    }
    async fn revoke(&mut self) -> Result<Value> {
        self.clear_task_links();
        self.stop_notifications();
        self.files.cancel_all();
        let s = self.session.clone().ok_or("no-session")?;
        let mut next = self.registry.clone();
        if let Some(proof) = next.evidence.get_mut(&s.origin) {
            proof.pending = true;
        }
        self.persist(next)?;
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
        Self::retire_in(&mut next, &s)?;
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
        if self.session.is_none() {
            return Err("no-session");
        }
        let target = protocol::socket_target(
            protocol::string(v, "url")?,
            self.zero.as_ref().ok_or("no-config")?,
        )?;
        protocol::splice_protocol(
            protocol::string(v, "protocol")?,
            self.origin.as_ref().ok_or("no-server")?,
            &self.handle,
            &self.handle,
        )?;
        if self.jwt.is_empty() || self.jwt_exp <= now() / 1000 {
            match self.session_post("refresh").await {
                Err("offline-ready") => return Err("network"),
                result => {
                    result?;
                }
            }
        }
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
        let guard = self
            .fences
            .begin(self.session.as_ref().ok_or("no-session")?)?;
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
            let safe = match &opened {
                Ok(Ok(_)) | Err(_) => true,
                Ok(Err(tokio_tungstenite::tungstenite::Error::Http(response))) => {
                    !matches!(response.status().as_u16(), 401 | 403)
                }
                Ok(Err(tokio_tungstenite::tungstenite::Error::Io(_))) => true,
                _ => false,
            };
            if guard.complete(safe).is_err() {
                emit("error", json!({"kind":"storage-failed"}));
                emit("close", json!({"code":1006,"reason":"","clean":false}));
                let _ = owner.send(Work::Ended(gen, cid)).await;
                return;
            }
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
async fn open_browser(url: &str) -> Result<()> {
    #[cfg(target_os = "linux")]
    let mut command = tokio::process::Command::new("xdg-open");
    #[cfg(target_os = "macos")]
    let mut command = tokio::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = tokio::process::Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    command.arg(url);
    launch_browser(&mut command, Duration::from_secs(5)).await
}
async fn launch_browser(command: &mut tokio::process::Command, budget: Duration) -> Result<()> {
    let mut child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "no-browser")?;
    match tokio::time::timeout(budget, child.wait()).await {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(_) => Err("no-browser"),
        // Some launchers stay alive until the browser closes. Leave them running.
        Err(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_launcher_checks_exit_status() {
        for (script, expected) in [("exit 3", Err("no-browser")), ("exit 0", Ok(()))] {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", script]);
            assert_eq!(
                launch_browser(&mut command, Duration::from_secs(5)).await,
                expected,
                "{script}"
            );
        }
    }

    #[tokio::test]
    async fn browser_launcher_spawn_failure_is_retryable() {
        let mut command = tokio::process::Command::new("");
        assert_eq!(
            launch_browser(&mut command, Duration::from_secs(5)).await,
            Err("no-browser")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn browser_launcher_still_running_after_budget_counts_as_success() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exec sleep 2"]);
        assert_eq!(
            tokio::time::timeout(
                Duration::from_secs(1),
                launch_browser(&mut command, Duration::from_millis(20)),
            )
            .await,
            Ok(Ok(()))
        );
    }
    struct TestVault {
        value: Mutex<Registry>,
        reject: bool,
        remaining_writes: Mutex<u64>,
    }
    impl Vault for TestVault {
        fn load(&self) -> Result<Registry> {
            Ok(self.value.lock().unwrap().clone())
        }
        fn save(&self, registry: &Registry) -> Result<()> {
            let mut remaining = self.remaining_writes.lock().unwrap();
            if self.reject || *remaining == 0 {
                return Err("storage-failed");
            }
            *remaining -= 1;
            *self.value.lock().unwrap() = registry.clone();
            Ok(())
        }
    }
    #[tokio::test]
    async fn archive_input_capability_is_linux_only() {
        assert_eq!(
            actor(false).snapshot()["archiveInput"],
            cfg!(target_os = "linux")
        );
    }
    #[tokio::test]
    async fn archive_migration_capability_is_linux_only() {
        assert_eq!(
            actor(false).snapshot()["archiveMigration"],
            cfg!(target_os = "linux")
        );
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
                remaining_writes: Mutex::new(u64::MAX),
            }),
            fences: {
                let store = keyring_core::mock::Store::new().unwrap();
                Fences::new(move || Ok(store.clone()))
            },
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
            push: None,
            push_tasks: Vec::new(),
            push_state: "disabled",
            verified: false,
            tap: None,
            startup_link: None,
            cold_link: None,
            task_link: None,
            link_refused: false,
            attached: true,
            link_epoch: Arc::new(AtomicU64::new(0)),
            links_verified: Arc::new(AtomicBool::new(false)),
            app: None,
            #[cfg(test)]
            responses: Default::default(),
            #[cfg(test)]
            requests: Default::default(),
            #[cfg(test)]
            push_supported: true,
        }
    }
    fn cached_host() -> Actor {
        let mut host = actor(false);
        let stored = Session {
            expires_at: "2099-12-01T00:00:00Z".into(),
            ..session()
        };
        host.origin = Some(stored.origin.clone());
        host.registry.selected = host.origin.clone();
        host.registry
            .sessions
            .insert(stored.origin.clone(), stored.clone());
        let mut proof = Evidence::new(stored.clone());
        proof.verified = true;
        proof.name = Some("Alex".into());
        proof.email = Some("alex@example.test".into());
        proof.zero = Some("https://zero.example".into());
        proof.workspace = Some("workspace".into());
        host.registry.evidence.insert(stored.origin.clone(), proof);
        host.vault.save(&host.registry).unwrap();
        host.install(Some(stored));
        host
    }
    async fn native_op(host: &mut Actor, op: &str) -> Result<Value> {
        host.post(&json!({"op":op,"rid":1,"gen":host.gen}), 100)
            .await
    }
    #[tokio::test]
    async fn cold_offline_start_restores_only_complete_protected_evidence_and_no_jwt() {
        let mut host = cached_host();
        host.attach(Channel::new(|_| Ok(())), 1).unwrap();
        native_op(&mut host, "hello").await.unwrap();
        assert!(!host.verified);
        for op in [
            "session.read",
            "profile.read",
            "bootstrap.ensure",
            "config.read",
            "refresh",
        ] {
            host.responses.push_back((0, "".into(), false));
            let reply = native_op(&mut host, op).await;
            if op == "refresh" {
                assert_eq!(reply, Err("offline-ready"));
            } else {
                let reply = reply.unwrap();
                match op {
                    "session.read" => assert_eq!(reply["userId"], "u1"),
                    "profile.read" => assert_eq!(reply["name"], "Alex"),
                    "bootstrap.ensure" => assert_eq!(reply["workspaceId"], "workspace"),
                    "config.read" => assert_eq!(reply["zeroURL"], "https://zero.example"),
                    _ => unreachable!(),
                }
                assert!(!reply.to_string().contains("secret"));
            }
        }
        assert!(host.verified);
        assert!(host.jwt.is_empty());
        assert_eq!(host.meta()["tokenReady"], false);
        assert_eq!(host.meta()["jwtExp"], 0);
        assert!(!host.registry.evidence["https://a.example"].pending);
        assert!(host.vault.load().unwrap().evidence["https://a.example"]
            .ready(host.session.as_ref().unwrap(), now()));
    }
    #[tokio::test]
    async fn socket_retry_refreshes_native_jwt_after_cached_start_without_retargeting() {
        let mut host = cached_host();
        host.zero = Some("https://zero.example".into());
        let encoded = base64::engine::general_purpose::STANDARD
            .encode(format!(r#"{{"authToken":"{}"}}"#, host.handle))
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D");
        let request = json!({"op":"ws.open","rid":1,"gen":host.gen,"cid":1,"url":"wss://zero.example/sync/v51/connect","protocol":encoded});
        host.responses.push_back((0, "".into(), false));
        assert_eq!(host.socket_open(&request).await, Err("network"));
        assert!(host.jwt.is_empty());
        let claims = URL_SAFE_NO_PAD.encode(json!({"exp":now()/1000+3600}).to_string());
        let token = format!("a.{claims}.c");
        host.responses
            .push_back((200, json!({"token":token}).to_string(), false));
        // The unavailable channel prevents a real socket while exercising token recovery.
        assert_eq!(host.socket_open(&request).await, Err("closed"));
        assert_eq!(host.jwt, token);
        assert!(host.jwt_exp > now() / 1000);
        assert_eq!(
            host.requests
                .lock()
                .unwrap()
                .iter()
                .map(|r| r.1.as_str())
                .collect::<Vec<_>>(),
            vec!["/api/native/token", "/api/native/token"]
        );
        host.jwt.clear();
        host.responses.push_back((0, "".into(), true));
        assert_eq!(host.socket_open(&request).await, Err("cancelled"));
        assert!(host.jwt.is_empty());
        assert!(host.sockets.is_empty());
    }
    #[tokio::test]
    async fn incomplete_expired_or_mismatched_evidence_cannot_restore() {
        let host = cached_host();
        let session = host.session.as_ref().unwrap();
        let complete = host.registry.evidence[&session.origin].clone();
        assert!(complete.ready(session, now()));
        for missing in [
            "verified",
            "pending",
            "name",
            "email",
            "zero",
            "workspace",
            "expiry",
            "origin",
            "user",
            "device",
            "session",
            "token",
            "malformed-expiry",
            "invalid-zero",
            "invalid-workspace",
        ] {
            let mut proof = complete.clone();
            match missing {
                "verified" => proof.verified = false,
                "pending" => proof.pending = true,
                "name" => proof.name = None,
                "email" => proof.email = None,
                "zero" => proof.zero = None,
                "workspace" => proof.workspace = None,
                "expiry" => proof.session.expires_at = "2000-01-01T00:00:00Z".into(),
                "malformed-expiry" => proof.session.expires_at = "2099-02-30T00:00:00Z".into(),
                "origin" => proof.session.origin = "https://b.example".into(),
                "user" => proof.session.user_id = "other".into(),
                "device" => proof.session.device_id = "other".into(),
                "session" => proof.session.session_id = "other".into(),
                "token" => proof.session.token = "other".into(),
                "invalid-zero" => proof.zero = Some("http://zero.example".into()),
                "invalid-workspace" => proof.workspace = Some("/wrong".into()),
                _ => unreachable!(),
            }
            assert!(!proof.ready(session, now()), "accepted {missing}");
        }
        let expiry = chrono::DateTime::parse_from_rfc3339(&session.expires_at)
            .unwrap()
            .timestamp_millis() as u64;
        assert!(complete.ready(session, expiry - 1));
        assert!(!complete.ready(session, expiry));
        assert!(!complete.ready(session, expiry + 1));
        for value in [
            "2099-02-30T00:00:00Z",
            "2099-12-01T00:00:00+00:00",
            "2099-12-01T00:00:00.1Z",
            "2099-12-01T00:00:60Z",
        ] {
            assert!(!offline::unexpired(value, now()), "accepted {value}");
        }
    }
    #[tokio::test]
    async fn online_start_populates_evidence_and_refreshes_authoritative_expiry() {
        let mut host = cached_host();
        host.registry.evidence.clear();
        let stored = host.session.clone().unwrap();
        for (op, body) in [
            (
                "session.read",
                json!({"userId":stored.user_id,"deviceId":stored.device_id,"sessionId":stored.session_id,"expiresAt":"2099-12-02T00:00:00.000Z"}),
            ),
            (
                "profile.read",
                json!({"id":"u1","name":"Sam","email":"sam@example.test"}),
            ),
            ("bootstrap.ensure", json!({"workspaceId":"workspace"})),
            ("config.read", json!({"zeroURL":"https://zero.example"})),
        ] {
            host.responses.push_back((200, body.to_string(), false));
            native_op(&mut host, op).await.unwrap();
        }
        let registry = host.vault.load().unwrap();
        let stored = &registry.sessions["https://a.example"];
        assert_eq!(stored.expires_at, "2099-12-02T00:00:00.000Z");
        assert!(registry.evidence["https://a.example"].ready(stored, now()));
        assert_eq!(
            registry.evidence["https://a.example"].name.as_deref(),
            Some("Sam")
        );
    }
    #[tokio::test]
    async fn offline_evidence_is_not_used_for_trust_http_or_validation_failures() {
        for op in [
            "session.read",
            "profile.read",
            "bootstrap.ensure",
            "config.read",
            "refresh",
        ] {
            for (status, body) in [
                (1, ""),
                (2, ""),
                (503, "{}"),
                (200, "{bad"),
                (200, "{}"),
                (401, "{\"code\":\"unauthorized\"}"),
            ] {
                let mut host = cached_host();
                host.responses.push_back((status, body.into(), false));
                let result = native_op(&mut host, op).await;
                assert!(result.is_err(), "{op} {status}: {result:?}");
                assert_ne!(result, Err("offline-ready"));
                host.registry = host.vault.load().unwrap();
                let stored = host.registry.sessions.get("https://a.example").cloned();
                host.install(stored);
                host.responses.push_back((0, "".into(), false));
                assert!(
                    native_op(&mut host, "session.read").await.is_err(),
                    "{op} {status} resurrected offline evidence"
                );
            }
        }
    }
    #[tokio::test]
    async fn pending_checks_need_live_session_verification_and_stale_pages_cannot_restore() {
        let mut host = cached_host();
        host.registry
            .evidence
            .get_mut("https://a.example")
            .unwrap()
            .pending = true;
        host.responses.push_back((
            200,
            json!({"id":"u1","name":"Alex","email":"alex@example.test"}).to_string(),
            false,
        ));
        native_op(&mut host, "profile.read").await.unwrap();
        host.responses.push_back((0, "".into(), false));
        assert_eq!(native_op(&mut host, "session.read").await, Err("network"));
        let stored = host.session.clone().unwrap();
        host.responses.push_back((200, json!({"userId":stored.user_id,"deviceId":stored.device_id,"sessionId":stored.session_id,"expiresAt":stored.expires_at}).to_string(), false));
        native_op(&mut host, "session.read").await.unwrap();
        assert!(host.evidence(&stored).is_some());
        host.responses.push_back((0, "".into(), true));
        assert_eq!(native_op(&mut host, "session.read").await, Err("cancelled"));
        assert!(host.vault.load().unwrap().evidence["https://a.example"].pending);
    }
    #[tokio::test]
    async fn failed_check_or_refusal_persistence_never_reenables_offline_evidence() {
        for op in ["session.read", "session.revoke"] {
            for writes in [0, 1] {
                let mut host = cached_host();
                host.vault = Box::new(TestVault {
                    value: Mutex::new(host.registry.clone()),
                    reject: false,
                    remaining_writes: Mutex::new(writes),
                });
                host.responses
                    .push_back((401, r#"{"code":"unauthorized"}"#.into(), false));
                let result = native_op(&mut host, op).await;
                if writes == 0 {
                    assert_eq!(result, Err("storage-failed"));
                    assert!(host.requests.lock().unwrap().is_empty());
                } else {
                    assert!(result.is_err() || result.unwrap()["code"] == "storage-failed");
                    assert!(host.vault.load().unwrap().evidence["https://a.example"].pending);
                    assert!(host.session.is_none());
                }
            }
        }
        let mut revoked = cached_host();
        revoked.vault = Box::new(TestVault {
            value: Mutex::new(revoked.registry.clone()),
            reject: false,
            remaining_writes: Mutex::new(1),
        });
        revoked
            .responses
            .push_back((200, r#"{"revoked":true}"#.into(), false));
        let reply = native_op(&mut revoked, "session.revoke").await.unwrap();
        assert_eq!(reply["remoteRevoked"], true);
        assert_eq!(reply["code"], "storage-failed");
        assert!(revoked.vault.load().unwrap().evidence["https://a.example"].pending);
        assert!(revoked.session.is_none());
        let mut host = cached_host();
        host.vault = Box::new(TestVault {
            value: Mutex::new(host.registry.clone()),
            reject: false,
            remaining_writes: Mutex::new(1),
        });
        host.responses.push_back((0, "".into(), false));
        assert_eq!(
            native_op(&mut host, "session.read").await,
            Err("storage-failed")
        );
        assert!(host.vault.load().unwrap().evidence["https://a.example"].pending);
    }
    #[test]
    fn settings_destinations_are_fixed_and_bound_to_the_verified_owner() {
        let mut host = actor(false);
        link_owner(&mut host);
        for section in [
            "notifications",
            "security",
            "access-tokens",
            "calendar-feeds",
            "data",
            "danger",
        ] {
            let command = json!({"op":"settings.open","rid":1,"gen":host.gen,"id":host.handle,"body":{"section":section}});
            assert_eq!(
                host.settings_url(&command).unwrap(),
                format!("https://a.example/settings/{section}")
            );
        }
        let mut command = json!({"op":"settings.open","rid":1,"gen":host.gen,"id":host.handle,"body":{"section":"security"}});
        for section in [
            "",
            "../native/authorize",
            "https://other.example",
            "//other.example",
            "security?url=x",
            "security#x",
            "%73ecurity",
            "security/",
        ] {
            command["body"]["section"] = json!(section);
            assert_eq!(host.settings_url(&command), Err("invalid-settings"));
        }
        command["body"]["section"] = json!("security");
        command["url"] = json!("https://other.example");
        assert_eq!(host.settings_url(&command), Err("invalid-message"));
        command.as_object_mut().unwrap().remove("url");
        command["body"]["url"] = json!("https://other.example");
        assert_eq!(host.settings_url(&command), Err("invalid-message"));
        command["body"].as_object_mut().unwrap().remove("url");
        command["id"] = json!("retired");
        assert_eq!(host.settings_url(&command), Err("stale-generation"));
        command["id"] = json!(host.handle);
        host.verified = false;
        assert_eq!(host.settings_url(&command), Err("stale-generation"));
        host.verified = true;
        host.origin = Some("https://other.example".into());
        assert_eq!(host.settings_url(&command), Err("stale-generation"));
        host.origin = Some("https://a.example".into());
        host.clock.fetch_add(1, Ordering::SeqCst);
        assert_eq!(host.settings_url(&command), Err("cancelled"));
    }
    fn link() -> TaskLink {
        deep_links::parse("ditero://task?origin=https%3A%2F%2Fa.example&taskId=task").unwrap()
    }
    fn link_owner(host: &mut Actor) {
        let session = session();
        host.registry.selected = Some(session.origin.clone());
        host.registry
            .sessions
            .insert(session.origin.clone(), session.clone());
        host.origin = Some(session.origin.clone());
        host.install(Some(session));
        host.verified = true;
        host.links_verified.store(true, Ordering::SeqCst);
    }
    fn accept_link(host: &mut Actor, link: Option<TaskLink>) {
        host.receive_task_link(
            link,
            host.gen,
            host.page,
            host.link_epoch.load(Ordering::SeqCst),
        );
    }
    #[test]
    fn task_link_is_memory_only_and_exact_dismissal_preserves_other_requests() {
        let mut host = actor(false);
        link_owner(&mut host);
        accept_link(&mut host, Some(link()));
        let token = host.task_link.as_ref().unwrap().token.clone();
        let read = json!({"op":"link.read","rid":1,"gen":host.gen,"id":host.handle});
        assert_eq!(
            host.link_post(&read).unwrap()["open"],
            json!({"token":token,"taskId":"task"})
        );
        accept_link(
            &mut host,
            Some(TaskLink {
                task_id: "other".into(),
                ..link()
            }),
        );
        assert_eq!(host.task_link.as_ref().unwrap().token, token);
        host.link_post(&json!({"op":"link.dismiss","rid":2,"gen":host.gen,"id":host.handle,"body":{"token":"other"}})).unwrap();
        assert!(host.task_link.is_some());
        host.link_post(&json!({"op":"link.dismiss","rid":2,"gen":host.gen,"id":host.handle,"body":{"token":token}})).unwrap();
        assert_eq!(host.link_post(&read).unwrap()["open"], Value::Null);
        assert!(host.requests.lock().unwrap().is_empty());
        assert!(host.vault.load().unwrap().sessions.is_empty());
    }
    #[test]
    fn link_retirement_disables_ingress_before_advancing_ownership_epoch() {
        let epoch = AtomicU64::new(7);
        let verified = AtomicBool::new(true);
        assert_eq!(capture_link_ingress(&epoch, &verified), Some(7));
        let mut during = Some(0);
        retire_link_ingress(&epoch, &verified, || {
            during = capture_link_ingress(&epoch, &verified);
        });
        assert_eq!(
            during, None,
            "a callback between retirement writes must not capture the retired owner"
        );
        assert_eq!(epoch.load(Ordering::SeqCst), 8);
        assert!(!verified.load(Ordering::SeqCst));
        verified.store(true, Ordering::SeqCst);
        assert_eq!(capture_link_ingress(&epoch, &verified), Some(8));
    }
    #[test]
    fn explicit_link_retirement_fences_ingress_without_changing_credentials() {
        let mut host = actor(false);
        link_owner(&mut host);
        accept_link(&mut host, Some(link()));
        let (gen, page, epoch) = (host.gen, host.page, host.link_epoch.load(Ordering::SeqCst));
        let session = host.session.clone().unwrap();
        let handle = host.handle.clone();
        host.link_post(&json!({"op":"link.retire","rid":1,"gen":gen,"id":handle}))
            .unwrap();
        assert!(host.task_link.is_none());
        assert!(host.cold_link.is_none());
        assert!(!host.links_verified.load(Ordering::SeqCst));
        assert!(vault::same_session(
            host.session.as_ref().unwrap(),
            &session
        ));
        assert_eq!(host.handle, handle);
        host.receive_task_link(Some(link()), gen, page, epoch);
        assert!(host.task_link.is_none());
        accept_link(&mut host, Some(link()));
        assert!(
            host.task_link.is_none(),
            "current epoch alone cannot reopen retired ingress"
        );
        assert!(host.requests.lock().unwrap().is_empty());
    }
    #[test]
    fn foreign_and_malformed_links_have_only_a_refusal_without_origin_or_action() {
        for request in [
            None,
            Some(TaskLink {
                origin: "https://other.example".into(),
                ..link()
            }),
        ] {
            let mut host = actor(false);
            link_owner(&mut host);
            accept_link(&mut host, request);
            let read = json!({"op":"link.read","rid":1,"gen":host.gen,"id":host.handle});
            let value = host.link_post(&read).unwrap();
            assert_eq!(value["open"]["taskId"], Value::Null);
            assert_eq!(value["open"].as_object().unwrap().len(), 2);
            assert_eq!(host.origin.as_deref(), Some("https://a.example"));
            assert!(host.requests.lock().unwrap().is_empty());
        }
    }
    #[test]
    fn queued_link_cannot_follow_session_replacement_with_unchanged_generation() {
        let mut host = actor(false);
        link_owner(&mut host);
        let (gen, page, epoch) = (host.gen, host.page, host.link_epoch.load(Ordering::SeqCst));
        let mut replacement = session();
        replacement.user_id = "other".into();
        replacement.session_id = "new-session".into();
        host.install(Some(replacement));
        host.verified = true;
        host.links_verified.store(true, Ordering::SeqCst);
        assert_eq!(host.gen, gen);
        assert_eq!(host.page, page);
        host.receive_task_link(Some(link()), gen, page, epoch);
        assert!(host.task_link.is_none());
        accept_link(&mut host, Some(link()));
        assert_eq!(host.task_link.as_ref().unwrap().session.user_id, "other");
    }
    #[test]
    fn page_retirement_and_unverified_state_refuse_delivery_and_stale_reads() {
        let mut host = actor(false);
        link_owner(&mut host);
        host.verified = false;
        accept_link(&mut host, Some(link()));
        assert!(host.task_link.is_none());
        host.verified = true;
        accept_link(&mut host, Some(link()));
        host.pages.fetch_add(1, Ordering::SeqCst);
        let read = json!({"op":"link.read","rid":1,"gen":host.gen,"id":host.handle});
        assert_eq!(host.link_post(&read), Err("cancelled"));
        host.drain();
        assert!(host.task_link.is_none());
        assert!(!host.links_verified.load(Ordering::SeqCst));
    }
    #[test]
    fn task_link_protocol_refuses_extra_fields_and_wrong_authentication_handle() {
        let mut host = actor(false);
        link_owner(&mut host);
        accept_link(&mut host, Some(link()));
        for value in [
            json!({"op":"link.read","rid":1,"gen":host.gen,"id":"other"}),
            json!({"op":"link.read","rid":1,"gen":host.gen,"id":host.handle,"url":"https://evil.example"}),
            json!({"op":"link.dismiss","rid":1,"gen":host.gen,"id":host.handle,"body":{"token":"link","taskId":"other"}}),
        ] {
            assert_eq!(host.link_post(&value), Err("invalid-message"));
        }
        assert!(host.task_link.is_some());
    }
    #[tokio::test]
    async fn cold_link_restores_only_selected_session_and_waits_for_verification() {
        let mut host = actor(false);
        let stored = session();
        let mut registry = Registry::default();
        registry.selected = Some(stored.origin.clone());
        registry
            .sessions
            .insert(stored.origin.clone(), stored.clone());
        host.vault.save(&registry).unwrap();
        host.attached = false;
        host.startup_link = Some(link());
        host.attach(Channel::new(|_| Ok(())), 1).unwrap();
        assert!(host.cold_link.is_some());
        assert!(host.task_link.is_none());
        host.post(&json!({"op":"hello","rid":1}), 40).await.unwrap();
        assert_eq!(host.registry.selected, Some(stored.origin.clone()));
        assert!(host.cold_link.is_some());
        assert!(host.task_link.is_none());
        assert!(!host.verified);
        host.responses.push_back((200, json!({"userId":stored.user_id,"sessionId":stored.session_id,"deviceId":stored.device_id,"expiresAt":stored.expires_at}).to_string(), false));
        host.post(&json!({"op":"session.read","rid":2,"gen":host.gen}), 100)
            .await
            .unwrap();
        assert!(host.cold_link.is_none());
        assert_eq!(
            host.task_link.as_ref().unwrap().task_id.as_deref(),
            Some("task")
        );
        assert_eq!(host.requests.lock().unwrap().len(), 1);
        host.post(&json!({"op":"hello","rid":3}), 40).await.unwrap();
        assert!(host.cold_link.is_none());
        assert!(host.task_link.is_none());
    }
    #[test]
    fn cold_link_never_selects_an_account_and_cannot_survive_a_second_page() {
        let mut host = actor(false);
        host.attached = false;
        host.startup_link = Some(link());
        host.attach(Channel::new(|_| Ok(())), 1).unwrap();
        assert!(host.link_refused);
        assert!(host.registry.selected.is_none());
        assert!(host.cold_link.is_none());
        let stored = session();
        let mut registry = Registry::default();
        registry.selected = Some(stored.origin.clone());
        registry.sessions.insert(stored.origin.clone(), stored);
        host.vault.save(&registry).unwrap();
        host.attached = false;
        host.startup_link = Some(link());
        host.attach(Channel::new(|_| Ok(())), 1).unwrap();
        assert!(host.cold_link.is_some());
        host.attach(Channel::new(|_| Ok(())), 2).unwrap();
        assert!(host.cold_link.is_none());
        assert!(host.task_link.is_none());
    }
    #[tokio::test]
    async fn explicit_selection_and_failed_revocation_retire_links_before_network_work() {
        let mut host = actor(false);
        link_owner(&mut host);
        accept_link(&mut host, Some(link()));
        host.post(
            &json!({"op":"server.select","rid":1,"gen":host.gen,"origin":"https://a.example"}),
            150,
        )
        .await
        .unwrap();
        assert!(host.task_link.is_none());
        assert!(host.links_verified.load(Ordering::SeqCst));
        accept_link(&mut host, Some(link()));
        host.responses.push_back((503, "{}".into(), false));
        assert_eq!(host.revoke().await, Err("revoke-refused"));
        assert!(host.task_link.is_none());
        assert!(host.cold_link.is_none());
        assert!(!host.links_verified.load(Ordering::SeqCst));
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
    fn push_owner(host: &mut Actor) -> notifications::Owner {
        let session = session();
        host.install(Some(session.clone()));
        host.verified = true;
        let registration = DesktopRegistration {
            session: session.clone(),
            registration_id: "registration".into(),
            seen: vec!["notification".into()],
            receipts: vec!["notification".into()],
            locale: "en".into(),
        };
        host.registry
            .notifications
            .insert(session.origin, registration.clone());
        notifications::Owner {
            registration,
            gen: host.gen,
            page: host.page,
            handle: host.handle.clone(),
            clock: host.clock.clone(),
            pages: host.pages.clone(),
            retired: Arc::new(AtomicBool::new(false)),
            wake: Arc::new(tokio::sync::Notify::new()),
            locale: Arc::new(std::sync::RwLock::new("en".into())),
        }
    }
    #[tokio::test]
    async fn unverified_restore_and_retired_callbacks_have_no_notification_authority() {
        let mut restored = actor(false);
        let owner = push_owner(&mut restored);
        restored.verified = false;
        restored.start_notifications();
        assert!(restored.push.is_none());
        for retirement in 0..4 {
            let mut host = actor(false);
            let owner = push_owner(&mut host);
            match retirement {
                0 => host.drop_memory(),
                1 => {
                    host.pages.fetch_add(1, Ordering::SeqCst);
                }
                2 => {
                    let mut replacement = session();
                    replacement.token = "replacement-token".into();
                    host.install(Some(replacement));
                    host.verified = true;
                }
                _ => owner.cancel(),
            }
            let saved = host.registry.notifications.clone();
            let (tx, rx) = oneshot::channel();
            host.notification_event(NotificationEvent::Accepted(
                owner.clone(),
                "later".into(),
                tx,
            ));
            assert!(!rx.await.unwrap());
            host.notification_event(NotificationEvent::Received(
                owner.clone(),
                "notification".into(),
            ));
            host.notification_event(NotificationEvent::Action(owner, "notification".into()));
            assert!(host.tap.is_none());
            assert_eq!(
                serde_json::to_value(saved).unwrap(),
                serde_json::to_value(&host.registry.notifications).unwrap()
            );
        }
        assert!(!restored.notification_current(&owner));
    }
    #[tokio::test]
    async fn accepted_display_requires_protected_storage_and_receipt_uses_exact_owner() {
        let mut host = actor(true);
        let owner = push_owner(&mut host);
        let (tx, rx) = oneshot::channel();
        host.notification_event(NotificationEvent::Accepted(owner, "new".into(), tx));
        assert!(!rx.await.unwrap());
        assert_eq!(host.push_state, "storage-failed");
        assert!(host.verified);
        assert_eq!(host.push_reply()["state"], "storage-failed");
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        host.notification_event(NotificationEvent::Received(owner, "notification".into()));
        assert!(host.registry.notifications["https://a.example"]
            .receipts
            .is_empty());
        let old = session();
        let mut next = host.registry.clone();
        let mut replacement = next.notifications[&old.origin].clone();
        replacement.session.token = "replacement-token".into();
        replacement.registration_id = "replacement-registration".into();
        next.notifications.insert(old.origin.clone(), replacement);
        Actor::retire_in(&mut next, &old).unwrap();
        assert_eq!(
            next.notifications[&old.origin].registration_id,
            "replacement-registration"
        );
        assert!(next.retired_notifications.is_empty());
        Actor::retire_in(&mut host.registry, &old).unwrap();
        assert!(host.registry.notifications.is_empty());
        assert_eq!(
            host.registry.retired_notifications[0].registration_id,
            "registration"
        );
    }
    #[tokio::test]
    async fn terminal_cleanup_is_exact_and_durable_state_does_not_replace_active_owner() {
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        let old = owner.registration.clone();
        host.registry.notifications.clear();
        host.registry.retired_notifications.push(old.clone());
        let mut newer = old.clone();
        newer.session.token = "newer-token".into();
        host.registry.retired_notifications.push(newer.clone());
        host.push_state = "cleanup-pending";
        host.notification_cleaned(&old);
        assert_eq!(host.registry.retired_notifications.len(), 1);
        assert_eq!(
            host.registry.retired_notifications[0].session.token,
            "newer-token"
        );
        assert_eq!(host.push_state, "cleanup-pending");
        host.notification_cleaned(&newer);
        assert!(host.registry.retired_notifications.is_empty());
        assert_eq!(host.push_state, "disabled");
        host.registry.retired_notifications.push(old.clone());
        host.drop_memory();
        host.push_state = "cleanup-pending";
        host.notification_cleaned(&old);
        assert_eq!(host.push_state, "no-session");
        let current = push_owner(&mut host);
        host.registry.retired_notifications.push(old.clone());
        host.push_state = "active";
        host.notification_cleaned(&old);
        assert_eq!(host.push_state, "active");
        assert!(host.notification_current(&current));
        let mut failed = actor(true);
        failed.registry.retired_notifications.push(old.clone());
        failed.push_state = "cleanup-pending";
        failed.notification_cleaned(&old);
        assert_eq!(failed.registry.retired_notifications.len(), 1);
        assert_eq!(failed.push_state, "storage-failed");
    }
    #[tokio::test]
    async fn state_refresh_recovers_daemon_without_registering_and_locale_preserves_live_owner_and_tap(
    ) {
        let mut empty = actor(false);
        empty.install(Some(session()));
        empty.verified = true;
        empty.push_state = "unsupported";
        let reply = empty
            .push_post(
                &json!({"op":"push.state","rid":1,"gen":empty.gen,"id":empty.handle,"locale":"en"}),
            )
            .await
            .unwrap();
        assert_eq!(reply["state"], "disabled");
        assert!(empty.push.is_none());
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        host.push_state = "unsupported";
        host.push = Some(notifications::Receiver {
            owner: owner.clone(),
            task: tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async {})),
            finished: Arc::new(AtomicBool::new(true)),
        });
        let state =
            json!({"op":"push.state","rid":1,"gen":host.gen,"id":host.handle,"locale":"en"});
        let reply = host.push_post(&state).await.unwrap();
        assert_eq!(reply["state"], "active");
        assert!(owner.retired.load(Ordering::SeqCst));
        assert!(host.push.as_ref().unwrap().owner.current());
        assert!(host.requests.lock().unwrap().is_empty());
        let live = host.push.as_ref().unwrap().owner.clone();
        host.tap = Some(NotificationTap {
            owner: live.clone(),
            notification: "notification".into(),
            token: "tap-token".into(),
        });
        let reply = host
            .push_post(
                &json!({"op":"push.state","rid":2,"gen":host.gen,"id":host.handle,"locale":"de"}),
            )
            .await
            .unwrap();
        assert_eq!(reply["state"], "active");
        assert_eq!(
            host.registry.notifications["https://a.example"].locale,
            "de"
        );
        assert_eq!(
            notifications::notification_copy(&live).unwrap(),
            notifications::copy("de")
        );
        assert_eq!(host.tap.as_ref().unwrap().token, "tap-token");
        assert!(host.notification_current(&live));
        assert!(Arc::ptr_eq(
            &live.retired,
            &host.push.as_ref().unwrap().owner.retired
        ));
        host.push_supported = false;
        let reply = host.push_post(&state).await.unwrap();
        assert_eq!(reply["state"], "unsupported");
        assert!(host.push.is_none());
        assert!(!live.current());
        host.stop_notifications();
    }
    #[tokio::test]
    async fn unavailable_receipt_retires_pending_but_retains_seen_only_for_current_owner() {
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        assert!(notifications::receipt_terminal(
            404,
            &json!({"code":"notification-unavailable"})
        ));
        host.notification_event(NotificationEvent::Received(
            owner.clone(),
            "notification".into(),
        ));
        let record = &host.registry.notifications["https://a.example"];
        assert!(record.receipts.is_empty());
        assert_eq!(record.seen, vec!["notification"]);
        host.registry
            .notifications
            .get_mut("https://a.example")
            .unwrap()
            .receipts
            .push("notification".into());
        owner.cancel();
        host.notification_event(NotificationEvent::Received(owner, "notification".into()));
        assert_eq!(
            host.registry.notifications["https://a.example"].receipts,
            vec!["notification"]
        );
    }
    #[tokio::test]
    async fn failed_locale_persistence_preserves_existing_popups_and_pending_tap() {
        let mut host = actor(true);
        let owner = push_owner(&mut host);
        host.push_state = "active";
        host.push = Some(notifications::Receiver {
            owner: owner.clone(),
            task: tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async {})),
            finished: Arc::new(AtomicBool::new(false)),
        });
        host.tap = Some(NotificationTap {
            owner: owner.clone(),
            notification: "notification".into(),
            token: "preserved-tap".into(),
        });
        let reply = host
            .push_post(
                &json!({"op":"push.state","rid":1,"gen":host.gen,"id":host.handle,"locale":"es"}),
            )
            .await
            .unwrap();
        assert_eq!(reply["state"], "storage-failed");
        assert_eq!(
            host.registry.notifications["https://a.example"].locale,
            "en"
        );
        assert_eq!(
            notifications::notification_copy(&owner).unwrap(),
            notifications::copy("en")
        );
        assert!(host.notification_current(&owner));
        assert_eq!(host.tap.as_ref().unwrap().token, "preserved-tap");
        host.stop_notifications();
    }
    #[tokio::test]
    async fn background_refusal_carries_captured_handle_and_rejects_held_callbacks() {
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
        let capture = emitted.clone();
        host.channel = Some(Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(raw) = body else {
                panic!("unexpected raw event")
            };
            let message: String = serde_json::from_str(&raw).unwrap();
            capture
                .lock()
                .unwrap()
                .push(serde_json::from_str(&message).unwrap());
            Ok(())
        }));
        host.notification_event(NotificationEvent::Unauthorized(owner.clone()));
        assert_eq!(
            *emitted.lock().unwrap(),
            vec![json!({"t":"session-refused","gen":host.gen,"authHandle":owner.handle})]
        );
        assert!(host.handle.is_empty());
        assert!(!host.verified);
        let (reply, receive) = oneshot::channel();
        host.notification_event(NotificationEvent::Accepted(
            owner.clone(),
            "late".into(),
            reply,
        ));
        assert!(!receive.await.unwrap());
        host.notification_event(NotificationEvent::Action(
            owner.clone(),
            "notification".into(),
        ));
        host.notification_event(NotificationEvent::Received(owner, "notification".into()));
        assert!(host.tap.is_none());
        assert!(host.registry.notifications.is_empty());
        assert_eq!(emitted.lock().unwrap().len(), 1);
    }
    #[tokio::test]
    async fn no_session_states_and_finished_receiver_recovery_preserve_authority() {
        for op in ["push.state", "push.permission", "push.enable"] {
            let mut host = actor(false);
            let reply = host
                .push_post(&json!({"op":op,"rid":1,"gen":host.gen,"id":"","locale":"en"}))
                .await
                .unwrap();
            assert_eq!(
                reply,
                json!({"ok":true,"state":"no-session","permission":"denied","provider":"desktop"})
            );
            let owner = push_owner(&mut host);
            host.verified = false;
            let reply = host
                .push_post(&json!({"op":op,"rid":1,"gen":host.gen,"id":owner.handle,"locale":"de"}))
                .await
                .unwrap();
            assert_eq!(reply["state"], "no-session");
            assert!(host.push.is_none());
        }
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        let completion = Arc::new(AtomicBool::new(false));
        host.push = Some(notifications::Receiver {
            owner: owner.clone(),
            task: tauri::async_runtime::JoinHandle::Tokio(tokio::spawn(async {})),
            finished: completion.clone(),
        });
        assert!(!host.retire_finished_receiver());
        assert!(host.push.is_some());
        completion.store(true, Ordering::SeqCst);
        assert!(host.retire_finished_receiver());
        assert!(host.push.is_none());
        assert!(host.verified);
        assert!(owner.retired.load(Ordering::SeqCst));
        assert!(host.session.is_some());
        host.push_state = "unsupported";
        assert_eq!(host.push_reply()["permission"], "denied");
        host.drop_memory();
        assert!(!host.verified);
    }
    #[tokio::test]
    async fn pending_tap_survives_offline_and_is_consumed_only_by_exact_dismiss_or_404() {
        let mut host = actor(false);
        let owner = push_owner(&mut host);
        host.notification_event(NotificationEvent::Action(owner, "notification".into()));
        let open = json!({"op":"push.open","rid":1,"gen":host.gen,"id":host.handle});
        let token = host.tap.as_ref().unwrap().token.clone();
        host.responses.push_back((503, "{}".into(), false));
        assert_eq!(host.push_post(&open).await, Err("network"));
        assert_eq!(host.tap.as_ref().unwrap().token, token);
        host.responses.push_back((
            200,
            json!({"target":{"kind":"workspace","workspaceId":"w"}}).to_string(),
            false,
        ));
        let resolved = host.push_post(&open).await.unwrap();
        assert_eq!(resolved["open"]["token"], token);
        host.push_post(&json!({"op":"push.dismissOpen","rid":2,"gen":host.gen,"id":host.handle,"body":{"token":"other"}})).await.unwrap();
        assert!(host.tap.is_some());
        host.push_post(&json!({"op":"push.dismissOpen","rid":2,"gen":host.gen,"id":host.handle,"body":{"token":token}})).await.unwrap();
        assert!(host.tap.is_none());
        let owner = push_owner(&mut host);
        host.notification_event(NotificationEvent::Action(owner, "notification".into()));
        let open = json!({"op":"push.open","rid":1,"gen":host.gen,"id":host.handle});
        host.responses.push_back((404, "{}".into(), false));
        assert_eq!(host.push_post(&open).await, Err("notification-unavailable"));
        assert!(host.tap.is_none());
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
    async fn native_refusals_survive_failed_credential_deletion_and_cold_offline_restart() {
        for source in ["attachment", "notification", "e2e"] {
            for writes in [0, 1] {
                let mut host = cached_host();
                let store = keyring_core::mock::Store::new().unwrap();
                let running_store = store.clone();
                host.fences = Fences::new(move || Ok(running_store.clone()));
                let captured = host.session.clone().unwrap();
                let registration = DesktopRegistration {
                    session: captured.clone(),
                    registration_id: "registration".into(),
                    seen: vec![],
                    receipts: vec![],
                    locale: "en".into(),
                };
                host.registry
                    .notifications
                    .insert(captured.origin.clone(), registration.clone());
                host.verified = true;
                host.vault = Box::new(TestVault {
                    value: Mutex::new(host.registry.clone()),
                    reject: false,
                    remaining_writes: Mutex::new(writes),
                });
                match source {
                    "attachment" => host.file_reply(
                        attachments::Context::new(
                            host.gen,
                            host.page,
                            captured.clone(),
                            host.clock.clone(),
                            host.pages.clone(),
                        ),
                        1,
                        Ok(json!({"ok":false,"status":401,"body":r#"{"code":"unauthorized"}"#})),
                    ),
                    "notification" => {
                        let owner = notifications::Owner {
                            registration,
                            gen: host.gen,
                            page: host.page,
                            handle: host.handle.clone(),
                            clock: host.clock.clone(),
                            pages: host.pages.clone(),
                            retired: Arc::new(AtomicBool::new(false)),
                            wake: Arc::new(tokio::sync::Notify::new()),
                            locale: Arc::new(std::sync::RwLock::new("en".into())),
                        };
                        host.notification_event(NotificationEvent::Unauthorized(owner));
                    }
                    _ => {
                        host.responses
                            .push_back((403, r#"{"code":"forbidden"}"#.into(), false));
                        assert_eq!(
                            host.authed("/api/native/e2e/workspaces", false, None, false)
                                .await
                                .unwrap()
                                .0,
                            403
                        );
                    }
                }
                let retained = host.vault.load().unwrap();
                assert!(
                    retained.sessions.contains_key(&captured.origin),
                    "fixture must retain the credential after failed deletion"
                );
                let mut restarted = actor(false);
                restarted.registry = retained;
                restarted.fences = Fences::new(move || Ok(store.clone()));
                restarted.origin = Some(captured.origin.clone());
                restarted.install(Some(captured));
                assert!(
                    restarted
                        .evidence(restarted.session.as_ref().unwrap())
                        .is_none(),
                    "{source}/{writes} resurrected refused evidence"
                );
                restarted.responses.push_back((0, "".into(), false));
                assert!(
                    native_op(&mut restarted, "session.read").await.is_err(),
                    "{source}/{writes} reopened cached data"
                );
            }
        }
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
