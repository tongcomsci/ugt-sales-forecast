/**
 * A registration whose pricing policy the code does not implement must use the
 * uploaded or manually keyed price — never a computed one (audit item 15).
 *
 * Business decision, 9 Sep 2026: the twelve policy names with no formula in the
 * code (CPL Cost-Q, T-NaphthaH, PCI PA6 H/Q, FixEURO, Spot, …) each average a
 * different number of months per customer, so binding a formula now would be
 * guesswork. Until the formulas are specified, the stored price is the price.
 * Falling back to "CPL of the current month + spread" invents a plausible but
 * wrong number, which is worse than showing none.
 *
 * Run: npx tsx scripts/verify-manual-price-policy.mjs
 */
import assert from 'node:assert/strict';
import { isManualPricePolicy, normalizePricingPolicy } from '../src/lib/pricingPolicy.ts';
import { readSource } from './readSource.mjs';

// Every policy name found in production that the code does not implement.
const UNIMPLEMENTED = [
  'CPL Cost-Q',
  'CPL-monthly',
  'T-NaphthaH',
  'T-NaphthaQ',
  'D-NaphthaH',
  'TOYOTA Naphta-H',
  'PCI PA6 H',
  'PCI PA6 Q',
  'FixTHB+1 oct',
  'FixEURO',
  'Spot',
];

for (const name of UNIMPLEMENTED) {
  assert.equal(
    normalizePricingPolicy(name),
    null,
    `${name} now resolves to a formula — that binds a formula the business has not specified`
  );
  assert.equal(
    isManualPricePolicy(name),
    true,
    `${name} must be treated as a manual-price policy so no price is computed for it`
  );
}

// A policy the code does implement must still be computed.
for (const name of ['CPL-Q', 'BZ', 'FixJPY', 'TOYOTA Naphta', 'Cost+5%']) {
  assert.ok(normalizePricingPolicy(name), `${name} should be a known policy`);
  assert.equal(
    isManualPricePolicy(name),
    false,
    `${name} is implemented, so it must keep being calculated`
  );
}

// No policy set at all is not "manual" — those registrations legitimately fall
// through to the priceFormula chain (Naphtha, Benzene, CPL (PCI), …).
for (const empty of [null, undefined, '', '   ']) {
  assert.equal(
    isManualPricePolicy(empty),
    false,
    `${JSON.stringify(empty)} must not be treated as a manual-price policy`
  );
}

// The grid must actually consult the helper, not just export it.
const cellUtils = readSource('src/components/forecast/forecastCellUtils.ts');
assert.match(
  cellUtils,
  /isManualPricePolicy/,
  'forecastCellUtils must use isManualPricePolicy, otherwise the grid still computes a fallback price'
);

console.log(`[verify-manual-price-policy] OK (${UNIMPLEMENTED.length} policies kept manual)`);
