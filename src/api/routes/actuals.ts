import { Prisma } from '@prisma/client';
import { Router } from 'express';
import {
  buildAppModeRegistrationScopeSql,
  filterRegistrationIdsInAppMode,
  getAppMode,
} from '../../config/appMode';
import prisma from '../../db/prisma';
import { getActiveSnapshotVersion } from '../services/dataSnapshot';
import { pruneCache } from '../services/boundedCache';

const router = Router();
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface ActualApiRow {
  registrationId: string;
  sourceStatus: 'matched' | 'actual_only';
  month: string;
  qtyAct: number;
  priceAct: number;
  amountAct: number;
  carryInETD: number;
  carryOutETD: number;
  carryInLoading: number;
  carryOutLoading: number;
  registration?: Record<string, unknown>;
}

type ActualFilters = Record<string, string[]>;
export type ActualGranularity = 'month' | 'week';

export function actualRegistrationSourceSql(snapshotVersion: string | null) {
  const crmSource = snapshotVersion
    ? Prisma.sql`
      SELECT
        r.registrationId,
        r.keyForNoCRM,
        r.businessUnit AS BusinessUnit,
        r.plantCode AS PlantCode
      FROM dbo.crm_registration_snapshot r
      WHERE r.snapshotVersion = ${snapshotVersion}
        AND r.keyForNoCRM IS NOT NULL
    `
    : Prisma.sql`
      SELECT
        CAST(r.NewKey AS NVARCHAR(200)) AS registrationId,
        CAST(r.KeyforNoCRM AS NVARCHAR(500)) AS keyForNoCRM,
        CAST(N'' AS NVARCHAR(50)) AS BusinessUnit,
        CAST(r.PlantCode AS NVARCHAR(100)) AS PlantCode
      FROM dbo.VW_CRM_RegistrationAll_1 r
      WHERE r.MainRegist = 1
        AND r.NewKey IS NOT NULL
        AND r.KeyforNoCRM IS NOT NULL
    `;
  const modeScopeSql = buildAppModeRegistrationScopeSql('r');
  return Prisma.sql`
    SELECT registrationId, keyForNoCRM
    FROM (
      ${crmSource}
      UNION ALL
      SELECT
        r.id AS registrationId,
        r.keyForNoCRM AS keyForNoCRM,
        r.businessUnit AS BusinessUnit,
        r.plantCode AS PlantCode
      FROM dbo.master_data_crm_registrations r
      WHERE r.mainRegist = 1
    ) r
    WHERE r.registrationId IS NOT NULL
      ${modeScopeSql}
  `;
}

export function actualSalesSourceSql(snapshotVersion: string | null) {
  return snapshotVersion
    ? Prisma.sql`
      SELECT
        a.keyForNoRegist AS [Key for no regist],
        a.deliveryDate AS Deliverydate,
        a.carryInETD AS CarryIn_ETD,
        a.carryOutETD AS CarryOut_ETD,
        a.carryInLoading AS CarryIn_Loading,
        a.carryOutLoading AS CarryOut_Loading,
        a.qty AS [Order Qty_TON],
        a.price AS [Unit Price USD Ton(new)],
        a.amount AS [Net Amount USD (new)],
        a.country AS [Ship-to Country ],
        a.soldTo AS [Sold-to pt ],
        a.shipTo AS [Ship-to pt ],
        a.endUser AS Enduser,
        a.plant AS Plant,
        a.materialCode AS Material
      FROM dbo.actual_sales_snapshot a
      WHERE a.snapshotVersion = ${snapshotVersion}
    `
    : Prisma.sql`
      SELECT
        a.[Key for no regist], a.Deliverydate, a.CarryIn_ETD, a.CarryOut_ETD,
        a.CarryIn_Loading, a.CarryOut_Loading, a.[Order Qty_TON],
        a.[Unit Price USD Ton(new)], a.[Net Amount USD (new)],
        a.[Ship-to Country ], a.[Sold-to pt ], a.[Ship-to pt ],
        a.Enduser, a.Plant, a.Material
      FROM dbo.MKT_SALEReport_ZSDR001_UGT_CRM_NYL_1 a
    `;
}

function parseGranularity(value: unknown): ActualGranularity {
  return value === 'week' ? 'week' : 'month';
}

export function actualPeriodExpression(granularity: ActualGranularity) {
  return granularity === 'week'
    ? Prisma.sql`CONVERT(CHAR(10), DATEADD(DAY, -(DATEDIFF(DAY, '19000103', eventDate) % 7), CAST(eventDate AS DATE)), 126)`
    : Prisma.sql`CONVERT(CHAR(7), eventDate, 126)`;
}

function parseFilters(value: unknown): ActualFilters {
  if (typeof value !== 'string' || !value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([, values]) => Array.isArray(values))
        .map(([key, values]) => [key, (values as unknown[]).map(String).filter(Boolean)])
        .filter(([, values]) => values.length > 0)
    );
  } catch {
    return {};
  }
}

function matchesActualOnlyFilters(
  registration: Record<string, unknown> | undefined,
  filters: ActualFilters
) {
  if (!registration) return false;
  return Object.entries(filters).every(([key, selectedValues]) => {
    const value = String(registration[key] ?? '').toLowerCase();
    return selectedValues.some(selected => value === selected.toLowerCase());
  });
}

const MAX_ACTUAL_CACHE_ENTRIES = 64;
const actualRangeCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ActualApiRow[]> }
>();
const scopedActualCache = new Map<
  string,
  { expiresAt: number; promise: Promise<ActualApiRow[]> }
>();

async function snapshotCachePrefix() {
  const snapshotVersion = await getActiveSnapshotVersion();
  return snapshotVersion ?? 'live';
}

export function clearActualCaches() {
  actualRangeCache.clear();
  scopedActualCache.clear();
}

export function nextMonthStart(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, monthNumber, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

function getOnOffFromKey(value: string) {
  const segment = value.split('/').at(-1)?.trim() ?? '';
  return /^off$/i.test(segment) ? 'Off' : /^on$/i.test(segment) ? 'On' : '';
}

function createActualOnlyRegistration(row: Record<string, unknown>, registrationId: string) {
  const keyForNoCRM = String(row.keyForNoRegist ?? '');
  return {
    id: registrationId,
    sourceStatus: 'actual_only',
    keyForNoCRM,
    businessUnit: '',
    ownerName: '',
    registrationTopic: keyForNoCRM,
    onOffSpec: getOnOffFromKey(keyForNoCRM),
    plantCode: String(row.plant ?? ''),
    countryName: String(row.country ?? ''),
    materialDescription: '',
    materialCode: String(row.materialCode ?? ''),
    shipTo_name: String(row.shipTo ?? ''),
    soldTo_name: String(row.soldTo ?? ''),
    end_user: String(row.enduser ?? ''),
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
    plantName: String(row.plant ?? ''),
    countryCode: '',
    endUserCode: '',
    endUserExportControl: '',
    endUserName: String(row.enduser ?? ''),
    productName: '',
    productNamePud: '',
    gradeUfa: '',
    gradeSap: '',
    column1: keyForNoCRM,
    carryInETD: 0,
    carryOutETD: 0,
    carryInLoading: 0,
    carryOutLoading: 0,
    priceFormula: '',
    spread: null,
    pricingPolicy: null,
  };
}

async function queryActualRange(
  startMonth?: string,
  endMonth?: string,
  granularity: ActualGranularity = 'month'
) {
  const snapshotVersion = await getActiveSnapshotVersion();
  const registrationSource = actualRegistrationSourceSql(snapshotVersion);
  const actualSource = actualSalesSourceSql(snapshotVersion);
  const rangeStart = startMonth ? `${startMonth}-01` : null;
  const rangeEnd = endMonth ? nextMonthStart(endMonth) : null;
  const deliveryDateFilter = rangeStart && rangeEnd
    ? Prisma.sql`AND a.Deliverydate >= ${rangeStart} AND a.Deliverydate < ${rangeEnd}`
    : Prisma.empty;
  const carryDateFilter = rangeStart && rangeEnd
    ? Prisma.sql`AND eventData.eventDate >= ${rangeStart} AND eventData.eventDate < ${rangeEnd}`
    : Prisma.empty;
  const periodExpression = actualPeriodExpression(granularity);

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    WITH registration_source AS (${registrationSource}),
    actual_source AS (${actualSource}),
    registration_candidates AS (
      SELECT
        registrationId,
        keyForNoCRM,
        ROW_NUMBER() OVER (
          PARTITION BY keyForNoCRM
          ORDER BY registrationId
        ) AS matchOrder,
        COUNT(*) OVER (
          PARTITION BY keyForNoCRM
        ) AS matchCount
      FROM registration_source
    ),
    registration_map AS (
      SELECT registrationId, keyForNoCRM
      FROM registration_candidates
      WHERE matchOrder = 1
        AND matchCount = 1
    ),
    actual_events AS (
      SELECT
        CAST(a.[Key for no regist] AS NVARCHAR(500)) AS keyForNoRegist,
        a.Deliverydate AS eventDate,
        CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)) AS qtyAct,
        CAST(ISNULL(a.[Unit Price USD Ton(new)], 0) AS DECIMAL(18, 4)) AS priceAct,
        CAST(ISNULL(a.[Net Amount USD (new)], 0) AS DECIMAL(18, 4)) AS amountAct,
        CAST(0 AS DECIMAL(18, 4)) AS carryInETD,
        CAST(0 AS DECIMAL(18, 4)) AS carryOutETD,
        CAST(0 AS DECIMAL(18, 4)) AS carryInLoading,
        CAST(0 AS DECIMAL(18, 4)) AS carryOutLoading,
        CAST(a.[Ship-to Country ] AS NVARCHAR(500)) AS country,
        CAST(a.[Sold-to pt ] AS NVARCHAR(500)) AS soldTo,
        CAST(a.[Ship-to pt ] AS NVARCHAR(500)) AS shipTo,
        CAST(a.[Enduser] AS NVARCHAR(500)) AS enduser,
        CAST(a.[Plant] AS NVARCHAR(500)) AS plant,
        CAST(a.[Material] AS NVARCHAR(500)) AS materialCode
      FROM actual_source a
      WHERE a.[Key for no regist] IS NOT NULL
        AND a.Deliverydate IS NOT NULL
        ${deliveryDateFilter}

      UNION ALL

      SELECT
        CAST(a.[Key for no regist] AS NVARCHAR(500)),
        eventData.eventDate,
        0,
        0,
        0,
        CASE WHEN eventData.eventType = 'carryInETD' THEN eventData.qty ELSE 0 END,
        CASE WHEN eventData.eventType = 'carryOutETD' THEN eventData.qty ELSE 0 END,
        CASE WHEN eventData.eventType = 'carryInLoading' THEN eventData.qty ELSE 0 END,
        CASE WHEN eventData.eventType = 'carryOutLoading' THEN eventData.qty ELSE 0 END,
        CAST(a.[Ship-to Country ] AS NVARCHAR(500)),
        CAST(a.[Sold-to pt ] AS NVARCHAR(500)),
        CAST(a.[Ship-to pt ] AS NVARCHAR(500)),
        CAST(a.[Enduser] AS NVARCHAR(500)),
        CAST(a.[Plant] AS NVARCHAR(500)),
        CAST(a.[Material] AS NVARCHAR(500))
      FROM actual_source a
      CROSS APPLY (VALUES
        ('carryInETD', a.[CarryIn_ETD], CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))),
        ('carryOutETD', a.[CarryOut_ETD], CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))),
        ('carryInLoading', a.[CarryIn_Loading], CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))),
        ('carryOutLoading', a.[CarryOut_Loading], CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)))
      ) eventData(eventType, eventDate, qty)
      WHERE a.[Key for no regist] IS NOT NULL
        AND eventData.eventDate IS NOT NULL
        ${carryDateFilter}
    ),
    actual_by_period AS (
      SELECT
        keyForNoRegist,
        ${periodExpression} AS month,
        SUM(qtyAct) AS qtyAct,
        CASE
          WHEN SUM(qtyAct) = 0 THEN 0
          ELSE SUM(amountAct) / NULLIF(SUM(qtyAct), 0)
        END AS priceAct,
        SUM(amountAct) AS amountAct,
        SUM(carryInETD) AS carryInETD,
        SUM(carryOutETD) AS carryOutETD,
        SUM(carryInLoading) AS carryInLoading,
        SUM(carryOutLoading) AS carryOutLoading,
        MAX(country) AS country,
        MAX(soldTo) AS soldTo,
        MAX(shipTo) AS shipTo,
        MAX(enduser) AS enduser,
        MAX(plant) AS plant,
        MAX(materialCode) AS materialCode
      FROM actual_events
      GROUP BY keyForNoRegist, ${periodExpression}
    )
    SELECT
      m.registrationId,
      a.*
    FROM actual_by_period a
    LEFT JOIN registration_map m ON m.keyForNoCRM = a.keyForNoRegist
    ORDER BY COALESCE(m.registrationId, a.keyForNoRegist), a.month
  `;

  return rows.map(row => {
    const matchedRegistrationId = row.registrationId ? String(row.registrationId) : null;
    const registrationId = matchedRegistrationId ?? `ACTUAL_ONLY:${String(row.keyForNoRegist)}`;
    const sourceStatus = matchedRegistrationId ? 'matched' as const : 'actual_only' as const;
    return {
      registrationId,
      sourceStatus,
      month: String(row.month),
      qtyAct: Number(row.qtyAct),
      priceAct: Number(row.priceAct),
      amountAct: Number(row.amountAct),
      carryInETD: Number(row.carryInETD),
      carryOutETD: Number(row.carryOutETD),
      carryInLoading: Number(row.carryInLoading),
      carryOutLoading: Number(row.carryOutLoading),
      ...(sourceStatus === 'actual_only'
        ? { registration: createActualOnlyRegistration(row, registrationId) }
        : {}),
    };
  });
}

async function queryScopedActualRange(
  startMonth: string | undefined,
  endMonth: string | undefined,
  registrationIds: string[],
  granularity: ActualGranularity = 'month'
) {
  if (registrationIds.length === 0) return [];

  const snapshotVersion = await getActiveSnapshotVersion();
  const registrationSource = actualRegistrationSourceSql(snapshotVersion);
  const actualSource = actualSalesSourceSql(snapshotVersion);
  const registrationIdsJson = JSON.stringify(registrationIds);
  const rangeStart = startMonth ? `${startMonth}-01` : null;
  const rangeEnd = endMonth ? nextMonthStart(endMonth) : null;
  const eventDateFilter = rangeStart && rangeEnd
    ? Prisma.sql`AND eventData.eventDate >= ${rangeStart} AND eventData.eventDate < ${rangeEnd}`
    : Prisma.empty;
  const periodExpression = actualPeriodExpression(granularity);

  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
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
    actual_events AS (
      SELECT
        requested.registrationId,
        eventData.eventDate,
        eventData.qtyAct,
        eventData.priceAct,
        eventData.amountAct,
        eventData.carryInETD,
        eventData.carryOutETD,
        eventData.carryInLoading,
        eventData.carryOutLoading
      FROM actual_source a
      INNER JOIN requested_registrations requested
        ON requested.keyForNoCRM = a.[Key for no regist]
      CROSS APPLY (VALUES
        (
          a.Deliverydate,
          CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)),
          CAST(ISNULL(a.[Unit Price USD Ton(new)], 0) AS DECIMAL(18, 4)),
          CAST(ISNULL(a.[Net Amount USD (new)], 0) AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4)),
          CAST(0 AS DECIMAL(18, 4))
        ),
        (
          a.[CarryIn_ETD], 0, 0, 0,
          CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0, 0, 0
        ),
        (
          a.[CarryOut_ETD], 0, 0, 0,
          0, CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0, 0
        ),
        (
          a.[CarryIn_Loading], 0, 0, 0,
          0, 0, CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4)), 0
        ),
        (
          a.[CarryOut_Loading], 0, 0, 0,
          0, 0, 0, CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))
        )
      ) eventData(
        eventDate,
        qtyAct,
        priceAct,
        amountAct,
        carryInETD,
        carryOutETD,
        carryInLoading,
        carryOutLoading
      )
      WHERE eventData.eventDate IS NOT NULL
        ${eventDateFilter}
    )
    SELECT
      registrationId,
      ${periodExpression} AS month,
      SUM(qtyAct) AS qtyAct,
      CASE
        WHEN SUM(qtyAct) = 0 THEN 0
        ELSE SUM(amountAct) / NULLIF(SUM(qtyAct), 0)
      END AS priceAct,
      SUM(amountAct) AS amountAct,
      SUM(carryInETD) AS carryInETD,
      SUM(carryOutETD) AS carryOutETD,
      SUM(carryInLoading) AS carryInLoading,
      SUM(carryOutLoading) AS carryOutLoading
    FROM actual_events
    GROUP BY registrationId, ${periodExpression}
    ORDER BY registrationId, month
  `;

  return rows.map(row => ({
    registrationId: String(row.registrationId),
    sourceStatus: 'matched' as const,
    month: String(row.month),
    qtyAct: Number(row.qtyAct),
    priceAct: Number(row.priceAct),
    amountAct: Number(row.amountAct),
    carryInETD: Number(row.carryInETD),
    carryOutETD: Number(row.carryOutETD),
    carryInLoading: Number(row.carryInLoading),
    carryOutLoading: Number(row.carryOutLoading),
  }));
}

async function getCachedActualRange(
  startMonth?: string,
  endMonth?: string,
  granularity: ActualGranularity = 'month'
) {
  const snapshotPrefix = await snapshotCachePrefix();
  const cacheKey = `${getAppMode()}|${snapshotPrefix}|${granularity}|${startMonth ?? '*'}|${endMonth ?? '*'}`;
  const cached = actualRangeCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = queryActualRange(startMonth, endMonth, granularity).catch(error => {
    actualRangeCache.delete(cacheKey);
    throw error;
  });
  actualRangeCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  pruneCache(actualRangeCache, MAX_ACTUAL_CACHE_ENTRIES);
  return promise;
}

export async function getCachedScopedActualRange(
  startMonth: string | undefined,
  endMonth: string | undefined,
  registrationIds: string[],
  granularity: ActualGranularity = 'month'
) {
  const snapshotPrefix = await snapshotCachePrefix();
  const sortedIds = [...new Set(registrationIds)].sort((left, right) => left.localeCompare(right));
  const cacheKey = `${getAppMode()}|${snapshotPrefix}|${granularity}|${startMonth ?? '*'}|${endMonth ?? '*'}|${sortedIds.join('\u001f')}`;
  const cached = scopedActualCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.promise;

  const promise = queryScopedActualRange(startMonth, endMonth, sortedIds, granularity).catch(error => {
    scopedActualCache.delete(cacheKey);
    throw error;
  });
  scopedActualCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, promise });
  pruneCache(scopedActualCache, MAX_ACTUAL_CACHE_ENTRIES);
  return promise;
}

export async function getCachedScopedActualRangeBatched(
  startMonth: string | undefined,
  endMonth: string | undefined,
  registrationIds: string[],
  granularity: ActualGranularity = 'month'
) {
  if (await getActiveSnapshotVersion()) {
    return await getCachedScopedActualRange(startMonth, endMonth, registrationIds, granularity);
  }
  const chunks: string[][] = [];
  for (let index = 0; index < registrationIds.length; index += 500) {
    chunks.push(registrationIds.slice(index, index + 500));
  }

  const rows: ActualApiRow[] = [];
  for (let index = 0; index < chunks.length; index += 4) {
    const batch = await Promise.all(
      chunks
        .slice(index, index + 4)
        .map(chunk => getCachedScopedActualRange(startMonth, endMonth, chunk, granularity))
    );
    batch.forEach(chunkRows => rows.push(...chunkRows));
  }
  return rows;
}

router.get('/', async (req, res) => {
  const { startMonth, endMonth } = req.query as Record<string, string>;
  const granularity = parseGranularity(req.query.granularity);
  const filters = parseFilters(req.query.filters);
  const registrationIds = Array.isArray(req.query.registrationId)
    ? req.query.registrationId.map(String)
    : req.query.registrationId
      ? [String(req.query.registrationId)]
      : [];

  try {
    if (registrationIds.length > 0) {
      const allowedIds = await filterRegistrationIdsInAppMode(registrationIds);
      return res.json(
        await getCachedScopedActualRange(startMonth, endMonth, allowedIds, granularity)
      );
    }

    const rows = await getCachedActualRange(startMonth, endMonth, granularity);
    res.json(
      Object.keys(filters).length === 0
        ? rows
        : rows.filter(row =>
            row.sourceStatus !== 'actual_only' ||
            matchesActualOnlyFilters(row.registration, filters)
          )
    );
  } catch (error) {
    console.error('[actuals] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch actuals' });
  }
});

router.post('/query', async (req, res) => {
  const {
    startMonth,
    endMonth,
    registrationIds: rawRegistrationIds,
    granularity: rawGranularity,
  } = req.body as {
    startMonth?: string;
    endMonth?: string;
    registrationIds?: unknown;
    filters?: ActualFilters;
    granularity?: unknown;
  };
  const granularity = parseGranularity(rawGranularity);
  const requestedIds = Array.isArray(rawRegistrationIds)
    ? [...new Set(rawRegistrationIds.map(String).filter(Boolean))].slice(0, 5000)
    : [];

  if (requestedIds.length === 0) {
    return res.json([]);
  }

  try {
    const registrationIds = await filterRegistrationIdsInAppMode(requestedIds);
    if (registrationIds.length === 0) return res.json([]);
    res.json(
      await getCachedScopedActualRangeBatched(
        startMonth,
        endMonth,
        registrationIds,
        granularity
      )
    );
  } catch (error) {
    console.error('[actuals] POST query error:', error);
    res.status(500).json({ error: 'Failed to fetch actuals' });
  }
});

/**
 * Latest Actual price per registration = weighted avg (SUM amount / SUM qty)
 * for the most recent calendar month that has qty > 0.
 */
router.post('/latest-price', async (req, res) => {
  const rawRegistrationIds = Array.isArray(req.body?.registrationIds)
    ? (req.body.registrationIds as unknown[])
    : [];
  const normalizedIds = rawRegistrationIds
    .map(id => String(id ?? '').trim())
    .filter(id => id.length > 0);
  const requestedIds = Array.from(new Set(normalizedIds)).slice(0, 5000);
  if (requestedIds.length === 0) {
    return res.json([]);
  }

  try {
    const registrationIds = await filterRegistrationIdsInAppMode(requestedIds);
    if (registrationIds.length === 0) return res.json([]);
    const snapshotVersion = await getActiveSnapshotVersion();
    const registrationSource = actualRegistrationSourceSql(snapshotVersion);
    const actualSource = actualSalesSourceSql(snapshotVersion);
    const idsJson = JSON.stringify(registrationIds);

    const rows = await prisma.$queryRaw<Array<{
      registrationId: string;
      price: unknown;
    }>>`
      WITH requested_ids AS (
        SELECT CAST([value] AS NVARCHAR(200)) AS registrationId
        FROM OPENJSON(${idsJson})
      ),
      registration_source AS (${registrationSource}),
      actual_source AS (${actualSource}),
      registration_map AS (
        SELECT
          registrationId,
          keyForNoCRM,
          ROW_NUMBER() OVER (PARTITION BY keyForNoCRM ORDER BY registrationId) AS matchOrder
        FROM registration_source
      ),
      keyed AS (
        SELECT
          COALESCE(rm.registrationId, CAST(a.[Key for no regist] AS NVARCHAR(200))) AS registrationId,
          CONVERT(CHAR(7), a.Deliverydate, 126) AS monthPeriod,
          CAST(ISNULL(a.[Order Qty_TON], 0) AS FLOAT) AS qty,
          CAST(ISNULL(a.[Net Amount USD (new)], 0) AS FLOAT) AS amount
        FROM actual_source a
        LEFT JOIN registration_map rm
          ON rm.keyForNoCRM = CAST(a.[Key for no regist] AS NVARCHAR(500))
         AND rm.matchOrder = 1
        INNER JOIN requested_ids req
          ON req.registrationId = COALESCE(rm.registrationId, CAST(a.[Key for no regist] AS NVARCHAR(200)))
        WHERE a.Deliverydate IS NOT NULL
          AND ISNULL(a.[Order Qty_TON], 0) > 0
      ),
      monthly AS (
        SELECT
          registrationId,
          monthPeriod,
          SUM(qty) AS qty,
          SUM(amount) AS amount
        FROM keyed
        GROUP BY registrationId, monthPeriod
      ),
      ranked AS (
        SELECT
          registrationId,
          CASE WHEN qty > 0 THEN amount / qty ELSE 0 END AS price,
          ROW_NUMBER() OVER (
            PARTITION BY registrationId
            ORDER BY monthPeriod DESC
          ) AS rn
        FROM monthly
        WHERE qty > 0
      )
      SELECT registrationId, price
      FROM ranked
      WHERE rn = 1
    `;

    res.json(rows.map(row => ({
      registrationId: String(row.registrationId),
      price: Number(row.price ?? 0),
    })));
  } catch (error) {
    console.error('[actuals] POST latest-price error:', error);
    res.status(500).json({ error: 'Failed to fetch latest actual prices' });
  }
});

export default router;
