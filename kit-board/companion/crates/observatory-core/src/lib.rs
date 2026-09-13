//! Shared machinery for the Personal Observatory companion: configuration,
//! settings, discovery, credentials, state, sink, outbox, HTTP, locking, and
//! the scheduler service. Adapters live in `observatory-adapters`; the command
//! tree lives in the `observatory` binary.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod adapter;
pub mod config;
pub mod credentials;
pub mod detailed;
pub mod discovery;
pub mod effective;
pub mod http;
pub mod inbox;
pub mod lock;
pub mod outbox;
pub mod paths;
pub mod pyjson;
pub mod run;
pub mod service;
pub mod state;

/// The companion's semantic version, reported in every envelope.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// User agent for every request the companion makes.
pub const USER_AGENT: &str = concat!("observatory/", env!("CARGO_PKG_VERSION"));
