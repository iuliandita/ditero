use crate::protocol::{self, Result};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
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
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub evidence: BTreeMap<String, crate::offline::Evidence>,
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
pub(crate) fn native_store() -> keyring_core::Result<Arc<keyring_core::CredentialStore>> {
    #[cfg(target_os = "linux")]
    let store = zbus_secret_service_keyring_store::Store::new()?;
    #[cfg(target_os = "macos")]
    let store = apple_native_keyring_store::keychain::Store::new()?;
    #[cfg(target_os = "windows")]
    let store = windows_native_keyring_store::Store::new()?;
    Ok(store)
}
const SERVICE: &str = "io.ditero.desktop";
const ROOT: &str = "native-sessions-v1";
const JOURNAL: &str = "native-sessions-v2-journal";
const BLOB_LIMIT: usize = 2560;
const REGISTRY_LIMIT: usize = 1024 * 1024;
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Commit {
    version: u8,
    generation: String,
    chunks: usize,
    digest: String,
    pending: bool,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    next: Commit,
    previous: Option<Commit>,
}
fn password(entry: &keyring_core::Entry, value: &impl Serialize) -> Result<()> {
    let raw = serde_json::to_string(value).map_err(|_| "storage-failed")?;
    if raw.encode_utf16().count() * 2 > BLOB_LIMIT {
        return Err("storage-failed");
    }
    entry.set_password(&raw).map_err(|_| "storage-failed")
}
fn delete(entry: &keyring_core::Entry) -> Result<()> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
        Err(_) => Err("storage-failed"),
    }
}
fn delete_chunks(store: &Arc<keyring_core::CredentialStore>, commit: &Commit) -> Result<()> {
    for index in 0..commit.chunks {
        delete(&entry(store, &chunk_name(commit, index))?)?;
    }
    Ok(())
}
fn reclaim(store: &Arc<keyring_core::CredentialStore>, active: Option<&Commit>) -> Result<()> {
    let entry = entry(store, JOURNAL)?;
    let raw = match entry.get_password() {
        Ok(raw) => raw,
        Err(keyring_core::Error::NoEntry) => return Ok(()),
        Err(_) => return Err("vault-unavailable"),
    };
    if raw.encode_utf16().count() * 2 > BLOB_LIMIT {
        return Err("vault-invalid");
    }
    let journal: Journal =
        serde_json::from_value(protocol::parse(&raw).map_err(|_| "vault-invalid")?)
            .map_err(|_| "vault-invalid")?;
    if !valid_commit(&journal.next) || journal.previous.as_ref().is_some_and(|p| !valid_commit(p)) {
        return Err("vault-invalid");
    }
    for commit in [Some(&journal.next), journal.previous.as_ref()]
        .into_iter()
        .flatten()
    {
        if active.is_none_or(|a| a.generation != commit.generation) {
            delete_chunks(store, commit)?;
        }
    }
    delete(&entry)
}
fn entry(store: &Arc<keyring_core::CredentialStore>, name: &str) -> Result<keyring_core::Entry> {
    store
        .build(SERVICE, name, None)
        .map_err(|_| "vault-unavailable")
}
fn chunk_name(commit: &Commit, index: usize) -> String {
    format!("native-sessions-v2-{}-{index}", commit.generation)
}
fn valid_commit(commit: &Commit) -> bool {
    commit.version == 2
        && commit.generation.len() == 32
        && commit.generation.bytes().all(|b| b.is_ascii_hexdigit())
        && (1..=REGISTRY_LIMIT.div_ceil(BLOB_LIMIT)).contains(&commit.chunks)
        && commit.digest.len() == 64
        && commit.digest.bytes().all(|b| b.is_ascii_hexdigit())
}
fn reference(
    mut session: Value,
    credentials: &mut serde_json::Map<String, Value>,
) -> Result<Value> {
    let expiry = session
        .as_object_mut()
        .ok_or("storage-failed")?
        .remove("expires_at")
        .ok_or("storage-failed")?;
    let digest = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&session).map_err(|_| "storage-failed")?)
    );
    credentials.insert(digest.clone(), session);
    Ok(serde_json::json!({"credential":digest,"expires_at":expiry}))
}
fn compact(value: &Registry) -> Result<Vec<u8>> {
    let mut document = serde_json::to_value(value).map_err(|_| "storage-failed")?;
    let mut credentials = serde_json::Map::new();
    for session in document["sessions"]
        .as_object_mut()
        .ok_or("storage-failed")?
        .values_mut()
    {
        *session = reference(session.take(), &mut credentials)?;
    }
    for field in ["evidence", "notifications"] {
        if let Some(records) = document.get_mut(field).and_then(Value::as_object_mut) {
            for record in records.values_mut() {
                let object = record.as_object_mut().ok_or("storage-failed")?;
                let session = object.remove("session").ok_or("storage-failed")?;
                object.insert("session_ref".into(), reference(session, &mut credentials)?);
            }
        }
    }
    for record in document["retired_notifications"]
        .as_array_mut()
        .ok_or("storage-failed")?
    {
        let object = record.as_object_mut().ok_or("storage-failed")?;
        let session = object.remove("session").ok_or("storage-failed")?;
        object.insert("session_ref".into(), reference(session, &mut credentials)?);
    }
    document
        .as_object_mut()
        .ok_or("storage-failed")?
        .insert("credentials".into(), Value::Object(credentials));
    serde_json::to_vec(&document).map_err(|_| "storage-failed")
}
fn expand(mut document: Value) -> Result<Registry> {
    let credentials = document
        .as_object_mut()
        .ok_or("vault-invalid")?
        .remove("credentials")
        .ok_or("vault-invalid")?;
    let credentials = credentials.as_object().ok_or("vault-invalid")?;
    for (digest, session) in credentials {
        if &format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(session).map_err(|_| "vault-invalid")?)
        ) != digest
        {
            return Err("vault-invalid");
        }
    }
    let resolve = |reference: Value| -> Result<Value> {
        let reference = reference
            .as_object()
            .filter(|r| r.len() == 2)
            .ok_or("vault-invalid")?;
        let mut session = credentials
            .get(
                reference
                    .get("credential")
                    .and_then(Value::as_str)
                    .ok_or("vault-invalid")?,
            )
            .cloned()
            .ok_or("vault-invalid")?;
        if session
            .as_object_mut()
            .ok_or("vault-invalid")?
            .insert(
                "expires_at".into(),
                reference.get("expires_at").ok_or("vault-invalid")?.clone(),
            )
            .is_some()
        {
            return Err("vault-invalid");
        }
        Ok(session)
    };
    for session in document["sessions"]
        .as_object_mut()
        .ok_or("vault-invalid")?
        .values_mut()
    {
        *session = resolve(session.take())?;
    }
    for field in ["evidence", "notifications"] {
        if let Some(records) = document.get_mut(field).and_then(Value::as_object_mut) {
            for record in records.values_mut() {
                let object = record.as_object_mut().ok_or("vault-invalid")?;
                let binding = object.remove("session_ref").ok_or("vault-invalid")?;
                if object.insert("session".into(), resolve(binding)?).is_some() {
                    return Err("vault-invalid");
                }
            }
        }
    }
    for record in document["retired_notifications"]
        .as_array_mut()
        .ok_or("vault-invalid")?
    {
        let object = record.as_object_mut().ok_or("vault-invalid")?;
        let binding = object.remove("session_ref").ok_or("vault-invalid")?;
        if object.insert("session".into(), resolve(binding)?).is_some() {
            return Err("vault-invalid");
        }
    }
    serde_json::from_value(document).map_err(|_| "vault-invalid")
}
fn load_from(
    factory: impl FnOnce() -> keyring_core::Result<Arc<keyring_core::CredentialStore>>,
) -> Result<Registry> {
    let store = factory().map_err(|_| "vault-unavailable")?;
    let raw = match entry(&store, ROOT)?.get_password() {
        Ok(v) => v,
        Err(keyring_core::Error::NoEntry) => return Ok(Registry::default()),
        Err(_) => return Err("vault-unavailable"),
    };
    if raw.len() > REGISTRY_LIMIT {
        return Err("vault-invalid");
    }
    let document = protocol::parse(&raw).map_err(|_| "vault-invalid")?;
    let registry = if document.get("version").is_some() {
        let commit: Commit = serde_json::from_value(document).map_err(|_| "vault-invalid")?;
        if !valid_commit(&commit) {
            return Err("vault-invalid");
        }
        let mut bytes = Vec::new();
        for index in 0..commit.chunks {
            let chunk = entry(&store, &chunk_name(&commit, index))?
                .get_secret()
                .map_err(|_| "vault-unavailable")?;
            if chunk.is_empty()
                || chunk.len() > BLOB_LIMIT
                || bytes.len() + chunk.len() > REGISTRY_LIMIT
            {
                return Err("vault-invalid");
            }
            bytes.extend_from_slice(&chunk);
        }
        if format!("{:x}", Sha256::digest(&bytes)) != commit.digest {
            return Err("vault-invalid");
        }
        let mut registry = expand(
            protocol::parse(std::str::from_utf8(&bytes).map_err(|_| "vault-invalid")?)
                .map_err(|_| "vault-invalid")?,
        )?;
        if commit.pending {
            for proof in registry.evidence.values_mut() {
                proof.pending = true;
            }
        }
        registry
    } else {
        let mut legacy: Registry = serde_json::from_value(document).map_err(|_| "vault-invalid")?;
        // Legacy evidence predates complete native refusal fencing. Reverify online.
        legacy.evidence.clear();
        legacy
    };
    if registry
        .selected
        .as_ref()
        .is_some_and(|s| protocol::origin(s).as_ref() != Ok(s))
        || registry
            .sessions
            .iter()
            .any(|(origin, s)| origin != &s.origin || !s.valid())
        || registry.notifications.len() > 64
        || registry.evidence.iter().any(|(origin, proof)| {
            origin != &proof.session.origin
                || !proof.session.valid()
                || !registry
                    .sessions
                    .get(origin)
                    .is_some_and(|s| same_session(s, &proof.session))
        })
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
fn save_to(
    factory: impl FnOnce() -> keyring_core::Result<Arc<keyring_core::CredentialStore>>,
    value: &Registry,
) -> Result<()> {
    let store = factory().map_err(|_| "vault-unavailable")?;
    let root = entry(&store, ROOT)?;
    let previous = match root.get_password() {
        Ok(raw) => serde_json::from_str::<Commit>(&raw)
            .ok()
            .filter(valid_commit),
        Err(keyring_core::Error::NoEntry) => None,
        Err(_) => return Err("vault-unavailable"),
    };
    reclaim(&store, previous.as_ref())?;
    let bytes = compact(value)?;
    if bytes.is_empty() || bytes.len() > REGISTRY_LIMIT {
        return Err("storage-failed");
    }
    let mut random = [0; 16];
    OsRng.fill_bytes(&mut random);
    let mut commit = Commit {
        version: 2,
        generation: random.iter().map(|b| format!("{b:02x}")).collect(),
        chunks: bytes.len().div_ceil(BLOB_LIMIT),
        digest: format!("{:x}", Sha256::digest(&bytes)),
        pending: true,
    };
    let journal = entry(&store, JOURNAL)?;
    password(
        &journal,
        &Journal {
            next: commit.clone(),
            previous: previous.clone(),
        },
    )?;
    for (index, chunk) in bytes.chunks(BLOB_LIMIT).enumerate() {
        // Binary secrets avoid Windows' password-to-UTF-16 expansion.
        entry(&store, &chunk_name(&commit, index))?
            .set_secret(chunk)
            .map_err(|_| "storage-failed")?;
    }
    // Only this bounded pointer publishes the immutable snapshot. Never fall back
    // to older chunks after a missing, corrupt, or inaccessible committed record.
    password(&root, &commit)?;
    if let Some(previous) = previous {
        delete_chunks(&store, &previous)?;
    }
    delete(&journal)?;
    commit.pending = false;
    password(&root, &commit)?;
    Ok(())
}
impl Vault for SystemVault {
    fn load(&self) -> Result<Registry> {
        load_from(native_store)
    }
    fn save(&self, value: &Registry) -> Result<()> {
        save_to(native_store, value)
    }
}
// The protected commit pointer publishes selection and sessions atomically. No files,
// JavaScript vault commands, or plaintext fallback exist.
pub fn remove_session(registry: &mut Registry, captured: &Session) {
    if registry
        .sessions
        .get(&captured.origin)
        .is_some_and(|s| s.session_id == captured.session_id && s.user_id == captured.user_id)
    {
        registry.sessions.remove(&captured.origin);
        registry.evidence.remove(&captured.origin);
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
        registry
            .sessions
            .insert(session.origin.clone(), session.clone());
        let mut proof = crate::offline::Evidence::new(session.clone());
        proof.verified = true;
        proof.name = Some("Alex".into());
        proof.email = Some("alex@example.test".into());
        proof.workspace = Some("workspace".into());
        proof.zero = Some("https://zero.example".into());
        registry.evidence.insert(session.origin.clone(), proof);
        save_to(|| Ok(store.clone()), &registry).unwrap();
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
        assert!(recovered.evidence[&session.origin].ready(&session, 0));
        assert!(serde_json::to_value(Registry::default())
            .unwrap()
            .get("evidence")
            .is_none());
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
    fn worst_registry() -> Registry {
        let mut registry = Registry::default();
        for account in 0..8 {
            let session = Session {
                origin: format!(
                    "https://{}.{}.{}.{}.example",
                    "a".repeat(60),
                    "b".repeat(60),
                    "c".repeat(60),
                    format!("{account}{}", "d".repeat(50))
                ),
                token: format!("{}.{account}.{}", "A".repeat(250), "B".repeat(250)),
                session_id: "s".repeat(128),
                user_id: "u".repeat(128),
                device_id: "d".repeat(128),
                expires_at: "2099-12-01T00:00:00.000Z".into(),
            };
            assert!(session.valid());
            let mut proof = crate::offline::Evidence::new(session.clone());
            proof.verified = true;
            proof.name = Some("😀".repeat(128));
            proof.email = Some(format!("{}@example.test", "e".repeat(499)));
            proof.workspace = Some("w".repeat(128));
            proof.zero = Some(session.origin.clone());
            registry.selected = Some(session.origin.clone());
            registry.evidence.insert(session.origin.clone(), proof);
            registry
                .sessions
                .insert(session.origin.clone(), session.clone());
            let mut notification_session = session.clone();
            notification_session.expires_at = "2099-11-01T00:00:00Z".into();
            registry.notifications.insert(
                session.origin.clone(),
                DesktopRegistration {
                    session: notification_session,
                    registration_id: "r".repeat(128),
                    seen: (0..256).map(|n| format!("{n:0128}")).collect(),
                    receipts: (0..128).map(|n| format!("{n:0128}")).collect(),
                    locale: "ar".into(),
                },
            );
        }
        registry
    }
    #[test]
    fn worst_case_accounts_fit_every_windows_blob_and_evidence_never_duplicates_secrets() {
        let store = keyring_core::mock::Store::new().unwrap();
        let registry = worst_registry();
        save_to(|| Ok(store.clone()), &registry).unwrap();
        let abstract_store: Arc<keyring_core::CredentialStore> = store.clone();
        let root = entry(&abstract_store, ROOT)
            .unwrap()
            .get_password()
            .unwrap();
        assert!(
            root.encode_utf16().count() * 2 <= 2560,
            "Windows password blob exceeds 2560 bytes"
        );
        let commit: Commit = serde_json::from_str(&root).unwrap();
        let mut bytes = Vec::new();
        for index in 0..commit.chunks {
            let chunk = entry(&abstract_store, &chunk_name(&commit, index))
                .unwrap()
                .get_secret()
                .unwrap();
            assert!(
                chunk.len() <= 2560,
                "Windows binary blob exceeds 2560 bytes"
            );
            bytes.extend(chunk);
        }
        let document: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["credentials"].as_object().unwrap().len(), 8);
        let encoded = String::from_utf8(bytes.clone()).unwrap();
        for session in registry.sessions.values() {
            assert_eq!(
                encoded.matches(&session.token).count(),
                1,
                "credential duplicated in protected snapshot"
            );
        }
        for proof in document["evidence"].as_object().unwrap().values() {
            assert!(proof.get("session").is_none());
            assert_eq!(
                proof["session_ref"]["credential"].as_str().unwrap().len(),
                64
            );
        }
        let loaded = load_from(|| Ok(store.clone())).unwrap();
        assert_eq!(loaded.sessions.len(), 8);
        for (origin, session) in &loaded.sessions {
            assert!(loaded.evidence[origin].ready(session, 0));
            assert_eq!(session.token, registry.sessions[origin].token);
        }
        // Rebinding the protected evidence to a different retained session fails closed.
        let mut changed = document;
        let origin = loaded.selected.as_ref().unwrap();
        let binding = changed["sessions"][origin]["credential"]
            .as_str()
            .unwrap()
            .to_owned();
        changed["credentials"][&binding]["token"] = Value::String("replacement".into());
        assert!(matches!(expand(changed), Err("vault-invalid")));
    }
    #[test]
    fn legacy_upgrade_requires_online_evidence_and_incomplete_commits_never_restore_it() {
        let store = keyring_core::mock::Store::new().unwrap();
        let abstract_store: Arc<keyring_core::CredentialStore> = store.clone();
        let root = entry(&abstract_store, ROOT).unwrap();
        let mut registry = worst_registry();
        for round_one in [false, true] {
            let mut legacy = registry.clone();
            if !round_one {
                legacy.evidence.clear();
            }
            root.set_password(&serde_json::to_string(&legacy).unwrap())
                .unwrap();
            let migrated = load_from(|| Ok(store.clone())).unwrap();
            assert_eq!(migrated.sessions.len(), 8);
            assert_eq!(migrated.selected, legacy.selected);
            assert!(migrated.evidence.is_empty());
            save_to(|| Ok(store.clone()), &migrated).unwrap();
            assert!(load_from(|| Ok(store.clone())).unwrap().evidence.is_empty());
        }
        save_to(|| Ok(store.clone()), &registry).unwrap();
        let commit: Commit = serde_json::from_str(&root.get_password().unwrap()).unwrap();
        entry(&abstract_store, &chunk_name(&commit, 0))
            .unwrap()
            .as_any()
            .downcast_ref::<keyring_core::mock::Cred>()
            .unwrap()
            .set_error(keyring_core::Error::NoDefaultStore);
        registry.selected = None;
        assert_eq!(
            save_to(|| Ok(store.clone()), &registry),
            Err("storage-failed")
        );
        let recovered = load_from(|| Ok(store.clone())).unwrap();
        assert_eq!(recovered.sessions.len(), 8);
        assert!(recovered.evidence.values().all(|p| p.pending));
        let journal_entry = entry(&abstract_store, JOURNAL).unwrap();
        let journal = journal_entry.get_password().unwrap();
        assert!(journal.encode_utf16().count() * 2 <= 2560);
        save_to(|| Ok(store.clone()), &recovered).unwrap();
        assert!(matches!(
            journal_entry.get_password(),
            Err(keyring_core::Error::NoEntry)
        ));
        assert!(matches!(
            entry(&abstract_store, &chunk_name(&commit, 0))
                .unwrap()
                .get_secret(),
            Err(keyring_core::Error::NoEntry)
        ));
        let current: Commit = serde_json::from_str(&root.get_password().unwrap()).unwrap();
        let abandoned = Commit {
            version: 2,
            generation: "f".repeat(32),
            chunks: 1,
            digest: format!("{:x}", Sha256::digest(b"orphan")),
            pending: true,
        };
        password(
            &journal_entry,
            &Journal {
                next: abandoned.clone(),
                previous: Some(current),
            },
        )
        .unwrap();
        entry(&abstract_store, &chunk_name(&abandoned, 0))
            .unwrap()
            .set_secret(b"orphan")
            .unwrap();
        save_to(|| Ok(store.clone()), &recovered).unwrap();
        assert!(matches!(
            entry(&abstract_store, &chunk_name(&abandoned, 0))
                .unwrap()
                .get_secret(),
            Err(keyring_core::Error::NoEntry)
        ));
        assert!(load_from(|| Ok(store.clone()))
            .unwrap()
            .evidence
            .values()
            .all(|p| p.pending));
        let current: Commit = serde_json::from_str(&root.get_password().unwrap()).unwrap();
        entry(&abstract_store, &chunk_name(&current, 0))
            .unwrap()
            .delete_credential()
            .unwrap();
        assert!(matches!(
            load_from(|| Ok(store.clone())),
            Err("vault-unavailable")
        ));
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
