use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Map, Value};
use std::{fmt, sync::LazyLock};
use url::Url;

pub type Result<T> = std::result::Result<T, &'static str>;
pub const MAX_BODY: usize = 64 * 1024;
pub const MAX_SEND: usize = 1024 * 1024;
pub const HANDLE_BYTES: usize = 576;
static ID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$").unwrap());
static CREDENTIAL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)auth|cookie|token|secret|session|bearer|key|jwt|credential|origin").unwrap()
});
pub fn id(s: &str) -> bool {
    ID.is_match(s) && s != "." && s != ".."
}
pub fn canonical_id(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub fn string<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or("invalid-response")
}
pub fn plain(s: &str) -> bool {
    s.bytes()
        .all(|b| b > 32 && b < 127 && !b"\\@?#%".contains(&b))
}
fn authority(raw: &str) -> Result<String> {
    let mut parts = raw.split(':');
    let host = parts.next().unwrap_or("").to_ascii_lowercase();
    let port = parts.next();
    if parts.next().is_some()
        || host.len() > 253
        || host.split('.').any(|label| {
            label.is_empty()
                || label.len() > 63
                || !label.as_bytes()[0].is_ascii_alphanumeric()
                || !label.as_bytes()[label.len() - 1].is_ascii_alphanumeric()
                || !label
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        })
    {
        return Err("invalid-origin");
    }
    let port = match port {
        Some(p) if !p.starts_with('0') && p.bytes().all(|b| b.is_ascii_digit()) => p
            .parse::<u16>()
            .ok()
            .filter(|p| *p > 0)
            .ok_or("invalid-origin")?,
        Some(_) => return Err("invalid-origin"),
        None => 443,
    };
    Ok(format!(
        "{host}{}",
        if port == 443 {
            String::new()
        } else {
            format!(":{port}")
        }
    ))
}
pub fn origin(raw: &str) -> Result<String> {
    if raw.len() > 255
        || !plain(raw)
        || !raw
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
    {
        return Err("invalid-origin");
    }
    let rest = raw[8..].strip_suffix('/').unwrap_or(&raw[8..]);
    if rest.contains('/') {
        return Err("invalid-origin");
    }
    Ok(format!("https://{}", authority(rest)?))
}
pub fn endpoint(raw: &str) -> Result<String> {
    if raw.len() > 255
        || !plain(raw)
        || !raw
            .get(..8)
            .is_some_and(|p| p.eq_ignore_ascii_case("https://"))
    {
        return Err("invalid-config");
    }
    let (host, path) = raw[8..]
        .split_once('/')
        .map(|(h, p)| (h, format!("/{}", p.trim_end_matches('/'))))
        .unwrap_or((&raw[8..], String::new()));
    let path = path.trim_end_matches('/');
    if path.contains("/.")
        || !path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._~-".contains(&b))
    {
        return Err("invalid-config");
    }
    Ok(format!(
        "https://{}{path}",
        authority(host).map_err(|_| "invalid-config")?
    ))
}
pub fn scope(origin: &str, user: &str) -> String {
    format!("native:{}", json!([origin, user]))
}
pub fn socket_target(raw: &str, zero: &str) -> Result<String> {
    if raw.len() > 4096 {
        return Err("invalid-url");
    }
    let target = Url::parse(raw).map_err(|_| "invalid-url")?;
    let expected = format!("wss:{}/sync/v51/connect", &zero[6..]);
    let fixed = Url::parse(&expected).map_err(|_| "invalid-url")?;
    if target.scheme() != "wss"
        || !target.username().is_empty()
        || target.password().is_some()
        || target.fragment().is_some()
        || target.host_str() != fixed.host_str()
        || target.port_or_known_default() != fixed.port_or_known_default()
        || target.path() != fixed.path()
    {
        return Err("invalid-url");
    }
    // Reject normalized paths and percent-encoded authorities as well as credential query names.
    let before_query = raw.split('?').next().unwrap_or("");
    if before_query != expected {
        return Err("invalid-url");
    }
    let mut saw_cookie = false;
    if let Some(query) = target.query() {
        if !query
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"%._~=&+*!-".contains(&b))
        {
            return Err("invalid-url");
        }
        for pair in query.split('&') {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            if key == "baseCookie" {
                if saw_cookie
                    || !pair.contains('=')
                    || value.len() > 128
                    || !Regex::new(r"^(?:[0-9a-z]+(?:\.[0-9a-z]+)?(?:%3[Aa][0-9a-z]+)?)?$")
                        .unwrap()
                        .is_match(value)
                {
                    return Err("invalid-url");
                }
                saw_cookie = true;
            } else if key.is_empty()
                || key.len() > 64
                || !key
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
                || CREDENTIAL.is_match(key)
            {
                return Err("invalid-url");
            }
        }
    }
    Ok(raw.to_string())
}
pub fn validate_init(v: &Value, origin: &str, handle: &str, jwt: &str) -> Result<()> {
    let a = v.as_array().ok_or("invalid-callback")?;
    if a.len() != 2 || a[0] != "initConnection" {
        return Err("invalid-callback");
    }
    let body = a[1].as_object().ok_or("invalid-callback")?;
    for (key, path) in [
        ("userPushURL", "/api/zero/mutate"),
        ("userQueryURL", "/api/zero/query"),
    ] {
        if body
            .get(key)
            .is_some_and(|v| v.as_str() != Some(format!("{origin}{path}").as_str()))
        {
            return Err("invalid-callback");
        }
    }
    for key in ["userPushHeaders", "userQueryHeaders"] {
        if let Some(headers) = body.get(key) {
            let h = headers.as_object().ok_or("invalid-callback")?;
            if h.len() > 8 {
                return Err("invalid-callback");
            }
            for (name, value) in h {
                let value = value.as_str().ok_or("invalid-callback")?;
                if name.is_empty()
                    || name.len() > 64
                    || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || CREDENTIAL.is_match(name)
                    || value.len() > 256
                    || value.chars().any(|c| c < ' ' || c == '\u{7f}')
                    || value.to_ascii_lowercase().starts_with("bearer ")
                    || value.contains(handle)
                    || value.contains(jwt)
                {
                    return Err("invalid-callback");
                }
            }
        }
    }
    Ok(())
}
pub fn splice_protocol(encoded: &str, origin: &str, handle: &str, jwt: &str) -> Result<String> {
    if encoded.is_empty()
        || encoded.len() > MAX_BODY
        || !encoded
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"%._~!*'()-".contains(&b))
    {
        return Err("invalid-protocol");
    }
    let b64 = encoded
        .replace("%2B", "+")
        .replace("%2F", "/")
        .replace("%3D", "=")
        .replace("%2b", "+")
        .replace("%2f", "/")
        .replace("%3d", "=");
    let bytes = STANDARD.decode(&b64).map_err(|_| "invalid-protocol")?;
    if STANDARD.encode(&bytes) != b64 {
        return Err("invalid-protocol");
    }
    let raw = String::from_utf8(bytes).map_err(|_| "invalid-protocol")?;
    let v = parse(&raw)?;
    let map = v.as_object().ok_or("invalid-protocol")?;
    if map
        .keys()
        .any(|k| k != "authToken" && k != "initConnectionMessage")
        || string(&v, "authToken")? != handle
    {
        return Err("invalid-auth-handle");
    }
    let suffix = format!("\"authToken\":\"{handle}\"}}");
    let prefix = raw.strip_suffix(&suffix).ok_or("invalid-protocol")?;
    if let Some(init) = map.get("initConnectionMessage") {
        if !prefix.starts_with("{\"initConnectionMessage\":") || !prefix.ends_with(',') {
            return Err("invalid-protocol");
        }
        validate_init(init, origin, handle, jwt)?;
    } else if prefix != "{" {
        return Err("invalid-protocol");
    }
    Ok(STANDARD
        .encode(format!("{prefix}\"authToken\":\"{jwt}\"}}"))
        .replace('+', "%2B")
        .replace('/', "%2F")
        .replace('=', "%3D"))
}
pub fn filter_frame(raw: &str, origin: &str, handle: &str, jwt: &str) -> Result<String> {
    let v = parse(raw)?;
    let a = v
        .as_array()
        .filter(|a| !a.is_empty())
        .ok_or("invalid-frame")?;
    let name = a[0].as_str().ok_or("invalid-frame")?;
    if name.is_empty() || name.len() > 32 || !name.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Err("invalid-frame");
    }
    if name == "updateAuth" {
        if raw != format!("[\"updateAuth\",{{\"auth\":\"{handle}\"}}]") {
            return Err("invalid-auth-update");
        }
        return Ok(format!("[\"updateAuth\",{{\"auth\":\"{jwt}\"}}]"));
    }
    if name == "initConnection" {
        validate_init(&v, origin, handle, jwt)?;
    }
    Ok(raw.to_string())
}
// Reject duplicates at every depth, rather than serde_json::Value's last-key-wins default.
struct Strict(usize);
impl<'de> DeserializeSeed<'de> for Strict {
    type Value = Value;
    fn deserialize<D: de::Deserializer<'de>>(self, d: D) -> std::result::Result<Value, D::Error> {
        if self.0 > 24 {
            return Err(de::Error::custom("depth"));
        }
        d.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Strict {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: de::Error>(self, v: bool) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_i64<E: de::Error>(self, v: i64) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_u64<E: de::Error>(self, v: u64) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_f64<E: de::Error>(self, v: f64) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_str<E: de::Error>(self, v: &str) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_string<E: de::Error>(self, v: String) -> std::result::Result<Value, E> {
        Ok(json!(v))
    }
    fn visit_unit<E: de::Error>(self) -> std::result::Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut out = Vec::new();
        while let Some(v) = a.next_element_seed(Strict(self.0 + 1))? {
            out.push(v);
        }
        Ok(Value::Array(out))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> std::result::Result<Value, A::Error> {
        let mut out = Map::new();
        while let Some(k) = a.next_key::<String>()? {
            if out.contains_key(&k) {
                return Err(de::Error::custom("duplicate"));
            }
            out.insert(k, a.next_value_seed(Strict(self.0 + 1))?);
        }
        Ok(Value::Object(out))
    }
}
pub fn parse(raw: &str) -> Result<Value> {
    let mut d = serde_json::Deserializer::from_str(raw);
    let v = Strict(0).deserialize(&mut d).map_err(|_| "invalid-json")?;
    d.end().map_err(|_| "invalid-json")?;
    Ok(v)
}

pub fn e2e(v: &Value) -> Result<(bool, String, Option<String>)> {
    let op = string(v, "op")?;
    let (post, path, has_id, fields): (bool, &str, bool, &[&str]) = match op {
        "e2e.memberKeys" => (false, "/members/{id}/keys", true, &[]),
        "e2e.workspaceRotate" => (
            true,
            "/workspaces/{id}/rotate",
            true,
            &["previousVersion", "commitment", "grants"],
        ),
        "e2e.identity" => (false, "/identity", false, &[]),
        "e2e.enroll" => (
            true,
            "/enroll",
            false,
            &[
                "publicKey",
                "passphraseWrapped",
                "recoveryWrapped",
                "passphraseSalt",
                "recoverySalt",
                "formatVersion",
            ],
        ),
        "e2e.recovery" => (false, "/identity/recovery", false, &[]),
        "e2e.rewrap" => (
            true,
            "/rewrap",
            false,
            &["passphrase", "recovery", "formatVersion"],
        ),
        "e2e.identityRotate" => (
            true,
            "/identity/rotate",
            false,
            &[
                "publicKey",
                "previousPublicKey",
                "passphraseWrapped",
                "recoveryWrapped",
                "passphraseSalt",
                "recoverySalt",
                "formatVersion",
                "rewraps",
            ],
        ),
        "e2e.provisionPending" => (false, "/provision/pending", false, &[]),
        "e2e.provision" => (
            true,
            "/provision",
            false,
            &[
                "workspaceId",
                "recipientPublicKey",
                "commitment",
                "enc",
                "ciphertext",
            ],
        ),
        "e2e.keysMine" => (false, "/keys/mine", false, &[]),
        "e2e.grantsPending" => (false, "/grants/pending", false, &[]),
        "e2e.grantRequest" => (true, "/grants/request", false, &["workspaceId"]),
        "e2e.grantsMine" => (false, "/grants/mine", false, &[]),
        "e2e.grantSubmit" => (
            true,
            "/grants",
            false,
            &["requestId", "recipientPublicKey", "enc", "ciphertext"],
        ),
        "e2e.grantFail" => (true, "/grants/fail", false, &["requestId", "reason"]),
        _ => return Err("unknown-op"),
    };
    let path = if has_id {
        let i = string(v, "id")?;
        if !id(i) {
            return Err("invalid-id");
        }
        path.replace("{id}", i)
    } else {
        if v.get("id").is_some() {
            return Err("invalid-message");
        }
        path.to_string()
    };
    let body = if post {
        let b = v
            .get("body")
            .and_then(Value::as_object)
            .ok_or("invalid-body")?;
        if b.keys().any(|k| !fields.contains(&k.as_str())) {
            return Err("invalid-body");
        }
        let raw = json!(b).to_string();
        if raw.len() > MAX_BODY {
            return Err("invalid-body");
        }
        Some(raw)
    } else {
        if v.get("body").is_some() {
            return Err("invalid-body");
        }
        None
    };
    Ok((post, format!("/api/native/e2e{path}"), body))
}
pub fn attachment(v: &Value) -> Result<(bool, String, Option<String>)> {
    let op = string(v, "op")?;
    let (post, action, required, optional): (bool, &str, &[&str], &[&str]) = match op {
        "attachment.config" => (false, "config", &[], &[]),
        "attachment.reserve" => (
            true,
            "reserve",
            &[
                "id",
                "workspaceId",
                "parentKind",
                "parentId",
                "keyVersion",
                "filenameCiphertext",
                "contentTypeCiphertext",
                "dekWrapped",
                "declaredBytes",
            ],
            &["thumbnailDeclaredBytes"],
        ),
        "attachment.finalize" => (true, "finalize", &["id"], &[]),
        "attachment.abort" => (true, "abort", &["id"], &[]),
        "attachment.delete" => (true, "delete", &["id"], &[]),
        _ => return Err("unknown-op"),
    };
    let body = v
        .get("body")
        .and_then(Value::as_object)
        .ok_or("invalid-body")?;
    if required.iter().any(|k| !body.contains_key(*k))
        || body
            .keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("invalid-body");
    }
    for key in ["id", "workspaceId", "parentId"] {
        if let Some(value) = body.get(key) {
            let id = value.as_str().ok_or("invalid-id")?;
            if id.is_empty()
                || id.len() > 128
                || !id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
            {
                return Err("invalid-id");
            }
        }
    }
    let raw = Value::Object(body.clone()).to_string();
    Ok((
        post,
        format!("/api/native/attachments/{action}"),
        post.then_some(raw),
    ))
}
pub const MIGRATION_BODY: usize = 262144;
fn migration_exact(v: &Value, required: &[&str], optional: &[&str]) -> Result<()> {
    let m = v.as_object().ok_or("invalid-body")?;
    if required.iter().any(|k| !m.contains_key(*k))
        || m.keys()
            .any(|k| !required.contains(&k.as_str()) && !optional.contains(&k.as_str()))
    {
        return Err("invalid-body");
    }
    Ok(())
}
fn migration_uint(v: &Value, key: &str, min: u64, max: u64) -> Result<u64> {
    v.get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n >= min && *n <= max)
        .ok_or("invalid-body")
}
pub fn migration_hash(v: &Value, key: &str) -> Result<String> {
    let s = string(v, key)?;
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("invalid-body");
    }
    Ok(s.into())
}
fn migration_uuid(v: &Value, key: &str, target: bool) -> Result<()> {
    let s = string(v, key)?;
    let raw = if target {
        s.strip_prefix("migration_").ok_or("invalid-body")?
    } else {
        s
    };
    if raw.len() != 36
        || !raw.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
            }
        })
        || (target && (raw.as_bytes()[14] != b'4' || !b"89ab".contains(&raw.as_bytes()[19])))
    {
        return Err("invalid-body");
    }
    Ok(())
}
fn migration_prepared(v: &Value) -> Result<()> {
    migration_exact(
        v,
        &[
            "id",
            "keyVersion",
            "filenameCiphertext",
            "contentTypeCiphertext",
            "dekWrapped",
            "declaredBytes",
            "ciphertextSha256",
        ],
        &["thumbnailDeclaredBytes", "thumbnailCiphertextSha256"],
    )?;
    migration_uuid(v, "id", true)?;
    migration_uint(v, "keyVersion", 1, 2147483647)?;
    for key in ["filenameCiphertext", "contentTypeCiphertext", "dekWrapped"] {
        let text = string(v, key)?;
        if text.is_empty() || text.len() > 65536 || text.contains('\0') {
            return Err("invalid-body");
        }
    }
    migration_upload_fields(v)?;
    Ok(())
}
pub fn migration_upload_fields(v: &Value) -> Result<(u64, String, Option<(u64, String)>)> {
    let bytes = migration_uint(v, "declaredBytes", 1, 16777216)?;
    let hash = migration_hash(v, "ciphertextSha256")?;
    let size = v.get("thumbnailDeclaredBytes").filter(|v| !v.is_null());
    let digest = v.get("thumbnailCiphertextSha256").filter(|v| !v.is_null());
    let thumbnail = match (size, digest) {
        (None, None) => None,
        (Some(_), Some(_)) => {
            let n = migration_uint(v, "thumbnailDeclaredBytes", 1, 16777216)?;
            if bytes + n > 16777216 {
                return Err("invalid-body");
            }
            Some((n, migration_hash(v, "thumbnailCiphertextSha256")?))
        }
        _ => return Err("invalid-body"),
    };
    Ok((bytes, hash, thumbnail))
}
pub fn migration_upload(v: &Value) -> Result<String> {
    migration_exact(
        v,
        &[
            "jobId",
            "ordinal",
            "associationId",
            "attemptId",
            "targetAttachmentId",
            "revision",
            "thumbnail",
        ],
        &[],
    )?;
    let job = migration_hash(v, "jobId")?;
    let ordinal = migration_uint(v, "ordinal", 0, 50000)?;
    migration_uint(v, "revision", 1, 2147483647)?;
    migration_uuid(v, "associationId", false)?;
    migration_uuid(v, "attemptId", false)?;
    migration_uuid(v, "targetAttachmentId", true)?;
    v.get("thumbnail")
        .and_then(Value::as_bool)
        .ok_or("invalid-body")?;
    Ok(format!(
        "/api/native/portability/import/plans/{job}/attachment-reservations?ordinal={ordinal}"
    ))
}
pub fn archive_migration(v: &Value) -> Result<(bool, String, Option<String>, usize)> {
    let op = string(v, "op")?;
    let body = v.get("body").ok_or("invalid-body")?;
    let base = "/api/native/portability/import";
    if op == "archive.migration.jobs" {
        migration_exact(body, &["limit"], &["afterJobId"])?;
        let limit = migration_uint(body, "limit", 1, 64)?;
        let mut path = format!("{base}/jobs?limit={limit}");
        if body.get("afterJobId").is_some() {
            path.push_str(&format!(
                "&afterJobId={}",
                migration_hash(body, "afterJobId")?
            ));
        }
        return Ok((false, path, None, 65536));
    }
    let job = migration_hash(body, "jobId")?;
    let prefix = format!("{base}/plans/{job}");
    match op {
        "archive.migration.parents" => {
            migration_exact(body, &["jobId", "afterOrdinal", "limit"], &[])?;
            let after = body
                .get("afterOrdinal")
                .and_then(Value::as_i64)
                .filter(|v| (-1..=50000).contains(v))
                .ok_or("invalid-body")?;
            let limit = migration_uint(body, "limit", 1, 64)?;
            Ok((
                false,
                format!("{prefix}/attachment-parents?afterOrdinal={after}&limit={limit}"),
                None,
                262144,
            ))
        }
        "archive.migration.inspect" | "archive.migration.status" => {
            migration_exact(body, &["jobId", "ordinal"], &[])?;
            let ordinal = migration_uint(body, "ordinal", 0, 50000)?;
            let action = if op == "archive.migration.inspect" {
                "attachment-migrations"
            } else {
                "attachment-reservations"
            };
            Ok((
                false,
                format!("{prefix}/{action}?ordinal={ordinal}"),
                None,
                16384,
            ))
        }
        "archive.migration.reserve" | "archive.migration.recover" => {
            let recover = op == "archive.migration.recover";
            let key = if recover { "recovery" } else { "reservation" };
            migration_exact(body, &["jobId", key], &[])?;
            let input = body.get(key).ok_or("invalid-body")?;
            if recover {
                migration_exact(
                    input,
                    &[
                        "ordinal",
                        "sourceFingerprint",
                        "previous",
                        "prepared",
                        "retireLive",
                    ],
                    &[],
                )?;
                let previous = input.get("previous").ok_or("invalid-body")?;
                migration_exact(
                    previous,
                    &[
                        "associationId",
                        "attemptId",
                        "targetAttachmentId",
                        "revision",
                    ],
                    &[],
                )?;
                migration_uuid(previous, "associationId", false)?;
                migration_uuid(previous, "attemptId", false)?;
                migration_uuid(previous, "targetAttachmentId", true)?;
                migration_uint(previous, "revision", 1, 2147483647)?;
                input
                    .get("retireLive")
                    .and_then(Value::as_bool)
                    .ok_or("invalid-body")?;
                if previous.get("targetAttachmentId")
                    == input.get("prepared").and_then(|p| p.get("id"))
                {
                    return Err("invalid-body");
                }
            } else {
                migration_exact(
                    input,
                    &[
                        "ordinal",
                        "sourceFingerprint",
                        "expectedRevision",
                        "prepared",
                    ],
                    &[],
                )?;
                migration_uint(input, "expectedRevision", 0, 2147483647)?;
            }
            migration_uint(input, "ordinal", 0, 50000)?;
            migration_hash(input, "sourceFingerprint")?;
            migration_prepared(input.get("prepared").ok_or("invalid-body")?)?;
            let raw = input.to_string();
            if raw.len() > MIGRATION_BODY {
                return Err("invalid-body");
            }
            let action = if recover {
                "attachment-recoveries"
            } else {
                "attachment-reservations"
            };
            Ok((true, format!("{prefix}/{action}"), Some(raw), 16384))
        }
        _ => Err("unknown-op"),
    }
}

pub fn file_operation(op: &str) -> bool {
    op.starts_with("archive.migration.")
        || op.starts_with("archive.export.")
        || op.starts_with("archive.input.")
        || op.starts_with("attachment.")
        || op.starts_with("upload.")
        || op.starts_with("download.")
        || op.starts_with("stage.")
        || op.starts_with("save.")
}
pub fn file_chunk(op: &str) -> bool {
    matches!(op, "upload.write" | "stage.write" | "save.write")
}

#[cfg(test)]
mod tests {
    use super::*;
    fn migration_prepared_fixture() -> Value {
        json!({"id":"migration_11111111-1111-4111-8111-111111111111","keyVersion":1,"filenameCiphertext":"name","contentTypeCiphertext":"type","dekWrapped":"wrap","declaredBytes":4,"ciphertextSha256":"a".repeat(64),"thumbnailDeclaredBytes":null,"thumbnailCiphertextSha256":null})
    }
    #[test]
    fn archive_migration_fixed_routes_and_nested_boundaries() {
        let job = "a".repeat(64);
        for (op, body, suffix, post, cap) in [
            ("jobs", json!({"limit":1}), "jobs?limit=1", false, 65536),
            (
                "parents",
                json!({"jobId":job,"afterOrdinal":-1,"limit":64}),
                "attachment-parents?afterOrdinal=-1&limit=64",
                false,
                262144,
            ),
            (
                "inspect",
                json!({"jobId":job,"ordinal":0}),
                "attachment-migrations?ordinal=0",
                false,
                16384,
            ),
            (
                "status",
                json!({"jobId":job,"ordinal":50000}),
                "attachment-reservations?ordinal=50000",
                false,
                16384,
            ),
            (
                "reserve",
                json!({"jobId":job,"reservation":{"ordinal":0,"sourceFingerprint":job,"expectedRevision":0,"prepared":migration_prepared_fixture()}}),
                "attachment-reservations",
                true,
                16384,
            ),
            (
                "recover",
                json!({"jobId":job,"recovery":{"ordinal":0,"sourceFingerprint":job,"previous":{"associationId":"11111111-1111-4111-8111-111111111111","attemptId":"22222222-2222-4222-8222-222222222222","targetAttachmentId":"migration_33333333-3333-4333-8333-333333333333","revision":1},"prepared":migration_prepared_fixture(),"retireLive":true}}),
                "attachment-recoveries",
                true,
                16384,
            ),
        ] {
            let value = json!({"op":format!("archive.migration.{op}"),"body":body});
            let (actual, path, payload, limit) = archive_migration(&value).unwrap();
            assert_eq!(actual, post);
            assert!(path.starts_with("/api/native/portability/import/"));
            assert!(path.ends_with(suffix));
            assert_eq!(limit, cap);
            if let Some(raw) = payload {
                assert!(parse(&raw).unwrap().get("jobId").is_none());
            }
            for field in ["url", "ownerId", "headers", "bytes"] {
                let mut invalid = value.clone();
                invalid["body"][field] = json!("caller");
                assert!(archive_migration(&invalid).is_err());
            }
        }
        for body in [
            json!({"limit":0}),
            json!({"limit":65}),
            json!({"limit":1.5}),
            json!({"limit":1,"afterJobId":"../x"}),
        ] {
            assert!(
                archive_migration(&json!({"op":"archive.migration.jobs","body":body})).is_err()
            );
        }
        let mut prepared = migration_prepared_fixture();
        prepared["thumbnailDeclaredBytes"] = json!(1);
        assert!(migration_prepared(&prepared).is_err());
        prepared["thumbnailCiphertextSha256"] = json!("b".repeat(64));
        prepared["declaredBytes"] = json!(16777216);
        assert!(migration_prepared(&prepared).is_err());
        prepared = migration_prepared_fixture();
        prepared["filenameCiphertext"] = json!("x".repeat(65537));
        assert!(migration_prepared(&prepared).is_err());
        prepared = migration_prepared_fixture();
        for field in ["filenameCiphertext", "contentTypeCiphertext", "dekWrapped"] {
            prepared[field] = json!("\\".repeat(65536));
        }
        assert!(archive_migration(&json!({"op":"archive.migration.reserve","body":{"jobId":job,"reservation":{"ordinal":0,"sourceFingerprint":job,"expectedRevision":0,"prepared":prepared}}})).is_err());
    }
    #[test]
    fn archive_input_uses_named_file_operations_without_request_chunks() {
        for op in [
            "archive.input.pick",
            "archive.input.read",
            "archive.input.cancelPending",
            "archive.input.cancel",
        ] {
            assert!(file_operation(op));
            assert!(!file_chunk(op));
        }
    }
    #[test]
    fn strict_authorities_and_json() {
        assert_eq!(
            origin("HTTPS://Example.COM:443/"),
            Ok("https://example.com".into())
        );
        for s in [
            "http://example.com",
            "https://u@example.com",
            "https://example.com/%2f",
            "https://example.com:0",
            "https://[::1]",
        ] {
            assert!(origin(s).is_err());
        }
        assert!(parse(r#"{"a":{"b":1,"b":2}}"#).is_err());
        assert!(parse("{} {}").is_err());
    }
    #[test]
    fn protocol_keeps_init_bytes_and_never_accepts_caller_credentials() {
        let h = "h";
        let j = "a.b.c";
        let raw = r#"{"initConnectionMessage":["initConnection",{"userQueryURL":"https://example.com/api/zero/query","x":1.0}],"authToken":"h"}"#;
        let p = STANDARD
            .encode(raw)
            .replace('+', "%2B")
            .replace('/', "%2F")
            .replace('=', "%3D");
        let out = splice_protocol(&p, "https://example.com", h, j).unwrap();
        let decoded = STANDARD
            .decode(
                out.replace("%2B", "+")
                    .replace("%2F", "/")
                    .replace("%3D", "="),
            )
            .unwrap();
        assert_eq!(
            String::from_utf8(decoded).unwrap(),
            raw.replace("\"authToken\":\"h\"", "\"authToken\":\"a.b.c\"")
        );
        assert!(filter_frame(
            r#"["updateAuth",{"auth":"caller-jwt"}]"#,
            "https://example.com",
            h,
            j
        )
        .is_err());
        assert!(filter_frame(
            r#"["initConnection",{"userPushHeaders":{"Authorization":"Bearer x"}}]"#,
            "https://example.com",
            h,
            j
        )
        .is_err());
    }
    #[test]
    fn fixed_destinations_and_scopes() {
        assert!(socket_target(
            "wss://example.com/sync/v51/connect?auth=x",
            "https://example.com"
        )
        .is_err());
        assert!(socket_target(
            "wss://example.com/a/../sync/v51/connect",
            "https://example.com"
        )
        .is_err());
        assert!(e2e(&json!({"op":"e2e.enroll","body":{"url":"https://other.example"}})).is_err());
        assert_ne!(
            scope("https://a.example", "u1"),
            scope("https://b.example", "u1")
        );
    }
    #[test]
    fn attachment_controls_have_closed_fields_and_fixed_native_paths() {
        assert_eq!(
            attachment(&json!({"op":"attachment.config","body":{}})).unwrap(),
            (false, "/api/native/attachments/config".into(), None)
        );
        let value =
            attachment(&json!({"op":"attachment.finalize","body":{"id":"safe-1"}})).unwrap();
        assert_eq!(value.1, "/api/native/attachments/finalize");
        for body in [
            json!({"id":"../secret"}),
            json!({"id":"safe","url":"https://other.example"}),
            json!({"id":"safe","authorization":"secret"}),
        ] {
            assert!(attachment(&json!({"op":"attachment.finalize","body":body})).is_err());
        }
        assert!(!file_chunk("attachment.reserve"));
        assert!(file_chunk("upload.write"));
        assert!(file_operation("save.cancelPending"));
    }
}
