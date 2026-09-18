//! HTTPS client for provider interfaces the adapters call. Same TLS, no-redirect,
//! bounded-body, and no-log-body rules as the Observatory client. Only `https`
//! URLs are accepted. Response text never reaches a log.

use std::time::Duration;

use observatory_contract::DetailCode;
use serde_json::Value;
use thiserror::Error;
use ureq::Agent;
use ureq::http::Response;

use crate::config::Secret;
use crate::http::blocking_agent;

/// The largest provider response body the companion reads.
const MAX_RESPONSE_BYTES: u64 = 4_000_000;

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum ProviderHttpError {
    #[error("the provider URL must be https with no credentials")]
    InvalidUrl,
    #[error("the provider redirected; redirects are not followed")]
    Redirect,
    #[error("the provider refused the credential")]
    Unauthorized,
    #[error("the provider rate-limited the request")]
    RateLimited { retry_after_seconds: Option<u64> },
    #[error("the provider returned status {0}")]
    Status(u16),
    #[error("the provider could not be reached")]
    Transport,
    #[error("the request timed out")]
    Timeout,
    #[error("the provider response was not valid JSON")]
    Decode,
}

impl ProviderHttpError {
    pub fn detail(&self) -> DetailCode {
        match self {
            ProviderHttpError::Unauthorized => DetailCode::HttpUnauthorized,
            ProviderHttpError::RateLimited { .. } => DetailCode::HttpRateLimited,
            ProviderHttpError::Timeout => DetailCode::Timeout,
            ProviderHttpError::Decode => DetailCode::UnrecognizedPayload,
            _ => DetailCode::HttpError,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Auth<'a> {
    Bearer(&'a Secret),
    ApiKey(&'a Secret),
    CursorSession { token: &'a Secret, user_id: Option<&'a str> },
}

#[derive(Debug)]
pub struct ProviderClient {
    agent: Agent,
}

impl ProviderClient {
    pub fn new(timeout: Duration) -> Self {
        ProviderClient { agent: blocking_agent(timeout) }
    }

    pub fn get_json(
        &self,
        url: &str,
        auth: Auth<'_>,
        extra_headers: &[(&str, &str)],
    ) -> Result<Value, ProviderHttpError> {
        self.exchange("GET", url, auth, extra_headers, None)
    }

    pub fn post_json(
        &self,
        url: &str,
        auth: Auth<'_>,
        extra_headers: &[(&str, &str)],
        body: &[u8],
    ) -> Result<Value, ProviderHttpError> {
        self.exchange("POST", url, auth, extra_headers, Some(body))
    }

    fn exchange(
        &self,
        _method: &str,
        url: &str,
        auth: Auth<'_>,
        extra_headers: &[(&str, &str)],
        body: Option<&[u8]>,
    ) -> Result<Value, ProviderHttpError> {
        validate_https(url)?;
        let response = match body {
            Some(bytes) => {
                let request = with_headers(self.agent.post(url), auth, extra_headers);
                request.header("Content-Type", "application/json").send(bytes)
            }
            None => with_headers(self.agent.get(url), auth, extra_headers).call(),
        }
        .map_err(map_transport)?;
        let (status, retry_after, text) = read_body(response)?;
        decode(status, retry_after, &text)
    }
}

fn with_headers<B>(
    mut request: ureq::RequestBuilder<B>,
    auth: Auth<'_>,
    extra_headers: &[(&str, &str)],
) -> ureq::RequestBuilder<B> {
    request = request.header("Accept", "application/json");
    match auth {
        Auth::Bearer(secret) => {
            request = request.header("Authorization", &format!("Bearer {}", secret.expose()));
        }
        Auth::ApiKey(secret) => {
            request = request.header("x-api-key", secret.expose());
        }
        Auth::CursorSession { token, user_id } => {
            let exposed = token.expose();
            request = request.header("Authorization", &format!("Bearer {exposed}"));
            // Dashboard POSTs reject requests without this CSRF origin.
            request = request.header("Origin", "https://cursor.com");
            if let Some(user_id) = user_id.filter(|id| !id.is_empty()) {
                request = request.header("Cookie", &format!("WorkosCursorSessionToken={user_id}::{exposed}"));
            }
        }
    }
    for (name, value) in extra_headers {
        request = request.header(*name, *value);
    }
    request
}

/// HTTPS only, no userinfo, query and fragment are allowed (provider pagination).
pub fn validate_https(url: &str) -> Result<(), ProviderHttpError> {
    let trimmed = url.trim();
    let (scheme, rest) = trimmed.split_once("://").ok_or(ProviderHttpError::InvalidUrl)?;
    if scheme != "https" {
        return Err(ProviderHttpError::InvalidUrl);
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return Err(ProviderHttpError::InvalidUrl);
    }
    Ok(())
}

fn map_transport(error: ureq::Error) -> ProviderHttpError {
    match error {
        ureq::Error::Timeout(_) => ProviderHttpError::Timeout,
        _ => ProviderHttpError::Transport,
    }
}

fn read_body(mut response: Response<ureq::Body>) -> Result<(u16, Option<u64>, String), ProviderHttpError> {
    let status = response.status().as_u16();
    if (300..400).contains(&status) {
        return Err(ProviderHttpError::Redirect);
    }
    let retry_after = response
        .headers()
        .get("retry-after")
        .and_then(|value| value.to_str().ok())
        .and_then(parse_retry_after);
    let text = response
        .body_mut()
        .with_config()
        .limit(MAX_RESPONSE_BYTES)
        .read_to_string()
        .map_err(|_| ProviderHttpError::Transport)?;
    Ok((status, retry_after, text))
}

fn decode(status: u16, retry_after: Option<u64>, text: &str) -> Result<Value, ProviderHttpError> {
    match status {
        401 | 403 => Err(ProviderHttpError::Unauthorized),
        429 => Err(ProviderHttpError::RateLimited { retry_after_seconds: retry_after }),
        200..=299 => serde_json::from_str(text).map_err(|_| ProviderHttpError::Decode),
        other => Err(ProviderHttpError::Status(other)),
    }
}

pub fn parse_retry_after(value: &str) -> Option<u64> {
    value.trim().parse::<u64>().ok()
}

/// `application/x-www-form-urlencoded` query string; keys are emitted as given.
pub fn query_string(pairs: &[(&str, &str)]) -> String {
    let mut out = String::new();
    for (index, (key, value)) in pairs.iter().enumerate() {
        if index > 0 {
            out.push('&');
        }
        out.push_str(&encode_component(key));
        out.push('=');
        out.push_str(&encode_component(value));
    }
    out
}

fn encode_component(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_urls_are_required_and_credentials_are_rejected() {
        assert!(validate_https("https://api.example.test/v1").is_ok());
        assert!(validate_https("https://api.example.test/v1?page=1").is_ok());
        assert!(validate_https("http://api.example.test/v1").is_err());
        assert!(validate_https("https://user:pw@api.example.test/v1").is_err());
        assert!(validate_https("ftp://api.example.test").is_err());
    }

    #[test]
    fn retry_after_is_seconds_only() {
        assert_eq!(parse_retry_after("12"), Some(12));
        assert_eq!(parse_retry_after(" 7 "), Some(7));
        assert_eq!(parse_retry_after("Wed, 21 Oct 2015 07:28:00 GMT"), None);
    }

    #[test]
    fn query_string_encodes_values_and_keeps_array_keys() {
        assert_eq!(
            query_string(&[("group_by[]", "model"), ("group_by[]", "workspace_id"), ("limit", "31")]),
            "group_by%5B%5D=model&group_by%5B%5D=workspace_id&limit=31"
        );
    }
}
