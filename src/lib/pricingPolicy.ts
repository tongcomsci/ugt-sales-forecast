/**
 * Polymer pricing-policy helpers shared by grid calculation and import.
 */

export const POLYMER_PRICING_POLICIES = [
  '(CPL/BZ)/2-Q',
  'BZ',
  'BZ-2',
  'BZ-H',
  'BZ-Q',
  'Cost+5%',
  'CPL/BZ',
  'CPL/BZ-Q',
  'CPL-1',
  'CPL-2',
  'CPL-6',
  'CPL-H',
  'CPL-Q',
  'FixJPY',
  'FixTHB',
  'FixUSD',
  'TOYOTA Naphta',
] as const;

export type PolymerPricingPolicy = (typeof POLYMER_PRICING_POLICIES)[number];

const POLICY_SET = new Set<string>(POLYMER_PRICING_POLICIES);

/** Spreadsheet synonym → canonical policy name. */
const POLICY_ALIASES: Record<string, PolymerPricingPolicy> = {
  '(cpl/bz)/2-q': '(CPL/BZ)/2-Q',
  'cpl/bz': 'CPL/BZ',
  'cpl/bz-q': 'CPL/BZ-Q',
  bz: 'BZ',
  'bz-2': 'BZ-2',
  'bz-h': 'BZ-H',
  'bz-q': 'BZ-Q',
  'cost+5%': 'Cost+5%',
  'cost + 5%': 'Cost+5%',
  'cost+5': 'Cost+5%',
  'cpl-1': 'CPL-1',
  'cpl-2': 'CPL-2',
  'cpl-6': 'CPL-6',
  'cpl-h': 'CPL-H',
  'cpl-q': 'CPL-Q',
  'fix jpy': 'FixJPY',
  'fixjpy': 'FixJPY',
  'fix thb': 'FixTHB',
  'fixthb': 'FixTHB',
  'fix usd': 'FixUSD',
  'fixusd': 'FixUSD',
  'toyota naphta': 'TOYOTA Naphta',
  'toyota naphtha': 'TOYOTA Naphta',
};

const CPL_BZ_252_SPREAD_HINT = 'spread of 252 yen';

export function normalizePricingPolicy(value: unknown): PolymerPricingPolicy | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (POLICY_SET.has(text)) return text as PolymerPricingPolicy;
  const alias = POLICY_ALIASES[text.toLowerCase().replace(/\s+/g, ' ')];
  return alias ?? null;
}

/** Normalize Cost+5% spread text (spaces / case). */
export function isCostPlus5Spread(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, '');
  return text === 'cost+5%' || text === 'cost+5' || text === 'costplus5%' || text === 'costplus5';
}

export function parseNumericSpreadText(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const text = String(value).trim().replaceAll(',', '');
  if (text === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Resolve effective numeric spread for a policy (handles CPL/BZ-Q 252-yen note → 700). */
export function resolvePolicySpread(
  policy: PolymerPricingPolicy | null | undefined,
  spreadText: unknown,
): number {
  const raw = spreadText === null || spreadText === undefined ? '' : String(spreadText);
  if (policy === 'CPL/BZ-Q' && raw.toLowerCase().includes(CPL_BZ_252_SPREAD_HINT)) {
    return 700;
  }
  return parseNumericSpreadText(raw);
}

function addMonths(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Months whose CPL/BZ prices are needed to price display month M for this policy.
 * For CPL-Q returns the three source months to average.
 */
export function resolvePricingSourceMonths(
  policy: PolymerPricingPolicy | null | undefined,
  displayMonth: string,
): string[] {
  if (!policy || !/^\d{4}-\d{2}$/.test(displayMonth)) return [displayMonth];

  if (policy === 'CPL-1') return [addMonths(displayMonth, -1)];
  if (policy === 'CPL-2' || policy === 'BZ-2') return [addMonths(displayMonth, -2)];

  if (policy === 'CPL-Q') {
    const monthNum = Number(displayMonth.slice(5, 7));
    const year = Number(displayMonth.slice(0, 4));
    // 1-3 → avg Sep–Nov prior year; 4-6 → Dec prior–Feb; 7-9 → Mar–May; 10-12 → Jun–Aug
    if (monthNum >= 1 && monthNum <= 3) {
      return [`${year - 1}-09`, `${year - 1}-10`, `${year - 1}-11`];
    }
    if (monthNum >= 4 && monthNum <= 6) {
      return [`${year - 1}-12`, `${year}-01`, `${year}-02`];
    }
    if (monthNum >= 7 && monthNum <= 9) {
      return [`${year}-03`, `${year}-04`, `${year}-05`];
    }
    return [`${year}-06`, `${year}-07`, `${year}-08`];
  }

  return [displayMonth];
}

/** Primary pricing month (first source month) — used when a single lookup is enough. */
export function resolvePricingMonth(
  policy: PolymerPricingPolicy | null | undefined,
  displayMonth: string,
): string {
  return resolvePricingSourceMonths(policy, displayMonth)[0] ?? displayMonth;
}

export type PolicyPriceInputs = {
  cpl: number;
  /** Average CPL across source months when policy is CPL-Q; otherwise ignored. */
  cplAverage?: number;
  benzene: number;
  jpyRate: number;
  thbRate: number;
  spreadText: unknown;
  latestActualPrice?: number;
};

/**
 * Compute Polymer policy price. Returns null when policy is absent/unknown
 * (caller should fall back to legacy CPL/Naphtha/Benzene).
 * When spread is Cost+5%, returns latestActualPrice (or 0 if missing).
 */
export function computePolicyPrice(
  policy: PolymerPricingPolicy | null | undefined,
  inputs: PolicyPriceInputs,
): number | null {
  if (isCostPlus5Spread(inputs.spreadText)) {
    const actual = inputs.latestActualPrice;
    return Number.isFinite(actual) ? Number(actual) : 0;
  }

  if (!policy) return null;

  const spread = resolvePolicySpread(policy, inputs.spreadText);
  const cpl = Number.isFinite(inputs.cpl) ? inputs.cpl : 0;
  const cplAvg = Number.isFinite(inputs.cplAverage) ? Number(inputs.cplAverage) : cpl;
  const bz = Number.isFinite(inputs.benzene) ? inputs.benzene : 0;
  const jpy = Number.isFinite(inputs.jpyRate) ? inputs.jpyRate : 0;
  const thb = Number.isFinite(inputs.thbRate) ? inputs.thbRate : 0;
  const rawSpread = inputs.spreadText === null || inputs.spreadText === undefined
    ? ''
    : String(inputs.spreadText);

  switch (policy) {
    case 'Cost+5%':
      // Policy name itself — treated like CPL + Spread unless spread says Cost+5%
      // (handled above). Excel note: "ใช้ CPL+Spread".
      return cpl + spread;

    case '(CPL/BZ)/2-Q':
    case 'CPL/BZ':
    case 'CPL/BZ-Q':
      return (cpl + bz) / 2 + spread;

    case 'BZ':
    case 'BZ-H':
    case 'BZ-Q':
    case 'BZ-2':
      return bz + spread;

    case 'CPL-1':
    case 'CPL-2':
    case 'CPL-6':
    case 'CPL-H':
      return cpl + spread;

    case 'CPL-Q':
      return cplAvg + spread;

    case 'FixJPY':
      if (jpy <= 0) return 0;
      return (spread * 1000) / jpy;

    case 'FixTHB':
      if (thb <= 0) return 0;
      return (spread * 1000) / thb;

    case 'FixUSD':
      return spread;

    case 'TOYOTA Naphta': {
      if (rawSpread.includes('367')) return cpl + 1500;
      if (rawSpread.includes('279')) return cpl + 1000;
      return cpl + spread;
    }

    default:
      return null;
  }
}

export function isKnownPricingPolicy(value: unknown): boolean {
  return normalizePricingPolicy(value) !== null;
}

/**
 * True when a registration names a pricing policy this module does not
 * implement — the price then comes from the upload or from manual entry, and
 * must not be calculated.
 *
 * Several policies in use (CPL Cost-Q, T-NaphthaH, PCI PA6 H/Q, FixEURO, Spot,
 * …) average a different number of months per customer, so no single formula
 * fits them. Until each is specified, computing anything here would produce a
 * plausible but wrong price, which is harder to notice than a missing one.
 *
 * An empty policy is not "manual": those registrations legitimately fall
 * through to the priceFormula chain.
 */
export function isManualPricePolicy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (String(value).trim() === '') return false;
  return normalizePricingPolicy(value) === null;
}
