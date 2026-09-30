import type { ReportKind } from '../contracts';

/** Contracts the board publishes. `report-contracts.ts` maps each one to its zod source. */
export type ContractId = 'report-envelope-v1' | 'tasks-v1' | 'standup-v1' | 'readings-v1' | 'audit-v1' | 'usage-v2';

/**
 * Who may call an endpoint. Everything except `session` is admitted by `proxy.ts` without a cookie and
 * authenticates inside its handler; `tests/kit-manifests.test.ts` holds the two to the same list.
 */
export type EndpointAuth =
  | 'session' // signed-in browser; mutations also check the origin
  | 'producer' // producer bearer key from INGEST_KEYS_JSON, scoped to `scope`
  | 'producer-or-session' // a producer key when an Authorization header is sent, otherwise a same-origin session
  | 'install' // companion install key
  | 'pairing-code' // one-time pairing code, exchanged for an install key
  | 'telemetry' // telemetry-source bearer key
  | 'telemetry-or-session'
  | 'cron' // CRON_SECRET bearer, sent by Vercel Cron
  | 'public'; // sign-in itself

export type Endpoint = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** The path as a caller writes it; `:name` marks a dynamic segment. */
  path: string;
  auth: EndpointAuth;
  scope?: string;
  contract?: ContractId;
  summary: string;
};

/**
 * How ingestion treats a kind's payload contract. `observe` stores any envelope-valid report and returns
 * the contract result in the receipt; `enforce` answers 422 and stores nothing when the payload fails.
 */
export type Enforcement = 'observe' | 'enforce';

export type KitReport = { kind: ReportKind; contract: ContractId; enforcement: Enforcement };

/** A job outside the repository that feeds the board. The app that runs it is its source of truth. */
export type Schedule = { name: string; kind: ReportKind; owner: string; cadence: string; source: string; connected: boolean };

/** A file producers take from the repository, by its path from the repository root. */
export type Download = { label: string; path: string; summary: string };

export type KitManifest = {
  id: string;
  title: string;
  summary: string;
  /** Where the kit's producer-side files live today, from the repository root. */
  directory: string;
  extracted: boolean;
  page: { path: string; empty: string };
  reports: readonly KitReport[];
  /** Scopes a producer key can carry for this kit. */
  producers: readonly string[];
  schedules: readonly Schedule[];
  endpoints: readonly Endpoint[];
  downloads: readonly Download[];
};
