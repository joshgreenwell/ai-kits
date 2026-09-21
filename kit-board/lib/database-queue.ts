export class DatabaseUnavailable extends Error {
  constructor(public readonly code: 'DB_TIMEOUT' | 'DB_BUSY') { super(code); this.name = 'DatabaseUnavailable'; }
}

/**
 * Gate BEFORE creating a driver query: Supavisor must never see pipelined work.
 * A job's budget (`timeoutMs`) starts when the job starts, so work that waited behind a slow
 * transaction still gets its whole budget; only a wait longer than `waitMs` refuses the job as busy.
 */
export class DatabaseQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  constructor(private readonly reset: () => Promise<void>, private readonly timeoutMs = 5000, private readonly capacity = 64, private readonly waitMs = 60_000) {}

  run<T>(work: () => PromiseLike<T>): Promise<T> {
    if (this.pending >= this.capacity) return Promise.reject(new DatabaseUnavailable('DB_BUSY'));
    this.pending++;
    const queuedAt = Date.now();
    const result = this.tail.then(async () => {
      if (Date.now() - queuedAt > this.waitMs) throw new DatabaseUnavailable('DB_BUSY');
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new DatabaseUnavailable('DB_TIMEOUT')), this.timeoutMs); }),
        ]);
      } catch (error) {
        if (error instanceof DatabaseUnavailable && error.code === 'DB_TIMEOUT') await this.reset();
        throw error;
      } finally { clearTimeout(timer); }
    });
    this.tail = result.catch(() => {});
    return result.finally(() => { this.pending--; });
  }
}
