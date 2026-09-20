//! Subprocess helpers. Windows spawns stay console-less so a scheduled run
//! never flashes a window; stderr is discarded so provider logs never mix
//! with Observatory codes.

use std::ffi::OsStr;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use thiserror::Error;

/// `CREATE_NO_WINDOW` — hide a console for GUI/scheduled child processes.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A child process that does not flash a console on Windows.
pub fn command(program: impl AsRef<OsStr>) -> Command {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Runs `program` with discarded stdin/stdout/stderr so provider output never
/// mixes with Observatory codes (Claude `auth status --json` can name an email).
/// Windows `.cmd`/`.bat` go through `cmd.exe /D /C`; every spawn is console-less.
pub fn run_discarded(program: &Path, args: &[&str], timeout: Duration) -> Result<bool, RpcError> {
    let mut child = hidden_command(program, args).spawn().map_err(|_| RpcError::Io)?;
    let start = Instant::now();
    loop {
        match child.try_wait().map_err(|_| RpcError::Io)? {
            Some(status) => return Ok(status.success()),
            None if start.elapsed() >= timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(RpcError::Timeout);
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn hidden_command(program: &Path, args: &[&str]) -> Command {
    #[cfg(windows)]
    {
        let ext = program.extension().and_then(|value| value.to_str()).unwrap_or("");
        if ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat") {
            let mut line = format!("\"{}\"", program.display());
            for arg in args {
                line.push(' ');
                line.push_str(arg);
            }
            let mut cmd = command("cmd.exe");
            cmd.arg("/D").arg("/C").arg(line);
            cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            return cmd;
        }
    }
    let mut cmd = command(program);
    cmd.args(args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd
}

/// Spawns `command` with piped stdin/stdout and discarded stderr.
pub fn spawn_piped(command: &mut Command) -> io::Result<Child> {
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn()
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum RpcError {
    #[error("the subprocess pipe failed")]
    Io,
    #[error("the subprocess timed out")]
    Timeout,
    #[error("the subprocess spoke an unrecognized protocol")]
    Protocol,
    #[error("the subprocess returned an application error")]
    Application,
}

/// A JSON-RPC 2.0 child: Content-Length framing, with newline-delimited JSON as a fallback.
pub struct JsonRpcProcess {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Result<Value, RpcError>>,
}

impl JsonRpcProcess {
    pub fn spawn(command: &mut Command) -> io::Result<Self> {
        let mut child = spawn_piped(command)?;
        let stdin = child.stdin.take().ok_or_else(|| io::Error::other("stdin"))?;
        let stdout = child.stdout.take().ok_or_else(|| io::Error::other("stdout"))?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || read_loop(stdout, tx));
        Ok(JsonRpcProcess { child, stdin, rx })
    }

    pub fn notify(&mut self, method: &str, params: Value) -> Result<(), RpcError> {
        self.write(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    pub fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcError> {
        self.write(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(RpcError::Timeout);
            }
            let value = self.rx.recv_timeout(remaining).map_err(|_| RpcError::Timeout)??;
            if value.get("id").and_then(Value::as_u64) != Some(id)
                && value.get("id").and_then(Value::as_i64) != Some(id as i64)
            {
                continue;
            }
            if value.get("error").is_some_and(|error| !error.is_null()) {
                return Err(RpcError::Application);
            }
            return value.get("result").cloned().ok_or(RpcError::Protocol);
        }
    }

    fn write(&mut self, value: &Value) -> Result<(), RpcError> {
        // Codex app-server speaks newline-delimited JSON. Content-Length framing
        // is rejected (`expected value at line 1 column 1`).
        let mut body = serde_json::to_vec(value).map_err(|_| RpcError::Protocol)?;
        body.push(b'\n');
        self.stdin.write_all(&body).map_err(|_| RpcError::Io)?;
        self.stdin.flush().map_err(|_| RpcError::Io)
    }
}

impl Drop for JsonRpcProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn read_loop(stdout: ChildStdout, tx: mpsc::Sender<Result<Value, RpcError>>) {
    let mut reader = BufReader::new(stdout);
    loop {
        match read_message(&mut reader) {
            Ok(value) => {
                if tx.send(Ok(value)).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = tx.send(Err(error));
                break;
            }
        }
    }
}

fn read_message(reader: &mut BufReader<ChildStdout>) -> Result<Value, RpcError> {
    let mut line = String::new();
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|_| RpcError::Io)? == 0 {
            return Err(RpcError::Io);
        }
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            let len: usize = rest.trim().parse().map_err(|_| RpcError::Protocol)?;
            loop {
                line.clear();
                if reader.read_line(&mut line).map_err(|_| RpcError::Io)? == 0 {
                    return Err(RpcError::Io);
                }
                if line.trim().is_empty() {
                    break;
                }
            }
            let mut body = vec![0; len];
            reader.read_exact(&mut body).map_err(|_| RpcError::Io)?;
            return serde_json::from_slice(&body).map_err(|_| RpcError::Protocol);
        }
        if trimmed.starts_with('{') {
            return serde_json::from_str(trimmed).map_err(|_| RpcError::Protocol);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn discarded_success_exits_without_capturing_output() {
        let (program, args): (PathBuf, Vec<&str>) = if cfg!(windows) {
            (PathBuf::from("cmd.exe"), vec!["/C", "exit", "0"])
        } else {
            // Debian keeps `true` under /bin; macOS only under /usr/bin.
            let program = ["/bin/true", "/usr/bin/true"]
                .into_iter()
                .map(PathBuf::from)
                .find(|path| path.exists())
                .expect("a `true` binary");
            (program, vec![])
        };
        assert_eq!(run_discarded(&program, &args, Duration::from_secs(5)), Ok(true));
    }

    #[test]
    fn discarded_timeout_kills_the_child() {
        let (program, args): (PathBuf, Vec<&str>) = if cfg!(windows) {
            (PathBuf::from("cmd.exe"), vec!["/C", "ping", "127.0.0.1", "-n", "20"])
        } else {
            (PathBuf::from("/bin/sleep"), vec!["20"])
        };
        assert_eq!(run_discarded(&program, &args, Duration::from_millis(200)), Err(RpcError::Timeout));
    }
}
