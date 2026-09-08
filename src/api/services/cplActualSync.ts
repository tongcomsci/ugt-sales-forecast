import prisma from '../../db/prisma';
import { getActiveSnapshotVersion, USE_LOCAL_SNAPSHOT } from './dataSnapshot';

/// Live actual-sales source (same table used by actuals and snapshot refresh).
export const ACTUAL_SALES_VIEW =
  process.env.ACTUAL_SALES_VIEW?.trim()
  || 'dbo.MKT_SALEReport_ZSDR001_UGT_CRM_NYL_1';

const PRICE_TYPE = 'Actual';
const VERSION_NAME = 'GLOBAL';

export type CplActualSyncResult = {
  ok: boolean;
  synced: number;
  source: string;
  error?: string;
};

let syncPromise: Promise<CplActualSyncResult> | null = null;

function roundPrice(value: unknown) {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.round(num * 10000) / 10000;
}

async function queryMonthlyCplActual(snapshotVersion: string | null) {
  if (snapshotVersion) {
    return prisma.$queryRaw<Array<{ month: string; cplPrice: unknown }>>`
      SELECT
        CONVERT(CHAR(7), a.deliveryDate, 126) AS [month],
        CASE
          WHEN SUM(CAST(ISNULL(a.qty, 0) AS DECIMAL(18, 4))) = 0 THEN CAST(0 AS DECIMAL(18, 4))
          ELSE SUM(CAST(ISNULL(a.amount, 0) AS DECIMAL(18, 4)))
            / NULLIF(SUM(CAST(ISNULL(a.qty, 0) AS DECIMAL(18, 4))), 0)
        END AS cplPrice
      FROM dbo.actual_sales_snapshot a
      WHERE a.snapshotVersion = ${snapshotVersion}
        AND a.deliveryDate IS NOT NULL
        AND ISNULL(a.qty, 0) > 0
      GROUP BY CONVERT(CHAR(7), a.deliveryDate, 126)
      ORDER BY [month] ASC
    `;
  }

  return prisma.$queryRawUnsafe<Array<{ month: string; cplPrice: unknown }>>(`
    SELECT
      CONVERT(CHAR(7), a.Deliverydate, 126) AS [month],
      CASE
        WHEN SUM(CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))) = 0 THEN CAST(0 AS DECIMAL(18, 4))
        ELSE SUM(CAST(ISNULL(a.[Net Amount USD (new)], 0) AS DECIMAL(18, 4)))
          / NULLIF(SUM(CAST(ISNULL(a.[Order Qty_TON], 0) AS DECIMAL(18, 4))), 0)
      END AS cplPrice
    FROM ${ACTUAL_SALES_VIEW} a
    WHERE a.Deliverydate IS NOT NULL
      AND ISNULL(a.[Order Qty_TON], 0) > 0
    GROUP BY CONVERT(CHAR(7), a.Deliverydate, 126)
    ORDER BY [month] ASC
  `);
}

/// Aggregate sum(Net Amount USD) / sum(Order Qty_TON) by delivery month and upsert CPL Actual rows.
export async function syncCplActualPrices(): Promise<CplActualSyncResult> {
  if (syncPromise !== null) return syncPromise;

  syncPromise = (async () => {
    const snapshotVersion = USE_LOCAL_SNAPSHOT ? await getActiveSnapshotVersion() : null;
    const source = snapshotVersion
      ? `actual_sales_snapshot:${snapshotVersion}`
      : ACTUAL_SALES_VIEW;

    try {
      const monthlyRows = await queryMonthlyCplActual(snapshotVersion);
      if (monthlyRows.length === 0) {
        return { ok: true, synced: 0, source };
      }

      await prisma.$transaction(async tx => {
        for (const row of monthlyRows) {
          const month = String(row.month ?? '').trim();
          if (!/^\d{4}-\d{2}$/.test(month)) continue;
          const cplPrice = roundPrice(row.cplPrice);
          await tx.$executeRaw`
            MERGE [dbo].[price_management_values] WITH (HOLDLOCK) AS target
            USING (
              SELECT ${month} AS [month], ${PRICE_TYPE} AS [priceType], ${VERSION_NAME} AS [versionName]
            ) AS source
            ON target.[month] = source.[month]
              AND target.[priceType] = source.[priceType]
              AND target.[versionName] = source.[versionName]
            WHEN MATCHED THEN
              UPDATE SET
                [cplPrice] = ${cplPrice},
                [updatedAt] = CURRENT_TIMESTAMP
            WHEN NOT MATCHED THEN
              INSERT ([month], [priceType], [versionName], [cplPrice], [naphthaPrice], [benzenePrice])
              VALUES (${month}, ${PRICE_TYPE}, ${VERSION_NAME}, ${cplPrice}, 0, 0);
          `;
        }
      }, { timeout: 120_000 });

      return { ok: true, synced: monthlyRows.length, source };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, synced: 0, source, error: message };
    }
  })();

  try {
    return await syncPromise;
  } finally {
    syncPromise = null;
  }
}

export async function getCplActualPriceCount(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ cnt: number }>>`
    SELECT COUNT(*) AS cnt
    FROM dbo.price_management_values
    WHERE priceType = ${PRICE_TYPE}
      AND versionName = ${VERSION_NAME}
  `;
  return Number(rows[0]?.cnt ?? 0);
}
