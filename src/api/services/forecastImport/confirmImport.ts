import type { Prisma } from '@prisma/client';
import prisma from '../../../db/prisma';
import { clearForecastSummaryCache } from '../../routes/forecast';
import {
  formatForecastPeriodForApi,
  parseForecastPeriodToDate,
} from '../../../lib/forecastPeriod';
import {
  CURRENT_FORECAST_VERSION,
  LEGACY_PREVIEW_CONTRACT_VERSION,
  VERSIONED_PREVIEW_CONTRACT_VERSION,
} from './constants';
import {
  chunkArray,
  isFirstDayOfMonthPeriod,
  isFirstWednesdayPeriod,
  normalizeKey,
} from './excelUtils';
import { upsertRegistrationPriceSettings, upsertRegistrationSpread } from '../registrationPricing';
import { isCostPlus5Spread, normalizePricingPolicy } from '../../../lib/pricingPolicy';
import { getActiveSnapshotVersion } from '../dataSnapshot';
import { findRegistrationMatches } from './matching';
import { normalizeStampPeriod } from './stampPeriod';
import type {
  ConfirmLegacyImportRecord,
  ConfirmVersionedImportRecord,
} from './types';

type ImportColumnFlags = {
  hasPriceColumns: boolean;
  hasAmountColumns: boolean;
  spreadByRegistrationId?: Record<string, string>;
  pricingPolicyByRegistrationId?: Record<string, string>;
};

const LEGACY_IMPORT_COLUMN_FLAGS: ImportColumnFlags = {
  hasPriceColumns: false,
  hasAmountColumns: false,
};

const VERSIONED_IMPORT_COLUMN_FLAGS: ImportColumnFlags = {
  hasPriceColumns: true,
  hasAmountColumns: true,
};

export {
  CURRENT_FORECAST_VERSION,
  LEGACY_PREVIEW_CONTRACT_VERSION,
  VERSIONED_PREVIEW_CONTRACT_VERSION,
};

export type ForecastImportConfirmResult = {
  ok: true;
  imported: number;
  created: number;
  overwritten: number;
  version: string;
  registrationsCreated: number;
  createdRegistrationIds: string[];
};

export class ForecastImportConfirmError extends Error {
  readonly statusCode: number;
  readonly code?: string;

  constructor(statusCode: number, message: string, code?: string) {
    super(message);
    this.name = 'ForecastImportConfirmError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

const MAX_IMPORT_RECORDS = 20_000;
const LOOKUP_CHUNK_SIZE = 500;
const VALUE_EPSILON = 0.0001;

type ExistingForecastRow = {
  registrationId: string;
  period: Date;
  granularity: string;
  qtyFcst: Prisma.Decimal | null;
  priceFcst: Prisma.Decimal | null;
  amountFcst: Prisma.Decimal | null;
};

function destinationKey(
  registrationId: string,
  period: string,
  granularity: 'week' | 'month'
) {
  if (granularity === 'month' && /^\d{4}-\d{2}$/.test(period)) {
    return `${registrationId}|${period}-01`;
  }
  return `${registrationId}|${period}`;
}

function existingRowKey(row: ExistingForecastRow) {
  const periodKey = formatForecastPeriodForApi(row.period, row.granularity);
  if (row.granularity === 'month') {
    return `${row.registrationId}|${periodKey}-01`;
  }
  return `${row.registrationId}|${periodKey}`;
}

function assertNoDuplicateDestinations(
  records: Array<{ matchedRegistrationId: string; period: string }>
) {
  const seen = new Set<string>();
  for (const record of records) {
    const key = `${record.matchedRegistrationId}|${record.period}`;
    if (seen.has(key)) {
      throw new ForecastImportConfirmError(
        400,
        `Import contains duplicate forecast destination ${key}.`
      );
    }
    seen.add(key);
  }
}

function assertRecordCount(records: unknown[]) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new ForecastImportConfirmError(
      400,
      'No importable forecast records were supplied.'
    );
  }
  if (records.length > MAX_IMPORT_RECORDS) {
    throw new ForecastImportConfirmError(413, 'Import contains too many records.');
  }
}

function normalizeChangedBy(changedBy: unknown) {
  return String(changedBy ?? 'sales-forecast-web').trim() || 'sales-forecast-web';
}

async function applyImportedSpreads(
  spreadByRegistrationId: Record<string, string> | undefined,
  changedBy: string,
) {
  if (!spreadByRegistrationId) return;
  const entries = Object.entries(spreadByRegistrationId);
  for (const [registrationId, spread] of entries) {
    await upsertRegistrationSpread(registrationId, spread, changedBy);
  }
}

async function applyImportedPricingPolicies(
  pricingPolicyByRegistrationId: Record<string, string> | undefined,
  changedBy: string,
) {
  if (!pricingPolicyByRegistrationId) return;
  const entries = Object.entries(pricingPolicyByRegistrationId);
  for (const [registrationId, pricingPolicy] of entries) {
    await upsertRegistrationPriceSettings(registrationId, {
      pricingPolicy,
      updatedBy: changedBy,
    });
  }
}

function registrationIdsWithLivePolicy(
  pricingPolicyByRegistrationId: Record<string, string> | undefined,
  spreadByRegistrationId: Record<string, string> | undefined,
) {
  const live = new Set<string>();
  for (const [registrationId, policy] of Object.entries(pricingPolicyByRegistrationId ?? {})) {
    if (normalizePricingPolicy(policy)) live.add(registrationId);
  }
  for (const [registrationId, spread] of Object.entries(spreadByRegistrationId ?? {})) {
    if (isCostPlus5Spread(spread)) live.add(registrationId);
  }
  return live;
}

function parseLegacyRecords(records: ConfirmLegacyImportRecord[]): ConfirmLegacyImportRecord[] {
  assertRecordCount(records);
  const parsed: ConfirmLegacyImportRecord[] = [];

  for (const value of records) {
    if (!value || typeof value !== 'object') {
      throw new ForecastImportConfirmError(400, 'Invalid import record.');
    }
    const record = value as Record<string, unknown>;
    const excelKeyForNoRegist = normalizeKey(record.excelKeyForNoRegist);
    const matchedRegistrationId = normalizeKey(record.matchedRegistrationId);
    const period = normalizeKey(record.period);
    const qtyFcst = Number(record.qtyFcst);
    const priceFcst = Number(record.priceFcst ?? 0);
    const amountFcst = Number(record.amountFcst ?? 0);
    if (
      !excelKeyForNoRegist ||
      !matchedRegistrationId ||
      !isFirstWednesdayPeriod(period) ||
      record.granularity !== 'week' ||
      !Number.isFinite(qtyFcst) ||
      qtyFcst < 0 ||
      !Number.isFinite(priceFcst) ||
      priceFcst < 0 ||
      !Number.isFinite(amountFcst) ||
      amountFcst < 0
    ) {
      throw new ForecastImportConfirmError(400, 'Import contains an invalid forecast record.');
    }
    parsed.push({
      excelKeyForNoRegist,
      matchedRegistrationId,
      period,
      granularity: 'week',
      qtyFcst,
      priceFcst,
      amountFcst,
    });
  }

  assertNoDuplicateDestinations(parsed);
  return parsed;
}

function parseVersionedRecords(
  records: ConfirmVersionedImportRecord[]
): ConfirmVersionedImportRecord[] {
  assertRecordCount(records);
  const parsed: ConfirmVersionedImportRecord[] = [];

  for (const value of records) {
    if (!value || typeof value !== 'object') {
      throw new ForecastImportConfirmError(400, 'Invalid import record.');
    }
    const record = value as Record<string, unknown>;
    const excelKeyForNoRegist = normalizeKey(record.excelKeyForNoRegist);
    const matchedRegistrationId = normalizeKey(record.matchedRegistrationId);
    const period = normalizeKey(record.period);
    const qtyFcst = Number(record.qtyFcst);
    const priceFcst = Number(record.priceFcst);
    const amountFcst = Number(record.amountFcst);
    if (
      !excelKeyForNoRegist ||
      !matchedRegistrationId ||
      !isFirstDayOfMonthPeriod(period) ||
      record.granularity !== 'month' ||
      !Number.isFinite(qtyFcst) ||
      qtyFcst < 0 ||
      !Number.isFinite(priceFcst) ||
      priceFcst < 0 ||
      !Number.isFinite(amountFcst) ||
      amountFcst < 0
    ) {
      throw new ForecastImportConfirmError(400, 'Import contains an invalid forecast record.');
    }
    parsed.push({
      excelKeyForNoRegist,
      matchedRegistrationId,
      period,
      granularity: 'month',
      qtyFcst,
      priceFcst,
      amountFcst,
    });
  }

  assertNoDuplicateDestinations(parsed);
  return parsed;
}

async function registrationStillExists(registrationId: string) {
  const id = registrationId.trim();
  if (!id) return false;
  const managed = await prisma.masterDataCrmRegistration.findFirst({
    where: { OR: [{ id }, { newKey: id }] },
    select: { id: true },
  });
  if (managed) return true;
  const snapshotVersion = await getActiveSnapshotVersion();
  if (snapshotVersion) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT TOP (1) r.registrationId AS id
      FROM dbo.crm_registration_snapshot r
      WHERE r.snapshotVersion = ${snapshotVersion}
        AND (r.registrationId = ${id} OR r.newKey = ${id})
    `;
    return rows.length > 0;
  }
  const crm = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT TOP (1) CAST(ISNULL(r.NewKey, r.KeyforNoCRM) AS NVARCHAR(200)) AS id
    FROM dbo.VW_CRM_RegistrationAll_1 r
    WHERE r.MainRegist = 1
      AND (CAST(r.NewKey AS NVARCHAR(200)) = ${id} OR CAST(r.KeyforNoCRM AS NVARCHAR(500)) = ${id})
  `;
  return crm.length > 0;
}

async function assertRegistrationMatchesUnchanged(
  records: Array<{ excelKeyForNoRegist: string; matchedRegistrationId: string }>
) {
  const uniqueRecords = [
    ...new Map(
      records.map(record => [
        `${record.excelKeyForNoRegist}|${record.matchedRegistrationId}`,
        record,
      ])
    ).values(),
  ];
  const registrationMatches = await findRegistrationMatches([
    ...new Set(uniqueRecords.map(record => record.excelKeyForNoRegist)),
  ]);

  for (const record of uniqueRecords) {
    const matches = registrationMatches.get(record.excelKeyForNoRegist) ?? [];
    if (matches.some(match => match.registrationId === record.matchedRegistrationId)) {
      continue;
    }
    // Auto-created rows may normalize plant (e.g. UBJ → 0), so Excel key no longer
    // exact-matches CRM/managed lookup — accept if the destination registration still exists.
    if (matches.length === 0 && await registrationStillExists(record.matchedRegistrationId)) {
      continue;
    }
    throw new ForecastImportConfirmError(
      409,
      `Registration matching changed for ${record.excelKeyForNoRegist}. Run Preview again.`,
      'REGISTRATION_MATCH_CHANGED'
    );
  }
}

async function loadExistingForecastRows(
  versionName: string,
  registrationIds: string[],
  periods: Date[]
): Promise<ExistingForecastRow[]> {
  if (registrationIds.length === 0 || periods.length === 0) return [];

  const rows: ExistingForecastRow[] = [];
  for (const idChunk of chunkArray(registrationIds, LOOKUP_CHUNK_SIZE)) {
    const chunkRows = await prisma.forecastValue.findMany({
      where: {
        versionName,
        registrationId: { in: idChunk },
        period: { in: periods },
      },
      select: {
        registrationId: true,
        period: true,
        granularity: true,
        qtyFcst: true,
        priceFcst: true,
        amountFcst: true,
      },
    });
    rows.push(...chunkRows);
  }
  return rows;
}

function buildExistingMaps(rows: ExistingForecastRow[]) {
  const existingKeys = new Set(rows.map(existingRowKey));
  const existingMap = new Map(rows.map(row => [existingRowKey(row), row]));
  return { existingKeys, existingMap };
}

function qtyPriceOrAmountChanged(
  existing: ExistingForecastRow | undefined,
  qtyFcst: number,
  priceFcst: number,
  amountFcst: number,
  hasPriceColumns = true,
  hasAmountColumns = true
) {
  if (!existing) return true;
  if (Math.abs(Number(existing.qtyFcst ?? 0) - qtyFcst) > VALUE_EPSILON) return true;
  if (hasPriceColumns && Math.abs(Number(existing.priceFcst ?? 0) - priceFcst) > VALUE_EPSILON) return true;
  if (hasAmountColumns && Math.abs(Number(existing.amountFcst ?? 0) - amountFcst) > VALUE_EPSILON) return true;
  return false;
}

function buildImportResult(
  records: Array<{ matchedRegistrationId: string; period: string }>,
  existingKeys: Set<string>,
  version: string,
  granularity: 'week' | 'month'
): ForecastImportConfirmResult {
  const overwritten = records.filter(record =>
    existingKeys.has(destinationKey(record.matchedRegistrationId, record.period, granularity))
  ).length;
  return {
    ok: true,
    imported: records.length,
    created: records.length - overwritten,
    overwritten,
    version,
    registrationsCreated: 0,
    createdRegistrationIds: [],
  };
}

export async function confirmLegacyImport(
  records: ConfirmLegacyImportRecord[],
  changedBy: string,
  stampPeriod: unknown,
  columnFlags: ImportColumnFlags = LEGACY_IMPORT_COLUMN_FLAGS,
): Promise<ForecastImportConfirmResult> {
  const parsedRecords = parseLegacyRecords(records);
  const normalizedChangedBy = normalizeChangedBy(changedBy);
  const normalizedStampPeriod = normalizeStampPeriod(stampPeriod);

  await assertRegistrationMatchesUnchanged(parsedRecords);

  const registrationIds = [...new Set(parsedRecords.map(record => record.matchedRegistrationId))];
  const periods = [
    ...new Set(parsedRecords.map(record => parseForecastPeriodToDate(record.period, 'week'))),
  ];
  const existingRows = await loadExistingForecastRows(
    CURRENT_FORECAST_VERSION,
    registrationIds,
    periods
  );
  const { existingKeys, existingMap } = buildExistingMaps(existingRows);

  const changedRecords = parsedRecords.filter(record => {
    const key = destinationKey(record.matchedRegistrationId, record.period, 'week');
    return qtyPriceOrAmountChanged(
      existingMap.get(key),
      record.qtyFcst,
      record.priceFcst,
      record.amountFcst,
      columnFlags.hasPriceColumns,
      columnFlags.hasAmountColumns
    );
  });
  const changedKeys = new Set(
    changedRecords.map(record =>
      destinationKey(record.matchedRegistrationId, record.period, 'week')
    )
  );

  const mergePayload = JSON.stringify(
    parsedRecords.map(record => ({
      registrationId: record.matchedRegistrationId,
      period: record.period,
      qtyFcst: record.qtyFcst,
      priceFcst: record.priceFcst,
      amountFcst: record.amountFcst,
      changed: changedKeys.has(
        destinationKey(record.matchedRegistrationId, record.period, 'week')
      )
        ? 1
        : 0,
    }))
  );

  const updatePrice = columnFlags.hasPriceColumns ? 1 : 0;
  const updateAmount = columnFlags.hasAmountColumns ? 1 : 0;

  await prisma.$transaction(async transaction => {
    await transaction.forecastVersion.upsert({
      where: { name: CURRENT_FORECAST_VERSION },
      create: { name: CURRENT_FORECAST_VERSION, versionKey: 1, isStandard: true },
      update: { versionKey: 1, isStandard: true },
    });
    const batch = await transaction.forecastCommitBatch.create({
      data: {
        source: 'excel_import',
        changedBy: normalizedChangedBy,
        stampPeriod: normalizedStampPeriod,
        recordCount: changedRecords.length,
      },
    });
    await transaction.$executeRaw`
      MERGE [dbo].[forecast_values] WITH (HOLDLOCK) AS target
      USING (
        SELECT registrationId, period, qtyFcst, priceFcst, amountFcst, changed
        FROM OPENJSON(${mergePayload})
        WITH (
          registrationId NVARCHAR(200) '$.registrationId',
          period DATE '$.period',
          qtyFcst DECIMAL(18,4) '$.qtyFcst',
          priceFcst DECIMAL(18,4) '$.priceFcst',
          amountFcst DECIMAL(18,4) '$.amountFcst',
          changed INT '$.changed'
        )
      ) AS source
      ON target.registrationId = source.registrationId
        AND target.versionName = ${CURRENT_FORECAST_VERSION}
        AND target.period = source.period
        AND target.granularity = 'week'
      WHEN MATCHED THEN
        UPDATE SET
          target.qtyFcst = source.qtyFcst,
          target.priceFcst = CASE WHEN ${updatePrice} = 1 THEN source.priceFcst ELSE target.priceFcst END,
          target.amountFcst = CASE WHEN ${updateAmount} = 1 THEN source.amountFcst ELSE target.amountFcst END,
          target.lastBatchId = CASE
            WHEN source.changed = 1 THEN ${batch.id}
            ELSE target.lastBatchId
          END,
          target.updatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (
          registrationId, versionName, period, granularity,
          qtyFcst, priceFcst, amountFcst, lastBatchId, updatedAt
        )
        VALUES (
          source.registrationId, ${CURRENT_FORECAST_VERSION}, source.period, 'week',
          source.qtyFcst, source.priceFcst, source.amountFcst, ${batch.id}, SYSUTCDATETIME()
        );
    `;
    if (parsedRecords.length > 0) {
      await transaction.forecastChangeLog.createMany({
        data: parsedRecords.map(record => {
          const existing = existingMap.get(
            destinationKey(record.matchedRegistrationId, record.period, 'week')
          );
          return {
            batchId: batch.id,
            registrationId: record.matchedRegistrationId,
            versionName: CURRENT_FORECAST_VERSION,
            period: parseForecastPeriodToDate(record.period, 'week'),
            granularity: 'week',
            oldQtyFcst: existing?.qtyFcst ?? null,
            newQtyFcst: record.qtyFcst,
            oldPriceFcst: existing?.priceFcst ?? null,
            newPriceFcst: columnFlags.hasPriceColumns
              ? record.priceFcst
              : (existing?.priceFcst ?? 0),
            oldAmountFcst: existing?.amountFcst ?? null,
            newAmountFcst: columnFlags.hasAmountColumns
              ? record.amountFcst
              : (existing?.amountFcst ?? 0),
          };
        }),
      });
    }

    if (columnFlags.hasPriceColumns) {
      const livePolicyIds = registrationIdsWithLivePolicy(
        columnFlags.pricingPolicyByRegistrationId,
        columnFlags.spreadByRegistrationId,
      );
      const registrationIdsWithFixedPrice = [
        ...new Set(
          parsedRecords
            .filter(record => record.priceFcst > 0 && !livePolicyIds.has(record.matchedRegistrationId))
            .map(record => record.matchedRegistrationId)
        ),
      ];
      if (registrationIdsWithFixedPrice.length > 0) {
        await transaction.masterDataCrmRegistration.updateMany({
          where: { id: { in: registrationIdsWithFixedPrice } },
          data: { priceFormula: 'Fixed Price' },
        });
      }
    }
  }, { timeout: 120_000 });

  await applyImportedSpreads(columnFlags.spreadByRegistrationId, normalizedChangedBy);
  await applyImportedPricingPolicies(columnFlags.pricingPolicyByRegistrationId, normalizedChangedBy);

  clearForecastSummaryCache();
  return buildImportResult(parsedRecords, existingKeys, CURRENT_FORECAST_VERSION, 'week');
}

export async function confirmVersionedImport(
  records: ConfirmVersionedImportRecord[],
  targetVersion: string,
  changedBy: string,
  stampPeriod: unknown,
  columnFlags: ImportColumnFlags = VERSIONED_IMPORT_COLUMN_FLAGS,
): Promise<ForecastImportConfirmResult> {
  const parsedRecords = parseVersionedRecords(records);
  const versionName = normalizeKey(targetVersion);
  if (!versionName) {
    throw new ForecastImportConfirmError(400, 'Target forecast version is required.');
  }
  if (versionName === CURRENT_FORECAST_VERSION) {
    throw new ForecastImportConfirmError(
      400,
      'Versioned import cannot target Current Forecast. Use the legacy import flow instead.'
    );
  }

  const normalizedChangedBy = normalizeChangedBy(changedBy);
  const normalizedStampPeriod = normalizeStampPeriod(stampPeriod);

  const version = await prisma.forecastVersion.findUnique({
    where: { name: versionName },
    select: { name: true },
  });
  if (!version) {
    throw new ForecastImportConfirmError(
      409,
      `Forecast version "${versionName}" was not found.`,
      'VERSION_NOT_FOUND'
    );
  }

  await assertRegistrationMatchesUnchanged(parsedRecords);

  const registrationIds = [...new Set(parsedRecords.map(record => record.matchedRegistrationId))];
  const periods = [
    ...new Set(parsedRecords.map(record => parseForecastPeriodToDate(record.period, 'month'))),
  ];
  const existingRows = await loadExistingForecastRows(versionName, registrationIds, periods);
  const { existingKeys, existingMap } = buildExistingMaps(existingRows);

  const changedRecords = parsedRecords.filter(record => {
    const key = destinationKey(record.matchedRegistrationId, record.period, 'month');
    return qtyPriceOrAmountChanged(
      existingMap.get(key),
      record.qtyFcst,
      record.priceFcst,
      record.amountFcst,
      columnFlags.hasPriceColumns,
      columnFlags.hasAmountColumns
    );
  });
  const changedKeys = new Set(
    changedRecords.map(record =>
      destinationKey(record.matchedRegistrationId, record.period, 'month')
    )
  );

  const mergePayload = JSON.stringify(
    parsedRecords.map(record => ({
      registrationId: record.matchedRegistrationId,
      period: record.period,
      qtyFcst: record.qtyFcst,
      priceFcst: record.priceFcst,
      amountFcst: record.amountFcst,
      changed: changedKeys.has(
        destinationKey(record.matchedRegistrationId, record.period, 'month')
      )
        ? 1
        : 0,
    }))
  );

  const updatePrice = columnFlags.hasPriceColumns ? 1 : 0;
  const updateAmount = columnFlags.hasAmountColumns ? 1 : 0;

  await prisma.$transaction(async transaction => {
    const batch = await transaction.forecastCommitBatch.create({
      data: {
        source: 'excel_import_versioned',
        changedBy: normalizedChangedBy,
        stampPeriod: normalizedStampPeriod,
        recordCount: changedRecords.length,
      },
    });
    await transaction.$executeRaw`
      MERGE [dbo].[forecast_values] WITH (HOLDLOCK) AS target
      USING (
        SELECT registrationId, period, qtyFcst, priceFcst, amountFcst, changed
        FROM OPENJSON(${mergePayload})
        WITH (
          registrationId NVARCHAR(200) '$.registrationId',
          period DATE '$.period',
          qtyFcst DECIMAL(18,4) '$.qtyFcst',
          priceFcst DECIMAL(18,4) '$.priceFcst',
          amountFcst DECIMAL(18,4) '$.amountFcst',
          changed INT '$.changed'
        )
      ) AS source
      ON target.registrationId = source.registrationId
        AND target.versionName = ${versionName}
        AND target.period = source.period
        AND target.granularity = 'month'
      WHEN MATCHED THEN
        UPDATE SET
          target.qtyFcst = source.qtyFcst,
          target.priceFcst = CASE WHEN ${updatePrice} = 1 THEN source.priceFcst ELSE target.priceFcst END,
          target.amountFcst = CASE WHEN ${updateAmount} = 1 THEN source.amountFcst ELSE target.amountFcst END,
          target.lastBatchId = CASE
            WHEN source.changed = 1 THEN ${batch.id}
            ELSE target.lastBatchId
          END,
          target.updatedAt = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (
          registrationId, versionName, period, granularity,
          qtyFcst, priceFcst, amountFcst, lastBatchId, updatedAt
        )
        VALUES (
          source.registrationId, ${versionName}, source.period, 'month',
          source.qtyFcst, source.priceFcst, source.amountFcst, ${batch.id}, SYSUTCDATETIME()
        );
    `;
    if (parsedRecords.length > 0) {
      await transaction.forecastChangeLog.createMany({
        data: parsedRecords.map(record => {
          const existing = existingMap.get(
            destinationKey(record.matchedRegistrationId, record.period, 'month')
          );
          return {
            batchId: batch.id,
            registrationId: record.matchedRegistrationId,
            versionName,
            period: parseForecastPeriodToDate(record.period, 'month'),
            granularity: 'month',
            oldQtyFcst: existing?.qtyFcst ?? null,
            newQtyFcst: record.qtyFcst,
            oldPriceFcst: existing?.priceFcst ?? null,
            newPriceFcst: columnFlags.hasPriceColumns
              ? record.priceFcst
              : (existing?.priceFcst ?? 0),
            oldAmountFcst: existing?.amountFcst ?? null,
            newAmountFcst: columnFlags.hasAmountColumns
              ? record.amountFcst
              : (existing?.amountFcst ?? 0),
          };
        }),
      });
    }

    if (columnFlags.hasPriceColumns) {
      const livePolicyIds = registrationIdsWithLivePolicy(
        columnFlags.pricingPolicyByRegistrationId,
        columnFlags.spreadByRegistrationId,
      );
      const registrationIdsWithFixedPrice = [
        ...new Set(
          parsedRecords
            .filter(record => record.priceFcst > 0 && !livePolicyIds.has(record.matchedRegistrationId))
            .map(record => record.matchedRegistrationId)
        ),
      ];
      if (registrationIdsWithFixedPrice.length > 0) {
        await transaction.masterDataCrmRegistration.updateMany({
          where: { id: { in: registrationIdsWithFixedPrice } },
          data: { priceFormula: 'Fixed Price' },
        });
      }
    }
  }, { timeout: 120_000 });

  await applyImportedSpreads(columnFlags.spreadByRegistrationId, normalizedChangedBy);
  await applyImportedPricingPolicies(columnFlags.pricingPolicyByRegistrationId, normalizedChangedBy);

  clearForecastSummaryCache();
  return buildImportResult(parsedRecords, existingKeys, versionName, 'month');
}
