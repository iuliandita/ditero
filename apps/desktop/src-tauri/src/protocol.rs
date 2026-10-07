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
pub fn file_operation(op: &str) -> bool {
    op.starts_with("archive.export.")
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
