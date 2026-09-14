//! Knowledge-source (vault) configuration as one run sees it: normalized local
//! roots, connector identifiers, the per-resource configuration version, and
//! the local deny switch. Paths in here never leave the machine; the adapters
//! classify tool arguments against these roots and keep only keys and kinds.

use serde_json::json;

use crate::config::LocalResource;
use crate::pyjson::digest;

/// The deny-list entry that keeps every resource-access row on this machine.
pub const RESOURCE_ATTRIBUTION_DENY: &str = "execution.resource_attribution";

/// One configured resource with roots already normalized and aliased.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceContext {
    pub key: String,
    /// Normalized roots (see `normalize_path`) plus MSYS/WSL aliases for drive roots.
    pub roots: Vec<String>,
    /// `mcp:<namespace>` and `url:<prefix>` connector identifiers.
    pub connectors: Vec<String>,
}

/// Every resource this run classifies against.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ResourceConfiguration {
    pub resources: Vec<ResourceContext>,
    /// The home directory `~/` resolves against, normalized; pinned by tests.
    pub home: Option<String>,
    /// Digest of the whole configuration for the scan generation; `None` when empty.
    pub scan_digest: Option<String>,
}

impl ResourceConfiguration {
    pub fn is_empty(&self) -> bool {
        self.resources.is_empty()
    }

    pub fn resource(&self, key: &str) -> Option<&ResourceContext> {
        self.resources.iter().find(|resource| resource.key == key)
    }

    /// Builds the run-time view from `companion.json` entries. Invalid entries
    /// are skipped by the caller; this only normalizes. Roots that cannot be
    /// normalized (relative without a home, variables) are dropped silently.
    pub fn from_local(resources: &[LocalResource], home: Option<&str>) -> Self {
        let home = home.and_then(|home| normalize_path(home, None, None));
        let contexts: Vec<ResourceContext> = resources
            .iter()
            .map(|resource| {
                let mut roots: Vec<String> = resource
                    .roots
                    .iter()
                    .filter_map(|root| normalize_path(&root.to_string_lossy(), None, home.as_deref()))
                    .flat_map(|root| {
                        let mut all = root_aliases(&root);
                        all.push(root);
                        all
                    })
                    .collect();
                roots.sort();
                roots.dedup();
                let mut connectors = resource.connectors.clone();
                connectors.sort();
                connectors.dedup();
                ResourceContext { key: resource.key.clone(), roots, connectors }
            })
            .collect();
        let scan_digest = (!contexts.is_empty()).then(|| {
            let mut entries: Vec<_> = contexts
                .iter()
                .map(|context| json!([context.key, context.roots, context.connectors]))
                .collect();
            entries.sort_by_key(|entry| entry.to_string());
            // The normalized roots already carry the home a `~/` root resolved against, so the
            // digest must not depend on the environment's home when no root needs it.
            digest(&json!(["resource-config", entries])).as_str().to_owned()
        });
        Self { resources: contexts, home, scan_digest }
    }

    /// The per-resource configuration digest: this resource's own key, roots and
    /// connectors plus the keys of other resources sharing any connector, so an
    /// unrelated vault being added never re-versions this one.
    pub fn resource_version(&self, key: &str) -> Option<String> {
        let resource = self.resource(key)?;
        let mut sharing: Vec<&str> = self
            .resources
            .iter()
            .filter(|other| other.key != resource.key)
            .filter(|other| other.connectors.iter().any(|connector| resource.connectors.contains(connector)))
            .map(|other| other.key.as_str())
            .collect();
        sharing.sort_unstable();
        sharing.dedup();
        Some(
            digest(&json!(["resource-version", resource.key, resource.roots, resource.connectors, sharing]))
                .as_str()
                .to_owned(),
        )
    }
}

/// True when the local deny list keeps resource evidence on this machine: the
/// exact entry or any dotted prefix of it, like the other mode-path denies.
pub fn resource_attribution_denied(deny: &[String]) -> bool {
    deny.iter().any(|entry| {
        RESOURCE_ATTRIBUTION_DENY == entry
            || RESOURCE_ATTRIBUTION_DENY
                .strip_prefix(entry.as_str())
                .is_some_and(|rest| rest.starts_with('.'))
    })
}

/// How a normalized path compares: Windows forms (drive letter, UNC, and the
/// MSYS `/c/…` and WSL `/mnt/c/…` aliases) are lowercased; POSIX paths keep
/// their case. Decided by the path text alone so every platform agrees.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Form {
    Posix,
    Windows,
}

/// Normalizes one path argument for root matching: quotes stripped, `\`
/// folded to `/`, `.`/`..` resolved lexically, no trailing separator, and
/// lowercased for Windows forms. Relative paths resolve against `base` (itself
/// normalized) and `~/` against `home`; anything else unresolvable — a URL, a
/// variable, `~user`, a relative path without a base — is `None`. Nothing here
/// touches the file system, so symlinks and junctions are out of scope.
pub fn normalize_path(raw: &str, base: Option<&str>, home: Option<&str>) -> Option<String> {
    let value = strip_quotes(raw.trim());
    if value.is_empty() || value.contains('\0') || looks_like_url(value) || has_variable(value) {
        return None;
    }
    let value = value.replace('\\', "/");
    if let Some(rest) = value.strip_prefix('~') {
        return if rest.is_empty() || rest.starts_with('/') {
            let home = normalize_path(home?, None, None)?;
            resolve_relative(&home, rest.trim_start_matches('/'))
        } else {
            None
        };
    }
    match absolute_form(&value) {
        Some(form) => Some(canonical(&value, form)),
        None => resolve_relative(&normalize_path(base?, None, home)?, &value),
    }
}

/// Component-prefix match: `path` is the root itself or lies beneath it. Never
/// a substring match, so `/vault2/x` does not belong to `/vault`.
pub fn matches(path: &str, root: &str) -> bool {
    if path == root {
        return true;
    }
    if root.ends_with('/') { path.starts_with(root) } else { path.starts_with(&format!("{root}/")) }
}

/// MSYS/Git Bash and WSL spellings of a normalized drive root, so a `/c/vault`
/// argument written from Git Bash matches the `C:\vault` root.
fn root_aliases(root: &str) -> Vec<String> {
    match drive_letter(root) {
        Some(drive) => {
            let rest = &root[2..];
            vec![format!("/{drive}{rest}"), format!("/mnt/{drive}{rest}")]
        }
        None => Vec::new(),
    }
}

fn strip_quotes(value: &str) -> &str {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

/// `scheme://…` or a multi-letter `scheme:` prefix (a single letter is a drive).
fn looks_like_url(value: &str) -> bool {
    if value.contains("://") {
        return true;
    }
    let scheme: String =
        value.chars().take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '.' | '-')).collect();
    scheme.len() >= 2
        && value[scheme.len()..].starts_with(':')
        && scheme.chars().next().is_some_and(|c| c.is_ascii_alphabetic())
}

/// Shell or PowerShell variable references never resolve lexically.
fn has_variable(value: &str) -> bool {
    if value.contains('$') {
        return true;
    }
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        let after = &rest[start + 1..];
        let name_len = after.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_').count();
        if name_len > 0 && after[name_len..].starts_with('%') {
            return true;
        }
        rest = after;
    }
    false
}

fn drive_letter(value: &str) -> Option<char> {
    let mut chars = value.chars();
    let letter = chars.next().filter(char::is_ascii_alphabetic)?;
    (chars.next() == Some(':') && matches!(chars.next(), None | Some('/')))
        .then(|| letter.to_ascii_lowercase())
}

/// The form of an absolute path written with `/` separators, or `None` when relative.
fn absolute_form(value: &str) -> Option<Form> {
    if drive_letter(value).is_some() || value.starts_with("//") {
        return Some(Form::Windows);
    }
    if !value.starts_with('/') {
        return None;
    }
    let alias = value.strip_prefix("/mnt/").unwrap_or(&value[1..]);
    let mut chars = alias.chars();
    let is_alias =
        chars.next().is_some_and(|c| c.is_ascii_alphabetic()) && matches!(chars.next(), None | Some('/'));
    Some(if is_alias { Form::Windows } else { Form::Posix })
}

fn resolve_relative(base: &str, relative: &str) -> Option<String> {
    let form = absolute_form(base)?;
    Some(canonical(&format!("{base}/{relative}"), form))
}

/// Lexical cleanup of an absolute path with `/` separators.
fn canonical(value: &str, form: Form) -> String {
    let (prefix, rest) = if let Some(drive) = drive_letter(value) {
        (format!("{drive}:"), &value[2..])
    } else if value.starts_with("//") {
        ("/".to_owned(), &value[1..])
    } else {
        (String::new(), value)
    };
    let mut components: Vec<&str> = Vec::new();
    for component in rest.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop();
            }
            other => components.push(other),
        }
    }
    let joined = if components.is_empty() {
        if prefix.is_empty() { "/".to_owned() } else { prefix }
    } else {
        format!("{prefix}/{}", components.join("/"))
    };
    match form {
        Form::Windows => joined.to_lowercase(),
        Form::Posix => joined,
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    fn resource(key: &str, roots: &[&str], connectors: &[&str]) -> LocalResource {
        LocalResource {
            key: key.into(),
            label: None,
            roots: roots.iter().map(PathBuf::from).collect(),
            connectors: connectors.iter().map(|value| (*value).to_owned()).collect(),
            source: None,
        }
    }

    #[test]
    fn deny_uses_mode_path_prefixes() {
        assert!(!resource_attribution_denied(&[]));
        assert!(resource_attribution_denied(&["execution.resource_attribution".to_owned()]));
        assert!(resource_attribution_denied(&["execution".to_owned()]));
        assert!(!resource_attribution_denied(&["execution.project_attribution".to_owned()]));
        assert!(!resource_attribution_denied(&["exec".to_owned()]));
    }

    #[test]
    fn posix_paths_resolve_lexically_and_keep_case() {
        assert_eq!(normalize_path("/Vault/Notes/../a.md", None, None).as_deref(), Some("/Vault/a.md"));
        assert_eq!(normalize_path("/vault//notes/./b.md/", None, None).as_deref(), Some("/vault/notes/b.md"));
        assert_eq!(normalize_path("/", None, None).as_deref(), Some("/"));
        assert_eq!(normalize_path("/../x", None, None).as_deref(), Some("/x"));
        assert_eq!(normalize_path("\"/vault/quoted.md\"", None, None).as_deref(), Some("/vault/quoted.md"));
        assert_eq!(normalize_path("'/vault/single.md'", None, None).as_deref(), Some("/vault/single.md"));
    }

    #[test]
    fn relative_paths_need_an_absolute_base() {
        assert_eq!(normalize_path("notes/a.md", Some("/vault"), None).as_deref(), Some("/vault/notes/a.md"));
        assert_eq!(normalize_path("./a.md", Some("/vault/"), None).as_deref(), Some("/vault/a.md"));
        assert_eq!(normalize_path("../b.md", Some("/vault/notes"), None).as_deref(), Some("/vault/b.md"));
        assert_eq!(normalize_path("a.md", None, None), None);
        assert_eq!(normalize_path("a.md", Some("relative"), None), None);
        assert_eq!(
            normalize_path("a.md", Some("~/vault"), Some("/home/u")).as_deref(),
            Some("/home/u/vault/a.md")
        );
        assert_eq!(normalize_path("", Some("/vault"), None), None);
        assert_eq!(normalize_path("   ", Some("/vault"), None), None);
    }

    #[test]
    fn windows_forms_fold_separators_and_case() {
        assert_eq!(normalize_path("C:\\Vault\\Note.MD", None, None).as_deref(), Some("c:/vault/note.md"));
        assert_eq!(
            normalize_path("c:/Vault/sub/../Note.md", None, None).as_deref(),
            Some("c:/vault/note.md")
        );
        assert_eq!(normalize_path("C:\\", None, None).as_deref(), Some("c:"));
        assert_eq!(normalize_path("C:", None, None).as_deref(), Some("c:"));
        assert_eq!(
            normalize_path("\\\\Server\\Share\\Dir\\x.md", None, None).as_deref(),
            Some("//server/share/dir/x.md")
        );
        assert_eq!(
            normalize_path("..\\Vault\\Note.md", Some("C:\\Work\\proj"), None).as_deref(),
            Some("c:/work/vault/note.md")
        );
        assert_eq!(normalize_path("Note.md", Some("C:\\Vault"), None).as_deref(), Some("c:/vault/note.md"));
        // Drive-relative paths are not absolute and have no base.
        assert_eq!(normalize_path("C:Note.md", None, None), None);
    }

    #[test]
    fn msys_and_wsl_aliases_are_windows_forms() {
        assert_eq!(normalize_path("/c/Vault/Note.md", None, None).as_deref(), Some("/c/vault/note.md"));
        assert_eq!(
            normalize_path("/mnt/C/Vault/Note.md", None, None).as_deref(),
            Some("/mnt/c/vault/note.md")
        );
        assert_eq!(normalize_path("/mnt/Data/Note.md", None, None).as_deref(), Some("/mnt/Data/Note.md"));
        assert_eq!(normalize_path("/cache/Note.md", None, None).as_deref(), Some("/cache/Note.md"));
        assert_eq!(normalize_path("Note.md", Some("/c/Vault"), None).as_deref(), Some("/c/vault/note.md"));
    }

    #[test]
    fn home_resolves_tilde_only_for_the_current_user() {
        let home = Some("/home/u");
        assert_eq!(normalize_path("~/vault/a.md", None, home).as_deref(), Some("/home/u/vault/a.md"));
        assert_eq!(
            normalize_path("~\\vault\\a.md", None, Some("C:\\Users\\U")).as_deref(),
            Some("c:/users/u/vault/a.md")
        );
        assert_eq!(normalize_path("~", None, home).as_deref(), Some("/home/u"));
        assert_eq!(normalize_path("~other/vault/a.md", None, home), None);
        assert_eq!(normalize_path("~/vault/a.md", None, None), None);
        assert_eq!(normalize_path("~/vault/a.md", Some("/base"), None), None);
    }

    #[test]
    fn urls_variables_and_nul_are_unresolvable() {
        assert_eq!(normalize_path("https://example.test/a.md", None, None), None);
        assert_eq!(normalize_path("file:///vault/a.md", None, None), None);
        assert_eq!(normalize_path("obsidian://open?vault=x", None, None), None);
        assert_eq!(normalize_path("$HOME/vault/a.md", None, None), None);
        assert_eq!(normalize_path("${VAULT}/a.md", None, None), None);
        assert_eq!(normalize_path("%USERPROFILE%\\vault\\a.md", None, None), None);
        assert_eq!(normalize_path("$env:USERPROFILE\\a.md", None, None), None);
        assert_eq!(normalize_path("/vault/100%.md", None, None).as_deref(), Some("/vault/100%.md"));
        assert_eq!(normalize_path("/vault/a\0.md", None, None), None);
    }

    #[test]
    fn matching_is_by_component_prefix() {
        assert!(matches("/vault", "/vault"));
        assert!(matches("/vault/notes/a.md", "/vault"));
        assert!(!matches("/vault2/a.md", "/vault"));
        assert!(!matches("/vaul", "/vault"));
        assert!(!matches("/Vault/a.md", "/vault"));
        assert!(matches("c:/vault/a.md", "c:"));
        assert!(matches("/anything", "/"));
        assert!(matches("/", "/"));
    }

    #[test]
    fn contexts_normalize_roots_alias_drives_and_version_per_resource() {
        let alpha = resource(
            "alpha-src",
            &["C:\\Vaults\\Alpha\\", "~/alpha"],
            &["mcp:vault", "url:https://alpha.test/"],
        );
        let beta = resource("beta-src", &["/srv/Beta"], &["mcp:vault"]);
        let gamma = resource("gamma-src", &["relative/root"], &[]);
        let configuration =
            ResourceConfiguration::from_local(&[alpha.clone(), beta.clone(), gamma.clone()], Some("/home/U"));
        assert_eq!(configuration.home.as_deref(), Some("/home/U"));
        let alpha_context = configuration.resource("alpha-src").unwrap();
        assert_eq!(
            alpha_context.roots,
            vec!["/c/vaults/alpha", "/home/U/alpha", "/mnt/c/vaults/alpha", "c:/vaults/alpha"]
        );
        assert_eq!(alpha_context.connectors, vec!["mcp:vault", "url:https://alpha.test/"]);
        assert_eq!(configuration.resource("beta-src").unwrap().roots, vec!["/srv/Beta"]);
        assert!(configuration.resource("gamma-src").unwrap().roots.is_empty());
        assert!(!configuration.is_empty());
        assert!(configuration.scan_digest.as_ref().is_some_and(|digest| digest.len() == 64));

        // Per-resource versions depend only on the resource and connector-sharing keys.
        let alpha_version = configuration.resource_version("alpha-src").unwrap();
        let beta_version = configuration.resource_version("beta-src").unwrap();
        let gamma_version = configuration.resource_version("gamma-src").unwrap();
        assert_ne!(alpha_version, beta_version);
        assert_eq!(configuration.resource_version("missing"), None);

        // Adding an unrelated resource re-versions nothing else; the scan digest moves.
        let delta = resource("delta-src", &["/srv/delta"], &[]);
        let grown = ResourceConfiguration::from_local(
            &[alpha.clone(), beta.clone(), gamma.clone(), delta],
            Some("/home/U"),
        );
        assert_eq!(grown.resource_version("alpha-src").unwrap(), alpha_version);
        assert_eq!(grown.resource_version("gamma-src").unwrap(), gamma_version);
        assert_ne!(grown.scan_digest, configuration.scan_digest);

        // A new resource sharing alpha's connector re-versions alpha (and beta) but not gamma.
        let sharer = resource("epsilon-src", &[], &["mcp:vault"]);
        let shared = ResourceConfiguration::from_local(
            &[alpha.clone(), beta.clone(), gamma.clone(), sharer],
            Some("/home/U"),
        );
        assert_ne!(shared.resource_version("alpha-src").unwrap(), alpha_version);
        assert_ne!(shared.resource_version("beta-src").unwrap(), beta_version);
        assert_eq!(shared.resource_version("gamma-src").unwrap(), gamma_version);

        // Changing a root re-versions only that resource.
        let moved = resource("beta-src", &["/srv/beta-moved"], &["mcp:vault"]);
        let changed =
            ResourceConfiguration::from_local(&[alpha.clone(), moved, gamma.clone()], Some("/home/U"));
        assert_eq!(changed.resource_version("alpha-src").unwrap(), alpha_version);
        assert_ne!(changed.resource_version("beta-src").unwrap(), beta_version);

        // Entry order, root spelling, and duplicate connectors do not change the scan digest.
        let respelled = resource(
            "alpha-src",
            &["~/alpha", "c:/vaults/alpha"],
            &["url:https://alpha.test/", "mcp:vault", "mcp:vault"],
        );
        let reordered = ResourceConfiguration::from_local(&[beta, respelled, gamma], Some("/home/U"));
        assert_eq!(reordered.scan_digest, configuration.scan_digest);

        // The environment's home only matters through a `~/` root: an interactive run and a
        // scheduled run with different (or no) home values must not alternate generations.
        let absolute = resource("gamma-src", &["/srv/gamma"], &[]);
        let interactive = ResourceConfiguration::from_local(std::slice::from_ref(&absolute), Some("/home/U"));
        let scheduled = ResourceConfiguration::from_local(std::slice::from_ref(&absolute), None);
        assert_eq!(interactive.scan_digest, scheduled.scan_digest);
        assert_eq!(interactive.resource_version("gamma-src"), scheduled.resource_version("gamma-src"));
        let home_bound = resource("home-src", &["~/notes"], &[]);
        assert_ne!(
            ResourceConfiguration::from_local(std::slice::from_ref(&home_bound), Some("/home/U")).scan_digest,
            ResourceConfiguration::from_local(std::slice::from_ref(&home_bound), Some("/home/V")).scan_digest
        );

        let empty = ResourceConfiguration::from_local(&[], Some("/home/U"));
        assert!(empty.is_empty());
        assert_eq!(empty.scan_digest, None);
        assert_eq!(
            ResourceConfiguration::default(),
            ResourceConfiguration { resources: vec![], home: None, scan_digest: None }
        );
    }
}
