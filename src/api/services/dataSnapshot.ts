import { randomUUID } from 'node:crypto';
import prisma from '../../db/prisma';
import { crmBusinessUnitSelectRaw } from './businessUnit';

const SNAPSHOT_SOURCE = 'crm_actual';
export const SNAPSHOT_REFRESH_MS = 5 * 60 * 1000;
export const USE_LOCAL_SNAPSHOT = process.env.USE_LOCAL_SNAPSHOT !== 'false';

let refreshPromise: Promise<SnapshotStatus> | null = null;

export interface SnapshotStatus {
  enabled: boolean;
  activeVersion: string | null;
  status: string;
  startedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  rowCount: number;
}

function jsonValue(value: unknown) {
  return JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? Number(item) : item
  );
}

export async function getSnapshotStatus(): Promise<SnapshotStatus> {
  if (!USE_LOCAL_SNAPSHOT) {
    return {
      enabled: false,
      activeVersion: null,
      status: 'disabled',
      startedAt: null,
      completedAt: null,
      lastError: null,
      rowCount: 0,
    };
  }
  const state = await prisma.dataSnapshotState.findUnique({
    where: { source: SNAPSHOT_SOURCE },
  });
  return {
    enabled: true,
    activeVersion: state?.activeVersion ?? null,
    status: state?.status ?? 'empty',
    startedAt: state?.startedAt ?? null,
    completedAt: state?.completedAt ?? null,
    lastError: state?.lastError ?? null,
    rowCount: state?.rowCount ?? 0,
  };
}

export async function getActiveSnapshotVersion() {
  if (!USE_LOCAL_SNAPSHOT) return null;
  const state = await prisma.dataSnapshotState.findUnique({
    where: { source: SNAPSHOT_SOURCE },
    select: { activeVersion: true },
  });
  return state?.activeVersion ?? null;
}

async function fetchRegistrationRows() {
  const businessUnitSelect = await crmBusinessUnitSelectRaw('businessUnit');
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT
      CAST(r.NewKey AS NVARCHAR(1000)) AS newKey,
      CAST(r.NewKey AS NVARCHAR(200)) AS registrationId,
      CAST(r.KeyforNoCRM AS NVARCHAR(500)) AS keyForNoCRM,
      r.OwnerName AS ownerName,
      r.RegistrationTopic AS registrationTopic,
      r.OnOffSpec AS onOffSpec,
      r.PlantCode AS plantCode,
      r.CountryName AS countryName,
      r.MaterialDescription AS materialDescription,
      r.MaterialCode AS materialCode,
      r.ShipTo_name AS shipToName,
      r.SoldTo_name AS soldToName,
      r.End_user AS endUser,
      r.SoldToCode AS soldToCode,
      r.ShipToCode AS shipToCode,
      r.[Group] AS groupName,
      r.MaterialNameOnCoa AS materialNameOnCoa,
      r.AdditionalRequirement AS additionalRequirement,
      r.Pic AS pic,
      CONVERT(NVARCHAR(50), r.Commission) AS commission,
      r.ProductDescription AS productDescription,
      r.Classified AS classified,
      CONVERT(NVARCHAR(50), r.CommissionIndirect) AS commissionIndirect,
      CONVERT(NVARCHAR(50), r.CommissionFinancialDiscount) AS commissionFinancialDiscount,
      r.NewCoaName AS newCoaName,
      r.NewTier1 AS newTier1,
      r.NewOem AS newOem,
      r.Packing AS packing,
      r.AgreedSpecType AS agreedSpecType,
      r.WasteScrap AS wasteScrap,
      r.ForResaleNotApprove AS forResaleNotApprove,
      CONVERT(NVARCHAR(100), r.ImdsDate, 120) AS imdsDate,
      r.Model AS model,
      CONVERT(NVARCHAR(30), r.CreatedOn, 120) AS createdOn,
      r.Approve AS approve,
      r.PartName AS partName,
      r.CoaName AS coaName,
      ISNULL(r.Cat1Name, '') AS process,
      ISNULL(r.Cat2Name, '') AS application,
      ISNULL(r.Cat3Name, '') AS subApp,
      r.ZoneName AS zoneName,
      r.PlantName AS plantName,
      r.CountryCode AS countryCode,
      r.EndUserCode AS endUserCode,
      r.EndUserExportControl AS endUserExportControl,
      r.EndUserName AS endUserName,
      r.ProductName AS productName,
      ${businessUnitSelect}
    FROM dbo.VW_CRM_RegistrationAll_1 r
    WHERE r.NewKey IS NOT NULL AND r.MainRegist = 1
  `);
}

async function fetchActualRows() {
  return prisma.$queryRawUnsafe<Record<string, unknown>[]>(`
    SELECT
      CAST(a.[Key for regist] AS NVARCHAR(500)) AS keyForRegist,
      CAST(a.[Key for no regist] AS NVARCHAR(500)) AS keyForNoRegist,
      a.Deliverydate AS deliveryDate,
      a.CarryIn_ETD AS carryInETD,
      a.CarryOut_ETD AS carryOutETD,
      a.CarryIn_Loading AS carryInLoading,
      a.CarryOut_Loading AS carryOutLoading,
      CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18,4)) AS qty,
      CAST(ISNULL(a.[Unit Price USD Ton(new)], 0) AS DECIMAL(18,4)) AS price,
      CAST(ISNULL(a.[Net Amount USD (new)], 0) AS DECIMAL(18,4)) AS amount,
      CAST(a.[Ship-to Country ] AS NVARCHAR(500)) AS country,
      CAST(a.[Sold-to pt ] AS NVARCHAR(500)) AS soldTo,
      CAST(a.[Ship-to pt ] AS NVARCHAR(500)) AS shipTo,
      CAST(a.Enduser AS NVARCHAR(500)) AS endUser,
      CAST(a.Plant AS NVARCHAR(500)) AS plant,
      CAST(a.Material AS NVARCHAR(500)) AS materialCode
    FROM dbo.MKT_SALEReport_ZSDR001_UGT_CRM_NYL_1 a
    WHERE a.[Key for no regist] IS NOT NULL
  `);
}

async function performRefresh() {
  const version = randomUUID();
  const startedAt = new Date();
  const staleBefore = new Date(startedAt.getTime() - 10 * 60 * 1000);
  await prisma.dataSnapshotState.upsert({
    where: { source: SNAPSHOT_SOURCE },
    create: {
      source: SNAPSHOT_SOURCE,
      status: 'idle',
    },
    update: {},
  });
  const lock = await prisma.dataSnapshotState.updateMany({
    where: {
      source: SNAPSHOT_SOURCE,
      OR: [
        { status: { not: 'syncing' } },
        { startedAt: null },
        { startedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: 'syncing',
      startedAt,
      lastError: null,
    },
  });
  if (lock.count === 0) return getSnapshotStatus();

  try {
    const [registrations, actuals] = await Promise.all([
      fetchRegistrationRows(),
      fetchActualRows(),
    ]);
    const registrationJson = jsonValue(registrations);
    const actualJson = jsonValue(actuals);

    await prisma.$transaction(async transaction => {
      await transaction.$executeRaw`
        INSERT INTO dbo.crm_registration_snapshot (
          snapshotVersion, registrationId, newKey, keyForNoCRM, ownerName,
          registrationTopic, onOffSpec, plantCode, countryName, materialDescription,
          materialCode, shipToName, soldToName, endUser, soldToCode, shipToCode,
          groupName, materialNameOnCoa, additionalRequirement, pic, commission,
          productDescription, classified, commissionIndirect, commissionFinancialDiscount,
          newCoaName, newTier1, newOem, packing, agreedSpecType, wasteScrap,
          forResaleNotApprove, imdsDate, model, createdOn, approve, partName, coaName,
          process, application, subApp, zoneName, plantName, countryCode, endUserCode,
          endUserExportControl, endUserName, productName, businessUnit
        )
        SELECT
          ${version}, registrationId, newKey, keyForNoCRM, ownerName,
          registrationTopic, onOffSpec, plantCode, countryName, materialDescription,
          materialCode, shipToName, soldToName, endUser, soldToCode, shipToCode,
          groupName, materialNameOnCoa, additionalRequirement, pic, commission,
          productDescription, classified, commissionIndirect, commissionFinancialDiscount,
          newCoaName, newTier1, newOem, packing, agreedSpecType, wasteScrap,
          forResaleNotApprove, imdsDate, model, createdOn, approve, partName, coaName,
          process, application, subApp, zoneName, plantName, countryCode, endUserCode,
          endUserExportControl, endUserName, productName, businessUnit
        FROM OPENJSON(${registrationJson})
        WITH (
          registrationId NVARCHAR(200), newKey NVARCHAR(1000), keyForNoCRM NVARCHAR(500),
          ownerName NVARCHAR(500), registrationTopic NVARCHAR(500), onOffSpec NVARCHAR(100),
          plantCode NVARCHAR(100), countryName NVARCHAR(500), materialDescription NVARCHAR(1000),
          materialCode NVARCHAR(100), shipToName NVARCHAR(500), soldToName NVARCHAR(500),
          endUser NVARCHAR(500), soldToCode NVARCHAR(100), shipToCode NVARCHAR(100),
          groupName NVARCHAR(500), materialNameOnCoa NVARCHAR(500),
          additionalRequirement NVARCHAR(1000), pic NVARCHAR(500), commission NVARCHAR(50),
          productDescription NVARCHAR(1000), classified NVARCHAR(500),
          commissionIndirect NVARCHAR(50), commissionFinancialDiscount NVARCHAR(50),
          newCoaName NVARCHAR(500), newTier1 NVARCHAR(500), newOem NVARCHAR(500),
          packing NVARCHAR(500), agreedSpecType NVARCHAR(500), wasteScrap NVARCHAR(500),
          forResaleNotApprove NVARCHAR(500), imdsDate NVARCHAR(100), model NVARCHAR(500),
          createdOn NVARCHAR(30), approve NVARCHAR(500), partName NVARCHAR(500),
          coaName NVARCHAR(500), process NVARCHAR(500), application NVARCHAR(500),
          subApp NVARCHAR(500), zoneName NVARCHAR(500), plantName NVARCHAR(500),
          countryCode NVARCHAR(100), endUserCode NVARCHAR(100),
          endUserExportControl NVARCHAR(500), endUserName NVARCHAR(500),
          productName NVARCHAR(500), businessUnit NVARCHAR(50)
        )
      `;
      await transaction.$executeRaw`
        INSERT INTO dbo.actual_sales_snapshot (
          snapshotVersion, keyForRegist, keyForNoRegist, deliveryDate,
          carryInETD, carryOutETD, carryInLoading, carryOutLoading,
          qty, price, amount, country, soldTo, shipTo, endUser, plant, materialCode
        )
        SELECT
          ${version}, keyForRegist, keyForNoRegist, deliveryDate,
          carryInETD, carryOutETD, carryInLoading, carryOutLoading,
          qty, price, amount, country, soldTo, shipTo, endUser, plant, materialCode
        FROM OPENJSON(${actualJson})
        WITH (
          keyForRegist NVARCHAR(500), keyForNoRegist NVARCHAR(500),
          deliveryDate DATETIME2, carryInETD DATETIME2, carryOutETD DATETIME2,
          carryInLoading DATETIME2, carryOutLoading DATETIME2,
          qty DECIMAL(18,4), price DECIMAL(18,4), amount DECIMAL(18,4),
          country NVARCHAR(500), soldTo NVARCHAR(500), shipTo NVARCHAR(500),
          endUser NVARCHAR(500), plant NVARCHAR(500), materialCode NVARCHAR(500)
        )
      `;
      await transaction.dataSnapshotState.update({
        where: { source: SNAPSHOT_SOURCE },
        data: {
          activeVersion: version,
          status: 'ready',
          completedAt: new Date(),
          lastError: null,
          rowCount: registrations.length + actuals.length,
        },
      });
      await transaction.$executeRaw`
        DELETE FROM dbo.crm_registration_snapshot WHERE snapshotVersion <> ${version}
      `;
      await transaction.$executeRaw`
        DELETE FROM dbo.actual_sales_snapshot WHERE snapshotVersion <> ${version}
      `;
    }, { timeout: 120_000 });
    const [{ clearActualCaches }, { clearForecastSummaryCache }] = await Promise.all([
      import('../routes/actuals'),
      import('../routes/forecast'),
    ]);
    clearActualCaches();
    clearForecastSummaryCache();
    // Keep FactForecast ↔ DimRegistration joins consistent (Power BI): re-point
    // forecast rows whose registration key disappeared from DimRegistration
    // (e.g. CRM topic rename / MainRegist moved to another row).
    const { reconcileForecastRegistrationKeys } = await import('./registrationKeyReconcile');
    reconcileForecastRegistrationKeys().catch(reconcileError => {
      console.error('[registration-reconcile] failed:', reconcileError);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.dataSnapshotState.update({
      where: { source: SNAPSHOT_SOURCE },
      data: { status: 'failed', lastError: message.slice(0, 2000) },
    }).catch(updateError => {
      console.error('[snapshot] failed to persist refresh error:', updateError);
    });
    throw error;
  }
  return getSnapshotStatus();
}

export function triggerSnapshotRefresh() {
  if (!USE_LOCAL_SNAPSHOT) return getSnapshotStatus();
  if (!refreshPromise) {
    refreshPromise = performRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export async function ensureSnapshotRefresh() {
  if (!USE_LOCAL_SNAPSHOT) return;
  const status = await getSnapshotStatus();
  if (
    !status.completedAt ||
    Date.now() - status.completedAt.getTime() >= SNAPSHOT_REFRESH_MS
  ) {
    triggerSnapshotRefresh().catch(error => {
      console.error('[snapshot] background refresh failed:', error);
    });
  }
}

export function startSnapshotScheduler() {
  if (!USE_LOCAL_SNAPSHOT) return;
  ensureSnapshotRefresh().catch(error => {
    console.error('[snapshot] startup refresh check failed:', error);
  });
  const timer = setInterval(() => {
    ensureSnapshotRefresh().catch(error => {
      console.error('[snapshot] scheduled refresh check failed:', error);
    });
  }, 30_000);
  timer.unref();
}
