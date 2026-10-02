use crate::protocol::{self, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, sync::Arc};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Session {
    pub origin: String,
    pub token: String,
    pub session_id: String,
    pub user_id: String,
    pub device_id: String,
    pub expires_at: String,
}
impl Session {
    pub fn scope(&self) -> String {
        protocol::scope(&self.origin, &self.user_id)
    }
    pub fn valid(&self) -> bool {
        protocol::origin(&self.origin).as_ref() == Ok(&self.origin)
            && protocol::id(&self.session_id)
            && protocol::id(&self.user_id)
            && protocol::id(&self.device_id)
            && !self.token.is_empty()
            && self.token.len() <= 512
            && self
                .token
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-._~+/=".contains(&b))
            && valid_expiry(&self.expires_at)
    }
}
pub fn valid_expiry(s: &str) -> bool {
    s.len() >= 20
        && s.len() <= 40
        && s.ends_with('Z')
        && s.bytes()
            .all(|b| b.is_ascii_digit() || b"-T:.Z".contains(&b))
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Registry {
    pub selected: Option<String>,
    pub sessions: BTreeMap<String, Session>,
    #[serde(default)]
    pub notifications: BTreeMap<String, DesktopRegistration>,
    #[serde(default)]
    pub retired_notifications: Vec<DesktopRegistration>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopRegistration {
    pub session: Session,
    pub registration_id: String,
    #[serde(default)]
    pub seen: Vec<String>,
    #[serde(default)]
    pub receipts: Vec<String>,
    #[serde(default = "default_locale")]
    pub locale: String,
}
fn default_locale() -> String {
    "en".into()
}
impl DesktopRegistration {
    pub fn valid(&self) -> bool {
        self.session.valid()
            && protocol::id(&self.registration_id)
            && self.seen.len() <= 256
            && self.receipts.len() <= 128
            && self.seen.iter().all(|id| protocol::id(id))
            && self
                .receipts
                .iter()
                .all(|id| protocol::id(id) && self.seen.contains(id))
            && matches!(
                self.locale.as_str(),
                "en" | "de" | "es" | "fr" | "ro" | "ar"
            )
    }
}
pub fn same_session(a: &Session, b: &Session) -> bool {
    a.origin == b.origin
        && a.user_id == b.user_id
        && a.session_id == b.session_id
        && a.device_id == b.device_id
        && a.token == b.token
}
pub trait Vault: Send + Sync {
    fn load(&self) -> Result<Registry>;
    fn save(&self, value: &Registry) -> Result<()>;
}
pub struct SystemVault;
fn native_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    #[cfg(target_os = "linux")]
    let store = zbus_secret_service_keyring_store::Store::new()?;
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new()?;
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new()?;
    Ok(store)
}
fn entry_from(
    factory: impl FnOnce() -> keyring_core::Result<Arc<keyring_core::CredentialStore>>,
) -> Result<keyring_core::Entry> {
    // Reconnect on every operation. The convenience keyring wrapper permanently
    // caches initial connection failures, so UI retry cannot recover through it.
    factory()
        .and_then(|store| store.build("io.ditero.desktop", "native-sessions-v1", None))
        .map_err(|_| "vault-unavailable")
}
fn load_from(
    factory: impl FnOnce() -> keyring_core::Result<Arc<keyring_core::CredentialStore>>,
) -> Result<Registry> {
    let entry = entry_from(factory)?;
    let raw = match entry.get_password() {
        Ok(v) => v,
        Err(keyring_core::Error::NoEntry) => return Ok(Registry::default()),
        Err(_) => return Err("vault-unavailable"),
    };
    if raw.len() > 1024 * 1024 {
        return Err("vault-invalid");
    }
    let strict = protocol::parse(&raw).map_err(|_| "vault-invalid")?;
    let registry: Registry = serde_json::from_value(strict).map_err(|_| "vault-invalid")?;
    if registry
        .selected
        .as_ref()
        .is_some_and(|s| protocol::origin(s).as_ref() != Ok(s))
        || registry
            .sessions
            .iter()
            .any(|(origin, s)| origin != &s.origin || !s.valid())
        || registry.notifications.len() > 64
        || registry.retired_notifications.len() > 64
        || registry
            .notifications
            .iter()
            .any(|(origin, r)| origin != &r.session.origin || !r.valid())
        || registry.retired_notifications.iter().any(|r| !r.valid())
    {
        return Err("vault-invalid");
    }
    Ok(registry)
}
impl Vault for SystemVault {
    fn load(&self) -> Result<Registry> {
        load_from(native_store)
    }
    fn save(&self, value: &Registry) -> Result<()> {
        let raw = serde_json::to_string(value).map_err(|_| "storage-failed")?;
        if raw.len() > 1024 * 1024 {
            return Err("storage-failed");
        }
        entry_from(native_store)?
            .set_password(&raw)
            .map_err(|_| "storage-failed")
    }
}
// A single protected vault record commits selection and session changes together. No files,
// JavaScript vault commands, or plaintext fallback exist.
pub fn remove_session(registry: &mut Registry, captured: &Session) {
    if registry
        .sessions
        .get(&captured.origin)
        .is_some_and(|s| s.session_id == captured.session_id && s.user_id == captured.user_id)
    {
        registry.sessions.remove(&captured.origin);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retry_reconnects_after_initial_failure_without_losing_the_existing_record() {
        use keyring_core::api::CredentialStoreApi;
        use std::cell::Cell;
        let store = keyring_core::mock::Store::new().unwrap();
        let entry = store
            .build("io.ditero.desktop", "native-sessions-v1", None)
            .unwrap();
        let mut registry = Registry {
            selected: Some("https://a.example".into()),
            ..Registry::default()
        };
        let session = Session {
            origin: "https://a.example".into(),
            token: "protected-secret".into(),
            session_id: "s1".into(),
            user_id: "u1".into(),
            device_id: "d1".into(),
            expires_at: "2026-12-01T00:00:00Z".into(),
        };
        registry.sessions.insert(session.origin.clone(), session);
        entry
            .set_password(&serde_json::to_string(&registry).unwrap())
            .unwrap();
        let attempts = Cell::new(0);
        let factory = || -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
            attempts.set(attempts.get() + 1);
            if attempts.get() == 1 {
                Err(keyring_core::Error::NoDefaultStore)
            } else {
                Ok(store.clone())
            }
        };
        assert!(matches!(load_from(factory), Err("vault-unavailable")));
        let recovered = load_from(factory).unwrap();
        assert_eq!(attempts.get(), 2);
        assert_eq!(recovered.selected, registry.selected);
        assert_eq!(
            recovered.sessions["https://a.example"].token,
            "protected-secret"
        );
        entry
            .as_any()
            .downcast_ref::<keyring_core::mock::Cred>()
            .unwrap()
            .set_error(keyring_core::Error::NoDefaultStore);
        assert!(matches!(load_from(factory), Err("vault-unavailable")));
        assert_eq!(
            load_from(factory).unwrap().sessions["https://a.example"].token,
            "protected-secret"
        );
        assert_eq!(attempts.get(), 4);
    }
    #[test]
    fn captured_logout_preserves_other_server_and_replacement_account() {
        let mut r = Registry::default();
        let make = |origin: &str, user: &str| Session {
            origin: origin.into(),
            token: "secret".into(),
            session_id: user.into(),
            user_id: user.into(),
            device_id: "d1".into(),
            expires_at: "2026-12-01T00:00:00Z".into(),
        };
        let old = make("https://a.example", "u1");
        r.sessions
            .insert(old.origin.clone(), make("https://a.example", "u2"));
        r.sessions
            .insert("https://b.example".into(), make("https://b.example", "u1"));
        remove_session(&mut r, &old);
        assert_eq!(r.sessions.len(), 2);
        let current = r.sessions["https://a.example"].clone();
        remove_session(&mut r, &current);
        assert_eq!(r.sessions.len(), 1);
        assert_eq!(r.sessions["https://b.example"].user_id, "u1");
    }
}
