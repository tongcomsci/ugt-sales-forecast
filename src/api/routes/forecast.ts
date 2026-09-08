import { Prisma } from '@prisma/client';
import { Router } from 'express';
import {
  assertRegistrationIdsInAppMode,
  buildAppModeRegistrationScopeSql,
  filterRegistrationIdsInAppMode,
  getAppMode,
} from '../../config/appMode';
import prisma from '../../db/prisma';
import {
  actualPeriodExpression,
  actualRegistrationSourceSql,
  actualSalesSourceSql,
  nextMonthStart,
  type ActualGranularity,
} from './actuals';
import {
  getFilteredRegistrationIds,
  getRegistrationSourceSql,
  normalizeRegistrationFilters,
} from './registrations';
import { getActiveSnapshotVersion } from '../services/dataSnapshot';
import {
  CURRENT_FORECAST_VERSION_NAME,
  firstWednesdayPeriod,
  formatForecastPeriodForApi,
  monthKeyToEndOfMonth,
  monthKeyToFirstOfMonth,
  parseForecastPeriodToDate,
  resolveForecastListGranularity,
} from '../../lib/forecastPeriod';
import { queueForecastChangeNotification } from '../services/forecastChangeNotification';
import { sendForecastChangeEmails } from '../services/overplanNotification';
import {
  buildForecastChangeBatches,
  sampleForecastChangePreview,
} from '../services/notificationPreview';
import { pruneCache } from '../services/boundedCache';
import { chunkArray } from '../services/forecastImport/excelUtils';

const router = Router();
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CHANGED_BY = 'User (Admin)';
const DEFAULT_STAMP_PERIOD = 'No';
const ALLOWED_STAMP_PERIODS = new Set([
  DEFAULT_STAMP_PERIOD,
  'Weekly1',
  'Weekly2',
  'Weekly3',
  'Weekly4',
  'Weekly5',
  'Monthly1',
  'Monthly2',
]);
const STANDARD_VERSION_KEYS: Record<string, number> = {
  'Current Forecast': 1,
  'BB FY26': 2,
  'SepF FY26': 3,
  'DecF FY26': 4,
};

interface ForecastSummaryPeriod {
  period: string;
  qtyAct: number;
  qtyFcst: number;
  amountFcst: number;
  carryInETD: number;
  carryOutETD: number;
  carryInLoading: number;
  carryOutLoading: number;
}

interface ForecastSummaryResponse {
  generatedAt: string;
  periods: ForecastSummaryPeriod[];
}

interface NormalizedForecastUpdate {
  registrationId: string;
  versionName: string;
  period: Date;
  periodKey: string;
  granularity: string;
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
}

const MAX_SUMMARY_CACHE_ENTRIES = 64;
// Three query parameters per cell, against SQL Server's 2100-parameter cap.
const EXISTING_LOOKUP_CHUNK_SIZE = 300;
// Far above any real paste, but keeps one request from pinning the server.
const MAX_UPDATES_PER_REQUEST = 20_000;
const summaryCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ForecastSummaryResponse> }
>();

export function clearForecastSummaryCache() {
  summaryCache.clear();
  import('./overplan')
    .then(module => module.clearOverplanEvaluateCache())
    .catch(() => undefined);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function numberMatchesFilter(value: number, selectedValues: string[]) {
  return selectedValues.some(selected => {
    const parsed = Number(selected);
    return Number.isFinite(parsed)
      ? Math.abs(value - parsed) < 0.0001
      : String(value) === selected;
  });
}

function normalizeGranularity(value: unknown): 'month' | 'week' {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === 'month' || trimmed === 'week') return trimmed;
  }
  return 'month';
}

function normalizeForecastUpdates(updates: unknown[]) {
  const normalized = new Map<string, NormalizedForecastUpdate>();
  for (const value of updates) {
    if (!value || typeof value !== 'object') continue;
    const item = value as Record<string, unknown>;
    const registrationId = String(item.registrationId ?? '').trim();
    const versionName = String(item.version ?? item.versionName ?? '').trim();
    const period = String(item.period ?? '').trim();
    if (!registrationId || !versionName || !period) continue;
    const periodKey = period;
    const granularity = normalizeGranularity(item.granularity);
    const qtyFcst = Number(item.qtyFcst ?? 0);
    const priceFcst = Number(item.priceFcst ?? 0);
    const amountFcst = Number(item.amountFcst ?? 0);
    if (!Number.isFinite(qtyFcst) || qtyFcst < 0) continue;
    normalized.set(`${registrationId}|${versionName}|${periodKey}`, {
      registrationId,
      versionName,
      period: parseForecastPeriodToDate(periodKey, granularity),
      periodKey,
      granularity,
      qtyFcst,
      priceFcst: Number.isFinite(priceFcst) ? priceFcst : 0,
      amountFcst: Number.isFinite(amountFcst) && amountFcst >= 0 ? amountFcst : 0,
    });
  }
  return [...normalized.values()];
}

function normalizeStampPeriod(value: unknown) {
  const stampPeriod = String(value ?? DEFAULT_STAMP_PERIOD).trim();
  return ALLOWED_STAMP_PERIODS.has(stampPeriod) ? stampPeriod : DEFAULT_STAMP_PERIOD;
}

function hasForecastChanged(
  oldValue: { qtyFcst: unknown; priceFcst: unknown; amountFcst?: unknown } | undefined,
  update: NormalizedForecastUpdate
) {
  if (!oldValue) return true;
  return (
    Math.abs(Number(oldValue.qtyFcst ?? 0) - update.qtyFcst) > 0.0001 ||
    Math.abs(Number(oldValue.priceFcst ?? 0) - update.priceFcst) > 0.0001 ||
    Math.abs(Number(oldValue.amountFcst ?? 0) - update.amountFcst) > 0.0001
  );
}

function mapAuditRow(row: Prisma.ForecastChangeLogGetPayload<{ include: { batch: true } }>) {
  return {
    id: row.id,
    batchId: row.batchId,
    source: row.batch.source,
    changedBy: row.batch.changedBy,
    batchCreatedAt: row.batch.createdAt,
    registrationId: row.registrationId,
    versionName: row.versionName,
    period: formatForecastPeriodForApi(row.period, row.granularity),
    granularity: row.granularity,
    oldQtyFcst: row.oldQtyFcst === null ? null : Number(row.oldQtyFcst),
    newQtyFcst: Number(row.newQtyFcst),
    oldPriceFcst: row.oldPriceFcst === null ? null : Number(row.oldPriceFcst),
    newPriceFcst: Number(row.newPriceFcst),
    oldAmountFcst: row.oldAmountFcst === null ? null : Number(row.oldAmountFcst),
    newAmountFcst: Number(row.newAmountFcst),
    changedAt: row.changedAt,
  };
}

function buildCellAuditWhere(
  registrationId: string,
  versionName: string,
  period: string
): Prisma.ForecastChangeLogWhereInput {
  if (/^\d{4}-\d{2}$/.test(period)) {
    return {
      registrationId,
      versionName,
      period: {
        gte: monthKeyToFirstOfMonth(period),
        lte: monthKeyToEndOfMonth(period),
      },
    };
  }

  const periodDate = parseForecastPeriodToDate(
    period,
    /^\d{4}-\d{2}-\d{2}$/.test(period) ? 'week' : 'month'
  );
  return { registrationId, versionName, period: periodDate };
}

async function nextForecastVersionKey(transaction: Pick<typeof prisma, '$queryRaw'>) {
  const rows = await transaction.$queryRaw<Array<{ nextKey: unknown }>>`
    SELECT ISNULL(MAX([versionKey]), 0) + 1 AS nextKey
    FROM [dbo].[forecast_versions]
  `;
  return Number(rows[0]?.nextKey ?? 1);
}

async function ensureForecastVersion(
  transaction: Pick<typeof prisma, 'forecastVersion' | '$queryRaw'>,
  name: string,
  isStandard = false
) {
  const standardKey = STANDARD_VERSION_KEYS[name];
  const existing = await transaction.forecastVersion.findUnique({
    where: { name },
    select: { name: true },
  });
  if (existing) {
    if (standardKey !== undefined) {
      await transaction.forecastVersion.update({
        where: { name },
        data: { versionKey: standardKey, isStandard: true },
      });
    }
    return;
  }

  await transaction.forecastVersion.create({
    data: {
      name,
      isStandard: isStandard || standardKey !== undefined,
      versionKey: standardKey ?? await nextForecastVersionKey(transaction),
    },
  });
}

function createEmptySummary(period: string): ForecastSummaryPeriod {
  return {
    period,
    qtyAct: 0,
    qtyFcst: 0,
    amountFcst: 0,
    carryInETD: 0,
    carryOutETD: 0,
    carryInLoading: 0,
    carryOutLoading: 0,
  };
}

async function loadCarryTotalsByRegistration(
  registrationIds: string[],
  startMonth: string,
  endMonth: string,
  snapshotVersion: string | null
) {
  if (registrationIds.length === 0) return new Map<string, {
    carryInETD: number;
    carryOutETD: number;
    carryInLoading: number;
    carryOutLoading: number;
  }>();
  const registrationIdsJson = JSON.stringify(registrationIds);
  const registrationSource = actualRegistrationSourceSql(snapshotVersion);
  const actualSource = actualSalesSourceSql(snapshotVersion);
  const rangeStart = `${startMonth}-01`;
  const rangeEnd = nextMonthStart(endMonth);

  const rows = await prisma.$queryRaw<Array<{
    registrationId: string;
    carryInETD: unknown;
    carryOutETD: unknown;
    carryInLoading: unknown;
    carryOutLoading: unknown;
  }>>`
    WITH requested_ids AS (
      SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
      FROM OPENJSON(${registrationIdsJson})
    ),
    registration_source AS (${registrationSource}),
    actual_source AS (${actualSource}),
    requested_registrations AS (
      SELECT DISTINCT source.registrationId, source.keyForNoCRM
      FROM registration_source source
      INNER JOIN requested_ids requested
        ON requested.registrationId = source.registrationId
    ),
    carry_events AS (
      SELECT
        requested.registrationId,
        eventData.eventDate,
        eventData.carryInETD,
        eventData.carryOutETD,
        eventData.carryInLoading,
        eventData.carryOutLoading
      FROM actual_source actual
      INNER JOIN requested_registrations requested
        ON requested.keyForNoCRM = actual.[Key for no regist]
      CROSS APPLY (VALUES
        (actual.[CarryIn_ETD], CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0, 0, 0),
        (actual.[CarryOut_ETD], 0, CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0, 0),
        (actual.[CarryIn_Loading], 0, 0, CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0),
        (actual.[CarryOut_Loading], 0, 0, 0, CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)))
      ) eventData(eventDate, carryInETD, carryOutETD, carryInLoading, carryOutLoading)
      WHERE eventData.eventDate IS NOT NULL
        AND eventData.eventDate >= ${rangeStart}
        AND eventData.eventDate < ${rangeEnd}
    )
    SELECT
      registrationId,
      SUM(carryInETD) AS carryInETD,
      SUM(carryOutETD) AS carryOutETD,
      SUM(carryInLoading) AS carryInLoading,
      SUM(carryOutLoading) AS carryOutLoading
    FROM carry_events
    GROUP BY registrationId
  `;
  return new Map(rows.map(row => [
    String(row.registrationId),
    {
      carryInETD: Number(row.carryInETD ?? 0),
      carryOutETD: Number(row.carryOutETD ?? 0),
      carryInLoading: Number(row.carryInLoading ?? 0),
      carryOutLoading: Number(row.carryOutLoading ?? 0),
    },
  ]));
}

async function loadActualSummaryRows(
  registrationIds: string[],
  periods: string[],
  startMonth: string,
  endMonth: string,
  granularity: ActualGranularity,
  snapshotVersion: string | null
) {
  if (registrationIds.length === 0) return [];
  const registrationIdsJson = JSON.stringify(registrationIds);
  const periodsJson = JSON.stringify(periods);
  const registrationSource = actualRegistrationSourceSql(snapshotVersion);
  const actualSource = actualSalesSourceSql(snapshotVersion);
  const periodExpression = actualPeriodExpression(granularity);
  const rangeStart = `${startMonth}-01`;
  const rangeEnd = nextMonthStart(endMonth);

  return prisma.$queryRaw<Array<{
    period: string;
    qtyAct: unknown;
    carryInETD: unknown;
    carryOutETD: unknown;
    carryInLoading: unknown;
    carryOutLoading: unknown;
  }>>`
    WITH requested_ids AS (
      SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
      FROM OPENJSON(${registrationIdsJson})
    ),
    requested_periods AS (
      SELECT CAST([value] AS NVARCHAR(15)) AS period
      FROM OPENJSON(${periodsJson})
    ),
    registration_source AS (${registrationSource}),
    actual_source AS (${actualSource}),
    requested_registrations AS (
      SELECT DISTINCT source.registrationId, source.keyForNoCRM
      FROM registration_source source
      INNER JOIN requested_ids requested
        ON requested.registrationId = source.registrationId
    ),
    actual_events AS (
      SELECT
        eventData.eventDate,
        eventData.qtyAct,
        eventData.carryInETD,
        eventData.carryOutETD,
        eventData.carryInLoading,
        eventData.carryOutLoading
      FROM actual_source actual
      INNER JOIN requested_registrations requested
        ON requested.keyForNoCRM = actual.[Key for no regist]
      CROSS APPLY (VALUES
        (
          actual.Deliverydate,
          CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4))
        ),
        (
          actual.[CarryIn_ETD],
          0,
          CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)),
          0,
          0,
          0
        ),
        (
          actual.[CarryOut_ETD],
          0,
          0,
          CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)),
          0,
          0
        ),
        (
          actual.[CarryIn_Loading],
          0,
          0,
          0,
          CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)),
          0
        ),
        (
          actual.[CarryOut_Loading],
          0,
          0,
          0,
          0,
          CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4))
        )
      ) eventData(
        eventDate,
        qtyAct,
        carryInETD,
        carryOutETD,
        carryInLoading,
        carryOutLoading
      )
      WHERE eventData.eventDate IS NOT NULL
        AND eventData.eventDate >= ${rangeStart}
        AND eventData.eventDate < ${rangeEnd}
    ),
    actual_by_period AS (
      SELECT
        ${periodExpression} AS period,
        SUM(qtyAct) AS qtyAct,
        SUM(carryInETD) AS carryInETD,
        SUM(carryOutETD) AS carryOutETD,
        SUM(carryInLoading) AS carryInLoading,
        SUM(carryOutLoading) AS carryOutLoading
      FROM actual_events
      GROUP BY ${periodExpression}
    )
    SELECT actual_by_period.*
    FROM actual_by_period
    INNER JOIN requested_periods
      ON requested_periods.period = actual_by_period.period
  `;
}

async function loadForecastSummaryRows(
  registrationIds: string[],
  periods: string[],
  version: string,
  granularity: ActualGranularity
) {
  if (registrationIds.length === 0) return [];
  const registrationIdsJson = JSON.stringify(registrationIds);
  const periodsJson = JSON.stringify(periods);

  if (granularity === 'month') {
    return prisma.$queryRaw<Array<{ period: string; qtyFcst: unknown; amountFcst: unknown }>>`
      WITH requested_ids AS (
        SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
        FROM OPENJSON(${registrationIdsJson})
      ),
      requested_periods AS (
        SELECT CAST([value] AS NVARCHAR(15)) AS period
        FROM OPENJSON(${periodsJson})
      ),
      dated_by_month AS (
        SELECT
          forecast.registrationId,
          FORMAT(forecast.period, 'yyyy-MM') AS period,
          SUM(forecast.qtyFcst) AS qtyFcst,
          SUM(
            CASE
              WHEN forecast.amountFcst > 0 THEN forecast.amountFcst
              ELSE forecast.qtyFcst * forecast.priceFcst
            END
          ) AS amountFcst
        FROM dbo.forecast_values forecast
        INNER JOIN requested_ids requested
          ON requested.registrationId = forecast.registrationId
        INNER JOIN requested_periods requested_period
          ON requested_period.period = FORMAT(forecast.period, 'yyyy-MM')
        WHERE forecast.versionName = ${version}
          AND forecast.granularity = N'week'
        GROUP BY forecast.registrationId, FORMAT(forecast.period, 'yyyy-MM')
      ),
      monthly_rows AS (
        SELECT
          forecast.registrationId,
          FORMAT(forecast.period, 'yyyy-MM') AS period,
          forecast.qtyFcst,
          CASE
            WHEN forecast.amountFcst > 0 THEN forecast.amountFcst
            ELSE forecast.qtyFcst * forecast.priceFcst
          END AS amountFcst
        FROM dbo.forecast_values forecast
        INNER JOIN requested_ids requested
          ON requested.registrationId = forecast.registrationId
        INNER JOIN requested_periods requested_period
          ON requested_period.period = FORMAT(forecast.period, 'yyyy-MM')
        WHERE forecast.versionName = ${version}
          AND forecast.granularity = N'month'
      )
      SELECT
        requested_periods.period,
        SUM(CASE
          WHEN dated_by_month.qtyFcst IS NOT NULL THEN dated_by_month.qtyFcst
          ELSE ISNULL(monthly_rows.qtyFcst, 0)
        END) AS qtyFcst,
        SUM(CASE
          WHEN dated_by_month.amountFcst IS NOT NULL THEN dated_by_month.amountFcst
          ELSE ISNULL(monthly_rows.amountFcst, 0)
        END) AS amountFcst
      FROM requested_periods
      CROSS JOIN requested_ids
      LEFT JOIN dated_by_month
        ON dated_by_month.registrationId = requested_ids.registrationId
       AND dated_by_month.period = requested_periods.period
      LEFT JOIN monthly_rows
        ON monthly_rows.registrationId = requested_ids.registrationId
       AND monthly_rows.period = requested_periods.period
      GROUP BY requested_periods.period
    `;
  }

  return prisma.$queryRaw<Array<{ period: string; qtyFcst: unknown }>>`
    WITH requested_ids AS (
      SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
      FROM OPENJSON(${registrationIdsJson})
    ),
    requested_periods AS (
      SELECT
        CAST([value] AS NVARCHAR(15)) AS period,
        LEFT(CAST([value] AS NVARCHAR(15)), 7) AS monthPeriod,
        CONVERT(CHAR(10), DATEADD(
          DAY,
          (7 - (DATEDIFF(DAY, '19000103', CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), '-01') AS DATE)) % 7)) % 7,
          CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), '-01') AS DATE)
        ), 126) AS firstWednesday
      FROM OPENJSON(${periodsJson})
    ),
    requested_months AS (
      SELECT DISTINCT monthPeriod
      FROM requested_periods
    ),
    exact_week_rows AS (
      SELECT forecast.registrationId, CONVERT(CHAR(10), forecast.period, 23) AS period, forecast.qtyFcst
      FROM dbo.forecast_values forecast
      INNER JOIN requested_ids requested
        ON requested.registrationId = forecast.registrationId
      INNER JOIN requested_periods requested_period
        ON requested_period.period = CONVERT(CHAR(10), forecast.period, 23)
      WHERE forecast.versionName = ${version}
        AND forecast.granularity = N'week'
    ),
    monthly_rows AS (
      SELECT forecast.registrationId, FORMAT(forecast.period, 'yyyy-MM') AS period, forecast.qtyFcst
      FROM dbo.forecast_values forecast
      INNER JOIN requested_ids requested
        ON requested.registrationId = forecast.registrationId
      INNER JOIN requested_months requested_month
        ON requested_month.monthPeriod = FORMAT(forecast.period, 'yyyy-MM')
      WHERE forecast.versionName = ${version}
        AND forecast.granularity = N'month'
    )
    SELECT
      requested_periods.period,
      SUM(CASE
        WHEN exact_week_rows.qtyFcst IS NOT NULL THEN exact_week_rows.qtyFcst
        WHEN requested_periods.period = requested_periods.firstWednesday THEN ISNULL(monthly_rows.qtyFcst, 0)
        ELSE 0
      END) AS qtyFcst
    FROM requested_periods
    CROSS JOIN requested_ids
    LEFT JOIN exact_week_rows
      ON exact_week_rows.registrationId = requested_ids.registrationId
     AND exact_week_rows.period = requested_periods.period
    LEFT JOIN monthly_rows
      ON monthly_rows.registrationId = requested_ids.registrationId
     AND monthly_rows.period = requested_periods.monthPeriod
    GROUP BY requested_periods.period
  `;
}

async function buildForecastSummary(
  body: Record<string, unknown>,
  snapshotVersion: string | null
): Promise<ForecastSummaryResponse> {
  const startMonth = String(body.startMonth ?? '');
  const endMonth = String(body.endMonth ?? '');
  const version = String(body.version ?? 'Current Forecast');
  const granularity: ActualGranularity = body.granularity === 'week' ? 'week' : 'month';
  const periods = Array.isArray(body.periods)
    ? [...new Set(body.periods.map(String).filter(Boolean))]
    : [];
  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth) || periods.length === 0) {
    throw new Error('Invalid summary date range or periods');
  }

  const filters = normalizeRegistrationFilters(body.filters);
  const formulaFilter = Array.isArray(body.formulaFilter)
    ? body.formulaFilter.map(String).filter(Boolean)
    : [];
  const formulaOverrides = body.formulaOverrides && typeof body.formulaOverrides === 'object'
    ? body.formulaOverrides as Record<string, string>
    : {};
  const carryFilters = body.carryFilters && typeof body.carryFilters === 'object'
    ? body.carryFilters as Record<string, unknown>
    : {};
  let registrationIds = await getFilteredRegistrationIds(filters);
  if (formulaFilter.length > 0) {
    registrationIds = registrationIds.filter(registrationId =>
      formulaFilter.includes(formulaOverrides[registrationId] ?? 'CPL')
    );
  }

  const carryFilterEntries = Object.entries(carryFilters)
    .filter(([, values]) => Array.isArray(values) && values.length > 0)
    .map(([key, values]) => [key, (values as unknown[]).map(String)] as const);
  if (carryFilterEntries.length > 0) {
    const carryTotalsByRegistration = await loadCarryTotalsByRegistration(
      registrationIds,
      startMonth,
      endMonth,
      snapshotVersion
    );
    registrationIds = registrationIds.filter(registrationId => {
      const totals = carryTotalsByRegistration.get(registrationId) ?? {
        carryInETD: 0,
        carryOutETD: 0,
        carryInLoading: 0,
        carryOutLoading: 0,
      };
      return carryFilterEntries.every(([key, values]) =>
        key in totals &&
        numberMatchesFilter(totals[key as keyof typeof totals], values)
      );
    });
  }

  const scopedRegistrationIds = Array.isArray(body.registrationIds)
    ? [...new Set(body.registrationIds.map(String).filter(Boolean))]
    : [];
  if (scopedRegistrationIds.length > 0) {
    const scopedSet = new Set(scopedRegistrationIds);
    registrationIds = registrationIds.filter(id => scopedSet.has(id));
  }

  const summaryByPeriod = new Map(
    periods.map(period => [period, createEmptySummary(period)])
  );

  const [actualRows, forecastRows] = await Promise.all([
    loadActualSummaryRows(registrationIds, periods, startMonth, endMonth, granularity, snapshotVersion),
    loadForecastSummaryRows(registrationIds, periods, version, granularity),
  ]);

  actualRows.forEach(row => {
    const summary = summaryByPeriod.get(String(row.period));
    if (!summary) return;
    summary.qtyAct = Number(row.qtyAct ?? 0);
    summary.carryInETD = Number(row.carryInETD ?? 0);
    summary.carryOutETD = Number(row.carryOutETD ?? 0);
    summary.carryInLoading = Number(row.carryInLoading ?? 0);
    summary.carryOutLoading = Number(row.carryOutLoading ?? 0);
  });

  forecastRows.forEach(row => {
    const summary = summaryByPeriod.get(String(row.period));
    if (!summary) return;
    summary.qtyFcst = Number(row.qtyFcst ?? 0);
    summary.amountFcst = Number((row as { amountFcst?: unknown }).amountFcst ?? 0);
  });

  return {
    generatedAt: new Date().toISOString(),
    periods: periods.map(period => summaryByPeriod.get(period)!),
  };
}

router.post('/summary', async (req, res) => {
  const snapshotVersion = await getActiveSnapshotVersion();
  const cacheKey = `${getAppMode()}|${snapshotVersion ?? 'legacy'}|${stableJson(req.body)}`;
  const cached = summaryCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    try {
      return res.json(await cached.promise);
    } catch {
      summaryCache.delete(cacheKey);
    }
  }

  const promise = buildForecastSummary(req.body as Record<string, unknown>, snapshotVersion).catch(error => {
    summaryCache.delete(cacheKey);
    throw error;
  });
  summaryCache.set(cacheKey, {
    expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS,
    promise,
  });
  pruneCache(summaryCache, MAX_SUMMARY_CACHE_ENTRIES);

  try {
    res.json(await promise);
  } catch (error) {
    console.error('[forecast] POST summary error:', error);
    res.status(500).json({ error: 'Failed to calculate forecast summary' });
  }
});

router.get('/fact-forecast', async (req, res) => {
  const {
    version,
    startPeriod,
    endPeriod,
    registrationId,
    limit = '5000',
  } = req.query as Record<string, string>;
  const take = Math.min(Math.max(Number(limit) || 5000, 1), 50000);

  try {
    const rows = await prisma.$queryRaw<Array<{
      fcstRevKey: string;
      revision: string;
      forecastVersion: string;
      versionKey: number;
      registrationKey: string;
      fcstPeriod: string;
      newQty: unknown;
      price: unknown;
      amount: unknown;
      stampPeriod: string;
    }>>`
      SELECT TOP (${take})
        [Fcst Rev Key] AS fcstRevKey,
        [Revision] AS revision,
        [Forecast Version] AS forecastVersion,
        [Version Key] AS versionKey,
        [Registration Key] AS registrationKey,
        [Fcst Period] AS fcstPeriod,
        [NewQty] AS newQty,
        [Price] AS price,
        [Amount] AS amount,
        [Stamp Period] AS stampPeriod
      FROM [dbo].[FactForecast]
      WHERE (${version ?? null} IS NULL OR [Forecast Version] = ${version ?? null})
        AND (${registrationId ?? null} IS NULL OR [Registration Key] = ${registrationId ?? null})
        AND (${startPeriod ?? null} IS NULL OR [Fcst Period] >= TRY_CONVERT(DATE, CONCAT(${startPeriod ?? null}, N'-01'), 126))
        AND (${endPeriod ?? null} IS NULL OR [Fcst Period] <= EOMONTH(TRY_CONVERT(DATE, CONCAT(${endPeriod ?? null}, N'-01'), 126)))
      ORDER BY [Version Key], [Registration Key], [Fcst Period]
    `;
    res.json(rows.map(row => ({
      fcstRevKey: row.fcstRevKey,
      revision: row.revision,
      forecastVersion: row.forecastVersion,
      versionKey: Number(row.versionKey),
      registrationKey: row.registrationKey,
      fcstPeriod: row.fcstPeriod,
      newQty: Number(row.newQty ?? 0),
      price: Number(row.price ?? 0),
      amount: Number(row.amount ?? 0),
      stampPeriod: row.stampPeriod ?? 'No',
    })));
  } catch (error) {
    console.error('[forecast] GET fact forecast error:', error);
    res.status(500).json({ error: 'Failed to fetch FactForecast data' });
  }
});

router.get('/audit/cell', async (req, res) => {
  const { registrationId, version, period } = req.query as Record<string, string>;
  if (!registrationId || !version || !period) {
    return res.status(400).json({ error: 'registrationId, version and period are required' });
  }

  try {
    const where = buildCellAuditWhere(registrationId, version, period);
    const [totalChanges, latestRows] = await Promise.all([
      prisma.forecastChangeLog.count({ where }),
      prisma.forecastChangeLog.findMany({
        where,
        include: { batch: true },
        orderBy: [{ changedAt: 'desc' }],
        take: 3,
      }),
    ]);
    res.json({
      totalChanges,
      latestChanges: latestRows.map(mapAuditRow),
    });
  } catch (error) {
    console.error('[forecast] GET audit cell error:', error);
    res.status(500).json({ error: 'Failed to fetch forecast cell audit history' });
  }
});

router.get('/audit', async (req, res) => {
  const { registrationId, version, start, end } = req.query as Record<string, string>;
  try {
    const rows = await prisma.forecastChangeLog.findMany({
      where: {
        ...(registrationId ? { registrationId } : {}),
        ...(version ? { versionName: version } : {}),
        ...(start || end ? {
          period: {
            ...(start ? { gte: monthKeyToFirstOfMonth(start) } : {}),
            ...(end ? { lte: monthKeyToEndOfMonth(end) } : {}),
          },
        } : {}),
      },
      include: { batch: true },
      orderBy: [{ changedAt: 'desc' }],
      take: 500,
    });
    res.json(rows.map(mapAuditRow));
  } catch (error) {
    console.error('[forecast] GET audit error:', error);
    res.status(500).json({ error: 'Failed to fetch forecast audit history' });
  }
});

type ForecastListQueryParams = {
  version?: string;
  startPeriod?: string;
  endPeriod?: string;
  granularity?: string;
  registrationIds?: string[];
};

type ForecastQueryRow = {
  registrationId: string;
  period: string;
  granularity: string;
  version: string;
  qtyFcst: number;
  priceFcst: number;
  amountFcst: number;
};

function mapForecastQueryRow(
  row: {
    registrationId: string;
    versionName: string;
    period: Date;
    granularity: string;
    qtyFcst: unknown;
    priceFcst: unknown;
    amountFcst: unknown;
  },
  displayGranularity: string,
  periodOverride?: string,
): ForecastQueryRow {
  return {
    registrationId: row.registrationId,
    period: periodOverride ?? formatForecastPeriodForApi(row.period, displayGranularity),
    granularity: displayGranularity,
    version: row.versionName,
    qtyFcst: Number(row.qtyFcst),
    priceFcst: Number(row.priceFcst),
    amountFcst: Number(row.amountFcst),
  };
}

async function queryForecastValues(params: ForecastListQueryParams): Promise<ForecastQueryRow[]> {
  const { version, startPeriod, endPeriod, granularity } = params;
  const registrationIds = params.registrationIds ?? [];
  const requestedGranularity = granularity === 'week' ? 'week' : granularity === 'month' ? 'month' : undefined;
  const effectiveGranularity = version
    ? resolveForecastListGranularity(
        version,
        requestedGranularity === 'week' ? 'week' : 'month',
      )
    : requestedGranularity;

  const periodFilter = startPeriod || endPeriod
    ? {
        period: {
          ...(startPeriod ? { gte: monthKeyToFirstOfMonth(startPeriod) } : {}),
          ...(endPeriod ? { lte: monthKeyToEndOfMonth(endPeriod) } : {}),
        },
      }
    : {};

  const baseWhere = {
    ...(registrationIds.length > 0 ? { registrationId: { in: registrationIds } } : {}),
    ...(version ? { versionName: version } : {}),
    ...periodFilter,
  };

  const keyed = new Map<string, ForecastQueryRow>();

  if (effectiveGranularity === 'week') {
    const weekRows = await prisma.forecastValue.findMany({
      where: { ...baseWhere, granularity: 'week' },
      orderBy: [{ registrationId: 'asc' }, { period: 'asc' }],
    });
    for (const row of weekRows) {
      const item = mapForecastQueryRow(row, 'week');
      keyed.set(`${item.registrationId}|${item.version}|${item.period}`, item);
    }

    // Current Forecast may hold month rows (e.g. after copy from SepF). Grid expects
    // first-Wednesday week keys — mirror summary SQL fallback so cells are not blank.
    if (version === CURRENT_FORECAST_VERSION_NAME) {
      const monthRows = await prisma.forecastValue.findMany({
        where: { ...baseWhere, granularity: 'month' },
        orderBy: [{ registrationId: 'asc' }, { period: 'asc' }],
      });
      for (const row of monthRows) {
        const monthPeriod = formatForecastPeriodForApi(row.period, 'month');
        const weekPeriod = firstWednesdayPeriod(monthPeriod);
        const key = `${row.registrationId}|${row.versionName}|${weekPeriod}`;
        if (keyed.has(key)) continue;
        keyed.set(key, mapForecastQueryRow(row, 'week', weekPeriod));
      }
    }
  } else {
    const monthRows = await prisma.forecastValue.findMany({
      where: { ...baseWhere, granularity: 'month' },
      orderBy: [{ registrationId: 'asc' }, { period: 'asc' }],
    });
    for (const row of monthRows) {
      const item = mapForecastQueryRow(row, 'month');
      keyed.set(`${item.registrationId}|${item.version}|${item.period}`, item);
    }
  }

  return [...keyed.values()].sort((left, right) =>
    left.registrationId.localeCompare(right.registrationId)
    || left.period.localeCompare(right.period)
  );
}

/**
 * GET /api/forecast?version=&startPeriod=&endPeriod=&granularity=
 * Returns ForecastValue rows for given filters.
 * period field is "YYYY-MM" (month) or "YYYY-MM-DD" (week) in API responses.
 * Prefer POST /query when filtering by many registrationIds (avoids HTTP 431).
 */
router.get('/', async (req, res) => {
  const { version, startPeriod, endPeriod, granularity } = req.query as Record<string, string>;
  const registrationIds = Array.isArray(req.query.registrationId)
    ? req.query.registrationId.map(String)
    : req.query.registrationId
      ? [String(req.query.registrationId)]
      : [];
  try {
    res.json(await queryForecastValues({
      version,
      startPeriod,
      endPeriod,
      granularity,
      registrationIds,
    }));
  } catch (error) {
    console.error('[forecast] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch forecast data' });
  }
});

/**
 * POST /api/forecast/query
 * Body: { version, startPeriod, endPeriod, granularity, registrationIds }
 * Same as GET but registrationIds in JSON body — avoids URL/header size limits (HTTP 431).
 */
router.post('/query', async (req, res) => {
  const {
    version,
    startPeriod,
    endPeriod,
    granularity,
    registrationIds: rawRegistrationIds,
  } = req.body as {
    version?: string;
    startPeriod?: string;
    endPeriod?: string;
    granularity?: string;
    registrationIds?: unknown;
  };
  const requestedIds = Array.isArray(rawRegistrationIds)
    ? [...new Set(rawRegistrationIds.map(String).filter(Boolean))].slice(0, 5000)
    : [];

  if (requestedIds.length === 0) {
    return res.json([]);
  }

  try {
    const registrationIds = await filterRegistrationIdsInAppMode(requestedIds);
    if (registrationIds.length === 0) return res.json([]);
    res.json(await queryForecastValues({
      version,
      startPeriod,
      endPeriod,
      granularity,
      registrationIds,
    }));
  } catch (error) {
    console.error('[forecast] POST query error:', error);
    res.status(500).json({ error: 'Failed to fetch forecast data' });
  }
});

/**
 * PATCH /api/forecast
 * Body: Array<{ registrationId, version, period, granularity, qtyFcst, priceFcst, amountFcst }>
 * Upserts all rows in a single transaction.
 */
router.patch('/', async (req, res) => {
  const updates = Array.isArray(req.body) ? req.body : req.body?.values;
  const sessionUser = (req as typeof req & { user?: { name?: string; email?: string } }).user;
  const changedBy = String(
    sessionUser?.name ??
    sessionUser?.email ??
    req.body?.changedBy ??
    req.header('x-changed-by') ??
    DEFAULT_CHANGED_BY
  ).trim() || DEFAULT_CHANGED_BY;
  const stampPeriod = normalizeStampPeriod(req.body?.stampPeriod);
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'Body must be a non-empty array of forecast values' });
  }
  for (const value of updates) {
    if (!value || typeof value !== 'object') continue;
    const qtyFcst = Number((value as Record<string, unknown>).qtyFcst);
    if (Number.isFinite(qtyFcst) && qtyFcst < 0) {
      return res.status(400).json({ error: 'Forecast quantity cannot be negative.' });
    }
    const amountFcst = Number((value as Record<string, unknown>).amountFcst);
    if (Number.isFinite(amountFcst) && amountFcst < 0) {
      return res.status(400).json({ error: 'Forecast amount cannot be negative.' });
    }
  }
  if (updates.length > MAX_UPDATES_PER_REQUEST) {
    return res.status(413).json({
      error: `Too many forecast values in one request (${updates.length}). ` +
        `Save at most ${MAX_UPDATES_PER_REQUEST} at a time.`,
    });
  }
  const normalizedUpdates = normalizeForecastUpdates(updates);
  if (normalizedUpdates.length === 0) {
    return res.status(400).json({ error: 'No valid forecast values were supplied' });
  }

  try {
    await assertRegistrationIdsInAppMode(
      normalizedUpdates.map(update => update.registrationId)
    );
    const result = await prisma.$transaction(async transaction => {
      for (const versionName of [...new Set(normalizedUpdates.map(update => update.versionName))]) {
        await ensureForecastVersion(
          transaction,
          versionName,
          STANDARD_VERSION_KEYS[versionName] !== undefined
        );
      }
      // One OR clause per cell costs three query parameters, and SQL Server
      // caps a statement at 2100, so a large grid save has to be chunked.
      const existingRows: Array<{
        registrationId: string;
        versionName: string;
        period: Date;
        granularity: string;
        qtyFcst: Prisma.Decimal;
        priceFcst: Prisma.Decimal;
        amountFcst: Prisma.Decimal;
      }> = [];
      for (const chunk of chunkArray(normalizedUpdates, EXISTING_LOOKUP_CHUNK_SIZE)) {
        const chunkRows = await transaction.forecastValue.findMany({
          where: {
            OR: chunk.map(update => ({
              registrationId: update.registrationId,
              versionName: update.versionName,
              period: update.period,
            })),
          },
          select: {
            registrationId: true,
            versionName: true,
            period: true,
            granularity: true,
            qtyFcst: true,
            priceFcst: true,
            amountFcst: true,
          },
        });
        existingRows.push(...chunkRows);
      }
      const existingMap = new Map(
        existingRows.map(row => [
          `${row.registrationId}|${row.versionName}|${formatForecastPeriodForApi(row.period, row.granularity)}`,
          row,
        ])
      );
      const changedUpdates = normalizedUpdates.filter(update =>
        hasForecastChanged(
          existingMap.get(`${update.registrationId}|${update.versionName}|${update.periodKey}`),
          update
        )
      );
      const changedKeys = new Set(
        changedUpdates.map(update => `${update.registrationId}|${update.versionName}|${update.periodKey}`)
      );
      const batch = await transaction.forecastCommitBatch.create({
        data: {
          source: 'manual_commit',
          changedBy,
          stampPeriod,
          recordCount: changedUpdates.length,
        },
      });

      // Bulk upsert via a single MERGE instead of one round-trip per row. Only
      // rows whose values changed pick up the new batch id (matching the previous
      // per-row behaviour); unchanged rows keep their existing lastBatchId.
      const mergePayload = normalizedUpdates.map(update => ({
        registrationId: update.registrationId,
        versionName: update.versionName,
        period: update.period.toISOString().slice(0, 10),
        granularity: update.granularity,
        qtyFcst: update.qtyFcst,
        priceFcst: update.priceFcst,
        amountFcst: update.amountFcst,
        changed: changedKeys.has(
          `${update.registrationId}|${update.versionName}|${update.periodKey}`
        ) ? 1 : 0,
      }));
      const mergeJson = JSON.stringify(mergePayload);
      await transaction.$executeRaw`
        MERGE [dbo].[forecast_values] WITH (HOLDLOCK) AS target
        USING (
          SELECT
            [registrationId], [versionName], [period], [granularity],
            [qtyFcst], [priceFcst], [amountFcst], [changed]
          FROM OPENJSON(${mergeJson})
          WITH (
            [registrationId] NVARCHAR(200) N'$.registrationId',
            [versionName]    NVARCHAR(100) N'$.versionName',
            [period]         DATE          N'$.period',
            [granularity]    NVARCHAR(10)  N'$.granularity',
            [qtyFcst]        DECIMAL(18,4) N'$.qtyFcst',
            [priceFcst]      DECIMAL(18,4) N'$.priceFcst',
            [amountFcst]     DECIMAL(18,4) N'$.amountFcst',
            [changed]        BIT           N'$.changed'
          )
        ) AS source
        ON target.[registrationId] = source.[registrationId]
          AND target.[versionName] = source.[versionName]
          AND target.[period] = source.[period]
          AND target.[granularity] = source.[granularity]
        WHEN MATCHED THEN
          UPDATE SET
            target.[qtyFcst] = source.[qtyFcst],
            target.[priceFcst] = source.[priceFcst],
            target.[amountFcst] = source.[amountFcst],
            target.[lastBatchId] = CASE WHEN source.[changed] = 1 THEN ${batch.id} ELSE target.[lastBatchId] END,
            target.[updatedAt] = SYSUTCDATETIME()
        WHEN NOT MATCHED THEN
          INSERT ([registrationId], [versionName], [period], [granularity], [qtyFcst], [priceFcst], [amountFcst], [lastBatchId], [updatedAt])
          VALUES (source.[registrationId], source.[versionName], source.[period], source.[granularity], source.[qtyFcst], source.[priceFcst], source.[amountFcst], ${batch.id}, SYSUTCDATETIME());
      `;

      if (changedUpdates.length > 0) {
        await transaction.forecastChangeLog.createMany({
          data: changedUpdates.map(update => {
            const oldValue = existingMap.get(`${update.registrationId}|${update.versionName}|${update.periodKey}`);
            return {
              batchId: batch.id,
              registrationId: update.registrationId,
              versionName: update.versionName,
              period: update.period,
              granularity: update.granularity,
              oldQtyFcst: oldValue?.qtyFcst ?? null,
              newQtyFcst: update.qtyFcst,
              oldPriceFcst: oldValue?.priceFcst ?? null,
              newPriceFcst: update.priceFcst,
              oldAmountFcst: oldValue?.amountFcst ?? null,
              newAmountFcst: update.amountFcst,
            };
          }),
        });
      }
      return {
        batchId: batch.id,
        changed: changedUpdates.length,
        notificationChanges: changedUpdates.map(update => {
          const oldValue = existingMap.get(`${update.registrationId}|${update.versionName}|${update.periodKey}`);
          return {
            registrationId: update.registrationId,
            periodKey: update.periodKey,
            oldQtyFcst: oldValue ? Number(oldValue.qtyFcst) : null,
            newQtyFcst: update.qtyFcst,
          };
        }),
      };
    }, { timeout: 120_000 });
    clearForecastSummaryCache();

    if (result.notificationChanges.length > 0) {
      queueForecastChangeNotification({
        changedBy,
        commitBatchId: result.batchId,
        changes: result.notificationChanges,
      });
    }

    res.json({
      ok: true,
      updated: normalizedUpdates.length,
      batchId: result.batchId,
      changed: result.changed,
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String((error as { code?: string }).code)
      : undefined;
    if (code === 'REGISTRATION_OUT_OF_MODE') {
      return res.status(403).json({
        error: error instanceof Error ? error.message : 'Registration outside selected mode',
        code,
      });
    }
    console.error('[forecast] PATCH error:', error);
    res.status(500).json({ error: 'Failed to save forecast data' });
  }
});

router.post('/preview-commit-email', async (req, res) => {
  try {
    const body = req.body as {
      changedBy?: string;
      changes?: Array<{
        ownerName: string;
        materialCode: string;
        materialDescription: string;
        plantCode?: string;
        period: string;
        oldQtyFcst: number | null;
        newQtyFcst: number;
      }>;
      useSample?: boolean;
    };

    const payload = body.useSample === false && body.changes && body.changes.length > 0
      ? {
          changedBy: String(body.changedBy ?? DEFAULT_CHANGED_BY),
          changes: body.changes,
        }
      : sampleForecastChangePreview();

    const batches = await buildForecastChangeBatches(payload);
    res.json({
      ok: true,
      previewOnly: true,
      sent: 0,
      batches,
    });
  } catch (error) {
    console.error('[forecast] preview-commit-email error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to preview forecast change notification',
    });
  }
});

router.post('/send-commit-email', async (req, res) => {
  try {
    const body = req.body as {
      changedBy?: string;
      changes?: Array<{
        ownerName: string;
        materialCode: string;
        materialDescription: string;
        plantCode?: string;
        period: string;
        oldQtyFcst: number | null;
        newQtyFcst: number;
      }>;
    };

    if (!body.changes || body.changes.length === 0) {
      res.status(400).json({ error: 'No forecast changes to send' });
      return;
    }

    const result = await sendForecastChangeEmails({
      changedBy: String(body.changedBy ?? DEFAULT_CHANGED_BY),
      changes: body.changes,
    });

    res.json({
      ok: true,
      sent: result.sent,
      skipped: result.skipped,
    });
  } catch (error) {
    console.error('[forecast] send-commit-email error:', error);
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Failed to send forecast change notification',
    });
  }
});

/**
 * POST /api/forecast/copy-version
 * Body: { sourceVersion, targetVersion }
 * Replaces all forecast values in target with a full copy of source.
 */
router.post('/copy-version', async (req, res) => {
  const sourceVersion = typeof req.body?.sourceVersion === 'string'
    ? req.body.sourceVersion.trim()
    : '';
  const targetVersion = typeof req.body?.targetVersion === 'string'
    ? req.body.targetVersion.trim()
    : '';

  if (!sourceVersion || !targetVersion) {
    return res.status(400).json({ error: 'sourceVersion and targetVersion are required' });
  }
  if (sourceVersion === targetVersion) {
    return res.status(400).json({ error: 'sourceVersion and targetVersion must be different' });
  }

  const [sourceExists, targetExists] = await Promise.all([
    prisma.forecastVersion.findUnique({ where: { name: sourceVersion }, select: { name: true } }),
    prisma.forecastVersion.findUnique({ where: { name: targetVersion }, select: { name: true } }),
  ]);
  if (!sourceExists || !targetExists) {
    return res.status(400).json({ error: 'Unknown forecast version' });
  }

  try {
    const registrationSourceSql = await getRegistrationSourceSql();
    const modeScopeSql = buildAppModeRegistrationScopeSql('r');
    const modeRegistrationCte = Prisma.sql`
      WITH registration_source AS (${registrationSourceSql}),
      mode_registrations AS (
        SELECT DISTINCT LTRIM(RTRIM(CONVERT(NVARCHAR(200), r.RegistrationId))) AS registrationId
        FROM registration_source r
        WHERE r.RegistrationId IS NOT NULL
          ${modeScopeSql}
      )
    `;

    const copied = await prisma.$transaction(async transaction => {
      const sourceCountRows = await transaction.$queryRaw<Array<{ cnt: number }>>`
        ${modeRegistrationCte}
        SELECT COUNT_BIG(1) AS cnt
        FROM [dbo].[forecast_values] fv
        INNER JOIN mode_registrations mr ON mr.registrationId = fv.[registrationId]
        WHERE fv.[versionName] = ${sourceVersion}
      `;
      const sourceCount = Number(sourceCountRows[0]?.cnt ?? 0);

      const batch = await transaction.forecastCommitBatch.create({
        data: {
          source: 'version_copy',
          changedBy: DEFAULT_CHANGED_BY,
          stampPeriod: DEFAULT_STAMP_PERIOD,
          recordCount: sourceCount,
        },
      });

      // Replace only rows belonging to the selected app mode.
      await transaction.$executeRaw`
        ${modeRegistrationCte}
        DELETE fv
        FROM [dbo].[forecast_values] fv
        INNER JOIN mode_registrations mr ON mr.registrationId = fv.[registrationId]
        WHERE fv.[versionName] = ${targetVersion}
      `;

      // Current Forecast grid reads week rows (first-Wednesday keys). When copying
      // from month-based versions (e.g. SepF), store as week so cells populate.
      await transaction.$executeRaw`
        ${modeRegistrationCte}
        INSERT INTO [dbo].[forecast_values] (
          [registrationId], [versionName], [period], [granularity],
          [qtyFcst], [priceFcst], [amountFcst], [lastBatchId], [updatedAt]
        )
        SELECT
          fv.[registrationId],
          ${targetVersion},
          CASE
            WHEN ${targetVersion} = N'Current Forecast' AND fv.[granularity] = N'month' THEN
              DATEADD(
                DAY,
                (7 - (DATEDIFF(DAY, '19000103', CAST(DATEFROMPARTS(YEAR(fv.[period]), MONTH(fv.[period]), 1) AS DATE)) % 7)) % 7,
                CAST(DATEFROMPARTS(YEAR(fv.[period]), MONTH(fv.[period]), 1) AS DATE)
              )
            ELSE fv.[period]
          END,
          CASE
            WHEN ${targetVersion} = N'Current Forecast' AND fv.[granularity] = N'month' THEN N'week'
            ELSE fv.[granularity]
          END,
          fv.[qtyFcst],
          fv.[priceFcst],
          fv.[amountFcst],
          ${batch.id},
          SYSUTCDATETIME()
        FROM [dbo].[forecast_values] fv
        INNER JOIN mode_registrations mr ON mr.registrationId = fv.[registrationId]
        WHERE fv.[versionName] = ${sourceVersion}
      `;

      return sourceCount;
    }, {
      // Large versions (e.g. sepF → Current Forecast) routinely exceed the 5s default.
      maxWait: 20_000,
      timeout: 300_000,
    });

    clearForecastSummaryCache();
    res.json({ ok: true, copied, sourceVersion, targetVersion });
  } catch (error) {
    console.error('[forecast] copy-version error:', error);
    const message = error instanceof Error ? error.message : 'Failed to copy forecast version';
    res.status(500).json({
      error: message.includes('timeout') || message.includes('Transaction already closed')
        ? 'Copy timed out — try again (large versions can take a few minutes)'
        : 'Failed to copy forecast version',
    });
  }
});

export default router;
