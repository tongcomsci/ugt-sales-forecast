/**
 * Checks the shared cache size cap (audit item 8).
 * Run: npx tsx scripts/verify-bounded-cache.mjs
 */
import assert from 'node:assert/strict';
import { pruneCache } from '../src/api/services/boundedCache.ts';
import { readSource } from './readSource.mjs';

const future = () => Date.now() + 60_000;
const past = () => Date.now() - 1;

const fill = (entries) => new Map(entries.map(([key, expiresAt]) => [key, { expiresAt }]));

// under the cap: untouched
const small = fill([['a', future()], ['b', future()]]);
pruneCache(small, 5);
assert.deepEqual([...small.keys()], ['a', 'b'], 'must not evict while under the cap');

// expired entries go first, even when they are the newest
const withExpired = fill([['keep1', future()], ['keep2', future()], ['stale', past()]]);
pruneCache(withExpired, 2);
assert.deepEqual(
  [...withExpired.keys()],
  ['keep1', 'keep2'],
  'expired entries must be dropped before live ones'
);

// nothing expired: drop oldest-inserted until it fits
const allLive = fill([['oldest', future()], ['middle', future()], ['newest', future()]]);
pruneCache(allLive, 1);
assert.deepEqual([...allLive.keys()], ['newest'], 'must evict oldest-first when nothing is expired');

// the cap is honoured exactly, not approximately
const many = fill(Array.from({ length: 50 }, (_, i) => [`k${i}`, future()]));
pruneCache(many, 10);
assert.equal(many.size, 10, `expected exactly 10 entries, got ${many.size}`);
assert.equal(many.has('k49'), true, 'newest entry must survive');
assert.equal(many.has('k0'), false, 'oldest entry must be evicted');

// a cap of 0 empties the cache rather than looping forever
const zero = fill([['a', future()]]);
pruneCache(zero, 0);
assert.equal(zero.size, 0, 'maxEntries 0 must clear the cache');

// every cache that grows per query shape must be capped
const wired = [
  ['src/api/routes/forecast.ts', 'summaryCache'],
  ['src/api/routes/actuals.ts', 'actualRangeCache'],
  ['src/api/routes/actuals.ts', 'scopedActualCache'],
  ['src/api/routes/overplan.ts', 'evaluationCoreCache'],
  ['src/api/routes/inventory.ts', 'inventoryQueryCache'],
  ['src/api/services/appRoles.ts', 'permissionsCache'],
  ['src/api/services/forecastImport/previewCache.ts', 'cache'],
  ['src/api/services/overplanData.ts', 'detailQtyCache'],
];
for (const [file, name] of wired) {
  const source = readSource(file);
  assert.match(
    source,
    new RegExp(`pruneCache\\(\\s*${name}\\b`),
    `${file}: ${name} is never passed to pruneCache, so it can grow without bound`
  );
}

console.log(`[verify-bounded-cache] OK (${wired.length} caches capped)`);
