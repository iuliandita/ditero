use crate::{
    protocol::{self, Result},
    vault::{DesktopRegistration, Session},
};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, RwLock,
};
use std::time::Duration;
use tokio::sync::{mpsc, oneshot, Notify};

#[derive(Clone)]
pub struct Owner {
    pub registration: DesktopRegistration,
    pub gen: u64,
    pub page: u64,
    pub handle: String,
    pub clock: Arc<AtomicU64>,
    pub pages: Arc<AtomicU64>,
    pub retired: Arc<AtomicBool>,
    pub wake: Arc<Notify>,
    pub locale: Arc<RwLock<String>>,
}
impl Owner {
    pub fn current(&self) -> bool {
        !self.retired.load(Ordering::SeqCst)
            && self.clock.load(Ordering::SeqCst) == self.gen
            && self.pages.load(Ordering::SeqCst) == self.page
    }
    pub fn cancel(&self) {
        self.retired.store(true, Ordering::SeqCst);
        self.wake.notify_one();
    }
    pub fn matches(&self, session: &Session, handle: &str, gen: u64, page: u64) -> bool {
        self.current()
            && crate::vault::same_session(&self.registration.session, session)
            && self.handle == handle
            && self.gen == gen
            && self.page == page
    }
}
pub enum Event {
    Accepted(Owner, String, oneshot::Sender<bool>),
    Received(Owner, String),
    Action(Owner, String),
    State(Owner, &'static str),
    Stopped(Owner, &'static str),
    Unauthorized(Owner),
}
pub struct Receiver {
    pub owner: Owner,
    pub task: tauri::async_runtime::JoinHandle<()>,
    pub finished: Arc<AtomicBool>,
}
pub async fn drain(tasks: Vec<tauri::async_runtime::JoinHandle<()>>, budget: Duration) -> bool {
    tokio::time::timeout(budget, futures_util::future::join_all(tasks))
        .await
        .is_ok_and(|results| results.iter().all(std::result::Result::is_ok))
}
async fn observe_display<S, C, F>(owner: &Owner, shown: S, close: C) -> Option<u32>
where
    S: std::future::Future<Output = std::result::Result<u32, ()>>,
    C: FnOnce(u32) -> F,
    F: std::future::Future<Output = ()>,
{
    let id = shown.await.ok().filter(|id| *id > 0)?;
    if !owner.current() {
        close(id).await;
        None
    } else {
        Some(id)
    }
}
async fn accepted(owner: &Owner, reply: oneshot::Receiver<bool>) -> bool {
    if !owner.current() {
        return false;
    }
    tokio::select! { result = reply => result.unwrap_or(false) && owner.current(), _ = owner.wake.notified() => false }
}
pub fn exact(v: &Value, fields: &[&str]) -> bool {
    v.as_object()
        .is_some_and(|o| o.len() == fields.len() && fields.iter().all(|f| o.contains_key(*f)))
}
pub fn cleanup_terminal(status: u16, value: &Value) -> bool {
    (status == 200 && exact(value, &["unregistered"]) && value["unregistered"] == true)
        || (status == 401 && exact(value, &["code"]) && value["code"] == "unauthorized")
}
pub fn receipt_terminal(status: u16, value: &Value) -> bool {
    (status == 200 && exact(value, &["received"]) && value["received"] == true)
        || (status == 404 && exact(value, &["code"]) && value["code"] == "notification-unavailable")
}
pub fn notification_copy(owner: &Owner) -> Result<(&'static str, &'static str)> {
    owner
        .locale
        .read()
        .map(|locale| copy(&locale))
        .map_err(|_| "storage-failed")
}
pub fn messages(v: &Value, registration: &str) -> Result<Vec<String>> {
    if !exact(v, &["messages"]) {
        return Err("invalid-response");
    }
    let values = v["messages"]
        .as_array()
        .filter(|v| v.len() <= 20)
        .ok_or("invalid-response")?;
    let mut ids = Vec::new();
    for value in values {
        if !exact(value, &["version", "notificationId", "registrationId"])
            || value["version"] != "1"
            || value["registrationId"] != registration
        {
            return Err("invalid-response");
        }
        let id = protocol::string(value, "notificationId")?;
        if !protocol::id(id) || ids.iter().any(|old| old == id) {
            return Err("invalid-response");
        }
        ids.push(id.to_owned());
    }
    Ok(ids)
}
pub fn target(value: &Value) -> Result<Value> {
    let kind = protocol::string(value, "kind")?;
    let fields: &[&str] = match kind {
        "task" => &["kind", "workspaceId", "listId", "taskId"],
        "workspace" => &["kind", "workspaceId"],
        _ => return Err("invalid-response"),
    };
    if !exact(value, fields)
        || fields
            .iter()
            .filter(|f| **f != "kind")
            .any(|f| !value[*f].as_str().is_some_and(protocol::id))
    {
        return Err("invalid-response");
    }
    Ok(value.clone())
}
pub async fn request(
    http: &reqwest::Client,
    session: &Session,
    operation: &str,
    body: Option<Value>,
) -> Result<(u16, Value)> {
    let path = match operation {
        "config" => "/api/native/push/desktop/config",
        "poll" => "/api/native/push/desktop/poll",
        "receipt" => "/api/native/push/desktop/receipt",
        "unregister" => "/api/native/push/desktop/unregister",
        _ => return Err("unknown-op"),
    };
    let url = format!("{}{path}", session.origin);
    let mut request = if body.is_some() {
        http.post(url)
    } else {
        http.get(url)
    }
    .bearer_auth(&session.token)
    .header("Accept", "application/json");
    if let Some(body) = body {
        request = request.json(&body);
    }
    let mut response = request.send().await.map_err(|_| "network")?;
    let status = response.status().as_u16();
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "network")? {
        if bytes.len() + chunk.len() > 8192 {
            return Err("invalid-response");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        status,
        protocol::parse(std::str::from_utf8(&bytes).map_err(|_| "invalid-response")?)?,
    ))
}
pub fn copy(locale: &str) -> (&'static str, &'static str) {
    match locale {
        "de" => ("Öffne Ditero, um die Benachrichtigung anzusehen.", "Öffnen"),
        "es" => ("Abre Ditero para ver la notificación.", "Abrir"),
        "fr" => ("Ouvre Ditero pour voir ta notification.", "Ouvrir"),
        "ro" => ("Deschide Ditero pentru a vedea notificarea.", "Deschide"),
        "ar" => ("افتح Ditero لعرض الإشعار.", "فتح"),
        _ => ("Open Ditero to view your notification.", "Open"),
    }
}
#[cfg(target_os = "linux")]
pub async fn supported() -> bool {
    tokio::time::timeout(Duration::from_secs(3), linux::connect())
        .await
        .is_ok_and(|r| r.is_ok())
}
#[cfg(not(target_os = "linux"))]
pub async fn supported() -> bool {
    false
}
pub fn start(owner: Owner, http: reqwest::Client, events: mpsc::Sender<Event>) -> Receiver {
    let captured = owner.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let completed = finished.clone();
    let task = tauri::async_runtime::spawn(async move {
        #[cfg(test)]
        {
            let _ = (http, events);
            captured.wake.notified().await;
        }
        #[cfg(all(not(test), target_os = "linux"))]
        linux::run(captured, http, events).await;
        #[cfg(all(not(test), not(target_os = "linux")))]
        {
            let _ = http;
            let _ = events.send(Event::State(captured, "unsupported")).await;
        }
        completed.store(true, Ordering::SeqCst);
    });
    Receiver {
        owner,
        task,
        finished,
    }
}
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use futures_util::StreamExt;
    use std::collections::HashMap;
    use zbus::{zvariant::Value as Variant, Connection, Proxy};
    pub async fn connect() -> zbus::Result<(Proxy<'static>, Proxy<'static>)> {
        let connection = Connection::session().await?;
        let bus = zbus::fdo::DBusProxy::new(&connection).await?;
        let owner = bus
            .get_name_owner("org.freedesktop.Notifications".try_into()?)
            .await?;
        let watcher = Proxy::new_owned(
            connection.clone(),
            "org.freedesktop.Notifications",
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await?;
        let proxy = Proxy::new_owned(
            connection.clone(),
            owner,
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await?;
        let capabilities: Vec<String> = proxy.call("GetCapabilities", &()).await?;
        if !capabilities.iter().any(|c| c == "actions") {
            return Err(zbus::Error::Failure("actions-unavailable".into()));
        }
        Ok((proxy, watcher))
    }
    async fn close(proxy: &Proxy<'_>, id: u32) {
        if !tokio::time::timeout(
            Duration::from_secs(2),
            proxy.call::<_, _, ()>("CloseNotification", &(id,)),
        )
        .await
        .is_ok_and(|result| result.is_ok())
        {
            eprintln!("notification withdrawal unconfirmed");
        }
    }
    async fn daemon_current(proxy: &Proxy<'_>) -> bool {
        tokio::time::timeout(Duration::from_secs(3), async {
            let Ok(bus) = zbus::fdo::DBusProxy::new(proxy.connection()).await else {
                return false;
            };
            bus.get_name_owner("org.freedesktop.Notifications".try_into().unwrap())
                .await
                .is_ok_and(|name| name.as_str() == proxy.destination().as_str())
        })
        .await
        .unwrap_or(false)
    }
    pub async fn run(owner: Owner, http: reqwest::Client, events: mpsc::Sender<Event>) {
        let (proxy, watcher) = match tokio::time::timeout(Duration::from_secs(3), connect()).await {
            Ok(Ok(proxy)) => proxy,
            _ => {
                let _ = events.send(Event::State(owner, "unsupported")).await;
                return;
            }
        };
        let mut signals = match proxy.receive_all_signals().await {
            Ok(s) => s,
            Err(_) => {
                let _ = events.send(Event::State(owner, "unsupported")).await;
                return;
            }
        };
        let mut changes = match watcher.receive_owner_changed().await {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut ids: HashMap<u32, String> = HashMap::new();
        let mut receipts = owner.registration.receipts.clone();
        let mut seen = owner.registration.seen.clone();
        let mut tick = tokio::time::interval(Duration::from_secs(10));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        while owner.current() {
            tokio::select! {
                _ = owner.wake.notified() => { if !owner.current() { break; } }
                change = changes.next() => {
                    let _ = change;
                    owner.cancel();
                    let _ = events.send(Event::Stopped(owner.clone(), "temporary-unavailable")).await;
                    break;
                }
                signal = signals.next() => {
                    let Some(signal) = signal else { break; };
                    match signal.header().member().map(|m| m.as_str()) {
                        Some("ActionInvoked") => {
                            if let Ok((id,key)) = signal.body().deserialize::<(u32,String)>() {
                                if key == "default" && owner.current() && daemon_current(&proxy).await && owner.current() {
                                    if let Some(notification) = ids.remove(&id) {
                                        let _ = events.send(Event::Action(owner.clone(), notification)).await;
                                        close(&proxy,id).await;
                                    }
                                }
                            }
                        }
                        Some("NotificationClosed") => { if let Ok((id,_)) = signal.body().deserialize::<(u32,u32)>() { ids.remove(&id); } }
                        _ => {}
                    }
                }
                _ = tick.tick() => {
                    if !owner.current() { break; }
                    for notification in receipts.clone() {
                        if !owner.current() { break; }
                        let result = request(&http,&owner.registration.session,"receipt",Some(json!({"registrationId":owner.registration.registration_id,"notificationId":notification}))).await;
                        if !owner.current() { break; }
                        if result.is_ok_and(|(status,v)| receipt_terminal(status,&v)) {
                            receipts.retain(|id| id != &notification);
                            let _ = events.send(Event::Received(owner.clone(),notification)).await;
                        }
                    }
                    if !owner.current() { break; }
                    let result = request(&http,&owner.registration.session,"poll",Some(json!({"registrationId":owner.registration.registration_id}))).await;
                    if !owner.current() { break; }
                    let batch = match result {
                        Ok((200,v)) => messages(&v,&owner.registration.registration_id),
                        Ok((401,v)) if exact(&v,&["code"]) && v["code"] == "unauthorized" => { let _ = events.send(Event::Unauthorized(owner.clone())).await; break; }
                        _ => Err("temporary-unavailable"),
                    };
                    let batch = match batch { Ok(v) => v, Err(_) => { let _ = events.send(Event::State(owner.clone(),"temporary-unavailable")).await; continue; } };
                    let _ = events.send(Event::State(owner.clone(),"active")).await;
                    for notification in batch {
                        if !owner.current() { break; }
                        if seen.contains(&notification) { continue; }
                        if !daemon_current(&proxy).await || !owner.current() { owner.cancel();let _ = events.send(Event::Stopped(owner.clone(),"temporary-unavailable")).await; break; }
                        let (body,action) = match notification_copy(&owner) { Ok(copy)=>copy,Err(_)=>{ let _=events.send(Event::State(owner.clone(),"storage-failed")).await;break; } };
                        let hints: HashMap<&str,Variant<'_>> = HashMap::from([("transient",Variant::Bool(true))]);
                        // Observe this result even on retirement, so an accepted late display can be withdrawn.
                        let arguments=("Ditero",0u32,"","Ditero",body,vec!["default",action],hints,300000i32);
                        let shown=async { proxy.call::<_,_,u32>("Notify",&arguments).await.map_err(|_| ()) };
                        let id = match observe_display(&owner,shown,|id| close(&proxy,id)).await { Some(id)=>id,None=>{ if owner.current() { let _ = events.send(Event::State(owner.clone(),"temporary-unavailable")).await; } break; } };
                        if !owner.current() || !daemon_current(&proxy).await || !owner.current() {
                            close(&proxy,id).await;
                            if owner.current() { owner.cancel();let _=events.send(Event::Stopped(owner.clone(),"temporary-unavailable")).await; }
                            break;
                        }
                        if ids.contains_key(&id) { close(&proxy,id).await;owner.cancel();let _=events.send(Event::Stopped(owner.clone(),"temporary-unavailable")).await;break; }
                        let (tx,rx) = oneshot::channel();
                        if events.send(Event::Accepted(owner.clone(),notification.clone(),tx)).await.is_err() { close(&proxy,id).await; break; }
                        if !accepted(&owner,rx).await { close(&proxy,id).await; owner.cancel(); break; }
                        ids.insert(id,notification.clone());
                        while seen.len() >= 256 { if let Some(i)=seen.iter().position(|n| !receipts.contains(n)) { seen.remove(i); } else { break; } }
                        seen.push(notification.clone());
                        receipts.push(notification);
                    }
                }
            }
        }
        futures_util::future::join_all(ids.keys().map(|id| close(&proxy, *id))).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_terminal_provider_results_keep_unknown_and_transient_retries() {
        assert!(cleanup_terminal(200, &json!({"unregistered":true})));
        assert!(cleanup_terminal(401, &json!({"code":"unauthorized"})));
        assert!(receipt_terminal(200, &json!({"received":true})));
        assert!(receipt_terminal(
            404,
            &json!({"code":"notification-unavailable"})
        ));
        for (status, value) in [
            (401, json!({"code":"unauthorized","extra":true})),
            (401, json!({"code":"other"})),
            (500, json!({"code":"unauthorized"})),
            (200, json!({"unregistered":false})),
            (404, json!({"code":"notification-unavailable","extra":true})),
            (404, json!({"code":"other"})),
            (503, json!({"code":"notification-unavailable"})),
            (200, json!({"received":false})),
        ] {
            assert!(!cleanup_terminal(status, &value));
            assert!(!receipt_terminal(status, &value));
        }
    }
    fn owner() -> Owner {
        Owner {
            registration: DesktopRegistration {
                session: Session {
                    origin: "https://a.example".into(),
                    token: "token".into(),
                    session_id: "session".into(),
                    user_id: "user".into(),
                    device_id: "device".into(),
                    expires_at: "2026-12-01T00:00:00Z".into(),
                },
                registration_id: "registration".into(),
                seen: Vec::new(),
                receipts: Vec::new(),
                locale: "en".into(),
            },
            gen: 1,
            page: 1,
            handle: "handle".into(),
            clock: Arc::new(AtomicU64::new(1)),
            pages: Arc::new(AtomicU64::new(1)),
            retired: Arc::new(AtomicBool::new(false)),
            wake: Arc::new(Notify::new()),
            locale: Arc::new(RwLock::new("en".into())),
        }
    }
    #[tokio::test]
    async fn cancellation_releases_actor_acceptance_wait_without_a_reply() {
        let owner = owner();
        let captured = owner.clone();
        let (reply, receive) = oneshot::channel();
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _ = started.send(());
            accepted(&captured, receive).await
        });
        ready.await.unwrap();
        owner.cancel();
        assert!(!tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .unwrap()
            .unwrap());
        assert!(reply.send(true).is_err());
    }
    #[tokio::test]
    async fn one_drain_budget_detaches_held_displays_and_reaper_withdraws_late_exact_ids() {
        let mut tasks = Vec::new();
        let mut replies = Vec::new();
        let mut closed = Vec::new();
        for id in [17u32, 23u32] {
            let owner = owner();
            let captured = owner.clone();
            let (reply, hold) = oneshot::channel();
            let (withdraw, confirmation) = oneshot::channel();
            let (started, ready) = oneshot::channel();
            let task = tokio::spawn(async move {
                let shown = async {
                    let _ = started.send(());
                    hold.await.map_err(|_| ())
                };
                assert!(observe_display(&captured, shown, move |actual| async move {
                    let _ = withdraw.send(actual);
                })
                .await
                .is_none());
            });
            ready.await.unwrap();
            owner.cancel();
            tasks.push(tauri::async_runtime::JoinHandle::Tokio(task));
            replies.push((id, reply));
            closed.push(confirmation);
        }
        let start = tokio::time::Instant::now();
        assert!(!drain(tasks, Duration::from_millis(20)).await);
        assert!(start.elapsed() < Duration::from_millis(200));
        for (id, reply) in replies {
            reply.send(id).unwrap();
        }
        for (confirmation, expected) in closed.into_iter().zip([17u32, 23u32]) {
            assert_eq!(
                tokio::time::timeout(Duration::from_secs(1), confirmation)
                    .await
                    .unwrap()
                    .unwrap(),
                expected
            );
        }
    }
    #[test]
    fn strict_opaque_messages_and_targets() {
        assert_eq!(
            messages(
                &json!({"messages":[{"version":"1","notificationId":"n","registrationId":"r"}]}),
                "r"
            )
            .unwrap(),
            vec!["n"]
        );
        for v in [
            json!({"messages":[{"version":"1","notificationId":"n","registrationId":"other"}]}),
            json!({"messages":[{"version":"1","notificationId":"n","registrationId":"r","url":"https://other.test"}]}),
            json!({"messages":[{"version":1,"notificationId":"n","registrationId":"r"}]}),
        ] {
            assert!(messages(&v, "r").is_err());
        }
        assert!(
            target(&json!({"kind":"task","workspaceId":"w","listId":"l","taskId":"t"})).is_ok()
        );
        assert!(target(
            &json!({"kind":"task","workspaceId":"w","listId":"l","taskId":"t","url":"x"})
        )
        .is_err());
    }
}
