//! Provider adapters for the Personal Observatory companion, one module per
//! adapter behind the `Adapter` trait from `observatory-core`.
//!
//! Phase 1 ships `claude_execution` and `codex_execution` as exact ports of
//! `collect.py` v1.1.0 (see `jsonl`), and `claude_account` as the Claude
//! statusline allowance reader. Every other adapter is present as a
//! contract-conformant stub: it reports its prerequisites in `preflight` and,
//! until its provider fixture exists, reports coverage `failed` with
//! `unrecognized_payload` and parser version `0`. It never guesses a shape.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod agents;
pub mod claude_account;
pub mod claude_execution;
pub mod codex_execution;
pub mod jsonl;
pub mod readings;
pub mod requests;
pub mod resources;
pub mod stubs;
pub mod tools;

use observatory_core::adapter::Adapter;

/// Every companion adapter, in run order.
pub fn adapters() -> Vec<Box<dyn Adapter>> {
    vec![
        Box::new(claude_execution::ClaudeExecution),
        Box::new(codex_execution::CodexExecution),
        Box::new(claude_account::ClaudeAccount),
        Box::new(stubs::CodexAccount),
        Box::new(stubs::CursorExecution),
        Box::new(stubs::CursorAccount),
        Box::new(stubs::AnthropicApi),
        Box::new(stubs::OpenaiApi),
    ]
}

/// The parser version the two execution adapters report: the companion version,
/// since their behavior is pinned to `collect.py` v1.1.0 plus the v2 fields.
pub const EXECUTION_PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+v1.1.0-detail5");
