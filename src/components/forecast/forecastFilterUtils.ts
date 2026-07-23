import type { ColumnFilterValue, ColumnFiltersState, Registration } from '../../types/forecast';
import { EMPTY_COLUMN_FILTER } from '../../types/forecast';

const INVISIBLE_FILTER_CHARS = /[\u0000-\u001F\u007F-\u009F\u00A0\u200B-\u200D\uFEFF]/g;
export const BLANK_FILTER_OPTION = '';

export function normalizeFilterOptionValue(value: unknown): string {
  return String(value ?? '')
    .replace(INVISIBLE_FILTER_CHARS, '')
    .trim();
}

export function isBlankFilterOptionValue(value: unknown): boolean {
  return normalizeFilterOptionValue(value) === BLANK_FILTER_OPTION;
}

export function formatFilterOptionLabel(value: string): string {
  return isBlankFilterOptionValue(value) ? '(Blank)' : value;
}

export function dedupeFilterOptions(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeFilterOptionValue(value);
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.sort((a, b) => {
    if (!a) return -1;
    if (!b) return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

export function getRegistrationFieldValue(reg: Registration, key: string): string {
  const value = reg[key as keyof Registration];
  if ((key.startsWith('inventory') || key.startsWith('carry')) && typeof value === 'number') {
    return value.toLocaleString(undefined, {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  }
  if (key === 'spread') {
    return String(value ?? '');
  }
  return String(value ?? '');
}

export function getUniqueColumnValues(registrations: Registration[], key: string): string[] {
  return dedupeFilterOptions(
    registrations.map(reg => getRegistrationFieldValue(reg, key))
  );
}

export function normalizeColumnFilter(filter?: ColumnFilterValue): ColumnFilterValue {
  return filter ?? { ...EMPTY_COLUMN_FILTER };
}

export function isColumnFilterActive(filter?: ColumnFilterValue): boolean {
  return normalizeColumnFilter(filter).selectedValues.length > 0;
}

export function hasActiveColumnFilters(filters: ColumnFiltersState): boolean {
  return Object.values(filters).some(isColumnFilterActive);
}

export function matchesColumnFilter(reg: Registration, key: string, filter?: ColumnFilterValue): boolean {
  const { selectedValues } = normalizeColumnFilter(filter);
  if (selectedValues.length === 0) return true;

  const regValue = normalizeFilterOptionValue(getRegistrationFieldValue(reg, key));
  return selectedValues.some(selected =>
    regValue === normalizeFilterOptionValue(selected)
  );
}

export function matchesCustomColumnFilter(
  registrationId: string,
  columnId: string,
  filter: ColumnFilterValue | undefined,
  customColumnValues: Map<string, Record<string, string | null>>,
): boolean {
  const { selectedValues } = normalizeColumnFilter(filter);
  if (selectedValues.length === 0) return true;

  const rawValue = customColumnValues.get(registrationId)?.[columnId] ?? '';
  const regValue = normalizeFilterOptionValue(rawValue);
  return selectedValues.some(selected =>
    regValue === normalizeFilterOptionValue(selected)
  );
}

export function getUniqueCustomColumnValues(
  registrations: Registration[],
  columnId: string,
  customColumnValues: Map<string, Record<string, string | null>>,
): string[] {
  return dedupeFilterOptions(
    registrations.map(reg => customColumnValues.get(reg.id)?.[columnId] ?? '')
  );
}

export function filterRegistrations(
  registrations: Registration[],
  columnFilters: ColumnFiltersState
): Registration[] {
  return registrations.filter(reg =>
    Object.entries(columnFilters).every(([key, filter]) =>
      matchesColumnFilter(reg, key, filter)
    )
  );
}
