/**
 * One number bounds a usage read. The server's budget for one queued job (a statement, or a whole
 * section transaction) is the source of truth; the Postgres timeouts, the driver's own deadline, and
 * the browser's bound all derive from it so no layer gives up on work another layer will finish.
 * This module has no server-only import: the client reads the derived bound.
 */
export const DATABASE_JOB_BUDGET_MS = 30_000;
/** Postgres sees the same budget as `statement_timeout` and, on 17+, `transaction_timeout`. */
export const DATABASE_JOB_BUDGET_INTERVAL = `${DATABASE_JOB_BUDGET_MS}ms`;
/**
 * The driver's deadline sits this far past the server's, so Postgres cancels a slow read cleanly
 * (SQLSTATE 57014, the connection kept) before the queue destroys the connection.
 */
export const DATABASE_JOB_GRACE_MS = 2_000;
/** A queued job waits at most this long before it is refused as busy; its budget starts when it starts. */
export const DATABASE_QUEUE_WAIT_MS = 60_000;
/** The browser outlasts the server budget plus grace and network time; abandoning a read the server caches wastes it. */
export const USAGE_QUERY_CLIENT_TIMEOUT_MS = DATABASE_JOB_BUDGET_MS + DATABASE_JOB_GRACE_MS + 8_000;
