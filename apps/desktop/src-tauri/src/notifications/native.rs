use super::*;
use rand::{distributions::Alphanumeric, Rng};
use std::collections::HashMap;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
use windows as platform;

pub use platform::{initialize, permission};

pub enum Response {
    Action(String),
    Failed(String),
}

fn random_id() -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(8)
        .map(char::from)
        .collect()
}

pub async fn run(
    owner: Owner,
    http: reqwest::Client,
    events: mpsc::Sender<Event>,
    fences: Arc<crate::request_fence::Fences>,
) {
    let (send, mut responses) = mpsc::channel(64);
    let prefix = random_id();
    let backend = match platform::Backend::new(owner.clone(), send, prefix.clone()) {
        Ok(backend) => backend,
        Err(state) => {
            let _ = events.send(Event::State(owner, state)).await;
            return;
        }
    };
    let mut shown: HashMap<String, (String, platform::Display, std::time::Instant)> =
        HashMap::new();
    let mut receipts = owner.registration.receipts.clone();
    let mut seen = owner.registration.seen.clone();
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    while owner.current() {
        tokio::select! {
            _ = owner.wake.notified() => { if !owner.current() { break; } }
            response = responses.recv() => {
                match response {
                    Some(Response::Action(id)) => {
                        if let Some((notification, display, _)) = shown.remove(&id) {
                            backend.close(&id, display);
                            if owner.current() { let _ = events.send(Event::Action(owner.clone(), notification)).await; }
                        }
                    }
                    Some(Response::Failed(id)) => {
                        if let Some((_, display, _)) = shown.remove(&id) { backend.close(&id, display); }
                        let state = permission(false).await.err().unwrap_or("temporary-unavailable");
                        let _ = events.send(Event::State(owner.clone(), state)).await;
                        break;
                    }
                    None => break,
                }
            }
            _ = tick.tick() => {
                if !owner.current() { break; }
                let expired: Vec<_> = shown.iter().filter(|(_, (_, _, time))| time.elapsed() >= Duration::from_secs(300)).map(|(id, _)| id.clone()).collect();
                for id in expired {
                    if let Some((_, display, _)) = shown.remove(&id) { backend.close(&id, display); }
                }
                if let Err(state) = permission(false).await {
                    let _ = events.send(Event::State(owner.clone(),state)).await;
                    break;
                }
                for notification in receipts.clone() {
                    if !owner.current() { break; }
                    let result = request(&fences,&http,&owner.registration.session,"receipt",Some(json!({"registrationId":owner.registration.registration_id,"notificationId":notification}))).await;
                    if !owner.current() { break; }
                    if result.is_ok_and(|(status,v)| receipt_terminal(status,&v)) {
                        receipts.retain(|id| id != &notification);
                        let _ = events.send(Event::Received(owner.clone(),notification)).await;
                    }
                }
                if !owner.current() { break; }
                let result = request(&fences,&http,&owner.registration.session,"poll",Some(json!({"registrationId":owner.registration.registration_id}))).await;
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
                    let body = match notification_copy(&owner) { Ok((body,_))=>body,Err(state)=>{ let _=events.send(Event::State(owner.clone(),state)).await;break; } };
                    // The OS receives only generic copy and a fresh opaque identifier, never account data.
                    let id = format!("{prefix}{}",random_id());
                    let display = match backend.show(&id,body).await {
                        Ok(display) => display,
                        Err(state) => { let _=events.send(Event::State(owner.clone(),state)).await;break; }
                    };
                    if !owner.current() { backend.close(&id,display); break; }
                    let (tx,rx) = oneshot::channel();
                    if events.send(Event::Accepted(owner.clone(),notification.clone(),tx)).await.is_err() || !accepted(&owner,rx).await {
                        backend.close(&id,display); owner.cancel(); break;
                    }
                    // Keep OS handles and their callbacks bounded even when the user never dismisses them.
                    if shown.len() >= 32 {
                        if let Some(old) = shown.keys().next().cloned() {
                            if let Some((_, display, _)) = shown.remove(&old) { backend.close(&old,display); }
                        }
                    }
                    shown.insert(id,(notification.clone(),display,std::time::Instant::now()));
                    while seen.len() >= 256 { if let Some(i)=seen.iter().position(|n| !receipts.contains(n)) { seen.remove(i); } else { break; } }
                    seen.push(notification.clone());
                    receipts.push(notification);
                }
            }
        }
    }
    for (id, (_, display, _)) in shown {
        backend.close(&id, display);
    }
}
