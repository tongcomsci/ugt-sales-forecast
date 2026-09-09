/**
 * Guards how the built-in administrators are recognised (audit item 9).
 *
 * A display name is not unique and, worse, arrives from Keycloak unverified —
 * matching on it hands admin to anyone who can set their own name to match.
 * Employee codes come from HR and are unique, so they are the only safe key.
 *
 * These are source checks: resolveSessionPermissions needs a database and an
 * HR cache, so the branch cannot be exercised without standing both up.
 *
 * Run: npx tsx scripts/verify-admin-permissions.mjs
 */
import assert from 'node:assert/strict';
import { readSource } from './readSource.mjs';

const source = readSource('src/api/services/appRoles.ts');

// The seed list must hold employee codes, not names.
assert.doesNotMatch(
  source,
  /DEFAULT_ADMIN_NAMES/,
  'DEFAULT_ADMIN_NAMES must be gone — seed admins are identified by employee code'
);
assert.match(
  source,
  /DEFAULT_ADMIN_EMP_CODES/,
  'expected a DEFAULT_ADMIN_EMP_CODES list'
);

const listMatch = source.match(/DEFAULT_ADMIN_EMP_CODES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
assert.ok(listMatch, 'DEFAULT_ADMIN_EMP_CODES must be a Set literal so it can be checked here');
const entries = [...listMatch[1].matchAll(/'([^']*)'/g)].map(m => m[1]);
assert.ok(entries.length > 0, 'DEFAULT_ADMIN_EMP_CODES must not be empty');
for (const entry of entries) {
  assert.match(
    entry,
    /^\d+$/,
    `"${entry}" is not an employee code — a name here would reintroduce the vulnerability`
  );
}

// The admin decision must never read the unverified display name.
const start = source.indexOf('function isDefaultAdminIdentity(');
assert.ok(start > 0, 'isDefaultAdminIdentity must exist');
const body = source.slice(start);
const fn = body.slice(0, body.indexOf('\n}\n') + 2);
assert.doesNotMatch(
  fn,
  /user\.name|fullNameEng/,
  'isDefaultAdminIdentity must not match on a name — only on the HR employee code:\n' + fn
);
assert.match(fn, /empCode/, 'isDefaultAdminIdentity must compare the HR employee code');

// A user with no HR identity cannot be a seed admin.
assert.match(
  fn,
  /identity\s*(!==|===)\s*null|!identity|identity\?\./,
  'isDefaultAdminIdentity must handle a missing HR identity explicitly'
);

console.log(`[verify-admin-permissions] OK (${entries.length} seed admins by employee code)`);
