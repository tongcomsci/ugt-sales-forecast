const MONTH_KEY_RE = /^\d{4}-\d{2}$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isMonthPeriodKey(value: string): boolean {
  return MONTH_KEY_RE.test(value);
}

export function monthKeyFromDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

export function formatForecastPeriodForApi(date: Date, granularity: string): string {
  if (granularity === 'month') return monthKeyFromDate(date);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function parseForecastPeriodToDate(period: string, granularity = 'month'): Date {
  if (MONTH_KEY_RE.test(period)) {
    const [y, m] = period.split('-').map(Number);
    return buildPeriodDate(period, y, m, 1);
  }
  if (DATE_KEY_RE.test(period)) {
    const [y, m, d] = period.split('-').map(Number);
    // Importers build month periods as YYYY-MM-01, so that stays valid. Any
    // other day means the caller mixed up the granularity: rounding it to the
    // 1st would silently write the wrong row.
    if (granularity === 'month' && d !== 1) {
      throw new Error(
        `Month period must be YYYY-MM or the first of the month, got: ${period}`
      );
    }
    return buildPeriodDate(period, y, m, d);
  }
  throw new Error(`Invalid forecast period: ${period}`);
}

/** Reject impossible dates instead of handing back an Invalid Date. */
function buildPeriodDate(period: string, year: number, month: number, day: number): Date {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid forecast period: ${period}`);
  }
  return date;
}

export function monthKeyToFirstOfMonth(monthKey: string): Date {
  return parseForecastPeriodToDate(monthKey, 'month');
}

export function monthKeyToEndOfMonth(monthKey: string): Date {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0));
}

export const CURRENT_FORECAST_VERSION_NAME = 'Current Forecast';

/** First Wednesday on or after the 1st — matches legacy Excel import storage. */
export function firstWednesdayPeriod(month: string): string {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const firstDay = new Date(Date.UTC(year, monthIndex, 1));
  const daysUntilWednesday = (3 - firstDay.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + daysUntilWednesday))
    .toISOString()
    .slice(0, 10);
}

/** Granularity used when loading forecast_values rows from the API. */
export function resolveForecastListGranularity(
  versionName: string,
  forecastMode: 'month' | 'week' | 'day',
): 'month' | 'week' {
  // Current Forecast imports store first-Wednesday rows with granularity 'week'
  // even when the grid is in month view.
  if (versionName === CURRENT_FORECAST_VERSION_NAME) {
    return 'week';
  }
  return forecastMode === 'week' ? 'week' : 'month';
}

export function resolveForecastStoragePeriod(
  displayPeriod: string,
  forecastMode: 'month' | 'week' | 'day',
  versionName: string,
  currentForecastVersion = CURRENT_FORECAST_VERSION_NAME
): string {
  if (forecastMode !== 'month' || !MONTH_KEY_RE.test(displayPeriod)) {
    return displayPeriod;
  }
  if (versionName === currentForecastVersion) {
    return firstWednesdayPeriod(displayPeriod);
  }
  return displayPeriod;
}

export function toPeriodDate(value: Date | string, granularity = 'month'): Date {
  if (value instanceof Date) return value;
  return parseForecastPeriodToDate(value, granularity);
}
