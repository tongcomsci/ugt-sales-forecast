import { Router } from 'express';
import prisma from '../../db/prisma';

const router = Router();
const PRICE_TYPES = new Set(['Actual', 'Fcst']);
const GLOBAL_VERSION = 'GLOBAL';
const CURRENT_VERSION = 'Current Forecast';

type PriceType = 'Actual' | 'Fcst';

function normalizePriceType(value: unknown): PriceType {
  return value === 'Actual' ? 'Actual' : 'Fcst';
}

function normalizeVersion(priceType: PriceType, value: unknown) {
  if (priceType === 'Actual') return GLOBAL_VERSION;
  const version = typeof value === 'string' && value.trim() ? value.trim() : CURRENT_VERSION;
  return version;
}

function fyBounds(fy: unknown) {
  const year = Number(fy);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return null;
  return { start: `${year}-04`, end: `${year + 1}-03` };
}

function monthRange(start: string, end: string) {
  const months: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    months.push(cursor);
    const [year, month] = cursor.split('-').map(Number);
    cursor = month === 12
      ? `${year + 1}-01`
      : `${year}-${String(month + 1).padStart(2, '0')}`;
  }
  return months;
}

function numberOrZero(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? num : 0;
}

async function ensureVersion(versionName: string) {
  if (versionName === GLOBAL_VERSION) return true;
  const count = await prisma.forecastVersion.count({ where: { name: versionName } });
  return count > 0;
}

async function fetchRows({
  start,
  end,
  priceType,
  versionName,
}: {
  start: string;
  end: string;
  priceType: PriceType;
  versionName: string;
}) {
  const rows = await prisma.$queryRaw<Array<{
    month: string;
    cplPrice: unknown;
    naphthaPrice: unknown;
    benzenePrice: unknown;
    jpyUsdRate: unknown;
    thbUsdRate: unknown;
    cplTecnonPrice: unknown;
    cplPciPrice: unknown;
    fallbackCplPrice: unknown;
    currentCplPrice: unknown;
    currentNaphthaPrice: unknown;
    currentBenzenePrice: unknown;
    currentJpyUsdRate: unknown;
    currentThbUsdRate: unknown;
    currentCplTecnonPrice: unknown;
    currentCplPciPrice: unknown;
  }>>`
    SELECT
      months.[month],
      target.[cplPrice],
      target.[naphthaPrice],
      target.[benzenePrice],
      target.[jpyUsdRate],
      target.[thbUsdRate],
      target.[cplTecnonPrice],
      target.[cplPciPrice],
      legacy.[price] AS [fallbackCplPrice],
      currentFcst.[cplPrice] AS [currentCplPrice],
      currentFcst.[naphthaPrice] AS [currentNaphthaPrice],
      currentFcst.[benzenePrice] AS [currentBenzenePrice],
      currentFcst.[jpyUsdRate] AS [currentJpyUsdRate],
      currentFcst.[thbUsdRate] AS [currentThbUsdRate],
      currentFcst.[cplTecnonPrice] AS [currentCplTecnonPrice],
      currentFcst.[cplPciPrice] AS [currentCplPciPrice]
    FROM (
      SELECT [month] FROM [dbo].[cpl_prices]
      UNION
      SELECT [month] FROM [dbo].[price_management_values]
    ) months
    LEFT JOIN [dbo].[price_management_values] target
      ON target.[month] = months.[month]
      AND target.[priceType] = ${priceType}
      AND target.[versionName] = ${versionName}
    LEFT JOIN [dbo].[price_management_values] currentFcst
      ON currentFcst.[month] = months.[month]
      AND currentFcst.[priceType] = N'Fcst'
      AND currentFcst.[versionName] = N'Current Forecast'
    LEFT JOIN [dbo].[cpl_prices] legacy
      ON legacy.[month] = months.[month]
    WHERE months.[month] >= ${start} AND months.[month] <= ${end}
    ORDER BY months.[month] ASC
  `;

  const byMonth = new Map(rows.map(row => [row.month, row]));
  return monthRange(start, end).map(month => {
    const row = byMonth.get(month);
    return {
      month,
      cplPrice: Number(row?.cplPrice ?? row?.currentCplPrice ?? row?.fallbackCplPrice ?? 0),
      naphthaPrice: Number(row?.naphthaPrice ?? row?.currentNaphthaPrice ?? 0),
      benzenePrice: Number(row?.benzenePrice ?? row?.currentBenzenePrice ?? 0),
      jpyUsdRate: Number(row?.jpyUsdRate ?? row?.currentJpyUsdRate ?? 0),
      thbUsdRate: Number(row?.thbUsdRate ?? row?.currentThbUsdRate ?? 0),
      cplTecnonPrice: Number(row?.cplTecnonPrice ?? row?.currentCplTecnonPrice ?? 0),
      cplPciPrice: Number(row?.cplPciPrice ?? row?.currentCplPciPrice ?? 0),
    };
  });
}

router.get('/', async (req, res) => {
  const priceType = normalizePriceType(req.query.priceType);
  const versionName = normalizeVersion(priceType, req.query.version);
  const bounds = fyBounds(req.query.fy) ?? {
    start: typeof req.query.startMonth === 'string' ? req.query.startMonth : '2000-01',
    end: typeof req.query.endMonth === 'string' ? req.query.endMonth : '2100-12',
  };
  if (!/^\d{4}-\d{2}$/.test(bounds.start) || !/^\d{4}-\d{2}$/.test(bounds.end)) {
    return res.status(400).json({ error: 'startMonth/endMonth must be YYYY-MM' });
  }

  try {
    const rows = await fetchRows({ ...bounds, priceType, versionName });
    res.json({ priceType, versionName, rows });
  } catch (error) {
    console.error('[price-management] GET error:', error);
    res.status(500).json({ error: 'Failed to fetch price management data' });
  }
});

router.patch('/bulk', async (req, res) => {
  const priceType = normalizePriceType(req.body?.priceType);
  const versionName = normalizeVersion(priceType, req.body?.versionName);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];

  if (!PRICE_TYPES.has(priceType)) return res.status(400).json({ error: 'Invalid priceType' });
  if (!(await ensureVersion(versionName))) return res.status(400).json({ error: `Unknown forecast version ${versionName}` });
  if (rows.length === 0) return res.status(400).json({ error: 'rows are required' });

  try {
    await prisma.$transaction(async tx => {
      for (const row of rows) {
        const month = String(row.month ?? '');
        if (!/^\d{4}-\d{2}$/.test(month)) throw new Error(`Invalid month ${month}`);
        const cplPrice = numberOrZero(row.cplPrice);
        const naphthaPrice = numberOrZero(row.naphthaPrice);
        const benzenePrice = numberOrZero(row.benzenePrice);
        const jpyUsdRate = numberOrZero(row.jpyUsdRate);
        const thbUsdRate = numberOrZero(row.thbUsdRate);
        const cplTecnonPrice = numberOrZero(row.cplTecnonPrice);
        const cplPciPrice = numberOrZero(row.cplPciPrice);
        await tx.$executeRaw`
          MERGE [dbo].[price_management_values] WITH (HOLDLOCK) AS target
          USING (SELECT ${month} AS [month], ${priceType} AS [priceType], ${versionName} AS [versionName]) AS source
          ON target.[month] = source.[month]
            AND target.[priceType] = source.[priceType]
            AND target.[versionName] = source.[versionName]
          WHEN MATCHED THEN
            UPDATE SET
              [cplPrice] = ${cplPrice},
              [naphthaPrice] = ${naphthaPrice},
              [benzenePrice] = ${benzenePrice},
              [jpyUsdRate] = ${jpyUsdRate},
              [thbUsdRate] = ${thbUsdRate},
              [cplTecnonPrice] = ${cplTecnonPrice},
              [cplPciPrice] = ${cplPciPrice},
              [updatedAt] = CURRENT_TIMESTAMP
          WHEN NOT MATCHED THEN
            INSERT ([month], [priceType], [versionName], [cplPrice], [naphthaPrice], [benzenePrice], [jpyUsdRate], [thbUsdRate], [cplTecnonPrice], [cplPciPrice])
            VALUES (${month}, ${priceType}, ${versionName}, ${cplPrice}, ${naphthaPrice}, ${benzenePrice}, ${jpyUsdRate}, ${thbUsdRate}, ${cplTecnonPrice}, ${cplPciPrice});
        `;
        if (priceType === 'Fcst' && versionName === CURRENT_VERSION) {
          await tx.cplPrice.upsert({
            where: { month },
            update: { price: cplPrice },
            create: { month, price: cplPrice },
          });
        }
      }
    });
    res.json({ ok: true, updated: rows.length, priceType, versionName });
  } catch (error) {
    console.error('[price-management] PATCH error:', error);
    res.status(500).json({ error: 'Failed to save price management data' });
  }
});

router.post('/copy', async (req, res) => {
  const bounds = fyBounds(req.body?.fy);
  const sourceVersion = normalizeVersion('Fcst', req.body?.sourceVersion);
  const targetVersion = normalizeVersion('Fcst', req.body?.targetVersion);
  if (!bounds) return res.status(400).json({ error: 'fy is required' });
  if (sourceVersion === targetVersion) return res.status(400).json({ error: 'sourceVersion and targetVersion must be different' });
  if (!(await ensureVersion(sourceVersion)) || !(await ensureVersion(targetVersion))) {
    return res.status(400).json({ error: 'Unknown forecast version' });
  }

  try {
    const sourceRows = await fetchRows({ ...bounds, priceType: 'Fcst', versionName: sourceVersion });
    await prisma.$transaction(async tx => {
      for (const row of sourceRows) {
        await tx.$executeRaw`
          MERGE [dbo].[price_management_values] WITH (HOLDLOCK) AS target
          USING (SELECT ${row.month} AS [month], N'Fcst' AS [priceType], ${targetVersion} AS [versionName]) AS source
          ON target.[month] = source.[month]
            AND target.[priceType] = source.[priceType]
            AND target.[versionName] = source.[versionName]
          WHEN MATCHED THEN
            UPDATE SET
              [cplPrice] = ${row.cplPrice},
              [naphthaPrice] = ${row.naphthaPrice},
              [benzenePrice] = ${row.benzenePrice},
              [jpyUsdRate] = ${row.jpyUsdRate},
              [thbUsdRate] = ${row.thbUsdRate},
              [cplTecnonPrice] = ${row.cplTecnonPrice},
              [cplPciPrice] = ${row.cplPciPrice},
              [updatedAt] = CURRENT_TIMESTAMP
          WHEN NOT MATCHED THEN
            INSERT ([month], [priceType], [versionName], [cplPrice], [naphthaPrice], [benzenePrice], [jpyUsdRate], [thbUsdRate], [cplTecnonPrice], [cplPciPrice])
            VALUES (
              ${row.month}, N'Fcst', ${targetVersion},
              ${row.cplPrice}, ${row.naphthaPrice}, ${row.benzenePrice},
              ${row.jpyUsdRate}, ${row.thbUsdRate}, ${row.cplTecnonPrice}, ${row.cplPciPrice}
            );
        `;
      }
    });
    res.json({ ok: true, copied: sourceRows.length, sourceVersion, targetVersion });
  } catch (error) {
    console.error('[price-management] COPY error:', error);
    res.status(500).json({ error: 'Failed to copy price management data' });
  }
});

router.delete('/:month', async (req, res) => {
  const { month } = req.params;
  const priceType = normalizePriceType(req.query.priceType);
  const versionName = normalizeVersion(priceType, req.query.version);
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must be YYYY-MM' });
  }

  try {
    await prisma.$executeRaw`
      DELETE FROM [dbo].[price_management_values]
      WHERE [month] = ${month}
        AND [priceType] = ${priceType}
        AND [versionName] = ${versionName}
    `;
    if (priceType === 'Fcst' && versionName === CURRENT_VERSION) {
      await prisma.cplPrice.deleteMany({ where: { month } });
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('[price-management] DELETE error:', error);
    res.status(500).json({ error: 'Failed to remove price management data' });
  }
});

export default router;
