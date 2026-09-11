/** Private process memory only; callers authenticate before requesting a value. */
export function readCache<T>(ttlMs: number, load: () => Promise<T>) {
  let cached: { value: T; expires: number } | undefined;
  let pending: Promise<T> | undefined;
  let generation = 0;
  return {
    get(): Promise<T> {
      if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
      if (pending) return pending;
      const version = generation;
      const request = Promise.resolve().then(load).then(value => {
        if (version === generation) cached = { value, expires: Date.now() + ttlMs };
        return value;
      }).finally(() => { if (pending === request) pending = undefined; });
      pending = request;
      return request;
    },
    invalidate() { generation++; cached = undefined; pending = undefined; },
  };
}
