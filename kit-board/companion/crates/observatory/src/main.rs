//! `observatory`: the Personal Observatory companion. One static binary per
//! machine that collects AI usage through internal adapters and publishes
//! envelope v2 to the Observatory. Thin command functions over the library crates.
#![forbid(unsafe_code)]
#![deny(unused_must_use)]

mod cli;
mod commands;
mod prompt;

use std::process::ExitCode;

use clap::Parser;

use crate::cli::{Cli, Command};

fn main() -> ExitCode {
    let cli = Cli::parse();
    // Hooks must cost about a millisecond: no tracing subscriber, no state.
    let fast_path = matches!(cli.command, Command::Statusline(_) | Command::Hook(_));
    if !fast_path {
        let level = match std::env::var("OBSERVATORY_LOG").as_deref() {
            Ok("debug") => tracing::Level::DEBUG,
            Ok("info") => tracing::Level::INFO,
            Ok("error") => tracing::Level::ERROR,
            _ => tracing::Level::WARN,
        };
        tracing_subscriber::fmt()
            .with_max_level(level)
            .with_writer(std::io::stderr)
            .with_target(false)
            .init();
    }
    match commands::dispatch(cli) {
        Ok(code) => code,
        Err(error) => {
            // Errors are codes and short sentences; never a token, a path outside the
            // configuration directory, or provider data.
            let text =
                serde_json::json!({ "ok": false, "error": error.code(), "message": error.to_string() });
            eprintln!("{text}");
            ExitCode::from(1)
        }
    }
}
