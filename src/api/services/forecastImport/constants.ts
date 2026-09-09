export const CURRENT_FORECAST_VERSION = 'Current Forecast';
export const LEGACY_PREFERRED_SHEET_NAMES = ['Polymer', 'Sheet1'];
export const VERSIONED_PREFERRED_SHEET_NAMES = ['Polymer', 'CP'];
export const SKIP_SHEET_NAMES = new Set(['mapping', 'fcst version']);
export const KEY_HEADER = 'Key for no regist';
export const KEY_HEADER_ALIASES = ['Key for no regist', 'NewKey', 'New Key', 'Key'] as const;
export const FCST_VERSION_SHEET = 'Fcst Version';
export const LEGACY_PREVIEW_CONTRACT_VERSION = 13;
export const VERSIONED_PREVIEW_CONTRACT_VERSION = 7;
export const DEFAULT_STAMP_PERIOD = 'No';
export const PREVIEW_CACHE_TTL_MS = 30 * 60 * 1000;
export const AMOUNT_MISMATCH_TOLERANCE = 0.01;
export const PREVIEW_IMPORTABLE_SAMPLE_SIZE = 50;
export const PREVIEW_UNIFIED_ROWS_SAMPLE_SIZE = 100;
export const PREVIEW_UNMATCHED_ROWS_SAMPLE_SIZE = 100;
export const PREVIEW_OVERWRITE_SAMPLE_SIZE = 50;
/**
 * Cap for the validation-issue lists. A badly formed workbook can produce one
 * entry per row, and the summary keeps the true counts, so the detail lists
 * only ever need to be a readable sample.
 */
export const PREVIEW_ISSUE_SAMPLE_SIZE = 100;

export const ALLOWED_STAMP_PERIODS = new Set([
  DEFAULT_STAMP_PERIOD,
  'Weekly1',
  'Weekly2',
  'Weekly3',
  'Weekly4',
  'Weekly5',
  'Monthly1',
  'Monthly2',
]);

export const MONTH_INDEX_BY_ABBREVIATION: Record<string, number> = {
  JAN: 0,
  FEB: 1,
  MAR: 2,
  APR: 3,
  MAY: 4,
  JUN: 5,
  JUL: 6,
  AUG: 7,
  SEP: 8,
  OCT: 9,
  NOV: 10,
  DEC: 11,
};
