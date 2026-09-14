//! The scheduler service (section 2.3): a LaunchAgent on macOS, a Task Scheduler
//! task on Windows, a systemd user timer on Linux. `uninstall` removes the
//! schedule it installed and leaves state for the user to delete. Also finds and
//! removes the v1 `collect.py` schedules the companion replaces.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use observatory_contract::Uuid;
use serde::Serialize;
use thiserror::Error;

use crate::paths::{ensure_private_dir, home_dir};

#[derive(Debug, Error)]
pub enum ServiceError {
    #[error("no scheduler is supported on this platform")]
    Unsupported,
    #[error("the scheduler command failed")]
    Command,
    #[error("scheduler file error")]
    Io(#[from] io::Error),
    #[error("no home directory")]
    NoHome,
    #[error("the companion executable path is unavailable")]
    NoExecutable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ServiceStatus {
    pub installed: bool,
    pub label: String,
    pub scheduler: &'static str,
    pub interval_minutes: Option<u64>,
}

/// The schedule label for an install.
pub fn label(install_id: &Uuid) -> String {
    if cfg!(target_os = "macos") {
        format!("com.personal-observatory.companion.{install_id}")
    } else if cfg!(windows) {
        format!("Personal Observatory Companion {install_id}")
    } else {
        "personal-observatory-companion".to_owned()
    }
}

fn scheduler_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "launchd"
    } else if cfg!(windows) {
        "schtasks"
    } else {
        "systemd"
    }
}

fn run_quiet(program: &str, args: &[&str]) -> Result<bool, ServiceError> {
    let status = Command::new(program).args(args).stdout(Stdio::null()).stderr(Stdio::null()).status()?;
    Ok(status.success())
}

fn run_capture(program: &str, args: &[&str]) -> Result<Option<String>, ServiceError> {
    let output = Command::new(program).args(args).stderr(Stdio::null()).output()?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).into_owned()))
    } else {
        Ok(None)
    }
}

fn executable() -> Result<PathBuf, ServiceError> {
    std::env::current_exe().map_err(|_| ServiceError::NoExecutable)
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct LaunchAgent {
    label: String,
    program_arguments: Vec<String>,
    start_interval: u64,
    run_at_load: bool,
    process_type: String,
    standard_out_path: String,
    standard_error_path: String,
}

fn launch_agent_path(label: &str) -> Result<PathBuf, ServiceError> {
    Ok(home_dir().ok_or(ServiceError::NoHome)?.join("Library/LaunchAgents").join(format!("{label}.plist")))
}

fn launchd_domain() -> Result<String, ServiceError> {
    let uid = run_capture("id", &["-u"])?.ok_or(ServiceError::Command)?;
    Ok(format!("gui/{}", uid.trim()))
}

fn systemd_dir() -> Result<PathBuf, ServiceError> {
    Ok(home_dir().ok_or(ServiceError::NoHome)?.join(".config/systemd/user"))
}

/// Installs (or reinstalls) the schedule for this install at the given cadence.
pub fn install(
    config_dir: &Path,
    install_id: &Uuid,
    cadence_minutes: u64,
) -> Result<ServiceStatus, ServiceError> {
    let label = label(install_id);
    let exe = executable()?;
    let logs = config_dir.join("logs");
    ensure_private_dir(&logs)?;
    if cfg!(target_os = "macos") {
        let plist = launch_agent_path(&label)?;
        let domain = launchd_domain()?;
        let service = format!("{domain}/{label}");
        if run_quiet("launchctl", &["print", &service])? {
            run_quiet("launchctl", &["bootout", &service])?;
        }
        if let Some(parent) = plist.parent() {
            fs::create_dir_all(parent)?;
        }
        let agent = LaunchAgent {
            label: label.clone(),
            program_arguments: vec![
                exe.to_string_lossy().into_owned(),
                "--config-dir".into(),
                config_dir.to_string_lossy().into_owned(),
                "run".into(),
            ],
            start_interval: cadence_minutes * 60,
            run_at_load: true,
            process_type: "Background".into(),
            standard_out_path: logs.join("companion.log").to_string_lossy().into_owned(),
            standard_error_path: logs.join("companion.error.log").to_string_lossy().into_owned(),
        };
        plist::to_file_xml(&plist, &agent).map_err(|_| ServiceError::Command)?;
        crate::state::restrict_file(&plist)?;
        if !run_quiet("launchctl", &["bootstrap", &domain, &plist.to_string_lossy()])? {
            return Err(ServiceError::Command);
        }
    } else if cfg!(windows) {
        // The directory is pinned so a run started by the scheduler and one started from a
        // packaged app (which sees a redirected %LOCALAPPDATA%) share the same state.
        let task =
            format!("\"{}\" --config-dir \"{}\" run", exe.to_string_lossy(), config_dir.to_string_lossy());
        let cadence = cadence_minutes.to_string();
        let ok = run_quiet(
            "schtasks",
            &["/Create", "/TN", &label, "/TR", &task, "/SC", "MINUTE", "/MO", &cadence, "/IT", "/F"],
        )?;
        if !ok {
            return Err(ServiceError::Command);
        }
    } else if cfg!(target_os = "linux") {
        let dir = systemd_dir()?;
        fs::create_dir_all(&dir)?;
        let service = format!(
            "[Unit]\nDescription=Personal Observatory companion\n\n[Service]\nType=oneshot\nExecStart={} --config-dir {} run\n",
            exe.to_string_lossy(),
            config_dir.to_string_lossy()
        );
        let timer = format!(
            "[Unit]\nDescription=Personal Observatory companion schedule\n\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec={cadence_minutes}min\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n"
        );
        fs::write(dir.join(format!("{label}.service")), service)?;
        fs::write(dir.join(format!("{label}.timer")), timer)?;
        let timer_unit = format!("{label}.timer");
        if !run_quiet("systemctl", &["--user", "daemon-reload"])?
            || !run_quiet("systemctl", &["--user", "enable", "--now", &timer_unit])?
        {
            return Err(ServiceError::Command);
        }
    } else {
        return Err(ServiceError::Unsupported);
    }
    Ok(ServiceStatus {
        installed: true,
        label,
        scheduler: scheduler_name(),
        interval_minutes: Some(cadence_minutes),
    })
}

/// Removes the schedule. State, config, and logs stay for the user to delete.
pub fn uninstall(install_id: &Uuid) -> Result<ServiceStatus, ServiceError> {
    let label = label(install_id);
    if cfg!(target_os = "macos") {
        let plist = launch_agent_path(&label)?;
        let service = format!("{}/{label}", launchd_domain()?);
        if run_quiet("launchctl", &["print", &service])? {
            run_quiet("launchctl", &["bootout", &service])?;
        }
        if plist.exists() {
            fs::remove_file(&plist)?;
        }
    } else if cfg!(windows) {
        run_quiet("schtasks", &["/Delete", "/TN", &label, "/F"])?;
    } else if cfg!(target_os = "linux") {
        let dir = systemd_dir()?;
        let timer_unit = format!("{label}.timer");
        run_quiet("systemctl", &["--user", "disable", "--now", &timer_unit])?;
        for name in [format!("{label}.timer"), format!("{label}.service")] {
            let path = dir.join(name);
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
        run_quiet("systemctl", &["--user", "daemon-reload"])?;
    } else {
        return Err(ServiceError::Unsupported);
    }
    Ok(ServiceStatus { installed: false, label, scheduler: scheduler_name(), interval_minutes: None })
}

/// Whether the schedule is installed.
pub fn status(install_id: &Uuid) -> Result<ServiceStatus, ServiceError> {
    let label = label(install_id);
    let installed = if cfg!(target_os = "macos") {
        let service = format!("{}/{label}", launchd_domain()?);
        run_quiet("launchctl", &["print", &service])?
    } else if cfg!(windows) {
        run_quiet("schtasks", &["/Query", "/TN", &label])?
    } else if cfg!(target_os = "linux") {
        let timer_unit = format!("{label}.timer");
        run_quiet("systemctl", &["--user", "is-enabled", &timer_unit])?
    } else {
        return Err(ServiceError::Unsupported);
    };
    Ok(ServiceStatus { installed, label, scheduler: scheduler_name(), interval_minutes: None })
}

/// Labels of v1 `collect.py` schedules found on this machine.
pub fn v1_schedules() -> Vec<String> {
    if cfg!(target_os = "macos") {
        let Some(home) = home_dir() else { return Vec::new() };
        let Ok(entries) = fs::read_dir(home.join("Library/LaunchAgents")) else { return Vec::new() };
        let mut labels: Vec<String> = entries
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_str().map(str::to_owned))
            .filter(|name| name.starts_with("com.personal-observatory.usage.") && name.ends_with(".plist"))
            .map(|name| name.trim_end_matches(".plist").to_owned())
            .collect();
        labels.sort();
        labels
    } else if cfg!(windows) {
        let Ok(Some(output)) = run_capture("schtasks", &["/Query", "/FO", "CSV", "/NH"]) else {
            return Vec::new();
        };
        let mut labels: Vec<String> = output
            .lines()
            .filter_map(|line| line.split(',').next())
            .map(|cell| cell.trim_matches('"').trim_start_matches('\\').to_owned())
            .filter(|name| name.starts_with("Personal Observatory Usage "))
            .collect();
        labels.sort();
        labels.dedup();
        labels
    } else {
        Vec::new()
    }
}

/// Removes a v1 schedule by label.
pub fn uninstall_v1(label: &str) -> Result<(), ServiceError> {
    if cfg!(target_os = "macos") {
        let service = format!("{}/{label}", launchd_domain()?);
        if run_quiet("launchctl", &["print", &service])? {
            run_quiet("launchctl", &["bootout", &service])?;
        }
        let plist = launch_agent_path(label)?;
        if plist.exists() {
            fs::remove_file(plist)?;
        }
        Ok(())
    } else if cfg!(windows) {
        if run_quiet("schtasks", &["/Delete", "/TN", label, "/F"])? {
            Ok(())
        } else {
            Err(ServiceError::Command)
        }
    } else {
        Err(ServiceError::Unsupported)
    }
}

// --- reading the installed schedule back ---------------------------------------

/// The installed schedule as the scheduler reports it, for the capability
/// document and `doctor`. Nothing here rewrites a schedule; a run must never
/// replace the job that started it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct InstalledSchedule {
    /// `launchd`, `task_scheduler`, or `systemd`; `None` on an unsupported platform.
    pub mechanism: Option<&'static str>,
    /// `not_installed`, `installed`, or `unreadable` (installed, interval not recoverable).
    pub state: &'static str,
    pub interval_minutes: Option<u64>,
    /// Whether the installed command pins `--config-dir` to this configuration directory.
    pub config_dir_pinned: bool,
}

fn mechanism_name() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("launchd")
    } else if cfg!(windows) {
        Some("task_scheduler")
    } else if cfg!(target_os = "linux") {
        Some("systemd")
    } else {
        None
    }
}

fn run_capture_bytes(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = Command::new(program).args(args).stderr(Stdio::null()).output().ok()?;
    output.status.success().then_some(output.stdout)
}

/// Console output as text: `schtasks /XML` writes UTF-16 (with or without a BOM);
/// everything else is UTF-8.
pub fn decode_console_text(bytes: &[u8]) -> String {
    let (little, offset) = match bytes {
        [0xFF, 0xFE, ..] => (true, 2),
        [0xFE, 0xFF, ..] => (false, 2),
        [_, 0, _, 0, ..] => (true, 0),
        [0, _, 0, _, ..] => (false, 0),
        _ => return String::from_utf8_lossy(bytes).into_owned(),
    };
    let units: Vec<u16> = bytes[offset..]
        .chunks_exact(2)
        .map(|pair| {
            if little {
                u16::from_le_bytes([pair[0], pair[1]])
            } else {
                u16::from_be_bytes([pair[0], pair[1]])
            }
        })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Minutes in an ISO 8601 duration such as `PT1H`, `PT30M`, or `PT1H30M`.
pub fn parse_iso8601_minutes(text: &str) -> Option<u64> {
    let rest = text.trim().strip_prefix("PT")?;
    let mut minutes = 0u64;
    let mut number = String::new();
    let mut any = false;
    for ch in rest.chars() {
        if ch.is_ascii_digit() {
            number.push(ch);
            continue;
        }
        let value: u64 = number.parse().ok()?;
        number.clear();
        minutes = minutes.checked_add(match ch {
            'H' => value.checked_mul(60)?,
            'M' => value,
            'S' => value / 60,
            _ => return None,
        })?;
        any = true;
    }
    (any && number.is_empty()).then_some(minutes)
}

fn xml_element<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let start = text.find(&format!("<{name}>"))? + name.len() + 2;
    let end = start + text[start..].find(&format!("</{name}>"))?;
    Some(&text[start..end])
}

/// The repetition interval of a `schtasks /Query /XML` task: only the
/// `Triggers/*/Repetition/Interval` element counts, never `IdleSettings` or
/// `ExecutionTimeLimit` durations.
pub fn parse_schtasks_repetition_minutes(xml: &str) -> Option<u64> {
    let triggers = xml_element(xml, "Triggers")?;
    let repetition = xml_element(triggers, "Repetition")?;
    parse_iso8601_minutes(xml_element(repetition, "Interval")?)
}

/// Whether the task's `Arguments` pin the given configuration directory.
pub fn schtasks_pins_config_dir(xml: &str, config_dir: &Path) -> bool {
    let Some(arguments) = xml_element(xml, "Arguments") else { return false };
    arguments_pin_config_dir(&arguments.replace("&quot;", "\""), config_dir)
}

fn same_dir(left: &str, right: &Path) -> bool {
    let normalize = |text: &str| {
        let text = text.trim().trim_matches('"').replace('\\', "/");
        let text = text.trim_end_matches('/');
        if cfg!(windows) { text.to_lowercase() } else { text.to_owned() }
    };
    normalize(left) == normalize(&right.to_string_lossy())
}

fn arguments_pin_config_dir(arguments: &str, config_dir: &Path) -> bool {
    let Some(index) = arguments.find("--config-dir") else { return false };
    let rest = arguments[index + "--config-dir".len()..].trim_start_matches(['=', ' ']);
    let value = if let Some(quoted) = rest.strip_prefix('"') {
        quoted.split('"').next().unwrap_or_default()
    } else {
        rest.split_whitespace().next().unwrap_or_default()
    };
    same_dir(value, config_dir)
}

/// The `run interval = <seconds>` line of `launchctl print`.
pub fn parse_launchctl_run_interval_minutes(text: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("run interval =")?.trim();
        value.parse::<u64>().ok().map(|seconds| seconds / 60)
    })
}

/// `OnUnitActiveSec=` from a timer unit, or `TimersMonotonic=` from `systemctl show`.
pub fn parse_systemd_minutes(text: &str) -> Option<u64> {
    for line in text.lines() {
        let line = line.trim();
        let value = if let Some(v) = line.strip_prefix("OnUnitActiveSec=") {
            v
        } else if let Some(v) = line.strip_prefix("TimersMonotonic=") {
            v.split("OnUnitActiveUSec=").nth(1)?.split(';').next()?.trim()
        } else {
            continue;
        };
        return parse_systemd_span_minutes(value);
    }
    None
}

fn parse_systemd_span_minutes(text: &str) -> Option<u64> {
    let mut total = 0u64;
    let mut any = false;
    for part in text.split_whitespace() {
        let digits: String = part.chars().take_while(char::is_ascii_digit).collect();
        let value: u64 = digits.parse().ok()?;
        let unit = &part[digits.len()..];
        total += match unit {
            "h" | "hr" | "hour" | "hours" => value * 60,
            "min" | "m" | "minute" | "minutes" => value,
            "s" | "sec" | "second" | "seconds" => value / 60,
            "us" | "usec" | "ms" | "msec" => 0,
            _ => return None,
        };
        any = true;
    }
    any.then_some(total)
}

/// Reads the schedule back from the scheduler that runs it.
pub fn installed_schedule(config_dir: &Path, install_id: &Uuid) -> InstalledSchedule {
    let label = label(install_id);
    let mechanism = mechanism_name();
    let not_installed = InstalledSchedule {
        mechanism,
        state: "not_installed",
        interval_minutes: None,
        config_dir_pinned: false,
    };
    let unreadable = |pinned: bool| InstalledSchedule {
        mechanism,
        state: "unreadable",
        interval_minutes: None,
        config_dir_pinned: pinned,
    };
    if cfg!(windows) {
        let Some(bytes) = run_capture_bytes("schtasks", &["/Query", "/TN", &label, "/XML"]) else {
            return not_installed;
        };
        let xml = decode_console_text(&bytes);
        let pinned = schtasks_pins_config_dir(&xml, config_dir);
        match parse_schtasks_repetition_minutes(&xml) {
            Some(minutes) => InstalledSchedule {
                mechanism,
                state: "installed",
                interval_minutes: Some(minutes),
                config_dir_pinned: pinned,
            },
            None => unreadable(pinned),
        }
    } else if cfg!(target_os = "macos") {
        let Ok(domain) = launchd_domain() else { return unreadable(false) };
        let Some(printed) = run_capture_bytes("launchctl", &["print", &format!("{domain}/{label}")]) else {
            return not_installed;
        };
        let printed = decode_console_text(&printed);
        let loaded = parse_launchctl_run_interval_minutes(&printed);
        let (file_interval, pinned) = launch_agent_path(&label)
            .ok()
            .and_then(|path| fs::read(path).ok())
            .and_then(|bytes| plist::from_bytes::<plist::Value>(&bytes).ok())
            .and_then(|value| {
                let dict = value.as_dictionary()?;
                let seconds = dict.get("StartInterval").and_then(plist::Value::as_unsigned_integer);
                let arguments: Vec<String> = dict
                    .get("ProgramArguments")
                    .and_then(plist::Value::as_array)
                    .map(|items| {
                        items.iter().filter_map(|item| item.as_string().map(str::to_owned)).collect()
                    })
                    .unwrap_or_default();
                Some((seconds.map(|s| s / 60), arguments_pin_config_dir(&arguments.join(" "), config_dir)))
            })
            .unwrap_or((None, false));
        match (loaded, file_interval) {
            (Some(loaded), Some(file)) if loaded == file => InstalledSchedule {
                mechanism,
                state: "installed",
                interval_minutes: Some(loaded),
                config_dir_pinned: pinned,
            },
            (Some(loaded), None) => InstalledSchedule {
                mechanism,
                state: "installed",
                interval_minutes: Some(loaded),
                config_dir_pinned: pinned,
            },
            _ => unreadable(pinned),
        }
    } else if cfg!(target_os = "linux") {
        let timer_unit = format!("{label}.timer");
        let enabled = run_quiet("systemctl", &["--user", "is-enabled", &timer_unit]).unwrap_or(false);
        if !enabled {
            return not_installed;
        }
        let shown = run_capture_bytes("systemctl", &["--user", "show", &timer_unit, "-p", "TimersMonotonic"])
            .map(|bytes| decode_console_text(&bytes))
            .and_then(|text| parse_systemd_minutes(&text));
        let dir = systemd_dir().ok();
        let file = dir
            .as_ref()
            .and_then(|dir| fs::read_to_string(dir.join(&timer_unit)).ok())
            .and_then(|text| parse_systemd_minutes(&text));
        let pinned = dir
            .as_ref()
            .and_then(|dir| fs::read_to_string(dir.join(format!("{label}.service"))).ok())
            .map(|text| arguments_pin_config_dir(&text, config_dir))
            .unwrap_or(false);
        match shown.or(file) {
            Some(minutes) => InstalledSchedule {
                mechanism,
                state: "installed",
                interval_minutes: Some(minutes),
                config_dir_pinned: pinned,
            },
            None => unreadable(pinned),
        }
    } else {
        InstalledSchedule {
            mechanism: None,
            state: "not_installed",
            interval_minutes: None,
            config_dir_pinned: false,
        }
    }
}

#[cfg(test)]
mod readback_tests {
    use super::*;

    // Shapes captured from real `schtasks /Query /XML` output for 15-, 30-, and 60-minute
    // tasks: the default cadence serializes as PT1H, and other durations sit nearby.
    fn task_xml(interval: &str, arguments: &str) -> String {
        format!(
            "<?xml version=\"1.0\" encoding=\"UTF-16\"?>\n<Task version=\"1.2\">\n  <Triggers>\n    <TimeTrigger>\n      <Repetition>\n        <Interval>{interval}</Interval>\n        <StopAtDurationEnd>false</StopAtDurationEnd>\n      </Repetition>\n      <StartBoundary>2026-09-13T22:00:00</StartBoundary>\n      <Enabled>true</Enabled>\n    </TimeTrigger>\n  </Triggers>\n  <Settings>\n    <IdleSettings>\n      <Duration>PT10M</Duration>\n      <WaitTimeout>PT1H</WaitTimeout>\n    </IdleSettings>\n    <ExecutionTimeLimit>PT72H</ExecutionTimeLimit>\n  </Settings>\n  <Actions Context=\"Author\">\n    <Exec>\n      <Command>\"C:\\Users\\synthetic\\observatory.exe\"</Command>\n      <Arguments>{arguments}</Arguments>\n    </Exec>\n  </Actions>\n</Task>\n"
        )
    }

    #[test]
    fn iso8601_durations_convert_to_minutes() {
        assert_eq!(parse_iso8601_minutes("PT15M"), Some(15));
        assert_eq!(parse_iso8601_minutes("PT30M"), Some(30));
        assert_eq!(parse_iso8601_minutes("PT1H"), Some(60));
        assert_eq!(parse_iso8601_minutes("PT1H30M"), Some(90));
        assert_eq!(parse_iso8601_minutes("PT90S"), Some(1));
        assert_eq!(parse_iso8601_minutes("P1D"), None);
        assert_eq!(parse_iso8601_minutes("PT"), None);
        assert_eq!(parse_iso8601_minutes("PT1X"), None);
    }

    #[test]
    fn schtasks_interval_comes_from_the_trigger_only() {
        let args = "--config-dir &quot;C:\\Users\\synthetic\\.config\\personal-hub\\companion&quot; run";
        let xml = task_xml("PT1H", args);
        assert_eq!(parse_schtasks_repetition_minutes(&xml), Some(60));
        assert_eq!(parse_schtasks_repetition_minutes(&task_xml("PT15M", args)), Some(15));
        assert_eq!(parse_schtasks_repetition_minutes(&task_xml("PT1H30M", args)), Some(90));
        let no_trigger = xml.replace("<Triggers>", "<Triggerz>").replace("</Triggers>", "</Triggerz>");
        assert_eq!(
            parse_schtasks_repetition_minutes(&no_trigger),
            None,
            "idle-settings durations never count"
        );
        let dir = Path::new("C:/Users/synthetic/.config/personal-hub/companion/");
        assert!(schtasks_pins_config_dir(&xml, dir));
        assert!(!schtasks_pins_config_dir(&task_xml("PT1H", "run"), dir));
        assert!(!schtasks_pins_config_dir(&xml, Path::new("C:/Users/synthetic/other")));
    }

    #[test]
    fn console_bytes_decode_utf16_with_or_without_a_bom() {
        let text = "<Interval>PT1H</Interval>";
        let mut bom = vec![0xFF, 0xFE];
        bom.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        assert_eq!(decode_console_text(&bom), text);
        let bare: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_console_text(&bare), text);
        assert_eq!(decode_console_text(text.as_bytes()), text);
    }

    #[test]
    fn launchd_and_systemd_intervals_parse() {
        let printed = "gui/501/com.personal-observatory.companion.x = {\n\tactive count = 0\n\tpath = /Users/synthetic/Library/LaunchAgents/x.plist\n\trun interval = 3600\n\tstate = waiting\n}";
        assert_eq!(parse_launchctl_run_interval_minutes(printed), Some(60));
        assert_eq!(parse_launchctl_run_interval_minutes("state = waiting"), None);
        assert_eq!(parse_systemd_minutes("[Timer]\nOnBootSec=2min\nOnUnitActiveSec=30min\n"), Some(30));
        assert_eq!(parse_systemd_minutes("OnUnitActiveSec=1h"), Some(60));
        assert_eq!(
            parse_systemd_minutes(
                "TimersMonotonic={ OnBootUSec=2min ; next_elapse=... } { OnUnitActiveUSec=15min ; next_elapse=... }"
            ),
            Some(15)
        );
        assert_eq!(parse_systemd_minutes("Description=x"), None);
        assert!(arguments_pin_config_dir(
            "ExecStart=/opt/observatory --config-dir /home/s/.config/personal-hub/companion run",
            Path::new("/home/s/.config/personal-hub/companion")
        ));
        assert!(!arguments_pin_config_dir(
            "ExecStart=/opt/observatory run",
            Path::new("/home/s/.config/personal-hub/companion")
        ));
    }
}
