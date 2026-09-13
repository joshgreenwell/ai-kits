//! The detailed monthly report step: runs the kept v1 analyzer adapter
//! (`scripts/telemetry/detailed_report.py`) as a subprocess when the
//! `detailed_monthly_report` setting is on and the binding names the analyzer.
//! The adapter keeps its own state, artifacts, and publisher credential; the
//! companion only writes a connection file for it and records the result codes.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use observatory_contract::Provider;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::LocalBinding;
use crate::discovery::find_executable;
use crate::paths::{home_dir, write_private};

/// Where a binding's analyzer lives; copied from a v1 connection or written by hand.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DetailedReportConfig {
    /// `detailed_report.py` from the v1 collector bundle.
    pub script: PathBuf,
    /// The interpreter; `python3`, then `python`, on `PATH` when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub python: Option<PathBuf>,
    pub analyzer_path: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex_home: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub analyzer_config_path: Option<PathBuf>,
    /// The separate usage-publisher credential file; never read by the companion.
    pub upload_config_path: PathBuf,
    pub machine_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct DetailedOutcome {
    pub binding_id: String,
    pub account_id: String,
    pub provider: Provider,
    pub result: Value,
}

fn failed(code: &str) -> Value {
    json!({ "status": "failed", "error": code })
}

/// Runs the adapter for one binding. Returns the adapter's JSON result, or a
/// `{status: failed, error: <code>}` value; never the subprocess's text.
pub fn run(
    config_dir: &Path,
    url: &str,
    binding: &LocalBinding,
    settings: &DetailedReportConfig,
    dry_run: bool,
    budget: Duration,
) -> Value {
    let dir = config_dir.join("detailed");
    let connection = dir.join(format!("{}.json", binding.binding_id));
    let mut report = json!({
        "analyzer_path": settings.analyzer_path, "upload_config_path": settings.upload_config_path, "machine_id": settings.machine_id,
    });
    if let Some(home) = &settings.codex_home {
        report["codex_home"] = json!(home);
    }
    if let Some(path) = &settings.analyzer_config_path {
        report["analyzer_config_path"] = json!(path);
    }
    let document = json!({
        "provider": binding.provider, "account_id": binding.account_id, "source_id": binding.binding_id,
        "mode": "local", "url": url, "key": "", "detailed_report": report,
    });
    let Ok(text) = serde_json::to_vec_pretty(&document) else { return failed("serialize") };
    if write_private(&connection, &text).is_err() {
        return failed("io_error");
    }
    let interpreter =
        settings.python.clone().or_else(|| find_executable("python3")).or_else(|| find_executable("python"));
    let Some(interpreter) = interpreter else { return failed("interpreter_missing") };
    let mut command = Command::new(interpreter);
    command.arg(&settings.script).arg("--config").arg(&connection);
    if dry_run {
        command.arg("--dry-run");
    }
    let mut child = match command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(child) => child,
        Err(_) => return failed("spawn_failed"),
    };
    let started = Instant::now();
    let mut stdout = child.stdout.take();
    let reader = std::thread::spawn(move || {
        let mut buffer = Vec::new();
        if let Some(handle) = stdout.as_mut() {
            let _ = handle.by_ref().take(256 * 1024).read_to_end(&mut buffer);
        }
        buffer
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if started.elapsed() > budget => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(_) => break None,
        }
    };
    let output = reader.join().unwrap_or_default();
    let Some(status) = status else { return failed("timeout") };
    match serde_json::from_slice::<Value>(&output) {
        Ok(value) if value.is_object() => {
            if status.success() {
                value
            } else {
                // The adapter prints a bounded failure code before a non-zero exit.
                json!({ "status": "failed", "error": value.get("error").and_then(Value::as_str).unwrap_or("exit_nonzero") })
            }
        }
        _ => failed(if status.success() { "invalid_output" } else { "exit_nonzero" }),
    }
}

/// The v1 telemetry directory on this machine.
fn v1_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(base).join("PersonalObservatory"));
        }
    } else if let Some(home) = home_dir() {
        dirs.push(home.join(".config/personal-hub/telemetry"));
    }
    dirs
}

/// The interpreter and `collect.py` directory a v1 macOS LaunchAgent uses for a source.
fn launch_agent_program(source_id: &str) -> Option<(PathBuf, PathBuf)> {
    let plist = home_dir()?
        .join("Library/LaunchAgents")
        .join(format!("com.personal-observatory.usage.{source_id}.plist"));
    let value = plist::Value::from_file(&plist).ok()?;
    let arguments = value.as_dictionary()?.get("ProgramArguments")?.as_array()?;
    let python = PathBuf::from(arguments.first()?.as_string()?);
    let script = PathBuf::from(arguments.get(1)?.as_string()?);
    Some((python, script.parent()?.to_path_buf()))
}

/// Finds a v1 connection for the provider that opted into the detailed report and
/// turns it into a companion configuration, when `detailed_report.py` can be located.
pub fn discover_v1(provider: Provider) -> Option<DetailedReportConfig> {
    for dir in v1_dirs() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        let mut files: Vec<PathBuf> = entries
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "json"))
            .collect();
        files.sort();
        for path in files {
            let Ok(bytes) = std::fs::read(&path) else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { continue };
            if value.get("provider").and_then(Value::as_str) != Some(provider.as_str())
                || value.get("mode").and_then(Value::as_str) != Some("local")
            {
                continue;
            }
            let Some(settings) = value.get("detailed_report").and_then(Value::as_object) else { continue };
            let text = |key: &str| settings.get(key).and_then(Value::as_str).map(str::to_owned);
            let (Some(analyzer_path), Some(upload_config_path), Some(machine_id)) =
                (text("analyzer_path"), text("upload_config_path"), text("machine_id"))
            else {
                continue;
            };
            let source_id = value.get("source_id").and_then(Value::as_str).unwrap_or("");
            let (python, script_dir) = launch_agent_program(source_id)
                .map(|(python, dir)| (Some(python), dir))
                .unwrap_or((None, dir.clone()));
            let script = script_dir.join("detailed_report.py");
            if !script.is_file() {
                continue;
            }
            return Some(DetailedReportConfig {
                script,
                python,
                analyzer_path: PathBuf::from(analyzer_path),
                codex_home: text("codex_home").map(PathBuf::from),
                analyzer_config_path: text("analyzer_config_path").map(PathBuf::from),
                upload_config_path: PathBuf::from(upload_config_path),
                machine_id,
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use observatory_contract::{AccountId, Uuid};
    use std::str::FromStr;

    #[test]
    fn config_round_trips_without_unknown_keys() {
        let text = r#"{"script":"/x/detailed_report.py","analyzer_path":"/x/a.py","upload_config_path":"/x/u.json","machine_id":"m1","codex_home":"/x/.codex"}"#;
        let config: DetailedReportConfig = serde_json::from_str(text).unwrap();
        assert_eq!(config.machine_id, "m1");
        assert!(
            serde_json::from_str::<DetailedReportConfig>(&text.replace("machine_id", "machine")).is_err()
        );
    }

    #[test]
    fn a_missing_script_fails_with_a_code() {
        let dir = tempfile::tempdir().unwrap();
        let binding = LocalBinding {
            binding_id: Uuid::v4(),
            account_id: AccountId::from_str("codex-primary").unwrap(),
            provider: Provider::Codex,
            roots: None,
            codex_home: None,
            cursor_state_db: None,
            detailed_report: None,
        };
        let settings = DetailedReportConfig {
            script: dir.path().join("missing.py"),
            python: Some(dir.path().join("no-such-interpreter")),
            analyzer_path: dir.path().join("a.py"),
            codex_home: None,
            analyzer_config_path: None,
            upload_config_path: dir.path().join("u.json"),
            machine_id: "m".into(),
        };
        let result = run(dir.path(), "https://localhost", &binding, &settings, true, Duration::from_secs(5));
        assert_eq!(result["status"], "failed");
        assert_eq!(result["error"], "spawn_failed");
        let written: Value = serde_json::from_slice(
            &std::fs::read(dir.path().join("detailed").join(format!("{}.json", binding.binding_id))).unwrap(),
        )
        .unwrap();
        assert_eq!(written["mode"], "local");
        assert_eq!(written["key"], "");
        assert_eq!(written["detailed_report"]["machine_id"], "m");
    }
}
