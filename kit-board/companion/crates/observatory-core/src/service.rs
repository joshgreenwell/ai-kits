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
            program_arguments: vec![exe.to_string_lossy().into_owned(), "run".into()],
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
        let task = format!("\"{}\" run", exe.to_string_lossy());
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
            "[Unit]\nDescription=Personal Observatory companion\n\n[Service]\nType=oneshot\nExecStart={} run\n",
            exe.to_string_lossy()
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
