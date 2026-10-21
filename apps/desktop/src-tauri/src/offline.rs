use crate::{protocol, vault::Session};
use serde::{Deserialize, Serialize};
use std::{error::Error, sync::OnceLock};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub session: Session,
    pub verified: bool,
    pub pending: bool,
    pub name: Option<String>,
    pub email: Option<String>,
    pub zero: Option<String>,
    pub workspace: Option<String>,
}
impl Evidence {
    pub fn new(session: Session) -> Self {
        Self {
            session,
            verified: false,
            pending: false,
            name: None,
            email: None,
            zero: None,
            workspace: None,
        }
    }
    pub fn ready(&self, session: &Session, now: u64) -> bool {
        self.verified
            && !self.pending
            && crate::vault::same_session(&self.session, session)
            && self.session.expires_at == session.expires_at
            && unexpired(&session.expires_at, now)
            && self.name.as_ref().is_some_and(|v| v.chars().count() <= 512)
            && self
                .email
                .as_ref()
                .is_some_and(|v| v.chars().count() <= 512)
            && self
                .zero
                .as_ref()
                .is_some_and(|v| protocol::endpoint(v).as_ref() == Ok(v))
            && self.workspace.as_ref().is_some_and(|v| protocol::id(v))
    }
}
pub fn unexpired(value: &str, now: u64) -> bool {
    static ISO: OnceLock<regex::Regex> = OnceLock::new();
    if !ISO
        .get_or_init(|| {
            regex::Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$").unwrap()
        })
        .is_match(value)
    {
        return false;
    }
    chrono::DateTime::parse_from_rfc3339(value).is_ok_and(|date| {
        date.timestamp_subsec_nanos() < 1_000_000_000
            && date.timestamp_millis() > 0
            && date.timestamp_millis() as u64 > now
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        net::TcpListener,
        time::{Duration, Instant},
    };

    #[tokio::test]
    async fn native_tls_refusal_is_not_a_network_failure_even_when_reqwest_says_connect() {
        // Disposable self-signed localhost identity, never a deployed credential. macOS
        // refuses to import a PKCS#12 with an empty password.
        let identity =
            native_tls::Identity::from_pkcs12(include_bytes!("../tests/tls.p12"), "fixture")
                .unwrap();
        let tls = native_tls::TlsAcceptor::new(identity).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                match listener.accept() {
                    Ok((stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        assert!(tls.accept(stream).is_err());
                        return;
                    }
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(error) => panic!("TLS fixture accept: {error}"),
                }
            }
        });
        let client = reqwest::Client::builder()
            .tls_backend_native()
            .https_only(true)
            .no_proxy()
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let error = client
            .get(format!("https://{address}"))
            .send()
            .await
            .err()
            .unwrap();
        assert!(error.is_connect());
        assert_eq!(transport_error(&error), "transport-refused");
        server.join().unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        drop(listener);
        let error = client
            .get(format!("https://{address}"))
            .send()
            .await
            .err()
            .unwrap();
        assert_eq!(transport_error(&error), "network");
    }
}

// A TLS handshake failure is never evidence of being offline, including when
// reqwest also classifies it as a connect error.
pub fn transport_error(error: &reqwest::Error) -> &'static str {
    #[cfg(debug_assertions)]
    {
        eprintln!(
            "Native transport: connect={}, timeout={}",
            error.is_connect(),
            error.is_timeout()
        );
        let mut cause = error.source();
        while let Some(value) = cause {
            eprintln!("Native transport cause: {value}");
            cause = value.source();
        }
    }
    let mut source: Option<&(dyn Error + 'static)> = Some(error);
    while let Some(cause) = source {
        if cause.is::<native_tls::Error>() {
            return "transport-refused";
        }
        source = cause.source();
    }
    if error.is_connect() || error.is_timeout() {
        "network"
    } else {
        "transport-refused"
    }
}
