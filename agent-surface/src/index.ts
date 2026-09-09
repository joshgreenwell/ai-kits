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
export { CATEGORIES, CATEGORY_META, DEFAULT_FAILING_CATEGORIES, PROJECTED_PSEUDO_CATEGORY, type Category, type CategoryMeta } from "./categories.js";
export { allDeltas, categorize, diffSnapshots } from "./diff.js";
export { changedFields, classifyDirection, DIRECTION_RULES, findDirectionRule, type DirectionResult, type DirectionRule } from "./direction.js";
export { explain, explainEntries, explainIds, renderExplain, renderInterpretationsDoc, type ExplainEntry, type ExplainKind } from "./explain.js";
export {
  applyInterpretations,
  detectNotInterpreted,
  findInterpretation,
  findNotInterpreted,
  FLAG_META,
  FLAGS,
  INTERPRETATIONS,
  INTERPRETATIONS_DATE,
  NOT_INTERPRETED,
  OUTSIDE_LIST_NOTE,
  TIER_ORDER,
  weakerTier,
  type Classification,
  type Flag,
  type Interpretation,
  type InterpretationMeta,
  type NotInterpreted,
} from "./interpretations/index.js";
export {
  computeVerdict,
  DEFAULT_VERDICT_OPTIONS,
  FAIL_ON_NAMES,
  isProjectedWidening,
  isUndecided,
  parseFailOnList,
  resolveFailOn,
  type Verdict,
  type VerdictOptions,
} from "./verdict.js";
export { loadSnapshotFile, schemaVersionMismatch, validateSnapshotShape, type SnapshotLoad } from "./snapshotfile.js";
export {
  ENTRY_KINDS,
  SCHEMA_VERSION,
  SEMANTICS_DOC_DATE,
  type Breadth,
  type ChangeKind,
  type Delta,
  type Diff,
  type DiffSide,
  type DiffSummary,
  type Direction,
  type Entry,
  type FailOn,
  type VerdictLabel,
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
