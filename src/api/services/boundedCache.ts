/**
 * Size cap for the in-memory request caches.
 *
 * Every cache here keys on a query shape (filters, periods, registration ids),
 * so the number of distinct keys is unbounded even though each entry has a TTL:
 * an entry that expires and is never asked for again is never dropped. Without
 * a cap the process grows until it is restarted.
 *
 * Drops expired entries first, then oldest-inserted (Map preserves insertion
 * order) until the cache fits.
 */
export function pruneCache<T extends { expiresAt: number }>(
  cache: Map<string, T>,
  maxEntries: number
): void {
  if (cache.size <= maxEntries) return;
  dropExpired(cache);
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/**
 * Drops only the entries whose TTL has passed, leaving the rest alone.
 *
 * Use this where eviction must never be based on size — sessions, for example,
 * where discarding the oldest entry would log an active user out.
 */
export function dropExpired<T extends { expiresAt: number }>(cache: Map<string, T>): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
}
