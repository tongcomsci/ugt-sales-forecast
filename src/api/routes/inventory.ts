import { Prisma } from '@prisma/client';
import { Router } from 'express';
import {
  buildAppModeRegistrationScopeSql,
  filterRegistrationIdsInAppMode,
  getAppMode,
} from '../../config/appMode';
import prisma from '../../db/prisma';
import { getRegistrationSourceSql } from './registrations';
import { pruneCache } from '../services/boundedCache';

const router = Router();
const CACHE_TTL_MS = 5 * 60 * 1000;
const QUERY_CACHE_TTL_MS = 60 * 1000;
const MAX_INVENTORY_QUERY_CACHE_ENTRIES = 32;
function resolveInventoryViewName() {
  // Read over the linked server on the main connection, same as
  // HR_EMPLOYEE_VIEW / CUSTOMER_MASTER_VIEW.
  const name = process.env.INVENTORY_VIEW_NAME ?? 'thrygsd002.UBE_DW.dbo.MKT_NYL_Current_INV';
  // This value is interpolated straight into SQL, so accept only 2-4 dotted
  // parts, each a bare or bracketed identifier.
  if (!/^(\[[\w ]+\]|\w+)(\.(\[[\w ]+\]|\w+)){1,3}$/.test(name)) {
    throw new Error(
      `INVENTORY_VIEW_NAME must be a [server.][database.]schema.view identifier, got: ${name}`
    );
  }
  return name;
}

const INVENTORY_VIEW = Prisma.raw(resolveInventoryViewName());

interface InventoryApiRow {
  registrationId: string;
  ownerName: string;
  registrationTopic: string;
  plantCode: string;
  materialCode: string;
  materialDescription: string;
  inventoryMaterialDescription: string;
  a0Qty: number;
  nonA0Qty: number;
  waitJudgeQty: number;
  ogQty: number;
  yoQty: number;
  totalQty: number;
  inventoryDate: string | null;
}

const inventoryQueryCache = new Map<
  string,
  { expiresAt: number; promise: Promise<InventoryApiRow[]> }
>();

function inventoryQueryCacheKey(registrationIds: string[]) {
  return `${getAppMode()}|${registrationIds.slice().sort().join('|')}`;
}

function normalizeQuantity(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRegistrationIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map(item => String(item ?? '').trim())
      .filter(Boolean)
      .slice(0, 200)
  ));
}

function mapInventoryRow(
  row: Record<string, unknown>,
  inventory?: Record<string, unknown>
): InventoryApiRow {
  const plantCode = String(row.plantCode ?? row.PlantCode ?? '').trim();
  const materialCode = String(row.materialCode ?? row.MaterialCode ?? '').trim();
  return {
    registrationId: String(row.registrationId ?? row.RegistrationId ?? ''),
    ownerName: String(row.ownerName ?? row.OwnerName ?? ''),
    registrationTopic: String(row.registrationTopic ?? row.RegistrationTopic ?? ''),
    plantCode,
    materialCode,
    materialDescription: String(row.materialDescription ?? row.MaterialDescription ?? ''),
    inventoryMaterialDescription: String(inventory?.inventoryMaterialDescription ?? ''),
    a0Qty: normalizeQuantity(inventory?.a0Qty),
    nonA0Qty: normalizeQuantity(inventory?.nonA0Qty),
    waitJudgeQty: normalizeQuantity(inventory?.waitJudgeQty),
    ogQty: normalizeQuantity(inventory?.ogQty),
    yoQty: normalizeQuantity(inventory?.yoQty),
    totalQty: normalizeQuantity(inventory?.totalQty),
    inventoryDate: inventory?.inventoryDate ? String(inventory.inventoryDate) : null,
  };
}

async function loadInventoryRows() {
  const registrationSource = await getRegistrationSourceSql();
  const inventoryRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH latest_inventory_date AS (
      SELECT MAX(CAST(inv.[Date] AS DATE)) AS inventoryDate
      FROM ${INVENTORY_VIEW} inv
    ),
    inventory_grouped AS (
      SELECT
        LTRIM(RTRIM(CAST(inv.Plant AS NVARCHAR(100)))) AS plantCode,
        LTRIM(RTRIM(CAST(inv.Material AS NVARCHAR(100)))) AS materialCode,
        MAX(LTRIM(RTRIM(CAST(inv.[Mat Description] AS NVARCHAR(500))))) AS inventoryMaterialDescription,
        LTRIM(RTRIM(CAST(inv.QA_Group AS NVARCHAR(50)))) AS qaGroup,
        SUM(ISNULL(TRY_CONVERT(DECIMAL(18, 4), inv.QTY), 0)) AS qty
      FROM ${INVENTORY_VIEW} inv
      CROSS JOIN latest_inventory_date latest
      WHERE latest.inventoryDate IS NOT NULL
        AND CAST(inv.[Date] AS DATE) = latest.inventoryDate
      GROUP BY
        LTRIM(RTRIM(CAST(inv.Plant AS NVARCHAR(100)))),
        LTRIM(RTRIM(CAST(inv.Material AS NVARCHAR(100)))),
        LTRIM(RTRIM(CAST(inv.QA_Group AS NVARCHAR(50))))
    )
    SELECT
      plantCode,
      materialCode,
      MAX(inventoryMaterialDescription) AS inventoryMaterialDescription,
      SUM(CASE WHEN qaGroup = 'A0' THEN qty ELSE 0 END) AS a0Qty,
      SUM(CASE WHEN qaGroup = 'NonA0' THEN qty ELSE 0 END) AS nonA0Qty,
      SUM(CASE WHEN qaGroup = 'WaitJudge' THEN qty ELSE 0 END) AS waitJudgeQty,
      SUM(CASE WHEN qaGroup = 'OG' THEN qty ELSE 0 END) AS ogQty,
      SUM(CASE WHEN qaGroup = 'YO' THEN qty ELSE 0 END) AS yoQty,
      SUM(qty) AS totalQty,
      CONVERT(CHAR(10), MAX(latest.inventoryDate), 126) AS inventoryDate
    FROM inventory_grouped
    CROSS JOIN latest_inventory_date latest
    GROUP BY plantCode, materialCode
  `;
  const inventoryByKey = new Map(
    inventoryRows.map(row => [
      `${String(row.plantCode ?? '').trim()}|${String(row.materialCode ?? '').trim()}`,
      row,
    ])
  );

  const modeScopeSql = buildAppModeRegistrationScopeSql('r');
  const rows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH registration_source AS (${registrationSource})
    SELECT
      r.RegistrationId AS registrationId,
      r.OwnerName AS ownerName,
      r.RegistrationTopic AS registrationTopic,
      r.PlantCode AS plantCode,
      r.MaterialCode AS materialCode,
      r.MaterialDescription AS materialDescription
    FROM registration_source r
    WHERE r.RegistrationId IS NOT NULL
      ${modeScopeSql}
    ORDER BY r.OwnerName, r.RegistrationTopic, r.PlantCode, r.MaterialCode
  `;

  return rows.map(row => {
    const plantCode = String(row.plantCode ?? '').trim();
    const materialCode = String(row.materialCode ?? '').trim();
    return mapInventoryRow(row, inventoryByKey.get(`${plantCode}|${materialCode}`));
  });
}

async function loadInventoryRowsForRegistrationIds(registrationIds: string[]) {
  if (registrationIds.length === 0) return [];
  const allowedIds = await filterRegistrationIdsInAppMode(registrationIds);
  if (allowedIds.length === 0) return [];

  const registrationSource = await getRegistrationSourceSql();
  const modeScopeSql = buildAppModeRegistrationScopeSql('r');
  const registrations = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH registration_source AS (${registrationSource})
    SELECT
      r.RegistrationId AS registrationId,
      r.OwnerName AS ownerName,
      r.RegistrationTopic AS registrationTopic,
      r.PlantCode AS plantCode,
      r.MaterialCode AS materialCode,
      r.MaterialDescription AS materialDescription
    FROM registration_source r
    WHERE r.RegistrationId IN (${Prisma.join(allowedIds)})
      ${modeScopeSql}
  `;
  if (registrations.length === 0) return [];

  const plantCodes = Array.from(new Set(
    registrations.map(row => String(row.plantCode ?? '').trim()).filter(Boolean)
  ));
  const materialCodes = Array.from(new Set(
    registrations.map(row => String(row.materialCode ?? '').trim()).filter(Boolean)
  ));
  if (plantCodes.length === 0 || materialCodes.length === 0) {
    return registrations.map(row => mapInventoryRow(row));
  }

  const inventoryRows = await prisma.$queryRaw<Array<Record<string, unknown>>>`
    WITH latest_inventory_date AS (
      SELECT MAX(CAST(inv.[Date] AS DATE)) AS inventoryDate
      FROM ${INVENTORY_VIEW} inv
    ),
    inventory_grouped AS (
      SELECT
        LTRIM(RTRIM(CAST(inv.Plant AS NVARCHAR(100)))) AS plantCode,
        LTRIM(RTRIM(CAST(inv.Material AS NVARCHAR(100)))) AS materialCode,
        MAX(LTRIM(RTRIM(CAST(inv.[Mat Description] AS NVARCHAR(500))))) AS inventoryMaterialDescription,
        LTRIM(RTRIM(CAST(inv.QA_Group AS NVARCHAR(50)))) AS qaGroup,
        SUM(ISNULL(TRY_CONVERT(DECIMAL(18, 4), inv.QTY), 0)) AS qty
      FROM ${INVENTORY_VIEW} inv
      CROSS JOIN latest_inventory_date latest
      WHERE latest.inventoryDate IS NOT NULL
        AND CAST(inv.[Date] AS DATE) = latest.inventoryDate
        AND LTRIM(RTRIM(CAST(inv.Plant AS NVARCHAR(100)))) IN (${Prisma.join(plantCodes)})
        AND LTRIM(RTRIM(CAST(inv.Material AS NVARCHAR(100)))) IN (${Prisma.join(materialCodes)})
      GROUP BY
        LTRIM(RTRIM(CAST(inv.Plant AS NVARCHAR(100)))),
        LTRIM(RTRIM(CAST(inv.Material AS NVARCHAR(100)))),
        LTRIM(RTRIM(CAST(inv.QA_Group AS NVARCHAR(50))))
    )
    SELECT
      plantCode,
      materialCode,
      MAX(inventoryMaterialDescription) AS inventoryMaterialDescription,
      SUM(CASE WHEN qaGroup = 'A0' THEN qty ELSE 0 END) AS a0Qty,
      SUM(CASE WHEN qaGroup = 'NonA0' THEN qty ELSE 0 END) AS nonA0Qty,
      SUM(CASE WHEN qaGroup = 'WaitJudge' THEN qty ELSE 0 END) AS waitJudgeQty,
      SUM(CASE WHEN qaGroup = 'OG' THEN qty ELSE 0 END) AS ogQty,
      SUM(CASE WHEN qaGroup = 'YO' THEN qty ELSE 0 END) AS yoQty,
      SUM(qty) AS totalQty,
      CONVERT(CHAR(10), MAX(latest.inventoryDate), 126) AS inventoryDate
    FROM inventory_grouped
    CROSS JOIN latest_inventory_date latest
    GROUP BY plantCode, materialCode
  `;
  const inventoryByKey = new Map(
    inventoryRows.map(row => [
      `${String(row.plantCode ?? '').trim()}|${String(row.materialCode ?? '').trim()}`,
      row,
    ])
  );

  return registrations.map(row => {
    const plantCode = String(row.plantCode ?? '').trim();
    const materialCode = String(row.materialCode ?? '').trim();
    return mapInventoryRow(row, inventoryByKey.get(`${plantCode}|${materialCode}`));
  });
}

router.post('/query', async (req, res) => {
  const registrationIds = normalizeRegistrationIds(req.body?.registrationIds);
  if (registrationIds.length === 0) {
    return res.json([]);
  }

  const cacheKey = inventoryQueryCacheKey(registrationIds);
  let cached = inventoryQueryCache.get(cacheKey);
  if (!cached || cached.expiresAt <= Date.now()) {
    cached = {
      expiresAt: Date.now() + QUERY_CACHE_TTL_MS,
      promise: loadInventoryRowsForRegistrationIds(registrationIds).catch(error => {
        inventoryQueryCache.delete(cacheKey);
        throw error;
      }),
    };
    inventoryQueryCache.set(cacheKey, cached);
    pruneCache(inventoryQueryCache, MAX_INVENTORY_QUERY_CACHE_ENTRIES);
  }

  try {
    res.json(await cached.promise);
  } catch (error) {
    console.error('[inventory] query error:', error);
    res.status(500).json({
      error: 'Failed to fetch inventory data',
      hint: 'Verify access to [UBE_DW].[dbo].[MKT_NYL_Current_INV] or set INVENTORY_VIEW_NAME.',
    });
  }
});

const inventoryListCacheByMode = new Map<
  string,
  { expiresAt: number; promise: Promise<InventoryApiRow[]> }
>();

router.get('/', async (_req, res) => {
  const mode = getAppMode();
  let cached = inventoryListCacheByMode.get(mode);
  if (!cached || cached.expiresAt <= Date.now()) {
    cached = {
      expiresAt: Date.now() + CACHE_TTL_MS,
      promise: loadInventoryRows().catch(error => {
        inventoryListCacheByMode.delete(mode);
        throw error;
      }),
    };
    inventoryListCacheByMode.set(mode, cached);
  }

  try {
    res.json(await cached.promise);
  } catch (error) {
    console.error('[inventory] GET error:', error);
    res.status(500).json({
      error: 'Failed to fetch inventory data',
      hint: 'Verify access to [UBE_DW].[dbo].[MKT_NYL_Current_INV] or set INVENTORY_VIEW_NAME.',
    });
  }
});

export default router;
