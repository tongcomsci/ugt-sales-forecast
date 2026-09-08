import { Prisma } from '@prisma/client';
import prisma from '../../db/prisma';
import {
  actualPeriodExpression,
  actualRegistrationSourceSql,
  actualSalesSourceSql,
  nextMonthStart,
  type ActualGranularity,
} from '../routes/actuals';
import {
  buildRegistrationFilterSql,
  getRegistrationSourceSql,
  type RegistrationFilters,
} from '../routes/registrations';
import { getActiveSnapshotVersion } from './dataSnapshot';
import { OVERPLAN_ACTUAL_SOURCE } from './overplanCompare';
import { pruneCache } from './boundedCache';

const DETAIL_QTY_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_DETAIL_QTY_CACHE_ENTRIES = 24;
const META_ID_CHUNK_SIZE = 1500;

export type OverplanRegistrationMeta = {
  registrationId: string;
  materialCode: string;
  materialDescription: string;
  plantCode: string;
  ownerName: string;
};

export type OverplanDetailQtyRow = OverplanRegistrationMeta & {
  period: string;
  leftQty: number;
  rightQty: number;
};

type DetailQtyCacheEntry = {
  expiresAt: number;
  promise: Promise<OverplanDetailQtyRow[]>;
};

const detailQtyCache = new Map<string, DetailQtyCacheEntry>();

export function clearOverplanDetailQtyCache(): void {
  detailQtyCache.clear();
}

function monthPeriodsBetween(startMonth: string, endMonth: string) {
  const [startYear, startMonthNumber] = startMonth.split('-').map(Number);
  const [endYear, endMonthNumber] = endMonth.split('-').map(Number);
  const periods: string[] = [];
  let year = startYear;
  let month = startMonthNumber;
  while (year < endYear || (year === endYear && month <= endMonthNumber)) {
    periods.push(`${year}-${String(month).padStart(2, '0')}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return periods;
}

export function resolveOverplanPeriods(startMonth: string, endMonth: string) {
  return monthPeriodsBetween(startMonth, endMonth);
}

function chunkArray<T>(values: T[], size: number): T[][] {
  if (values.length === 0) return [];
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function stableFiltersKey(filters: RegistrationFilters): string {
  const entries = Object.entries(filters)
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, values]) => `${key}:${[...values].sort().join('|')}`);
  return entries.join(';');
}

function detailQtyCacheKey(input: {
  startMonth: string;
  endMonth: string;
  granularity: ActualGranularity;
  compareLeft: string;
  compareRight: string;
  filters: RegistrationFilters;
  dataStamp: string;
}): string {
  return [
    input.compareLeft,
    input.compareRight,
    input.startMonth,
    input.endMonth,
    input.granularity,
    stableFiltersKey(input.filters),
    input.dataStamp,
  ].join('\u0001');
}

async function loadForecastDataStamp(compareLeft: string, compareRight: string): Promise<string> {
  const versions = [compareLeft, compareRight].filter(name => name && name !== OVERPLAN_ACTUAL_SOURCE);
  if (versions.length === 0) {
    const snapshot = await getActiveSnapshotVersion();
    return `actual:${snapshot ?? 'live'}`;
  }

  const versionJson = JSON.stringify(versions);
  const rows = await prisma.$queryRaw<Array<{ stamp: Date | null; cnt: bigint | number }>>`
    SELECT MAX(updatedAt) AS stamp, COUNT_BIG(*) AS cnt
    FROM dbo.forecast_values
    WHERE versionName IN (SELECT CAST([value] AS NVARCHAR(100)) FROM OPENJSON(${versionJson}))
  `;
  const stamp = rows[0]?.stamp ? new Date(rows[0].stamp).toISOString() : 'none';
  const cnt = Number(rows[0]?.cnt ?? 0);
  const snapshot = compareLeft === OVERPLAN_ACTUAL_SOURCE || compareRight === OVERPLAN_ACTUAL_SOURCE
    ? await getActiveSnapshotVersion()
    : null;
  return `${stamp}|${cnt}|actual:${snapshot ?? 'none'}`;
}

export async function getOverplanCompareDataStamp(compareLeft: string, compareRight: string) {
  return loadForecastDataStamp(compareLeft, compareRight);
}

function pruneDetailQtyCache(): void {
  pruneCache(detailQtyCache, MAX_DETAIL_QTY_CACHE_ENTRIES);
}

export async function loadOverplanRegistrationMeta(registrationIds: string[]) {
  if (registrationIds.length === 0) return new Map<string, OverplanRegistrationMeta>();
  const registrationSourceSql = await getRegistrationSourceSql();
  const metaById = new Map<string, OverplanRegistrationMeta>();

  for (const idChunk of chunkArray([...new Set(registrationIds)], META_ID_CHUNK_SIZE)) {
    const registrationIdsJson = JSON.stringify(idChunk);
    const rows = await prisma.$queryRaw<Array<{
      registrationId: string;
      materialCode: string | null;
      materialDescription: string | null;
      plantCode: string | null;
      ownerName: string | null;
    }>>`
      WITH requested_ids AS (
        SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
        FROM OPENJSON(${registrationIdsJson})
      ),
      registration_source AS (${registrationSourceSql})
      SELECT
        CAST(source.RegistrationId AS NVARCHAR(200)) AS registrationId,
        CAST(ISNULL(source.MaterialCode, '') AS NVARCHAR(100)) AS materialCode,
        CAST(ISNULL(source.MaterialDescription, '') AS NVARCHAR(500)) AS materialDescription,
        CAST(ISNULL(source.PlantCode, '') AS NVARCHAR(100)) AS plantCode,
        CAST(ISNULL(source.OwnerName, '') AS NVARCHAR(500)) AS ownerName
      FROM registration_source source
      INNER JOIN requested_ids requested
        ON requested.registrationId = source.RegistrationId
    `;

    for (const row of rows) {
      metaById.set(row.registrationId, {
        registrationId: row.registrationId,
        materialCode: row.materialCode ?? '',
        materialDescription: row.materialDescription ?? '',
        plantCode: row.plantCode ?? '',
        ownerName: row.ownerName ?? '',
      });
    }
  }

  return metaById;
}

async function loadForecastQtyByRegistrationPeriod(
  periods: string[],
  versionName: string,
  granularity: ActualGranularity,
  filterSql: Prisma.Sql,
  registrationSourceSql: Prisma.Sql
) {
  if (periods.length === 0) return new Map<string, number>();
  const periodsJson = JSON.stringify(periods);
  const keyFor = (registrationId: string, period: string) => `${registrationId}|${period}`;

  if (granularity === 'month') {
    // Sparse + sargable: start from forecast_values, join registration for mode/filters.
    const rows = await prisma.$queryRaw<Array<{ registrationId: string; period: string; qtyFcst: unknown }>>`
      WITH registration_source AS (${registrationSourceSql}),
      requested_periods AS (
        SELECT
          CAST([value] AS NVARCHAR(7)) AS period,
          CAST(CONCAT(CAST([value] AS NVARCHAR(7)), N'-01') AS DATE) AS periodStart,
          DATEADD(MONTH, 1, CAST(CONCAT(CAST([value] AS NVARCHAR(7)), N'-01') AS DATE)) AS periodEnd
        FROM OPENJSON(${periodsJson})
      ),
      week_by_month AS (
        SELECT
          forecast.registrationId,
          CONVERT(CHAR(7), forecast.period, 126) AS period,
          SUM(forecast.qtyFcst) AS qtyFcst
        FROM dbo.forecast_values forecast
        INNER JOIN registration_source r
          ON r.RegistrationId = forecast.registrationId
        INNER JOIN requested_periods requested_period
          ON forecast.period >= requested_period.periodStart
         AND forecast.period < requested_period.periodEnd
        WHERE forecast.versionName = ${versionName}
          AND forecast.granularity = N'week'
          AND r.RegistrationId IS NOT NULL
          ${filterSql}
        GROUP BY forecast.registrationId, CONVERT(CHAR(7), forecast.period, 126)
      ),
      monthly_rows AS (
        SELECT
          forecast.registrationId,
          CONVERT(CHAR(7), forecast.period, 126) AS period,
          SUM(forecast.qtyFcst) AS qtyFcst
        FROM dbo.forecast_values forecast
        INNER JOIN registration_source r
          ON r.RegistrationId = forecast.registrationId
        INNER JOIN requested_periods requested_period
          ON forecast.period >= requested_period.periodStart
         AND forecast.period < requested_period.periodEnd
        WHERE forecast.versionName = ${versionName}
          AND forecast.granularity = N'month'
          AND r.RegistrationId IS NOT NULL
          ${filterSql}
        GROUP BY forecast.registrationId, CONVERT(CHAR(7), forecast.period, 126)
      ),
      keys AS (
        SELECT registrationId, period FROM week_by_month
        UNION
        SELECT registrationId, period FROM monthly_rows
      )
      SELECT
        keys.registrationId,
        keys.period,
        CASE
          WHEN week_by_month.qtyFcst IS NOT NULL THEN week_by_month.qtyFcst
          ELSE ISNULL(monthly_rows.qtyFcst, 0)
        END AS qtyFcst
      FROM keys
      LEFT JOIN week_by_month
        ON week_by_month.registrationId = keys.registrationId
       AND week_by_month.period = keys.period
      LEFT JOIN monthly_rows
        ON monthly_rows.registrationId = keys.registrationId
       AND monthly_rows.period = keys.period
    `;
    const qtyMap = new Map<string, number>();
    for (const row of rows) {
      const qty = Number(row.qtyFcst ?? 0);
      if (!Number.isFinite(qty) || qty === 0) continue;
      qtyMap.set(keyFor(row.registrationId, row.period), qty);
    }
    return qtyMap;
  }

  const rows = await prisma.$queryRaw<Array<{ registrationId: string; period: string; qtyFcst: unknown }>>`
    WITH registration_source AS (${registrationSourceSql}),
    requested_periods AS (
      SELECT
        CAST([value] AS NVARCHAR(15)) AS period,
        LEFT(CAST([value] AS NVARCHAR(15)), 7) AS monthPeriod,
        CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), N'-01') AS DATE) AS monthStart,
        DATEADD(MONTH, 1, CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), N'-01') AS DATE)) AS monthEnd,
        CONVERT(CHAR(10), DATEADD(
          DAY,
          (7 - (DATEDIFF(DAY, '19000103', CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), '-01') AS DATE)) % 7)) % 7,
          CAST(CONCAT(LEFT(CAST([value] AS NVARCHAR(15)), 7), '-01') AS DATE)
        ), 126) AS firstWednesday
      FROM OPENJSON(${periodsJson})
    ),
    requested_months AS (
      SELECT DISTINCT monthPeriod, monthStart, monthEnd
      FROM requested_periods
    ),
    exact_week_rows AS (
      SELECT
        forecast.registrationId,
        CONVERT(CHAR(10), forecast.period, 23) AS period,
        forecast.qtyFcst
      FROM dbo.forecast_values forecast
      INNER JOIN registration_source r
        ON r.RegistrationId = forecast.registrationId
      INNER JOIN requested_periods requested_period
        ON forecast.period = CAST(requested_period.period AS DATE)
      WHERE forecast.versionName = ${versionName}
        AND forecast.granularity = N'week'
        AND r.RegistrationId IS NOT NULL
        ${filterSql}
        AND forecast.period >= (SELECT MIN(monthStart) FROM requested_months)
        AND forecast.period < (SELECT MAX(monthEnd) FROM requested_months)
    ),
    monthly_rows AS (
      SELECT
        forecast.registrationId,
        CONVERT(CHAR(7), forecast.period, 126) AS period,
        SUM(forecast.qtyFcst) AS qtyFcst
      FROM dbo.forecast_values forecast
      INNER JOIN registration_source r
        ON r.RegistrationId = forecast.registrationId
      INNER JOIN requested_months requested_month
        ON forecast.period >= requested_month.monthStart
       AND forecast.period < requested_month.monthEnd
      WHERE forecast.versionName = ${versionName}
        AND forecast.granularity = N'month'
        AND r.RegistrationId IS NOT NULL
        ${filterSql}
      GROUP BY forecast.registrationId, CONVERT(CHAR(7), forecast.period, 126)
    ),
    week_keys AS (
      SELECT registrationId, period, qtyFcst FROM exact_week_rows
    ),
    month_as_week AS (
      SELECT
        monthly_rows.registrationId,
        requested_periods.period,
        monthly_rows.qtyFcst
      FROM monthly_rows
      INNER JOIN requested_periods
        ON requested_periods.monthPeriod = monthly_rows.period
       AND requested_periods.period = requested_periods.firstWednesday
      WHERE NOT EXISTS (
        SELECT 1
        FROM exact_week_rows
        WHERE exact_week_rows.registrationId = monthly_rows.registrationId
          AND exact_week_rows.period = requested_periods.period
      )
    )
    SELECT registrationId, period, qtyFcst FROM week_keys
    UNION ALL
    SELECT registrationId, period, qtyFcst FROM month_as_week
  `;
  const qtyMap = new Map<string, number>();
  for (const row of rows) {
    const qty = Number(row.qtyFcst ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;
    qtyMap.set(keyFor(row.registrationId, row.period), qty);
  }
  return qtyMap;
}

async function loadActualQtyByRegistrationPeriod(
  periods: string[],
  startMonth: string,
  endMonth: string,
  granularity: ActualGranularity,
  filterSql: Prisma.Sql,
  registrationSourceSql: Prisma.Sql
) {
  if (periods.length === 0) return new Map<string, number>();
  const snapshotVersion = await getActiveSnapshotVersion();
  const periodsJson = JSON.stringify(periods);
  const actualRegSource = actualRegistrationSourceSql(snapshotVersion);
  const actualSource = actualSalesSourceSql(snapshotVersion);
  const periodExpression = actualPeriodExpression(granularity);
  const rangeStart = `${startMonth}-01`;
  const rangeEnd = nextMonthStart(endMonth);
  const keyFor = (registrationId: string, period: string) => `${registrationId}|${period}`;

  // Join full registration_source (mode + filters) to actual key map — no OPENJSON of all ids.
  const rows = await prisma.$queryRaw<Array<{ registrationId: string; period: string; qtyAct: unknown }>>`
    WITH registration_source AS (${registrationSourceSql}),
    actual_reg_map AS (${actualRegSource}),
    requested_periods AS (
      SELECT CAST([value] AS NVARCHAR(15)) AS period
      FROM OPENJSON(${periodsJson})
    ),
    actual_source AS (${actualSource}),
    requested_registrations AS (
      SELECT DISTINCT
        CAST(map.registrationId AS NVARCHAR(200)) AS registrationId,
        map.keyForNoCRM
      FROM actual_reg_map map
      INNER JOIN registration_source r
        ON r.RegistrationId = map.registrationId
      WHERE map.registrationId IS NOT NULL
        ${filterSql}
    ),
    actual_events AS (
      SELECT
        requested.registrationId,
        eventData.eventDate,
        eventData.qtyAct
      FROM actual_source actual
      INNER JOIN requested_registrations requested
        ON requested.keyForNoCRM = actual.[Key for no regist]
      CROSS APPLY (VALUES
        (actual.Deliverydate, CAST(ISNULL(actual.[Order Qty_TON], 0) AS DECIMAL(18, 4)))
      ) eventData(eventDate, qtyAct)
      WHERE eventData.eventDate IS NOT NULL
        AND eventData.eventDate >= ${rangeStart}
        AND eventData.eventDate < ${rangeEnd}
    ),
    actual_by_period AS (
      SELECT
        registrationId,
        ${periodExpression} AS period,
        SUM(qtyAct) AS qtyAct
      FROM actual_events
      GROUP BY registrationId, ${periodExpression}
    )
    SELECT actual_by_period.registrationId, actual_by_period.period, actual_by_period.qtyAct
    FROM actual_by_period
    INNER JOIN requested_periods requested_period
      ON requested_period.period = actual_by_period.period
  `;

  const qtyMap = new Map<string, number>();
  for (const row of rows) {
    const qty = Number(row.qtyAct ?? 0);
    if (!Number.isFinite(qty) || qty === 0) continue;
    qtyMap.set(keyFor(row.registrationId, row.period), qty);
  }
  return qtyMap;
}

async function loadCompareQtyMap(
  source: string,
  periods: string[],
  startMonth: string,
  endMonth: string,
  granularity: ActualGranularity,
  filterSql: Prisma.Sql,
  registrationSourceSql: Prisma.Sql
) {
  if (source === OVERPLAN_ACTUAL_SOURCE) {
    return loadActualQtyByRegistrationPeriod(
      periods,
      startMonth,
      endMonth,
      granularity,
      filterSql,
      registrationSourceSql
    );
  }
  return loadForecastQtyByRegistrationPeriod(
    periods,
    source,
    granularity,
    filterSql,
    registrationSourceSql
  );
}

async function loadOverplanDetailRowsUncached(input: {
  filters: RegistrationFilters;
  startMonth: string;
  endMonth: string;
  granularity: ActualGranularity;
  compareLeft: string;
  compareRight: string;
}): Promise<OverplanDetailQtyRow[]> {
  const t0 = Date.now();
  const periods = resolveOverplanPeriods(input.startMonth, input.endMonth);
  const filterSql = buildRegistrationFilterSql(input.filters);
  const registrationSourceSql = await getRegistrationSourceSql();

  const [leftQtyMap, rightQtyMap] = await Promise.all([
    loadCompareQtyMap(
      input.compareLeft,
      periods,
      input.startMonth,
      input.endMonth,
      input.granularity,
      filterSql,
      registrationSourceSql
    ),
    loadCompareQtyMap(
      input.compareRight,
      periods,
      input.startMonth,
      input.endMonth,
      input.granularity,
      filterSql,
      registrationSourceSql
    ),
  ]);

  const keys = new Set<string>([...leftQtyMap.keys(), ...rightQtyMap.keys()]);
  const registrationIdsNeeded = [...new Set(
    [...keys].map(key => key.slice(0, key.indexOf('|'))).filter(Boolean)
  )];
  const metaById = await loadOverplanRegistrationMeta(registrationIdsNeeded);

  const rows: OverplanDetailQtyRow[] = [];
  for (const key of keys) {
    const separator = key.indexOf('|');
    if (separator <= 0) continue;
    const registrationId = key.slice(0, separator);
    const period = key.slice(separator + 1);
    const leftQty = leftQtyMap.get(key) ?? 0;
    const rightQty = rightQtyMap.get(key) ?? 0;
    if (leftQty === 0 && rightQty === 0) continue;
    const meta = metaById.get(registrationId) ?? {
      registrationId,
      materialCode: '',
      materialDescription: '',
      plantCode: '',
      ownerName: '',
    };
    rows.push({
      ...meta,
      period,
      leftQty,
      rightQty,
    });
  }

  console.info(
    `[overplan] detail qty ${Date.now() - t0}ms rows=${rows.length} `
    + `${input.compareLeft} vs ${input.compareRight} ${input.granularity} `
    + `${input.startMonth}..${input.endMonth}`
  );
  return rows;
}

export async function loadOverplanDetailRows(input: {
  filters?: RegistrationFilters;
  startMonth: string;
  endMonth: string;
  granularity?: ActualGranularity;
  compareLeft: string;
  compareRight: string;
}): Promise<OverplanDetailQtyRow[]> {
  const filters = input.filters ?? {};
  const granularity = input.granularity ?? 'month';
  const dataStamp = await loadForecastDataStamp(input.compareLeft, input.compareRight);
  const cacheKey = detailQtyCacheKey({
    startMonth: input.startMonth,
    endMonth: input.endMonth,
    granularity,
    compareLeft: input.compareLeft,
    compareRight: input.compareRight,
    filters,
    dataStamp,
  });

  const cached = detailQtyCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = loadOverplanDetailRowsUncached({
    filters,
    startMonth: input.startMonth,
    endMonth: input.endMonth,
    granularity,
    compareLeft: input.compareLeft,
    compareRight: input.compareRight,
  }).catch(error => {
    detailQtyCache.delete(cacheKey);
    throw error;
  });

  detailQtyCache.set(cacheKey, {
    expiresAt: Date.now() + DETAIL_QTY_CACHE_TTL_MS,
    promise,
  });
  pruneDetailQtyCache();
  return promise;
}

export function aggregateOverplanRows(rows: OverplanDetailQtyRow[]) {
  const grouped = new Map<string, OverplanDetailQtyRow>();
  for (const row of rows) {
    const key = `${row.materialCode}|${row.plantCode}|${row.period}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        registrationId: key,
        materialCode: row.materialCode,
        materialDescription: row.materialDescription,
        plantCode: row.plantCode,
        ownerName: '',
        period: row.period,
        leftQty: row.leftQty,
        rightQty: row.rightQty,
      });
      continue;
    }
    existing.leftQty += row.leftQty;
    existing.rightQty += row.rightQty;
  }
  return [...grouped.values()];
}
