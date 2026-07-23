/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { lazy, Suspense, useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useLoading } from './lib/loadingContext';
import { 
  BarChart3,
  Settings, 
  FileSpreadsheet, 
  AlertTriangle,
  ChevronRight, 
  Download,
  Plus,
  RefreshCw,
  Calendar,
  Layers,
  PieChart as PieIcon,
  TrendingUp,
  Box,
  Truck,
  X,
  LogOut,
  Columns3,
  Copy,
  Mail,
  Loader2,
  Package,
  Shield,
  Pencil,
  SlidersHorizontal,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format, addMonths, addDays, getDay, startOfMonth, endOfMonth, parseISO } from 'date-fns';
import { cn } from './lib/utils';
import { ForecastInputTable } from './components/forecast/ForecastInputTable';
import { ManageAdminPanel } from './components/forecast/ManageAdminPanel';
import { ManageColumnPanel } from './components/forecast/ManageColumnPanel';
import { ManageEmailPanel } from './components/forecast/ManageEmailPanel';
import { ManageRegistrationPanel } from './components/forecast/DraftRegistrationPanel';
import { NavDropdown, NavDropdownItem } from './components/layout/NavDropdown';
import { SfSelect } from './components/ui/SfSelect';
const OverplanView = lazy(() =>
  import('./components/overplan/OverplanView').then(module => ({ default: module.OverplanView }))
);
import {
  NotificationEmailPreviewModal,
  type EmailBatchPreview,
} from './components/notifications/NotificationEmailPreviewModal';
import { buildForecastIndex, getForecastCellValue, getForecastStoragePeriod, monthKey, resolveRegistrationPriceFormula } from './components/forecast/forecastCellUtils';
import { isCostPlus5Spread, normalizePricingPolicy } from './lib/pricingPolicy';
import { resolveForecastListGranularity } from './lib/forecastPeriod';
import { filterRegistrations, matchesCustomColumnFilter } from './components/forecast/forecastFilterUtils';
import { api, ApiError, FORECAST_BACKGROUND_CHUNK_SIZE, FORECAST_PRIORITY_REGISTRATION_COUNT, REGISTRATION_PAGE_SIZE, formatApiError, type AppConfig, type AuthUser, type SessionPermissions, type SnapshotStatus } from './lib/api';
import {
  ensureCanonicalModeInUrl,
  getActiveClientAppMode,
  setActiveClientAppMode,
} from './lib/appModeClient';
import { effectivePermissions } from './lib/permissions';
import {
  EMPTY_COLUMN_FILTER,
  type ColumnFiltersState,
  type ColumnFilterValue,
  type CustomColumnDef,
  type CustomColumnValue,
  customColumnIdFromFilterKey,
  isCustomColumnFilterKey,
  type ActualValue,
  type CPLPrice,
  type Dimension,
  type ForecastLoadProgress,
  type ForecastSummary,
  type ForecastSummaryRequest,
  type ForecastValue,
  type InventoryRow,
  type PriceManagementRow,
  type PriceManagementType,
  type PriceFormula,
  type Registration,
  type ValueType,
  isManagedRegistrationMerge,
} from './types/forecast';

const lazyRechart = (name: string) => lazy(async () => {
  const module = await import('recharts');
  return { default: module[name as keyof typeof module] as React.ComponentType<Record<string, unknown>> };
});
const ResponsiveContainer = lazyRechart('ResponsiveContainer');
const AreaChart = lazyRechart('AreaChart');
const Area = lazyRechart('Area');
const CartesianGrid = lazyRechart('CartesianGrid');
const XAxis = lazyRechart('XAxis');
const YAxis = lazyRechart('YAxis');
const Tooltip = lazyRechart('Tooltip');
const PieChart = lazyRechart('PieChart');
const Pie = lazyRechart('Pie');
const Cell = lazyRechart('Cell');
const Legend = lazyRechart('Legend');
const ReBarChart = lazyRechart('BarChart');
const Bar = lazyRechart('Bar');

// --- Types ---

type AppTab = 'forecast' | 'master' | 'dashboard' | 'overplan' | 'weekly' | 'monthly' | 'yearly' | 'mtp' | 'pdc' | 'suggestion';
const FORECAST_SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const FORECAST_SUMMARY_CACHE_PREFIX = 'forecast-summary:v2:';
const BU_FILTER_STORAGE_KEY_PREFIX = 'sales-forecast:business-unit-filter:v1';
const STAMP_PERIOD_OPTIONS = ['No', 'Weekly1', 'Weekly2', 'Weekly3', 'Weekly4', 'Weekly5', 'Monthly1', 'Monthly2'];
const CURRENT_FORECAST_VERSION = 'Current Forecast';
const GLOBAL_PRICE_VERSION = 'GLOBAL';
const ANALYTICS_POWER_BI_URL = 'https://app.powerbi.com/groups/08e1f1d7-5d67-43e1-b1ed-0f0930863c6f/reports/eaa3a0d9-22a9-4f03-848e-bcd4d401f2c0?ctid=0b702037-5428-4249-9606-56c40358141d&pbi_source=linkShare';

function businessUnitStorageKey(appMode?: string) {
  return appMode ? `${BU_FILTER_STORAGE_KEY_PREFIX}:${appMode}` : BU_FILTER_STORAGE_KEY_PREFIX;
}

function loadStoredBusinessUnitFilter(appMode?: string): ColumnFiltersState {
  if (globalThis.localStorage === undefined) return {};
  try {
    const raw = globalThis.localStorage.getItem(businessUnitStorageKey(appMode))
      ?? (!appMode ? null : globalThis.localStorage.getItem(BU_FILTER_STORAGE_KEY_PREFIX));
    if (!raw) return {};
    const selectedValues = JSON.parse(raw);
    if (!Array.isArray(selectedValues)) return {};
    const values = selectedValues.map(value => String(value).trim()).filter(Boolean);
    return values.length > 0 ? { businessUnit: { searchText: '', selectedValues: values } } : {};
  } catch {
    return {};
  }
}

function buildScopedForecastQuery(
  registrationIds: string[],
  dateRange: { start: string; end: string },
  version: string,
  forecastMode: 'month' | 'week' | 'day',
) {
  const granularity = resolveForecastListGranularity(version, forecastMode);
  return {
    registrationIds,
    version,
    startPeriod: dateRange.start.slice(0, 7),
    endPeriod: dateRange.end.slice(0, 7),
    granularity,
  };
}

function orderRegistrationIdsForFetch(allIds: string[], priorityIds: Iterable<string>) {
  const prioritySet = new Set(priorityIds);
  const priority: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  for (const id of allIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    if (prioritySet.has(id)) priority.push(id);
    else rest.push(id);
  }
  return [...priority, ...rest];
}

function buildForecastScopeKey(
  version: string,
  dateRange: { start: string; end: string },
  forecastMode: 'month' | 'week' | 'day',
) {
  return `${version}|${dateRange.start}|${dateRange.end}|${forecastMode}`;
}

/** Avoid treating an empty API response as a successful scope load (cells stay blank). */
function hasForecastDataForScope(
  forecastData: ForecastValue[],
  version: string,
  dateRange: { start: string; end: string },
) {
  const start = dateRange.start.slice(0, 7);
  const end = dateRange.end.slice(0, 7);
  return forecastData.some(item => {
    if (item.version !== version) return false;
    const periodMonth = monthKey(item.month);
    return periodMonth >= start && periodMonth <= end;
  });
}

function hashRegistrationIds(registrationIds: string[]) {
  let hash = 0;
  for (const id of registrationIds) {
    for (let index = 0; index < id.length; index += 1) {
      hash = (hash * 33 + id.charCodeAt(index)) | 0;
    }
    hash = (hash * 33 + id.length) | 0;
  }
  return hash >>> 0;
}

function buildForecastPriorityIds(allIds: string[], displayedIds: string[]) {
  const priority: string[] = [];
  const seen = new Set<string>();

  for (const id of displayedIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    priority.push(id);
    if (priority.length >= FORECAST_PRIORITY_REGISTRATION_COUNT) {
      return priority;
    }
  }

  for (const id of allIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    priority.push(id);
    if (priority.length >= FORECAST_PRIORITY_REGISTRATION_COUNT) {
      break;
    }
  }

  return priority;
}

interface ForecastScopeCacheEntry {
  loadedAt: number;
  registrationSig: string;
  fcstFetched: boolean;
  fcstPriorityLoaded: boolean;
}

function buildRegistrationLoadSignature(
  writeEpoch: number,
  registrationIds: string[],
  filterKey = '',
) {
  return `${writeEpoch}|${registrationIds.length}|${hashRegistrationIds(registrationIds)}|${filterKey}`;
}

interface PendingCellEdit {
  registrationId: string;
  period: string;
  version: string;
  baseValue: number;
  currentValue: number;
}

type PendingForecastEdit = PendingCellEdit;
type PendingPriceEdit = PendingCellEdit;
type PendingAmountEdit = PendingCellEdit;

interface InventoryCommitPreviewRow {
  key: string;
  registration: Registration;
  period: string;
  baseValue: number;
  currentValue: number;
  delta: number;
  pendingMaterialDelta: number;
  inventory?: InventoryRow;
}

function ignorePromise(promise: Promise<unknown>) {
  promise.catch(() => undefined);
}

function mergeCustomColumnValues(
  previous: Map<string, Record<string, string | null>>,
  rows: CustomColumnValue[],
): Map<string, Record<string, string | null>> {
  const next = new Map(previous);
  for (const row of rows) {
    const previousValues = next.get(row.registrationId);
    const existing: Record<string, string | null> = Object.assign({}, previousValues);
    existing[row.columnId] = row.value;
    next.set(row.registrationId, existing);
  }
  return next;
}

async function queryCustomColumnValuesInChunks(
  registrationIds: string[],
  columnIds?: string[],
): Promise<CustomColumnValue[]> {
  if (registrationIds.length === 0) return [];
  const chunkSize = 500;
  const chunks: string[][] = [];
  for (let index = 0; index < registrationIds.length; index += chunkSize) {
    chunks.push(registrationIds.slice(index, index + chunkSize));
  }
  const results = await Promise.all(
    chunks.map(chunk => api.customColumns.queryValues(chunk, columnIds)),
  );
  return results.flat();
}

function pendingEditValues<T extends PendingCellEdit>(edits: Record<string, T>): T[] {
  return Object.values(edits);
}

function restorePendingEdits<T extends PendingCellEdit>(
  previous: Record<string, T>,
  edits: T[]
): Record<string, T> {
  const restored = { ...previous };
  for (const edit of edits) {
    restored[`${edit.registrationId}|${edit.version}|${edit.period}`] = edit;
  }
  return restored;
}

function withoutRegistrationEdits<T extends { registrationId: string }>(
  previous: Record<string, T>,
  registrationId: string
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(previous).filter(([, edit]) => edit.registrationId !== registrationId)
  );
}

function withoutVersionEdits<T extends PendingCellEdit>(
  previous: Record<string, T>,
  version: string
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(previous).filter(([, edit]) => edit.version !== version)
  );
}

function seedPriceStateFromForecasts(
  forecasts: ForecastValue[],
  skipRegistrationIds?: Set<string>,
) {
  const fixedPrices = new Map<string, Map<string, number>>();
  const formulas = new Map<string, PriceFormula>();
  for (const item of forecasts) {
    if (skipRegistrationIds?.has(item.registrationId)) continue;
    const price = item.priceFcst ?? 0;
    if (price <= 0) continue;
    const pricingMonth = monthKey(item.month);
    const regPrices = fixedPrices.get(item.registrationId) ?? new Map<string, number>();
    regPrices.set(pricingMonth, price);
    fixedPrices.set(item.registrationId, regPrices);
    formulas.set(item.registrationId, 'Fixed Price');
  }
  return { fixedPrices, formulas };
}

function applyForecastSummaryEdits(
  previous: ForecastSummary | null,
  edits: PendingForecastEdit[],
  selectedVersion: string,
  forecastMode: 'week' | 'month'
) {
  if (!previous) return previous;
  const periods = previous.periods.map(period => ({ ...period }));
  const periodIndex = new Map<string, number>(
    periods.map((period, index) => [period.period, index])
  );
  for (const edit of edits) {
    if (edit.version !== selectedVersion) continue;
    const displayPeriod = forecastMode === 'month'
      ? edit.period.slice(0, 7)
      : edit.period;
    const index = periodIndex.get(displayPeriod);
    if (index !== undefined) {
      periods[index].qtyFcst += edit.currentValue - edit.baseValue;
    }
  }
  return { ...previous, periods };
}

function deltaTextClass(value: number) {
  if (value > 0) return 'text-[#007ABE]';
  if (value < 0) return 'text-rose-600';
  return 'text-slate-500';
}

function priceRowsToCplPrices(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.cplPrice }));
}

function priceRowsToNaphthaPrices(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.naphthaPrice }));
}

function priceRowsToBenzenePrices(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.benzenePrice }));
}

function mapLegacyCplPrices(prices: CPLPrice[]): PriceManagementRow[] {
  return prices.map(price => ({
    month: price.month,
    cplPrice: price.price,
    naphthaPrice: 0,
    benzenePrice: 0,
    jpyUsdRate: 0,
    thbUsdRate: 0,
    cplTecnonPrice: 0,
    cplPciPrice: 0,
  }));
}

function priceRowsToJpyRates(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.jpyUsdRate }));
}

function priceRowsToThbRates(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.thbUsdRate }));
}

function priceRowsToTecnonPrices(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.cplTecnonPrice }));
}

function priceRowsToPciPrices(rows: PriceManagementRow[]): CPLPrice[] {
  return rows.map(row => ({ month: row.month, price: row.cplPciPrice }));
}

function shiftMonthKey(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

interface CarrySnapshot {
  carryInETD: number;
  carryOutETD: number;
  carryInLoading: number;
  carryOutLoading: number;
}

// Carry columns show a single snapshot month per registration: the current
// month before the 26th (order cutoff), next month from the 26th onward.
function getCarrySnapshotMonth(now = new Date()): string {
  const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return now.getDate() < 26 ? currentMonthKey : shiftMonthKey(currentMonthKey, 1);
}

function resolveApiErrorMessage(primary: unknown, secondary: unknown, fallback: string): string {
  if (secondary instanceof ApiError) return secondary.message;
  if (primary instanceof ApiError) return primary.message;
  return fallback;
}

async function loadPriceManagementData(
  fy: number,
  priceManagementType: 'Actual' | 'Fcst',
  priceManagementVersion: string,
  signal: AbortSignal,
): Promise<PriceManagementRow[]> {
  const versionForQuery = priceManagementType === 'Actual'
    ? GLOBAL_PRICE_VERSION
    : priceManagementVersion;
  try {
    const result = await api.priceManagement.list(fy, priceManagementType, versionForQuery, signal);
    return result.rows;
  } catch (primaryError) {
    try {
      const legacyPrices = await api.cpl.list(fy);
      return mapLegacyCplPrices(legacyPrices);
    } catch (secondaryError) {
      throw new Error(resolveApiErrorMessage(primaryError, secondaryError, 'Failed to load Price Management data'));
    }
  }
}

async function loadForecastPriceData(
  startMonth: string,
  endMonth: string,
  version: string,
  signal: AbortSignal,
): Promise<{
  cpl: CPLPrice[];
  naphtha: CPLPrice[];
  benzene: CPLPrice[];
  jpy: CPLPrice[];
  thb: CPLPrice[];
  tecnon: CPLPrice[];
  pci: CPLPrice[];
}> {
  // Polymer policies may look back CPL-Q (~6 months) / CPL-2 — pad the range.
  const paddedStart = shiftMonthKey(startMonth, -6);
  try {
    const result = await api.priceManagement.listRange(paddedStart, endMonth, version, signal);
    return {
      cpl: priceRowsToCplPrices(result.rows),
      naphtha: priceRowsToNaphthaPrices(result.rows),
      benzene: priceRowsToBenzenePrices(result.rows),
      jpy: priceRowsToJpyRates(result.rows),
      thb: priceRowsToThbRates(result.rows),
      tecnon: priceRowsToTecnonPrices(result.rows),
      pci: priceRowsToPciPrices(result.rows),
    };
  } catch (primaryError) {
    try {
      const legacyPrices = await api.cpl.list();
      const cplFallback = legacyPrices
        .filter(price => price.month >= paddedStart && price.month <= endMonth)
        .sort((a, b) => a.month.localeCompare(b.month));
      const zero = cplFallback.map(price => ({ month: price.month, price: 0 }));
      return {
        cpl: cplFallback,
        naphtha: zero,
        benzene: zero,
        jpy: zero,
        thb: zero,
        tecnon: zero,
        pci: zero,
      };
    } catch (secondaryError) {
      throw new Error(resolveApiErrorMessage(primaryError, secondaryError, 'Failed to load forecast prices'));
    }
  }
}

// --- Components ---

const MONTH_OPTIONS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

function MonthYearPicker({
  value,
  onChange,
  ariaLabel,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
}>) {
  const selectedYear = Number(value.slice(0, 4)) || new Date().getFullYear();
  const selectedMonth = Number(value.slice(5, 7)) - 1;
  const [isOpen, setIsOpen] = useState(false);
  const [displayYear, setDisplayYear] = useState(selectedYear);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const yearOptions = useMemo(
    () => Array.from({ length: 51 }, (_, index) => 2000 + index),
    []
  );

  useEffect(() => {
    if (!isOpen) setDisplayYear(selectedYear);
  }, [isOpen, selectedYear]);

  useEffect(() => {
    if (!isOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setIsOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [isOpen]);

  const selectMonth = (monthIndex: number) => {
    onChange(`${displayYear}-${String(monthIndex + 1).padStart(2, '0')}`);
    setIsOpen(false);
  };

  return (
    <div ref={pickerRef} className="relative flex-1">
      <button
        type="button"
        onClick={() => setIsOpen(previous => !previous)}
        className="flex w-full items-center justify-between rounded border border-slate-200 bg-slate-50 p-1.5 text-left text-xs text-slate-700 outline-none transition-colors hover:border-slate-300 focus:border-blue-400"
        aria-label={ariaLabel}
        aria-expanded={isOpen}
      >
        <span>{format(parseISO(`${value}-01`), 'MMMM yyyy')}</span>
        <Calendar size={14} className="shrink-0 text-slate-500" />
      </button>

      {isOpen && (
        <div className="absolute left-0 top-full z-[100] mt-2 w-72 rounded-lg border border-slate-200 bg-white p-3 shadow-xl">
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setDisplayYear(year => Math.max(2000, year - 1))}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 text-slate-500 hover:border-blue-200 hover:text-blue-600"
              aria-label="Previous year"
            >
              <ChevronRight size={16} className="rotate-180" />
            </button>
            <select
              value={displayYear}
              onChange={event => setDisplayYear(Number(event.target.value))}
              className="sf-select h-8 min-w-0 flex-1 rounded border px-2 text-sm outline-none"
              aria-label="Select year"
            >
              {yearOptions.map(year => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setDisplayYear(year => Math.min(2050, year + 1))}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded border border-slate-200 text-slate-500 hover:border-blue-200 hover:text-blue-600"
              aria-label="Next year"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="grid grid-cols-4 gap-1.5">
            {MONTH_OPTIONS.map((month, monthIndex) => {
              const isSelected = displayYear === selectedYear && monthIndex === selectedMonth;
              return (
                <button
                  key={month}
                  type="button"
                  onClick={() => selectMonth(monthIndex)}
                  className={cn(
                    "h-9 rounded text-xs font-bold transition-colors",
                    isSelected
                      ? "bg-blue-600 text-white"
                      : "text-slate-600 hover:bg-blue-50 hover:text-blue-700"
                  )}
                >
                  {month}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('forecast');
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [permissions, setPermissions] = useState<SessionPermissions | null>(null);
  const [appConfig, setAppConfig] = useState<AppConfig | null>(null);
  const [isAuthLoading, setIsAuthLoading] = useState(true);
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const [openNavMenu, setOpenNavMenu] = useState<'manage' | 'budget' | null>(null);
  const [manageAdminOpen, setManageAdminOpen] = useState(false);
  const [manageEmailOpen, setManageEmailOpen] = useState(false);
  const [manageColumnsOpen, setManageColumnsOpen] = useState(false);
  const [manageColumnsInitialSection, setManageColumnsInitialSection] = useState<'add' | 'manage'>('add');
  const [manageRegistrationOpen, setManageRegistrationOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const [isAddingVersion, setIsAddingVersion] = useState(false);
  const [isEditingVersion, setIsEditingVersion] = useState(false);
  const [newVersionName, setNewVersionName] = useState('');
  const [editingVersionName, setEditingVersionName] = useState('');
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [isCopyingPriceVersion, setIsCopyingPriceVersion] = useState(false);
  const [isCopyingForecastVersion, setIsCopyingForecastVersion] = useState(false);
  const [selectedFy, setSelectedFy] = useState(2026);
  const [priceManagementType, setPriceManagementType] = useState<PriceManagementType>('Fcst');
  const [priceManagementVersion, setPriceManagementVersion] = useState(CURRENT_FORECAST_VERSION);
  const [priceManagementRows, setPriceManagementRows] = useState<PriceManagementRow[]>([]);
  const [copySourceVersion, setCopySourceVersion] = useState(CURRENT_FORECAST_VERSION);
  const [copyForecastSourceVersion, setCopyForecastSourceVersion] = useState(CURRENT_FORECAST_VERSION);
  const cplTableRef = useRef<HTMLDivElement>(null);
  const [registrations, setRegistrations] = useState<Registration[]>([]);
  const [managedRegistrations, setManagedRegistrations] = useState<Registration[]>([]);
  const [customColumnDefs, setCustomColumnDefs] = useState<CustomColumnDef[]>([]);
  const [customColumnValues, setCustomColumnValues] = useState<Map<string, Record<string, string | null>>>(new Map());
  const customColumnValuesRef = useRef(customColumnValues);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>(() => loadStoredBusinessUnitFilter());
  const [forecastData, setForecastData] = useState<ForecastValue[]>([]);
  const forecastDataRef = useRef<ForecastValue[]>([]);
  const forecastPositionRef = useRef(new Map<string, number>());
  const [pendingForecastEdits, setPendingForecastEdits] = useState<Record<string, PendingForecastEdit>>({});
  const [pendingPriceEdits, setPendingPriceEdits] = useState<Record<string, PendingPriceEdit>>({});
  const [pendingAmountEdits, setPendingAmountEdits] = useState<Record<string, PendingAmountEdit>>({});
  const [forecastSummary, setForecastSummary] = useState<ForecastSummary | null>(null);
  const [isForecastSummaryUpdating, setIsForecastSummaryUpdating] = useState(false);
  const [forecastAuditVersion, setForecastAuditVersion] = useState(0);
  const [inventoryByRegistrationId, setInventoryByRegistrationId] = useState<Map<string, InventoryRow>>(new Map());
  const [isInventoryLoading, setIsInventoryLoading] = useState(false);
  const [carrySnapshotByRegistrationId, setCarrySnapshotByRegistrationId] = useState<Map<string, CarrySnapshot>>(new Map());
  const [inventoryCommitPreviewOpen, setInventoryCommitPreviewOpen] = useState(false);
  const [commitEmailPreviewOpen, setCommitEmailPreviewOpen] = useState(false);
  const [commitEmailPreviewBatches, setCommitEmailPreviewBatches] = useState<EmailBatchPreview[]>([]);
  const [commitEmailPreviewLoading, setCommitEmailPreviewLoading] = useState(false);
  const [commitEmailSending, setCommitEmailSending] = useState(false);
  const [commitEmailSendMessage, setCommitEmailSendMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const inventoryByRegistrationIdRef = useRef<Map<string, InventoryRow>>(new Map());
  const pendingInventoryRequestIdsRef = useRef<Set<string>>(new Set());
  const mergedRegistrationCacheRef = useRef(new Map<string, {
    registration: Registration;
    inventory?: InventoryRow;
    carry?: CarrySnapshot;
    merged: Registration;
  }>());
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus | null>(null);
  const [isRefreshingSnapshot, setIsRefreshingSnapshot] = useState(false);
  const [snapshotDataVersion, setSnapshotDataVersion] = useState(0);
  const snapshotVersionRef = useRef<string | null>(null);
  const hasSnapshotStatusRef = useRef(false);
  const [cplPrices, setCplPrices] = useState<CPLPrice[]>([]);
  const [naphthaprices, setNaphthaprices] = useState<CPLPrice[]>([]);
  const [benzeneprices, setBenzeneprices] = useState<CPLPrice[]>([]);
  const [jpyRates, setJpyRates] = useState<CPLPrice[]>([]);
  const [thbRates, setThbRates] = useState<CPLPrice[]>([]);
  const [tecnonPrices, setTecnonPrices] = useState<CPLPrice[]>([]);
  const [pciPrices, setPciPrices] = useState<CPLPrice[]>([]);
  const [latestActualPriceMap, setLatestActualPriceMap] = useState<Map<string, number>>(new Map());
  const [pricingPolicyMap, setPricingPolicyMap] = useState<Map<string, string | null>>(new Map());
  const [versions, setVersions] = useState<string[]>([CURRENT_FORECAST_VERSION]);
  const [selectedVersion, setSelectedVersion] = useState(CURRENT_FORECAST_VERSION);
  const [stampPeriod, setStampPeriod] = useState('No');
  const [planningView, setPlanningView] = useState<'sale' | 'accounting' | 'production'>('sale');
  const [selectedDimension, setSelectedDimension] = useState<Dimension>('Qty');
  const [selectedType, setSelectedType] = useState<ValueType>('Fcst');
  const [forecastMode, setForecastMode] = useState<'month' | 'week' | 'day'>('month');
  const isCurrentForecastVersion = selectedVersion === CURRENT_FORECAST_VERSION;
  const [formulaMap, setFormulaMap] = useState<Map<string, PriceFormula>>(new Map());
  const handleFormulaChange = useCallback((regId: string, formula: PriceFormula) => {
    setFormulaMap(prev => new Map(prev).set(regId, formula));
  }, []);
  const [spreadMap, setSpreadMap] = useState<Map<string, string>>(new Map());
  const handleSpreadChange = useCallback((regId: string, spread: string | null) => {
    setSpreadMap(prev => {
      const next = new Map(prev);
      if (spread === null || spread === '') next.delete(regId);
      else next.set(regId, spread);
      return next;
    });
  }, []);
  const handleSpreadCommit = useCallback(async (regId: string, spread: string | null) => {
    const committedBy = authUser?.name || authUser?.email || 'sales-forecast-web';
    try {
      await api.registrations.updateSpread(regId, spread, committedBy);
      setRegistrations(previous =>
        previous.map(registration =>
          registration.id === regId ? { ...registration, spread } : registration
        )
      );
      setManagedRegistrations(previous =>
        previous.map(registration =>
          registration.id === regId ? { ...registration, spread } : registration
        )
      );
      setAppError(null);
    } catch (error) {
      setAppError(error instanceof ApiError ? error.message : 'Failed to save spread');
    }
  }, [authUser?.email, authUser?.name]);
  const handlePricingPolicyChange = useCallback(async (regId: string, pricingPolicy: string | null) => {
    setPricingPolicyMap(prev => {
      const next = new Map(prev);
      next.set(regId, pricingPolicy);
      return next;
    });
    const committedBy = authUser?.name || authUser?.email || 'sales-forecast-web';
    try {
      await api.registrations.updatePriceSettings(regId, { pricingPolicy }, committedBy);
      setRegistrations(previous =>
        previous.map(registration =>
          registration.id === regId ? { ...registration, pricingPolicy } : registration
        )
      );
      setManagedRegistrations(previous =>
        previous.map(registration =>
          registration.id === regId ? { ...registration, pricingPolicy } : registration
        )
      );
      setAppError(null);
    } catch (error) {
      setAppError(error instanceof ApiError ? error.message : 'Failed to save pricing policy');
    }
  }, [authUser?.email, authUser?.name]);
  const handleCustomColumnValueChange = useCallback(async (
    columnId: string,
    registrationId: string,
    value: string | null,
  ) => {
    setCustomColumnValues(previous => {
      const next = new Map(previous);
      const previousValues = next.get(registrationId);
      const existing: Record<string, string | null> = Object.assign({}, previousValues);
      existing[columnId] = value;
      next.set(registrationId, existing);
      return next;
    });
    try {
      await api.customColumns.upsertValue(columnId, registrationId, value);
      setAppError(null);
    } catch (error) {
      setAppError(error instanceof ApiError ? error.message : 'Failed to save custom column value');
      ignorePromise(
        queryCustomColumnValuesInChunks([registrationId], [columnId]).then(rows => {
          setCustomColumnValues(previous => mergeCustomColumnValues(previous, rows));
        }),
      );
    }
  }, []);
  const handleCustomColumnsChanged = useCallback((columns: CustomColumnDef[]) => {
    setCustomColumnDefs(columns);
    const activeColumnIds = new Set(columns.map(column => column.id));
    setColumnFilters(previous => {
      const nextEntries = Object.entries(previous).filter(([key]) => {
        if (!isCustomColumnFilterKey(key)) return true;
        return activeColumnIds.has(customColumnIdFromFilterKey(key));
      });
      return Object.fromEntries(nextEntries);
    });
  }, []);
  const openManageColumns = useCallback((section: 'add' | 'manage' = 'add') => {
    setManageColumnsInitialSection(section);
    setManageColumnsOpen(true);
  }, []);
  const [fixedPriceMap, setFixedPriceMap] = useState<Map<string, Map<string, number>>>(new Map());
  const handleFixedPriceChange = useCallback((regId: string, month: string, price: number) => {
    if (!Number.isFinite(price) || price < 0) return;
    const pricingMonth = monthKey(month);
    setFormulaMap(prev => new Map(prev).set(regId, 'Fixed Price'));
    setFixedPriceMap(prev => {
      const next = new Map(prev);
      const regPrices = new Map<string, number>(prev.get(regId));
      regPrices.set(pricingMonth, price);
      next.set(regId, regPrices);
      return next;
    });

    const storagePeriod = getForecastStoragePeriod(month, forecastMode, selectedVersion);
    const editKey = `${regId}|${selectedVersion}|${month}`;
    const storageKey = `${regId}|${selectedVersion}|${storagePeriod}`;
    const knownIndex = forecastPositionRef.current.get(storageKey);
    const existing = knownIndex === undefined
      ? undefined
      : forecastDataRef.current[knownIndex];

    setPendingPriceEdits(previous => ({
      ...previous,
      [editKey]: {
        registrationId: regId,
        period: month,
        version: selectedVersion,
        baseValue: previous[editKey]?.baseValue ?? existing?.priceFcst ?? 0,
        currentValue: price,
      },
    }));
    setForecastData(prev => {
      const indexedItem = knownIndex === undefined ? undefined : prev[knownIndex];
      const index = indexedItem &&
        indexedItem.registrationId === regId &&
        indexedItem.month === storagePeriod &&
        indexedItem.version === selectedVersion
        ? knownIndex
        : prev.findIndex(item =>
            item.registrationId === regId &&
            item.month === storagePeriod &&
            item.version === selectedVersion
          );

      if (index > -1) {
        const newData = [...prev];
        newData[index] = { ...newData[index], priceFcst: price };
        return newData;
      }
      forecastPositionRef.current.set(storageKey, prev.length);
      return [...prev, {
        registrationId: regId,
        month: storagePeriod,
        version: selectedVersion,
        qtyAct: 0,
        qtyFcst: existing?.qtyFcst ?? 0,
        priceFcst: price,
        priceAct: 0,
      }];
    });
  }, [forecastMode, selectedVersion]);
  const handleAmountChange = useCallback((regId: string, month: string, amount: number) => {
    if (!Number.isFinite(amount) || amount < 0) return;

    const storagePeriod = getForecastStoragePeriod(month, forecastMode, selectedVersion);
    const editKey = `${regId}|${selectedVersion}|${month}`;
    const storageKey = `${regId}|${selectedVersion}|${storagePeriod}`;
    const knownIndex = forecastPositionRef.current.get(storageKey);
    const existing = knownIndex === undefined
      ? undefined
      : forecastDataRef.current[knownIndex];

    setPendingAmountEdits(previous => ({
      ...previous,
      [editKey]: {
        registrationId: regId,
        period: month,
        version: selectedVersion,
        baseValue: previous[editKey]?.baseValue ?? existing?.amountFcst ?? 0,
        currentValue: amount,
      },
    }));
    setForecastData(prev => {
      const indexedItem = knownIndex === undefined ? undefined : prev[knownIndex];
      const index = indexedItem &&
        indexedItem.registrationId === regId &&
        indexedItem.month === storagePeriod &&
        indexedItem.version === selectedVersion
        ? knownIndex
        : prev.findIndex(item =>
            item.registrationId === regId &&
            item.month === storagePeriod &&
            item.version === selectedVersion
          );

      if (index > -1) {
        const newData = [...prev];
        newData[index] = { ...newData[index], amountFcst: amount };
        return newData;
      }
      forecastPositionRef.current.set(storageKey, prev.length);
      return [...prev, {
        registrationId: regId,
        month: storagePeriod,
        version: selectedVersion,
        qtyAct: 0,
        qtyFcst: existing?.qtyFcst ?? 0,
        priceFcst: existing?.priceFcst ?? 0,
        amountFcst: amount,
        priceAct: 0,
      }];
    });
  }, [forecastMode, selectedVersion]);
  const [formulaFilter, setFormulaFilter] = useState<ColumnFilterValue>(EMPTY_COLUMN_FILTER);
  const [dateRange, setDateRange] = useState({ 
    start: format(new Date(), 'yyyy-MM'), 
    end: format(addMonths(new Date(), 3), 'yyyy-MM') 
  });
  const startDatePickerRef = useRef<HTMLInputElement | null>(null);
  const endDatePickerRef = useRef<HTMLInputElement | null>(null);
  const hasSkippedInitialActualRefreshRef = useRef(false);
  const hasSkippedInitialForecastScopeRefreshRef = useRef(false);
  const hasSkippedInitialRegistrationFilterRef = useRef(false);
  const isLoadingMoreRef = useRef(false);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const registrationLoadGenerationRef = useRef(0);
  const loadedCustomValueRegistrationIdsRef = useRef<Set<string>>(new Set());
  const initialForecastLoadCompleteRef = useRef(false);
  const [initialForecastLoadComplete, setInitialForecastLoadComplete] = useState(false);
  const selectedVersionRef = useRef(selectedVersion);
  const registrationsRef = useRef(registrations);
  useEffect(() => {
    registrationsRef.current = registrations;
  }, [registrations]);
  useEffect(() => {
    selectedVersionRef.current = selectedVersion;
  }, [selectedVersion]);
  const versionsRef = useRef(versions);
  useEffect(() => {
    versionsRef.current = versions;
  }, [versions]);
  const forecastModeRef = useRef(forecastMode);
  useEffect(() => {
    forecastModeRef.current = forecastMode;
  }, [forecastMode]);
  const dateRangeRef = useRef(dateRange);
  useEffect(() => {
    dateRangeRef.current = dateRange;
  }, [dateRange]);

  // Read-through cache for the scoped forecast fetch. Skips refetch when the user
  // toggles back to a (version + date range + mode) that is already loaded.
  const forecastScopeCacheRef = useRef<{
    registrationSig: string;
    scopes: Map<string, ForecastScopeCacheEntry>;
  }>({ registrationSig: '', scopes: new Map() });
  const forecastBackgroundAbortRef = useRef<AbortController | null>(null);
  const forecastWriteEpochRef = useRef(0);
  const pendingEditsCountRef = useRef(0);
  const displayedRegistrationIdsRef = useRef<string[]>([]);

  const [isLoading, setIsLoading] = useState(true);
  const [isTableDataLoading, setIsTableDataLoading] = useState(false);
  const [forecastLoadProgress, setForecastLoadProgress] = useState<ForecastLoadProgress | null>(null);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [registrationCursor, setRegistrationCursor] = useState<string | null>(null);
  const [hasMoreRegistrations, setHasMoreRegistrations] = useState(true);
  const [appError, setAppError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isForecastHeaderCollapsed, setIsForecastHeaderCollapsed] = useState(false);
  const { start: loadStart, done: loadDone } = useLoading();
  const flash = (ms = 350) => { loadStart(); setTimeout(loadDone, ms); };

  const refreshSessionPermissions = useCallback(() => {
    return api.auth.me()
      .then(result => {
        setAuthUser(result.user);
        setPermissions(result.permissions ?? {
          role: 'user',
          canManageAdmin: false,
          canManageEmail: false,
          empCode: null,
        });
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.auth.me()
      .then(result => {
        if (cancelled) return;
        setAuthUser(result.user);
        setPermissions(result.permissions ?? {
          role: 'user',
          canManageAdmin: false,
          canManageEmail: false,
          empCode: null,
        });
      })
      .catch(error => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          const loginUrl = typeof error.details.loginUrl === 'string'
            ? error.details.loginUrl
            : api.auth.loginUrl();
          window.location.href = loginUrl;
          return;
        }
        setAppError(error instanceof ApiError ? error.message : 'Failed to check sign-in status');
      })
      .finally(() => {
        if (!cancelled) setIsAuthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isAccountMenuOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!accountMenuRef.current?.contains(event.target as Node)) {
        setIsAccountMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsAccountMenuOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [isAccountMenuOpen]);

  const handleLogout = useCallback(async () => {
    loadStart();
    try {
      await api.auth.logout();
    } catch (error) {
      setAppError(error instanceof ApiError ? error.message : 'Failed to log out');
    } finally {
      loadDone();
      setIsAccountMenuOpen(false);
    }
  }, [loadDone, loadStart]);

  useEffect(() => {
    forecastDataRef.current = forecastData;
    forecastPositionRef.current = new Map(
      forecastData.map((item, index) => [
        `${item.registrationId}|${item.version}|${item.month}`,
        index,
      ])
    );
  }, [forecastData]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api.sync.status();
        if (cancelled) return;
        setSnapshotStatus(status);
        if (
          hasSnapshotStatusRef.current &&
          status.activeVersion &&
          snapshotVersionRef.current !== status.activeVersion
        ) {
          setSnapshotDataVersion(version => version + 1);
        }
        snapshotVersionRef.current = status.activeVersion;
        hasSnapshotStatusRef.current = true;
      } catch (error) {
        if (!cancelled) console.error('[snapshot status] failed:', error);
      }
    };
    ignorePromise(poll());
    const timer = window.setInterval(poll, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const mergeInventoryRows = useCallback((rows: InventoryRow[]) => {
    if (rows.length === 0) return;
    setInventoryByRegistrationId(previous => {
      const next = new Map(previous);
      rows.forEach(row => {
        if (row.registrationId) next.set(row.registrationId, row);
      });
      inventoryByRegistrationIdRef.current = next;
      return next;
    });
  }, []);

  const loadInventoryForRegistrations = useCallback(async (
    registrationList: Registration[],
    signal?: AbortSignal
  ) => {
    const registrationIds = registrationList
      .map(registration => registration.id)
      .filter(id =>
        id &&
        !inventoryByRegistrationIdRef.current.has(id) &&
        !pendingInventoryRequestIdsRef.current.has(id)
      );
    if (registrationIds.length === 0) return;

    registrationIds.forEach(id => pendingInventoryRequestIdsRef.current.add(id));
    setIsInventoryLoading(true);
    try {
      const rows = await api.inventory.query(registrationIds, signal);
      if (!signal?.aborted) mergeInventoryRows(rows);
    } catch (error) {
      if (!signal?.aborted) console.error('[inventory] scoped load failed:', error);
    } finally {
      registrationIds.forEach(id => pendingInventoryRequestIdsRef.current.delete(id));
      if (pendingInventoryRequestIdsRef.current.size === 0) setIsInventoryLoading(false);
    }
  }, [mergeInventoryRows]);

  useEffect(() => {
    let cancelled = false;
    const targetMonth = getCarrySnapshotMonth();
    api.actuals.list(targetMonth, targetMonth).then(rows => {
      if (cancelled) return;
      const map = new Map<string, CarrySnapshot>();
      rows.forEach(row => {
        map.set(row.registrationId, {
          carryInETD: row.carryInETD,
          carryOutETD: row.carryOutETD,
          carryInLoading: row.carryInLoading,
          carryOutLoading: row.carryOutLoading,
        });
      });
      setCarrySnapshotByRegistrationId(map);
    }).catch(error => {
      console.error('[carry snapshot] failed to load:', error);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRefreshSnapshot = useCallback(async () => {
    if (isRefreshingSnapshot) return;
    setIsRefreshingSnapshot(true);
    loadStart();
    try {
      const status = await api.sync.refresh();
      setSnapshotStatus(status);
      snapshotVersionRef.current = status.activeVersion;
      setSnapshotDataVersion(version => version + 1);
    } catch (error) {
      setAppError(error instanceof ApiError ? error.message : 'Failed to refresh source data');
    } finally {
      setIsRefreshingSnapshot(false);
      loadDone();
    }
  }, [isRefreshingSnapshot, loadDone, loadStart]);

  const serverRegistrationFilters = useMemo(
    () => Object.fromEntries(
      (Object.entries(columnFilters) as Array<[string, ColumnFilterValue]>)
        .filter(([key, filter]) =>
          key !== 'priceFormula' &&
          key !== 'spread' &&
          !key.startsWith('carry') &&
          !key.startsWith('inventory') &&
          filter.selectedValues.length > 0
        )
        .map(([key, filter]) => [key, filter.selectedValues])
    ),
    [columnFilters]
  );
  const serverRegistrationFilterKey = useMemo(
    () => JSON.stringify(serverRegistrationFilters),
    [serverRegistrationFilters]
  );
  const serverRegistrationFiltersRef = useRef(serverRegistrationFilters);
  useEffect(() => {
    serverRegistrationFiltersRef.current = serverRegistrationFilters;
  }, [serverRegistrationFilters]);
  useEffect(() => {
    const mode = ensureCanonicalModeInUrl();
    setActiveClientAppMode(mode);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const mode = getActiveClientAppMode();
    setActiveClientAppMode(mode);
    api.appConfig.get()
      .then(config => {
        if (cancelled) return;
        setAppConfig(config);
        setActiveClientAppMode(config.appMode);
        document.title = config.displayName;
        const allowed = new Set(config.allowedBusinessUnits.map(value => value.toLowerCase()));
        setColumnFilters(prev => {
          const stored = loadStoredBusinessUnitFilter(config.appMode);
          const selectedValues = (stored.businessUnit?.selectedValues?.length
            ? stored.businessUnit.selectedValues
            : prev.businessUnit?.selectedValues ?? []
          ).filter(value => allowed.has(value.toLowerCase()));
          if (selectedValues.length === 0) {
            if (!prev.businessUnit) return prev;
            const { businessUnit: _removed, ...rest } = prev;
            return rest;
          }
          return {
            ...prev,
            businessUnit: { searchText: '', selectedValues },
          };
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    try {
      const selectedValues = columnFilters.businessUnit?.selectedValues ?? [];
      const key = businessUnitStorageKey(appConfig?.appMode);
      if (selectedValues.length > 0) {
        globalThis.localStorage.setItem(key, JSON.stringify(selectedValues));
      } else {
        globalThis.localStorage.removeItem(key);
      }
    } catch {
      // Local storage is optional; filters still work without persistence.
    }
  }, [columnFilters.businessUnit?.selectedValues, appConfig?.appMode]);
  const loadFilterOptions = useCallback(
    (columnKey: string, search: string, cursor?: string | null) =>
      api.registrations.filterOptions(
        columnKey,
        search,
        serverRegistrationFilters,
        cursor
      ),
    [serverRegistrationFilters]
  );

  // Content-stable key so Set/callback identity does NOT churn when
  // registrations is replaced with an equivalent list (prevents reload loops).
  const policyDrivenRegistrationKey = useMemo(() => {
    const ids: string[] = [];
    for (const registration of registrations) {
      const isPolymer = String(registration.businessUnit ?? '').toLowerCase() === 'polymer';
      if (!isPolymer) continue;
      const policy = normalizePricingPolicy(
        pricingPolicyMap.has(registration.id)
          ? pricingPolicyMap.get(registration.id)
          : registration.pricingPolicy
      );
      const spread = spreadMap.has(registration.id)
        ? spreadMap.get(registration.id)
        : registration.spread;
      if (policy || isCostPlus5Spread(spread)) ids.push(registration.id);
    }
    ids.sort();
    return ids.join('\0');
  }, [pricingPolicyMap, registrations, spreadMap]);

  const policyDrivenRegistrationIds = useMemo(
    () => new Set(policyDrivenRegistrationKey ? policyDrivenRegistrationKey.split('\0') : []),
    [policyDrivenRegistrationKey],
  );

  const polymerRegistrationIdsKey = useMemo(() => {
    return registrations
      .filter(registration => String(registration.businessUnit ?? '').toLowerCase() === 'polymer')
      .map(registration => registration.id)
      .filter(Boolean)
      .sort()
      .join('\0');
  }, [registrations]);

  const applyPriceStateFromForecasts = useCallback((forecasts: ForecastValue[]) => {
    const { fixedPrices, formulas } = seedPriceStateFromForecasts(
      forecasts,
      policyDrivenRegistrationIds,
    );
    if (fixedPrices.size > 0) {
      setFixedPriceMap(previous => {
        const next = new Map(previous);
        for (const [regId, prices] of fixedPrices) {
          const regPrices = new Map<string, number>(previous.get(regId));
          for (const [pricingMonth, price] of prices) {
            regPrices.set(pricingMonth, price);
          }
          next.set(regId, regPrices);
        }
        return next;
      });
    }
    if (formulas.size > 0) {
      setFormulaMap(previous => {
        const next = new Map(previous);
        for (const [regId, formula] of formulas) {
          next.set(regId, formula);
        }
        return next;
      });
    }
  }, [policyDrivenRegistrationIds]);

  const mergeForecastChunk = useCallback((
    forecasts: ForecastValue[],
    options?: { seedPriceState?: boolean },
  ) => {
    if (forecasts.length === 0) return;
    setForecastData(previous => {
      const next = [...previous];
      const position = new Map(
        next.map((item, index) => [
          `${item.registrationId}|${item.version}|${item.month}`,
          index,
        ])
      );

      for (const item of forecasts) {
        const key = `${item.registrationId}|${item.version}|${item.month}`;
        const knownIndex = position.get(key);
        const existing = knownIndex !== undefined ? next[knownIndex] : undefined;
        if (
          existing &&
          existing.registrationId === item.registrationId &&
          existing.version === item.version &&
          existing.month === item.month
        ) {
          next[knownIndex] = {
            ...existing,
            qtyFcst: item.qtyFcst,
            priceFcst: item.priceFcst,
            amountFcst: item.amountFcst ?? existing.amountFcst,
          };
        } else {
          position.set(key, next.length);
          next.push({
            ...item,
            qtyAct: existing?.qtyAct ?? item.qtyAct ?? 0,
            priceAct: existing?.priceAct ?? item.priceAct ?? 0,
            amountAct: existing?.amountAct ?? item.amountAct,
            carryInETD: existing?.carryInETD ?? item.carryInETD,
            carryOutETD: existing?.carryOutETD ?? item.carryOutETD,
            carryInLoading: existing?.carryInLoading ?? item.carryInLoading,
            carryOutLoading: existing?.carryOutLoading ?? item.carryOutLoading,
          });
        }
      }

      forecastPositionRef.current = position;
      forecastDataRef.current = next;
      return next;
    });
    if (options?.seedPriceState) {
      applyPriceStateFromForecasts(forecasts);
    }
  }, [applyPriceStateFromForecasts]);

  const abortForecastBackgroundLoad = useCallback(() => {
    forecastBackgroundAbortRef.current?.abort();
    forecastBackgroundAbortRef.current = null;
  }, []);

  const markForecastScopeCached = useCallback((
    version: string,
    dateRange: { start: string; end: string },
    forecastMode: 'month' | 'week' | 'day',
    registrationSig: string,
    entry: Pick<ForecastScopeCacheEntry, 'fcstFetched' | 'fcstPriorityLoaded'>,
  ) => {
    forecastScopeCacheRef.current.scopes.set(
      buildForecastScopeKey(version, dateRange, forecastMode),
      {
        loadedAt: Date.now(),
        registrationSig,
        fcstFetched: entry.fcstFetched,
        fcstPriorityLoaded: entry.fcstPriorityLoaded,
      },
    );
  }, []);

  const startForecastPhasedLoad = useCallback(({
    registrationIds,
    dateRange,
    version,
    forecastMode,
    signal,
    seedPriceStateOnFirstChunk = true,
    priorityRegistrationIds,
    silent = false,
    onPriorityReady,
  }: {
    registrationIds: string[];
    dateRange: { start: string; end: string };
    version: string;
    forecastMode: 'month' | 'week' | 'day';
    signal?: AbortSignal;
    seedPriceStateOnFirstChunk?: boolean;
    priorityRegistrationIds?: string[];
    silent?: boolean;
    onPriorityReady?: () => void;
  }): { priorityComplete: Promise<void>; allComplete: Promise<void> } => {
    const orderedIds = orderRegistrationIdsForFetch(
      registrationIds,
      priorityRegistrationIds ?? displayedRegistrationIdsRef.current,
    );
    const priorityIds = orderedIds.slice(0, FORECAST_PRIORITY_REGISTRATION_COUNT);
    const remainderIds = orderedIds.slice(FORECAST_PRIORITY_REGISTRATION_COUNT);
    const remainderChunkCount = remainderIds.length > 0
      ? Math.ceil(remainderIds.length / FORECAST_BACKGROUND_CHUNK_SIZE)
      : 0;
    const totalChunks = (priorityIds.length > 0 ? 1 : 0) + remainderChunkCount;

    let resolvePriority!: () => void;
    let rejectPriority!: (error: unknown) => void;
    const priorityComplete = new Promise<void>((resolve, reject) => {
      resolvePriority = resolve;
      rejectPriority = reject;
    });

    const allComplete = (async () => {
      const scopedQuery = buildScopedForecastQuery(registrationIds, dateRange, version, forecastMode);

      const fetchIds = async (
        ids: string[],
        chunkIndex: number,
        seedPriceState: boolean,
      ) => {
        if (ids.length === 0 || signal?.aborted) return;
        const rows = await api.forecast.query({
          version: scopedQuery.version,
          startPeriod: scopedQuery.startPeriod,
          endPeriod: scopedQuery.endPeriod,
          granularity: scopedQuery.granularity,
          registrationIds: ids,
          signal,
        });
        mergeForecastChunk(rows, { seedPriceState });
        if (!silent && totalChunks > 0) {
          setForecastLoadProgress({
            active: chunkIndex + 1 < totalChunks,
            completedChunks: chunkIndex + 1,
            totalChunks,
            version,
          });
        }
      };

      try {
        if (!silent && totalChunks > 0) {
          setForecastLoadProgress({
            active: true,
            completedChunks: 0,
            totalChunks,
            version,
          });
        }

        if (priorityIds.length > 0) {
          await fetchIds(priorityIds, 0, seedPriceStateOnFirstChunk);
        }
        onPriorityReady?.();
        resolvePriority();

        let chunkIndex = 1;
        for (let offset = 0; offset < remainderIds.length; offset += FORECAST_BACKGROUND_CHUNK_SIZE) {
          if (signal?.aborted) return;
          const chunkIds = remainderIds.slice(offset, offset + FORECAST_BACKGROUND_CHUNK_SIZE);
          await fetchIds(chunkIds, chunkIndex, false);
          chunkIndex += 1;
        }
      } catch (error) {
        rejectPriority(error);
        throw error;
      } finally {
        if (!silent) {
          setForecastLoadProgress(null);
        }
      }
    })();

    return { priorityComplete, allComplete };
  }, [mergeForecastChunk]);

  const prefetchOtherForecastVersions = useCallback(({
    registrationIds,
    dateRange,
    forecastMode,
    versionsToLoad,
    activeVersion,
    registrationSig,
    priorityRegistrationIds,
  }: {
    registrationIds: string[];
    dateRange: { start: string; end: string };
    forecastMode: 'month' | 'week' | 'day';
    versionsToLoad: string[];
    activeVersion: string;
    registrationSig: string;
    priorityRegistrationIds?: string[];
  }) => {
    const otherVersions = versionsToLoad.filter(version => version !== activeVersion);
    if (otherVersions.length === 0) return;

    abortForecastBackgroundLoad();
    const controller = new AbortController();
    forecastBackgroundAbortRef.current = controller;

    ignorePromise((async () => {
      for (const version of otherVersions) {
        if (controller.signal.aborted) return;
        const scopeKey = buildForecastScopeKey(version, dateRange, forecastMode);
        const cached = forecastScopeCacheRef.current.scopes.get(scopeKey);
        if (
          cached?.registrationSig === registrationSig &&
          cached.fcstFetched &&
          hasForecastDataForScope(forecastDataRef.current, version, dateRange)
        ) {
          continue;
        }

        const { allComplete } = startForecastPhasedLoad({
          registrationIds,
          dateRange,
          version,
          forecastMode,
          signal: controller.signal,
          priorityRegistrationIds,
          seedPriceStateOnFirstChunk: false,
          silent: true,
        });
        await allComplete;
        if (controller.signal.aborted) return;
        markForecastScopeCached(version, dateRange, forecastMode, registrationSig, {
          fcstPriorityLoaded: true,
          fcstFetched: true,
        });
      }
    })().catch(error => {
      if (!controller.signal.aborted) {
        console.warn('[forecast prefetch] background load failed:', error);
      }
    }));
  }, [abortForecastBackgroundLoad, markForecastScopeCached, startForecastPhasedLoad]);

  const loadAllForecastVersions = useCallback(async ({
    registrationIds,
    dateRange,
    forecastMode,
    versionsToLoad,
    activeVersion,
    signal,
    priorityRegistrationIds,
    filterKey = '',
    waitForPriorityOnly = false,
  }: {
    registrationIds: string[];
    dateRange: { start: string; end: string };
    forecastMode: 'month' | 'week' | 'day';
    versionsToLoad: string[];
    activeVersion: string;
    signal?: AbortSignal;
    priorityRegistrationIds?: string[];
    filterKey?: string;
    waitForPriorityOnly?: boolean;
  }) => {
    if (registrationIds.length === 0 || versionsToLoad.length === 0) return;

    const registrationSig = buildRegistrationLoadSignature(
      forecastWriteEpochRef.current,
      registrationIds,
      filterKey,
    );
    forecastScopeCacheRef.current.registrationSig = registrationSig;

    const activeScopeKey = buildForecastScopeKey(activeVersion, dateRange, forecastMode);
    const cachedActive = forecastScopeCacheRef.current.scopes.get(activeScopeKey);
    const activeIsFresh = cachedActive?.registrationSig === registrationSig
      && cachedActive.fcstFetched
      && hasForecastDataForScope(forecastDataRef.current, activeVersion, dateRange);

    if (!activeIsFresh) {
      const { priorityComplete, allComplete } = startForecastPhasedLoad({
        registrationIds,
        dateRange,
        version: activeVersion,
        forecastMode,
        signal,
        priorityRegistrationIds,
        seedPriceStateOnFirstChunk: true,
        silent: false,
        onPriorityReady: () => {
          markForecastScopeCached(activeVersion, dateRange, forecastMode, registrationSig, {
            fcstPriorityLoaded: true,
            fcstFetched: false,
          });
        },
      });

      await priorityComplete;
      if (waitForPriorityOnly) {
        ignorePromise(allComplete.then(() => {
          if (signal?.aborted) return;
          markForecastScopeCached(activeVersion, dateRange, forecastMode, registrationSig, {
            fcstPriorityLoaded: true,
            fcstFetched: true,
          });
        }).catch(error => {
          if (!signal?.aborted) console.warn('[forecast] background active load failed:', error);
        }));
      } else {
        await allComplete;
        if (!signal?.aborted) {
          markForecastScopeCached(activeVersion, dateRange, forecastMode, registrationSig, {
            fcstPriorityLoaded: true,
            fcstFetched: true,
          });
        }
      }
    }

    prefetchOtherForecastVersions({
      registrationIds,
      dateRange,
      forecastMode,
      versionsToLoad,
      activeVersion,
      registrationSig,
      priorityRegistrationIds,
    });
  }, [markForecastScopeCached, prefetchOtherForecastVersions, startForecastPhasedLoad]);

  const mergeLoadedForecastData = useCallback((
    forecasts: ForecastValue[],
    actuals: ActualValue[],
    activeVersions: string[]
  ) => {
    const actualOnlyRegistrations = actuals
      .map(actual => actual.registration)
      .filter((registration): registration is Registration => Boolean(registration));
    const matchedRegistrationIds = new Set(
      actuals
        .filter(actual => actual.sourceStatus === 'matched')
        .map(actual => actual.registrationId)
    );
    if (actualOnlyRegistrations.length > 0 || matchedRegistrationIds.size > 0) {
      setRegistrations(previous => {
        const next = new Map(previous.map(registration => [
          registration.id,
          matchedRegistrationIds.has(registration.id)
            ? { ...registration, sourceStatus: 'matched' as const }
            : registration,
        ]));
        actualOnlyRegistrations.forEach(registration => next.set(registration.id, registration));
        return Array.from(next.values());
      });
    }

    setForecastData(previous => {
      const next = new Map<string, ForecastValue>(
        previous.map(item => [`${item.registrationId}|${item.version}|${item.month}`, item])
      );

      forecasts.forEach(item => {
        next.set(`${item.registrationId}|${item.version}|${item.month}`, item);
      });

      actuals.forEach(actual => {
        activeVersions.forEach(version => {
          const key = `${actual.registrationId}|${version}|${actual.month}`;
          const existing = next.get(key);
          next.set(key, {
            registrationId: actual.registrationId,
            month: actual.month,
            version,
            qtyFcst: existing?.qtyFcst ?? 0,
            ...existing,
            qtyAct: actual.qtyAct,
            priceAct: actual.priceAct,
            amountAct: actual.amountAct,
            carryInETD: actual.carryInETD,
            carryOutETD: actual.carryOutETD,
            carryInLoading: actual.carryInLoading,
            carryOutLoading: actual.carryOutLoading,
          });
        });
      });

      return Array.from(next.values());
    });

    const { fixedPrices, formulas } = seedPriceStateFromForecasts(
      forecasts,
      policyDrivenRegistrationIds,
    );
    if (fixedPrices.size > 0) {
      setFixedPriceMap(previous => {
        const next = new Map(previous);
        for (const [regId, prices] of fixedPrices) {
          const regPrices = new Map<string, number>(previous.get(regId));
          for (const [pricingMonth, price] of prices) {
            regPrices.set(pricingMonth, price);
          }
          next.set(regId, regPrices);
        }
        return next;
      });
    }
    if (formulas.size > 0) {
      setFormulaMap(previous => {
        const next = new Map(previous);
        for (const [regId, formula] of formulas) {
          next.set(regId, formula);
        }
        return next;
      });
    }
  }, [policyDrivenRegistrationIds]);

  const mergeActualsIntoForecastState = useCallback((
    acts: ActualValue[],
    range: { startMonth: string; endMonth: string },
    mode: 'month' | 'week' | 'day',
  ) => {
    const { startMonth, endMonth } = range;
    const actualOnlyRegistrations = acts
      .map(actual => actual.registration)
      .filter((registration): registration is Registration => Boolean(registration));
    const matchedRegistrationIds = new Set(
      acts
        .filter(actual => actual.sourceStatus === 'matched')
        .map(actual => actual.registrationId)
    );
    setRegistrations(previous => {
      const next = new Map(
        previous
          .filter(registration => registration.sourceStatus !== 'actual_only')
          .map(registration => [
            registration.id,
            matchedRegistrationIds.has(registration.id)
              ? { ...registration, sourceStatus: 'matched' as const }
              : { ...registration, sourceStatus: 'registration_only' as const },
          ])
      );
      actualOnlyRegistrations.forEach(registration => next.set(registration.id, registration));
      return Array.from(next.values());
    });

    const activeVersions = versionsRef.current.length > 0
      ? versionsRef.current
      : ['Current Forecast'];
    const actualMap = new Map(
      acts.map(actual => [`${actual.registrationId}|${actual.month}`, actual])
    );

    setForecastData(previous => {
      const next = new Map<string, ForecastValue>();

      previous.forEach(item => {
        const isRequestedPeriod = mode === 'week'
          ? /^\d{4}-\d{2}-\d{2}$/.test(item.month)
          : /^\d{4}-\d{2}$/.test(item.month);
        const isInRequestedRange =
          isRequestedPeriod &&
          item.month.slice(0, 7) >= startMonth &&
          item.month.slice(0, 7) <= endMonth;
        const actual = isInRequestedRange
          ? actualMap.get(`${item.registrationId}|${item.month}`)
          : undefined;

        next.set(`${item.registrationId}|${item.version}|${item.month}`, {
          ...item,
          ...(isInRequestedRange
            ? {
                qtyAct: actual?.qtyAct ?? 0,
                priceAct: actual?.priceAct ?? 0,
                amountAct: actual?.amountAct ?? 0,
                carryInETD: actual?.carryInETD ?? 0,
                carryOutETD: actual?.carryOutETD ?? 0,
                carryInLoading: actual?.carryInLoading ?? 0,
                carryOutLoading: actual?.carryOutLoading ?? 0,
              }
            : {}),
        });
      });

      acts.forEach(actual => {
        activeVersions.forEach(version => {
          const key = `${actual.registrationId}|${version}|${actual.month}`;
          if (next.has(key)) return;
          next.set(key, {
            registrationId: actual.registrationId,
            month: actual.month,
            version,
            qtyAct: actual.qtyAct,
            qtyFcst: 0,
            priceAct: actual.priceAct,
            amountAct: actual.amountAct,
            carryInETD: actual.carryInETD,
            carryOutETD: actual.carryOutETD,
            carryInLoading: actual.carryInLoading,
            carryOutLoading: actual.carryOutLoading,
          });
        });
      });

      return Array.from(next.values());
    });
  }, []);

  const refreshActualsForLoadedRegistrations = useCallback(async (signal?: AbortSignal) => {
    if (!initialForecastLoadCompleteRef.current) return;
    const registrationIds = registrationsRef.current.map(registration => registration.id);
    if (registrationIds.length === 0) return;

    const { start, end } = dateRangeRef.current;
    const startMonth = start.slice(0, 7);
    const endMonth = end.slice(0, 7);
    const mode = forecastModeRef.current;
    const actualGranularity = mode === 'week' ? 'week' : 'month';
    const acts = await api.actuals.list(
      startMonth,
      endMonth,
      registrationIds,
      serverRegistrationFiltersRef.current,
      actualGranularity,
      signal
    );
    mergeActualsIntoForecastState(acts, { startMonth, endMonth }, mode);
  }, [mergeActualsIntoForecastState]);

  useEffect(() => {
    customColumnValuesRef.current = customColumnValues;
  }, [customColumnValues]);

  useEffect(() => {
    let cancelled = false;
    api.customColumns.list()
      .then(columns => {
        if (!cancelled) setCustomColumnDefs(columns);
      })
      .catch(error => {
        if (!cancelled) {
          console.error('[custom-columns] initial load failed:', error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (customColumnDefs.length === 0) return;
    const pendingIds = registrations
      .map(registration => registration.id)
      .filter(id => !loadedCustomValueRegistrationIdsRef.current.has(id));
    if (pendingIds.length === 0) return;

    let cancelled = false;
    ignorePromise(
      queryCustomColumnValuesInChunks(pendingIds).then(rows => {
        if (cancelled) return;
        for (const id of pendingIds) {
          loadedCustomValueRegistrationIdsRef.current.add(id);
        }
        setCustomColumnValues(previous => mergeCustomColumnValues(previous, rows));
      }).catch(error => {
        if (!cancelled) {
          console.error('[custom-columns] value load failed:', error);
        }
      }),
    );

    return () => {
      cancelled = true;
    };
  }, [customColumnDefs, registrations]);

  useEffect(() => {
    if (!manageRegistrationOpen) return;

    let cancelled = false;
    api.registrations.managed()
      .then(managed => {
        if (cancelled) return;
        setManagedRegistrations(managed);
        if (managed.length === 0) return;
        setRegistrations(previous => {
          const byId = new Map(previous.map(registration => [registration.id, registration]));
          for (const registration of managed) {
            byId.set(registration.id, registration);
          }
          return [...byId.values()];
        });
      })
      .catch(error => {
        if (cancelled) return;
        setAppError(formatApiError(error, 'Failed to refresh new registrations'));
      });

    return () => {
      cancelled = true;
    };
  }, [manageRegistrationOpen]);

  // Keep latest callbacks in refs so data-loading effects do NOT re-run when
  // callback identities churn (this previously caused an infinite reload loop
  // that flooded the API and exhausted the DB connection pool).
  const loadAllForecastVersionsRef = useRef(loadAllForecastVersions);
  useEffect(() => {
    loadAllForecastVersionsRef.current = loadAllForecastVersions;
  }, [loadAllForecastVersions]);
  const mergeLoadedForecastDataRef = useRef(mergeLoadedForecastData);
  useEffect(() => {
    mergeLoadedForecastDataRef.current = mergeLoadedForecastData;
  }, [mergeLoadedForecastData]);
  const loadInventoryForRegistrationsRef = useRef(loadInventoryForRegistrations);
  useEffect(() => {
    loadInventoryForRegistrationsRef.current = loadInventoryForRegistrations;
  }, [loadInventoryForRegistrations]);
  const abortForecastBackgroundLoadRef = useRef(abortForecastBackgroundLoad);
  useEffect(() => {
    abortForecastBackgroundLoadRef.current = abortForecastBackgroundLoad;
  }, [abortForecastBackgroundLoad]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const generation = registrationLoadGenerationRef.current;
    async function load() {
      try {
        pendingInventoryRequestIdsRef.current.clear();
        mergedRegistrationCacheRef.current.clear();
        inventoryByRegistrationIdRef.current = new Map();
        setInventoryByRegistrationId(new Map());
        initialForecastLoadCompleteRef.current = false;
        setInitialForecastLoadComplete(false);
        hasSkippedInitialForecastScopeRefreshRef.current = false;
        setIsLoading(true);
        loadStart();
        setAppError(null);
        const [registrationPage, cpls, vers] = await Promise.all([
          api.registrations.page(
            null,
            REGISTRATION_PAGE_SIZE,
            serverRegistrationFiltersRef.current,
            controller.signal,
          ),
          api.cpl.list(),
          api.versions.list(),
        ]);
        if (cancelled) return;
        const allVers = vers.length > 0 ? vers : ['Current Forecast'];
        const allRegistrations = registrationPage.items;
        setVersions(allVers);
        setSelectedVersion(previous =>
          allVers.includes(previous) ? previous : allVers[0]
        );
        setPriceManagementVersion(previous =>
          allVers.includes(previous) ? previous : allVers[0]
        );
        if (generation !== registrationLoadGenerationRef.current) return;
        setRegistrations(allRegistrations);
        ignorePromise(
          api.registrations.managed()
            .then(managed => {
              if (cancelled || generation !== registrationLoadGenerationRef.current) return;
              setManagedRegistrations(managed);
              if (managed.length === 0) return;
              setRegistrations(previous => {
                const byId = new Map(previous.map(registration => [registration.id, registration]));
                for (const registration of managed) {
                  byId.set(registration.id, registration);
                }
                return [...byId.values()];
              });
            })
            .catch(error => {
              if (!cancelled) console.error('[managed registrations] background load failed:', error);
            })
        );
        setRegistrationCursor(registrationPage.nextCursor);
        setHasMoreRegistrations(registrationPage.hasMore);
        setCplPrices(cpls);
        setNaphthaprices(cpls.map(c => ({ month: c.month, price: 0 })));
        setBenzeneprices(cpls.map(c => ({ month: c.month, price: 0 })));
        setPriceManagementRows(mapLegacyCplPrices(cpls));
        setIsLoading(false);
        loadDone();

        const registrationIds = allRegistrations.map(reg => reg.id);
        if (registrationIds.length === 0) return;
        ignorePromise(loadInventoryForRegistrationsRef.current(allRegistrations, controller.signal));

        setIsTableDataLoading(true);
        const versionForInitialLoad = selectedVersionRef.current;
        const rangeForInitialLoad = dateRangeRef.current;
        const modeForInitialLoad = forecastModeRef.current;
        const actualsPromise = api.actuals.list(
          rangeForInitialLoad.start.slice(0, 7),
          rangeForInitialLoad.end.slice(0, 7),
          registrationIds,
          serverRegistrationFiltersRef.current,
          modeForInitialLoad,
          controller.signal
        );
        await loadAllForecastVersionsRef.current({
          registrationIds,
          dateRange: rangeForInitialLoad,
          forecastMode: modeForInitialLoad,
          versionsToLoad: allVers,
          activeVersion: versionForInitialLoad,
          signal: controller.signal,
          priorityRegistrationIds: buildForecastPriorityIds(registrationIds, registrationIds),
          filterKey: JSON.stringify(serverRegistrationFiltersRef.current),
          waitForPriorityOnly: true,
        });
        setIsTableDataLoading(false);
        setForecastLoadProgress(null);
        const actuals = await actualsPromise;
        if (!cancelled && generation === registrationLoadGenerationRef.current) {
          mergeLoadedForecastDataRef.current([], actuals, allVers);
          initialForecastLoadCompleteRef.current = true;
          setInitialForecastLoadComplete(true);
          hasSkippedInitialForecastScopeRefreshRef.current = true;
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          const msg = error instanceof ApiError ? error.message : 'Failed to load data. Is the API server running?';
          setAppError(msg);
          setVersions([CURRENT_FORECAST_VERSION]);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
          setIsTableDataLoading(false);
          setForecastLoadProgress(null);
        }
        loadDone();
      }
    }
    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Initial mount load only. Re-loads triggered by filters/date/version are
    // handled by the dedicated effect below; depending on callback identities
    // here caused an infinite reload loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeTab !== 'master') return;

    let cancelled = false;
    const controller = new AbortController();
    async function loadPriceManagement() {
      try {
        const rows = await loadPriceManagementData(
          selectedFy,
          priceManagementType,
          priceManagementVersion,
          controller.signal,
        );
        if (cancelled) return;
        setPriceManagementRows(rows);
        setAppError(null);
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setAppError(error instanceof Error ? error.message : 'Failed to load Price Management data');
        }
      }
    }

    loadPriceManagement();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeTab, priceManagementType, priceManagementVersion, selectedFy]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function loadForecastPrices() {
      try {
        const prices = await loadForecastPriceData(
          dateRange.start.slice(0, 7),
          dateRange.end.slice(0, 7),
          selectedVersion,
          controller.signal,
        );
        if (cancelled) return;
        setCplPrices(prices.cpl);
        setNaphthaprices(prices.naphtha);
        setBenzeneprices(prices.benzene);
        setJpyRates(prices.jpy);
        setThbRates(prices.thb);
        setTecnonPrices(prices.tecnon);
        setPciPrices(prices.pci);
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          setAppError(error instanceof Error ? error.message : 'Failed to load forecast prices');
        }
      }
    }
    loadForecastPrices();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [dateRange.end, dateRange.start, selectedVersion]);

  // Seed pricingPolicyMap from loaded registrations (Polymer policies).
  useEffect(() => {
    setPricingPolicyMap(previous => {
      const next = new Map(previous);
      let changed = false;
      for (const registration of registrations) {
        if (next.has(registration.id)) continue;
        if (registration.pricingPolicy == null || registration.pricingPolicy === '') continue;
        next.set(registration.id, registration.pricingPolicy);
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [registrations]);

  // Latest Actual prices for Cost+5% Polymer pricing.
  useEffect(() => {
    const polymerIds = polymerRegistrationIdsKey
      ? polymerRegistrationIdsKey.split('\0')
      : [];
    if (polymerIds.length === 0) {
      setLatestActualPriceMap(new Map());
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    ignorePromise((async () => {
      try {
        const rows = await api.actuals.latestPrice(polymerIds, controller.signal);
        if (cancelled) return;
        setLatestActualPriceMap(new Map(rows.map(row => [row.registrationId, row.price])));
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          console.warn('[actuals] latest-price failed:', error);
        }
      }
    })());

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [polymerRegistrationIdsKey]);

  const loadMoreRegistrations = useCallback(async () => {
    if (isLoadingMoreRef.current || !hasMoreRegistrations || !registrationCursor) return;

    const generation = registrationLoadGenerationRef.current;
    const controller = new AbortController();
    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = controller;
    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    try {
      const page = await api.registrations.page(
        registrationCursor,
        REGISTRATION_PAGE_SIZE,
        serverRegistrationFilters,
        controller.signal
      );
      if (generation !== registrationLoadGenerationRef.current) return;
      const registrationIds = page.items.map(reg => reg.id);
      const activeVersions = versions.length > 0 ? versions : ['Current Forecast'];

      setRegistrations(previous => {
        const existingIds = new Set(previous.map(reg => reg.id));
        return [...previous, ...page.items.filter(reg => !existingIds.has(reg.id))];
      });
      setRegistrationCursor(page.nextCursor);
      setHasMoreRegistrations(page.hasMore);
      ignorePromise(loadInventoryForRegistrations(page.items, controller.signal));

      if (registrationIds.length > 0) {
        const actualsPromise = api.actuals.list(
          dateRange.start.slice(0, 7),
          dateRange.end.slice(0, 7),
          registrationIds,
          serverRegistrationFilters,
          forecastMode,
          controller.signal
        );
        const { priorityComplete, allComplete } = startForecastPhasedLoad({
          registrationIds,
          dateRange,
          version: selectedVersion,
          forecastMode,
          signal: controller.signal,
          priorityRegistrationIds: registrationIds,
          seedPriceStateOnFirstChunk: false,
          silent: true,
        });
        await priorityComplete;
        const actuals = await actualsPromise;
        if (generation === registrationLoadGenerationRef.current) {
          mergeLoadedForecastData([], actuals, activeVersions);
        }
        ignorePromise(allComplete.catch(error => {
          if (!controller.signal.aborted) {
            console.warn('[forecast] load-more background fill failed:', error);
          }
        }));
        prefetchOtherForecastVersions({
          registrationIds,
          dateRange,
          forecastMode,
          versionsToLoad: activeVersions,
          activeVersion: selectedVersion,
          registrationSig: buildRegistrationLoadSignature(
            forecastWriteEpochRef.current,
            registrationsRef.current.map(registration => registration.id),
            serverRegistrationFilterKey,
          ),
          priorityRegistrationIds: registrationIds,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof ApiError ? error.message : 'Failed to load more rows';
        setAppError(message);
      }
    } finally {
      if (loadMoreAbortRef.current === controller) loadMoreAbortRef.current = null;
      if (generation === registrationLoadGenerationRef.current) {
        isLoadingMoreRef.current = false;
        setIsLoadingMore(false);
        setForecastLoadProgress(null);
      }
    }
  }, [
    dateRange.end,
    dateRange.start,
    hasMoreRegistrations,
    loadInventoryForRegistrations,
    mergeLoadedForecastData,
    prefetchOtherForecastVersions,
    registrationCursor,
    serverRegistrationFilterKey,
    serverRegistrationFilters,
    startForecastPhasedLoad,
    versions,
    forecastMode,
    selectedVersion,
  ]);

  useEffect(() => {
    if (!hasSkippedInitialRegistrationFilterRef.current) {
      hasSkippedInitialRegistrationFilterRef.current = true;
      return;
    }

    const generation = registrationLoadGenerationRef.current + 1;
    registrationLoadGenerationRef.current = generation;
    loadedCustomValueRegistrationIdsRef.current.clear();
    loadMoreAbortRef.current?.abort();
    abortForecastBackgroundLoadRef.current();
    isLoadingMoreRef.current = false;
    setIsLoadingMore(false);
    setIsTableDataLoading(true);
    setForecastLoadProgress(null);
    forecastScopeCacheRef.current = { registrationSig: '', scopes: new Map() };
    setRegistrationCursor(null);
    setHasMoreRegistrations(false);

    const filters = serverRegistrationFiltersRef.current;
    const range = dateRangeRef.current;
    const mode = forecastModeRef.current;
    const version = selectedVersionRef.current;
    const activeVersions = versionsRef.current.length > 0
      ? versionsRef.current
      : ['Current Forecast'];

    let cancelled = false;
    const controller = new AbortController();
    async function loadFilteredRegistrations() {
      try {
        const registrationPage = await api.registrations.page(
          null,
          REGISTRATION_PAGE_SIZE,
          filters,
          controller.signal,
        );
        if (cancelled || generation !== registrationLoadGenerationRef.current) return;

        setRegistrations(registrationPage.items);
        setRegistrationCursor(registrationPage.nextCursor);
        setHasMoreRegistrations(registrationPage.hasMore);
        ignorePromise(loadInventoryForRegistrationsRef.current(registrationPage.items, controller.signal));

        const registrationIds = registrationPage.items.map(reg => reg.id);
        if (registrationIds.length === 0) return;

        const actualsPromise = api.actuals.list(
          range.start.slice(0, 7),
          range.end.slice(0, 7),
          registrationIds,
          filters,
          mode,
          controller.signal
        );
        await loadAllForecastVersionsRef.current({
          registrationIds,
          dateRange: range,
          forecastMode: mode,
          versionsToLoad: activeVersions,
          activeVersion: version,
          signal: controller.signal,
          priorityRegistrationIds: buildForecastPriorityIds(registrationIds, registrationIds),
          filterKey: serverRegistrationFilterKey,
          waitForPriorityOnly: true,
        });
        setIsTableDataLoading(false);
        setForecastLoadProgress(null);
        const actuals = await actualsPromise;
        if (
          !cancelled &&
          !controller.signal.aborted &&
          generation === registrationLoadGenerationRef.current
        ) {
          mergeLoadedForecastDataRef.current([], actuals, activeVersions);
        }
      } catch (error) {
        if (!cancelled && generation === registrationLoadGenerationRef.current) {
          const message = error instanceof ApiError ? error.message : 'Failed to apply filters';
          setAppError(message);
        }
      } finally {
        if (!cancelled && generation === registrationLoadGenerationRef.current) {
          setIsTableDataLoading(false);
          setForecastLoadProgress(null);
        }
      }
    }

    ignorePromise(loadFilteredRegistrations());
    return () => {
      cancelled = true;
      controller.abort();
      setForecastLoadProgress(null);
    };
  }, [
    serverRegistrationFilterKey,
    dateRange.start,
    dateRange.end,
    forecastMode,
    selectedVersion,
  ]);

  useEffect(() => {
    if (!hasSkippedInitialActualRefreshRef.current) {
      hasSkippedInitialActualRefreshRef.current = true;
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    loadMoreAbortRef.current?.abort();

    async function refreshActuals() {
      try {
        await refreshActualsForLoadedRegistrations(controller.signal);
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          const message = error instanceof ApiError ? error.message : 'Failed to refresh actual data';
          setAppError(message);
        }
      }
    }

    refreshActuals();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    dateRange.start,
    dateRange.end,
    serverRegistrationFilterKey,
    versions,
    forecastMode,
    snapshotDataVersion,
    refreshActualsForLoadedRegistrations,
  ]);

  useEffect(() => {
    if (activeTab !== 'forecast') return;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      ignorePromise(refreshActualsForLoadedRegistrations());
    }, 5 * 60 * 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeTab, refreshActualsForLoadedRegistrations]);

  useEffect(() => {
    if (!initialForecastLoadCompleteRef.current) return;
    if (!hasSkippedInitialForecastScopeRefreshRef.current) {
      hasSkippedInitialForecastScopeRefreshRef.current = true;
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    loadMoreAbortRef.current?.abort();

    async function refreshScopedForecast() {
      try {
        const registrationIds = registrationsRef.current.map(registration => registration.id);
        if (registrationIds.length === 0) return;

        const registrationSig = buildRegistrationLoadSignature(
          forecastWriteEpochRef.current,
          registrationIds,
          serverRegistrationFilterKey,
        );
        if (forecastScopeCacheRef.current.registrationSig !== registrationSig) {
          forecastScopeCacheRef.current = { registrationSig, scopes: new Map() };
        }
        const scopeKey = buildForecastScopeKey(selectedVersion, dateRange, forecastMode);
        const cachedScope = forecastScopeCacheRef.current.scopes.get(scopeKey);
        if (
          pendingEditsCountRef.current === 0 &&
          cachedScope?.registrationSig === registrationSig &&
          cachedScope.fcstFetched &&
          hasForecastDataForScope(forecastDataRef.current, selectedVersion, dateRange)
        ) {
          return;
        }

        const priorityIds = buildForecastPriorityIds(
          registrationIds,
          displayedRegistrationIdsRef.current,
        );

        if (
          pendingEditsCountRef.current === 0 &&
          cachedScope?.registrationSig === registrationSig &&
          cachedScope.fcstPriorityLoaded
        ) {
          ignorePromise((async () => {
            const { allComplete } = startForecastPhasedLoad({
              registrationIds,
              dateRange,
              version: selectedVersion,
              forecastMode,
              signal: controller.signal,
              priorityRegistrationIds: priorityIds,
              seedPriceStateOnFirstChunk: false,
              silent: true,
            });
            await allComplete;
            if (cancelled || controller.signal.aborted) return;
            markForecastScopeCached(selectedVersion, dateRange, forecastMode, registrationSig, {
              fcstPriorityLoaded: true,
              fcstFetched: true,
            });
          })().catch(error => {
            if (!cancelled && !controller.signal.aborted) {
              console.warn('[forecast] background version fill failed:', error);
            }
          }));
          return;
        }

        const { priorityComplete, allComplete } = startForecastPhasedLoad({
          registrationIds,
          dateRange,
          version: selectedVersion,
          forecastMode,
          signal: controller.signal,
          priorityRegistrationIds: priorityIds,
          seedPriceStateOnFirstChunk: false,
          silent: false,
          onPriorityReady: () => {
            markForecastScopeCached(selectedVersion, dateRange, forecastMode, registrationSig, {
              fcstPriorityLoaded: true,
              fcstFetched: false,
            });
            setForecastLoadProgress(null);
          },
        });
        await priorityComplete;
        if (cancelled || controller.signal.aborted) return;
        ignorePromise(allComplete.then(() => {
          if (cancelled || controller.signal.aborted) return;
          markForecastScopeCached(selectedVersion, dateRange, forecastMode, registrationSig, {
            fcstPriorityLoaded: true,
            fcstFetched: true,
          });
        }).catch(error => {
          if (!cancelled && !controller.signal.aborted) {
            const message = error instanceof ApiError ? error.message : 'Failed to refresh forecast data';
            setAppError(message);
          }
        }));
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) {
          const message = error instanceof ApiError ? error.message : 'Failed to refresh forecast data';
          setAppError(message);
        }
      } finally {
        if (!cancelled) {
          setForecastLoadProgress(null);
        }
      }
    }

    ignorePromise(refreshScopedForecast());
    return () => {
      cancelled = true;
      controller.abort();
      setForecastLoadProgress(null);
    };
  }, [
    dateRange.end,
    dateRange.start,
    forecastMode,
    initialForecastLoadComplete,
    markForecastScopeCached,
    startForecastPhasedLoad,
    selectedVersion,
    serverRegistrationFilterKey,
  ]);

  const openDatePicker = (input: HTMLInputElement | null) => {
    if (!input) return;
    if (typeof input.showPicker === 'function') {
      input.showPicker();
    } else {
      input.focus();
      input.click();
    }
  };

  const formatDayModeValue = (value: string) => {
    if (!value) return '';
    const [year, month, day] = value.split('-');
    return year && month && day ? `${day}/${month}/${year}` : value;
  };

  const parseDayModeValue = (value: string) => {
    const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const [, day, month, year] = match;
    const dayNum = Number(day);
    const monthNum = Number(month);
    const date = new Date(`${year}-${monthNum.toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`);
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() + 1 !== monthNum ||
      date.getDate() !== dayNum
    ) {
      return null;
    }
    return `${year}-${monthNum.toString().padStart(2, '0')}-${dayNum.toString().padStart(2, '0')}`;
  };

  const convertMonthRangeToDateRange = (range: { start: string; end: string }) => {
    const startDate = parseISO(`${range.start}-01`);
    const endDate = endOfMonth(parseISO(`${range.end}-01`));
    return {
      start: format(startDate, 'yyyy-MM-dd'),
      end: format(endDate, 'yyyy-MM-dd'),
    };
  };

  const convertDateRangeToMonthRange = (range: { start: string; end: string }) => ({
    start: format(parseISO(range.start), 'yyyy-MM'),
    end: format(parseISO(range.end), 'yyyy-MM'),
  });

  const handleForecastModeChange = (mode: 'month' | 'week' | 'day') => {
    if (mode === forecastMode) return;
    if (mode === 'week' && !isCurrentForecastVersion) return;

    setForecastMode(mode);
    // Only convert if switching TO/FROM month mode
    // Month uses 'yyyy-MM' format, Week/Day use 'yyyy-MM-dd' format
    if (mode === 'month' && forecastMode !== 'month') {
      // Converting TO month mode from any non-month mode
      setDateRange(prev => convertDateRangeToMonthRange(prev));
    } else if (mode !== 'month' && forecastMode === 'month') {
      // Converting FROM month mode to any non-month mode
      setDateRange(prev => convertMonthRangeToDateRange(prev));
    }
    // If both are non-month modes (week/day to day/week), keep dateRange as-is
  };

  const inventoryByMaterialKey = useMemo(
    () => {
      const map = new Map<string, InventoryRow>();
      inventoryByRegistrationId.forEach(row => {
        map.set(`${row.plantCode}|${row.materialCode}`, row);
      });
      return map;
    },
    [inventoryByRegistrationId]
  );

  const registrationsWithInventory = useMemo(
    () => registrations.map(registration => {
      const inventory =
        inventoryByRegistrationId.get(registration.id) ??
        inventoryByMaterialKey.get(`${registration.plantCode}|${registration.materialCode}`);
      const carry = carrySnapshotByRegistrationId.get(registration.id);
      if (!inventory && !carry) return registration;
      const cached = mergedRegistrationCacheRef.current.get(registration.id);
      if (cached?.registration === registration && cached?.inventory === inventory && cached?.carry === carry) {
        return cached.merged;
      }
      const merged = {
        ...registration,
        ...(inventory ? {
          inventoryA0Qty: inventory.a0Qty,
          inventoryNonA0Qty: inventory.nonA0Qty,
          inventoryWaitJudgeQty: inventory.waitJudgeQty,
          inventoryOgQty: inventory.ogQty,
          inventoryYoQty: inventory.yoQty,
          inventoryDate: inventory.inventoryDate,
        } : {}),
        ...(carry ? {
          carryInETD: carry.carryInETD,
          carryOutETD: carry.carryOutETD,
          carryInLoading: carry.carryInLoading,
          carryOutLoading: carry.carryOutLoading,
        } : {}),
      };
      mergedRegistrationCacheRef.current.set(registration.id, {
        registration,
        inventory,
        carry,
        merged,
      });
      return merged;
    }),
    [inventoryByMaterialKey, inventoryByRegistrationId, carrySnapshotByRegistrationId, registrations]
  );

  const filteredRegistrations = useMemo(() => {
    const clientOnlyFilters = Object.fromEntries(
      (Object.entries(columnFilters) as Array<[string, ColumnFilterValue]>)
        .filter(([key]) => key.startsWith('carry') || key.startsWith('inventory'))
    );
    let regs = filterRegistrations(registrationsWithInventory, clientOnlyFilters);
    if (formulaFilter.selectedValues.length > 0) {
      regs = regs.filter(reg =>
        formulaFilter.selectedValues.includes(formulaMap.get(reg.id) ?? 'CPL')
      );
    }
    const customColumnFilters = (Object.entries(columnFilters) as Array<[string, ColumnFilterValue]>)
      .filter(([key, filter]) => isCustomColumnFilterKey(key) && filter.selectedValues.length > 0);
    if (customColumnFilters.length > 0) {
      regs = regs.filter(reg =>
        customColumnFilters.every(([key, filter]) =>
          matchesCustomColumnFilter(
            reg.id,
            customColumnIdFromFilterKey(key),
            filter,
            customColumnValues,
          )
        )
      );
    }
    return regs;
  }, [columnFilters, customColumnValues, formulaFilter, formulaMap, registrationsWithInventory]);

  const displayedRegistrations = useMemo(() => {
    return filteredRegistrations;
  }, [filteredRegistrations]);

  useEffect(() => {
    displayedRegistrationIdsRef.current = displayedRegistrations.map(registration => registration.id);
  }, [displayedRegistrations]);

  const allDisplayedRegistrations = useMemo(
    () => registrationsWithInventory,
    [registrationsWithInventory]
  );

  useEffect(() => {
    if (!isCurrentForecastVersion && forecastMode === 'week') {
      setForecastMode('month');
      setDateRange(prev => convertDateRangeToMonthRange(prev));
    }
  }, [isCurrentForecastVersion, forecastMode]);

  const monthsToShow = useMemo(() => {
    const list: string[] = [];
    if (forecastMode === 'month') {
      const startDate = parseISO(dateRange.start + '-01');
      const endDate = parseISO(dateRange.end + '-01');
      let curr = startOfMonth(startDate);
      const end = startOfMonth(endDate);
      while (curr <= end) {
        list.push(format(curr, 'yyyy-MM'));
        curr = addMonths(curr, 1);
      }
    } else if (forecastMode === 'week') {
      const startMonthDate = startOfMonth(parseISO(dateRange.start));
      const endMonthDate = endOfMonth(parseISO(dateRange.end));
      const daysUntilWednesday = (3 - getDay(startMonthDate) + 7) % 7;
      let curr = addDays(startMonthDate, daysUntilWednesday);
      const end = endMonthDate;
      while (curr <= end) {
        list.push(format(curr, 'yyyy-MM-dd'));
        curr = addDays(curr, 7);
      }
    } else if (forecastMode === 'day') {
      let curr = parseISO(dateRange.start);
      const end = parseISO(dateRange.end);
      while (curr <= end) {
        list.push(format(curr, 'yyyy-MM-dd'));
        curr = addDays(curr, 1);
      }
    }
    return list;
  }, [dateRange, forecastMode]);

  const forecastSummaryRequest = useMemo<ForecastSummaryRequest>(() => {
    // formulaOverrides only affects the server total when a formula filter is
    // active. Building it unconditionally makes the request change every time a
    // new page seeds more non-CPL formulas, which needlessly refetches on scroll.
    const formulaOverrides: Record<string, string> = {};
    if (formulaFilter.selectedValues.length > 0) {
      formulaMap.forEach((formula, registrationId) => {
        if (formula !== 'CPL') formulaOverrides[registrationId] = formula;
      });
    }
    const carryFilters = Object.fromEntries(
      (Object.entries(columnFilters) as Array<[string, ColumnFilterValue]>)
        .filter(([key, filter]) => key.startsWith('carry') && filter.selectedValues.length > 0)
        .map(([key, filter]) => [key, filter.selectedValues])
    );
    // Intentionally omit registrationIds: the server computes the grand total from
    // the same filters. Scoping to the currently-loaded page IDs would refetch the
    // summary on every pagination step (and make the footer grow as you scroll).
    return {
      startMonth: dateRange.start.slice(0, 7),
      endMonth: dateRange.end.slice(0, 7),
      periods: monthsToShow,
      granularity: forecastMode === 'week' ? 'week' : 'month',
      version: selectedVersion,
      filters: serverRegistrationFilters,
      formulaFilter: formulaFilter.selectedValues,
      formulaOverrides,
      carryFilters,
    };
  }, [
    columnFilters,
    dateRange.end,
    dateRange.start,
    forecastMode,
    formulaFilter.selectedValues,
    formulaMap,
    monthsToShow,
    selectedVersion,
    serverRegistrationFilters,
  ]);
  const forecastSummaryRequestKey = useMemo(
    () => JSON.stringify(forecastSummaryRequest),
    [forecastSummaryRequest]
  );

  useEffect(() => {
    if (activeTab !== 'forecast' || monthsToShow.length === 0) return;

    const cacheKey = `${FORECAST_SUMMARY_CACHE_PREFIX}${getActiveClientAppMode()}:${forecastSummaryRequestKey}`;
    const cachedRaw = window.localStorage.getItem(cacheKey);
    let hasUsableCache = false;
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as {
          cachedAt: number;
          summary: ForecastSummary;
        };
        if (
          Date.now() - cached.cachedAt <= FORECAST_SUMMARY_CACHE_TTL_MS &&
          cached.summary?.periods
        ) {
          setForecastSummary(cached.summary);
          hasUsableCache = true;
        }
      } catch {
        window.localStorage.removeItem(cacheKey);
      }
    }
    if (!hasUsableCache) setForecastSummary(null);

    const controller = new AbortController();
    setIsForecastSummaryUpdating(true);
    api.forecast.summary(forecastSummaryRequest, controller.signal)
      .then(summary => {
        if (controller.signal.aborted) return;
        setForecastSummary(summary);
        window.localStorage.setItem(
          cacheKey,
          JSON.stringify({ cachedAt: Date.now(), summary })
        );
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error('[forecast summary] refresh failed:', error);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsForecastSummaryUpdating(false);
      });

    return () => controller.abort();
    // Depend on the stringified request content only. The memoized request object
    // gets a fresh reference whenever unrelated state (e.g. formulaMap growing as
    // pages load) changes, but as long as the content key is identical there is no
    // reason to refetch. forecastSummaryRequest is read inside and always matches
    // the current key because both are derived in the same render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    activeTab,
    forecastSummaryRequestKey,
    monthsToShow.length,
  ]);

  const displayedForecastSummary = useMemo<ForecastSummary | null>(() => {
    if (!forecastSummary) return null;
    const periods = forecastSummary.periods.map(period => ({ ...period }));
    const periodIndex = new Map(periods.map((period, index) => [period.period, index]));

    pendingEditValues(pendingForecastEdits).forEach(edit => {
      if (edit.version !== selectedVersion) return;
      const displayPeriod = forecastMode === 'month'
        ? edit.period.slice(0, 7)
        : edit.period;
      const index = periodIndex.get(displayPeriod);
      if (index === undefined) return;
      periods[index].qtyFcst += edit.currentValue - edit.baseValue;
    });

    return { ...forecastSummary, periods };
  }, [forecastMode, forecastSummary, pendingForecastEdits, selectedVersion]);

  const availableForecastModes = isCurrentForecastVersion
    ? (['month', 'week'] as const)
    : (['month'] as const);

  const filteredCplPrices = useMemo(() => {
    const fyStart = `${selectedFy}-04`;
    const fyEnd = `${selectedFy + 1}-03`;
    return priceManagementRows.map(row => ({ month: row.month, price: row.cplPrice }))
      .filter(c => c.month >= fyStart && c.month <= fyEnd)
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [priceManagementRows, selectedFy]);

  const filteredNaphtha = useMemo(() => {
    const fyStart = `${selectedFy}-04`;
    const fyEnd = `${selectedFy + 1}-03`;
    return priceManagementRows.map(row => ({ month: row.month, price: row.naphthaPrice }))
      .filter(c => c.month >= fyStart && c.month <= fyEnd)
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [priceManagementRows, selectedFy]);

  const filteredBenzene = useMemo(() => {
    const fyStart = `${selectedFy}-04`;
    const fyEnd = `${selectedFy + 1}-03`;
    return priceManagementRows.map(row => ({ month: row.month, price: row.benzenePrice }))
      .filter(c => c.month >= fyStart && c.month <= fyEnd)
      .sort((a, b) => a.month.localeCompare(b.month));
  }, [priceManagementRows, selectedFy]);

  const handleForecastChange = useCallback((regId: string, month: string, value: number) => {
    if (!Number.isFinite(value) || value < 0) return;
    const storagePeriod = getForecastStoragePeriod(month, forecastMode, selectedVersion);
    const editKey = `${regId}|${selectedVersion}|${month}`;
    const storageKey = `${regId}|${selectedVersion}|${storagePeriod}`;
    const knownIndex = forecastPositionRef.current.get(storageKey);
    const existing = knownIndex === undefined
      ? undefined
      : forecastDataRef.current[knownIndex];
    setPendingForecastEdits(previous => ({
      ...previous,
      [editKey]: {
        registrationId: regId,
        period: month,
        version: selectedVersion,
        baseValue: previous[editKey]?.baseValue ?? existing?.qtyFcst ?? 0,
        currentValue: value,
      },
    }));
    setForecastData(prev => {
      const indexedItem = knownIndex === undefined ? undefined : prev[knownIndex];
      const index = indexedItem &&
        indexedItem.registrationId === regId &&
        indexedItem.month === storagePeriod &&
        indexedItem.version === selectedVersion
        ? knownIndex
        : prev.findIndex(item =>
            item.registrationId === regId &&
            item.month === storagePeriod &&
            item.version === selectedVersion
          );

      if (index > -1) {
        const newData = [...prev];
        newData[index] = { ...newData[index], qtyFcst: value };
        return newData;
      } else {
        forecastPositionRef.current.set(storageKey, prev.length);
        return [...prev, {
          registrationId: regId,
          month: storagePeriod,
          version: selectedVersion,
          qtyAct: 0,
          qtyFcst: value,
          priceAct: 0,
        }];
      }
    });
  }, [forecastMode, selectedVersion]);

  const pendingForecastEditList = useMemo(
    () => pendingEditValues(pendingForecastEdits),
    [pendingForecastEdits]
  );

  const pendingPriceEditList = useMemo(
    () => pendingEditValues(pendingPriceEdits),
    [pendingPriceEdits]
  );

  const pendingAmountEditList = useMemo(
    () => pendingEditValues(pendingAmountEdits),
    [pendingAmountEdits]
  );

  const pendingCommitEditCount =
    pendingForecastEditList.length + pendingPriceEditList.length + pendingAmountEditList.length;
  pendingEditsCountRef.current = pendingCommitEditCount;

  const inventoryCommitPreviewRows = useMemo<InventoryCommitPreviewRow[]>(() => {
    const registrationsById = new Map<string, Registration>(
      registrationsWithInventory.map(registration => [registration.id, registration])
    );
    const pendingDeltaByMaterial = new Map<string, number>();
    pendingForecastEditList.forEach(edit => {
      const registration = registrationsById.get(edit.registrationId);
      if (!registration) return;
      const materialKey = `${registration.plantCode}|${registration.materialCode}`;
      pendingDeltaByMaterial.set(
        materialKey,
        (pendingDeltaByMaterial.get(materialKey) ?? 0) + (edit.currentValue - edit.baseValue)
      );
    });

    return pendingForecastEditList.map(edit => {
      const registration = registrationsById.get(edit.registrationId);
      const fallbackRegistration: Registration = registration ?? {
        id: edit.registrationId,
        businessUnit: '',
        ownerName: '',
        registrationTopic: edit.registrationId,
        onOffSpec: '',
        plantCode: '',
        countryName: '',
        materialDescription: '',
        materialCode: '',
        shipTo_name: '',
        soldTo_name: '',
        end_user: '',
        soldToCode: '',
        shipToCode: '',
        group: '',
        materialNameOnCoa: '',
        additionalRequirement: '',
        pic: '',
        commission: '',
        productDescription: '',
        classified: '',
        commissionIndirect: '',
        commissionFinancialDiscount: '',
        newCoaName: '',
        newTier1: '',
        newOem: '',
        packing: '',
        agreedSpecType: '',
        wasteScrap: '',
        forResaleNotApprove: '',
        imdsDate: '',
        model: '',
        createdOn: '',
        approve: '',
        partName: '',
        coaName: '',
        process: '',
        application: '',
        subApp: '',
        zoneName: '',
        plantName: '',
        countryCode: '',
        endUserCode: '',
        endUserExportControl: '',
        endUserName: '',
        productName: '',
        productNamePud: '',
        gradeUfa: '',
        gradeSap: '',
        column1: '',
        carryInETD: 0,
        carryOutETD: 0,
        carryInLoading: 0,
        carryOutLoading: 0,
        priceFormula: 'CPL',
        spread: null,
        pricingPolicy: null,
      };
      const materialKey = `${fallbackRegistration.plantCode}|${fallbackRegistration.materialCode}`;
      return {
        key: `${edit.registrationId}|${edit.version}|${edit.period}`,
        registration: fallbackRegistration,
        period: edit.period,
        baseValue: edit.baseValue,
        currentValue: edit.currentValue,
        delta: edit.currentValue - edit.baseValue,
        pendingMaterialDelta: pendingDeltaByMaterial.get(materialKey) ?? (edit.currentValue - edit.baseValue),
        inventory: inventoryByMaterialKey.get(materialKey),
      };
    });
  }, [inventoryByMaterialKey, pendingForecastEditList, registrationsWithInventory]);

  const executeCommitForecastUpdates = useCallback(() => {
    const qtyEditsToCommit = [...pendingForecastEditList];
    const priceEditsToCommit = [...pendingPriceEditList];
    const amountEditsToCommit = [...pendingAmountEditList];
    if (
      qtyEditsToCommit.length === 0 &&
      priceEditsToCommit.length === 0 &&
      amountEditsToCommit.length === 0
    ) return;

    const editKeys = new Set([
      ...qtyEditsToCommit.map(edit => `${edit.registrationId}|${edit.version}|${edit.period}`),
      ...priceEditsToCommit.map(edit => `${edit.registrationId}|${edit.version}|${edit.period}`),
      ...amountEditsToCommit.map(edit => `${edit.registrationId}|${edit.version}|${edit.period}`),
    ]);
    const qtyEditsByKey = new Map(
      qtyEditsToCommit.map(edit => [`${edit.registrationId}|${edit.version}|${edit.period}`, edit])
    );
    const priceEditsByKey = new Map(
      priceEditsToCommit.map(edit => [`${edit.registrationId}|${edit.version}|${edit.period}`, edit])
    );
    const amountEditsByKey = new Map(
      amountEditsToCommit.map(edit => [`${edit.registrationId}|${edit.version}|${edit.period}`, edit])
    );

    const updates: ForecastValue[] = [...editKeys].map(key => {
      const qtyEdit = qtyEditsByKey.get(key);
      const priceEdit = priceEditsByKey.get(key);
      const amountEdit = amountEditsByKey.get(key);
      const sample = qtyEdit ?? priceEdit ?? amountEdit;
      if (!sample) {
        throw new Error(`Missing pending edit for ${key}`);
      }
      const storagePeriod = getForecastStoragePeriod(sample.period, forecastMode, sample.version);
      const storageKey = `${sample.registrationId}|${sample.version}|${storagePeriod}`;
      const knownIndex = forecastPositionRef.current.get(storageKey);
      const existing = knownIndex === undefined
        ? undefined
        : forecastDataRef.current[knownIndex];

      return {
        registrationId: sample.registrationId,
        month: storagePeriod,
        version: sample.version,
        qtyAct: 0,
        qtyFcst: qtyEdit?.currentValue ?? existing?.qtyFcst ?? 0,
        priceFcst: priceEdit?.currentValue ?? existing?.priceFcst ?? 0,
        amountFcst: amountEdit?.currentValue ?? existing?.amountFcst ?? 0,
        priceAct: 0,
      };
    });
    const committedBy = authUser?.name || authUser?.email || 'User (Admin)';
    const currentStampPeriod = stampPeriod;
    const currentSummaryRequest = forecastSummaryRequest;
    const currentSummaryRequestKey = forecastSummaryRequestKey;

    setInventoryCommitPreviewOpen(false);
    setPendingForecastEdits({});
    setPendingPriceEdits({});
    setPendingAmountEdits({});
    forecastWriteEpochRef.current += 1;
    setForecastAuditVersion(version => version + 1);
    setForecastSummary(previous =>
      applyForecastSummaryEdits(previous, qtyEditsToCommit, selectedVersion, forecastMode)
    );
    loadStart();
    setTimeout(loadDone, 400);
    setAppError(null);

    const saveForecastUpdates = async () => {
      try {
        await api.forecast.save(updates, committedBy, currentStampPeriod);
        setIsForecastSummaryUpdating(true);
        try {
          const summary = await api.forecast.summary(currentSummaryRequest);
          setForecastSummary(summary);
          window.localStorage.setItem(
            `${FORECAST_SUMMARY_CACHE_PREFIX}${getActiveClientAppMode()}:${currentSummaryRequestKey}`,
            JSON.stringify({ cachedAt: Date.now(), summary })
          );
        } catch (summaryError) {
          console.error('[forecast summary] refresh after commit failed:', summaryError);
        } finally {
          setIsForecastSummaryUpdating(false);
        }
      } catch (error) {
        setPendingForecastEdits(previous => restorePendingEdits(previous, qtyEditsToCommit));
        setPendingPriceEdits(previous => restorePendingEdits(previous, priceEditsToCommit));
        setPendingAmountEdits(previous => restorePendingEdits(previous, amountEditsToCommit));
        setAppError(error instanceof ApiError ? error.message : 'Failed to commit forecast updates');
      }
    };
    ignorePromise(saveForecastUpdates());
  }, [
    authUser,
    forecastMode,
    forecastSummaryRequest,
    forecastSummaryRequestKey,
    loadDone,
    loadStart,
    pendingForecastEditList,
    pendingPriceEditList,
    pendingAmountEditList,
    selectedVersion,
    stampPeriod,
  ]);

  const handleCommitForecastUpdates = useCallback(() => {
    const hasQtyEdits = pendingForecastEditList.length > 0;
    const hasPriceEdits = pendingPriceEditList.length > 0;
    const hasAmountEdits = pendingAmountEditList.length > 0;
    if ((!hasQtyEdits && !hasPriceEdits && !hasAmountEdits) || isSaving) return;

    if (!hasQtyEdits && (hasPriceEdits || hasAmountEdits)) {
      executeCommitForecastUpdates();
      return;
    }

    setInventoryCommitPreviewOpen(true);

    const pendingRegistrationIds = new Set(
      pendingForecastEditList.map(edit => edit.registrationId)
    );
    const pendingRegistrations = registrationsWithInventory.filter(registration =>
      pendingRegistrationIds.has(registration.id) &&
      !inventoryByRegistrationIdRef.current.has(registration.id)
    );
    if (pendingRegistrations.length > 0) {
      ignorePromise(loadInventoryForRegistrations(pendingRegistrations));
    }
  }, [
    executeCommitForecastUpdates,
    isSaving,
    loadInventoryForRegistrations,
    pendingForecastEditList,
    pendingPriceEditList,
    pendingAmountEditList,
    registrationsWithInventory,
  ]);

  const handlePreviewCommitEmail = useCallback(async () => {
    if (inventoryCommitPreviewRows.length === 0) return;
    try {
      setCommitEmailPreviewLoading(true);
      setCommitEmailPreviewOpen(true);
      const response = await api.notifications.previewForecastChange({
        useSample: false,
        changedBy: authUser?.name || authUser?.email || 'Sales Forecast User',
        changes: inventoryCommitPreviewRows.map(row => ({
          ownerName: row.registration.ownerName ?? '',
          materialCode: row.registration.materialCode ?? '',
          materialDescription: row.registration.materialDescription ?? '',
          plantCode: row.registration.plantCode ?? '',
          period: row.period,
          oldQtyFcst: row.baseValue,
          newQtyFcst: row.currentValue,
        })),
      });
      setCommitEmailPreviewBatches(response.batches);
    } catch (error) {
      setCommitEmailPreviewOpen(false);
      setAppError(formatApiError(error, 'Failed to preview commit email'));
    } finally {
      setCommitEmailPreviewLoading(false);
    }
  }, [authUser, inventoryCommitPreviewRows]);

  const handleSendCommitEmail = useCallback(async () => {
    if (inventoryCommitPreviewRows.length === 0) return;
    try {
      setCommitEmailSending(true);
      setCommitEmailSendMessage(null);
      const changes = inventoryCommitPreviewRows.map(row => ({
        ownerName: row.registration.ownerName ?? '',
        materialCode: row.registration.materialCode ?? '',
        materialDescription: row.registration.materialDescription ?? '',
        plantCode: row.registration.plantCode ?? '',
        period: row.period,
        oldQtyFcst: row.baseValue,
        newQtyFcst: row.currentValue,
      }));
      const result = await api.notifications.sendForecastChange({
        changedBy: authUser?.name || authUser?.email || 'Sales Forecast User',
        changes,
      });
      if (result.sent > 0) {
        setCommitEmailSendMessage({
          tone: 'success',
          text: `Sent ${result.sent} email${result.sent === 1 ? '' : 's'} successfully.`,
        });
      } else if (result.skipped === 'email_disabled_or_empty') {
        setCommitEmailSendMessage({
          tone: 'error',
          text: 'Email sending is disabled on the server (FORECAST_EMAIL_ENABLED).',
        });
      } else {
        setCommitEmailSendMessage({
          tone: 'error',
          text: 'No emails sent — check Manage Email recipients.',
        });
      }
    } catch (error) {
      setCommitEmailSendMessage({
        tone: 'error',
        text: formatApiError(error, 'Failed to send email'),
      });
    } finally {
      setCommitEmailSending(false);
    }
  }, [authUser, inventoryCommitPreviewRows]);

  const handleCreateManagedRegistration = useCallback(async (registration: Registration) => {
    loadStart();
    try {
      const saved = await api.registrations.create(registration);
      setManagedRegistrations(previous => [saved, ...previous.filter(item => item.id !== saved.id)]);
      setRegistrations(previous => [saved, ...previous.filter(item => item.id !== saved.id)]);
      setFormulaMap(previous =>
        new Map(previous).set(
          saved.id,
          (saved.priceFormula || 'CPL') as PriceFormula
        )
      );
      ignorePromise(loadInventoryForRegistrations([saved]));
      return saved;
    } finally {
      loadDone();
    }
  }, [loadDone, loadInventoryForRegistrations, loadStart]);

  const handleUpdateManagedRegistration = useCallback(async (registration: Registration) => {
    loadStart();
    try {
      const result = await api.registrations.update(registration);
      if (isManagedRegistrationMerge(result)) {
        const { crmRegistrationId, removedManagedId, forecastsMoved } = result;
        setManagedRegistrations(previous =>
          previous.filter(item => item.id !== removedManagedId)
        );
        setRegistrations(previous =>
          previous.filter(item => item.id !== removedManagedId)
        );
        setForecastData(previous =>
          previous.map(item =>
            item.registrationId === removedManagedId
              ? { ...item, registrationId: crmRegistrationId }
              : item
          )
        );
        setPendingForecastEdits(previous =>
          previous.map(edit =>
            edit.registrationId === removedManagedId
              ? { ...edit, registrationId: crmRegistrationId }
              : edit
          )
        );
        setPendingPriceEdits(previous =>
          previous.map(edit =>
            edit.registrationId === removedManagedId
              ? { ...edit, registrationId: crmRegistrationId }
              : edit
          )
        );
        setPendingAmountEdits(previous =>
          previous.map(edit =>
            edit.registrationId === removedManagedId
              ? { ...edit, registrationId: crmRegistrationId }
              : edit
          )
        );
        setFormulaMap(previous => {
          const next = new Map(previous);
          const formula = next.get(removedManagedId);
          if (formula) {
            next.set(crmRegistrationId, formula);
          }
          next.delete(removedManagedId);
          return next;
        });
        setFixedPriceMap(previous => {
          const next = new Map(previous);
          const price = next.get(removedManagedId);
          if (price) {
            next.set(crmRegistrationId, price);
          }
          next.delete(removedManagedId);
          return next;
        });
        inventoryByRegistrationIdRef.current.delete(removedManagedId);
        setInventoryByRegistrationId(previous => {
          const next = new Map(previous);
          next.delete(removedManagedId);
          inventoryByRegistrationIdRef.current = next;
          mergedRegistrationCacheRef.current.delete(removedManagedId);
          mergedRegistrationCacheRef.current.delete(crmRegistrationId);
          return next;
        });
        console.info(
          `Merged managed registration ${removedManagedId} into CRM ${crmRegistrationId} (${forecastsMoved} forecast row(s) moved)`
        );
        return result;
      }

      const saved = result;
      setManagedRegistrations(previous =>
        previous.map(item => item.id === saved.id ? saved : item)
      );
      setRegistrations(previous =>
        previous.map(item => item.id === saved.id ? saved : item)
      );
      setFormulaMap(previous =>
        new Map(previous).set(
          saved.id,
          (saved.priceFormula || 'CPL') as PriceFormula
        )
      );
      inventoryByRegistrationIdRef.current.delete(saved.id);
      setInventoryByRegistrationId(previous => {
        const next = new Map(previous);
        next.delete(saved.id);
        inventoryByRegistrationIdRef.current = next;
        mergedRegistrationCacheRef.current.delete(saved.id);
        return next;
      });
      ignorePromise(loadInventoryForRegistrations([saved]));
      return saved;
    } finally {
      loadDone();
    }
  }, [loadDone, loadInventoryForRegistrations, loadStart]);

  const handleDeleteManagedRegistration = useCallback(async (registrationId: string) => {
    loadStart();
    try {
      await api.registrations.remove(registrationId);
      setManagedRegistrations(previous =>
        previous.filter(registration => registration.id !== registrationId)
      );
      setRegistrations(previous =>
        previous.filter(registration => registration.id !== registrationId)
      );
      setForecastData(previous =>
        previous.filter(item => item.registrationId !== registrationId)
      );
      setPendingForecastEdits(previous => withoutRegistrationEdits(previous, registrationId));
      setPendingPriceEdits(previous => withoutRegistrationEdits(previous, registrationId));
      setPendingAmountEdits(previous => withoutRegistrationEdits(previous, registrationId));
      setFormulaMap(previous => {
        const next = new Map(previous);
        next.delete(registrationId);
        return next;
      });
      setFixedPriceMap(previous => {
        const next = new Map(previous);
        next.delete(registrationId);
        return next;
      });
      setInventoryByRegistrationId(previous => {
        const next = new Map(previous);
        next.delete(registrationId);
        inventoryByRegistrationIdRef.current = next;
        mergedRegistrationCacheRef.current.delete(registrationId);
        return next;
      });
    } finally {
      loadDone();
    }
  }, [loadDone, loadStart]);

  const handleCurrentForecastImportComplete = useCallback(async (
    targetVersion = CURRENT_FORECAST_VERSION,
    options?: { startMonth?: string; endMonth?: string }
  ) => {
    setSelectedVersion(targetVersion);
    if (versions.includes(targetVersion)) {
      setPriceManagementVersion(targetVersion);
    }

    let loadStartMonth = dateRange.start.slice(0, 7);
    let loadEndMonth = dateRange.end.slice(0, 7);
    if (options?.startMonth && options?.endMonth) {
      if (options.startMonth < loadStartMonth) loadStartMonth = options.startMonth;
      if (options.endMonth > loadEndMonth) loadEndMonth = options.endMonth;
      setDateRange({ start: loadStartMonth, end: loadEndMonth });
    }

    const actualGranularity = resolveForecastListGranularity(targetVersion, forecastMode);

    loadStart();
    try {
      const managed = await api.registrations.managed();
      setManagedRegistrations(managed);

      let registrationIds = registrations.map(registration => registration.id);
      if (managed.length > 0) {
        setRegistrations(previous => {
          const byId = new Map(previous.map(registration => [registration.id, registration]));
          for (const registration of managed) {
            byId.set(registration.id, registration);
          }
          return [...byId.values()];
        });
        const mergedIds = new Set(registrationIds);
        for (const registration of managed) {
          mergedIds.add(registration.id);
        }
        registrationIds = [...mergedIds];
      }

      if (registrationIds.length === 0) return;

      const [forecasts, actuals] = await Promise.all([
        api.forecast.list({
          ...buildScopedForecastQuery(
            registrationIds,
            { start: loadStartMonth, end: loadEndMonth },
            targetVersion,
            forecastMode,
          ),
        }),
        api.actuals.list(
          loadStartMonth,
          loadEndMonth,
          registrationIds,
          {},
          actualGranularity
        ),
      ]);
      mergeLoadedForecastData(
        forecasts,
        actuals,
        versions.length > 0 ? versions : [targetVersion]
      );
      setPendingForecastEdits({});
      setPendingPriceEdits({});
      setPendingAmountEdits({});
      setForecastSummary(null);
      forecastWriteEpochRef.current += 1;
      setForecastAuditVersion(version => version + 1);
    } finally {
      loadDone();
    }
  }, [
    dateRange.end,
    dateRange.start,
    forecastMode,
    loadDone,
    loadStart,
    mergeLoadedForecastData,
    registrations,
    versions,
  ]);

  const openCopyForecastModal = useCallback(() => {
    const source = versions.find(version => version !== selectedVersion)
      ?? versions[0]
      ?? CURRENT_FORECAST_VERSION;
    setCopyForecastSourceVersion(source);
    setIsCopyingForecastVersion(true);
  }, [selectedVersion, versions]);

  const handleCopyForecastVersion = useCallback(async () => {
    const targetVersion = selectedVersion;
    loadStart();
    setIsSaving(true);
    try {
      await api.forecast.copyVersion(copyForecastSourceVersion, targetVersion);

      setPendingForecastEdits(previous => withoutVersionEdits(previous, targetVersion));
      setPendingPriceEdits(previous => withoutVersionEdits(previous, targetVersion));
      setPendingAmountEdits(previous => withoutVersionEdits(previous, targetVersion));

      forecastWriteEpochRef.current += 1;
      forecastScopeCacheRef.current.scopes.delete(
        buildForecastScopeKey(targetVersion, dateRange, forecastMode)
      );

      const registrationIds = registrations.map(registration => registration.id);
      if (registrationIds.length > 0) {
        const actualGranularity = resolveForecastListGranularity(targetVersion, forecastMode);
        const [forecasts, actuals] = await Promise.all([
          api.forecast.list({
            ...buildScopedForecastQuery(registrationIds, dateRange, targetVersion, forecastMode),
          }),
          api.actuals.list(
            dateRange.start.slice(0, 7),
            dateRange.end.slice(0, 7),
            registrationIds,
            {},
            actualGranularity
          ),
        ]);
        mergeLoadedForecastData(
          forecasts,
          actuals,
          versions.length > 0 ? versions : [targetVersion]
        );
      }

      setForecastSummary(null);
      setForecastAuditVersion(version => version + 1);
      setIsCopyingForecastVersion(false);
      setAppError(null);
    } catch (error) {
      const msg = error instanceof ApiError ? error.message : 'Failed to copy forecast version';
      setAppError(msg);
    } finally {
      setIsSaving(false);
      loadDone();
    }
  }, [
    copyForecastSourceVersion,
    dateRange,
    forecastMode,
    loadDone,
    loadStart,
    mergeLoadedForecastData,
    registrations,
    selectedVersion,
    versions,
  ]);

  const exportToExcel = async () => {
    loadStart();
    try {
      const XLSX = await import('xlsx');
      // Build the lookup index once (instead of a linear scan per cell) and reuse
      // the same price/formula/spread maps the grid uses so exported values match
      // what is on screen.
      const exportForecastIndex = buildForecastIndex(forecastData);
      const exportPriceMaps = {
        cpl: new Map<string, number>(cplPrices.map(price => [price.month, price.price])),
        naphtha: new Map<string, number>(naphthaprices.map(price => [price.month, price.price])),
        benzene: new Map<string, number>(benzeneprices.map(price => [price.month, price.price])),
        jpy: new Map<string, number>(jpyRates.map(price => [price.month, price.price])),
        thb: new Map<string, number>(thbRates.map(price => [price.month, price.price])),
        tecnon: new Map<string, number>(tecnonPrices.map(price => [price.month, price.price])),
        pci: new Map<string, number>(pciPrices.map(price => [price.month, price.price])),
      };
      const data = displayedRegistrations.map(reg => {
        const row: Record<string, unknown> = { ...reg };
        const formula = resolveRegistrationPriceFormula(formulaMap, reg);
        monthsToShow.forEach(m => {
          const { value } = getForecastCellValue(
            reg,
            m,
            selectedVersion,
            selectedDimension,
            selectedType,
            forecastData,
            cplPrices,
            forecastMode,
            planningView,
            exportForecastIndex,
            formula,
            naphthaprices,
            benzeneprices,
            fixedPriceMap,
            exportPriceMaps,
            spreadMap,
            pricingPolicyMap,
            latestActualPriceMap,
          );
          row[m] = value;
        });
        return row;
      });

      const worksheet = XLSX.utils.json_to_sheet(data);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, "Forecast");
      XLSX.writeFile(workbook, `SaleForecast_${selectedVersion}_${format(new Date(), 'yyyyMMdd')}.xlsx`);
    } finally {
      loadDone();
    }
  };

  const selectZeroPriceInput = (event: React.FocusEvent<HTMLInputElement>) => {
    if (Number(event.currentTarget.value) === 0) event.currentTarget.select();
  };

  const keepZeroPriceSelected = (event: React.MouseEvent<HTMLInputElement>) => {
    if (Number(event.currentTarget.value) !== 0) return;
    event.preventDefault();
    event.currentTarget.select();
  };

  const updatePriceManagementCell = useCallback((
    month: string,
    field: keyof Omit<PriceManagementRow, 'month'>,
    value: number
  ) => {
    setPriceManagementRows(previous => {
      const exists = previous.some(row => row.month === month);
      const nextRows = exists
        ? previous.map(row => row.month === month ? { ...row, [field]: value } : row)
        : [...previous, {
            month,
            cplPrice: 0,
            naphthaPrice: 0,
            benzenePrice: 0,
            jpyUsdRate: 0,
            thbUsdRate: 0,
            cplTecnonPrice: 0,
            cplPciPrice: 0,
            [field]: value,
          }];
      return nextRows.sort((a, b) => a.month.localeCompare(b.month));
    });
  }, []);

  const handleSavePriceManagement = useCallback(async () => {
    loadStart();
    setIsSaving(true);
    try {
      await api.priceManagement.saveBulk(
        priceManagementType,
        priceManagementType === 'Actual' ? GLOBAL_PRICE_VERSION : priceManagementVersion,
        priceManagementRows
      );
      if (priceManagementType === 'Fcst' && priceManagementVersion === selectedVersion) {
        setCplPrices(priceRowsToCplPrices(priceManagementRows));
        setNaphthaprices(priceRowsToNaphthaPrices(priceManagementRows));
        setBenzeneprices(priceRowsToBenzenePrices(priceManagementRows));
        setJpyRates(priceRowsToJpyRates(priceManagementRows));
        setThbRates(priceRowsToThbRates(priceManagementRows));
        setTecnonPrices(priceRowsToTecnonPrices(priceManagementRows));
        setPciPrices(priceRowsToPciPrices(priceManagementRows));
      }
      setAppError(null);
    } catch (error) {
      const msg = error instanceof ApiError ? error.message : 'Failed to save price management data';
      setAppError(msg);
    } finally {
      setIsSaving(false);
      loadDone();
    }
  }, [loadDone, loadStart, priceManagementRows, priceManagementType, priceManagementVersion, selectedVersion]);

  const sessionPermissions = useMemo(
    () => effectivePermissions(authUser, permissions),
    [authUser, permissions]
  );
  const isManageNavActive = activeTab === 'master'
    || manageAdminOpen
    || manageEmailOpen
    || manageColumnsOpen
    || manageRegistrationOpen;
  const isBudgetNavActive = activeTab === 'mtp' || activeTab === 'yearly';
  const displayUserName = authUser?.name || authUser?.email || 'User';
  const userInitials = displayUserName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(part => part[0]?.toUpperCase())
    .join('') || 'U';

  if (isAuthLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#F8FAFC] text-slate-500">
        <div className="rounded-lg border border-slate-200 bg-white px-5 py-4 text-xs font-bold uppercase tracking-wider shadow-sm">
          Checking sign-in...
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#F8FAFC] text-slate-800 font-sans overflow-hidden">
      {/* Top Branding Bar */}
      <nav className="relative z-50 flex h-14 shrink-0 items-center justify-between overflow-visible bg-[#007ABE] px-5 shadow-sm">
        <div className="flex min-w-0 items-center gap-5 overflow-visible">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-[56px] shrink-0 items-center justify-center rounded-md bg-white shadow-sm" aria-label="UBE">
              <svg viewBox="0 0 120 42" className="h-7 w-[52px]" role="img" aria-hidden="true">
                <text
                  x="57"
                  y="31"
                  fill="#2F86C5"
                  fontFamily="Arial Black, Arial, sans-serif"
                  fontSize="34"
                  fontStyle="italic"
                  fontWeight="900"
                  letterSpacing="-4"
                  textAnchor="middle"
                >
                  UBE
                </text>
              </svg>
            </div>
            <span className="text-white font-bold tracking-tight text-base uppercase whitespace-nowrap">SalesNexus</span>
            {appConfig ? (
              <span className="hidden text-[10px] font-semibold uppercase tracking-wider text-blue-100/90 sm:inline">
                {appConfig.appMode === 'ufa' ? 'UFA' : 'Polymer / Composite'}
              </span>
            ) : null}
          </div>
          <div className="h-5 w-[1px] bg-white/25"></div>
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-visible py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button
              onClick={() => { flash(); setOpenNavMenu(null); setActiveTab('forecast'); }}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wider transition-all",
                activeTab === 'forecast' ? "bg-white text-[#007ABE] shadow-sm" : "text-blue-50 hover:bg-white/10 hover:text-white"
              )}
            >
              <FileSpreadsheet size={14} />
              Sales Forecast
            </button>
            <NavDropdown
              label="Manage"
              icon={<Settings size={14} />}
              isOpen={openNavMenu === 'manage'}
              onToggle={() => setOpenNavMenu(open => open === 'manage' ? null : 'manage')}
              onClose={() => setOpenNavMenu(null)}
              active={isManageNavActive}
            >
              <NavDropdownItem
                label="Price Base"
                icon={<SlidersHorizontal size={14} />}
                onClick={() => {
                  flash();
                  setOpenNavMenu(null);
                  setActiveTab('master');
                }}
              />
              {sessionPermissions.canManageAdmin && (
                <NavDropdownItem
                  label="Admin"
                  icon={<Shield size={14} />}
                  onClick={() => {
                    setOpenNavMenu(null);
                    setManageAdminOpen(true);
                  }}
                />
              )}
              {sessionPermissions.canManageEmail && (
                <NavDropdownItem
                  label="Email"
                  icon={<Mail size={14} />}
                  onClick={() => {
                    setOpenNavMenu(null);
                    setManageEmailOpen(true);
                  }}
                />
              )}
              {sessionPermissions.canManageAdmin && (
                <NavDropdownItem
                  label="Columns"
                  icon={<Columns3 size={14} />}
                  onClick={() => {
                    setOpenNavMenu(null);
                    openManageColumns('manage');
                  }}
                />
              )}
              <NavDropdownItem
                label="Registration"
                icon={<Pencil size={14} />}
                badge={managedRegistrations.length}
                onClick={() => {
                  setOpenNavMenu(null);
                  setManageRegistrationOpen(true);
                }}
              />
            </NavDropdown>
            <button
              onClick={() => {
                flash();
                setOpenNavMenu(null);
                // Open the Power BI analytics report in a new tab; keep the
                // current page unchanged.
                window.open(ANALYTICS_POWER_BI_URL, '_blank', 'noopener,noreferrer');
              }}
              className="flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wider transition-all text-blue-50 hover:bg-white/10 hover:text-white"
            >
              <BarChart3 size={14} />
              Analytics
            </button>
            <button
              onClick={() => { flash(); setOpenNavMenu(null); setActiveTab('overplan'); }}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wider transition-all",
                activeTab === 'overplan' ? "bg-white text-[#007ABE] shadow-sm" : "text-blue-50 hover:bg-white/10 hover:text-white"
              )}
            >
              <AlertTriangle size={14} />
              Diff Plan
            </button>
            <button
              onClick={() => { flash(); setOpenNavMenu(null); setActiveTab('pdc'); }}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-[10px] font-black uppercase tracking-wider transition-all",
                activeTab === 'pdc' ? "bg-white text-[#007ABE] shadow-sm" : "text-blue-50 hover:bg-white/10 hover:text-white"
              )}
            >
              <PieIcon size={14} />
              PDC Summary
            </button>
            <NavDropdown
              label="Budget"
              icon={<Layers size={14} />}
              isOpen={openNavMenu === 'budget'}
              onToggle={() => setOpenNavMenu(open => open === 'budget' ? null : 'budget')}
              onClose={() => setOpenNavMenu(null)}
              active={isBudgetNavActive}
            >
              <NavDropdownItem
                label="MTP BG"
                icon={<Calendar size={14} />}
                onClick={() => {
                  flash();
                  setOpenNavMenu(null);
                  setActiveTab('mtp');
                }}
              />
              <NavDropdownItem
                label="Yearly BG"
                icon={<Layers size={14} />}
                onClick={() => {
                  flash();
                  setOpenNavMenu(null);
                  setActiveTab('yearly');
                }}
              />
            </NavDropdown>
          </div>
        </div>
        <div ref={accountMenuRef} className="relative flex items-center gap-3">
          <div className="text-right mr-2">
            <p className="text-[8px] text-blue-100/90 leading-none uppercase font-bold tracking-wide">Authenticated as</p>
            <p className="text-[10px] text-white font-semibold">{displayUserName}</p>
          </div>
          <button
            type="button"
            onClick={() => setIsAccountMenuOpen(open => !open)}
            className="flex w-8 h-8 rounded-full bg-blue-600 items-center justify-center text-white text-[10px] font-bold shadow-inner ring-2 ring-white/15 transition hover:ring-white/45 focus:outline-none focus:ring-white"
            aria-label="Open account menu"
            aria-expanded={isAccountMenuOpen}
          >
            {userInitials}
          </button>

          {isAccountMenuOpen && (
            <div className="absolute right-0 top-11 z-[90] w-80 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100 shadow-2xl">
              <div className="flex items-center justify-between border-b border-slate-200 bg-slate-200/80 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white shadow-inner">
                    {userInitials}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-bold text-slate-800">{displayUserName}</p>
                    <p className="truncate text-xs font-medium text-slate-500">{authUser?.email || 'Signed in'}</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsAccountMenuOpen(false)}
                  className="rounded-full p-1.5 text-slate-500 transition hover:bg-white hover:text-slate-800"
                  aria-label="Close account menu"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="p-3">
                <div className="rounded-2xl bg-white p-3 shadow-sm">
                  <div className="mb-3 flex items-center gap-3 rounded-xl bg-slate-50 p-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">
                      {userInitials}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-bold text-slate-800">{displayUserName}</p>
                      <p className="truncate text-xs text-slate-500">{authUser?.email || 'Local session'}</p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={handleLogout}
                    className="flex w-full items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm font-bold text-slate-700 transition hover:border-red-200 hover:bg-red-50 hover:text-red-600"
                  >
                    <LogOut size={18} />
                    Log out
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </nav>

      {appError && (
        <div className="bg-red-50 border-b border-red-200 px-6 py-2 flex items-center justify-between shrink-0 z-50">
          <span className="text-red-600 text-xs font-bold">{appError}</span>
          <button onClick={() => setAppError(null)} className="text-red-400 hover:text-red-600 text-xs ml-4 font-bold">✕ Dismiss</button>
        </div>
      )}

      <ManageAdminPanel
        open={manageAdminOpen}
        onClose={() => setManageAdminOpen(false)}
        sessionEmpCode={sessionPermissions.empCode}
                onSaved={() => { ignorePromise(refreshSessionPermissions()); }}
      />

      <ManageEmailPanel
        open={manageEmailOpen}
        onClose={() => setManageEmailOpen(false)}
      />

      <ManageColumnPanel
        open={manageColumnsOpen}
        initialSection={manageColumnsInitialSection}
        onClose={() => setManageColumnsOpen(false)}
        onColumnsChanged={handleCustomColumnsChanged}
      />

      <ManageRegistrationPanel
        open={manageRegistrationOpen}
        registrations={managedRegistrations}
        onClose={() => setManageRegistrationOpen(false)}
        onUpdate={handleUpdateManagedRegistration}
        onDelete={handleDeleteManagedRegistration}
      />

      {/* Filter Area (Header) */}
      {activeTab === 'forecast' && (
        <header
          className={cn(
            "relative bg-white border-b border-slate-200 shrink-0 z-40 overflow-visible",
            isForecastHeaderCollapsed ? "h-3" : "h-[100px] shadow-sm"
          )}
        >
          <button
            type="button"
            onClick={() => setIsForecastHeaderCollapsed(prev => !prev)}
            className={cn(
              "absolute left-1/2 top-full z-50 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition-[color,border-color,background-color,transform] duration-150 will-change-transform",
              isForecastHeaderCollapsed
                ? "hover:bg-white hover:text-blue-600 hover:border-blue-200"
                : "hover:bg-slate-50 hover:text-slate-900 hover:border-slate-300"
            )}
            title={isForecastHeaderCollapsed ? "Show filter bar" : "Hide filter bar"}
            aria-label={isForecastHeaderCollapsed ? "Show filter bar" : "Hide filter bar"}
          >
            <ChevronRight
              size={16}
              className={cn(
                "transition-transform duration-150",
                isForecastHeaderCollapsed ? "rotate-90" : "-rotate-90"
              )}
            />
          </button>
          <div
            className={cn(
              "h-[100px] px-4 pt-3 pb-2.5 flex flex-col justify-center transition-[opacity,transform] duration-200 ease-in-out",
              isForecastHeaderCollapsed
                ? "pointer-events-none -translate-y-2 opacity-0"
                : "translate-y-0 opacity-100"
            )}
          >
          <div className="grid w-full max-w-[1400px] grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_minmax(0,1fr)] items-center gap-4">
            <FilterGroup
                label="Date Range"
                action={
                  <div className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 p-1 text-[10px] font-bold uppercase">
                    {availableForecastModes.map(mode => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => { flash(); handleForecastModeChange(mode); }}
                        className={cn(
                          "rounded-full px-2 py-1 transition-all",
                          forecastMode === mode
                            ? "bg-white text-blue-600 shadow-sm"
                            : "text-slate-500 hover:text-slate-700"
                        )}
                      >
                        {mode === 'month' ? 'Month' : 'Week'}
                      </button>
                    ))}
                  </div>
                }
              >
                <div className="flex items-center gap-2">
                {forecastMode === 'month' ? (
                  <MonthYearPicker
                    value={dateRange.start}
                    onChange={start => setDateRange(previous => ({ ...previous, start }))}
                    ariaLabel="Select start month and year"
                  />
                ) : (
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={formatDayModeValue(dateRange.start)}
                      onChange={event => {
                        const parsed = parseDayModeValue(event.target.value);
                        if (parsed !== null) {
                          setDateRange(previous => ({ ...previous, start: parsed }));
                        }
                      }}
                      className="w-full rounded border border-slate-200 bg-slate-50 p-1.5 pr-8 text-xs outline-none transition-all focus:border-blue-400"
                    />
                    <input
                      ref={startDatePickerRef}
                      type="date"
                      value={dateRange.start}
                      onChange={event => setDateRange(previous => ({ ...previous, start: event.target.value }))}
                      className="pointer-events-none absolute left-0 top-0 h-0 w-0 opacity-0"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      onClick={() => openDatePicker(startDatePickerRef.current)}
                      className="absolute inset-y-0 right-1.5 flex items-center justify-center text-slate-500 transition-colors hover:text-blue-600"
                      aria-label="Open start date picker"
                    >
                      <Calendar size={14} />
                    </button>
                  </div>
                )}
                <span className="text-slate-300 text-[10px]">TO</span>
                {forecastMode === 'month' ? (
                  <MonthYearPicker
                    value={dateRange.end}
                    onChange={end => setDateRange(previous => ({ ...previous, end }))}
                    ariaLabel="Select end month and year"
                  />
                ) : (
                  <div className="relative flex-1">
                    <input
                      type="text"
                      value={formatDayModeValue(dateRange.end)}
                      onChange={event => {
                        const parsed = parseDayModeValue(event.target.value);
                        if (parsed !== null) {
                          setDateRange(previous => ({ ...previous, end: parsed }));
                        }
                      }}
                      className="w-full rounded border border-slate-200 bg-slate-50 p-1.5 pr-8 text-xs outline-none transition-all focus:border-blue-400"
                    />
                    <input
                      ref={endDatePickerRef}
                      type="date"
                      value={dateRange.end}
                      onChange={event => setDateRange(previous => ({ ...previous, end: event.target.value }))}
                      className="pointer-events-none absolute left-0 top-0 h-0 w-0 opacity-0"
                      aria-hidden="true"
                    />
                    <button
                      type="button"
                      onClick={() => openDatePicker(endDatePickerRef.current)}
                      className="absolute inset-y-0 right-1.5 flex items-center justify-center text-slate-500 transition-colors hover:text-blue-600"
                      aria-label="Open end date picker"
                    >
                      <Calendar size={14} />
                    </button>
                  </div>
                )}
                </div>
              </FilterGroup>

            <FilterGroup label="Dimension">
              <div className="flex bg-slate-100 p-1 rounded-lg">
                {(['Qty', 'Price', 'Amount'] as Dimension[]).map(d => (
                  <button 
                    key={d}
                    onClick={() => { flash(); setSelectedDimension(d); }}
                    className={cn(
                      "flex-1 text-[10px] py-1 rounded transition-all font-bold uppercase",
                      selectedDimension === d ? "bg-white shadow-sm text-blue-600" : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </FilterGroup>

            <FilterGroup label="Value Type">
              <div className="flex bg-slate-100 p-1 rounded-lg">
                {(['Act', 'Fcst', 'Act-Fcst'] as ValueType[]).map(t => (
                  <button 
                    key={t}
                    onClick={() => { flash(); setSelectedType(t); }}
                    className={cn(
                      "flex-1 text-[10px] py-1 rounded transition-all font-bold uppercase",
                      selectedType === t ? "bg-white shadow-sm text-blue-600" : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </FilterGroup>

            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(72px,88px)] gap-3">
            <FilterGroup label="Forecast Version">
              <div className="flex w-full items-center gap-1.5 relative">
                <div className="relative min-w-0 flex-1">
                  <select
                    value={selectedVersion}
                    onChange={e => {
                      flash();
                      const nextVersion = e.target.value;
                      forecastWriteEpochRef.current += 1;
                      forecastScopeCacheRef.current = {
                        registrationSig: '',
                        scopes: new Map(),
                      };
                      setSelectedVersion(nextVersion);
                    }}
                    className="sf-select w-full min-w-0 text-xs border rounded p-1.5 outline-none appearance-none pr-8 transition-colors"
                    title={selectedVersion}
                  >
                    {versions.map(v => <option key={v}>{v}</option>)}
                  </select>
                  <div className="absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-blue-400">
                    <ChevronRight size={14} className="rotate-90" />
                  </div>
                </div>
                    <button 
                      type="button"
                      onClick={() => {
                        setIsAddingVersion(true);
                        setIsEditingVersion(false);
                      }}
                      className="shrink-0 p-1.5 hover:bg-blue-50 text-blue-600 rounded-lg border border-blue-100 transition-colors bg-white shadow-sm"
                      title="Add new version"
                    >
                      <Plus size={16} />
                    </button>
                    <button 
                      type="button"
                      onClick={() => {
                        setEditingVersionName(selectedVersion);
                        setIsEditingVersion(true);
                        setIsAddingVersion(false);
                      }}
                      className="shrink-0 p-1.5 hover:bg-blue-50 text-blue-600 rounded-lg border border-blue-100 transition-colors bg-white shadow-sm"
                      title="Rename selected version"
                    >
                      <Pencil size={16} />
                    </button>

                    <AnimatePresence>
                      {isAddingVersion && (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 10 }}
                          className="absolute top-full right-0 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xl z-[100]"
                        >
                          <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#007ABE] text-white shadow-sm">
                                <Plus size={14} strokeWidth={2.5} />
                              </div>
                              <div className="min-w-0">
                                <h4 className="text-sm font-semibold text-slate-900">Add forecast version</h4>
                                <p className="text-[11px] text-slate-500">Create a new plan label for forecasts</p>
                              </div>
                            </div>
                          </div>
                          <div className="space-y-3 p-4">
                            <label className="block">
                              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Version name</span>
                              <input 
                                autoFocus
                                type="text" 
                                value={newVersionName}
                                onChange={e => setNewVersionName(e.target.value)}
                                placeholder="e.g. BB FY26"
                                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-800 outline-none transition-colors focus:border-[#007ABE] focus:ring-2 focus:ring-[#007ABE]/15"
                              />
                            </label>
                            <div className="flex gap-2 pt-1">
                              <button 
                                onClick={async () => {
                                  if (newVersionName && !versions.includes(newVersionName)) {
                                    try {
                                      loadStart();
                                      await api.versions.create(newVersionName);
                                      setVersions(prev => [...prev, newVersionName]);
                                      setSelectedVersion(newVersionName);
                                      setNewVersionName('');
                                      setIsAddingVersion(false);
                                    } catch (error) {
                                      const msg = error instanceof ApiError ? error.message : 'Failed to create version';
                                      setAppError(msg);
                                    } finally {
                                      loadDone();
                                    }
                                  }
                                }}
                                className="flex-1 rounded-lg bg-[#007ABE] py-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0069a3] disabled:opacity-50"
                                disabled={!newVersionName.trim() || versions.includes(newVersionName.trim())}
                              >
                                Create version
                              </button>
                              <button 
                                onClick={() => setIsAddingVersion(false)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}

                      {isEditingVersion && (
                        <motion.div 
                          initial={{ opacity: 0, scale: 0.95, y: 10 }}
                          animate={{ opacity: 1, scale: 1, y: 0 }}
                          exit={{ opacity: 0, scale: 0.95, y: 10 }}
                          className="absolute top-full right-0 mt-2 w-72 overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xl z-[100]"
                        >
                          <div className="border-b border-slate-100 bg-slate-50/80 px-4 py-3">
                            <div className="flex items-center gap-2.5">
                              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#007ABE] text-white shadow-sm">
                                <Pencil size={14} strokeWidth={2.5} />
                              </div>
                              <div className="min-w-0">
                                <h4 className="text-sm font-semibold text-slate-900">Rename version</h4>
                                <p className="text-[11px] text-slate-500">Change the label shown in the version list</p>
                              </div>
                            </div>
                          </div>
                          <div className="space-y-3 p-4">
                            <div>
                              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">Current name</span>
                              <p className="truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700">
                                {selectedVersion}
                              </p>
                            </div>
                            <label className="block">
                              <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-slate-400">New name</span>
                              <input 
                                autoFocus
                                type="text" 
                                value={editingVersionName}
                                onChange={e => setEditingVersionName(e.target.value)}
                                placeholder="Enter new version name"
                                className={cn(
                                  'w-full rounded-lg border px-3 py-2 text-xs text-slate-800 outline-none transition-colors focus:ring-2 focus:ring-[#007ABE]/15',
                                  versions.includes(editingVersionName.trim()) && editingVersionName.trim() !== selectedVersion
                                    ? 'border-red-300 focus:border-red-400'
                                    : 'border-slate-200 focus:border-[#007ABE]'
                                )}
                              />
                            </label>
                            {versions.includes(editingVersionName.trim()) && editingVersionName.trim() !== selectedVersion && (
                              <p className="text-[11px] font-medium text-red-600">This name is already used by another version.</p>
                            )}
                            <div className="flex gap-2 pt-1">
                              <button 
                                onClick={() => {
                                  const trimmed = editingVersionName.trim();
                                  if (trimmed && trimmed !== selectedVersion && !versions.includes(trimmed)) {
                                    const oldName = selectedVersion;
                                    const newName = trimmed;
                                    
                                    setVersions(prev => prev.map(v => v === oldName ? newName : v));
                                    setForecastData(prev => prev.map(f => f.version === oldName ? { ...f, version: newName } : f));
                                    forecastWriteEpochRef.current += 1;
                                    setSelectedVersion(newName);
                                    flash();
                                    setIsEditingVersion(false);
                                  } else if (trimmed === selectedVersion) {
                                    setIsEditingVersion(false);
                                  }
                                }}
                                disabled={
                                  !editingVersionName.trim() ||
                                  editingVersionName.trim() === selectedVersion ||
                                  versions.includes(editingVersionName.trim())
                                }
                                className="flex-1 rounded-lg bg-[#007ABE] py-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#0069a3] disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                Save name
                              </button>
                              <button 
                                onClick={() => setIsEditingVersion(false)}
                                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-semibold text-slate-600 transition-colors hover:bg-slate-50"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </FilterGroup>

                <FilterGroup label="STAMP PERIOD">
                  <SfSelect
                    className="w-full max-w-[88px]"
                    value={stampPeriod}
                    onChange={nextPeriod => { flash(); setStampPeriod(nextPeriod); }}
                    options={STAMP_PERIOD_OPTIONS}
                  />
                </FilterGroup>
            </div>

                <FilterGroup label="VIEW MODE">
                  <SfSelect
                    value={planningView}
                    onChange={nextView => { flash(); setPlanningView(nextView as 'sale' | 'accounting' | 'production'); }}
                    options={[
                      { value: 'sale', label: 'Sale Input' },
                      { value: 'accounting', label: 'Accounting' },
                      { value: 'production', label: 'Production' },
                    ]}
                  />
                </FilterGroup>
          </div>
          </div>
        </header>
      )}

      {activeTab === 'master' && (
        <header className="h-[115px] bg-white border-b border-slate-200 p-4 flex flex-col justify-center shrink-0 shadow-sm z-40">
          <div className="flex items-end justify-between gap-4 w-full">
            <div className="flex items-end gap-4 min-w-0">
              <FilterGroup label="Fiscal Year (FY)">
                <SfSelect
                  className="w-64"
                  value={String(selectedFy)}
                  onChange={nextFy => { flash(); setSelectedFy(Number(nextFy)); }}
                  options={[2024, 2025, 2026, 2027, 2028].map(year => ({
                    value: String(year),
                    label: `FY ${String(year).slice(-2)} (${year}-04 to ${year + 1}-03)`,
                  }))}
                />
              </FilterGroup>
            </div>

            <div className="flex items-end gap-4 shrink-0">
              <FilterGroup label="Price Type">
                <div className="bg-slate-100 p-1 rounded-xl flex shadow-inner">
                  {(['Actual', 'Fcst'] as PriceManagementType[]).map(type => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => { flash(); setPriceManagementType(type); }}
                      className={cn(
                        "px-5 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                        priceManagementType === type
                          ? "bg-white text-blue-600 shadow-sm"
                          : "text-slate-500 hover:text-slate-700"
                      )}
                    >
                      {type === 'Actual' ? 'ACT' : 'FCST'}
                    </button>
                  ))}
                </div>
              </FilterGroup>

              <FilterGroup label="Forecast Version">
                <SfSelect
                  className="w-56"
                  value={priceManagementVersion}
                  disabled={priceManagementType === 'Actual'}
                  onChange={nextVersion => { flash(); setPriceManagementVersion(nextVersion); }}
                  options={versions}
                />
              </FilterGroup>

              <button
                type="button"
                onClick={() => {
                  const firstSource = versions.find(version => version !== priceManagementVersion) ?? CURRENT_FORECAST_VERSION;
                  setCopySourceVersion(firstSource);
                  setIsCopyingPriceVersion(true);
                }}
                disabled={priceManagementType !== 'Fcst' || versions.length < 2}
                aria-hidden={priceManagementType !== 'Fcst'}
                tabIndex={priceManagementType === 'Fcst' ? 0 : -1}
                className={cn(
                  'bg-white hover:bg-blue-50 text-blue-600 border border-blue-100 text-[10px] font-bold py-2 px-4 rounded-lg shadow-sm flex items-center gap-1 uppercase tracking-wider transition-all active:scale-95 disabled:opacity-50',
                  priceManagementType !== 'Fcst' && 'invisible pointer-events-none'
                )}
              >
                <Copy size={12} />
                Copy
              </button>
              <button 
                onClick={async () => {
                  const XLSX = await import('xlsx');
                  const worksheet = XLSX.utils.json_to_sheet(priceManagementRows);
                  const workbook = XLSX.utils.book_new();
                  XLSX.utils.book_append_sheet(workbook, worksheet, `PRICE_FY${String(selectedFy).slice(-2)}`);
                  XLSX.writeFile(workbook, `Price_${priceManagementType}_${priceManagementVersion}_FY${String(selectedFy).slice(-2)}_${format(new Date(), 'yyyyMMdd')}.xlsx`);
                }}
                className="bg-slate-100 hover:bg-slate-200 text-slate-600 text-[10px] font-bold py-2 px-4 rounded-lg shadow-sm flex items-center gap-1 uppercase tracking-wider transition-all active:scale-95"
              >
                <Download size={12} />
                Export FY
              </button>
            </div>
          </div>
        </header>
      )}

      {/* Main Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Content Area */}
        <main className="flex-1 bg-white flex flex-col overflow-hidden relative">
          {isLoading && (
            <div className="absolute inset-0 z-50 flex items-center justify-center bg-white/90 backdrop-blur-sm">
              <div className="text-slate-500 text-sm font-bold animate-pulse tracking-widest uppercase">Loading from server…</div>
            </div>
          )}
          <AnimatePresence mode="wait">
            {activeTab === 'forecast' && (
              <motion.div 
                key="forecast"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                <ForecastInputTable
                  registrations={displayedRegistrations}
                  allRegistrations={allDisplayedRegistrations}
                  columnFilters={columnFilters}
                  onColumnFiltersChange={setColumnFilters}
                  monthsToShow={monthsToShow}
                  forecastData={forecastData}
                  cplPrices={cplPrices}
                  selectedVersion={selectedVersion}
                  selectedDimension={selectedDimension}
                  selectedType={selectedType}
                  onForecastChange={handleForecastChange}
                  onExport={exportToExcel}
                  forecastMode={forecastMode}
                  planningView={planningView}
                  formulaMap={formulaMap}
                  onFormulaChange={handleFormulaChange}
                  pricingPolicyMap={pricingPolicyMap}
                  onPricingPolicyChange={handlePricingPolicyChange}
                  spreadMap={spreadMap}
                  onSpreadChange={handleSpreadChange}
                  onSpreadCommit={handleSpreadCommit}
                  formulaFilter={formulaFilter}
                  onFormulaFilterChange={setFormulaFilter}
                  naphthaprices={naphthaprices}
                  benzeneprices={benzeneprices}
                  jpyRates={jpyRates}
                  thbRates={thbRates}
                  tecnonPrices={tecnonPrices}
                  pciPrices={pciPrices}
                  latestActualPriceMap={latestActualPriceMap}
                  fixedPriceMap={fixedPriceMap}
                  onFixedPriceChange={handleFixedPriceChange}
                  onAmountChange={handleAmountChange}
                  isTableDataLoading={isTableDataLoading}
                  forecastLoadProgress={forecastLoadProgress}
                  isLoadingMore={isLoadingMore}
                  hasMoreRows={hasMoreRegistrations}
                  onLoadMore={loadMoreRegistrations}
                  loadFilterOptions={loadFilterOptions}
                  onCreateManagedRegistration={handleCreateManagedRegistration}
                  onImportComplete={handleCurrentForecastImportComplete}
                  forecastSummary={displayedForecastSummary}
                  isForecastSummaryUpdating={isForecastSummaryUpdating}
                  forecastAuditVersion={forecastAuditVersion}
                  stampPeriod={stampPeriod}
                  customColumnDefs={customColumnDefs}
                  customColumnValues={customColumnValues}
                  canManageCustomColumns={sessionPermissions.canManageAdmin}
                  onOpenManageColumns={openManageColumns}
                  onCustomColumnValueChange={handleCustomColumnValueChange}
                  onOpenCopyForecast={openCopyForecastModal}
                  canCopyForecast={versions.length >= 2}
                  appMode={appConfig?.appMode ?? null}
                />

                <InventoryCommitPreviewModal
                  open={inventoryCommitPreviewOpen}
                  rows={inventoryCommitPreviewRows}
                  isInventoryLoading={isInventoryLoading}
                  onClose={() => setInventoryCommitPreviewOpen(false)}
                  onConfirm={executeCommitForecastUpdates}
                  onPreviewEmail={() => { ignorePromise(handlePreviewCommitEmail()); }}
                  isEmailPreviewLoading={commitEmailPreviewLoading}
                />

                <NotificationEmailPreviewModal
                  open={commitEmailPreviewOpen}
                  batches={commitEmailPreviewBatches}
                  loading={commitEmailPreviewLoading}
                  sending={commitEmailSending}
                  sendMessage={commitEmailSendMessage}
                  onSend={() => { ignorePromise(handleSendCommitEmail()); }}
                  onClose={() => {
                    setCommitEmailPreviewOpen(false);
                    setCommitEmailSendMessage(null);
                  }}
                />

                {/* Bottom Status Bar */}
                <div className="h-10 border-t border-slate-200 bg-slate-50 px-6 flex items-center justify-between shrink-0">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full",
                      snapshotStatus?.status === 'failed' ? "bg-amber-400" : "bg-green-500",
                      snapshotStatus?.status === 'syncing' && "animate-pulse"
                    )} />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[8px] font-black uppercase tracking-widest text-slate-400">System Status</span>
                        <span className="font-mono text-[9px] font-bold uppercase tracking-tight text-slate-500">
                          {snapshotStatus?.status === 'syncing'
                            ? 'SYNCING_SOURCE'
                            : snapshotStatus?.status === 'failed'
                              ? 'SOURCE_SYNC_FAILED'
                              : 'LOCAL_DATA_READY'}
                        </span>
                      </div>
                      <p className="truncate text-[8px] text-slate-400">
                        {snapshotStatus?.completedAt
                          ? `Updated ${new Date(snapshotStatus.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : 'Preparing local data'}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => { ignorePromise(handleRefreshSnapshot()); }}
                      disabled={isRefreshingSnapshot || snapshotStatus?.status === 'syncing'}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-400 transition-colors hover:border-blue-200 hover:text-[#007ABE] disabled:cursor-wait disabled:opacity-50"
                      title="Refresh source data now"
                      aria-label="Refresh source data now"
                    >
                      <RefreshCw size={13} className={isRefreshingSnapshot ? "animate-spin" : ""} />
                    </button>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] text-slate-400 font-serif italic">Pending Changes: {pendingCommitEditCount} units</span>
                    <button 
                      onClick={handleCommitForecastUpdates}
                      disabled={isSaving || pendingCommitEditCount === 0}
                      className="bg-green-600 hover:bg-green-700 text-white text-[10px] font-bold px-4 py-1.5 rounded shadow-sm hover:shadow-md transition-all active:scale-95 uppercase tracking-wider disabled:opacity-50"
                    >
                      Commit Updates
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'master' && (
              <motion.div 
                key="master"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1 flex flex-col overflow-hidden"
              >
                <div ref={cplTableRef} className="flex-1 overflow-auto">
                  <table className="w-full border-collapse table-fixed min-w-[1680px]">
                    <thead className="sticky top-0 z-20 bg-slate-100">
                      <tr className="divide-x divide-slate-200">
                        <th className="w-[8%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-left">Month</th>
                        <th className="w-[10%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-left">Period Description</th>
                        <th className="w-[12%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">CPL CCF (USD/Ton)</th>
                        <th className="w-[11%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">Naphtha (USD/Ton)</th>
                        <th className="w-[11%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">Benzene (USD/Ton)</th>
                        <th className="w-[10%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">JPY/USD</th>
                        <th className="w-[10%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">THB/USD</th>
                        <th className="w-[14%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">CPL Tecnon (USD/Ton)</th>
                        <th className="w-[14%] px-3 py-3 text-[10px] font-black uppercase text-slate-400 text-right tracking-widest">CPL PCI (USD/Ton)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-xs font-semibold">
                      {filteredCplPrices.map(cpl => (
                        <tr key={cpl.month} className="divide-x divide-slate-50 hover:bg-slate-50/50 transition group">
                          <td className="px-3 py-3 font-mono text-slate-400 uppercase group-hover:text-blue-600 transition-colors">{cpl.month}</td>
                          <td className="px-3 py-3 text-slate-700 font-bold">{format(parseISO(cpl.month + '-01'), 'MMMM yyyy')}</td>
                          <td className="px-3 py-3 bg-blue-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-slate-300">$</span>
                              <input
                                type="number"
                                value={cpl.price}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'cplPrice', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-blue-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-blue-100 outline-none transition-all shadow-sm"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-amber-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-slate-300">$</span>
                              <input
                                type="number"
                                value={filteredNaphtha.find(n => n.month === cpl.month)?.price ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'naphthaPrice', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-amber-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-amber-100 outline-none transition-all shadow-sm"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-emerald-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-slate-300">$</span>
                              <input
                                type="number"
                                value={filteredBenzene.find(b => b.month === cpl.month)?.price ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'benzenePrice', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-emerald-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-emerald-100 outline-none transition-all shadow-sm"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-violet-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                type="number"
                                value={priceManagementRows.find(r => r.month === cpl.month)?.jpyUsdRate ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'jpyUsdRate', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-violet-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-violet-100 outline-none transition-all shadow-sm"
                                title="JPY per 1 USD"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-rose-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <input
                                type="number"
                                value={priceManagementRows.find(r => r.month === cpl.month)?.thbUsdRate ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'thbUsdRate', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-rose-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-rose-100 outline-none transition-all shadow-sm"
                                title="THB per 1 USD"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-cyan-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-slate-300">$</span>
                              <input
                                type="number"
                                value={priceManagementRows.find(r => r.month === cpl.month)?.cplTecnonPrice ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'cplTecnonPrice', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-cyan-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-cyan-100 outline-none transition-all shadow-sm"
                                title="CPL Tecnon TW Domestic"
                              />
                            </div>
                          </td>
                          <td className="px-3 py-3 bg-orange-50/10">
                            <div className="flex items-center justify-end gap-1.5">
                              <span className="text-slate-300">$</span>
                              <input
                                type="number"
                                value={priceManagementRows.find(r => r.month === cpl.month)?.cplPciPrice ?? 0}
                                onFocus={selectZeroPriceInput}
                                onMouseUp={keepZeroPriceSelected}
                                onChange={e => {
                                  const val = Number(e.target.value);
                                  updatePriceManagementCell(cpl.month, 'cplPciPrice', val);
                                }}
                                className="bg-white border border-slate-200 group-hover:border-orange-400 rounded-md px-2 py-1.5 font-mono font-bold text-sm text-right w-28 focus:ring-2 focus:ring-orange-100 outline-none transition-all shadow-sm"
                                title="CPL PCI"
                              />
                            </div>
                          </td>
                        </tr>
                      ))}
                      {filteredCplPrices.length === 0 && (
                        <tr>
                          <td colSpan={9} className="p-12 text-center">
                            <div className="flex flex-col items-center gap-2 opacity-30">
                              <Calendar size={48} />
                              <p className="font-bold uppercase tracking-widest text-xs">No data for FY {String(selectedFy).slice(-2)}</p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                
                {/* Bottom Status Bar */}
                <div className="h-10 border-t border-slate-200 bg-slate-50 px-6 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-6">
                    <div className="flex items-center gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500"></div>
                      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest">Master Data Live</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-[10px] text-slate-400 font-serif italic">Viewing FY {String(selectedFy).slice(-2)} · Records: {filteredCplPrices.length}</span>
                    <button 
                      onClick={handleSavePriceManagement}
                      disabled={isSaving || priceManagementRows.length === 0}
                      className="bg-green-600 hover:bg-green-700 text-white text-[10px] font-bold px-4 py-1.5 rounded shadow-sm transition-all active:scale-95 uppercase tracking-wider disabled:opacity-50"
                    >
                      {isSaving ? 'Saving...' : 'Save All Changes'}
                    </button>
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === 'dashboard' && (
              <motion.div
                key="dashboard"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex-1"
              >
                <PlaceholderView
                  title="Analytics"
                  icon={<BarChart3 size={48} />}
                  description="Power BI weekly and monthly sales reports will open from this area when the report link is ready."
                />
              </motion.div>
            )}

            {activeTab === 'overplan' && (
              <Suspense fallback={
                <div className="flex flex-1 items-center justify-center text-sm font-semibold text-slate-400">
                  Loading Diff Plan…
                </div>
              }>
                <div className="flex min-h-0 flex-1">
                  <OverplanView />
                </div>
              </Suspense>
            )}

            {activeTab === 'weekly' && (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-sm font-bold text-slate-400">Loading report...</div>}>
                <ReportView onShowDetail={() => setShowDetailModal(true)} title="Weekly Sales Report" description="Performance tracking by week and registration" data={forecastData} registrations={registrations} type="weekly" />
              </Suspense>
            )}
            {activeTab === 'monthly' && (
              <Suspense fallback={<div className="flex h-full items-center justify-center text-sm font-bold text-slate-400">Loading report...</div>}>
                <ReportView onShowDetail={() => setShowDetailModal(true)} title="Monthly Sales Report" description="Consolidated monthly performance vs previous year" data={forecastData} registrations={registrations} type="monthly" />
              </Suspense>
            )}
            {activeTab === 'yearly' && <BudgetView title="Yearly Budget - FY26" subtitle="Comparison: BB vs SepF vs DecF" registrations={registrations} />}
            {activeTab === 'mtp' && <BudgetView title="MTP Budget (3Yr Horizon)" subtitle="Strategic 3-year capacity & sales planning" isMtp registrations={registrations} />}
            {activeTab === 'pdc' && <PdcSummaryView data={forecastData} version={selectedVersion} registrations={registrations} />}
            {activeTab === 'suggestion' && <PlaceholderView title="Production Suggestion" icon={<Truck size={48} />} />}
          </AnimatePresence>
        </main>
      </div>

      {isCopyingForecastVersion && (
        <CopyForecastVersionModal
          versions={versions}
          sourceVersion={copyForecastSourceVersion}
          targetVersion={selectedVersion}
          isSaving={isSaving}
          onSourceChange={setCopyForecastSourceVersion}
          onClose={() => setIsCopyingForecastVersion(false)}
          onCopy={() => { ignorePromise(handleCopyForecastVersion()); }}
        />
      )}

      {isCopyingPriceVersion && (
        <CopyPriceVersionModal
          fy={selectedFy}
          versions={versions}
          sourceVersion={copySourceVersion}
          targetVersion={priceManagementVersion}
          isSaving={isSaving}
          onSourceChange={setCopySourceVersion}
          onClose={() => setIsCopyingPriceVersion(false)}
          onCopy={async () => {
            loadStart();
            setIsSaving(true);
            try {
              await api.priceManagement.copy(selectedFy, copySourceVersion, priceManagementVersion);
              const result = await api.priceManagement.list(selectedFy, 'Fcst', priceManagementVersion);
              setPriceManagementRows(result.rows);
              if (priceManagementVersion === selectedVersion) {
                setCplPrices(priceRowsToCplPrices(result.rows));
                setNaphthaprices(priceRowsToNaphthaPrices(result.rows));
                setBenzeneprices(priceRowsToBenzenePrices(result.rows));
                setJpyRates(priceRowsToJpyRates(result.rows));
                setThbRates(priceRowsToThbRates(result.rows));
                setTecnonPrices(priceRowsToTecnonPrices(result.rows));
                setPciPrices(priceRowsToPciPrices(result.rows));
              }
              setIsCopyingPriceVersion(false);
              setAppError(null);
            } catch (error) {
              const msg = error instanceof ApiError ? error.message : 'Failed to copy price version';
              setAppError(msg);
            } finally {
              setIsSaving(false);
              loadDone();
            }
          }}
        />
      )}

      {showDetailModal && (
        <DetailModal 
          onClose={() => setShowDetailModal(false)} 
          data={forecastData} 
          registrations={registrations}
        />
      )}
    </div>
  );
}

function InventoryCommitPreviewModal({
  open,
  rows,
  isInventoryLoading,
  isEmailPreviewLoading,
  onClose,
  onConfirm,
  onPreviewEmail,
}: Readonly<{
  open: boolean;
  rows: InventoryCommitPreviewRow[];
  isInventoryLoading: boolean;
  isEmailPreviewLoading?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  onPreviewEmail: () => void;
}>) {
  if (!open) return null;

  const formatQty = (value: number | undefined) =>
    value === undefined
      ? '-'
      : value.toLocaleString(undefined, {
          minimumFractionDigits: 3,
          maximumFractionDigits: 3,
        });
  const totalDelta = rows.reduce((sum, row) => sum + row.delta, 0);
  const inventoryDate = rows.find(row => row.inventory?.inventoryDate)?.inventory?.inventoryDate ?? null;
  const rowsWithInventory = rows.filter(row => row.inventory).length;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label="Close forecast save preview"
      />
      <div className="relative flex max-h-[86vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xl">
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#007ABE]/10 text-[#007ABE]">
              <Package size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                Confirm forecast save
              </h3>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                Review forecast changes and related inventory before saving.
                {inventoryDate ? ` Inventory as of ${inventoryDate}.` : ''}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid shrink-0 grid-cols-3 gap-3 border-b border-slate-100 bg-slate-50/50 px-5 py-3">
          <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2.5">
            <p className="text-[10px] font-medium text-slate-400">Changed cells</p>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums text-slate-800">
              {rows.length.toLocaleString()}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2.5">
            <p className="text-[10px] font-medium text-slate-400">Total forecast delta</p>
            <p className={cn(
              'mt-0.5 font-mono text-xl font-semibold tabular-nums',
              totalDelta === 0 ? 'text-slate-800' : deltaTextClass(totalDelta)
            )}>
              {totalDelta > 0 ? '+' : ''}{formatQty(totalDelta)}
            </p>
          </div>
          <div className="rounded-lg border border-slate-200/80 bg-white px-3 py-2.5">
            <p className="text-[10px] font-medium text-slate-400">Inventory loaded</p>
            <p className="mt-0.5 text-sm font-semibold text-slate-800">
              {isInventoryLoading ? (
                <span className="inline-flex items-center gap-1.5 text-slate-500">
                  <Loader2 size={14} className="animate-spin" />
                  Loading…
                </span>
              ) : (
                <span className="font-mono tabular-nums">
                  {rowsWithInventory}/{rows.length}
                </span>
              )}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-[1180px] w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-50 text-[10px] font-semibold text-slate-500">
              <tr>
                <th className="px-3 py-2.5 text-left font-medium">Registration</th>
                <th className="px-3 py-2.5 text-left font-medium">Period</th>
                <th className="px-3 py-2.5 text-left font-medium">Plant</th>
                <th className="px-3 py-2.5 text-left font-medium">Material</th>
                <th className="px-3 py-2.5 text-right font-medium">Old fcst</th>
                <th className="px-3 py-2.5 text-right font-medium">New fcst</th>
                <th className="px-3 py-2.5 text-right font-medium">Delta</th>
                <th className="px-3 py-2.5 text-right font-medium">Pending</th>
                <th className="px-3 py-2.5 text-right font-medium">A0</th>
                <th className="px-3 py-2.5 text-right font-medium">Non-A0</th>
                <th className="px-3 py-2.5 text-right font-medium">Wait judge</th>
                <th className="px-3 py-2.5 text-right font-medium">OG</th>
                <th className="px-3 py-2.5 text-right font-medium">YO</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(row => (
                <tr key={row.key} className="transition-colors hover:bg-slate-50/80">
                  <td className="max-w-[240px] px-3 py-2.5">
                    <div className="truncate font-medium text-slate-800" title={row.registration.registrationTopic}>
                      {row.registration.registrationTopic || row.registration.id}
                    </div>
                    <div className="truncate text-[10px] text-slate-400">
                      {row.registration.ownerName || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-slate-600">{row.period}</td>
                  <td className="px-3 py-2.5 font-mono text-slate-600">{row.registration.plantCode || '—'}</td>
                  <td className="px-3 py-2.5">
                    <div className="font-mono text-slate-700">{row.registration.materialCode || '—'}</div>
                    <div className="truncate text-[10px] text-slate-400">{row.registration.materialDescription || '—'}</div>
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-500">{formatQty(row.baseValue)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-medium text-slate-800">{formatQty(row.currentValue)}</td>
                  <td className={cn(
                    'px-3 py-2.5 text-right font-mono tabular-nums font-medium',
                    deltaTextClass(row.delta)
                  )}>
                    {row.delta > 0 ? '+' : ''}{formatQty(row.delta)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-700">
                    {formatQty(row.pendingMaterialDelta)}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">{formatQty(row.inventory?.a0Qty)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">{formatQty(row.inventory?.nonA0Qty)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">{formatQty(row.inventory?.waitJudgeQty)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">{formatQty(row.inventory?.ogQty)}</td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-slate-600">{formatQty(row.inventory?.yoQty)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-100 px-5 py-3.5">
          <p className="max-w-md text-[11px] leading-relaxed text-slate-400">
            Saving updates forecast values only. Inventory allocation rules will be applied in a later phase.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onPreviewEmail}
              disabled={isEmailPreviewLoading || rows.length === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-50"
            >
              {isEmailPreviewLoading ? <Loader2 size={14} className="animate-spin" /> : <Mail size={14} />}
              {isEmailPreviewLoading ? 'Loading…' : 'Send email'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              className="h-9 rounded-lg bg-[#007ABE] px-5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#0069a3]"
            >
              Confirm save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CopyForecastVersionModal({
  versions,
  sourceVersion,
  targetVersion,
  isSaving,
  onSourceChange,
  onClose,
  onCopy,
}: Readonly<{
  versions: string[];
  sourceVersion: string;
  targetVersion: string;
  isSaving: boolean;
  onSourceChange: (version: string) => void;
  onClose: () => void;
  onCopy: () => void;
}>) {
  const sourceOptions = versions.filter(version => version !== targetVersion);
  const selectedSource = sourceOptions.includes(sourceVersion)
    ? sourceVersion
    : sourceOptions[0] ?? '';

  useEffect(() => {
    if (selectedSource && selectedSource !== sourceVersion) onSourceChange(selectedSource);
  }, [onSourceChange, selectedSource, sourceVersion]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        aria-label="Close copy forecast version dialog"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#007ABE]/10 text-[#007ABE]">
              <Copy size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                Copy forecast version
              </h3>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                Copy all registration forecast values into the target version
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div>
              <label htmlFor="copy-forecast-source-version" className="mb-1.5 block text-[11px] font-medium text-slate-500">
                Copy from
              </label>
              <div className="relative">
                <select
                  id="copy-forecast-source-version"
                  value={selectedSource}
                  onChange={event => onSourceChange(event.target.value)}
                  className="sf-select h-10 w-full appearance-none rounded-lg border px-3 pr-9 text-sm outline-none"
                >
                  {sourceOptions.map(version => (
                    <option key={version} value={version}>{version}</option>
                  ))}
                </select>
                <ChevronRight
                  size={14}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rotate-90 text-slate-400"
                />
              </div>
            </div>

            <div className="flex h-10 items-center justify-center pb-0.5 text-slate-300">
              <ChevronRight size={18} />
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-medium text-slate-500">Copy to</p>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3">
                <p className="truncate text-sm font-semibold text-slate-800">{targetVersion}</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3.5 py-3">
            <p className="text-xs leading-relaxed text-amber-900/80">
              This replaces <span className="font-semibold">all</span> forecast qty, price, and amount values in <span className="font-semibold">{targetVersion}</span> with a full copy from the source (existing week/month rows in the target are removed). Spread and price formula are not copied.
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={isSaving || !selectedSource}
            className="inline-flex h-9 min-w-[120px] items-center justify-center gap-1.5 rounded-lg bg-[#007ABE] px-4 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#0069a3] disabled:opacity-50"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            {isSaving ? 'Copying…' : 'Confirm copy'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function CopyPriceVersionModal({
  fy,
  versions,
  sourceVersion,
  targetVersion,
  isSaving,
  onSourceChange,
  onClose,
  onCopy,
}: Readonly<{
  fy: number;
  versions: string[];
  sourceVersion: string;
  targetVersion: string;
  isSaving: boolean;
  onSourceChange: (version: string) => void;
  onClose: () => void;
  onCopy: () => void;
}>) {
  const sourceOptions = versions.filter(version => version !== targetVersion);
  const selectedSource = sourceOptions.includes(sourceVersion)
    ? sourceVersion
    : sourceOptions[0] ?? '';

  useEffect(() => {
    if (selectedSource && selectedSource !== sourceVersion) onSourceChange(selectedSource);
  }, [onSourceChange, selectedSource, sourceVersion]);

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
        aria-label="Close copy forecast price dialog"
        onClick={onClose}
      />
      <div className="relative w-full max-w-lg overflow-hidden rounded-xl border border-slate-200/80 bg-white shadow-xl">
        <header className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#007ABE]/10 text-[#007ABE]">
              <Copy size={18} />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-semibold tracking-tight text-slate-900">
                Copy forecast price
              </h3>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-500">
                FY {String(fy).slice(-2)} · Copy prices into the target version
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </header>

        <div className="space-y-4 px-5 py-4">
          <div className="grid grid-cols-[1fr_auto_1fr] items-end gap-3">
            <div>
              <label htmlFor="copy-source-version" className="mb-1.5 block text-[11px] font-medium text-slate-500">
                Copy from
              </label>
              <div className="relative">
                <select
                  id="copy-source-version"
                  value={selectedSource}
                  onChange={event => onSourceChange(event.target.value)}
                  className="sf-select h-10 w-full appearance-none rounded-lg border px-3 pr-9 text-sm outline-none"
                >
                  {sourceOptions.map(version => (
                    <option key={version} value={version}>{version}</option>
                  ))}
                </select>
                <ChevronRight
                  size={14}
                  className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rotate-90 text-slate-400"
                />
              </div>
            </div>

            <div className="flex h-10 items-center justify-center pb-0.5 text-slate-300">
              <ChevronRight size={18} />
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-medium text-slate-500">Copy to</p>
              <div className="flex h-10 items-center rounded-lg border border-slate-200 bg-slate-50 px-3">
                <p className="truncate text-sm font-semibold text-slate-800">{targetVersion}</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-amber-100 bg-amber-50/60 px-3.5 py-3">
            <p className="text-xs leading-relaxed text-amber-900/80">
              This replaces CPL, Naphtha, Benzene, FX, Tecnon, and PCI prices for every month in FY {String(fy).slice(-2)} in <span className="font-semibold">{targetVersion}</span>.
            </p>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-9 rounded-lg border border-slate-200 bg-white px-4 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onCopy}
            disabled={isSaving || !selectedSource}
            className="inline-flex h-9 min-w-[120px] items-center justify-center gap-1.5 rounded-lg bg-[#007ABE] px-4 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#0069a3] disabled:opacity-50"
          >
            {isSaving ? <Loader2 size={14} className="animate-spin" /> : <Copy size={14} />}
            {isSaving ? 'Copying…' : 'Confirm copy'}
          </button>
        </footer>
      </div>
    </div>
  );
}

function DetailModal({ onClose, data, registrations }: Readonly<{ onClose: () => void; data: ForecastValue[]; registrations: Registration[] }>) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close sales report details"
        onClick={onClose}
        className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
      />
      <motion.div 
        initial={{ opacity: 0, scale: 0.95, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        className="relative w-full max-w-5xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="p-6 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
          <div>
            <h3 className="text-xl font-bold text-slate-800">Sales Report Details</h3>
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Total Registration Breakdown</p>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-slate-200 rounded-full transition-colors"
          >
            <X size={20} className="text-slate-400" />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-6">
          <table className="w-full border-collapse">
            <thead className="sticky top-0 bg-white shadow-[0_1px_0_0_rgba(0,0,0,0.05)]">
              <tr className="text-[10px] font-black uppercase text-slate-400 tracking-widest">
                <th className="p-4 text-left">Registration</th>
                <th className="p-4 text-left">Product</th>
                <th className="p-4 text-right">Actual Qty</th>
                <th className="p-4 text-right">Forecast Qty</th>
                <th className="p-4 text-right">Variance</th>
                <th className="p-4 text-right">Performance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 text-xs font-semibold">
              {registrations.map(reg => {
                const regData = data.filter(d => d.registrationId === reg.id);
                const act = regData.reduce((s, c) => s + c.qtyAct, 0);
                const fcst = regData.reduce((s, c) => s + c.qtyFcst, 0);
                const variance = act - fcst;
                const perf = fcst > 0 ? (act / fcst) * 100 : 0;
                
                return (
                  <tr key={reg.id} className="hover:bg-slate-50/50 transition">
                    <td className="p-4">
                      <span className="text-slate-900 font-bold">{reg.registrationTopic}</span>
                      <p className="text-[10px] text-slate-400 uppercase">{reg.ownerName}</p>
                    </td>
                    <td className="p-4 text-slate-500">{reg.materialDescription}</td>
                    <td className="p-4 text-right font-mono text-slate-700">{act.toLocaleString()}</td>
                    <td className="p-4 text-right font-mono text-blue-600">{fcst.toLocaleString()}</td>
                    <td className={`p-4 text-right font-mono ${variance >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {variance > 0 ? '+' : ''}{variance.toLocaleString()}
                    </td>
                    <td className="p-4 text-right">
                      <span className={`px-2 py-1 rounded-full text-[10px] font-black ${perf >= 90 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {perf.toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="p-4 bg-slate-50 border-t border-slate-100 flex justify-end">
          <button 
            onClick={onClose}
            className="px-6 py-2 bg-slate-900 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-slate-800 transition shadow-lg"
          >
            Close Window
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// --- Component Views ---

function ReportView({ title, description, data, registrations, type, onShowDetail }: Readonly<{ title: string; description: string; data: ForecastValue[]; registrations: Registration[]; type: 'weekly' | 'monthly'; onShowDetail: () => void }>) {
  const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

  const trendData = useMemo(() => {
    const months = [...new Set(data.map(d => d.month))].sort((left, right) => left.localeCompare(right));
    return months.map(m => ({
      name: format(parseISO(m + '-01'), type === 'weekly' ? 'w\'WW' : 'MMM'),
      act: data.filter(d => d.month === m).reduce((s, c) => s + c.qtyAct, 0),
      fcst: data.filter(d => d.month === m).reduce((s, c) => s + c.qtyFcst, 0),
      variance: data.filter(d => d.month === m).reduce((s, c) => s + (c.qtyAct - c.qtyFcst), 0),
    }));
  }, [data, type]);

  const productData = useMemo(() => {
    const products: Record<string, number> = {};
    data.forEach(d => {
      const reg = registrations.find(r => r.id === d.registrationId);
      if (reg) {
        products[reg.materialDescription] = (products[reg.materialDescription] || 0) + d.qtyAct;
      }
    });
    return Object.entries(products).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [data, registrations]);

  const ownerData = useMemo(() => {
    const owners: Record<string, number> = {};
    data.forEach(d => {
      const reg = registrations.find(r => r.id === d.registrationId);
      if (reg) {
        owners[reg.ownerName] = (owners[reg.ownerName] || 0) + d.qtyAct;
      }
    });
    return Object.entries(owners).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [data, registrations]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full overflow-auto bg-slate-50/30">
      <div className="flex justify-between items-end border-b border-slate-200 pb-4 bg-white px-8 pt-4 sticky top-0 z-30 shadow-sm">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-800">{title}</h2>
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-0.5">{description}</p>
        </div>
        <div className="flex gap-2 pb-1">
          <button 
          onClick={async () => {
            const XLSX = await import('xlsx');
            const worksheet = XLSX.utils.json_to_sheet(trendData);
              const workbook = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(workbook, worksheet, "Performance_Trend");
              XLSX.writeFile(workbook, `${title.split(/\s+/).join('_')}_${format(new Date(), 'yyyyMMdd')}.xlsx`);
            }}
            className="bg-white border border-slate-200 text-slate-600 px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 hover:bg-slate-50 transition shadow-sm"
          >
            <Download size={14} /> Export XLS
          </button>
          <button 
            onClick={onShowDetail}
            className="bg-slate-900 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-2 hover:bg-slate-800 transition shadow-lg"
          >
            <TrendingUp size={14} /> Full Analytics
          </button>
        </div>
      </div>

      <div className="p-8 space-y-8 pb-12">
        {/* Hero KPIs */}
        <div className="grid grid-cols-4 gap-6">
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Total Actual Qty</p>
          <div className="flex items-end gap-2">
            <h4 className="text-2xl font-black text-slate-800 tracking-tighter">{data.reduce((s, c) => s + c.qtyAct, 0).toLocaleString()}</h4>
            <span className="text-[10px] text-green-500 font-bold mb-1">+12% vs LY</span>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Forecast Bias</p>
          <div className="flex items-end gap-2">
            <h4 className="text-2xl font-black text-slate-800 tracking-tighter">
              {((data.reduce((s, c) => s + c.qtyAct, 0) / data.reduce((s, c) => s + c.qtyFcst, 1)) * 100 - 100).toFixed(1)}%
            </h4>
            <span className="text-[10px] text-blue-500 font-bold mb-1">Under-forecasting</span>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm">
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Hit Rate</p>
          <div className="flex items-end gap-2">
            <h4 className="text-2xl font-black text-slate-800 tracking-tighter">
              {(Math.min(data.reduce((s, c) => s + c.qtyAct, 0), data.reduce((s, c) => s + c.qtyFcst, 0)) / Math.max(data.reduce((s, c) => s + c.qtyAct, 0), data.reduce((s, c) => s + c.qtyFcst, 1)) * 100).toFixed(1)}%
            </h4>
            <span className="text-[10px] text-amber-500 font-bold mb-1">Stable Accuracy</span>
          </div>
        </div>
        <div className="bg-white p-6 rounded-2xl border border-slate-200 shadow-sm group cursor-pointer hover:border-blue-400 transition-all active:scale-95" onClick={onShowDetail}>
          <p className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">Monthly Detail</p>
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-black text-blue-600 underline uppercase tracking-widest">Open Details</h4>
            <ChevronRight size={14} className="text-blue-500" />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-12 gap-6">
        {/* Chart 1: Trend */}
        <div className="col-span-8 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-[450px] flex flex-col">
          <div className="flex justify-between items-center mb-8">
            <h3 className="text-sm font-bold flex items-center gap-2">
              <TrendingUp size={16} className="text-blue-600" />
              Sales Performance Trend
            </h3>
            <div className="flex gap-4 text-[10px] font-black uppercase tracking-widest">
              <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-blue-500"></div> Actual</div>
              <div className="flex items-center gap-1.5"><div className="w-2.5 h-2.5 rounded-full bg-emerald-500"></div> Forecast</div>
            </div>
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trendData}>
              <defs>
                <linearGradient id="colorActView" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.1}/>
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorFcstView" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.1}/>
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
              <YAxis fontSize={10} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
              <Tooltip 
                contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)' }}
                itemStyle={{ fontSize: '12px', fontWeight: 'bold' }}
              />
              <Area type="monotone" dataKey="act" stroke="#3b82f6" strokeWidth={4} fillOpacity={1} fill="url(#colorActView)" name="Actual" />
              <Area type="monotone" dataKey="fcst" stroke="#10b981" strokeWidth={4} fillOpacity={1} fill="url(#colorFcstView)" name="Forecast" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Chart 2: Product Mix */}
        <div className="col-span-4 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-[450px] flex flex-col">
          <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
            <PieIcon size={16} className="text-orange-500" />
            Product Volume Mix
          </h3>
          <div className="flex-1 relative">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={productData}
                  cx="50%"
                  cy="50%"
                  innerRadius={60}
                  outerRadius={100}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {productData.map((entry, index) => (
                    <Cell key={entry.name} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip 
                  contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
                />
                <Legend layout="vertical" align="right" verticalAlign="middle" iconType="circle" wrapperStyle={{fontSize: '10px', fontWeight: 'bold'}} />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Owner Performance */}
        <div className="col-span-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-[400px] flex flex-col">
          <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
            <BarChart3 size={16} className="text-purple-500" />
            Performance by Sale Owner
          </h3>
          <ResponsiveContainer width="100%" height="100%">
            <ReBarChart data={ownerData} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f1f5f9" />
              <XAxis type="number" fontSize={10} axisLine={false} tickLine={false} hide />
              <YAxis dataKey="name" type="category" fontSize={10} axisLine={false} tickLine={false} width={100} tick={{fill: '#64748b', fontWeight: 'bold'}} />
              <Tooltip 
                cursor={{fill: '#f8fafc'}}
                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
              />
              <Bar dataKey="value" radius={[0, 8, 8, 0]} barSize={24}>
                {ownerData.map((entry, index) => (
                  <Cell key={entry.name} fill={COLORS[(index + 2) % COLORS.length]} />
                ))}
              </Bar>
            </ReBarChart>
          </ResponsiveContainer>
        </div>

        {/* Chart 4: Variance Analysis */}
        <div className="col-span-6 bg-white p-6 rounded-2xl border border-slate-200 shadow-sm h-[400px] flex flex-col">
          <h3 className="text-sm font-bold mb-6 flex items-center gap-2">
            <RefreshCw size={16} className="text-red-500" />
            Act vs Fcst Monthly Variance
          </h3>
          <ResponsiveContainer width="100%" height="100%">
            <ReBarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
              <XAxis dataKey="name" fontSize={10} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
              <YAxis fontSize={10} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
              <Tooltip 
                cursor={{fill: '#f8fafc'}}
                contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgb(0 0 0 / 0.1)' }}
              />
              <Bar dataKey="variance" radius={[6, 6, 0, 0]} barSize={32}>
                {trendData.map(entry => (
                  <Cell key={entry.name} fill={entry.variance >= 0 ? '#10b981' : '#ef4444'} />
                ))}
              </Bar>
            </ReBarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  </motion.div>
);
}

function InsightItem({ label, value, sub }: Readonly<{ label: string; value: string; sub: string }>) {
  return (
    <div>
      <p className="text-[10px] text-slate-400 font-bold uppercase">{label}</p>
      <p className="text-2xl font-black text-white">{value}</p>
      <p className="text-[10px] text-blue-400 font-medium italic">{sub}</p>
    </div>
  );
}

function budgetPlaceholderFor(registrationId: string, year: string) {
  const seed = `${registrationId}-${year}`
    .split('')
    .reduce((total, char) => total + char.charCodeAt(0), 0);
  return {
    volume: (seed * 7919) % 1_000_000,
    variance: ((seed % 50) / 10).toFixed(1),
    positive: seed % 2 === 0,
  };
}

function BudgetView({ title, subtitle, isMtp, registrations }: Readonly<{ title: string; subtitle: string; isMtp?: boolean; registrations: Registration[] }>) {
  const years = isMtp ? ['2026', '2027', '2028'] : ['FY26 BB', 'FY26 SepF', 'FY26 DecF'];
  
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full overflow-auto bg-slate-50/30">
      <div className="flex justify-between items-end border-b border-slate-200 pb-4 bg-white px-8 pt-4 sticky top-0 z-30 shadow-sm">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-800">{title}</h2>
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-0.5">{subtitle}</p>
        </div>
      </div>

      <div className="p-8 space-y-8 pb-12">
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <table className="w-full border-collapse text-left">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="divide-x divide-slate-200">
              <th className="p-4 text-[10px] font-black uppercase text-slate-400 w-64">Registration / Scope</th>
              {years.map(y => (
                <th key={y} className="p-4 text-[10px] font-black uppercase text-blue-600 text-center">{y}</th>
              ))}
              <th className="p-4 text-[10px] font-black uppercase text-slate-400 text-center w-32">Variance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-xs font-medium">
            {registrations.map(reg => (
              <tr key={reg.id} className="divide-x divide-slate-50 hover:bg-slate-50/50 transition">
                <td className="p-4">
                  <span className="font-bold text-slate-900">{reg.registrationTopic}</span>
                  <p className="text-[10px] text-slate-400">{reg.materialDescription} · {reg.countryName}</p>
                </td>
                {years.map(y => {
                  const placeholder = budgetPlaceholderFor(reg.id, y);
                  return (
                    <td key={y} className="p-4 text-center font-mono">
                      {placeholder.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                    </td>
                  );
                })}
                <td className="p-4 text-center">
                  <span className={cn(
                    "px-2 py-0.5 rounded-full text-[10px] font-bold",
                    budgetPlaceholderFor(reg.id, 'variance').positive ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"
                  )}>
                    {budgetPlaceholderFor(reg.id, 'variance').positive ? '+' : '-'}{budgetPlaceholderFor(reg.id, 'variance').variance}%
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  </motion.div>
);
}

function PdcSummaryView({ data, version, registrations }: Readonly<{ data: ForecastValue[]; version: string; registrations: Registration[] }>) {
  const summary = useMemo(() => {
    // Group by product
    const products = [...new Set(registrations.map(r => r.materialDescription))];
    return products.map(p => {
      const regs = registrations.filter(r => r.materialDescription === p);
      const qty = data
        .filter(d => regs.some(r => r.id === d.registrationId) && d.version === version)
        .reduce((s, c) => s + c.qtyFcst, 0);
      return { product: p, qty };
    });
  }, [data, version, registrations]);

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full overflow-auto bg-slate-50/30">
      <div className="flex justify-between items-end border-b border-slate-200 pb-4 bg-white px-8 pt-4 sticky top-0 z-30 shadow-sm">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-slate-800">Production Control Summary</h2>
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-0.5">Aggregated Qty for Manufacturing Planning · {version}</p>
        </div>
      </div>

      <div className="p-8 space-y-8 pb-12">
        <div className="grid grid-cols-2 gap-8">
        <div className="bg-white rounded-2xl border border-slate-200 p-6 flex flex-col gap-6">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Box size={16} className="text-blue-600" />
            Product Allocation
          </h3>
          <div className="flex-1 space-y-4">
            {summary.map(s => (
              <div key={s.product} className="flex flex-col gap-2">
                <div className="flex justify-between items-end">
                  <span className="text-xs font-bold text-slate-700">{s.product}</span>
                  <span className="text-[10px] font-mono text-slate-400 tracking-tighter">{s.qty.toLocaleString()} Units</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }} 
                    animate={{ width: `${Math.min(100, (s.qty / 2000) * 100)}%` }} 
                    className="h-full bg-blue-600 rounded-full" 
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200 p-8 flex flex-col items-center justify-center text-center gap-4">
          <div className="w-16 h-16 bg-white rounded-full shadow-lg flex items-center justify-center text-blue-600">
            <Plus size={32} />
          </div>
          <div>
            <h4 className="font-bold text-slate-900">Custom PDC Profile</h4>
            <p className="text-xs text-slate-500 max-w-[200px] mt-1">Create a new summary view with custom product groups or destinations.</p>
          </div>
          <button className="bg-slate-900 text-white px-6 py-2 rounded-lg text-xs font-bold uppercase tracking-wider">Configure</button>
        </div>
      </div>
    </div>
  </motion.div>
);
}

function PlaceholderView({
  title,
  icon,
  description,
}: Readonly<{
  title: string;
  icon: React.ReactNode;
  description?: string;
}>) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="h-full flex flex-col items-center justify-center text-center p-12 space-y-4">
      <div className="text-slate-200 animate-pulse">{icon}</div>
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-slate-400">{title}</h2>
        <p className="text-slate-400 text-xs font-black uppercase tracking-widest mt-1 italic">Coming Soon</p>
      </div>
      <div className="max-w-md bg-blue-50/50 p-6 rounded-2xl border border-blue-100">
        <p className="text-xs text-blue-600 leading-relaxed font-medium">
          {description ?? 'This module is being prepared for the next phase.'}
        </p>
      </div>
    </motion.div>
  );
}

function FilterGroup({ label, action, children }: Readonly<{ label: string; action?: React.ReactNode; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest px-0.5">{label}</span>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
