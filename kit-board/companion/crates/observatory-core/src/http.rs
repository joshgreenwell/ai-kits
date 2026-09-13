//! The Observatory HTTP client. Blocking, no async runtime, rustls with the
//! platform trust store, no redirects, bounded bodies, and errors reduced to
//! codes: no response text, URL, or header ever reaches a log.

use std::time::Duration;

use observatory_contract::{
    BindingRequest, BindingResponse, ConfigDocument, IdentityRequest, IdentityResponse, InstallOverride,
    PairRequest, PairResponse, SettingsResponse, UsageResponse, Uuid,
};
use serde::de::DeserializeOwned;
use thiserror::Error;
use ureq::Agent;
use ureq::config::Config;
use ureq::http::Response;
use ureq::tls::{RootCerts, TlsConfig};

use crate::USER_AGENT;
use crate::config::Secret;

/// The largest response body the companion reads.
const MAX_RESPONSE_BYTES: u64 = 4_000_000;

/// Where TLS roots come from: the platform trust store in the shipped build, the
/// bundled Mozilla roots in a cross-compiled test build (`--no-default-features`).
#[cfg(feature = "platform-tls")]
const TLS_ROOTS: RootCerts = RootCerts::PlatformVerifier;
#[cfg(not(feature = "platform-tls"))]
const TLS_ROOTS: RootCerts = RootCerts::WebPki;

/// A label for `doctor`, so a test build is recognizable.
pub const TLS_ROOTS_LABEL: &str = if cfg!(feature = "platform-tls") { "platform" } else { "webpki" };

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum HttpError {
    #[error(
        "the Observatory URL must be https, or http to localhost, with no credentials, query, or fragment"
    )]
    InvalidUrl,
    #[error("the Observatory redirected; redirects are not followed")]
    Redirect,
    #[error("the Observatory returned status {0}")]
    Status(u16),
    #[error("the Observatory could not be reached")]
    Transport,
    #[error("the request timed out")]
    Timeout,
    #[error("the Observatory response was not valid")]
    Decode,
    #[error("this install has no key; run `observatory connect`")]
    NoKey,
}

impl HttpError {
    /// True for a 401 or 403.
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, HttpError::Status(401 | 403))
    }
}

/// Validates the Observatory base URL the way `collect.py` `send()` does and
/// returns it without a trailing slash.
pub fn validate_base_url(url: &str) -> Result<String, HttpError> {
    let trimmed = url.trim().trim_end_matches('/');
    let (scheme, rest) = trimmed.split_once("://").ok_or(HttpError::InvalidUrl)?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    let path = &rest[authority_end..];
    if authority.is_empty() || authority.contains('@') || path.contains(['?', '#']) {
        return Err(HttpError::InvalidUrl);
    }
    let host = authority.rsplit_once(':').map_or(authority, |(host, port)| {
        if port.bytes().all(|b| b.is_ascii_digit()) { host } else { authority }
    });
    let local = matches!(host, "localhost" | "127.0.0.1" | "[::1]");
    match scheme {
        "https" => Ok(trimmed.to_owned()),
        "http" if local => Ok(trimmed.to_owned()),
        _ => Err(HttpError::InvalidUrl),
    }
}

/// The result of a conditional config fetch.
#[derive(Debug)]
pub enum ConfigFetch {
    NotModified,
    Document { document: Box<ConfigDocument>, etag: Option<String>, text: String },
}

#[derive(Debug)]
pub struct Client {
    agent: Agent,
    base: String,
    key: Option<Secret>,
}

impl Client {
    pub fn new(url: &str, key: Option<Secret>) -> Result<Client, HttpError> {
        let base = validate_base_url(url)?;
        let tls = TlsConfig::builder().root_certs(TLS_ROOTS).build();
        let config = Config::builder()
            .tls_config(tls)
            .max_redirects(0)
            .http_status_as_error(false)
            .timeout_global(Some(Duration::from_secs(45)))
            .user_agent(USER_AGENT)
            .build();
        Ok(Client { agent: config.into(), base, key })
    }

    pub fn base(&self) -> &str {
        &self.base
    }

    fn url(&self, route: &str) -> String {
        format!("{}{}", self.base, route)
    }

    fn bearer(&self) -> Result<String, HttpError> {
        let key = self.key.as_ref().ok_or(HttpError::NoKey)?;
        Ok(format!("Bearer {}", key.expose()))
    }

    fn map(error: ureq::Error) -> HttpError {
        match error {
            ureq::Error::Timeout(_) => HttpError::Timeout,
            _ => HttpError::Transport,
        }
    }

    fn body(mut response: Response<ureq::Body>) -> Result<(u16, String, Option<String>), HttpError> {
        let status = response.status();
        if status.is_redirection() {
            return Err(HttpError::Redirect);
        }
        let etag = response.headers().get("etag").and_then(|value| value.to_str().ok()).map(str::to_owned);
        let text = response
            .body_mut()
            .with_config()
            .limit(MAX_RESPONSE_BYTES)
            .read_to_string()
            .map_err(|_| HttpError::Transport)?;
        Ok((status.as_u16(), text, etag))
    }

    fn decode<T: DeserializeOwned>(status: u16, text: &str) -> Result<T, HttpError> {
        if !(200..300).contains(&status) {
            return Err(HttpError::Status(status));
        }
        serde_json::from_str(text).map_err(|_| HttpError::Decode)
    }

    fn send_json<T: DeserializeOwned>(
        &self,
        method: &str,
        route: &str,
        body: &[u8],
        auth: bool,
    ) -> Result<T, HttpError> {
        let url = self.url(route);
        let mut request = match method {
            "PUT" => self.agent.put(&url),
            _ => self.agent.post(&url),
        };
        request = request.header("Content-Type", "application/json").header("Accept", "application/json");
        if auth {
            request = request.header("Authorization", &self.bearer()?);
        }
        let response = request.send(body).map_err(Self::map)?;
        let (status, text, _) = Self::body(response)?;
        Self::decode(status, &text)
    }

    /// `POST /api/v1/companion/pair` (no auth).
    pub fn pair(&self, request: &PairRequest) -> Result<PairResponse, HttpError> {
        let body = serde_json::to_vec(request).map_err(|_| HttpError::Decode)?;
        self.send_json("POST", "/api/v1/companion/pair", &body, false)
    }

    /// `GET /api/v1/companion/config` with `If-None-Match`.
    pub fn fetch_config(&self, etag: Option<&str>) -> Result<ConfigFetch, HttpError> {
        let mut request = self
            .agent
            .get(self.url("/api/v1/companion/config"))
            .header("Accept", "application/json")
            .header("Authorization", &self.bearer()?);
        if let Some(etag) = etag {
            request = request.header("If-None-Match", etag);
        }
        let response = request.call().map_err(Self::map)?;
        if response.status().as_u16() == 304 {
            return Ok(ConfigFetch::NotModified);
        }
        let (status, text, etag) = Self::body(response)?;
        let document: ConfigDocument = Self::decode(status, &text)?;
        Ok(ConfigFetch::Document { document: Box::new(document), etag, text })
    }

    /// `POST /api/v1/usage` with an already serialized envelope.
    pub fn post_usage(&self, body: &[u8]) -> Result<UsageResponse, HttpError> {
        self.send_json("POST", "/api/v1/usage", body, true)
    }

    /// `POST /api/v1/companion/bindings`.
    pub fn create_binding(&self, request: &BindingRequest) -> Result<BindingResponse, HttpError> {
        let body = serde_json::to_vec(request).map_err(|_| HttpError::Decode)?;
        self.send_json("POST", "/api/v1/companion/bindings", &body, true)
    }

    /// `PUT /api/v1/companion/settings`.
    pub fn put_settings(&self, over: &InstallOverride) -> Result<SettingsResponse, HttpError> {
        let body = serde_json::to_vec(over).map_err(|_| HttpError::Decode)?;
        self.send_json("PUT", "/api/v1/companion/settings", &body, true)
    }

    /// `POST /api/v1/companion/bindings/<id>/identity`.
    pub fn confirm_identity(
        &self,
        binding_id: &Uuid,
        request: &IdentityRequest,
    ) -> Result<IdentityResponse, HttpError> {
        let body = serde_json::to_vec(request).map_err(|_| HttpError::Decode)?;
        self.send_json("POST", &format!("/api/v1/companion/bindings/{binding_id}/identity"), &body, true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_rules_match_collect_py() {
        assert_eq!(validate_base_url("https://example.test/").unwrap(), "https://example.test");
        assert_eq!(validate_base_url("http://localhost:3100").unwrap(), "http://localhost:3100");
        assert_eq!(validate_base_url("http://127.0.0.1:3100/base/").unwrap(), "http://127.0.0.1:3100/base");
        assert!(validate_base_url("http://example.test").is_err());
        assert!(validate_base_url("https://user:pw@example.test").is_err());
        assert!(validate_base_url("https://example.test/?x=1").is_err());
        assert!(validate_base_url("example.test").is_err());
        assert!(validate_base_url("ftp://localhost").is_err());
    }

    #[test]
    fn client_rejects_bad_urls_and_missing_key() {
        assert!(Client::new("http://example.test", None).is_err());
        let client = Client::new("https://example.test", None).unwrap();
        assert!(matches!(client.bearer(), Err(HttpError::NoKey)));
    }
}
