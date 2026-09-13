//! The command surface (section 2.3).

use std::path::PathBuf;

use clap::{Args, Parser, Subcommand, ValueEnum};

#[derive(Parser, Debug)]
#[command(
    name = "observatory",
    version,
    about = "Personal Observatory companion: collects AI usage on this machine"
)]
pub struct Cli {
    /// Configuration directory (defaults to the platform location; also `OBSERVATORY_CONFIG_DIR`).
    #[arg(long, global = true, value_name = "DIR")]
    pub config_dir: Option<PathBuf>,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Pair this machine with the Observatory using a one-time code.
    Connect(ConnectArgs),
    /// Discover installed products, propose bindings, choose readers, and install the schedule.
    Setup(SetupArgs),
    /// One collection cycle.
    Run(RunArgs),
    /// Live mode (a later phase).
    Serve,
    /// Install, remove, or inspect the scheduler entry.
    Service(ServiceArgs),
    /// Claude Code statusline command: reads the statusline JSON on stdin.
    Statusline(StatuslineArgs),
    /// Tool hook receiver: appends a bounded snapshot to the local inbox and exits.
    Hook(HookArgs),
    /// Last run summary, outbox, receipts, and schedule state.
    Status,
    /// Working directories this install has seen and their project hashes (local only).
    Projects,
    /// Effective mode and reason per adapter; prerequisite and credential checks.
    Doctor,
    /// The cached effective settings document.
    Settings(SettingsArgs),
    /// Print the semantic version.
    Version,
}

#[derive(Args, Debug)]
pub struct ConnectArgs {
    /// The Observatory origin, e.g. https://personal-observatory-jg.vercel.app
    #[arg(long)]
    pub url: String,
    /// The one-time pairing code shown in Usage → Connections (XXXX-XXXX).
    #[arg(long)]
    pub code: String,
    /// A label for this machine; defaults to the host name.
    #[arg(long)]
    pub label: Option<String>,
    /// Backfill start (YYYY-MM-DD). Pinned by the first run; defaults to the first day of the
    /// current UTC month. Local logs older than this are never read.
    #[arg(long, value_name = "YYYY-MM-DD")]
    pub since: Option<String>,
    /// Replace an existing pairing on this machine.
    #[arg(long)]
    pub force: bool,
}

#[derive(Args, Debug)]
pub struct SetupArgs {
    /// Accept every default without asking.
    #[arg(long)]
    pub yes: bool,
    /// Bind a provider to an account id, e.g. --bind claude=claude-primary (repeatable).
    #[arg(long = "bind", value_name = "PROVIDER=ACCOUNT")]
    pub bind: Vec<String>,
    /// Create secrets.json (0600) for Admin API keys.
    #[arg(long)]
    pub secrets: bool,
}

#[derive(Args, Debug)]
pub struct RunArgs {
    /// Collect and report what would be uploaded without uploading.
    #[arg(long)]
    pub dry_run: bool,
    /// Do not contact the Observatory for the config document; use the cache or defaults.
    #[arg(long)]
    pub offline: bool,
}

#[derive(Args, Debug)]
pub struct ServiceArgs {
    #[command(subcommand)]
    pub action: ServiceAction,
}

#[derive(Subcommand, Debug)]
pub enum ServiceAction {
    Install,
    Uninstall,
    Status,
}

#[derive(Args, Debug)]
pub struct StatuslineArgs {
    /// Inbox directory override (defaults to the configured inbox).
    #[arg(long)]
    pub inbox: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct HookArgs {
    pub provider: HookProvider,
}

#[derive(ValueEnum, Clone, Copy, Debug)]
pub enum HookProvider {
    Claude,
    Cursor,
}

#[derive(Args, Debug)]
pub struct SettingsArgs {
    #[command(subcommand)]
    pub action: SettingsAction,
}

#[derive(Subcommand, Debug)]
pub enum SettingsAction {
    Show,
}
