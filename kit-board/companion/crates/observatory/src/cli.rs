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
    /// Working directories this install has seen and their project hashes (local only);
    /// `--apps` prints the app-project resolution as counts instead.
    Projects(ProjectsArgs),
    /// Checks a dry-run copy of the state before an upgrade: fails when the new build would
    /// revise or duplicate ledger history beyond what the release allows.
    UpgradeGate(UpgradeGateArgs),
    /// Named knowledge sources (vaults) this install classifies tool calls against, with
    /// their local roots (local only); `add` and `remove` edit companion.json.
    Resources(ResourcesArgs),
    /// Effective mode and reason per adapter; prerequisite and credential checks.
    Doctor(DoctorArgs),
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
pub struct ProjectsArgs {
    /// Print how app projects, folders, and sessions resolve, as counts; no paths.
    #[arg(long)]
    pub apps: bool,
    /// With --apps: also print the titles of a few threads placed only by a root prefix.
    #[arg(long, requires = "apps")]
    pub samples: bool,
}

#[derive(Args, Debug)]
pub struct UpgradeGateArgs {
    /// The dry-run state copy to check (after `run --dry-run --offline` on it).
    #[arg(long, value_name = "FILE")]
    pub state: PathBuf,
    /// The last real run's `finished_at`. Without --baseline, activity before it is
    /// history (strict: activity that run had not read yet also counts); with
    /// --baseline it is reported only.
    #[arg(long, value_name = "RFC3339")]
    pub cutoff: String,
    /// A copy taken before the dry run, holding what the previous build produced and
    /// the server received. History is then what that build had read, not a time;
    /// it also enables the request-membership check and the per-field breakdown.
    #[arg(long, value_name = "FILE")]
    pub baseline: Option<PathBuf>,
}

#[derive(Args, Debug)]
pub struct DoctorArgs {
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
pub struct ResourcesArgs {
    /// Without a subcommand, lists the configured sources.
    #[command(subcommand)]
    pub action: Option<ResourcesAction>,
}

#[derive(Subcommand, Debug)]
pub enum ResourcesAction {
    /// Add a knowledge source, or replace the one with the same key.
    Add(ResourceAddArgs),
    /// Remove a knowledge source by key.
    Remove(ResourceRemoveArgs),
}

#[derive(Args, Debug)]
pub struct ResourceAddArgs {
    /// The privacy-safe key the Observatory labels: ^[a-z0-9_.:-]{1,64}$, e.g. obsidian.notes.
    #[arg(long)]
    pub key: String,
    /// An absolute directory whose files count as this source (repeatable).
    #[arg(long = "root", value_name = "DIR")]
    pub root: Vec<PathBuf>,
    /// A connector id, mcp:<namespace> or url:<prefix>, matched instead of a path (repeatable).
    #[arg(long = "connector", value_name = "ID")]
    pub connector: Vec<String>,
    /// A display label kept on this machine; the Observatory keeps its own labels.
    #[arg(long)]
    pub label: Option<String>,
    /// Where the definition came from, e.g. obsidian:<vault id>; informational.
    #[arg(long)]
    pub source: Option<String>,
}

#[derive(Args, Debug)]
pub struct ResourceRemoveArgs {
    /// The key of the source to remove.
    #[arg(long)]
    pub key: String,
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
