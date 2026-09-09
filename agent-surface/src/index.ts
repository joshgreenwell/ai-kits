/** Public API of agent-surface. The CLI in `cli.ts` is built on these exports. */

export { canonicalJson, canonicalize } from "./canonical.js";
export {
  discover,
  LOCAL_TRACKED_NOTE,
  LOCAL_UNTRACKED_NOTE,
  SUPPORTED_FILES,
  type DiscoverDeps,
  type Discovery,
  type Document,
  type FileRole,
  type SupportedFile,
} from "./discover.js";
export {
  defaultFs,
  defaultSpawner,
  GIT_MAX_BUFFER,
  GIT_SUBCOMMANDS,
  GitInvocationRefused,
  isTrackedInWorktree,
  readBlobAtRef,
  readWorktreeFile,
  resolveRef,
  resolveSide,
  runGit,
  type FileRead,
  type FsAdapter,
  type RefResolution,
  type ResolveDeps,
  type Side,
  type SideResolution,
  type SpawnOptions,
  type SpawnResult,
  type Spawner,
  type TrackedResult,
} from "./git.js";
export {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_DEPTH,
  escapePointerToken,
  parseJsonc,
  type JsoncOptions,
  type JsoncResult,
  type Position,
} from "./jsonc.js";
export {
  compareEntries,
  EXTRACTED_ROLES,
  extractEntries,
  HELPER_KEYS,
  MCP_TRANSPORTS,
  MODE_KEYS,
  PERMISSION_LISTS,
  PLUGIN_FLAG_KEYS,
  PLUGINS_ENABLED_NOTE,
  semanticEntry,
  sha256Hex,
  sortEntries,
  type Extraction,
  type SemanticEntry,
} from "./entries.js";
export { normalizeRule, normalizeSpec, type ParsedRule } from "./normalize.js";
export {
  CREDENTIAL_PRESENT,
  looksLikeCredential,
  REDACTED,
  redactString,
  redactTree,
  SENSITIVE_KEY,
  type CredentialFinding,
  type RedactedString,
  type RedactedTree,
} from "./redact.js";
export { BASE_ASSUMPTIONS, takeSnapshot, type SnapshotResult } from "./snapshot.js";
export { loadSnapshotFile, schemaVersionMismatch, validateSnapshotShape, type SnapshotLoad } from "./snapshotfile.js";
export {
  ENTRY_KINDS,
  SCHEMA_VERSION,
  SEMANTICS_DOC_DATE,
  type Breadth,
  type Direction,
  type Entry,
  type EntryKind,
  type Incomplete,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type Snapshot,
  type SnapshotOrigin,
  type Source,
  type SourceOrigin,
  type SourceStatus,
  type Tier,
} from "./types.js";
export { VERSION } from "./version.js";
