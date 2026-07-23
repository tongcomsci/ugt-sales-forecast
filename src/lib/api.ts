import type {
  ActualValue,
  CPLPrice,
  CustomColumnDef,
  CustomColumnType,
  CustomColumnValue,
  ForecastSummary,
  ForecastSummaryRequest,
  ForecastValue,
  InventoryRow,
  ManagedRegistrationUpdateResponse,
  PriceManagementRow,
  PriceManagementType,
  Registration,
} from '../types/forecast';
import {
  getActiveClientAppMode,
  toPublicAppMode,
} from './appModeClient';
import { withRegistrationIncompleteFlag } from './registrationIncomplete';

export const REGISTRATION_PAGE_SIZE = 80;
export const FORECAST_LIST_REGISTRATION_CHUNK_SIZE = 500;
export const FORECAST_PRIORITY_REGISTRATION_COUNT = 120;
export const FORECAST_BACKGROUND_CHUNK_SIZE = 200;
export const FORECAST_LIST_CONCURRENCY = 4;

export interface ForecastListParams {
  version?: string;
  startPeriod?: string;
  endPeriod?: string;
  granularity?: 'month' | 'week';
  registrationIds?: string[];
  signal?: AbortSignal;
}

export interface ForecastListChunkMeta {
  chunkIndex: number;
  totalChunks: number;
}

export interface ForecastListProgressiveOptions {
  onChunk: (rows: ForecastValue[], meta: ForecastListChunkMeta) => void | Promise<void>;
  signal?: AbortSignal;
  concurrency?: number;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (items.length <= chunkSize) return [items];
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize));
  }
  return chunks;
}

export interface CurrentForecastImportRecord {
  sourceRow: number;
  excelKeyForNoRegist: string;
  matchedRegistrationId: string;
  version: 'Current Forecast';
  sourceColumn: string;
  sourceMonthHeader: string;
  forecastMonth: string;
  period: string;
  granularity: 'week';
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
  action: 'create' | 'overwrite';
  oldQtyFcst: number | null;
  oldPriceFcst?: number | null;
  oldAmountFcst?: number | null;
}

export interface CurrentForecastUnifiedPreviewRow {
  sourceRow: number | null;
  sourceRows: number[];
  status: 'matched' | 'actual_only' | 'registration_only' | 'proposed_registration';
  keyRegist: string | null;
  keyNoRegist: string;
  country: string | null;
  soldTo: string | null;
  shipTo: string | null;
  enduser: string | null;
  plant: string | null;
  materialCode: string | null;
  onOff: string | null;
  process: string | null;
  application: string | null;
  subApplication: string | null;
  owner: string | null;
  businessUnit: string | null;
  qtyActual: number;
  qtyFcst: number;
  dimensionSource: 'registration' | 'actual' | 'excel' | 'actual_with_excel_fallback' | 'registration_with_actual_fallback';
}

export interface CurrentForecastImportPreview {
  previewContractVersion: number;
  summary: {
    sheetName: string;
    sheetNames?: string[];
    version: 'Current Forecast';
    totalRows: number;
    validRows: number;
    importableRecords: number;
    candidateRecords: number;
    headerErrors: number;
    missingKeyRows: number;
    unmatchedRows: number;
    duplicateExcelKeys: number;
    duplicateRegistrationMatches: number;
    crossSheetDuplicateKeys?: number;
    invalidNumericValues: number;
    existingDbConflicts: number;
    matchedRows: number;
    actualOnlyRows: number;
    registrationOnlyRows: number;
    proposedRegistrationRows: number;
    registrationsToCreate?: number;
    uniqueExcelKeys: number;
    groupedDuplicateKeys: number;
    createRecords: number;
    overwriteRecords: number;
    skippedKeyGroups?: number;
    excludedQty?: number;
    hasPriceColumns?: boolean;
    hasAmountColumns?: boolean;
    pricingPoliciesDetected?: number;
    unknownPricingPolicies?: number;
    excelTotalQty?: number;
    excelTotalAmount?: number;
    importTotalQty?: number;
    importTotalAmount?: number;
  };
  expectedForecastColumns: Array<{
    col: string;
    index: number;
    header: string;
    month: string;
    period: string;
  }>;
  detectedHeaders: Array<{ index: number; name: string }>;
  headerErrors: Array<{ sourceSheet?: string; column: string; expected: string; actual: string }>;
  missingKeyRows: Array<{ sourceSheet?: string; sourceRow: number }>;
  duplicateExcelKeys: Array<{
    excelKeyForNoRegist: string;
    sourceRows: number[];
    sourceSheet?: string;
    entries?: Array<{ sourceSheet: string; sourceRow: number }>;
  }>;
  crossSheetDuplicateKeys?: Array<{
    excelKeyForNoRegist: string;
    entries: Array<{ sourceSheet: string; sourceRow: number }>;
  }>;
  unmatchedRows: Array<{
    sourceSheet?: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    reasonCode: string;
    reason: string;
    hint?: string;
    parsedKey?: {
      soldTo: string;
      shipTo: string;
      enduser: string;
      plant: string;
      material: string;
      onOff: string;
    };
  }>;
  duplicateRegistrationMatches: Array<{
    sourceSheet?: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationIds: string[];
  }>;
  invalidNumericValues: Array<{
    sourceSheet?: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    column: string;
    header: string;
    value: unknown;
    reason?: string;
  }>;
  skippedKeyGroups?: Array<{
    excelKeyForNoRegist: string;
    sourceRows: number[];
    sourceSheet?: string;
    reason: string;
    reasonCode: 'invalid_forecast_number' | 'excluded_plant';
    qtyExcluded?: number;
  }>;
  existingDbConflicts: Array<{
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationId: string;
    period: string;
    sourceMonthHeader: string;
  }>;
  overwriteRecords: Array<{
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationId: string;
    period: string;
    sourceMonthHeader: string;
    oldQtyFcst: number;
    newQtyFcst: number;
  }>;
  unifiedPreviewRows: CurrentForecastUnifiedPreviewRow[];
  importableRecords: CurrentForecastImportRecord[];
}

export interface CurrentForecastImportResult {
  ok: boolean;
  imported: number;
  created: number;
  overwritten: number;
  version: string;
  registrationsCreated?: number;
  createdRegistrationIds?: string[];
}

export interface VersionedExpectedColumn {
  month: string;
  period: string;
  qty: { col: string; index: number; header: string };
  price: { col: string; index: number; header: string };
  amount: { col: string; index: number; header: string };
}

export interface VersionedForecastImportRecord {
  sourceRow: number;
  excelKeyForNoRegist: string;
  matchedRegistrationId: string;
  version: string;
  sourceColumn: string;
  sourceMonthHeader: string;
  forecastMonth: string;
  period: string;
  granularity: 'month';
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
  action: 'create' | 'overwrite';
  oldQtyFcst: number | null;
  oldPriceFcst?: number | null;
  oldAmountFcst?: number | null;
}

export interface AmountMismatchWarning {
  sourceSheet: string;
  sourceRow: number;
  excelKeyForNoRegist: string;
  forecastMonth: string;
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
  expectedAmount: number;
  difference: number;
}

export type LegacyForecastImportPreview = CurrentForecastImportPreview & {
  importMode: 'current_forecast';
  previewId: string;
};

export type VersionedForecastImportPreview = Omit<
  CurrentForecastImportPreview,
  'expectedForecastColumns' | 'summary' | 'importableRecords'
> & {
  previewId: string;
  importMode: 'versioned';
  targetVersion: string;
  excelVersionLabel: string;
  versionExists: boolean;
  expectedColumns: VersionedExpectedColumn[];
  amountMismatchWarnings: AmountMismatchWarning[];
  summary: CurrentForecastImportPreview['summary'] & {
    version: string;
    amountMismatchWarnings?: number;
  };
  importableRecords: VersionedForecastImportRecord[];
};

export type ForecastImportPreview = LegacyForecastImportPreview | VersionedForecastImportPreview;

export type ForecastImportResult = CurrentForecastImportResult;

export function isVersionedImportPreview(
  preview: ForecastImportPreview
): preview is VersionedForecastImportPreview {
  if (preview.importMode === 'versioned') return true;
  return 'expectedColumns' in preview && Array.isArray(preview.expectedColumns) && 'previewId' in preview;
}

export const LEGACY_FORECAST_IMPORT_CONTRACT_VERSION = 13;
export const VERSIONED_FORECAST_IMPORT_CONTRACT_VERSION = 7;

export interface OverplanConfig {
  id: string;
  planVersionName: string;
  actualVsPlanEnabled: boolean;
  forecastVsPlanEnabled: boolean;
  compareLeft: string;
  compareRight: string;
  aboveEnabled: boolean;
  belowEnabled: boolean;
  aboveThresholdTon: number | null;
  aboveThresholdPercent: number | null;
  belowThresholdTon: number | null;
  belowThresholdPercent: number | null;
  updatedBy: string;
  updatedAt: string;
}

export interface OverplanRecipient {
  id: string;
  reportType: 'aggregate' | 'non_aggregate' | 'forecast_change';
  email: string;
  displayName: string | null;
  isActive: boolean;
  sortOrder: number;
}

export interface EmailRecipientPreview {
  email: string;
  displayName: string;
  source: 'owner' | 'distribution';
}

export interface EmailBatchPreview {
  id: string;
  reportType: 'aggregate' | 'non_aggregate' | 'forecast_change';
  title: string;
  subject: string;
  html: string;
  recipients: EmailRecipientPreview[];
  rowCount: number;
  previewOnly: true;
}

export interface EmployeeContact {
  empCode: string;
  fullNameEng: string;
  currentEmail: string;
  costCenterEng: string;
}

export interface ForecastCcRecipient {
  id: string;
  empCode: string;
  fullNameEng: string;
  currentEmail: string;
  notifyEnabled: boolean;
  source: string;
  sortOrder: number;
}

export interface ForecastEmailOwner {
  ownerName: string;
  fullNameEng: string;
  currentEmail: string;
  hasEmail: boolean;
  routedToFallback?: boolean;
  notifyDisplayName?: string;
}

export interface OverplanResultRow {
  materialCode: string;
  materialDescription: string;
  plantCode: string;
  period: string;
  leftQty: number;
  rightQty: number;
  diffQty: number;
  pctVsRight: number | null;
  status: 'over' | 'under' | 'ok';
  breachReasons: string[];
  ownerName?: string;
  registrationId?: string;
}

export interface OverplanEvaluateResponse {
  generatedAt: string;
  view: 'aggregate' | 'detail';
  compareLeft: string;
  compareRight: string;
  page: number;
  pageSize: number;
  totalRows: number;
  hasMore: boolean;
  breachOnly: boolean;
  summary: {
    overCount: number;
    underCount: number;
  };
  rows: OverplanResultRow[];
}

export interface OverplanEvaluateRequest {
  startMonth: string;
  endMonth: string;
  granularity?: 'month' | 'week';
  compareLeft?: string;
  compareRight?: string;
  view: 'aggregate' | 'detail';
  breachOnly?: boolean;
  status?: 'over' | 'under';
  page?: number;
  pageSize?: number;
  filters?: Record<string, string[]>;
}

export type AppConfig = {
  appMode: 'nyl' | 'ufa';
  publicMode?: 'nylon' | 'ufa';
  allowedBusinessUnits: string[];
  displayName: string;
  basePath: string;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function formatApiError(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.status === 404) {
    return 'API endpoint not found — restart API server (npm run server) or deploy the latest backend.';
  }
  if (error.status === 431) {
    return 'Request too large (HTTP 431) — refresh the page. If this persists, restart the API server.';
  }
  return error.message || fallback;
}

export interface RegistrationPage {
  items: Registration[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface FilterOptionsPage {
  items: string[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SnapshotStatus {
  enabled: boolean;
  activeVersion: string | null;
  status: 'disabled' | 'empty' | 'idle' | 'syncing' | 'ready' | 'failed' | string;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
  rowCount: number;
}

export interface ForecastAuditChange {
  id: string;
  batchId: string;
  source: 'manual_commit' | 'excel_import' | string;
  changedBy: string;
  batchCreatedAt: string;
  registrationId: string;
  versionName: string;
  period: string;
  granularity: string;
  oldQtyFcst: number | null;
  newQtyFcst: number;
  oldPriceFcst: number | null;
  newPriceFcst: number;
  oldAmountFcst: number | null;
  newAmountFcst: number;
  changedAt: string;
}

export interface ForecastCellAuditSummary {
  totalChanges: number;
  latestChanges: ForecastAuditChange[];
}

export interface AuthUser {
  name: string;
  email: string;
  loginName?: string;
}

export type AppRole = 'admin' | 'super_user' | 'user';

export interface SessionPermissions {
  role: AppRole;
  canManageAdmin: boolean;
  canManageEmail: boolean;
  empCode: string | null;
}

export interface AuthMeResponse {
  authenticated: boolean;
  user: AuthUser;
  permissions?: SessionPermissions;
}

export interface AppRoleAssignment {
  empCode: string;
  fullNameEng: string;
  currentEmail: string;
  role: 'admin' | 'super_user';
  source: string;
  assignedBy: string | null;
  assignedAt: string;
}

const appBasePath = (
  (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL || '/'
).replace(/\/+$/, '');

/** Join app base + path without creating `//` (Express 404s on double-slash mounts). */
function withAppBase(path: string) {
  const [pathnamePart, query = ''] = path.split('?');
  const normalizedPath = (pathnamePart.startsWith('/') ? pathnamePart : `/${pathnamePart}`)
    .replace(/\/{2,}/g, '/');
  const suffix = query ? `?${query}` : '';
  if (!appBasePath) return `${normalizedPath}${suffix}`;
  if (
    normalizedPath === appBasePath ||
    normalizedPath.startsWith(`${appBasePath}/`)
  ) {
    return `${normalizedPath}${suffix}`;
  }
  return `${appBasePath}${normalizedPath}${suffix}`.replace(/\/{2,}/g, '/');
}

function withModeQuery(path: string) {
  const mode = toPublicAppMode(getActiveClientAppMode());
  const [pathname, query = ''] = path.split('?');
  const params = new URLSearchParams(query);
  params.set('mode', mode);
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function modeHeaders(): HeadersInit {
  return { 'X-App-Mode': toPublicAppMode(getActiveClientAppMode()) };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(withAppBase(withModeQuery(path)), {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...modeHeaders(),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && typeof body?.loginUrl === 'string') {
      window.location.href = body.loginUrl;
    }
    throw new ApiError(res.status, body?.error ?? `Request failed: ${res.status}`, body);
  }
  return res.json() as Promise<T>;
}

type ForecastListApiRow = {
  registrationId: string;
  period: string;
  version: string;
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
};

function mapForecastListRows(rows: ForecastListApiRow[]): ForecastValue[] {
  return rows.map(r => ({
    registrationId: r.registrationId,
    month: r.period,
    version: r.version,
    qtyAct: 0,
    qtyFcst: r.qtyFcst,
    priceFcst: r.priceFcst,
    amountFcst: r.amountFcst,
    priceAct: 0,
  }));
}

async function runForecastListProgressive(
  params: ForecastListParams,
  options: ForecastListProgressiveOptions,
): Promise<{ totalChunks: number }> {
  const signal = options.signal ?? params.signal;
  const fetchChunk = async (registrationIds?: string[]) => {
    if (registrationIds && registrationIds.length > 0) {
      return request<ForecastListApiRow[]>('/api/forecast/query', {
        method: 'POST',
        body: JSON.stringify({
          version: params.version,
          startPeriod: params.startPeriod,
          endPeriod: params.endPeriod,
          granularity: params.granularity,
          registrationIds,
        }),
        signal,
      });
    }
    const qs = new URLSearchParams();
    if (params.version) qs.set('version', params.version);
    if (params.startPeriod) qs.set('startPeriod', params.startPeriod);
    if (params.endPeriod) qs.set('endPeriod', params.endPeriod);
    if (params.granularity) qs.set('granularity', params.granularity);
    return request<ForecastListApiRow[]>(
      `/api/forecast?${qs.toString()}`,
      { signal }
    );
  };

  const registrationIds = params.registrationIds ?? [];
  const idChunks = registrationIds.length > 0
    ? chunkArray(registrationIds, FORECAST_LIST_REGISTRATION_CHUNK_SIZE)
    : [undefined as string[] | undefined];
  const totalChunks = idChunks.length;
  const concurrency = Math.max(1, options.concurrency ?? FORECAST_LIST_CONCURRENCY);

  const firstRows = await fetchChunk(idChunks[0]);
  if (signal?.aborted) return { totalChunks };
  await options.onChunk(mapForecastListRows(firstRows), { chunkIndex: 0, totalChunks });

  for (let offset = 1; offset < idChunks.length; offset += concurrency) {
    const batch = idChunks.slice(offset, offset + concurrency);
    const results = await Promise.all(batch.map(ids => fetchChunk(ids)));
    if (signal?.aborted) return { totalChunks };
    for (let index = 0; index < results.length; index += 1) {
      await options.onChunk(
        mapForecastListRows(results[index]),
        { chunkIndex: offset + index, totalChunks },
      );
    }
  }

  return { totalChunks };
}

// ── Registrations ────────────────────────────────────────────────────────────

export const api = {
  appConfig: {
    get: (): Promise<AppConfig> => request('/api/app-config'),
  },

  auth: {
    me: async (): Promise<AuthMeResponse> => {
      const res = await fetch(withAppBase(withModeQuery('/auth/me')), {
        headers: modeHeaders(),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new ApiError(res.status, body?.error ?? `Request failed: ${res.status}`, body);
      }
      return body as AuthMeResponse;
    },
    logout: async (): Promise<{ ok: boolean; logoutUrl?: string }> => {
      const result = await request<{ ok: boolean; logoutUrl?: string }>('/auth/logout', { method: 'POST' });
      if (result.logoutUrl) window.location.href = result.logoutUrl;
      return result;
    },
    loginUrl: () => withAppBase(withModeQuery('/auth/login')),
  },

  sync: {
    status: (): Promise<SnapshotStatus> => request('/api/sync/status'),
    refresh: (): Promise<SnapshotStatus> =>
      request('/api/sync/refresh', { method: 'POST' }),
  },

  inventory: {
    list: (): Promise<InventoryRow[]> => request('/api/inventory'),
    query: (registrationIds: string[], signal?: AbortSignal): Promise<InventoryRow[]> =>
      request('/api/inventory/query', {
        method: 'POST',
        body: JSON.stringify({ registrationIds }),
        signal,
      }),
  },

  registrations: {
    list: (
      filters: Record<string, string[]> = {},
      signal?: AbortSignal
    ): Promise<Registration[]> => {
      const qs = new URLSearchParams();
      if (Object.keys(filters).length > 0) qs.set('filters', JSON.stringify(filters));
      const query = qs.toString();
      return request(`/api/registrations${query ? `?${query}` : ''}`, { signal });
    },
    managed: async (): Promise<Registration[]> => {
      const rows = await request<Registration[]>('/api/registrations/managed');
      return rows.map(withRegistrationIncompleteFlag);
    },
    create: (registration: Registration): Promise<Registration> =>
      request('/api/registrations', {
        method: 'POST',
        body: JSON.stringify(registration),
      }),
    update: (registration: Registration): Promise<ManagedRegistrationUpdateResponse> =>
      request(`/api/registrations/${encodeURIComponent(registration.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(registration),
      }),
    updateSpread: (registrationId: string, spread: string | null, updatedBy?: string): Promise<{ registrationId: string; spread: string | null }> =>
      request(`/api/registrations/${encodeURIComponent(registrationId)}/spread`, {
        method: 'PATCH',
        body: JSON.stringify({ spread, updatedBy }),
      }),
    updatePriceSettings: (
      registrationId: string,
      settings: { spread?: string | null; pricingPolicy?: string | null },
      updatedBy?: string,
    ): Promise<{ registrationId: string; spread: string | null; pricingPolicy: string | null }> =>
      request(`/api/registrations/${encodeURIComponent(registrationId)}/price-settings`, {
        method: 'PATCH',
        body: JSON.stringify({ ...settings, updatedBy }),
      }),
    remove: (registrationId: string): Promise<{ ok: boolean }> =>
      request(`/api/registrations/${encodeURIComponent(registrationId)}`, {
        method: 'DELETE',
      }),
    page: (
      cursor?: string | null,
      limit = 80,
      filters: Record<string, string[]> = {},
      signal?: AbortSignal
    ): Promise<RegistrationPage> => {
      const qs = new URLSearchParams({ limit: String(limit) });
      if (cursor) qs.set('cursor', cursor);
      if (Object.keys(filters).length > 0) qs.set('filters', JSON.stringify(filters));
      return request(`/api/registrations?${qs.toString()}`, { signal });
    },
    filterOptions: (
      column: string,
      search = '',
      filters: Record<string, string[]> = {},
      cursor?: string | null,
      limit = 200
    ): Promise<FilterOptionsPage> => {
      const qs = new URLSearchParams({ column, limit: String(limit) });
      if (search) qs.set('search', search);
      if (Object.keys(filters).length > 0) qs.set('filters', JSON.stringify(filters));
      if (cursor) qs.set('cursor', cursor);
      return request(`/api/registrations/filter-options?${qs.toString()}`);
    },
  },

  // ── Forecast values ──────────────────────────────────────────────────────
  forecast: {
    query: async (params: ForecastListParams = {}): Promise<ForecastValue[]> => {
      const registrationIds = params.registrationIds ?? [];
      if (registrationIds.length === 0) return [];
      const rows = await request<ForecastListApiRow[]>('/api/forecast/query', {
        method: 'POST',
        body: JSON.stringify({
          version: params.version,
          startPeriod: params.startPeriod,
          endPeriod: params.endPeriod,
          granularity: params.granularity,
          registrationIds,
        }),
        signal: params.signal,
      });
      return mapForecastListRows(rows);
    },

    list: async (params: ForecastListParams = {}): Promise<ForecastValue[]> => {
      const collected: ForecastValue[] = [];
      await runForecastListProgressive(params, {
        signal: params.signal,
        onChunk: rows => {
          collected.push(...rows);
        },
      });
      return collected;
    },

    listProgressive: runForecastListProgressive,

    save: (
      values: ForecastValue[],
      changedBy = 'User (Admin)',
      stampPeriod = 'No'
    ): Promise<{ ok: boolean; updated: number }> =>
      request('/api/forecast', {
        method: 'PATCH',
        body: JSON.stringify({
          changedBy,
          stampPeriod,
          values: values.map(v => ({
            registrationId: v.registrationId,
            version:        v.version,
          period:         v.month,    // map month → period for server
            granularity:    /^\d{4}-\d{2}-\d{2}$/.test(v.month) ? 'week' : 'month',
            qtyFcst:        v.qtyFcst,
            priceFcst:      v.priceFcst ?? 0,
            amountFcst:     v.amountFcst ?? 0,
          })),
        }),
      }),

    auditCell: (
      registrationId: string,
      version: string,
      period: string,
      signal?: AbortSignal
    ): Promise<ForecastCellAuditSummary> => {
      const qs = new URLSearchParams({ registrationId, version, period });
      return request(`/api/forecast/audit/cell?${qs.toString()}`, { signal });
    },

    audit: (params: {
      registrationId?: string;
      version?: string;
      start?: string;
      end?: string;
      signal?: AbortSignal;
    }): Promise<ForecastAuditChange[]> => {
      const qs = new URLSearchParams();
      if (params.registrationId) qs.set('registrationId', params.registrationId);
      if (params.version) qs.set('version', params.version);
      if (params.start) qs.set('start', params.start);
      if (params.end) qs.set('end', params.end);
      return request(`/api/forecast/audit?${qs.toString()}`, { signal: params.signal });
    },

    summary: (
      params: ForecastSummaryRequest,
      signal?: AbortSignal
    ): Promise<ForecastSummary> =>
      request('/api/forecast/summary', {
        method: 'POST',
        body: JSON.stringify(params),
        signal,
      }),

    copyVersion: (
      sourceVersion: string,
      targetVersion: string
    ): Promise<{ ok: boolean; copied: number; sourceVersion: string; targetVersion: string }> =>
      request('/api/forecast/copy-version', {
        method: 'POST',
        body: JSON.stringify({ sourceVersion, targetVersion }),
      }),
  },

  // ── Actuals ───────────────────────────────────────────────────────────────
  actuals: {
    list: (
      startMonth?: string,
      endMonth?: string,
      registrationIds?: string[],
      filters: Record<string, string[]> = {},
      granularity: 'month' | 'week' = 'month',
      signal?: AbortSignal
    ): Promise<ActualValue[]> => {
      if (registrationIds && registrationIds.length > 0) {
        return request('/api/actuals/query', {
          method: 'POST',
          body: JSON.stringify({
            startMonth,
            endMonth,
            registrationIds,
            filters,
            granularity,
          }),
          signal,
        });
      }

      const qs = new URLSearchParams();
      if (startMonth) qs.set('startMonth', startMonth);
      if (endMonth)   qs.set('endMonth',   endMonth);
      qs.set('granularity', granularity);
      if (Object.keys(filters).length > 0) qs.set('filters', JSON.stringify(filters));
      const query = qs.toString();
      return request(`/api/actuals${query ? '?' + query : ''}`, { signal });
    },
    latestPrice: (
      registrationIds: string[],
      signal?: AbortSignal,
    ): Promise<Array<{ registrationId: string; price: number }>> => {
      if (registrationIds.length === 0) return Promise.resolve([]);
      return request('/api/actuals/latest-price', {
        method: 'POST',
        body: JSON.stringify({ registrationIds }),
        signal,
      });
    },
  },

  // ── CPL prices ────────────────────────────────────────────────────────────
  cpl: {
    list: (fy?: number): Promise<CPLPrice[]> => {
      const qs = fy !== undefined ? `?fy=${fy}` : '';
      return request(`/api/cpl-prices${qs}`);
    },

    create: (month: string, price: number): Promise<{ ok: boolean }> =>
      request('/api/cpl-prices', {
        method: 'POST',
        body: JSON.stringify({ month, price }),
      }),

    update: (month: string, price: number): Promise<{ ok: boolean }> =>
      request(`/api/cpl-prices/${month}`, {
        method: 'PATCH',
        body: JSON.stringify({ price }),
      }),

    remove: (month: string): Promise<{ ok: boolean }> =>
      request(`/api/cpl-prices/${month}`, { method: 'DELETE' }),
  },

  // ── Versions ──────────────────────────────────────────────────────────────
  priceManagement: {
    list: (
      fy: number,
      priceType: PriceManagementType,
      versionName: string,
      signal?: AbortSignal
    ): Promise<{ priceType: PriceManagementType; versionName: string; rows: PriceManagementRow[] }> => {
      const qs = new URLSearchParams({
        fy: String(fy),
        priceType,
        version: versionName,
      });
      return request(`/api/price-management?${qs.toString()}`, { signal });
    },

    listRange: (
      startMonth: string,
      endMonth: string,
      versionName: string,
      signal?: AbortSignal
    ): Promise<{ priceType: PriceManagementType; versionName: string; rows: PriceManagementRow[] }> => {
      const qs = new URLSearchParams({
        startMonth,
        endMonth,
        priceType: 'Fcst',
        version: versionName,
      });
      return request(`/api/price-management?${qs.toString()}`, { signal });
    },

    saveBulk: (
      priceType: PriceManagementType,
      versionName: string,
      rows: PriceManagementRow[]
    ): Promise<{ ok: boolean; updated: number }> =>
      request('/api/price-management/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ priceType, versionName, rows }),
      }),

    copy: (
      fy: number,
      sourceVersion: string,
      targetVersion: string
    ): Promise<{ ok: boolean; copied: number }> =>
      request('/api/price-management/copy', {
        method: 'POST',
        body: JSON.stringify({ fy, sourceVersion, targetVersion }),
      }),

    remove: (
      month: string,
      priceType: PriceManagementType,
      versionName: string
    ): Promise<{ ok: boolean }> => {
      const qs = new URLSearchParams({ priceType, version: versionName });
      return request(`/api/price-management/${month}?${qs.toString()}`, { method: 'DELETE' });
    },
  },

  versions: {
    list: (): Promise<string[]> => request('/api/versions'),

    create: (name: string): Promise<{ ok: boolean }> =>
      request('/api/versions', {
        method: 'POST',
        body: JSON.stringify({ name }),
      }),
  },

  imports: {
    forecastPreview: async (file: File): Promise<ForecastImportPreview> => {
      const res = await fetch(withAppBase(withModeQuery('/api/import/forecast/preview')), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ...modeHeaders(),
        },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(
          res.status,
          body?.error ?? `Request failed: ${res.status}`,
          body && typeof body === 'object' ? body : {}
        );
      }
      return res.json() as Promise<ForecastImportPreview>;
    },
    forecastConfirm: (
      preview: ForecastImportPreview,
      stampPeriod = 'No'
    ): Promise<ForecastImportResult> => {
      if ('previewId' in preview && preview.previewId) {
        return request('/api/import/forecast/confirm', {
          method: 'POST',
          body: JSON.stringify({
            previewContractVersion: preview.previewContractVersion,
            previewId: preview.previewId,
            stampPeriod,
          }),
        });
      }
      return request('/api/import/forecast/confirm', {
        method: 'POST',
        body: JSON.stringify({
          previewContractVersion: preview.previewContractVersion,
          stampPeriod,
          records: 'importableRecords' in preview ? preview.importableRecords : [],
        }),
      });
    },
    currentForecastPreview: async (file: File): Promise<CurrentForecastImportPreview> => {
      const res = await fetch(withAppBase(withModeQuery('/api/import/current-forecast/preview')), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ...modeHeaders(),
        },
        body: await file.arrayBuffer(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(
          res.status,
          body?.error ?? `Request failed: ${res.status}`,
          body && typeof body === 'object' ? body : {}
        );
      }
      return res.json() as Promise<CurrentForecastImportPreview>;
    },
    currentForecastConfirm: (
      preview: CurrentForecastImportPreview,
      stampPeriod = 'No'
    ): Promise<CurrentForecastImportResult> =>
      request('/api/import/current-forecast/confirm', {
        method: 'POST',
        body: JSON.stringify({
          previewContractVersion: preview.previewContractVersion,
          stampPeriod,
          records: preview.importableRecords,
        }),
      }),
  },

  overplan: {
    getConfig: (): Promise<OverplanConfig> => request('/api/overplan/config'),
    getSummary: (params?: {
      startMonth?: string;
      endMonth?: string;
      view?: 'aggregate' | 'detail';
      granularity?: 'month' | 'week';
    }): Promise<{
      generatedAt: string;
      view: 'aggregate' | 'detail';
      summary: { overCount: number; underCount: number };
    }> => {
      const query = new URLSearchParams();
      if (params?.startMonth) query.set('startMonth', params.startMonth);
      if (params?.endMonth) query.set('endMonth', params.endMonth);
      if (params?.view) query.set('view', params.view);
      if (params?.granularity) query.set('granularity', params.granularity);
      const suffix = query.toString() ? `?${query.toString()}` : '';
      return request(`/api/overplan/summary${suffix}`);
    },
    saveConfig: (config: Partial<OverplanConfig>): Promise<OverplanConfig> =>
      request('/api/overplan/config', {
        method: 'PATCH',
        body: JSON.stringify(config),
      }),
    listRecipients: (): Promise<OverplanRecipient[]> => request('/api/overplan/recipients'),
    saveRecipients: (recipients: OverplanRecipient[]): Promise<OverplanRecipient[]> =>
      request('/api/overplan/recipients', {
        method: 'PUT',
        body: JSON.stringify({ recipients }),
      }),
    evaluate: (payload: OverplanEvaluateRequest): Promise<OverplanEvaluateResponse> =>
      request('/api/overplan/evaluate', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    previewNotify: async (payload: Omit<OverplanEvaluateRequest, 'view' | 'page' | 'pageSize' | 'status'>) => {
      try {
        return await request<{
          ok: boolean;
          previewOnly: true;
          sent: 0;
          batches: EmailBatchPreview[];
          breachedDetailRows: number;
          breachedAggregateRows: number;
        }>('/api/overplan/preview-notify', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404) throw error;
        return request<{
          ok: boolean;
          previewOnly: true;
          sent: 0;
          batches: EmailBatchPreview[];
          breachedDetailRows: number;
          breachedAggregateRows: number;
        }>('/api/overplan/notify', {
          method: 'POST',
          body: JSON.stringify({ ...payload, previewOnly: true }),
        });
      }
    },
    notify: (payload: Omit<OverplanEvaluateRequest, 'view' | 'page' | 'pageSize' | 'status'>): Promise<{
      ok: boolean;
      sent: number;
      skipped: string | null;
      breachedDetailRows: number;
      breachedAggregateRows: number;
    }> =>
      request('/api/overplan/notify', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  notifications: {
    previewForecastChange: (payload?: {
      changedBy?: string;
      useSample?: boolean;
      changes?: Array<{
        ownerName: string;
        materialCode: string;
        materialDescription: string;
        plantCode?: string;
        period: string;
        oldQtyFcst: number | null;
        newQtyFcst: number;
      }>;
    }): Promise<{ ok: boolean; previewOnly: true; sent: 0; batches: EmailBatchPreview[] }> =>
      request('/api/forecast/preview-commit-email', {
        method: 'POST',
        body: JSON.stringify(payload ?? { useSample: true }),
      }),
    sendForecastChange: (payload: {
      changedBy?: string;
      changes: Array<{
        ownerName: string;
        materialCode: string;
        materialDescription: string;
        plantCode?: string;
        period: string;
        oldQtyFcst: number | null;
        newQtyFcst: number;
      }>;
    }): Promise<{ ok: boolean; sent: number; skipped: string | null }> =>
      request('/api/forecast/send-commit-email', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
  },

  forecastEmail: {
    listCcRecipients: (): Promise<ForecastCcRecipient[]> =>
      request('/api/forecast-email/cc-recipients'),
    saveCcRecipients: (recipients: ForecastCcRecipient[]): Promise<ForecastCcRecipient[]> =>
      request('/api/forecast-email/cc-recipients', {
        method: 'PUT',
        body: JSON.stringify({ recipients }),
      }),
    resolveOwners: (ownerNames: string[]): Promise<{ owners: ForecastEmailOwner[] }> =>
      request('/api/forecast-email/resolve-owners', {
        method: 'POST',
        body: JSON.stringify({ ownerNames }),
      }),
  },

  employees: {
    search: (query: string): Promise<{ results: EmployeeContact[] }> =>
      request(`/api/employees/search?q=${encodeURIComponent(query)}`),
    sync: (): Promise<{ ok: boolean; synced: number }> =>
      request('/api/employees/sync', { method: 'POST' }),
  },

  admin: {
    listRoles: (): Promise<{ assignments: AppRoleAssignment[] }> =>
      request('/api/admin/roles'),
    saveRoles: (assignments: Array<{
      empCode: string;
      fullNameEng: string;
      currentEmail: string;
      role: 'admin' | 'super_user';
      source?: string;
    }>): Promise<{ assignments: AppRoleAssignment[] }> =>
      request('/api/admin/roles', {
        method: 'PUT',
        body: JSON.stringify({ assignments }),
      }),
    removeRole: (empCode: string): Promise<{ assignments: AppRoleAssignment[] }> =>
      request(`/api/admin/roles/${encodeURIComponent(empCode)}`, { method: 'DELETE' }),
  },

  customColumns: {
    list: (): Promise<CustomColumnDef[]> =>
      request('/api/custom-columns'),
    create: (payload: {
      name: string;
      type: CustomColumnType;
      dropdownOptions?: string[];
      defaultValue?: string;
    }): Promise<CustomColumnDef> =>
      request('/api/custom-columns', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),
    update: (
      id: string,
      payload: Partial<{
        name: string;
        type: CustomColumnType;
        dropdownOptions: string[];
        defaultValue: string | null;
      }>,
    ): Promise<CustomColumnDef> =>
      request(`/api/custom-columns/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      }),
    remove: (id: string): Promise<{ ok: boolean }> =>
      request(`/api/custom-columns/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    queryValues: (
      registrationIds: string[],
      columnIds?: string[],
    ): Promise<CustomColumnValue[]> =>
      request('/api/custom-columns/values/query', {
        method: 'POST',
        body: JSON.stringify({ registrationIds, columnIds }),
      }),
    upsertValue: (
      columnId: string,
      registrationId: string,
      value: string | null,
    ): Promise<CustomColumnValue> =>
      request(
        `/api/custom-columns/${encodeURIComponent(columnId)}/values/${encodeURIComponent(registrationId)}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ value }),
        },
      ),
  },
};
