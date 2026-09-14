//! The statusline hook and an offline run, end to end through the binary: the
//! hook stamps each sample with the identity of the synthetic Claude config,
//! writes a part file only when a reading changes, keeps the sidecar and the
//! identity cache beside the inbox, and an offline `run --dry-run` binds the
//! stamped samples to the binding whose cached hash they carry and reports the
//! `allowance` capability. Every path is a scratch directory: `HOME`,
//! `USERPROFILE`, the configuration directory, and the Claude config file
//! (through the override seam, or through a `CLAUDE_CONFIG_DIR` profile).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use observatory_contract::{CollectionSettings, ConfigDocument};
use observatory_core::discovery::identity_hash;
use observatory_core::inbox::{IDENTITY_CACHE, LATEST_STATE, STATUS_SIDECAR, StatuslineSample};
use observatory_core::state::State;
use serde_json::{Value, json};

const ACCOUNT_UUID: &str = "11111111-2222-4333-8444-555555555555";
const PROFILE_UUID: &str = "22222222-3333-4444-8555-666666666666";
const INSTALL_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

fn claude_config_text(uuid: &str) -> String {
    json!({
        "oauthAccount": { "accountUuid": uuid, "emailAddress": "synthetic@example.test" },
        "primaryApiKey": "SECRET-KEY",
        "numStartups": 4
    })
    .to_string()
}

struct Scratch {
    dir: tempfile::TempDir,
    home: PathBuf,
    config: PathBuf,
    claude_config: PathBuf,
    /// A Claude profile (`CLAUDE_CONFIG_DIR`) the hook and the run resolve instead
    /// of the override seam, when set.
    profile: Option<PathBuf>,
    /// The reset anchors Claude Code would report, fixed for the scratch session.
    resets: (i64, i64),
}

impl Scratch {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("home");
        let config = dir.path().join("config");
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&config).unwrap();
        let claude_config = dir.path().join("claude.json");
        fs::write(&claude_config, claude_config_text(ACCOUNT_UUID)).unwrap();
        let now = jiff::Timestamp::now().as_second();
        Scratch {
            dir,
            home,
            config,
            claude_config,
            profile: None,
            resets: (now + 2 * 3600, now + 3 * 86_400),
        }
    }

    /// Switches every later command to a `CLAUDE_CONFIG_DIR` profile holding its
    /// own `.claude.json` for `uuid`, with no override seam. Returns the profile.
    fn use_profile(&mut self, uuid: &str) -> PathBuf {
        let profile = self.dir.path().join("profile");
        fs::create_dir_all(&profile).unwrap();
        fs::write(profile.join(".claude.json"), claude_config_text(uuid)).unwrap();
        self.profile = Some(profile.clone());
        profile
    }

    fn command(&self, args: &[&str]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_observatory"));
        command
            .arg("--config-dir")
            .arg(&self.config)
            .args(args)
            .env_remove("OBSERVATORY_CONFIG_DIR")
            .env("HOME", &self.home)
            .env("USERPROFILE", &self.home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        match &self.profile {
            Some(profile) => {
                command.env("CLAUDE_CONFIG_DIR", profile).env_remove("OBSERVATORY_CLAUDE_CONFIG_FILE")
            }
            None => command
                .env_remove("CLAUDE_CONFIG_DIR")
                .env("OBSERVATORY_CLAUDE_CONFIG_FILE", &self.claude_config),
        };
        command
    }

    /// A Claude settings file whose statusline hook names `config_dir`.
    fn install_hook(&self, settings: &Path, config_dir: &Path) {
        fs::create_dir_all(settings.parent().unwrap()).unwrap();
        fs::write(
            settings,
            json!({ "statusLine": { "type": "command",
                "command": format!("\"observatory\" --config-dir \"{}\" statusline", config_dir.display()) } })
            .to_string(),
        )
        .unwrap();
    }

    /// Runs the hook with a statusline payload; returns the printed line.
    fn statusline(&self, five_hour: f64, seven_day: f64) -> String {
        let payload = json!({
            "version": "2.0.0",
            "entrypoint": "cli",
            "cwd": "/private/synthetic/project",
            "session_id": "PRIVATE-SESSION",
            "rate_limits": {
                "five_hour": { "used_percentage": five_hour, "resets_at": self.resets.0 },
                "seven_day": { "used_percentage": seven_day, "resets_at": self.resets.1 }
            }
        });
        let mut child = self.command(&["statusline"]).spawn().unwrap();
        child.stdin.take().unwrap().write_all(payload.to_string().as_bytes()).unwrap();
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success(), "statusline exits 0: {}", String::from_utf8_lossy(&output.stderr));
        String::from_utf8(output.stdout).unwrap().trim_end().to_owned()
    }

    fn inbox(&self) -> PathBuf {
        self.config.join("inbox").join("claude-statusline")
    }

    fn part_files(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(self.inbox())
            .map(|entries| entries.filter_map(Result::ok).map(|entry| entry.path()).collect())
            .unwrap_or_default();
        files.sort();
        files
    }

    fn read_json(&self, path: &Path) -> Value {
        serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
    }

    /// Pairs the scratch install offline: `companion.json` plus a cached config
    /// document whose Claude binding holds the synthetic account's hash.
    fn pair(&self, identity_hash: &str) {
        self.pair_with(identity_hash, &[]);
    }

    fn pair_with(&self, identity_hash: &str, deny: &[&str]) {
        let key: String = "k".repeat(43);
        let nowhere = self.home.join("nowhere");
        fs::write(
            self.config.join("companion.json"),
            json!({
                "schema_version": 1,
                "url": "https://example.test",
                "install_id": INSTALL_ID,
                "key": key,
                "machine_label": "synthetic",
                "bindings": [{
                    "binding_id": BINDING_ID,
                    "account_id": "claude-primary",
                    "provider": "claude",
                    "roots": [nowhere]
                }],
                "deny": deny
            })
            .to_string(),
        )
        .unwrap();
        let document: ConfigDocument = serde_json::from_value(json!({
            "schema_version": 2,
            "settings_version": 3,
            "install": { "id": INSTALL_ID, "kind": "companion", "machine_label": "synthetic", "paused": false },
            "bindings": [{
                "binding_id": BINDING_ID,
                "account_id": "claude-primary",
                "provider": "claude",
                "enabled": true,
                "identity_hash": identity_hash
            }],
            "settings": CollectionSettings::defaults(),
            "companion": { "latest_version": null }
        }))
        .unwrap();
        let state = State::open(&self.config.join(format!("{INSTALL_ID}.sqlite3"))).unwrap();
        state.seed_cached_config(&document, "2026-09-12T00:00:00.000Z").unwrap();
    }

    /// `run --dry-run --offline`, parsed.
    fn dry_run(&self) -> Value {
        let output = self.command(&["run", "--dry-run", "--offline"]).output().unwrap();
        assert!(output.status.success(), "run exits 0: {}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }

    /// `doctor --offline` against the paired scratch directory, parsed.
    fn doctor(&self) -> Value {
        let output = self.command(&["doctor", "--offline"]).output().unwrap();
        assert!(output.status.success(), "doctor exits 0: {}", String::from_utf8_lossy(&output.stderr));
        serde_json::from_slice(&output.stdout).unwrap()
    }
}

fn adapter<'a>(summary: &'a Value, id: &str) -> &'a Value {
    summary["adapters"].as_array().unwrap().iter().find(|row| row["adapter"] == id).unwrap()
}

/// Every string in a JSON document: keys and leaves.
fn strings(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => out.push(text.clone()),
        Value::Array(items) => items.iter().for_each(|item| strings(item, out)),
        Value::Object(map) => {
            for (key, item) in map {
                out.push(key.clone());
                strings(item, out);
            }
        }
        _ => {}
    }
}

#[test]
fn the_hook_stamps_samples_writes_on_change_and_an_offline_run_binds_them() {
    let scratch = Scratch::new();
    let expected_hash = identity_hash("claude", ACCOUNT_UUID);

    // First invocation: both windows are new, one part file, stamped.
    assert_eq!(scratch.statusline(20.0, 40.0), "Claude · 5h 80% left · Claude · weekly 60% left");
    let files = scratch.part_files();
    assert_eq!(files.len(), 1, "{files:?}");
    let name = files[0].file_name().unwrap().to_str().unwrap();
    assert!(
        name.len() > 18 && &name[10..11] == "T" && &name[13..14] == "-" && name.ends_with(".json"),
        "{name}"
    );
    let samples: Vec<StatuslineSample> = serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert_eq!(samples.iter().map(|s| s.window_key.as_str()).collect::<Vec<_>>(), ["five_hour", "seven_day"]);
    assert!(samples.iter().all(|s| s.identity_hash.as_deref() == Some(expected_hash.as_str())));
    let text = fs::read_to_string(&files[0]).unwrap();
    assert!(!text.contains("PRIVATE") && !text.contains("synthetic/project"), "no session field: {text}");

    // The kept state and the sidecar sit beside the inbox; the identity cache in the config dir.
    let beside = scratch.inbox().parent().unwrap().to_path_buf();
    assert!(beside.join(LATEST_STATE).is_file());
    assert!(!scratch.inbox().join(LATEST_STATE).exists());
    let sidecar = scratch.read_json(&beside.join(STATUS_SIDECAR));
    assert_eq!(sidecar["invocations"], 1);
    assert_eq!(sidecar["offered_windows_ever"], json!(["five_hour", "seven_day"]));
    assert_eq!(sidecar["published_windows"], json!(["five_hour", "seven_day"]));
    assert!(sidecar["last_invocation_at"].is_string());
    assert!(sidecar.get("cwd").is_none() && sidecar.get("session_id").is_none());
    let cache = scratch.read_json(&scratch.config.join(IDENTITY_CACHE));
    let cache_key = scratch.claude_config.to_string_lossy().into_owned();
    assert_eq!(
        cache[&cache_key]["evidence_hash"],
        expected_hash.as_str(),
        "keyed by the config file: {cache}"
    );
    assert!(!fs::read_to_string(scratch.config.join(IDENTITY_CACHE)).unwrap().contains("SECRET"));

    // The same readings again: no new part file; the sidecar still counts the invocation.
    scratch.statusline(20.0, 40.0);
    assert_eq!(scratch.part_files().len(), 1);
    let sidecar = scratch.read_json(&beside.join(STATUS_SIDECAR));
    assert_eq!(sidecar["invocations"], 2);
    assert_eq!(sidecar["published_windows"], json!([]));

    // One window changed: a second part file carrying only that window.
    scratch.statusline(25.0, 40.0);
    let files = scratch.part_files();
    assert_eq!(files.len(), 2);
    let changed: Vec<StatuslineSample> = serde_json::from_slice(&fs::read(&files[1]).unwrap()).unwrap();
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0].window_key, "five_hour");
    assert_eq!(changed[0].used_percent, serde_json::Number::from_f64(25.0).unwrap());

    // Paired offline with the matching hash: the run binds all three samples and reports the meter.
    scratch.pair(expected_hash.as_str());
    let summary = scratch.dry_run();
    assert_eq!(summary["dry_run"], true);
    assert_eq!(summary["config"], "cached");
    let account = adapter(&summary, "claude_account");
    assert_eq!(account["state"], "ok", "{account}");
    assert_eq!(account["records"], 3, "{account}");
    assert_eq!(
        account["capabilities"],
        json!([{ "dimension": "allowance", "state": "complete", "detail_code": null }])
    );
    assert_eq!(
        adapter(&summary, "claude_execution")["detail"],
        "store_missing",
        "no transcripts in the scratch home"
    );
    assert_eq!(summary["records_pending"], 3);
    let state = State::open_read_only(&scratch.config.join(format!("{INSTALL_ID}.sqlite3"))).unwrap();
    assert!(state.quarantined_samples().unwrap().is_empty());
    assert_eq!(state.dirty_allowance_slots(BINDING_ID).unwrap().len(), 0, "emitted slots are clean");
    assert_eq!(scratch.part_files().len(), 2, "fresh part files survive the run's prune");

    // A hook installed for another configuration directory is reported beside the samples.
    scratch
        .install_hook(&scratch.home.join(".claude").join("settings.json"), &scratch.home.join("elsewhere"));
    scratch.statusline(30.0, 40.0);
    let summary = scratch.dry_run();
    let account = adapter(&summary, "claude_account");
    assert_eq!(account["records"], 1);
    assert_eq!(account["capabilities"][0]["detail_code"], "hook_config_dir_mismatch");
}

#[test]
fn samples_stamped_by_another_account_wait_in_quarantine() {
    let scratch = Scratch::new();
    scratch.statusline(20.0, 40.0);
    // The binding holds a different account's hash: nothing binds, nothing is emitted.
    scratch.pair(&"f".repeat(64));
    let summary = scratch.dry_run();
    let account = adapter(&summary, "claude_account");
    assert_eq!(account["state"], "ok");
    assert_eq!(account["records"], 0, "{account}");
    assert_eq!(account["capabilities"][0]["state"], "partial");
    assert_eq!(account["capabilities"][0]["detail_code"], "unpaired_identity");
    assert_eq!(summary["records_pending"], 0);
    let state = State::open_read_only(&scratch.config.join(format!("{INSTALL_ID}.sqlite3"))).unwrap();
    assert_eq!(state.quarantined_samples().unwrap().len(), 2);
}

#[test]
fn the_run_prunes_old_part_files_even_when_the_reader_is_denied() {
    let scratch = Scratch::new();
    scratch.statusline(20.0, 40.0);
    let fresh = scratch.part_files();
    assert_eq!(fresh.len(), 1);
    // A part file and a v1 hour file from long ago, plus a hand-named file that is never pruned.
    for name in ["2026-01-01T00-1767225600000000.json", "2026-01-02T03.json", "broken.json"] {
        fs::write(scratch.inbox().join(name), b"[]").unwrap();
    }
    scratch.pair_with(identity_hash("claude", ACCOUNT_UUID).as_str(), &["allowance.claude_reader"]);
    let summary = scratch.dry_run();
    let account = adapter(&summary, "claude_account");
    assert_eq!(account["state"], "denied_locally", "{account}");
    assert_eq!(account["records"], 0);
    let names: Vec<String> = scratch
        .part_files()
        .iter()
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.contains(&"broken.json".to_owned()));
    assert!(names.contains(&fresh[0].file_name().unwrap().to_string_lossy().into_owned()));
}

/// A `CLAUDE_CONFIG_DIR` profile: the hook stamps the profile's own account
/// (no override seam), caches it under the profile's config file, and the run
/// reads the hook from the profile's `settings.json`, not the home one.
#[test]
fn a_claude_profile_stamps_its_own_identity_and_its_settings_file_names_the_hook() {
    let mut scratch = Scratch::new();
    let profile = scratch.use_profile(PROFILE_UUID);
    let profile_hash = identity_hash("claude", PROFILE_UUID);
    assert_ne!(profile_hash.as_str(), identity_hash("claude", ACCOUNT_UUID).as_str());

    assert_eq!(scratch.statusline(20.0, 40.0), "Claude · 5h 80% left · Claude · weekly 60% left");
    let files = scratch.part_files();
    assert_eq!(files.len(), 1, "{files:?}");
    let samples: Vec<StatuslineSample> = serde_json::from_slice(&fs::read(&files[0]).unwrap()).unwrap();
    assert_eq!(samples.len(), 2);
    assert!(
        samples.iter().all(|s| s.identity_hash.as_deref() == Some(profile_hash.as_str())),
        "stamped with the profile's account: {samples:?}"
    );
    let cache = scratch.read_json(&scratch.config.join(IDENTITY_CACHE));
    let cache_key = profile.join(".claude.json").to_string_lossy().into_owned();
    assert_eq!(cache[&cache_key]["evidence_hash"], profile_hash.as_str(), "{cache}");
    assert!(!fs::read_to_string(scratch.config.join(IDENTITY_CACHE)).unwrap().contains("SECRET"));

    // The home settings file names this directory, the profile's names another: the run
    // under the same variable reads the profile's file and reports the mismatch.
    scratch.install_hook(&scratch.home.join(".claude").join("settings.json"), &scratch.config);
    scratch.install_hook(&profile.join("settings.json"), &scratch.home.join("elsewhere"));
    scratch.pair(profile_hash.as_str());
    let summary = scratch.dry_run();
    let account = adapter(&summary, "claude_account");
    assert_eq!(account["records"], 2, "{account}");
    assert_eq!(account["capabilities"][0]["detail_code"], "hook_config_dir_mismatch", "{account}");

    // The profile's hook naming the run's configuration directory: installed.
    scratch.install_hook(&profile.join("settings.json"), &scratch.config);
    let summary = scratch.dry_run();
    let account = adapter(&summary, "claude_account");
    assert_eq!(
        account["capabilities"],
        json!([{ "dimension": "allowance", "state": "complete", "detail_code": null }]),
        "{account}"
    );
    let doctor = scratch.doctor();
    assert_eq!(doctor["claude_statusline"]["hook"], "installed", "{}", doctor["claude_statusline"]);
    assert_eq!(doctor["claude_statusline"]["hook_config_dir"], scratch.config.to_string_lossy().as_ref());
    assert_eq!(doctor["bindings"][0]["identity"], "confirmed", "the profile's account is the paired one");
}

/// `doctor --offline` against the paired scratch directory: the hook, the
/// sidecar, and the quarantine, as codes and counts; the configuration
/// directory is the only scratch path it prints.
#[test]
fn doctor_reports_the_statusline_hook_and_the_quarantine_without_sample_paths() {
    let scratch = Scratch::new();
    scratch.statusline(20.0, 40.0);
    // Paired with another account's hash: both samples wait in quarantine.
    scratch.pair(&"f".repeat(64));
    scratch.dry_run();
    scratch.install_hook(&scratch.home.join(".claude").join("settings.json"), &scratch.config);

    let doctor = scratch.doctor();
    assert_eq!(doctor["ok"], true);
    assert_eq!(doctor["config"], "cached", "the cached document, no fetch: {}", doctor["config_error"]);
    assert!(doctor["config_error"].is_null());
    let report = &doctor["claude_statusline"];
    assert_eq!(report["hook"], "installed", "{report}");
    assert_eq!(report["hook_config_dir"], scratch.config.to_string_lossy().as_ref());
    assert_eq!(report["sidecar_present"], true);
    assert!(report["last_invocation_at"].is_string());
    assert_eq!(report["invocations"], 1);
    assert_eq!(report["offered_windows_ever"], json!(["five_hour", "seven_day"]));
    assert!(report["last_published_at"].is_string());
    assert_eq!(report["quarantined"], json!({ "unpaired_identity": 2 }));
    assert_eq!(report.as_object().unwrap().len(), 8, "the documented keys only: {report}");

    // No part file, inbox, sample, or transcript root appears; the scratch tree shows up only
    // as the configuration directory itself.
    let mut printed = Vec::new();
    strings(&doctor, &mut printed);
    let config_dir = scratch.config.to_string_lossy().into_owned();
    let scratch_root = scratch.dir.path().to_string_lossy().into_owned();
    let part_names: Vec<String> =
        scratch.part_files().iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert!(!part_names.is_empty());
    for text in &printed {
        assert!(!part_names.iter().any(|name| text.contains(name)), "part file printed: {text}");
        assert!(!text.contains("inbox") && !text.contains("nowhere"), "a path beyond the config dir: {text}");
        assert!(!text.contains(".json") && !text.contains("SECRET"), "{text}");
        if text.contains(&scratch_root) {
            assert_eq!(text, &config_dir, "the only scratch path is the configuration directory");
        }
    }

    // Without the hook the report says so and still names no other directory.
    fs::remove_file(scratch.home.join(".claude").join("settings.json")).unwrap();
    let report = scratch.doctor()["claude_statusline"].clone();
    assert_eq!(report["hook"], "not_installed");
    assert!(report["hook_config_dir"].is_null());
}
