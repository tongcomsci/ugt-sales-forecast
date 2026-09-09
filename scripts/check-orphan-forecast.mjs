/**
 * Find forecast rows an import no longer maintains (read-only).
 *
 * An import overwrites and creates but never deletes, so a registration that
 * drops out of the Excel sheet keeps whatever value it last had — and that
 * value still counts towards every total. That is what separates a plant total
 * in the app from the same column summed in the sheet.
 *
 * "Not maintained" means the row's (registrationId, versionName, period) does
 * not appear in the chosen import's change log. The change log is the right
 * source here: confirmImport writes one entry per parsed record, including
 * records whose value did not change. lastBatchId cannot be used for this —
 * it only moves when a value actually changes, so a row the sheet did contain
 * at an unchanged value still points at an older batch and would look stale.
 *
 * Writes nothing. Decide per registration whether the leftover value should
 * stay or be zeroed.
 *
 *   npx tsx scripts/check-orphan-forecast.mjs
 *   npx tsx scripts/check-orphan-forecast.mjs --plant 1104 --from 2026-09 --to 2026-09
 *   npx tsx scripts/check-orphan-forecast.mjs --version "SepF FY26" --limit 40
 */
import 'dotenv/config';
import prisma from '../src/db/prisma.ts';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const version = arg('version', 'Current Forecast');
const from = arg('from', '2026-04');
const to = arg('to', '2027-03');
const plant = arg('plant', null);
const limit = Number(arg('limit', 25));
const num = (value) => (value === null || value === undefined ? 0 : Number(value));

const monthStart = (month) => `${month}-01`;
const monthAfter = (month) => {
  const [year, mon] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, mon, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

// The baseline has to be an import that actually wrote to the version being
// asked about. The newest import overall may target a different version, and
// comparing against that flags the whole version as unmaintained.
const [batch] = await prisma.$queryRawUnsafe(`
  SELECT TOP 1 b.[id], b.[source], b.[changedBy], CONVERT(char(19), b.[createdAt], 126) AS createdAt
  FROM dbo.forecast_commit_batches b
  WHERE b.[source] LIKE N'excel_import%'
    AND EXISTS (
      SELECT 1 FROM dbo.forecast_change_logs l
      WHERE l.[batchId] = b.[id] AND l.[versionName] = N'${version.replaceAll("'", "''")}'
    )
  ORDER BY b.[createdAt] DESC
`);
if (!batch) {
  console.log(`No Excel import has ever written to version "${version}" — nothing to compare against.`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Comparing against the latest Excel import`);
console.log(`  ${batch.createdAt}  ${batch.source}  by ${batch.changedBy}`);
console.log(`Scope: version "${version}", ${from}..${to}${plant ? `, plant ${plant}` : ', all plants'}\n`);

const quote = (value) => `N'${String(value).replaceAll("'", "''")}'`;

/**
 * An import covers one sheet, so a plant that sheet never contained is not
 * "unmaintained" — it is maintained by a different sheet. Without this the
 * report is dominated by plants the chosen import was never responsible for.
 * Pass --all-plants to see the raw comparison anyway.
 */
const coveredPlants = process.argv.includes('--all-plants') ? [] : (
  await prisma.$queryRawUnsafe(`
    WITH reg AS (
      SELECT m.[id] AS rid, m.[plantCode] AS plantCode FROM dbo.master_data_crm_registrations m
      UNION ALL SELECT m.[newKey], m.[plantCode] FROM dbo.master_data_crm_registrations m
      UNION ALL SELECT r.[NewKey], CAST(r.[PlantCode] AS NVARCHAR(100)) FROM dbo.VW_CRM_RegistrationAll_1 r
    )
    SELECT DISTINCT reg.plantCode
    FROM dbo.forecast_change_logs l
    JOIN reg ON reg.rid = l.[registrationId]
    WHERE l.[batchId] = ${quote(batch.id)} AND reg.plantCode IS NOT NULL
  `)
).map(row => row.plantCode);

if (coveredPlants.length > 0) {
  console.log(`That import covered ${coveredPlants.length} plant(s): ${coveredPlants.sort().join(', ')}`);
  console.log('Plants outside it are maintained by another sheet and are excluded ' +
              '(pass --all-plants to include them).\n');
}

const plantFilter = plant
  ? `AND reg.plantCode = ${quote(plant)}`
  : coveredPlants.length > 0
    ? `AND reg.plantCode IN (${coveredPlants.map(quote).join(',')})`
    : '';

const rows = await prisma.$queryRawUnsafe(`
  WITH reg AS (
    SELECT m.[id] AS rid, m.[newKey] AS label, m.[plantCode] AS plantCode, N'app-created' AS origin
    FROM dbo.master_data_crm_registrations m
    UNION ALL
    SELECT m.[newKey], m.[newKey], m.[plantCode], N'app-created'
    FROM dbo.master_data_crm_registrations m
    UNION ALL
    SELECT r.[NewKey], r.[NewKey], CAST(r.[PlantCode] AS NVARCHAR(100)), N'CRM'
    FROM dbo.VW_CRM_RegistrationAll_1 r
  ),
  scoped AS (
    SELECT f.[registrationId], f.[period], f.[qtyFcst], f.[lastBatchId]
    FROM dbo.forecast_values f
    WHERE f.[versionName] = ${quote(version)}
      AND f.[period] >= '${monthStart(from)}' AND f.[period] < '${monthAfter(to)}'
  ),
  orphan AS (
    SELECT s.*
    FROM scoped s
    WHERE NOT EXISTS (
      SELECT 1 FROM dbo.forecast_change_logs l
      WHERE l.[batchId] = ${quote(batch.id)}
        AND l.[registrationId] = s.[registrationId]
        AND l.[versionName] = ${quote(version)}
        AND l.[period] = s.[period]
    )
  )
  SELECT TOP (${limit})
    MIN(reg.label) AS label,
    MIN(reg.plantCode) AS plantCode,
    MIN(reg.origin) AS origin,
    COUNT(*) AS rows,
    SUM(o.[qtyFcst]) AS qty,
    MAX(CONVERT(char(10), b.[createdAt], 126)) AS lastTouched,
    MAX(b.[source]) AS lastSource
  FROM orphan o
  JOIN reg ON reg.rid = o.[registrationId]
  LEFT JOIN dbo.forecast_commit_batches b ON b.[id] = o.[lastBatchId]
  WHERE 1 = 1 ${plantFilter}
  GROUP BY o.[registrationId]
  HAVING SUM(o.[qtyFcst]) <> 0
  ORDER BY SUM(o.[qtyFcst]) DESC
`);

const [totals] = await prisma.$queryRawUnsafe(`
  WITH reg AS (
    SELECT m.[id] AS rid, m.[plantCode] AS plantCode FROM dbo.master_data_crm_registrations m
    UNION ALL SELECT m.[newKey], m.[plantCode] FROM dbo.master_data_crm_registrations m
    UNION ALL SELECT r.[NewKey], CAST(r.[PlantCode] AS NVARCHAR(100)) FROM dbo.VW_CRM_RegistrationAll_1 r
  ),
  scoped AS (
    SELECT f.[registrationId], f.[period], f.[qtyFcst] FROM dbo.forecast_values f
    WHERE f.[versionName] = ${quote(version)}
      AND f.[period] >= '${monthStart(from)}' AND f.[period] < '${monthAfter(to)}'
  )
  SELECT COUNT(DISTINCT s.[registrationId]) AS regs, COUNT(*) AS rows, ISNULL(SUM(s.[qtyFcst]), 0) AS qty
  FROM scoped s
  JOIN reg ON reg.rid = s.[registrationId]
  WHERE NOT EXISTS (
      SELECT 1 FROM dbo.forecast_change_logs l
      WHERE l.[batchId] = ${quote(batch.id)}
        AND l.[registrationId] = s.[registrationId]
        AND l.[versionName] = ${quote(version)}
        AND l.[period] = s.[period]
    )
    ${plantFilter}
`);

if (rows.length === 0) {
  console.log('Every row in scope was covered by that import. Nothing left behind.');
} else {
  console.log(`Registrations carrying a value the import did not maintain (top ${rows.length} by quantity):\n`);
  for (const row of rows) {
    console.log(`  ${num(row.qty).toFixed(4).padStart(12)}  ${String(row.rows).padStart(3)} row(s)  ` +
                `plant ${String(row.plantCode ?? '-').padEnd(6)} ${String(row.origin).padEnd(12)} ` +
                `last touched ${row.lastTouched ?? '-'} ${row.lastSource ?? ''}`);
    console.log(`                ${row.label}`);
  }
}

console.log(`\nTotal not maintained in scope: ${num(totals.qty).toFixed(4)} ` +
            `across ${num(totals.rows)} row(s) / ${num(totals.regs)} registration(s).`);
console.log('Read-only — nothing was changed.');
await prisma.$disconnect();
