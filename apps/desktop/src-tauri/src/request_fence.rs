use crate::{offline, protocol::Result, vault::Session};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Factory = dyn Fn() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> + Send + Sync;
#[derive(Default)]
struct State {
    active: usize,
    blocked: bool,
    refusals: u64,
}
pub struct Fences {
    factory: Box<Factory>,
    states: Mutex<HashMap<String, State>>,
}
pub struct Request {
    fences: Arc<Fences>,
    key: String,
    completed: bool,
}
pub fn binding(session: &Session) -> String {
    format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&(
                &session.origin,
                &session.user_id,
                &session.device_id,
                &session.session_id,
                &session.token
            ))
            .expect("session serialization")
        )
    )
}
impl Fences {
    pub fn new(
        factory: impl Fn() -> keyring_core::Result<Arc<keyring_core::CredentialStore>>
            + Send
            + Sync
            + 'static,
    ) -> Arc<Self> {
        Arc::new(Self {
            factory: Box::new(factory),
            states: Mutex::new(HashMap::new()),
        })
    }
    fn entry(&self, key: &str) -> Result<keyring_core::Entry> {
        (self.factory)()
            .and_then(|s| {
                s.build(
                    "io.ditero.desktop",
                    &format!("request-fence-v1-{key}"),
                    None,
                )
            })
            .map_err(|_| "vault-unavailable")
    }
    pub fn allowed(&self, session: &Session) -> bool {
        self.entry(&binding(session))
            .is_ok_and(|e| matches!(e.get_secret(), Err(keyring_core::Error::NoEntry)))
    }
    pub fn begin(self: &Arc<Self>, session: &Session) -> Result<Request> {
        let key = binding(session);
        let mut states = self.states.lock().map_err(|_| "storage-failed")?;
        let entry = self.entry(&key)?;
        let state = states.entry(key.clone()).or_insert_with(|| State {
            active: 0,
            blocked: !self.allowed(session),
            refusals: 0,
        });
        // Persist before network I/O. A refusal needs no subsequent successful write.
        entry.set_secret(b"pending").map_err(|_| "storage-failed")?;
        state.active += 1;
        Ok(Request {
            fences: self.clone(),
            key,
            completed: false,
        })
    }
    pub fn refuse(&self, session: &Session) -> Result<()> {
        let key = binding(session);
        let mut states = self.states.lock().map_err(|_| "storage-failed")?;
        let state = states.entry(key.clone()).or_default();
        state.blocked = true;
        state.refusals += 1;
        self.entry(&key)?
            .set_secret(b"refused")
            .map_err(|_| "storage-failed")
    }
    pub fn revision(&self, session: &Session) -> Result<u64> {
        Ok(self
            .states
            .lock()
            .map_err(|_| "storage-failed")?
            .get(&binding(session))
            .map_or(0, |s| s.refusals))
    }
    pub fn verified(&self, session: &Session, revision: u64) -> Result<()> {
        let key = binding(session);
        let mut states = self.states.lock().map_err(|_| "storage-failed")?;
        let state = states.entry(key.clone()).or_default();
        if state.refusals != revision {
            return Err("session-refused");
        }
        if state.active == 0 {
            delete(&self.entry(&key)?)?;
        }
        state.blocked = false;
        Ok(())
    }
    pub async fn send(
        self: &Arc<Self>,
        session: &Session,
        request: reqwest::RequestBuilder,
    ) -> Result<reqwest::Response> {
        let guard = self.begin(session)?;
        let result = request.send().await;
        guard.complete(match &result {
            Ok(response) => !matches!(response.status().as_u16(), 401 | 403),
            Err(error) => offline::transport_error(error) == "network",
        })?;
        result.map_err(|e| offline::transport_error(&e))
    }
}
fn delete(entry: &keyring_core::Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(_) => Err("storage-failed"),
    }
}
impl Request {
    pub fn complete(mut self, safe: bool) -> Result<()> {
        let mut states = self.fences.states.lock().map_err(|_| "storage-failed")?;
        let state = states.get_mut(&self.key).ok_or("storage-failed")?;
        state.active -= 1;
        state.blocked |= !safe;
        if !safe {
            state.refusals += 1;
        }
        self.completed = true;
        if state.active == 0 && !state.blocked {
            state.blocked = true;
            delete(&self.fences.entry(&self.key)?)?;
            state.blocked = false;
        }
        Ok(())
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        if !self.completed {
            if let Ok(mut states) = self.fences.states.lock() {
                if let Some(state) = states.get_mut(&self.key) {
                    state.active -= 1;
                    state.blocked = true;
                    state.refusals += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> Session {
        Session {
            origin: "https://a.example".into(),
            user_id: "user".into(),
            device_id: "device".into(),
            session_id: "session".into(),
            token: "secret".into(),
            expires_at: "2099-01-01T00:00:00Z".into(),
        }
    }
    #[test]
    fn preflight_fence_survives_refusal_storage_failure_overlap_and_restart() {
        let store = keyring_core::mock::Store::new().unwrap();
        let factory_store = store.clone();
        let fences = Fences::new(move || Ok(factory_store.clone()));
        let s = session();
        assert!(fences.allowed(&s));
        let refused = fences.begin(&s).unwrap();
        let concurrent = fences.begin(&s).unwrap();
        assert!(!fences.allowed(&s));
        let entry = fences.entry(&binding(&s)).unwrap();
        entry
            .as_any()
            .downcast_ref::<keyring_core::mock::Cred>()
            .unwrap()
            .set_error(keyring_core::Error::NoDefaultStore);
        assert!(fences.refuse(&s).is_err());
        refused.complete(false).unwrap();
        concurrent.complete(true).unwrap();
        let restarted = Fences::new(move || Ok(store.clone()));
        assert!(!restarted.allowed(&s));
        let mut refreshed_expiry = s.clone();
        refreshed_expiry.expires_at = "2099-02-01T00:00:00Z".into();
        assert!(!restarted.allowed(&refreshed_expiry));
        restarted.begin(&s).unwrap().complete(true).unwrap();
        assert!(
            !restarted.allowed(&s),
            "ordinary success cannot recover a refusal"
        );
        restarted
            .verified(&s, restarted.revision(&s).unwrap())
            .unwrap();
        assert!(restarted.allowed(&s));
        let revision = restarted.revision(&s).unwrap();
        let interrupted = restarted.begin(&s).unwrap();
        drop(interrupted);
        assert!(!restarted.allowed(&s));
        assert_eq!(restarted.verified(&s, revision), Err("session-refused"));
        assert!(!restarted.allowed(&s));
    }
    #[tokio::test]
    async fn native_http_refusals_are_fenced_before_body_parsing_for_every_status() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        for status in [200, 401, 403] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 4096];
                stream.read(&mut request).unwrap();
                write!(stream, "HTTP/1.1 {status} Response\r\nContent-Length: 7\r\nConnection: close\r\n\r\ninvalid").unwrap();
            });
            let store = keyring_core::mock::Store::new().unwrap();
            let fences = Fences::new(move || Ok(store.clone()));
            let s = session();
            let response = fences
                .send(&s, reqwest::Client::new().get(format!("http://{address}")))
                .await
                .unwrap();
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(fences.allowed(&s), status == 200);
            server.join().unwrap();
        }
        let unavailable = Fences::new(|| Err(keyring_core::Error::NoDefaultStore));
        assert!(matches!(
            unavailable
                .send(&session(), reqwest::Client::new().get("http://127.0.0.1:1"))
                .await,
            Err("vault-unavailable")
        ));
    }
}
