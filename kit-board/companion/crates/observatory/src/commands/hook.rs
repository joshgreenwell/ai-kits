//! Tool hook receivers (`PreToolUse`/`PostToolUse`, Cursor hooks): append a
//! bounded snapshot to the local inbox and exit. Same latency rule as the
//! statusline; nothing is printed, and the exit code is always 0 so a hook can
//! never block a tool call.

use std::io::{self, Read};
use std::path::Path;
use std::process::ExitCode;

use jiff::Timestamp;
use observatory_contract::Sha256Hex;
use observatory_core::inbox::{HookEvent, append_hook_event, py_isoformat};
use serde_json::Value;

use crate::cli::{HookArgs, HookProvider};

pub fn hook(dir: &Path, args: HookArgs) -> ExitCode {
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        return ExitCode::SUCCESS;
    }
    let Ok(data) = serde_json::from_slice::<Value>(&input) else { return ExitCode::SUCCESS };
    let now = Timestamp::now();
    let provider = match args.provider {
        HookProvider::Claude => "claude",
        HookProvider::Cursor => "cursor",
    };
    let string =
        |key: &str| data.get(key).and_then(Value::as_str).map(|s| s.chars().take(80).collect::<String>());
    let event = HookEvent {
        observed_at: py_isoformat(now),
        provider: provider.to_owned(),
        event: string("hook_event_name").unwrap_or_else(|| "unknown".to_owned()),
        tool: string("tool_name"),
        session_hash: string("session_id").map(|id| Sha256Hex::digest(id.as_bytes()).as_str().to_owned()),
    };
    let _ = append_hook_event(&dir.join("inbox").join("hooks"), &event, now);
    ExitCode::SUCCESS
}
