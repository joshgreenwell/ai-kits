//! The Claude Code statusline command. Reads the statusline JSON on stdin,
//! appends allowance samples to the local inbox, prints the same one-line
//! summary `statusline.py` prints, and always exits 0, printing `Claude` on
//! any failure. No network, no SQLite, about a millisecond.

use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

use jiff::Timestamp;
use observatory_core::config::CompanionConfig;
use observatory_core::inbox::{
    record_statusline_status, samples_from_statusline, summary_line, write_statusline_samples,
};
use serde_json::Value;

use crate::cli::StatuslineArgs;

fn inbox_path(dir: &Path, args: &StatuslineArgs) -> (PathBuf, Option<String>) {
    if let Some(inbox) = &args.inbox {
        return (inbox.clone(), None);
    }
    match CompanionConfig::load(dir) {
        Ok(config) => (config.statusline_inbox(dir), passthrough(dir)),
        Err(_) => (dir.join("inbox").join("claude-statusline"), passthrough(dir)),
    }
}

/// A previous custom statusline command, preserved by `setup` beside the config.
fn passthrough(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("claude-statusline-passthrough.txt")).ok()?;
    let trimmed = text.trim();
    if trimmed.is_empty() { None } else { Some(trimmed.to_owned()) }
}

fn run_passthrough(command: &str, input: &[u8]) -> Option<String> {
    let mut child = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?
    } else {
        Command::new("sh")
            .args(["-c", command])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?
    };
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(input);
    }
    let output = child.wait_with_output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim_end().to_owned();
    if text.is_empty() { None } else { Some(text) }
}

pub fn statusline(dir: &Path, args: StatuslineArgs) -> ExitCode {
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        println!("Claude");
        return ExitCode::SUCCESS;
    }
    let Ok(data) = serde_json::from_slice::<Value>(&input) else {
        println!("Claude");
        return ExitCode::SUCCESS;
    };
    let now = Timestamp::now();
    let samples = samples_from_statusline(&data, now);
    let (inbox, passthrough) = inbox_path(dir, &args);
    if !samples.is_empty() {
        let _ = write_statusline_samples(&inbox, &samples, now);
    }
    // Diagnostics must never cost a real reading.
    let _ = record_statusline_status(&inbox, &data, &samples, now);
    let line = passthrough
        .and_then(|command| run_passthrough(&command, &input))
        .unwrap_or_else(|| summary_line(&samples));
    println!("{line}");
    ExitCode::SUCCESS
}
