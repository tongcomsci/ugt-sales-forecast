/**
 * Guards server-side session expiry (audit item 7).
 *
 * Sessions live in an in-process Map. The cookie's maxAge is enforced only by
 * the browser, so without an expiry stored alongside the session a captured
 * cookie value stays valid forever and the map never shrinks. These are source
 * checks: the logic is module-private and cannot be exercised without either
 * exporting internals or fast-forwarding eight hours.
 *
 * Run: npx tsx scripts/verify-session-expiry.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('src/api/auth.ts', 'utf8');

// Every session write must go through storeSession, which stamps the expiry.
// A bare sessions.set() elsewhere would create a session that never lapses.
const sessionWrites = [...source.matchAll(/sessions\.set\(/g)].length;
assert.equal(
  sessionWrites,
  1,
  `expected exactly one sessions.set() (inside storeSession), found ${sessionWrites} — ` +
  'a session written outside storeSession would never expire'
);

// Every session read must go through readSession, which drops lapsed entries.
const sessionReads = [...source.matchAll(/sessions\.get\(/g)].length;
assert.equal(
  sessionReads,
  1,
  `expected exactly one sessions.get() (inside readSession), found ${sessionReads} — ` +
  'a session read outside readSession would accept an expired session'
);

assert.match(source, /function storeSession\(/, 'storeSession must exist');
assert.match(source, /function readSession\(/, 'readSession must exist');

// readSession has to actually compare against the clock and evict.
const readBody = source.slice(source.indexOf('function readSession('));
const readFn = readBody.slice(0, readBody.indexOf('\n}\n') + 2);
assert.match(readFn, /expiresAt\s*<=\s*Date\.now\(\)/, 'readSession must check expiresAt');
assert.match(readFn, /sessions\.delete\(/, 'readSession must evict the lapsed session');

// storeSession has to stamp an expiry and sweep.
const storeBody = source.slice(source.indexOf('function storeSession('));
const storeFn = storeBody.slice(0, storeBody.indexOf('\n}\n') + 2);
assert.match(storeFn, /expiresAt:/, 'storeSession must stamp expiresAt');
assert.match(storeFn, /dropExpired\(sessions\)/, 'storeSession must sweep lapsed sessions');

// The cookie lifetime and the server lifetime must be the same value, not two
// copies that can drift.
assert.match(
  source,
  /maxAge:\s*SESSION_TTL_MS/,
  'the session cookie maxAge must reuse SESSION_TTL_MS rather than repeating the number'
);

// Abandoned PKCE login attempts are only deleted on a successful callback, so
// they need an age-based sweep or any unauthenticated caller can grow the map.
assert.match(source, /function sweepAuthStates\(/, 'sweepAuthStates must exist');
const setIndex = source.indexOf('authStates.set(');
assert.ok(setIndex > 0, 'expected an authStates.set() call');
assert.match(
  source.slice(Math.max(0, setIndex - 200), setIndex),
  /sweepAuthStates\(\)/,
  'sweepAuthStates() must run before a new auth state is stored'
);

console.log('[verify-session-expiry] OK');
