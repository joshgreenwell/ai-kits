//! The per-install privacy key and the keyed hashes derived from it.
//!
//! Every hash the companion uploads in place of a low-entropy value (a
//! working directory, a custom tool or agent name) is HMAC-SHA256 under a
//! random 32-byte key this install generates once and keeps in its state
//! database (`State::privacy_key`). Without the key the construction cannot be
//! evaluated, so a reader of the Observatory database cannot confirm a guessed
//! path or tool name by hashing it. The key never leaves the machine: it is not
//! uploaded, logged, or shown by `status` or `doctor`, and its `Debug` form is
//! redacted. Identifiers that are already high entropy (session ids, agent ids,
//! provider account ids) stay plain SHA-256, so they agree across installs.
//!
//! The functions here are pure in the key: two installs hash the same value to
//! different outputs, one install hashes it the same way every time, and a test
//! with a fixed key is deterministic.

use std::fmt;

use hmac::{Hmac, Mac};
use observatory_contract::Sha256Hex;
use serde_json::{Value, json};
use sha2::Sha256;

use crate::pyjson::py_compact_json;

/// The random key one install hashes its privacy-sensitive values under.
#[derive(Clone, PartialEq, Eq)]
pub struct PrivacyKey([u8; 32]);

impl PrivacyKey {
    pub const LEN: usize = 32;

    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        PrivacyKey(bytes)
    }

    /// A fresh key from the operating system's random source (the UUID v4
    /// generator), skipping the bytes that carry the version and variant so
    /// every byte is random.
    pub fn generate() -> Self {
        const RANDOM_BYTES: [usize; 14] = [0, 1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 14, 15];
        let mut bytes = [0u8; 32];
        let mut filled = 0;
        while filled < bytes.len() {
            let uuid = uuid::Uuid::new_v4().into_bytes();
            for index in RANDOM_BYTES {
                if filled == bytes.len() {
                    break;
                }
                bytes[filled] = uuid[index];
                filled += 1;
            }
        }
        PrivacyKey(bytes)
    }

    /// A fixed key for tests, so expected hashes are stable across runs. Never
    /// used by a production code path.
    pub fn fixed_for_tests() -> Self {
        let mut bytes = [0u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (index as u8).wrapping_mul(7).wrapping_add(3);
        }
        PrivacyKey(bytes)
    }

    /// The stored form: 64 lowercase hex digits. For the state database only.
    pub fn to_hex(&self) -> String {
        self.0.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// Parses the stored form; `None` for anything but 64 hex digits.
    pub fn from_hex(text: &str) -> Option<Self> {
        let text = text.trim();
        if text.len() != 64 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        let mut bytes = [0u8; 32];
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
        }
        Some(PrivacyKey(bytes))
    }

    /// HMAC-SHA256 over the value's `py_compact_json` form, as 64 hex digits:
    /// the keyed counterpart of `pyjson::digest`.
    pub fn keyed_digest(&self, value: &Value) -> Sha256Hex {
        let mut mac = Hmac::<Sha256>::new_from_slice(&self.0).unwrap_or_else(|_| unreachable!());
        mac.update(py_compact_json(value).as_bytes());
        let out = mac.finalize().into_bytes();
        let text: String = out.iter().map(|byte| format!("{byte:02x}")).collect();
        Sha256Hex::try_from(text).unwrap_or_else(|_| unreachable!())
    }

    /// `h:` plus the first sixteen hex digits of `keyed_digest`, the form
    /// hashed tool and agent names take on the wire.
    pub fn short_hash(&self, value: &Value) -> String {
        format!("h:{}", self.keyed_digest(value).prefix16())
    }
}

impl fmt::Debug for PrivacyKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("PrivacyKey(redacted)")
    }
}

/// The project key of a normalized working directory: `hmac(key, ["project", cwd])`.
/// Uploaded as `project.key` (basis `working_directory`) and its `project_hash` alias.
pub fn project_key(key: &PrivacyKey, cwd: &str) -> Sha256Hex {
    key.keyed_digest(&json!(["project", cwd]))
}

/// The hashed form of a custom, MCP, or function tool name within its
/// namespace: `h:` plus sixteen hex digits of `hmac(key, ["tool-name", namespace, name])`.
pub fn tool_name_hash(key: &PrivacyKey, namespace: Option<&str>, name: &str) -> String {
    key.short_hash(&json!(["tool-name", namespace, name]))
}

/// The hashed form of a tool namespace.
pub fn tool_namespace_hash(key: &PrivacyKey, namespace: &str) -> String {
    key.short_hash(&json!(["tool-namespace", namespace]))
}

/// The hashed form of a custom agent's role name.
pub fn agent_name_hash(key: &PrivacyKey, name: &str) -> String {
    key.short_hash(&json!(["agent-name", name]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyed_hashes_are_stable_per_key_and_differ_between_keys() {
        let one = PrivacyKey::fixed_for_tests();
        let two = PrivacyKey::from_bytes([0x42; 32]);
        assert_eq!(project_key(&one, "/work/app"), project_key(&one, "/work/app"));
        assert_ne!(project_key(&one, "/work/app"), project_key(&two, "/work/app"));
        assert_ne!(project_key(&one, "/work/app"), project_key(&one, "/work/other"));
        assert_eq!(project_key(&one, "/work/app").as_str().len(), 64);
        assert_eq!(
            tool_name_hash(&one, Some("vault"), "search"),
            tool_name_hash(&one, Some("vault"), "search")
        );
        assert_ne!(
            tool_name_hash(&one, Some("vault"), "search"),
            tool_name_hash(&two, Some("vault"), "search")
        );
        assert_ne!(tool_name_hash(&one, Some("vault"), "search"), tool_name_hash(&one, None, "search"));
        assert_ne!(tool_namespace_hash(&one, "vault"), tool_namespace_hash(&two, "vault"));
        assert_ne!(agent_name_hash(&one, "reviewer"), agent_name_hash(&two, "reviewer"));
        let short = tool_name_hash(&one, None, "private_tool");
        assert_eq!(short.len(), 18);
        assert!(short.starts_with("h:") && short[2..].bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn keyed_digest_is_not_the_plain_digest() {
        let key = PrivacyKey::fixed_for_tests();
        let value = json!(["project", "/work/app"]);
        assert_ne!(key.keyed_digest(&value), crate::pyjson::digest(&value));
    }

    #[test]
    fn keys_round_trip_through_hex_and_never_debug_print() {
        let key = PrivacyKey::generate();
        let hex = key.to_hex();
        assert_eq!(hex.len(), 64);
        assert_eq!(PrivacyKey::from_hex(&hex), Some(key.clone()));
        assert_ne!(PrivacyKey::generate(), key);
        assert_eq!(PrivacyKey::from_hex("abc"), None);
        assert_eq!(PrivacyKey::from_hex(&"zz".repeat(32)), None);
        assert_eq!(format!("{key:?}"), "PrivacyKey(redacted)");
        assert!(!format!("{key:?}").contains(&hex[..8]));
    }
}
