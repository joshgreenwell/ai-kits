//! Command implementations: thin functions over the library crates.

mod connect;
mod doctor;
mod hook;
mod projects;
mod run;
mod service;
mod settings;
mod setup;
mod status;
mod statusline;

use std::path::PathBuf;
use std::process::ExitCode;

use observatory_core::config::ConfigError;
use observatory_core::http::HttpError;
use observatory_core::paths;
use observatory_core::run::RunError;
use observatory_core::service::ServiceError;
use observatory_core::state::StateError;
use thiserror::Error;

use crate::cli::{Cli, Command};

#[derive(Debug, Error)]
pub enum CommandError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error(transparent)]
    Http(#[from] HttpError),
    #[error(transparent)]
    Run(#[from] RunError),
    #[error(transparent)]
    State(#[from] StateError),
    #[error(transparent)]
    Service(#[from] ServiceError),
    #[error(transparent)]
    Path(#[from] paths::PathError),
    #[error("this machine is already connected; pass --force to replace the pairing")]
    AlreadyConnected,
    #[error("{0}")]
    Invalid(String),
    #[error("a local file could not be written")]
    Io(#[from] std::io::Error),
}

impl CommandError {
    /// A bounded code for the JSON error line.
    pub fn code(&self) -> &'static str {
        match self {
            CommandError::Config(ConfigError::NotConnected) => "not_connected",
            CommandError::Config(_) => "config_error",
            CommandError::Http(HttpError::InvalidUrl) => "invalid_url",
            CommandError::Http(HttpError::Status(401 | 403)) => "unauthorized",
            CommandError::Http(_) => "http_error",
            CommandError::Run(RunError::InvalidSince) => "invalid_since",
            CommandError::Run(_) => "run_error",
            CommandError::State(_) => "state_error",
            CommandError::Service(_) => "service_error",
            CommandError::Path(_) => "path_error",
            CommandError::AlreadyConnected => "already_connected",
            CommandError::Invalid(_) => "invalid_argument",
            CommandError::Io(_) => "io_error",
        }
    }
}

pub type CommandResult = Result<ExitCode, CommandError>;

/// Resolves the configuration directory from the flag, the environment, or the platform default.
pub fn config_dir(cli: &Cli) -> Result<PathBuf, CommandError> {
    match &cli.config_dir {
        Some(dir) => Ok(dir.clone()),
        None => Ok(paths::config_dir()?),
    }
}

pub fn print_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(_) => println!("{{\"ok\":false,\"error\":\"serialize\"}}"),
    }
}

pub fn dispatch(cli: Cli) -> CommandResult {
    let dir = config_dir(&cli)?;
    match cli.command {
        Command::Connect(args) => connect::connect(&dir, args),
        Command::Setup(args) => setup::setup(&dir, args),
        Command::Run(args) => run::run(&dir, args),
        Command::Serve => {
            print_json(
                &serde_json::json!({ "ok": false, "error": "not_available", "message": "Live mode arrives in a later phase; settings.live_mode has no effect yet." }),
            );
            Ok(ExitCode::from(2))
        }
        Command::Service(args) => service::service(&dir, args),
        Command::Statusline(args) => Ok(statusline::statusline(&dir, args)),
        Command::Hook(args) => Ok(hook::hook(&dir, args)),
        Command::Status => status::status(&dir),
        Command::Projects => projects::projects(&dir),
        Command::Doctor => doctor::doctor(&dir),
        Command::Settings(args) => settings::settings(&dir, args),
        Command::Version => {
            println!("{}", observatory_core::VERSION);
            Ok(ExitCode::SUCCESS)
        }
    }
}
