//! Shared machinery for the Personal Observatory companion: configuration,
//! settings, discovery, credentials, state, sink, outbox, HTTP, locking, and
//! the scheduler service. Adapters live in `observatory-adapters`; the command
//! tree lives in the `observatory` binary.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod adapter;
pub mod builtins;
pub mod claude_keepalive;
pub mod codex_projects;
pub mod config;
pub mod credentials;
pub mod cursor_store;
pub mod detailed;
pub mod discovery;
pub mod effective;
pub mod gate;
pub mod http;
pub mod inbox;
pub mod labels;
pub mod lock;
pub mod outbox;
pub mod paths;
pub mod privacy;
pub mod process;
pub mod projects;
pub mod provider_http;
pub mod pyjson;
pub mod resources;
pub mod run;
pub mod service;
pub mod state;
pub mod worktree;

/// The companion's semantic version, reported in every envelope.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// User agent for every request the companion makes.
pub const USER_AGENT: &str = concat!("observatory/", env!("CARGO_PKG_VERSION"));
