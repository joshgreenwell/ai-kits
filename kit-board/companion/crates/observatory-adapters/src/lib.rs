//! Provider adapters for the Personal Observatory companion, one module per
//! adapter behind the `Adapter` trait from `observatory-core`.
//!
//! Local execution adapters (`claude_execution`, `codex_execution`) remain
//! exact ports of `collect.py` v1.1.0. Account, Cursor, and Admin API adapters
//! collect provider-reported allowance, usage, and cost through documented
//! interfaces. The v2 browser adapters are not in this crate.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

pub mod agents;
pub mod anthropic_api;
pub mod claude_account;
pub mod claude_execution;
pub mod codex_account;
pub mod codex_execution;
pub mod cursor_account;
pub mod cursor_execution;
pub mod jsonl;
pub mod openai_api;
pub mod provider;
pub mod readings;
pub mod requests;
pub mod resources;
pub mod tools;

use observatory_core::adapter::Adapter;

/// Every companion adapter, in run order.
pub fn adapters() -> Vec<Box<dyn Adapter>> {
    vec![
        Box::new(claude_execution::ClaudeExecution),
        Box::new(codex_execution::CodexExecution),
        Box::new(claude_account::ClaudeAccount),
        Box::new(codex_account::CodexAccount),
        Box::new(cursor_execution::CursorExecution),
        Box::new(cursor_account::CursorAccount),
        Box::new(anthropic_api::AnthropicApi),
        Box::new(openai_api::OpenaiApi),
    ]
}

/// The parser version the two execution adapters report: the companion version,
/// since their behavior is pinned to `collect.py` v1.1.0 plus the v2 fields.
pub const EXECUTION_PARSER_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "+v1.1.0-detail5");
