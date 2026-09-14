//! Knowledge-source (vault) access evidence: which configured resource a tool
//! invocation touched, decided from the arguments while they are in memory.
//! Arguments, commands, scripts, and file names are inspected here and dropped;
//! only resource keys, access kinds, evidence bases, and coverage classes leave.
//!
//! Evidence comes in three shapes. Explicit arguments (`Read.file_path`, patch
//! headers, `view_image.path`) name a path directly. Shell text (`Bash`,
//! `PowerShell`, Codex `shell_command`/`exec_command`/`local_shell_call`, and
//! `tools.*` calls inside Codex `exec` scripts) is tokenized conservatively:
//! a token is a candidate only when it is absolute, `./`-relative, or a bare
//! file name given to a recognized file command on a single line. Connector
//! calls (MCP namespaces, fetched URLs) match configured connector ids.
//! Being inside a vault is context: a working directory only resolves relative
//! candidates and never counts as access by itself.

use std::collections::{BTreeMap, HashMap};
use std::str::FromStr;

use observatory_contract::{
    AccessEvidenceBasis, AccessKind, Adapter, Basis, Channel, Code, EventOutcome, Nullable, Record,
    ResourceAccess, Sha256Hex, Stamp, Text, Uuid,
};
use observatory_core::adapter::{BindingContext, RunContext, Sink, record_id};
use observatory_core::pyjson::digest;
use observatory_core::resources::{
    ResourceConfiguration, matches, normalize_path, resource_attribution_denied,
};
use observatory_core::state::{ResourceAccessRow, ResourceInspectionCounts, State, StateError, ToolEventRow};
use serde_json::{Value, json};

pub const READ: &str = "read";
pub const SEARCH: &str = "search";
pub const WRITE: &str = "write";
pub const UNKNOWN: &str = "unknown";

pub const EXPLICIT_ARGUMENT: &str = "explicit_argument";
pub const CONNECTOR: &str = "connector";
pub const INDIRECT_SHELL: &str = "indirect_shell";

/// How many nested `-c` shells are followed before giving up.
const MAX_SHELL_DEPTH: usize = 3;

/// One raw path argument with the base it resolves against; normalized only in
/// `classify`, so nothing here is retained.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    pub path: String,
    pub base: Option<String>,
    pub access_kind: &'static str,
    pub evidence_basis: &'static str,
}

/// What one invocation's arguments say about resource access.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Evidence {
    Paths(Vec<Candidate>),
    Connector {
        id: String,
        access_kind: &'static str,
    },
    /// No path or connector evidence; a working directory alone is not evidence.
    None,
    /// A form the classifier cannot read: an opaque script, a non-object input,
    /// unparseable arguments.
    Unsupported,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResourceMatch {
    pub resource_key: String,
    pub access_kind: &'static str,
    pub evidence_basis: &'static str,
    /// The candidate also matched another resource or a nested root.
    pub nested_overlap: bool,
}

/// One inspected invocation: its matches (at most one per resource) and the
/// inspection class `matched | unmatched | no_evidence | unresolved | unsupported | ambiguous`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Classification {
    pub matches: Vec<ResourceMatch>,
    pub class: &'static str,
    /// Some candidate matched more than one resource or nested roots.
    pub overlapping: bool,
}

impl Classification {
    fn empty(class: &'static str) -> Self {
        Self { matches: Vec::new(), class, overlapping: false }
    }
}

/// The local row id for one (invocation, resource) pair; also the wire semantic key.
pub fn access_id(invocation_key: &str, resource_key: &str) -> String {
    digest(&json!(["resource-access", invocation_key, resource_key])).as_str().to_owned()
}

/// Access kind from a connector tool's bare name, by case-insensitive substring.
pub fn connector_kind(tool_name: Option<&str>) -> &'static str {
    let Some(name) = tool_name.map(str::to_lowercase) else { return UNKNOWN };
    let has = |words: &[&str]| words.iter().any(|word| name.contains(word));
    if has(&["write", "create", "update", "append", "delete", "patch", "put", "move", "rename", "remove"]) {
        WRITE
    } else if has(&["search", "find", "query", "list", "grep"]) {
        SEARCH
    } else if has(&["read", "get", "open", "fetch", "show", "view", "cat"]) {
        READ
    } else {
        UNKNOWN
    }
}

// --- Claude Code ---

/// Tools whose input is a program the classifier cannot follow.
fn opaque_script_tool(name: &str) -> bool {
    matches!(name, "Workflow" | "js" | "javascript" | "python" | "eval" | "execute_code" | "run_code")
}

/// An MCP call is opaque when the server is a REPL (`<anything>_repl`) or the
/// bare tool is a code runner under any server, such as `mcp__cua_repl__js`.
fn opaque_mcp(namespace: &str, tool: &str) -> bool {
    matches!(namespace, "node_repl" | "js_repl" | "python_repl")
        || namespace.ends_with("_repl")
        || namespace == "repl"
        || opaque_script_tool(tool)
}

/// Evidence from one Claude `tool_use` block, dispatched by raw tool name.
pub fn claude_evidence(tool_name: &str, input: &Value, cwd: Option<&str>) -> Evidence {
    let name = tool_name.trim();
    if let Some(rest) = name.strip_prefix("mcp__") {
        let (namespace, tool) = rest.split_once("__").unwrap_or((rest, ""));
        if namespace.is_empty() {
            return Evidence::None;
        }
        if opaque_mcp(namespace, tool) {
            return Evidence::Unsupported;
        }
        return Evidence::Connector {
            id: format!("mcp:{namespace}"),
            access_kind: connector_kind((!tool.is_empty()).then_some(tool)),
        };
    }
    if opaque_script_tool(name) {
        return Evidence::Unsupported;
    }
    let Some(object) = input.as_object() else { return Evidence::Unsupported };
    let field =
        |key: &str| object.get(key).and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    match name {
        "Read" => explicit(field("file_path"), READ, cwd),
        "NotebookRead" => explicit(field("notebook_path"), READ, cwd),
        "Write" | "Edit" | "MultiEdit" => explicit(field("file_path"), WRITE, cwd),
        "NotebookEdit" => explicit(field("notebook_path"), WRITE, cwd),
        "Glob" => {
            let mut candidates = Vec::new();
            if let Some(path) = field("path") {
                candidates.push(explicit_candidate(path, SEARCH, cwd));
            }
            if let Some(prefix) = field("pattern").and_then(glob_prefix) {
                candidates.push(explicit_candidate(&prefix, SEARCH, cwd));
            }
            paths_or_none(candidates)
        }
        // Grep's `pattern` is regex content, never a path.
        "Grep" | "LS" => paths_or_none(
            field("path").map(|path| explicit_candidate(path, SEARCH, cwd)).into_iter().collect(),
        ),
        "Bash" | "PowerShell" => match field("command") {
            Some(command) => shell_evidence(command, cwd),
            None => Evidence::Unsupported,
        },
        "WebFetch" => match field("url") {
            Some(url) => Evidence::Connector { id: format!("url:{url}"), access_kind: READ },
            None => Evidence::None,
        },
        _ => Evidence::None,
    }
}

fn explicit_candidate(path: &str, access_kind: &'static str, base: Option<&str>) -> Candidate {
    Candidate {
        path: path.to_owned(),
        base: base.map(str::to_owned),
        access_kind,
        evidence_basis: EXPLICIT_ARGUMENT,
    }
}

fn explicit(path: Option<&str>, access_kind: &'static str, base: Option<&str>) -> Evidence {
    match path {
        Some(path) => Evidence::Paths(vec![explicit_candidate(path, access_kind, base)]),
        None => Evidence::Unsupported,
    }
}

fn paths_or_none(candidates: Vec<Candidate>) -> Evidence {
    if candidates.is_empty() { Evidence::None } else { Evidence::Paths(candidates) }
}

/// The directory a glob pattern is anchored at, when that anchor is absolute:
/// the text before the first glob character, cut back to its last separator.
fn glob_prefix(pattern: &str) -> Option<String> {
    let literal = match pattern.find(['*', '?', '[', '{']) {
        Some(index) => &pattern[..index],
        None => pattern,
    };
    let anchor = match literal.rfind(['/', '\\']) {
        Some(index) if literal.len() > index + 1 => &literal[..index + 1],
        _ => literal,
    };
    let anchor = anchor.trim_end_matches(['/', '\\']);
    let anchor = if anchor.is_empty() && literal.starts_with(['/', '\\']) { "/" } else { anchor };
    (is_absolute_form(anchor) && !anchor.is_empty()).then(|| anchor.to_owned())
}

fn shell_evidence(command: &str, base: Option<&str>) -> Evidence {
    let scan = shell_scan(command, base, 0);
    if !scan.candidates.is_empty() {
        Evidence::Paths(scan.candidates)
    } else if scan.opaque {
        Evidence::Unsupported
    } else {
        Evidence::None
    }
}

// --- Codex ---

/// Evidence from one Codex `response_item` call payload. `arguments` (a JSON
/// string) and `input` (JavaScript or patch text) are read here and nowhere else.
pub fn codex_evidence(
    kind: &str,
    name: Option<&str>,
    namespace: Option<&str>,
    payload: &Value,
    ctx_cwd: Option<&str>,
) -> Evidence {
    match kind {
        "function_call" => {
            if let Some(connector) = namespace.and_then(|value| value.strip_prefix("mcp__")) {
                return mcp_connector(connector, name);
            }
            match name {
                Some("shell_command" | "shell" | "exec_command" | "local_shell") => {
                    match parse_arguments(payload.get("arguments")) {
                        Ok(Some(arguments)) => shell_arguments_evidence(&arguments, ctx_cwd),
                        Ok(None) => Evidence::None,
                        Err(()) => Evidence::Unsupported,
                    }
                }
                Some("view_image") => match parse_arguments(payload.get("arguments")) {
                    Ok(Some(arguments)) => view_image_evidence(&arguments, ctx_cwd),
                    Ok(None) => Evidence::None,
                    Err(()) => Evidence::Unsupported,
                },
                Some("apply_patch") => match parse_arguments(payload.get("arguments")) {
                    Ok(Some(arguments)) => match string_field(&arguments, &["input", "patch"]) {
                        Some(patch) => paths_or_none(patch_candidates(&patch, ctx_cwd)),
                        None => Evidence::None,
                    },
                    Ok(None) => Evidence::None,
                    Err(()) => Evidence::Unsupported,
                },
                _ => Evidence::None,
            }
        }
        "custom_tool_call" => match name {
            Some("exec" | "exec_command") => match payload.get("input") {
                Some(Value::String(script)) => exec_script_evidence(script, ctx_cwd),
                None | Some(Value::Null) => Evidence::None,
                Some(_) => Evidence::Unsupported,
            },
            Some("apply_patch") => match payload.get("input") {
                Some(Value::String(patch)) => paths_or_none(patch_candidates(patch, ctx_cwd)),
                None | Some(Value::Null) => Evidence::None,
                Some(_) => Evidence::Unsupported,
            },
            Some("view_image") => match payload.get("input") {
                Some(Value::String(text)) => match serde_json::from_str::<Value>(text) {
                    Ok(arguments) => view_image_evidence(&arguments, ctx_cwd),
                    Err(_) => Evidence::Unsupported,
                },
                Some(input @ Value::Object(_)) => view_image_evidence(input, ctx_cwd),
                _ => Evidence::None,
            },
            _ => Evidence::None,
        },
        "local_shell_call" => {
            let Some(action) = payload.get("action") else { return Evidence::None };
            let base = string_field(action, &["working_directory", "workdir", "cwd"]);
            match command_field(action, &["command", "cmd"]) {
                Ok(Some(command)) => shell_evidence(&command, base.as_deref().or(ctx_cwd)),
                Ok(None) => Evidence::None,
                Err(()) => Evidence::Unsupported,
            }
        }
        "mcp_tool_call" => {
            let namespace = namespace.or_else(|| payload.get("server").and_then(Value::as_str));
            match namespace
                .map(|value| value.strip_prefix("mcp__").unwrap_or(value))
                .filter(|value| !value.is_empty())
            {
                Some(connector) => mcp_connector(connector, name),
                None => Evidence::None,
            }
        }
        _ => Evidence::None,
    }
}

fn view_image_evidence(arguments: &Value, ctx_cwd: Option<&str>) -> Evidence {
    match string_field(arguments, &["path"]) {
        Some(path) => Evidence::Paths(vec![explicit_candidate(&path, READ, ctx_cwd)]),
        None => Evidence::None,
    }
}

fn mcp_connector(namespace: &str, tool_name: Option<&str>) -> Evidence {
    if opaque_mcp(namespace, tool_name.unwrap_or_default()) {
        return Evidence::Unsupported;
    }
    Evidence::Connector { id: format!("mcp:{namespace}"), access_kind: connector_kind(tool_name) }
}

/// `arguments` is a JSON string on the wire; an object is tolerated. `Err` is unparseable.
fn parse_arguments(value: Option<&Value>) -> Result<Option<Value>, ()> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => serde_json::from_str::<Value>(text).map(Some).map_err(|_| ()),
        Some(object @ Value::Object(_)) => Ok(Some(object.clone())),
        Some(_) => Err(()),
    }
}

fn string_field(object: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| object.get(key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// A command given as a string or as an argv array (re-quoted so `-c` scripts survive).
fn command_field(object: &Value, keys: &[&str]) -> Result<Option<String>, ()> {
    for key in keys {
        match object.get(key) {
            None | Some(Value::Null) => continue,
            Some(Value::String(command)) => return Ok(Some(command.clone())),
            Some(Value::Array(parts)) => {
                let parts: Option<Vec<&str>> = parts.iter().map(Value::as_str).collect();
                return parts.map(|parts| Some(join_command_array(&parts))).ok_or(());
            }
            Some(_) => return Err(()),
        }
    }
    Ok(None)
}

fn shell_arguments_evidence(arguments: &Value, ctx_cwd: Option<&str>) -> Evidence {
    let base = string_field(arguments, &["workdir", "cwd", "working_directory"]);
    match command_field(arguments, &["command", "cmd"]) {
        Ok(Some(command)) => shell_evidence(&command, base.as_deref().or(ctx_cwd)),
        Ok(None) => Evidence::None,
        Err(()) => Evidence::Unsupported,
    }
}

/// argv back to one shell line: elements with spaces or quotes are single-quoted,
/// with an inner quote doubled, which is the form the lexer below decodes.
fn join_command_array(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| {
            if part.is_empty()
                || part.chars().any(|ch| ch.is_whitespace() || matches!(ch, '\'' | '"' | '$' | '`'))
            {
                format!("'{}'", part.replace('\'', "''"))
            } else {
                (*part).to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move to:` headers.
fn patch_candidates(patch: &str, base: Option<&str>) -> Vec<Candidate> {
    const HEADERS: [&str; 4] = ["*** Update File:", "*** Add File:", "*** Delete File:", "*** Move to:"];
    patch
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            HEADERS
                .iter()
                .find_map(|header| line.strip_prefix(header))
                .map(str::trim)
                .filter(|path| !path.is_empty())
        })
        .map(|path| explicit_candidate(path, WRITE, base))
        .collect()
}

/// A Codex `exec` script is JavaScript calling `tools.*`; only those calls are
/// read, never arbitrary literals. `workdir`/`cwd` values are context only.
fn exec_script_evidence(script: &str, ctx_cwd: Option<&str>) -> Evidence {
    let calls = js_calls(script);
    let mut candidates = Vec::new();
    let mut opaque = false;
    let mut connectors: Vec<(String, &'static str)> = Vec::new();
    for call in &calls {
        match call.name.as_str() {
            "shell_command" | "shell" | "exec_command" | "local_shell" => {
                // A declared working directory the script computes is unknown context: relative
                // operands then stay unresolved rather than falling back to the turn's cwd.
                let base = match js_lookup(script, &call.arguments, &["workdir", "cwd"]) {
                    Lookup::Found(JsArg::Text(workdir)) => Some(workdir),
                    Lookup::Missing => ctx_cwd.map(str::to_owned),
                    Lookup::Found(_) | Lookup::Unparseable => None,
                };
                match js_lookup(script, &call.arguments, &["command", "cmd"]) {
                    Lookup::Found(JsArg::Text(command)) => {
                        let scan = shell_scan(&command, base.as_deref(), 0);
                        candidates.extend(scan.candidates);
                        opaque |= scan.opaque;
                    }
                    Lookup::Found(JsArg::List(parts)) => {
                        let parts: Vec<&str> = parts.iter().map(String::as_str).collect();
                        let scan = shell_scan(&join_command_array(&parts), base.as_deref(), 0);
                        candidates.extend(scan.candidates);
                        opaque |= scan.opaque;
                    }
                    Lookup::Missing => {}
                    Lookup::Unparseable => opaque = true,
                }
            }
            "apply_patch" => match js_argument_text(script, &call.arguments) {
                Some(patch) => candidates.extend(patch_candidates(&patch, ctx_cwd)),
                None => opaque = true,
            },
            "view_image" => match js_lookup(script, &call.arguments, &["path"]) {
                Lookup::Found(JsArg::Text(path)) => candidates.push(explicit_candidate(&path, READ, ctx_cwd)),
                Lookup::Missing => {}
                _ => opaque = true,
            },
            name => {
                if let Some(rest) = name.strip_prefix("mcp__") {
                    let (namespace, tool) = rest.split_once("__").unwrap_or((rest, ""));
                    if opaque_mcp(namespace, tool) {
                        opaque = true;
                    } else if !namespace.is_empty() {
                        connectors
                            .push((namespace.to_owned(), connector_kind((!tool.is_empty()).then_some(tool))));
                    }
                } else if path_like_literals(&call.arguments) {
                    opaque = true;
                }
            }
        }
    }
    if !candidates.is_empty() {
        return Evidence::Paths(candidates);
    }
    if opaque {
        return Evidence::Unsupported;
    }
    let mut namespaces: Vec<&str> = connectors.iter().map(|(namespace, _)| namespace.as_str()).collect();
    namespaces.sort_unstable();
    namespaces.dedup();
    match namespaces.as_slice() {
        [] => {}
        [namespace] => {
            let access_kind = connectors
                .iter()
                .map(|(_, kind)| *kind)
                .max_by_key(|kind| kind_rank(kind))
                .unwrap_or(UNKNOWN);
            return Evidence::Connector { id: format!("mcp:{namespace}"), access_kind };
        }
        _ => return Evidence::Unsupported,
    }
    if calls.is_empty() && path_like_literals(script) { Evidence::Unsupported } else { Evidence::None }
}

// --- Shell text ---

#[derive(Default)]
struct ShellScan {
    candidates: Vec<Candidate>,
    /// Some part was a script body the classifier cannot follow.
    opaque: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Item {
    Word {
        text: String,
        quoted: bool,
    },
    /// `>`/`>>` (write) or `<` (read); the next word is the target.
    Redirect(&'static str),
}

enum Segment {
    Command(Vec<Item>),
    /// `(` or `$(`: the base is saved until the matching `)`.
    Open,
    Close,
}

/// Path candidates in shell text; `base` resolves relative candidates until a
/// `cd` changes or loses it. Raw tokens only; `classify` normalizes.
pub fn shell_candidates(command: &str, base: Option<&str>) -> Vec<Candidate> {
    shell_scan(command, base, 0).candidates
}

fn shell_scan(command: &str, base: Option<&str>, depth: usize) -> ShellScan {
    let mut scan = ShellScan::default();
    if depth > MAX_SHELL_DEPTH {
        scan.opaque = true;
        return scan;
    }
    let text = strip_here_strings(&strip_heredocs(command));
    let text = text.replace("\\\r\n", " ").replace("\\\n", " ").replace("`\r\n", " ").replace("`\n", " ");
    let single_line = !text.trim().contains('\n');
    let mut base = base.map(str::to_owned);
    let mut stack: Vec<Option<String>> = Vec::new();
    for segment in lex(&text) {
        match segment {
            Segment::Open => stack.push(base.clone()),
            Segment::Close => {
                if let Some(saved) = stack.pop() {
                    base = saved;
                }
            }
            Segment::Command(items) => eval_command(items, &mut base, single_line, depth, &mut scan),
        }
    }
    scan
}

/// Removes `<<TAG` … `TAG` bodies (and the operator), keeping the rest of the
/// operator's line so a trailing `> out.md` still counts.
fn strip_heredocs(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some((start, end, tag, strip_tabs)) = find_heredoc(rest) {
        out.push_str(&rest[..start]);
        let after = &rest[end..];
        let Some(newline) = after.find('\n') else {
            out.push_str(after);
            return out;
        };
        out.push_str(&after[..newline]);
        out.push('\n');
        let body = &after[newline + 1..];
        let mut consumed = body.len();
        let mut offset = 0;
        for line in body.split_inclusive('\n') {
            offset += line.len();
            let candidate = line.trim_end_matches(['\n', '\r']);
            let candidate = if strip_tabs { candidate.trim_start_matches('\t') } else { candidate };
            if candidate == tag {
                consumed = offset;
                break;
            }
        }
        rest = &body[consumed..];
    }
    out.push_str(rest);
    out
}

/// Whether byte `index` sits outside every single- or double-quoted span, so a
/// `<<` inside a quoted script body (a shift, a stream) is not a heredoc.
fn outside_quotes(text: &str, index: usize) -> bool {
    let mut single = false;
    let mut double = false;
    let mut escaped = false;
    for (position, ch) in text.char_indices() {
        if position >= index {
            break;
        }
        if escaped {
            escaped = false;
            continue;
        }
        match ch {
            '\\' if !single => escaped = true,
            '\'' if !double => single = !single,
            '"' if !single => double = !double,
            _ => {}
        }
    }
    !single && !double
}

/// `(operator start, operator end, tag, strip leading tabs)` of the next heredoc.
fn find_heredoc(text: &str) -> Option<(usize, usize, String, bool)> {
    let mut search = 0;
    while let Some(found) = text[search..].find("<<") {
        let start = search + found;
        let mut cursor = start + 2;
        if text[cursor..].starts_with('<') {
            search = cursor + 1;
            continue;
        }
        if !outside_quotes(text, start) {
            search = cursor;
            continue;
        }
        let strip_tabs = text[cursor..].starts_with('-');
        if strip_tabs {
            cursor += 1;
        }
        cursor += text[cursor..].len() - text[cursor..].trim_start_matches([' ', '\t']).len();
        let quote = text[cursor..].chars().next().filter(|ch| matches!(ch, '\'' | '"'));
        if quote.is_some() {
            cursor += 1;
        }
        let tag_len: usize = text[cursor..]
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .map(char::len_utf8)
            .sum();
        if tag_len == 0 {
            search = start + 2;
            continue;
        }
        let tag = text[cursor..cursor + tag_len].to_owned();
        cursor += tag_len;
        if let Some(quote) = quote {
            if !text[cursor..].starts_with(quote) {
                search = start + 2;
                continue;
            }
            cursor += 1;
        }
        return Some((start, cursor, tag, strip_tabs));
    }
    None
}

/// Removes PowerShell `@'…'@` and `@"…"@` here-strings.
fn strip_here_strings(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    loop {
        let single = rest.find("@'").map(|index| (index, "'@"));
        let double = rest.find("@\"").map(|index| (index, "\"@"));
        let Some((start, close)) = [single, double].into_iter().flatten().min_by_key(|(index, _)| *index)
        else {
            out.push_str(rest);
            return out;
        };
        out.push_str(&rest[..start]);
        out.push(' ');
        let after = &rest[start + 2..];
        match after.find(close) {
            Some(end) => rest = &after[end + 2..],
            None => return out,
        }
    }
}

#[derive(Default)]
struct Lexer {
    segments: Vec<Segment>,
    items: Vec<Item>,
    word: String,
    quoted: bool,
    in_word: bool,
    /// The next word is heredoc/here-string content, not an operand.
    skip_next_word: bool,
}

impl Lexer {
    fn push(&mut self, ch: char) {
        self.word.push(ch);
        self.in_word = true;
    }

    fn flush_word(&mut self) {
        if self.in_word {
            let text = std::mem::take(&mut self.word);
            if self.skip_next_word {
                self.skip_next_word = false;
            } else {
                self.items.push(Item::Word { text, quoted: self.quoted });
            }
            self.quoted = false;
            self.in_word = false;
        }
    }

    fn flush_segment(&mut self) {
        self.flush_word();
        self.skip_next_word = false;
        if !self.items.is_empty() {
            self.segments.push(Segment::Command(std::mem::take(&mut self.items)));
        }
    }

    fn marker(&mut self, segment: Segment) {
        self.flush_segment();
        self.segments.push(segment);
    }

    fn redirect(&mut self, kind: &'static str) {
        // A numeric word right before the operator is a file descriptor (`2>`).
        if self.in_word && !self.quoted && self.word.chars().all(|ch| ch.is_ascii_digit()) {
            self.word.clear();
            self.in_word = false;
        }
        self.flush_word();
        self.items.push(Item::Redirect(kind));
    }
}

/// Splits shell text into command segments honoring quotes. Backslash escapes
/// only in POSIX contexts (before `"`, `\`, `$`, backtick, space, newline), so
/// unquoted `C:\vault\note.md` survives; backtick escapes the next character.
fn lex(text: &str) -> Vec<Segment> {
    let chars: Vec<char> = text.chars().collect();
    let mut lexer = Lexer::default();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        let next = chars.get(i + 1).copied();
        match ch {
            '\'' => {
                lexer.quoted = true;
                lexer.in_word = true;
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\'' {
                        if chars.get(i + 1) == Some(&'\'') {
                            lexer.word.push('\'');
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    lexer.word.push(chars[i]);
                    i += 1;
                }
                i += 1;
            }
            '"' => {
                lexer.quoted = true;
                lexer.in_word = true;
                i += 1;
                while i < chars.len() {
                    let inner = chars[i];
                    let following = chars.get(i + 1).copied();
                    match inner {
                        '"' if following == Some('"') => {
                            lexer.word.push('"');
                            i += 2;
                        }
                        '"' => break,
                        '\\' => match following {
                            Some(escaped @ ('"' | '\\' | '$' | '`')) => {
                                lexer.word.push(escaped);
                                i += 2;
                            }
                            Some('\n') => i += 2,
                            _ => {
                                lexer.word.push('\\');
                                i += 1;
                            }
                        },
                        '`' => {
                            match following {
                                Some('\n') | None => {}
                                Some(escaped) => lexer.word.push(escaped),
                            }
                            i += 2;
                        }
                        _ => {
                            lexer.word.push(inner);
                            i += 1;
                        }
                    }
                }
                i += 1;
            }
            '\\' => match next {
                // A word starting `\\name` is a UNC path, not an escaped backslash.
                Some('\\')
                    if !lexer.in_word && chars.get(i + 2).is_some_and(|ch| ch.is_ascii_alphanumeric()) =>
                {
                    lexer.push('\\');
                    lexer.push('\\');
                    i += 2;
                }
                Some(escaped @ ('"' | '\\' | '$' | '`' | ' ')) => {
                    lexer.push(escaped);
                    i += 2;
                }
                Some('\n') => i += 2,
                _ => {
                    lexer.push('\\');
                    i += 1;
                }
            },
            '`' => match next {
                Some(escaped) if !escaped.is_whitespace() => {
                    lexer.push(escaped);
                    i += 2;
                }
                _ => i += 1,
            },
            ' ' | '\t' | '\r' => {
                lexer.flush_word();
                i += 1;
            }
            '\n' | ';' => {
                lexer.flush_segment();
                i += 1;
            }
            '|' => {
                lexer.flush_segment();
                i += if matches!(next, Some('|' | '&')) { 2 } else { 1 };
            }
            '&' => match next {
                Some('&') => {
                    lexer.flush_segment();
                    i += 2;
                }
                Some('>') => {
                    lexer.redirect(WRITE);
                    i += 2;
                    if chars.get(i) == Some(&'>') {
                        i += 1;
                    }
                }
                _ => {
                    lexer.flush_word();
                    if lexer.items.is_empty() {
                        // PowerShell call operator at the start of a command.
                        lexer.items.push(Item::Word { text: "&".into(), quoted: false });
                    } else {
                        // Background job: the command ends here.
                        lexer.flush_segment();
                    }
                    i += 1;
                }
            },
            '>' => {
                lexer.redirect(WRITE);
                i += 1;
                if chars.get(i) == Some(&'>') {
                    i += 1;
                }
                if chars.get(i) == Some(&'&') {
                    // `>&2`, `>&-`: a descriptor, not a file.
                    i += 1;
                    while chars.get(i).is_some_and(|ch| ch.is_ascii_digit() || *ch == '-') {
                        i += 1;
                    }
                    lexer.items.pop();
                }
            }
            '<' => match next {
                Some('<') => {
                    // `<<<` here-string or a `<<TAG` remnant: the next word is content.
                    lexer.flush_word();
                    i += 2;
                    if chars.get(i) == Some(&'<') {
                        i += 1;
                    }
                    lexer.skip_next_word = true;
                }
                Some('(') => {
                    lexer.flush_word();
                    i += 1;
                }
                _ => {
                    lexer.redirect(READ);
                    i += 1;
                    if chars.get(i) == Some(&'&') {
                        i += 1;
                        while chars.get(i).is_some_and(|ch| ch.is_ascii_digit() || *ch == '-') {
                            i += 1;
                        }
                        lexer.items.pop();
                    }
                }
            },
            '$' if next == Some('(') => {
                lexer.marker(Segment::Open);
                i += 2;
            }
            '(' => {
                lexer.marker(Segment::Open);
                i += 1;
            }
            ')' => {
                lexer.marker(Segment::Close);
                i += 1;
            }
            '{' | '}' if !lexer.in_word => i += 1,
            '#' if !lexer.in_word => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            _ => {
                lexer.push(ch);
                i += 1;
            }
        }
    }
    lexer.flush_segment();
    lexer.segments
}

struct Profile {
    kind: &'static str,
    /// A file command: bare `name.ext` operands count on a single line.
    recognized: bool,
    /// The first positional operand is a pattern or script, not a file.
    pattern_first: bool,
}

fn verb_profile(verb: &str) -> Profile {
    let profile = |kind, recognized, pattern_first| Profile { kind, recognized, pattern_first };
    match verb {
        "cat" | "head" | "tail" | "less" | "more" | "wc" | "stat" | "file" | "bat" | "type" | "cut"
        | "sort" | "uniq" | "get-content" | "gc" | "get-item" | "gi" | "test-path" => {
            profile(READ, true, false)
        }
        "sed" | "awk" | "jq" => profile(READ, true, true),
        "grep" | "egrep" | "fgrep" | "rg" | "ag" | "ack" | "fd" | "select-string" | "sls" => {
            profile(SEARCH, true, true)
        }
        "find" | "ls" | "dir" | "tree" | "glob" | "get-childitem" | "gci" => profile(SEARCH, true, false),
        "tee" | "cp" | "mv" | "rm" | "touch" | "mkdir" | "rmdir" | "patch" | "set-content"
        | "add-content" | "ac" | "out-file" | "new-item" | "ni" | "remove-item" | "ri" | "del" | "erase"
        | "rd" | "move-item" | "mi" | "move" | "copy-item" | "cpi" | "copy" | "rename-item" | "rni"
        | "ren" => profile(WRITE, true, false),
        "python" | "python3" | "py" | "node" | "perl" | "ruby" | "php" | "deno" | "bun" | "bash" | "sh"
        | "zsh" | "dash" | "ksh" | "fish" | "pwsh" | "powershell" | "cmd" => profile(READ, true, false),
        _ => profile(UNKNOWN, false, false),
    }
}

fn is_shell(verb: &str) -> bool {
    matches!(verb, "bash" | "sh" | "zsh" | "dash" | "ksh" | "fish" | "pwsh" | "powershell" | "cmd")
}

fn is_interpreter(verb: &str) -> bool {
    matches!(verb, "python" | "python3" | "py" | "node" | "perl" | "ruby" | "php" | "deno" | "bun")
}

fn is_wrapper(verb: &str) -> bool {
    matches!(
        verb,
        "sudo" | "doas" | "env" | "time" | "nohup" | "command" | "builtin" | "xargs" | "nice" | "&" | "."
    )
}

/// PowerShell parameters whose value is a path.
fn is_path_flag(flag: &str) -> bool {
    matches!(flag, "-path" | "-literalpath" | "-filepath" | "-destination" | "-pspath")
}

/// Parameters whose next word is a value the classifier never treats as a path.
fn takes_value(flag: &str) -> bool {
    matches!(
        flag,
        "-pattern"
            | "-filter"
            | "-encoding"
            | "-totalcount"
            | "-head"
            | "-tail"
            | "-first"
            | "-last"
            | "-skip"
            | "-depth"
            | "-itemtype"
            | "-name"
            | "-value"
            | "-delimiter"
            | "-erroraction"
            | "-include"
            | "-exclude"
            | "-newname"
            | "-context"
            | "-readcount"
            | "-width"
            | "-stream"
            | "-property"
            | "-attributes"
            | "-inputobject"
            | "-culture"
            | "-iname"
            | "-ipath"
            | "-regex"
            | "-iregex"
            | "-type"
            | "-maxdepth"
            | "-mindepth"
            | "-newer"
            | "-mtime"
            | "-mmin"
            | "-size"
            | "-perm"
            | "-user"
            | "-group"
            | "-g"
            | "--glob"
            | "-t"
            | "--type"
            | "-m"
            | "--max-count"
    )
}

/// The command word without directories or a Windows extension, lowercased.
fn verb_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or(raw).to_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".com"] {
        if let Some(stripped) = base.strip_suffix(suffix) {
            return stripped.to_owned();
        }
    }
    base
}

fn is_assignment(text: &str) -> bool {
    let name_len = text.chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_').count();
    name_len > 0
        && text.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_')
        && text.chars().nth(name_len) == Some('=')
}

/// `$name=rest` → `Some(rest)`; `$name` alone → `Some("")`; otherwise `None`.
fn powershell_assignment(text: &str) -> Option<&str> {
    let name = text.strip_prefix('$')?;
    let name_len =
        name.chars().take_while(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | ':')).count();
    if name_len == 0 || !name.chars().next().is_some_and(|ch| ch.is_ascii_alphabetic() || ch == '_') {
        return None;
    }
    match &name[name_len..] {
        "" => Some(""),
        rest => rest.strip_prefix('='),
    }
}

fn eval_command(
    items: Vec<Item>,
    base: &mut Option<String>,
    single_line: bool,
    depth: usize,
    scan: &mut ShellScan,
) {
    let mut words = items;
    let mut cursor = 0;
    // Leading assignments (`VAR=x cmd`, `$r = cmd`, `$r=cmd`) and wrappers.
    loop {
        let Some(Item::Word { text, quoted }) = words.get(cursor) else { return };
        if !quoted && is_assignment(text) {
            cursor += 1;
            continue;
        }
        if !quoted && let Some(rest) = powershell_assignment(text) {
            if !rest.is_empty() {
                words[cursor] = Item::Word { text: rest.to_owned(), quoted: false };
                continue;
            }
            cursor += 1;
            match words.get(cursor) {
                Some(Item::Word { text, .. }) if text == "=" => cursor += 1,
                Some(Item::Word { text, quoted }) if text.starts_with('=') => {
                    words[cursor] = Item::Word { text: text[1..].to_owned(), quoted: *quoted };
                }
                _ => {}
            }
            continue;
        }
        let verb = verb_name(text);
        if is_wrapper(&verb) {
            cursor += 1;
            while let Some(Item::Word { text, quoted }) = words.get(cursor) {
                if !quoted
                    && (text.starts_with('-') && text.len() > 1 || (verb == "env" && is_assignment(text)))
                {
                    cursor += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        break;
    }
    let Some(Item::Word { text: verb_raw, .. }) = words.get(cursor) else { return };
    let verb = verb_name(verb_raw);
    cursor += 1;
    let operands = &words[cursor..];

    match verb.as_str() {
        "cd" | "chdir" | "pushd" | "push-location" | "set-location" | "sl" => {
            *base = change_directory(operands);
            return;
        }
        "popd" | "pop-location" => {
            *base = None;
            return;
        }
        _ => {}
    }

    if is_shell(&verb) {
        let powershell = matches!(verb.as_str(), "pwsh" | "powershell");
        // POSIX shells take one script word after `-c`; PowerShell and cmd accept the rest of
        // the line after `-Command` / `/c`, quoted or not.
        let body = if powershell || verb == "cmd" {
            rest_of_line(operands, &["-command", "-comm", "-c", "/c", "/k"])
        } else {
            script_operand(operands, &["-c", "-lc"]).map(str::to_owned)
        };
        if let Some(script) = body {
            let nested = shell_scan(&script, base.as_deref(), depth + 1);
            if nested.candidates.is_empty() && !nested.opaque && path_like_literals(&script) {
                scan.opaque = true;
            }
            scan.opaque |= nested.opaque;
            scan.candidates.extend(nested.candidates);
            return;
        }
        // `-e` is errexit for POSIX shells and only an encoded command for PowerShell.
        if powershell && script_operand(operands, &["-encodedcommand", "-e", "-ec", "-enc"]).is_some() {
            scan.opaque = true;
            return;
        }
    }
    if is_interpreter(&verb)
        && let Some(body) = script_operand(operands, &["-c", "-e", "--eval", "-p", "--print", "-E"])
    {
        if path_like_literals(body) {
            scan.opaque = true;
        }
        return;
    }

    let profile = verb_profile(&verb);
    let in_place = verb == "sed"
        && operands.iter().any(|item| {
            matches!(item, Item::Word { text, quoted: false } if text.starts_with("-i") || text.starts_with("--in-place"))
        });
    let kind = if in_place { WRITE } else { profile.kind };

    let mut pending_redirect: Option<&'static str> = None;
    let mut skip_next = false;
    let mut path_next = false;
    let mut explicit_pattern = false;
    let mut positional = 0;
    for item in operands {
        match item {
            Item::Redirect(redirect_kind) => pending_redirect = Some(redirect_kind),
            Item::Word { text, quoted } => {
                if let Some(redirect_kind) = pending_redirect.take() {
                    if candidate_form(text, *quoted, true, single_line) {
                        scan.candidates.push(shell_candidate(text, base, redirect_kind));
                    }
                    continue;
                }
                if skip_next {
                    skip_next = false;
                    continue;
                }
                if path_next {
                    path_next = false;
                    if candidate_form(text, *quoted, true, single_line) {
                        scan.candidates.push(shell_candidate(text, base, kind));
                    }
                    continue;
                }
                if !quoted && text.starts_with('-') && text.len() > 1 {
                    let flag = text.to_lowercase();
                    if let Some((option, value)) = text.split_once('=')
                        && option.starts_with("--")
                    {
                        if candidate_form(value, false, profile.recognized, single_line) {
                            scan.candidates.push(shell_candidate(value, base, kind));
                        }
                        continue;
                    }
                    if is_path_flag(&flag) {
                        path_next = true;
                    } else if profile.pattern_first && matches!(flag.as_str(), "-e" | "--regexp") {
                        explicit_pattern = true;
                        skip_next = true;
                    } else if profile.pattern_first
                        && matches!(flag.as_str(), "-f" | "--files" | "--type-list")
                    {
                        // `rg --files <dir>` lists a tree without a pattern: the operand is the path.
                        explicit_pattern = true;
                    } else if verb == "find"
                        && matches!(flag.as_str(), "-exec" | "-execdir" | "-ok" | "-okdir")
                    {
                        break;
                    } else if takes_value(&flag) {
                        skip_next = true;
                    }
                    continue;
                }
                if is_numeric(text) {
                    continue;
                }
                let index = positional;
                positional += 1;
                if profile.pattern_first && !explicit_pattern && index == 0 {
                    continue;
                }
                if candidate_form(text, *quoted, profile.recognized, single_line) {
                    scan.candidates.push(shell_candidate(text, base, kind));
                }
            }
        }
    }
}

fn shell_candidate(path: &str, base: &Option<String>, access_kind: &'static str) -> Candidate {
    Candidate { path: path.to_owned(), base: base.clone(), access_kind, evidence_basis: INDIRECT_SHELL }
}

/// The script body following one of `flags`, when present.
fn script_operand<'a>(operands: &'a [Item], flags: &[&str]) -> Option<&'a str> {
    let mut items = operands.iter();
    while let Some(item) = items.next() {
        if let Item::Word { text, quoted: false } = item
            && flags.contains(&text.to_lowercase().as_str())
        {
            return match items.next() {
                Some(Item::Word { text, .. }) => Some(text.as_str()),
                _ => None,
            };
        }
    }
    None
}

/// Everything after one of `flags`, re-joined as one command line (PowerShell
/// `-Command` and cmd `/c` take the rest of the line, quoted or not).
fn rest_of_line(operands: &[Item], flags: &[&str]) -> Option<String> {
    let position = operands.iter().position(|item| {
        matches!(item, Item::Word { text, quoted: false } if flags.contains(&text.to_lowercase().as_str()))
    })?;
    let rest = &operands[position + 1..];
    match rest {
        [] => None,
        // One word is a quoted script body; it is lexed again as written.
        [Item::Word { text, .. }] => Some(text.clone()),
        _ => Some(
            rest.iter()
                .map(|item| match item {
                    Item::Word { text, quoted: true } => format!("'{}'", text.replace('\'', "''")),
                    Item::Word { text, quoted: false } => text.clone(),
                    Item::Redirect(kind) if *kind == READ => "<".to_owned(),
                    Item::Redirect(_) => ">".to_owned(),
                })
                .collect::<Vec<_>>()
                .join(" "),
        ),
    }
}

/// The base after `cd`: an absolute or `~/` target is the new base; a relative,
/// `~user`, or variable target loses it. The target itself is never a candidate.
fn change_directory(operands: &[Item]) -> Option<String> {
    let mut target = None;
    let mut path_next = false;
    for item in operands {
        let Item::Word { text, quoted } = item else { break };
        if path_next {
            target = Some(text.as_str());
            break;
        }
        if !quoted && text.starts_with('-') && text.len() > 1 {
            path_next = is_path_flag(&text.to_lowercase());
            continue;
        }
        target = Some(text.as_str());
        break;
    }
    match target {
        None => Some("~".to_owned()),
        Some(target) if is_variable_path(target) || target.starts_with('$') => None,
        Some(target) if is_home_form(target) => Some(target.to_owned()),
        Some(target) if target.starts_with('~') => None,
        Some(target) if is_absolute_form(target) => Some(target.to_owned()),
        Some(_) => None,
    }
}

fn is_home_form(text: &str) -> bool {
    text == "~" || text.starts_with("~/") || text.starts_with("~\\")
}

/// POSIX `/x`, drive `X:\x` or `X:/x` (a bare `X:` is left alone: `q:` is an
/// object key far more often than a drive), UNC `\\x`, or any `~` form.
fn is_absolute_form(text: &str) -> bool {
    let mut chars = text.chars();
    let drive = chars.next().is_some_and(|ch| ch.is_ascii_alphabetic())
        && chars.next() == Some(':')
        && matches!(chars.next(), Some('/' | '\\'));
    drive || text.starts_with('/') || text.starts_with("\\\\") || text.starts_with('~')
}

fn is_variable_path(text: &str) -> bool {
    (text.starts_with('$') || text.starts_with('%')) && text.contains(['/', '\\'])
}

fn is_relative_prefixed(text: &str) -> bool {
    ["./", "../", ".\\", "..\\"].iter().any(|prefix| text.starts_with(prefix) && text.len() > prefix.len())
}

fn is_null_device(text: &str) -> bool {
    matches!(
        text.to_lowercase().as_str(),
        "/dev/null" | "/dev/stdin" | "/dev/stdout" | "/dev/stderr" | "/dev/tty" | "nul" | "$null" | "-"
    )
}

fn is_numeric(text: &str) -> bool {
    !text.is_empty()
        && text.chars().any(|ch| ch.is_ascii_digit())
        && text.chars().all(|ch| ch.is_ascii_digit() || matches!(ch, '.' | ',' | '-' | '+'))
}

/// A bare `name.ext` or `dir/name.ext` operand: extension of 1–8 alphanumerics,
/// no glob, URL, number, flag, assignment, or `key:value` shape.
fn is_named_file(text: &str, quoted: bool) -> bool {
    if text.contains(['*', '?', '[', '@', ':', '=']) || text.contains("://") || text.ends_with(['/', '\\']) {
        return false;
    }
    if text.starts_with('-') || is_numeric(text) || (!quoted && text.chars().any(char::is_whitespace)) {
        return false;
    }
    let last = text.rsplit(['/', '\\']).next().unwrap_or(text);
    let Some((name, ext)) = last.rsplit_once('.') else { return false };
    !name.is_empty()
        && !name.chars().all(|ch| ch == '.')
        && (1..=8).contains(&ext.len())
        && ext.chars().all(|ch| ch.is_ascii_alphanumeric())
}

/// Whether one operand is a path candidate under the A13 rules.
fn candidate_form(text: &str, quoted: bool, verb_recognized: bool, single_line: bool) -> bool {
    let value = text.trim();
    if value.is_empty() || is_null_device(value) || value.contains("://") {
        return false;
    }
    if !quoted && is_assignment(value) {
        return false;
    }
    if is_absolute_form(value) || is_variable_path(value) || is_relative_prefixed(value) {
        return true;
    }
    verb_recognized && single_line && is_named_file(value, quoted)
}

/// Whether free text mentions a path: an absolute or `./` token, or a quoted
/// file name. Used only to tell an opaque script from an empty one.
fn path_like_literals(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if matches!(ch, '\'' | '"' | '`') {
            if let Some((literal, end)) = js_string_literal(&chars, i) {
                let literal = literal.trim();
                if is_absolute_form(literal) || is_relative_prefixed(literal) || is_named_file(literal, true)
                {
                    return true;
                }
                i = end;
                continue;
            }
            i += 1;
            continue;
        }
        if ch.is_whitespace() || matches!(ch, '(' | ')' | ',' | ';' | '{' | '}' | '[' | ']') {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len()
            && !chars[i].is_whitespace()
            && !matches!(chars[i], '\'' | '"' | '`' | '(' | ')' | ',' | ';' | '{' | '}' | '[' | ']')
        {
            i += 1;
        }
        let token: String = chars[start..i].iter().collect();
        if (is_absolute_form(&token) || is_relative_prefixed(&token)) && !token.contains("://") {
            return true;
        }
    }
    false
}

// --- JavaScript (Codex exec scripts) ---

struct JsCall {
    name: String,
    arguments: String,
}

enum JsArg {
    Text(String),
    List(Vec<String>),
}

enum Lookup {
    Found(JsArg),
    Missing,
    Unparseable,
}

fn is_ident_start(ch: char) -> bool {
    ch.is_ascii_alphabetic() || matches!(ch, '_' | '$')
}

fn is_ident_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '_' | '$')
}

fn skip_ws(chars: &[char], mut i: usize) -> usize {
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    i
}

/// Index after a `//` or `/* */` comment starting at `i`, or `None`.
fn skip_comment(chars: &[char], i: usize) -> Option<usize> {
    match (chars.get(i), chars.get(i + 1)) {
        (Some('/'), Some('/')) => {
            let mut j = i + 2;
            while j < chars.len() && chars[j] != '\n' {
                j += 1;
            }
            Some(j)
        }
        (Some('/'), Some('*')) => {
            let mut j = i + 2;
            while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') {
                j += 1;
            }
            Some((j + 2).min(chars.len()))
        }
        _ => None,
    }
}

/// Every `tools.<name>(…)` call with its raw argument text.
fn js_calls(script: &str) -> Vec<JsCall> {
    let chars: Vec<char> = script.chars().collect();
    let mut calls = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        if matches!(chars[i], '\'' | '"' | '`') {
            i = js_string_literal(&chars, i).map_or(i + 1, |(_, end)| end);
            continue;
        }
        if let Some(end) = skip_comment(&chars, i) {
            i = end;
            continue;
        }
        let at_boundary = i == 0 || !is_ident_char(chars[i - 1]) && chars[i - 1] != '.';
        if at_boundary && chars[i..].starts_with(&['t', 'o', 'o', 'l', 's', '.']) {
            let name_start = i + 6;
            let mut j = name_start;
            while j < chars.len() && is_ident_char(chars[j]) {
                j += 1;
            }
            let name: String = chars[name_start..j].iter().collect();
            let open = skip_ws(&chars, j);
            if !name.is_empty() && chars.get(open) == Some(&'(') {
                let (arguments, end) = js_balanced(&chars, open);
                calls.push(JsCall { name, arguments });
                i = end;
                continue;
            }
            i = j.max(i + 1);
            continue;
        }
        i += 1;
    }
    calls
}

/// The text inside the bracket at `open` and the index after its match.
fn js_balanced(chars: &[char], open: usize) -> (String, usize) {
    let mut depth = 0usize;
    let mut i = open;
    while i < chars.len() {
        let ch = chars[i];
        if matches!(ch, '\'' | '"' | '`') {
            i = js_string_literal(chars, i).map_or(i + 1, |(_, end)| end);
            continue;
        }
        if let Some(end) = skip_comment(chars, i) {
            i = end;
            continue;
        }
        match ch {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return (chars[open + 1..i].iter().collect(), i + 1);
                }
            }
            _ => {}
        }
        i += 1;
    }
    (chars[(open + 1).min(chars.len())..].iter().collect(), chars.len())
}

/// Decodes the JavaScript string literal starting at `start` (a quote char);
/// returns the text and the index after the closing quote. Template
/// substitutions are kept verbatim.
fn js_string_literal(chars: &[char], start: usize) -> Option<(String, usize)> {
    let quote = *chars.get(start)?;
    let mut out = String::new();
    let mut i = start + 1;
    while i < chars.len() {
        let ch = chars[i];
        if ch == quote {
            return Some((out, i + 1));
        }
        if ch == '\\' {
            let escaped = *chars.get(i + 1)?;
            i += 2;
            match escaped {
                'n' => out.push('\n'),
                'r' => out.push('\r'),
                't' => out.push('\t'),
                'b' => out.push('\u{8}'),
                'f' => out.push('\u{c}'),
                'v' => out.push('\u{b}'),
                '0' => out.push('\0'),
                '\n' => {}
                '\r' => {
                    if chars.get(i) == Some(&'\n') {
                        i += 1;
                    }
                }
                'x' => {
                    let hex: String = chars.get(i..i + 2)?.iter().collect();
                    out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                    i += 2;
                }
                'u' => {
                    if chars.get(i) == Some(&'{') {
                        let close = (i..chars.len()).find(|&j| chars[j] == '}')?;
                        let hex: String = chars[i + 1..close].iter().collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                        i = close + 1;
                    } else {
                        let hex: String = chars.get(i..i + 4)?.iter().collect();
                        out.push(char::from_u32(u32::from_str_radix(&hex, 16).ok()?)?);
                        i += 4;
                    }
                }
                other => out.push(other),
            }
            continue;
        }
        if quote == '`' && ch == '$' && chars.get(i + 1) == Some(&'{') {
            let mut depth = 0usize;
            let mut j = i + 1;
            while j < chars.len() {
                match chars[j] {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            break;
                        }
                    }
                    _ => {}
                }
                j += 1;
            }
            out.extend(chars[i..(j + 1).min(chars.len())].iter());
            i = j + 1;
            continue;
        }
        if quote != '`' && ch == '\n' {
            return None;
        }
        out.push(ch);
        i += 1;
    }
    None
}

/// A string literal, or several joined with `+`, starting at `i`.
fn js_literal_chain(chars: &[char], i: usize) -> Option<(String, usize)> {
    let (mut text, mut end) = js_string_literal(chars, i)?;
    loop {
        let plus = skip_ws(chars, end);
        if chars.get(plus) != Some(&'+') {
            return Some((text, end));
        }
        let next = skip_ws(chars, plus + 1);
        match js_string_literal(chars, next) {
            Some((more, after)) => {
                text.push_str(&more);
                end = after;
            }
            None => return Some((text, end)),
        }
    }
}

/// `const|let|var <name> = <string literal chain>` anywhere in the script.
fn js_binding(script: &str, name: &str) -> Option<String> {
    let chars: Vec<char> = script.chars().collect();
    let target: Vec<char> = name.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if matches!(chars[i], '\'' | '"' | '`') {
            i = js_string_literal(&chars, i).map_or(i + 1, |(_, end)| end);
            continue;
        }
        if let Some(end) = skip_comment(&chars, i) {
            i = end;
            continue;
        }
        let boundary = i == 0 || !is_ident_char(chars[i - 1]);
        if boundary
            && chars[i..].starts_with(&target)
            && !chars.get(i + target.len()).is_some_and(|ch| is_ident_char(*ch))
        {
            let equals = skip_ws(&chars, i + target.len());
            if declared_before(&chars, i)
                && chars.get(equals) == Some(&'=')
                && chars.get(equals + 1) != Some(&'=')
            {
                let value = skip_ws(&chars, equals + 1);
                if let Some((text, _)) = js_literal_chain(&chars, value) {
                    return Some(text);
                }
            }
            i += target.len();
            continue;
        }
        i += 1;
    }
    None
}

/// Whether `const`, `let`, or `var` (as a whole word) ends the text before `end`.
fn declared_before(chars: &[char], end: usize) -> bool {
    let mut stop = end;
    while stop > 0 && chars[stop - 1].is_whitespace() {
        stop -= 1;
    }
    ["const", "let", "var"].iter().any(|keyword| {
        let len = keyword.chars().count();
        stop >= len
            && chars[stop - len..stop].iter().copied().eq(keyword.chars())
            && (stop == len || !is_ident_char(chars[stop - len - 1]))
    })
}

/// The one string argument of a call: a literal chain or an identifier bound to one.
fn js_argument_text(script: &str, arguments: &str) -> Option<String> {
    let chars: Vec<char> = arguments.chars().collect();
    let start = skip_ws(&chars, 0);
    if matches!(chars.get(start), Some('\'' | '"' | '`')) {
        return js_literal_chain(&chars, start).map(|(text, _)| text);
    }
    let mut end = start;
    while end < chars.len() && is_ident_char(chars[end]) {
        end += 1;
    }
    let name: String = chars[start..end].iter().collect();
    (!name.is_empty() && skip_ws(&chars, end) == chars.len()).then(|| js_binding(script, &name)).flatten()
}

/// A string (or string-array) property of an object-literal argument, by
/// strict JSON first and a tolerant key scan second (bare keys, single quotes,
/// backticks, `{cmd}` shorthand bound elsewhere in the script).
fn js_lookup(script: &str, arguments: &str, keys: &[&str]) -> Lookup {
    if let Ok(Value::Object(object)) = serde_json::from_str::<Value>(arguments.trim()) {
        for key in keys {
            match object.get(*key) {
                None | Some(Value::Null) => continue,
                Some(Value::String(text)) => return Lookup::Found(JsArg::Text(text.clone())),
                Some(Value::Array(items)) => {
                    let parts: Option<Vec<String>> =
                        items.iter().map(|item| item.as_str().map(str::to_owned)).collect();
                    return parts.map_or(Lookup::Unparseable, |parts| Lookup::Found(JsArg::List(parts)));
                }
                Some(_) => return Lookup::Unparseable,
            }
        }
        return Lookup::Missing;
    }
    let chars: Vec<char> = arguments.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if matches!(ch, '\'' | '"' | '`') {
            match js_string_literal(&chars, i) {
                Some((text, end)) => {
                    let after = skip_ws(&chars, end);
                    if chars.get(after) == Some(&':') && keys.contains(&text.as_str()) {
                        return js_value_at(script, &chars, after + 1);
                    }
                    i = end;
                }
                None => i += 1,
            }
            continue;
        }
        if let Some(end) = skip_comment(&chars, i) {
            i = end;
            continue;
        }
        if is_ident_start(ch) && (i == 0 || !is_ident_char(chars[i - 1])) {
            let start = i;
            while i < chars.len() && is_ident_char(chars[i]) {
                i += 1;
            }
            let ident: String = chars[start..i].iter().collect();
            let after = skip_ws(&chars, i);
            if keys.contains(&ident.as_str()) {
                match chars.get(after) {
                    Some(':') => return js_value_at(script, &chars, after + 1),
                    // `{cmd}` / `{cmd, workdir}` shorthand: the value is a binding.
                    Some(',' | '}') | None => {
                        return js_binding(script, &ident)
                            .map_or(Lookup::Unparseable, |text| Lookup::Found(JsArg::Text(text)));
                    }
                    _ => {}
                }
            }
            continue;
        }
        i += 1;
    }
    Lookup::Missing
}

fn js_value_at(script: &str, chars: &[char], position: usize) -> Lookup {
    let position = skip_ws(chars, position);
    match chars.get(position) {
        Some('\'' | '"' | '`') => js_literal_chain(chars, position)
            .map_or(Lookup::Unparseable, |(text, _)| Lookup::Found(JsArg::Text(text))),
        Some('[') => {
            let (inner, _) = js_balanced(chars, position);
            let inner: Vec<char> = inner.chars().collect();
            let mut parts = Vec::new();
            let mut i = 0;
            while i < inner.len() {
                let ch = inner[i];
                if matches!(ch, '\'' | '"' | '`') {
                    match js_literal_chain(&inner, i) {
                        Some((text, end)) => {
                            parts.push(text);
                            i = end;
                        }
                        None => return Lookup::Unparseable,
                    }
                    continue;
                }
                if ch.is_whitespace() || ch == ',' {
                    i += 1;
                    continue;
                }
                return Lookup::Unparseable;
            }
            Lookup::Found(JsArg::List(parts))
        }
        Some(ch) if is_ident_start(*ch) => {
            let mut end = position;
            while end < chars.len() && is_ident_char(chars[end]) {
                end += 1;
            }
            let name: String = chars[position..end].iter().collect();
            js_binding(script, &name).map_or(Lookup::Unparseable, |text| Lookup::Found(JsArg::Text(text)))
        }
        _ => Lookup::Unparseable,
    }
}

// --- Classification ---

fn kind_rank(kind: &str) -> u8 {
    match kind {
        WRITE => 3,
        READ => 2,
        SEARCH => 1,
        _ => 0,
    }
}

fn basis_rank(basis: &str) -> u8 {
    match basis {
        EXPLICIT_ARGUMENT => 3,
        CONNECTOR => 2,
        INDIRECT_SHELL => 1,
        _ => 0,
    }
}

fn connector_matches(id: &str, configured: &str) -> bool {
    if configured.starts_with("url:") { id.starts_with(configured) } else { id == configured }
}

/// Resolves evidence against the configuration: one match per resource with
/// the strongest kind and basis, plus the inspection class.
pub fn classify(evidence: &Evidence, configuration: &ResourceConfiguration) -> Classification {
    match evidence {
        Evidence::None => Classification::empty("no_evidence"),
        Evidence::Unsupported => Classification::empty("unsupported"),
        Evidence::Connector { id, access_kind } => {
            let keys: Vec<&str> = configuration
                .resources
                .iter()
                .filter(|resource| {
                    resource.connectors.iter().any(|connector| connector_matches(id, connector))
                })
                .map(|resource| resource.key.as_str())
                .collect();
            match keys.as_slice() {
                [] => Classification::empty("unmatched"),
                [key] => Classification {
                    matches: vec![ResourceMatch {
                        resource_key: (*key).to_owned(),
                        access_kind,
                        evidence_basis: CONNECTOR,
                        nested_overlap: false,
                    }],
                    class: "matched",
                    overlapping: false,
                },
                _ => Classification::empty("ambiguous"),
            }
        }
        Evidence::Paths(candidates) => {
            if candidates.is_empty() {
                return Classification::empty("no_evidence");
            }
            let home = configuration.home.as_deref();
            let mut merged: BTreeMap<String, ResourceMatch> = BTreeMap::new();
            let mut unresolved = false;
            let mut overlapping = false;
            for candidate in candidates {
                let Some(path) = normalize_path(&candidate.path, candidate.base.as_deref(), home) else {
                    unresolved = true;
                    continue;
                };
                let hits: Vec<&str> = configuration
                    .resources
                    .iter()
                    .flat_map(|resource| {
                        resource
                            .roots
                            .iter()
                            .filter(|root| matches(&path, root))
                            .map(move |_| resource.key.as_str())
                    })
                    .collect();
                let nested = hits.len() > 1;
                overlapping |= nested;
                for key in hits {
                    let entry = merged.entry(key.to_owned()).or_insert_with(|| ResourceMatch {
                        resource_key: key.to_owned(),
                        access_kind: UNKNOWN,
                        evidence_basis: "unknown",
                        nested_overlap: false,
                    });
                    if kind_rank(candidate.access_kind) > kind_rank(entry.access_kind) {
                        entry.access_kind = candidate.access_kind;
                    }
                    if basis_rank(candidate.evidence_basis) > basis_rank(entry.evidence_basis) {
                        entry.evidence_basis = candidate.evidence_basis;
                    }
                    entry.nested_overlap |= nested;
                }
            }
            let matches: Vec<ResourceMatch> = merged.into_values().collect();
            let class = if !matches.is_empty() {
                "matched"
            } else if unresolved {
                "unresolved"
            } else {
                "unmatched"
            };
            Classification { matches, class, overlapping }
        }
    }
}

// --- Local rows and wire records ---

/// The classification inputs one scan carries: the configuration and the
/// `cfg:<token>` each key's rows are stamped with. Built once per scan so the
/// per-resource digest is hashed once, not per invocation; the token itself is
/// random and lives in the state `meta` table, never derived from a root.
#[derive(Clone, Debug)]
pub struct ScanResources<'a> {
    pub configuration: &'a ResourceConfiguration,
    versions: BTreeMap<String, String>,
}

impl<'a> ScanResources<'a> {
    /// `None` when nothing is configured, so the parse sites skip classification.
    pub fn prepare(
        state: &State,
        configuration: &'a ResourceConfiguration,
    ) -> Result<Option<Self>, StateError> {
        if configuration.is_empty() {
            return Ok(None);
        }
        let mut versions = BTreeMap::new();
        for resource in &configuration.resources {
            if let Some(digest) = configuration.resource_version(&resource.key) {
                let token = state.resource_config_token(&digest)?;
                versions.insert(resource.key.clone(), configuration_version(&token));
            }
        }
        Ok(Some(Self { configuration, versions }))
    }

    pub fn version(&self, key: &str) -> Option<&str> {
        self.versions.get(key).map(String::as_str)
    }
}

/// The wire form of a configuration token.
pub fn configuration_version(token: &str) -> String {
    format!("cfg:{token}")
}

/// Classifies one invocation's evidence and stores what may be kept: one
/// access row per matched resource and the inspection class. The evidence is
/// consumed here; nothing from an argument survives the call.
pub fn save_evidence(
    state: &State,
    binding: &str,
    scan: &ScanResources<'_>,
    invocation_key: &str,
    timestamp: &str,
    evidence: &Evidence,
) -> Result<(), StateError> {
    let classification = classify(evidence, scan.configuration);
    for found in &classification.matches {
        let Some(version) = scan.version(&found.resource_key) else { continue };
        state.upsert_resource_access(
            binding,
            &ResourceAccessRow {
                id: access_id(invocation_key, &found.resource_key),
                timestamp: timestamp.to_owned(),
                invocation_key: invocation_key.to_owned(),
                resource_key: found.resource_key.clone(),
                configuration_version: version.to_owned(),
                access_kind: found.access_kind.to_owned(),
                evidence_basis: found.evidence_basis.to_owned(),
                nested_overlap: found.nested_overlap,
            },
        )?;
    }
    state.upsert_resource_inspection(
        binding,
        invocation_key,
        classification.class,
        classification.overlapping,
    )
}

/// Builds the `resource.access` record for one stored row with the outcome of
/// its invocation; `None` when a stored value is outside the contract.
pub fn record_from_access(
    binding: &Uuid,
    adapter: Adapter,
    parser_version: &str,
    row: &ResourceAccessRow,
    outcome: &str,
) -> Option<Record> {
    Some(Record::ResourceAccess(ResourceAccess {
        record_id: record_id(binding, Channel::LocalFile, &format!("resource:{}", row.id)),
        binding_id: binding.clone(),
        adapter,
        channel: Channel::LocalFile,
        observed_at: Stamp::parse(&row.timestamp).ok()?,
        basis: Basis::Exact,
        parser_version: Text::truncated(parser_version).ok()?,
        semantic_key: Sha256Hex::try_from(row.id.clone()).ok()?,
        invocation_key: Sha256Hex::try_from(row.invocation_key.clone()).ok()?,
        resource_key: Code::try_from(row.resource_key.clone()).ok()?,
        configuration_version: Nullable(Some(Code::try_from(row.configuration_version.clone()).ok()?)),
        access_kind: AccessKind::from_str(&row.access_kind).unwrap_or(AccessKind::Unknown),
        evidence_basis: AccessEvidenceBasis::from_str(&row.evidence_basis)
            .unwrap_or(AccessEvidenceBasis::Unknown),
        outcome: EventOutcome::from_str(outcome).unwrap_or(EventOutcome::Unknown),
    }))
}

/// Emits one record per stored access row of the binding. The outcome is the
/// invocation row's (`unknown` when none exists) and the subagent rule is the
/// invocation's, so a resource row never says more than its tool event.
pub fn emit_records(
    state: &State,
    binding: &BindingContext,
    adapter: Adapter,
    parser_version: &str,
    include_subagents: bool,
    tool_events: &[ToolEventRow],
    sink: &mut dyn Sink,
) -> Result<u64, StateError> {
    let mut outcomes: HashMap<&str, &str> = HashMap::new();
    let mut subagent: HashMap<&str, bool> = HashMap::new();
    for event in tool_events {
        if event.event_kind == "invocation" {
            outcomes.insert(event.invocation_key.as_str(), event.outcome.as_str());
        }
        *subagent.entry(event.invocation_key.as_str()).or_default() |= event.caller_is_subagent;
    }
    let mut emitted = 0;
    for row in state.resource_accesses(binding.binding_id.as_str())? {
        if !include_subagents && subagent.get(row.invocation_key.as_str()).copied().unwrap_or(false) {
            continue;
        }
        let outcome = outcomes.get(row.invocation_key.as_str()).copied().unwrap_or("unknown");
        if let Some(record) = record_from_access(&binding.binding_id, adapter, parser_version, &row, outcome)
        {
            sink.emit(record, None);
            emitted += 1;
        }
    }
    Ok(emitted)
}

/// What the `resource` capability reports: whether rows may leave the machine
/// and which inspection classes the retained history produced.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceEvidenceSummary {
    pub configured: bool,
    pub denied: bool,
    pub inspections: ResourceInspectionCounts,
}

impl ResourceEvidenceSummary {
    pub fn for_run(ctx: &RunContext) -> Self {
        Self {
            configured: !ctx.resources.is_empty(),
            denied: resource_attribution_denied(&ctx.deny),
            inspections: ResourceInspectionCounts::default(),
        }
    }

    pub fn observe(&mut self, counts: ResourceInspectionCounts) {
        self.inspections.add(counts);
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use observatory_core::config::LocalResource;

    use super::*;

    fn local(key: &str, roots: &[&str], connectors: &[&str]) -> LocalResource {
        LocalResource {
            key: key.into(),
            label: None,
            roots: roots.iter().map(PathBuf::from).collect(),
            connectors: connectors.iter().map(|value| (*value).to_owned()).collect(),
            source: None,
        }
    }

    /// Two POSIX vaults, a nested root configured as its own source, a Windows
    /// vault, and connectors: `mcp:shared` is claimed twice on purpose.
    fn configuration() -> ResourceConfiguration {
        ResourceConfiguration::from_local(
            &[
                local(
                    "alpha-src",
                    &["/synthetic/vault-alpha"],
                    &["mcp:alpha", "mcp:shared", "url:https://alpha.test/"],
                ),
                local("beta-src", &["/synthetic/vault-beta", "C:\\Synthetic\\Vault-Beta"], &["mcp:shared"]),
                local("inner-src", &["/synthetic/vault-alpha/nested"], &[]),
                local("home-src", &["~/notes"], &[]),
            ],
            Some("/home/u"),
        )
    }

    fn keys(classification: &Classification) -> Vec<(&str, &str, &str, bool)> {
        classification
            .matches
            .iter()
            .map(|m| (m.resource_key.as_str(), m.access_kind, m.evidence_basis, m.nested_overlap))
            .collect()
    }

    fn paths(evidence: &Evidence) -> Vec<(&str, Option<&str>, &str, &str)> {
        match evidence {
            Evidence::Paths(candidates) => candidates
                .iter()
                .map(|c| (c.path.as_str(), c.base.as_deref(), c.access_kind, c.evidence_basis))
                .collect(),
            _ => panic!("expected path evidence, got {evidence:?}"),
        }
    }

    fn shell(command: &str, base: Option<&str>) -> Vec<(String, Option<String>, &'static str)> {
        shell_candidates(command, base).into_iter().map(|c| (c.path, c.base, c.access_kind)).collect()
    }

    fn classified(evidence: &Evidence) -> Classification {
        classify(evidence, &configuration())
    }

    #[test]
    fn access_ids_are_labeled_digests() {
        let id = access_id("inv", "alpha-src");
        assert_eq!(id, digest(&json!(["resource-access", "inv", "alpha-src"])).as_str());
        assert_ne!(id, access_id("inv", "beta-src"));
        assert_ne!(id, access_id("other", "alpha-src"));
    }

    #[test]
    fn connector_kinds_follow_the_bare_tool_name() {
        assert_eq!(connector_kind(Some("search_notes")), SEARCH);
        assert_eq!(connector_kind(Some("ListFiles")), SEARCH);
        assert_eq!(connector_kind(Some("read_note")), READ);
        assert_eq!(connector_kind(Some("get_file_contents")), READ);
        assert_eq!(connector_kind(Some("update_note")), WRITE);
        assert_eq!(connector_kind(Some("search_and_delete")), WRITE);
        assert_eq!(connector_kind(Some("ping")), UNKNOWN);
        assert_eq!(connector_kind(None), UNKNOWN);
    }

    // --- Claude explicit arguments ---

    #[test]
    fn claude_read_and_write_tools_are_explicit_arguments() {
        let read =
            claude_evidence("Read", &json!({"file_path": "/synthetic/vault-alpha/a.md"}), Some("/elsewhere"));
        assert_eq!(
            paths(&read),
            vec![("/synthetic/vault-alpha/a.md", Some("/elsewhere"), READ, EXPLICIT_ARGUMENT)]
        );
        let classification = classified(&read);
        assert_eq!(keys(&classification), vec![("alpha-src", READ, EXPLICIT_ARGUMENT, false)]);
        assert_eq!((classification.class, classification.overlapping), ("matched", false));

        for tool in ["Write", "Edit", "MultiEdit"] {
            let evidence =
                claude_evidence(tool, &json!({"file_path": "notes/b.md"}), Some("/synthetic/vault-beta"));
            assert_eq!(
                paths(&evidence),
                vec![("notes/b.md", Some("/synthetic/vault-beta"), WRITE, EXPLICIT_ARGUMENT)]
            );
            assert_eq!(keys(&classified(&evidence)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        }
        let notebook =
            claude_evidence("NotebookEdit", &json!({"notebook_path": "/synthetic/vault-beta/n.ipynb"}), None);
        assert_eq!(keys(&classified(&notebook)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        let notebook =
            claude_evidence("NotebookRead", &json!({"notebook_path": "/synthetic/vault-beta/n.ipynb"}), None);
        assert_eq!(keys(&classified(&notebook)), vec![("beta-src", READ, EXPLICIT_ARGUMENT, false)]);

        // Missing or empty arguments are unsupported forms; a non-object input too.
        assert_eq!(claude_evidence("Read", &json!({}), None), Evidence::Unsupported);
        assert_eq!(claude_evidence("Read", &json!({"file_path": "  "}), None), Evidence::Unsupported);
        assert_eq!(claude_evidence("Read", &json!("text"), None), Evidence::Unsupported);
        assert_eq!(claude_evidence("TodoWrite", &json!(null), None), Evidence::Unsupported);
    }

    #[test]
    fn relative_explicit_paths_resolve_against_cwd_only() {
        let relative = claude_evidence("Read", &json!({"file_path": "a.md"}), None);
        let classification = classified(&relative);
        assert_eq!((classification.class, keys(&classification).len()), ("unresolved", 0));
        let outside =
            claude_evidence("Read", &json!({"file_path": "../vault-alpha/a.md"}), Some("/synthetic/other"));
        assert_eq!(keys(&classified(&outside)), vec![("alpha-src", READ, EXPLICIT_ARGUMENT, false)]);
        let unmatched =
            claude_evidence("Read", &json!({"file_path": "/synthetic/vault-alphabet/a.md"}), None);
        assert_eq!(classified(&unmatched).class, "unmatched");
        // cwd inside a vault does not make an outside path belong to it.
        let elsewhere =
            claude_evidence("Read", &json!({"file_path": "/tmp/x.md"}), Some("/synthetic/vault-alpha"));
        assert_eq!(classified(&elsewhere).class, "unmatched");
    }

    #[test]
    fn nested_roots_match_every_source_and_flag_overlap() {
        let evidence =
            claude_evidence("Read", &json!({"file_path": "/synthetic/vault-alpha/nested/deep.md"}), None);
        let classification = classified(&evidence);
        assert_eq!(
            keys(&classification),
            vec![("alpha-src", READ, EXPLICIT_ARGUMENT, true), ("inner-src", READ, EXPLICIT_ARGUMENT, true)]
        );
        assert!(classification.overlapping);
        assert_eq!(classification.class, "matched");
        let shallow =
            claude_evidence("Read", &json!({"file_path": "/synthetic/vault-alpha/nested.md"}), None);
        let shallow = classified(&shallow);
        assert_eq!(keys(&shallow), vec![("alpha-src", READ, EXPLICIT_ARGUMENT, false)]);
        assert!(!shallow.overlapping);
    }

    #[test]
    fn windows_paths_match_by_form_not_platform() {
        let cases = [
            "C:\\Synthetic\\Vault-Beta\\Note.md",
            "c:/synthetic/vault-beta/note.md",
            "C:\\SYNTHETIC\\VAULT-BETA\\sub\\..\\Note.md",
            "/c/Synthetic/Vault-Beta/Note.md",
            "/mnt/c/synthetic/vault-beta/note.md",
        ];
        for case in cases {
            let evidence = claude_evidence("Read", &json!({"file_path": case}), None);
            assert_eq!(
                keys(&classified(&evidence)),
                vec![("beta-src", READ, EXPLICIT_ARGUMENT, false)],
                "{case}"
            );
        }
        let relative =
            claude_evidence("Edit", &json!({"file_path": "Sub\\Note.md"}), Some("C:\\Synthetic\\Vault-Beta"));
        assert_eq!(keys(&classified(&relative)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        // POSIX roots stay case-sensitive.
        let cased = claude_evidence("Read", &json!({"file_path": "/Synthetic/Vault-Alpha/a.md"}), None);
        assert_eq!(classified(&cased).class, "unmatched");
    }

    #[test]
    fn home_relative_paths_resolve_against_the_pinned_home() {
        let evidence = claude_evidence("Read", &json!({"file_path": "~/notes/today.md"}), None);
        assert_eq!(keys(&classified(&evidence)), vec![("home-src", READ, EXPLICIT_ARGUMENT, false)]);
        let other_user = claude_evidence("Read", &json!({"file_path": "~someone/notes/today.md"}), None);
        assert_eq!(classified(&other_user).class, "unresolved");
        let no_home = ResourceConfiguration::from_local(&[local("home-src", &["/home/u/notes"], &[])], None);
        assert_eq!(classify(&evidence, &no_home).class, "unresolved");
    }

    #[test]
    fn grep_pattern_is_never_a_path_and_glob_uses_its_anchor() {
        let pattern_only = claude_evidence(
            "Grep",
            &json!({"pattern": "/synthetic/vault-alpha/a.md"}),
            Some("/synthetic/vault-alpha"),
        );
        assert_eq!(pattern_only, Evidence::None);
        assert_eq!(classified(&pattern_only).class, "no_evidence");
        let with_path =
            claude_evidence("Grep", &json!({"pattern": "todo", "path": "/synthetic/vault-alpha"}), None);
        assert_eq!(keys(&classified(&with_path)), vec![("alpha-src", SEARCH, EXPLICIT_ARGUMENT, false)]);
        let listing = claude_evidence("LS", &json!({"path": "notes"}), Some("/synthetic/vault-beta"));
        assert_eq!(keys(&classified(&listing)), vec![("beta-src", SEARCH, EXPLICIT_ARGUMENT, false)]);

        let anchored =
            claude_evidence("Glob", &json!({"pattern": "/synthetic/vault-alpha/notes/**/*.md"}), None);
        assert_eq!(paths(&anchored), vec![("/synthetic/vault-alpha/notes", None, SEARCH, EXPLICIT_ARGUMENT)]);
        let partial = claude_evidence("Glob", &json!({"pattern": "/synthetic/vault-alpha/nes*/x.md"}), None);
        assert_eq!(paths(&partial), vec![("/synthetic/vault-alpha", None, SEARCH, EXPLICIT_ARGUMENT)]);
        let literal = claude_evidence("Glob", &json!({"pattern": "C:\\Synthetic\\Vault-Beta\\a.md"}), None);
        assert_eq!(keys(&classified(&literal)), vec![("beta-src", SEARCH, EXPLICIT_ARGUMENT, false)]);
        let relative =
            claude_evidence("Glob", &json!({"pattern": "**/*.md"}), Some("/synthetic/vault-alpha"));
        assert_eq!(relative, Evidence::None);
        let relative_dir =
            claude_evidence("Glob", &json!({"pattern": "notes/*.md"}), Some("/synthetic/vault-alpha"));
        assert_eq!(relative_dir, Evidence::None);
        let with_path =
            claude_evidence("Glob", &json!({"pattern": "*.md", "path": "/synthetic/vault-beta"}), None);
        assert_eq!(keys(&classified(&with_path)), vec![("beta-src", SEARCH, EXPLICIT_ARGUMENT, false)]);
        let root_glob = claude_evidence("Glob", &json!({"pattern": "/*.md"}), None);
        assert_eq!(paths(&root_glob), vec![("/", None, SEARCH, EXPLICIT_ARGUMENT)]);
    }

    #[test]
    fn connectors_match_once_and_are_ambiguous_when_shared() {
        let unique = claude_evidence("mcp__alpha__search_notes", &json!({"query": "x"}), None);
        assert_eq!(unique, Evidence::Connector { id: "mcp:alpha".into(), access_kind: SEARCH });
        assert_eq!(keys(&classified(&unique)), vec![("alpha-src", SEARCH, CONNECTOR, false)]);
        let shared =
            claude_evidence("mcp__shared__read_note", &json!({"path": "/synthetic/vault-alpha/a.md"}), None);
        let classification = classified(&shared);
        assert_eq!((classification.class, keys(&classification).len()), ("ambiguous", 0));
        let unknown = claude_evidence("mcp__other__read", &json!({}), None);
        assert_eq!(classified(&unknown).class, "unmatched");
        assert_eq!(
            claude_evidence("mcp__vault", &json!({}), None),
            Evidence::Connector { id: "mcp:vault".into(), access_kind: UNKNOWN }
        );
        // Opaque script tools are unsupported forms even when they carry an MCP prefix.
        assert_eq!(claude_evidence("mcp__node_repl__js", &json!({"code": "x"}), None), Evidence::Unsupported);
        assert_eq!(claude_evidence("Workflow", &json!({"steps": []}), None), Evidence::Unsupported);
    }

    #[test]
    fn url_connectors_match_by_prefix() {
        let fetched = claude_evidence("WebFetch", &json!({"url": "https://alpha.test/notes/today"}), None);
        assert_eq!(
            fetched,
            Evidence::Connector { id: "url:https://alpha.test/notes/today".into(), access_kind: READ }
        );
        assert_eq!(keys(&classified(&fetched)), vec![("alpha-src", READ, CONNECTOR, false)]);
        let other = claude_evidence("WebFetch", &json!({"url": "https://alpha.test.example/x"}), None);
        assert_eq!(classified(&other).class, "unmatched");
        assert_eq!(claude_evidence("WebFetch", &json!({"prompt": "x"}), None), Evidence::None);
    }

    #[test]
    fn tools_without_path_semantics_are_no_evidence() {
        for tool in [
            "Agent",
            "Task",
            "Skill",
            "TodoWrite",
            "AskUserQuestion",
            "WebSearch",
            "EnterPlanMode",
            "ExitPlanMode",
            "custom_tool",
        ] {
            let evidence = claude_evidence(
                tool,
                &json!({"prompt": "/synthetic/vault-alpha/a.md"}),
                Some("/synthetic/vault-alpha"),
            );
            assert_eq!(evidence, Evidence::None, "{tool}");
        }
        assert_eq!(classified(&Evidence::None).class, "no_evidence");
        assert_eq!(classified(&Evidence::Unsupported).class, "unsupported");
        assert_eq!(classified(&Evidence::Paths(vec![])).class, "no_evidence");
    }

    // --- Shell text ---

    #[test]
    fn shell_verbs_pick_the_access_kind() {
        assert_eq!(
            shell("cat /synthetic/vault-alpha/a.md", None),
            vec![("/synthetic/vault-alpha/a.md".to_owned(), None, READ)]
        );
        assert_eq!(shell("rg -n todo /synthetic/vault-alpha", None)[0].2, SEARCH);
        assert_eq!(shell("rm -f /synthetic/vault-alpha/a.md", None)[0].2, WRITE);
        assert_eq!(shell("git add /synthetic/vault-alpha/a.md", None)[0].2, UNKNOWN);
        assert_eq!(
            shell("sed -i 's/a/b/' /synthetic/vault-alpha/a.md", None),
            vec![("/synthetic/vault-alpha/a.md".to_owned(), None, WRITE)]
        );
        assert_eq!(
            shell("sed -n '1,5p' /synthetic/vault-alpha/a.md", None),
            vec![("/synthetic/vault-alpha/a.md".to_owned(), None, READ)]
        );
        assert_eq!(shell("python /synthetic/vault-alpha/tool.py", None)[0].2, READ);
        assert_eq!(
            shell("echo hi > /synthetic/vault-alpha/out.md", None),
            vec![("/synthetic/vault-alpha/out.md".to_owned(), None, WRITE)]
        );
        assert_eq!(
            shell("cat < /synthetic/vault-alpha/in.md", None),
            vec![("/synthetic/vault-alpha/in.md".to_owned(), None, READ)]
        );
        assert_eq!(
            shell("cmd 2>/dev/null >>/synthetic/vault-alpha/log.md 2>&1", None),
            vec![("/synthetic/vault-alpha/log.md".to_owned(), None, WRITE)]
        );
        let evidence = claude_evidence("Bash", &json!({"command": "cat /synthetic/vault-alpha/a.md"}), None);
        assert_eq!(paths(&evidence), vec![("/synthetic/vault-alpha/a.md", None, READ, INDIRECT_SHELL)]);
        assert_eq!(keys(&classified(&evidence)), vec![("alpha-src", READ, INDIRECT_SHELL, false)]);
        assert_eq!(claude_evidence("Bash", &json!({"timeout": 1}), None), Evidence::Unsupported);
    }

    #[test]
    fn bare_names_count_only_as_file_command_operands_on_one_line() {
        let base = Some("/synthetic/vault-alpha");
        assert_eq!(shell("cat note.md", base), vec![("note.md".to_owned(), base.map(str::to_owned), READ)]);
        assert_eq!(shell("head -n 20 notes/daily.md", base).len(), 1);
        assert_eq!(
            shell("Get-Content 'PRIVATE SENTINEL note.md'", base),
            vec![("PRIVATE SENTINEL note.md".to_owned(), base.map(str::to_owned), READ)]
        );
        assert_eq!(shell("echo note.md", base), vec![]);
        assert_eq!(shell("git add note.md", base), vec![]);
        assert_eq!(shell("cat *.md", base), vec![]);
        assert_eq!(shell("cat 1.5", base), vec![]);
        assert_eq!(shell("cat notes/", base), vec![]);
        assert_eq!(shell("cat .", base), vec![]);
        assert_eq!(
            shell("cat ./note.md", base),
            vec![("./note.md".to_owned(), base.map(str::to_owned), READ)]
        );
        assert_eq!(shell("cat ../vault-beta/b.md", base).len(), 1);
        assert_eq!(shell("cat .\\note.md", base).len(), 1);
        assert_eq!(shell("cat ../", base), vec![]);
        // Patterns of search verbs are skipped; their file operands count.
        assert_eq!(shell("rg foo.md", base), vec![]);
        assert_eq!(
            shell("rg foo notes/a.md", base),
            vec![("notes/a.md".to_owned(), base.map(str::to_owned), SEARCH)]
        );
        assert_eq!(
            shell("grep -e foo.md a.md", base),
            vec![("a.md".to_owned(), base.map(str::to_owned), SEARCH)]
        );
        assert_eq!(shell("grep -A 3 foo a.md", base).len(), 1);
        assert_eq!(
            shell("jq '.a.b' data.json", base),
            vec![("data.json".to_owned(), base.map(str::to_owned), READ)]
        );
        assert_eq!(
            shell("Select-String -Pattern foo.md -Path a.md", base),
            vec![("a.md".to_owned(), base.map(str::to_owned), SEARCH)]
        );
        // A multi-line command is a script body: bare names never resolve, absolute ones still do.
        assert_eq!(shell("cd /tmp\ncat note.md", base), vec![]);
        assert_eq!(shell("echo start\ncat /synthetic/vault-alpha/note.md", base).len(), 1);
        // Line continuations keep a command single-line.
        assert_eq!(shell("cat \\\n  note.md", base).len(), 1);
    }

    #[test]
    fn heredocs_and_here_strings_are_not_evidence() {
        let base = Some("/synthetic/vault-alpha");
        let heredoc = "cat <<'EOF'\nsee note.md and other.txt in /synthetic/vault-alpha/x.md\nEOF";
        assert_eq!(shell(heredoc, base), vec![]);
        assert_eq!(claude_evidence("Bash", &json!({"command": heredoc}), base), Evidence::None);
        // The body is stripped; the redirect target on the command line still counts.
        let redirected = "cat <<EOF > out.md\nbody note.md\nEOF\n";
        assert_eq!(shell(redirected, base), vec![("out.md".to_owned(), base.map(str::to_owned), WRITE)]);
        let body_only = "cat <<EOF\nbody note.md\nEOF\n";
        assert_eq!(shell(body_only, base), vec![]);
        let redirected_abs = "cat <<EOF > /synthetic/vault-alpha/out.md\nbody note.md\nEOF\n";
        assert_eq!(
            shell(redirected_abs, base),
            vec![("/synthetic/vault-alpha/out.md".to_owned(), base.map(str::to_owned), WRITE)]
        );
        let dashed =
            "python - <<-PY\n\tprint('/synthetic/vault-alpha/a.md')\n\tPY\ncat /synthetic/vault-beta/b.md";
        assert_eq!(
            shell(dashed, base),
            vec![("/synthetic/vault-beta/b.md".to_owned(), base.map(str::to_owned), READ)]
        );
        let here_string = "@'\nGet-Content note.md\n'@ | python -\nGet-Content /synthetic/vault-beta/b.md";
        assert_eq!(
            shell(here_string, base),
            vec![("/synthetic/vault-beta/b.md".to_owned(), base.map(str::to_owned), READ)]
        );
        let bash_here_string = "cat <<< 'note.md'";
        assert_eq!(shell(bash_here_string, base), vec![]);
    }

    #[test]
    fn opaque_script_bodies_are_unsupported_only_when_they_mention_paths() {
        let base = Some("/synthetic/vault-alpha");
        let python = claude_evidence(
            "Bash",
            &json!({"command": "python -c \"open('/synthetic/vault-alpha/a.md').read()\""}),
            base,
        );
        assert_eq!(python, Evidence::Unsupported);
        let python_named = claude_evidence("Bash", &json!({"command": "python3 -c \"open('a.md')\""}), base);
        assert_eq!(python_named, Evidence::Unsupported);
        let node = claude_evidence("Bash", &json!({"command": "node -e 'console.log(1)'"}), base);
        assert_eq!(node, Evidence::None);
        // Shell wrappers are followed; their single-line bodies resolve.
        let wrapped = claude_evidence("Bash", &json!({"command": "bash -lc 'cat note.md'"}), base);
        assert_eq!(paths(&wrapped), vec![("note.md", base, READ, INDIRECT_SHELL)]);
        let pwsh = claude_evidence(
            "PowerShell",
            &json!({"command": "pwsh -Command \"Get-Content -Raw 'C:\\Synthetic\\Vault-Beta\\a.md'\""}),
            None,
        );
        assert_eq!(keys(&classified(&pwsh)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        let empty_wrapper = claude_evidence("Bash", &json!({"command": "bash -c 'git status'"}), base);
        assert_eq!(empty_wrapper, Evidence::None);
        let encoded = claude_evidence(
            "PowerShell",
            &json!({"command": "powershell -EncodedCommand ZQBjAGgAbwA="}),
            base,
        );
        assert_eq!(encoded, Evidence::Unsupported);
        // Candidates elsewhere in the command win over an opaque part.
        let mixed = claude_evidence(
            "Bash",
            &json!({"command": "python -c \"open('x.md')\" && cat /synthetic/vault-beta/b.md"}),
            base,
        );
        assert_eq!(keys(&classified(&mixed)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
    }

    #[test]
    fn cd_chains_move_the_base_and_never_count_themselves() {
        let base = Some("/elsewhere");
        assert_eq!(
            shell("cd /synthetic/vault-alpha && cat note.md", base),
            vec![("note.md".to_owned(), Some("/synthetic/vault-alpha".to_owned()), READ)]
        );
        assert_eq!(shell("cd /synthetic/vault-alpha", base), vec![]);
        assert_eq!(
            shell("cd notes && cat note.md", Some("/synthetic/vault-alpha")),
            vec![("note.md".to_owned(), None, READ)]
        );
        assert_eq!(
            classified(&shell_evidence("cd notes && cat note.md", Some("/synthetic/vault-alpha"))).class,
            "unresolved"
        );
        assert_eq!(
            shell("cd ~/notes; cat today.md", base),
            vec![("today.md".to_owned(), Some("~/notes".to_owned()), READ)]
        );
        assert_eq!(
            keys(&classified(&shell_evidence("cd ~/notes; cat today.md", base))),
            vec![("home-src", READ, INDIRECT_SHELL, false)]
        );
        assert_eq!(shell("cd ~other/notes; cat today.md", base), vec![("today.md".to_owned(), None, READ)]);
        assert_eq!(shell("cd $HOME/notes; cat today.md", base), vec![("today.md".to_owned(), None, READ)]);
        assert_eq!(
            shell("cd; cat today.md", base),
            vec![("today.md".to_owned(), Some("~".to_owned()), READ)]
        );
        assert_eq!(
            shell("pushd /synthetic/vault-beta; cat b.md; popd; cat c.md", base),
            vec![
                ("b.md".to_owned(), Some("/synthetic/vault-beta".to_owned()), READ),
                ("c.md".to_owned(), None, READ)
            ]
        );
        assert_eq!(
            shell("Set-Location -Path C:\\Synthetic\\Vault-Beta; Get-Content b.md", base),
            vec![("b.md".to_owned(), Some("C:\\Synthetic\\Vault-Beta".to_owned()), READ)]
        );
        assert_eq!(
            shell("(cd /synthetic/vault-beta && cat b.md); cat c.md", base),
            vec![
                ("b.md".to_owned(), Some("/synthetic/vault-beta".to_owned()), READ),
                ("c.md".to_owned(), Some("/elsewhere".to_owned()), READ)
            ]
        );
        assert_eq!(
            shell("echo $(cat /synthetic/vault-beta/b.md)", base),
            vec![("/synthetic/vault-beta/b.md".to_owned(), base.map(str::to_owned), READ)]
        );
        // Relative candidates with no base at all stay unresolved.
        assert_eq!(classified(&shell_evidence("cat note.md", None)).class, "unresolved");
    }

    #[test]
    fn powershell_forms_keep_backslashes_and_assignments_aside() {
        let base = Some("C:\\Work");
        let unquoted = shell("Get-Content -Raw C:\\Synthetic\\Vault-Beta\\Note.md", base);
        assert_eq!(
            unquoted,
            vec![("C:\\Synthetic\\Vault-Beta\\Note.md".to_owned(), base.map(str::to_owned), READ)]
        );
        assert_eq!(
            keys(&classified(&shell_evidence("Get-Content -Raw C:\\Synthetic\\Vault-Beta\\Note.md", base))),
            vec![("beta-src", READ, INDIRECT_SHELL, false)]
        );
        assert_eq!(shell("$r = Get-Content -LiteralPath 'C:\\Synthetic\\Vault-Beta\\a.md'", base).len(), 1);
        assert_eq!(shell("$r=Get-ChildItem C:\\Synthetic\\Vault-Beta -Recurse", base)[0].2, SEARCH);
        assert_eq!(shell("$x = 5", base), vec![]);
        assert_eq!(
            shell("& 'C:\\Tools\\run.exe' C:\\Synthetic\\Vault-Beta\\a.md", base),
            vec![("C:\\Synthetic\\Vault-Beta\\a.md".to_owned(), base.map(str::to_owned), UNKNOWN)]
        );
        assert_eq!(
            shell("Set-Content -Path ..\\Vault-Beta\\b.md -Value x", Some("C:\\Synthetic\\Other")),
            vec![("..\\Vault-Beta\\b.md".to_owned(), Some("C:\\Synthetic\\Other".to_owned()), WRITE)]
        );
        assert_eq!(
            keys(&classified(&shell_evidence(
                "Set-Content -Path ..\\Vault-Beta\\b.md -Value x",
                Some("C:\\Synthetic\\Other")
            ))),
            vec![("beta-src", WRITE, INDIRECT_SHELL, false)]
        );
        assert_eq!(
            shell("Out-File -FilePath C:\\Synthetic\\Vault-Beta\\o.md -Encoding utf8", base)[0].2,
            WRITE
        );
        assert_eq!(shell("Get-Content \"C:\\Synthetic\\Vault-Beta\\q.md\"", base).len(), 1);
        assert_eq!(
            shell("Get-ChildItem \\\\server\\share\\Vault", base),
            vec![("\\\\server\\share\\Vault".to_owned(), base.map(str::to_owned), SEARCH)]
        );
        assert_eq!(
            shell("Get-Content $env:USERPROFILE\\notes\\a.md", base),
            vec![("$env:USERPROFILE\\notes\\a.md".to_owned(), base.map(str::to_owned), READ)]
        );
        assert_eq!(
            classified(&shell_evidence("Get-Content $env:USERPROFILE\\notes\\a.md", base)).class,
            "unresolved"
        );
        assert_eq!(shell("Write-Output x > $null", base), vec![]);
        assert_eq!(shell("cat /synthetic/vault-alpha/a.md | Select-String todo", None).len(), 1);
    }

    #[test]
    fn wrappers_and_quoting_are_transparent() {
        assert_eq!(shell("sudo -u me cat /synthetic/vault-alpha/a.md", None).len(), 1);
        assert_eq!(shell("FOO=1 env BAR=2 cat /synthetic/vault-alpha/a.md", None).len(), 1);
        assert_eq!(
            shell("time cat \"/synthetic/vault-alpha/with space.md\"", None),
            vec![("/synthetic/vault-alpha/with space.md".to_owned(), None, READ)]
        );
        assert_eq!(
            shell("cat /synthetic/vault-alpha/with\\ space.md", None),
            vec![("/synthetic/vault-alpha/with space.md".to_owned(), None, READ)]
        );
        assert_eq!(
            shell("cat '/synthetic/vault-alpha/it''s.md'", None),
            vec![("/synthetic/vault-alpha/it's.md".to_owned(), None, READ)]
        );
        assert_eq!(shell("cat /synthetic/vault-alpha/a.md # /synthetic/vault-beta/b.md", None).len(), 1);
        assert_eq!(shell("cat https://example.test/a.md", None), vec![]);
        assert_eq!(shell("curl -o out.md https://example.test/a.md", None), vec![]);
        assert_eq!(shell("cat --file=/synthetic/vault-alpha/a.md", None).len(), 1);
        assert_eq!(
            shell("find /synthetic/vault-alpha -name '*.md' -exec cat {} \\;", None),
            vec![("/synthetic/vault-alpha".to_owned(), None, SEARCH)]
        );
        assert_eq!(shell("ls /synthetic/vault-alpha || cat /synthetic/vault-beta/b.md &", None).len(), 2);
        assert_eq!(shell("", None), vec![]);
        assert_eq!(shell("   ", None), vec![]);
    }

    #[test]
    fn shell_matches_collapse_per_resource_by_precedence() {
        let command = "ls /synthetic/vault-alpha && cat /synthetic/vault-alpha/a.md && echo x > /synthetic/vault-alpha/b.md";
        let classification = classified(&shell_evidence(command, None));
        assert_eq!(keys(&classification), vec![("alpha-src", WRITE, INDIRECT_SHELL, false)]);
        let mixed = Evidence::Paths(vec![
            shell_candidate("/synthetic/vault-alpha/a.md", &None, SEARCH),
            explicit_candidate("/synthetic/vault-alpha/b.md", READ, None),
            shell_candidate("/synthetic/vault-beta/b.md", &None, UNKNOWN),
        ]);
        assert_eq!(
            keys(&classified(&mixed)),
            vec![("alpha-src", READ, EXPLICIT_ARGUMENT, false), ("beta-src", UNKNOWN, INDIRECT_SHELL, false)]
        );
        let partly_unresolved = Evidence::Paths(vec![
            shell_candidate("note.md", &None, READ),
            shell_candidate("/synthetic/vault-beta/b.md", &None, READ),
        ]);
        assert_eq!(classified(&partly_unresolved).class, "matched");
        let unresolved_and_unmatched = Evidence::Paths(vec![
            shell_candidate("note.md", &None, READ),
            shell_candidate("/tmp/b.md", &None, READ),
        ]);
        assert_eq!(classified(&unresolved_and_unmatched).class, "unresolved");
    }

    // --- Codex ---

    #[test]
    fn codex_shell_function_calls_use_workdir_then_session_cwd() {
        let payload = json!({"arguments": "{\"command\":\"cat note.md\",\"workdir\":\"/synthetic/vault-alpha\",\"timeout_ms\":1000}"});
        let evidence =
            codex_evidence("function_call", Some("shell_command"), None, &payload, Some("/elsewhere"));
        assert_eq!(paths(&evidence), vec![("note.md", Some("/synthetic/vault-alpha"), READ, INDIRECT_SHELL)]);
        assert_eq!(keys(&classified(&evidence)), vec![("alpha-src", READ, INDIRECT_SHELL, false)]);
        let no_workdir = json!({"arguments": "{\"cmd\":\"cat note.md\"}"});
        let evidence = codex_evidence(
            "function_call",
            Some("exec_command"),
            None,
            &no_workdir,
            Some("/synthetic/vault-beta"),
        );
        assert_eq!(paths(&evidence), vec![("note.md", Some("/synthetic/vault-beta"), READ, INDIRECT_SHELL)]);
        let array = json!({"arguments": {"command": ["bash", "-lc", "cat /synthetic/vault-beta/b.md"]}});
        let evidence = codex_evidence("function_call", Some("shell"), None, &array, None);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        // workdir alone is context, never evidence.
        let context_only =
            json!({"arguments": "{\"command\":\"git status\",\"workdir\":\"/synthetic/vault-alpha\"}"});
        let evidence = codex_evidence("function_call", Some("shell_command"), None, &context_only, None);
        assert_eq!(evidence, Evidence::None);
        assert_eq!(
            codex_evidence(
                "function_call",
                Some("shell_command"),
                None,
                &json!({"arguments": "not json"}),
                None
            ),
            Evidence::Unsupported
        );
        assert_eq!(
            codex_evidence("function_call", Some("shell_command"), None, &json!({"arguments": "{}"}), None),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("function_call", Some("shell_command"), None, &json!({}), None),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("function_call", Some("shell_command"), None, &json!({"arguments": 5}), None),
            Evidence::Unsupported
        );
    }

    #[test]
    fn codex_explicit_forms_view_image_and_apply_patch() {
        let image = codex_evidence(
            "function_call",
            Some("view_image"),
            None,
            &json!({"arguments": "{\"path\":\"/synthetic/vault-alpha/img.png\"}"}),
            None,
        );
        assert_eq!(paths(&image), vec![("/synthetic/vault-alpha/img.png", None, READ, EXPLICIT_ARGUMENT)]);
        assert_eq!(
            codex_evidence("function_call", Some("view_image"), None, &json!({"arguments": "{}"}), None),
            Evidence::None
        );
        let patch = "*** Begin Patch\n*** Update File: /synthetic/vault-alpha/a.md\n@@\n-x\n+y\n*** Add File: notes/new.md\n+hello\n*** Delete File: /synthetic/vault-beta/old.md\n*** Move to: /tmp/moved.md\n*** End Patch";
        let evidence = codex_evidence(
            "custom_tool_call",
            Some("apply_patch"),
            None,
            &json!({"input": patch}),
            Some("/synthetic/vault-beta"),
        );
        assert_eq!(
            paths(&evidence),
            vec![
                ("/synthetic/vault-alpha/a.md", Some("/synthetic/vault-beta"), WRITE, EXPLICIT_ARGUMENT),
                ("notes/new.md", Some("/synthetic/vault-beta"), WRITE, EXPLICIT_ARGUMENT),
                ("/synthetic/vault-beta/old.md", Some("/synthetic/vault-beta"), WRITE, EXPLICIT_ARGUMENT),
                ("/tmp/moved.md", Some("/synthetic/vault-beta"), WRITE, EXPLICIT_ARGUMENT),
            ]
        );
        assert_eq!(
            keys(&classified(&evidence)),
            vec![
                ("alpha-src", WRITE, EXPLICIT_ARGUMENT, false),
                ("beta-src", WRITE, EXPLICIT_ARGUMENT, false)
            ]
        );
        let as_function = codex_evidence(
            "function_call",
            Some("apply_patch"),
            None,
            &json!({"arguments": {"input": patch}}),
            None,
        );
        assert_eq!(paths(&as_function).len(), 4);
        assert_eq!(
            codex_evidence(
                "custom_tool_call",
                Some("apply_patch"),
                None,
                &json!({"input": "no headers"}),
                None
            ),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("custom_tool_call", Some("apply_patch"), None, &json!({"input": {"x": 1}}), None),
            Evidence::Unsupported
        );
    }

    #[test]
    fn codex_exec_scripts_are_parsed_for_tools_calls_only() {
        let cwd = Some("/synthetic/vault-alpha");
        let script = "const r = await tools.shell_command({\"command\":\"Get-Content -Raw -LiteralPath 'C:\\\\Synthetic\\\\Vault-Beta\\\\a.md'\",\"workdir\":\"C:\\\\Work\",\"timeout_ms\":10000}); text(r)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(
            paths(&evidence),
            vec![("C:\\Synthetic\\Vault-Beta\\a.md", Some("C:\\Work"), READ, INDIRECT_SHELL)]
        );
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);

        // Unquoted keys, multi-line object, single-quoted values; workdir is the base.
        let script = "const r = await tools.exec_command({\n  cmd: 'cat note.md',\n  workdir: \"/synthetic/vault-beta\",\n  shell: 'bash'\n});\ntext(r.stdout);";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(paths(&evidence), vec![("note.md", Some("/synthetic/vault-beta"), READ, INDIRECT_SHELL)]);

        // Session cwd is the fallback base; a workdir inside a vault plus `git status` is nothing.
        let script = "text(await tools.exec_command({cmd:\"cat note.md\"}))";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(paths(&evidence), vec![("note.md", cwd, READ, INDIRECT_SHELL)]);
        let script = "const r = await tools.shell_command({command:\"git status\", workdir:\"/synthetic/vault-alpha\"}); text(r)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(evidence, Evidence::None);
        assert_eq!(classified(&evidence).class, "no_evidence");

        // apply_patch through a bound identifier or a direct literal is an explicit write.
        let script = "const patch = \"*** Begin Patch\\n*** Update File: C:\\\\Synthetic\\\\Vault-Beta\\\\a.md\\n@@\\n-x\\n+y\\n*** End Patch\";\nconst a = await tools.apply_patch(patch);\ntext(a)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(
            paths(&evidence),
            vec![("C:\\Synthetic\\Vault-Beta\\a.md", cwd, WRITE, EXPLICIT_ARGUMENT)]
        );
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        let script =
            "text(await tools.apply_patch(\"*** Begin Patch\\n*** Add File: new.md\\n+x\\n*** End Patch\"))";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("alpha-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        let script = "const patch = `*** Begin Patch\n*** Add File: /synthetic/vault-beta/t.md\n+x\n*** End Patch`;\nawait tools.apply_patch(patch)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        let script = "const patch = buildPatch();\nawait tools.apply_patch(patch)";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        let script = "let patch = '*** Begin Patch\\n*** Delete File: /synthetic/vault-beta/d.md\\n*** End Patch';\nawait tools.apply_patch(patch)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", WRITE, EXPLICIT_ARGUMENT, false)]);
        // Only a real declaration binds; a mention inside a string or a lookalike word does not.
        let script = "myconst patch = '*** Begin Patch\\n*** Add File: /synthetic/vault-beta/d.md\\n*** End Patch';\nawait tools.apply_patch(patch)";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        let script = "const note = 'const patch = 1';\nawait tools.apply_patch(patch)";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );

        // view_image is an explicit read.
        let script = "const r = await tools.view_image({path:\"C:\\\\Synthetic\\\\Vault-Beta\\\\img.png\"}); image(r.data)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", READ, EXPLICIT_ARGUMENT, false)]);
        let script =
            "const paths = [\"C:\\\\x.png\"];\nfor (const path of paths) { await tools.view_image({path}); }";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );

        // Shorthand `{cmd}` bound to a literal; a command array; a `+` chain.
        let script =
            "const cmd = 'cat ' + '/synthetic/vault-beta/b.md';\nconst r = await tools.exec_command({cmd});";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        let script =
            "await tools.shell_command({command: ['bash', '-lc', 'cat /synthetic/vault-beta/b.md']})";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(keys(&classified(&evidence)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        let script = "const r = await tools.shell_command({command: buildCommand()})";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );

        // The workdir literal is never a candidate even when a vault path.
        let script =
            "const r = await tools.shell_command({command:\"ls\", workdir:\"/synthetic/vault-beta\"})";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::None
        );

        // No recognized call: opaque when path-like literals appear, else nothing.
        let script =
            "const r = await tools.web__run({search_query:[{q:\"site:x.example/forum notes\"}]}); text(r)";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::None
        );
        let script =
            "const r = await tools.image_gen__imagegen({paths:[\"C:\\\\Synthetic\\\\Vault-Beta\\\\a.png\"]})";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        let script = "const r = await tools.mcp__node_repl__js({title:'t', code:'1+1'}); text(r)";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        let script = "const fs = require('fs'); fs.readFileSync('/synthetic/vault-alpha/a.md')";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        assert_eq!(
            codex_evidence(
                "custom_tool_call",
                Some("exec"),
                None,
                &json!({"input": "wrapper contains nested-looking function_call text"}),
                cwd
            ),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": 5}), cwd),
            Evidence::Unsupported
        );
        assert_eq!(codex_evidence("custom_tool_call", Some("exec"), None, &json!({}), cwd), Evidence::None);

        // MCP calls inside a script are connector evidence for one namespace.
        let script = "const r = await tools.mcp__alpha__search_notes({query:'x'}); text(r)";
        let evidence = codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd);
        assert_eq!(evidence, Evidence::Connector { id: "mcp:alpha".into(), access_kind: SEARCH });
        let script =
            "await tools.mcp__alpha__search_notes({q:'x'}); await tools.mcp__shared__read_note({n:'y'})";
        assert_eq!(
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), cwd),
            Evidence::Unsupported
        );
        // A comment header and a comment mentioning tools are skipped.
        let script = "// @exec: {\"timeout_ms\": 2000}\n/* tools.shell_command({command:'cat /synthetic/vault-beta/b.md'}) */\nconst r = await tools.shell_command({command:'cat /synthetic/vault-alpha/a.md'});";
        let evidence =
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), None);
        assert_eq!(keys(&classified(&evidence)), vec![("alpha-src", READ, INDIRECT_SHELL, false)]);
    }

    #[test]
    fn codex_local_shell_mcp_and_other_kinds() {
        let action = json!({"action": {"type": "exec", "command": ["cat", "note.md"], "working_directory": "/synthetic/vault-beta"}});
        let evidence = codex_evidence("local_shell_call", None, None, &action, Some("/elsewhere"));
        assert_eq!(paths(&evidence), vec![("note.md", Some("/synthetic/vault-beta"), READ, INDIRECT_SHELL)]);
        assert_eq!(
            codex_evidence("local_shell_call", None, None, &json!({"action": {"type": "exec"}}), None),
            Evidence::None
        );
        assert_eq!(codex_evidence("local_shell_call", None, None, &json!({}), None), Evidence::None);
        assert_eq!(
            codex_evidence("local_shell_call", None, None, &json!({"action": {"command": 5}}), None),
            Evidence::Unsupported
        );

        let mcp = codex_evidence(
            "function_call",
            Some("search"),
            Some("mcp__alpha"),
            &json!({"arguments": "{\"query\":\"x\"}"}),
            None,
        );
        assert_eq!(mcp, Evidence::Connector { id: "mcp:alpha".into(), access_kind: SEARCH });
        let mcp = codex_evidence("mcp_tool_call", Some("read_note"), Some("shared"), &json!({}), None);
        assert_eq!(mcp, Evidence::Connector { id: "mcp:shared".into(), access_kind: READ });
        assert_eq!(classified(&mcp).class, "ambiguous");
        let via_server = codex_evidence(
            "mcp_tool_call",
            Some("delete_note"),
            None,
            &json!({"server": "mcp__alpha"}),
            None,
        );
        assert_eq!(via_server, Evidence::Connector { id: "mcp:alpha".into(), access_kind: WRITE });
        assert_eq!(codex_evidence("mcp_tool_call", Some("x"), None, &json!({}), None), Evidence::None);
        assert_eq!(
            codex_evidence("function_call", Some("js"), Some("mcp__node_repl"), &json!({}), None),
            Evidence::Unsupported
        );

        assert_eq!(
            codex_evidence(
                "web_search_call",
                None,
                None,
                &json!({"action": {"query": "/synthetic/vault-alpha"}}),
                None
            ),
            Evidence::None
        );
        assert_eq!(
            codex_evidence(
                "function_call",
                Some("update_plan"),
                None,
                &json!({"arguments": "{\"plan\":[]}"}),
                None
            ),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("function_call", Some("wait_agent"), Some("collaboration"), &json!({}), None),
            Evidence::None
        );
        assert_eq!(
            codex_evidence("future_tool_call", Some("future_tool"), None, &json!({}), None),
            Evidence::None
        );
        assert_eq!(
            codex_evidence(
                "custom_tool_call",
                Some("private_tool"),
                None,
                &json!({"input": "/synthetic/vault-alpha/a.md"}),
                None
            ),
            Evidence::None
        );
        let view = codex_evidence(
            "custom_tool_call",
            Some("view_image"),
            None,
            &json!({"input": "{\"path\":\"/synthetic/vault-alpha/i.png\"}"}),
            None,
        );
        assert_eq!(keys(&classified(&view)), vec![("alpha-src", READ, EXPLICIT_ARGUMENT, false)]);
    }

    #[test]
    fn two_resources_in_one_invocation_each_match_once() {
        let command =
            "cat /synthetic/vault-alpha/a.md /synthetic/vault-beta/b.md /synthetic/vault-alpha/c.md";
        let classification = classified(&shell_evidence(command, None));
        assert_eq!(
            keys(&classification),
            vec![("alpha-src", READ, INDIRECT_SHELL, false), ("beta-src", READ, INDIRECT_SHELL, false)]
        );
        assert!(!classification.overlapping);
        let nested = "cp /synthetic/vault-alpha/nested/x.md /synthetic/vault-beta/x.md";
        let classification = classified(&shell_evidence(nested, None));
        assert_eq!(
            keys(&classification),
            vec![
                ("alpha-src", WRITE, INDIRECT_SHELL, true),
                ("beta-src", WRITE, INDIRECT_SHELL, false),
                ("inner-src", WRITE, INDIRECT_SHELL, true)
            ]
        );
        assert!(classification.overlapping);
        let empty = ResourceConfiguration::default();
        let classification = classify(&shell_evidence(command, None), &empty);
        assert_eq!((classification.class, classification.matches.len()), ("unmatched", 0));
    }

    #[test]
    fn review_fixes_hold_for_real_shell_forms() {
        let base = Some("/synthetic/vault-alpha");
        // argv with a quoted script survives the round trip through the lexer.
        let argv = json!({"command": ["bash", "-lc", "cat 'PRIVATE note.md' && echo \"it's\""], "workdir": "/synthetic/vault-alpha"});
        let evidence = codex_evidence(
            "function_call",
            Some("shell_command"),
            None,
            &json!({"arguments": argv.to_string()}),
            None,
        );
        assert_eq!(keys(&classified(&evidence)), vec![("alpha-src", READ, INDIRECT_SHELL, false)]);
        // A computed `workdir` in an exec script is unknown context, never the turn's cwd.
        let script = "const dir = await pickDir();\nconst r = await tools.shell_command({command: \"cat note.md\", workdir: dir}); text(r)";
        let evidence =
            codex_evidence("custom_tool_call", Some("exec"), None, &json!({"input": script}), base);
        let classification = classified(&evidence);
        assert_eq!((classification.class, classification.matches.len()), ("unresolved", 0));
        // `bash -e` is errexit, not an encoded command; the script operand is a read.
        let errexit = claude_evidence("Bash", &json!({"command": "bash -e run.sh"}), base);
        assert_eq!(paths(&errexit), vec![("run.sh", base, READ, INDIRECT_SHELL)]);
        // Push-Location moves the base and is never an access; Pop-Location loses it.
        let pushed = shell("Push-Location /synthetic/vault-beta; Get-Content a.md", None);
        assert_eq!(pushed, vec![("a.md".to_owned(), Some("/synthetic/vault-beta".to_owned()), READ)]);
        let popped = shell("Push-Location /synthetic/vault-beta; Pop-Location; Get-Content a.md", None);
        assert_eq!(popped, vec![("a.md".to_owned(), None, READ)]);
        // `rg --files <dir>` has no pattern operand.
        let listed = shell("rg --files /synthetic/vault-beta", None);
        assert_eq!(listed, vec![("/synthetic/vault-beta".to_owned(), None, SEARCH)]);
        let matched = shell("rg todo /synthetic/vault-beta", None);
        assert_eq!(matched, vec![("/synthetic/vault-beta".to_owned(), None, SEARCH)]);
        // PowerShell `-Command` takes the rest of the line, quoted or not.
        let unquoted = claude_evidence(
            "PowerShell",
            &json!({"command": "powershell -Command Get-Content C:\\Synthetic\\Vault-Beta\\a.md"}),
            None,
        );
        assert_eq!(keys(&classified(&unquoted)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        // `<<` inside a quoted script body is not a heredoc.
        let shifted = claude_evidence(
            "Bash",
            &json!({"command": "python -c \"print(1 << 3)\"\ncat /synthetic/vault-beta/after.md"}),
            None,
        );
        assert_eq!(keys(&classified(&shifted)), vec![("beta-src", READ, INDIRECT_SHELL, false)]);
        // A REPL `js` tool under any MCP server is opaque, not a connector call.
        assert_eq!(claude_evidence("mcp__cua_repl__js", &json!({"code": "1"}), None), Evidence::Unsupported);
        assert_eq!(
            codex_evidence(
                "function_call",
                Some("js"),
                Some("mcp__cua_repl"),
                &json!({"arguments": "{}"}),
                None
            ),
            Evidence::Unsupported
        );
        assert!(matches!(
            claude_evidence("mcp__alpha__search_notes", &json!({}), None),
            Evidence::Connector { .. }
        ));
    }
}
