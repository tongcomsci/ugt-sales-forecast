/**
 * Zero the forecast rows an import no longer maintains.
 *
 * An import overwrites and creates but never deletes, so a registration that
 * drops out of the Excel sheet keeps whatever value it last had and it still
 * counts towards every total. Where the sheet is the authority for a plant,
 * those leftovers are wrong and belong at zero.
 *
 * Business decision, 9 Sep 2026: for plant 1104 the sheet is the authority.
 * Rows the latest import did not cover go to zero — including rows that came
 * from version_copy rather than an import, because the sheet total the business
 * verified against treats those as zero too. Verified: plant 1104 September
 * moves from 2017.696 to 1819.396 against a sheet figure of ~1819.
 *
 * Sets qtyFcst and amountFcst to zero. Rows are kept, not deleted, so they stay
 * visible and the next import can write to them normally. priceFcst is left
 * alone: it is reference data and harmless without a quantity.
 *
 * Every change is recorded through ForecastCommitBatch and ForecastChangeLog,
 * the same audit trail every other write in this app uses.
 *
 *   Dry run:  npx tsx scripts/repair-orphan-forecast.mjs --plant 1104
 *   Apply:    npx tsx scripts/repair-orphan-forecast.mjs --plant 1104 --apply
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import prisma from '../src/db/prisma.ts';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const apply = process.argv.includes('--apply');
const version = arg('version', 'Current Forecast');
const from = arg('from', '2026-04');
const to = arg('to', '2027-03');
const plant = arg('plant', null);
const changedBy = arg('by', 'orphan-cleanup');
const num = (value) => (value === null || value === undefined ? 0 : Number(value));
const quote = (value) => `N'${String(value).replaceAll("'", "''")}'`;

if (!plant) {
  console.log('Refusing to run without --plant: the sheet is only known to be ' +
              'the authority for the plants someone has verified against it.');
  await prisma.$disconnect();
  process.exit(1);
}

const monthStart = (month) => `${month}-01`;
const monthAfter = (month) => {
  const [year, mon] = month.split('-').map(Number);
  const next = new Date(Date.UTC(year, mon, 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-01`;
};

const [batch] = await prisma.$queryRawUnsafe(`
  SELECT TOP 1 b.[id], b.[source], CONVERT(char(19), b.[createdAt], 126) AS createdAt
  FROM dbo.forecast_commit_batches b
  WHERE b.[source] LIKE N'excel_import%'
    AND EXISTS (SELECT 1 FROM dbo.forecast_change_logs l
                WHERE l.[batchId] = b.[id] AND l.[versionName] = ${quote(version)})
  ORDER BY b.[createdAt] DESC
`);
if (!batch) {
  console.log(`No Excel import has written to version "${version}".`);
  await prisma.$disconnect();
  process.exit(1);
}

const scope = `
  WITH reg AS (
    SELECT m.[id] AS rid, m.[plantCode] AS plantCode FROM dbo.master_data_crm_registrations m
    UNION ALL SELECT m.[newKey], m.[plantCode] FROM dbo.master_data_crm_registrations m
    UNION ALL SELECT r.[NewKey], CAST(r.[PlantCode] AS NVARCHAR(100)) FROM dbo.VW_CRM_RegistrationAll_1 r
  )
  SELECT f.[registrationId], f.[versionName], f.[period], f.[granularity],
         f.[qtyFcst], f.[priceFcst], f.[amountFcst]
  FROM dbo.forecast_values f
  JOIN reg ON reg.rid = f.[registrationId]
  WHERE reg.plantCode = ${quote(plant)}
    AND f.[versionName] = ${quote(version)}
    AND f.[period] >= '${monthStart(from)}' AND f.[period] < '${monthAfter(to)}'
    AND (f.[qtyFcst] <> 0 OR f.[amountFcst] <> 0)
    AND NOT EXISTS (
      SELECT 1 FROM dbo.forecast_change_logs l
      WHERE l.[batchId] = ${quote(batch.id)}
        AND l.[registrationId] = f.[registrationId]
        AND l.[versionName] = f.[versionName]
        AND l.[period] = f.[period]
    )`;

const targets = await prisma.$queryRawUnsafe(scope);

console.log(`Latest import for "${version}": ${batch.createdAt} (${batch.source})`);
console.log(`Scope: plant ${plant}, ${from}..${to}\n`);

if (targets.length === 0) {
  console.log('Nothing left unmaintained in scope.');
  await prisma.$disconnect();
  process.exit(0);
}

const byMonth = new Map();
let totalQty = 0;
for (const row of targets) {
  const month = row.period.toISOString().slice(0, 7);
  const entry = byMonth.get(month) ?? { rows: 0, qty: 0 };
  entry.rows += 1;
  entry.qty += num(row.qtyFcst);
  byMonth.set(month, entry);
  totalQty += num(row.qtyFcst);
}
for (const month of [...byMonth.keys()].sort()) {
  const entry = byMonth.get(month);
  console.log(`  ${month}  ${String(entry.rows).padStart(4)} row(s)  qty ${entry.qty.toFixed(4).padStart(12)}`);
}
const registrations = new Set(targets.map(row => row.registrationId));
console.log(`\n${targets.length} row(s) across ${registrations.size} registration(s), ` +
            `removing ${totalQty.toFixed(4)} from totals.`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to set these to zero.');
  await prisma.$disconnect();
  process.exit(0);
}

mkdirSync('backups', { recursive: true });
const backupPath = `backups/orphan-forecast-${Date.now()}.json`;
writeFileSync(backupPath, JSON.stringify({
  takenAt: new Date().toISOString(),
  scope: { plant, version, from, to },
  comparedAgainstBatch: batch,
  rows: targets,
}, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2), 'utf8');
console.log(`\nBackup written to ${backupPath} (${targets.length} rows).`);

const result = await prisma.$transaction(async tx => {
  const commit = await tx.forecastCommitBatch.create({
    data: { source: 'orphan_cleanup', changedBy, stampPeriod: 'No', recordCount: targets.length },
  });
  await tx.forecastChangeLog.createMany({
    data: targets.map(row => ({
      batchId: commit.id,
      registrationId: row.registrationId,
      versionName: row.versionName,
      period: row.period,
      granularity: row.granularity,
      oldQtyFcst: row.qtyFcst,
      newQtyFcst: 0,
      oldPriceFcst: row.priceFcst,
      newPriceFcst: row.priceFcst,
      oldAmountFcst: row.amountFcst,
      newAmountFcst: 0,
    })),
  });
  const payload = JSON.stringify(targets.map(row => ({
    registrationId: row.registrationId,
    versionName: row.versionName,
    period: row.period.toISOString().slice(0, 10),
    granularity: row.granularity,
  })));
  const updated = await tx.$executeRaw`
    UPDATE target
    SET target.[qtyFcst] = 0,
        target.[amountFcst] = 0,
        target.[lastBatchId] = ${commit.id},
        target.[updatedAt] = SYSUTCDATETIME()
    FROM [dbo].[forecast_values] target
    INNER JOIN OPENJSON(${payload})
      WITH (
        [registrationId] NVARCHAR(200) N'$.registrationId',
        [versionName]    NVARCHAR(100) N'$.versionName',
        [period]         DATE          N'$.period',
        [granularity]    NVARCHAR(10)  N'$.granularity'
      ) AS source
      ON target.[registrationId] = source.[registrationId]
     AND target.[versionName]    = source.[versionName]
     AND target.[period]         = source.[period]
     AND target.[granularity]    = source.[granularity]`;
  return { batchId: commit.id, updated };
}, { timeout: 120_000 });

console.log(`Zeroed ${result.updated} row(s) under batch ${result.batchId}.`);

const remaining = await prisma.$queryRawUnsafe(scope);
console.log(`Rows still unmaintained with a value in scope: ${remaining.length} (expected 0).`);
await prisma.$disconnect();
