/**
 * Reconcile app-created placeholder registrations against their CRM twins.
 *
 * An import that could not find a CRM match used to create a placeholder
 * registration named IMP_<plant>_<material>. The registration key embeds the
 * topic name (newKey = `${topic}/${keyForNoCRM}`), so once the same
 * registration appeared in CRM under its real name the app saw two separate
 * registrations for one real-world combination — and summed both.
 *
 * The guard that prevents this (findDuplicateRegistration, which checks CRM by
 * keyForNoCRM) landed in commit e080729 on 2026-07-06 11:49, about two hours
 * after the placeholders were created. So the code is fixed; this is leftover
 * data.
 *
 * Conflict rule: CRM wins. Verified against every conflicting row in the data —
 * the CRM value was always the newer one and always came from excel_import,
 * while the placeholder held a stale version_copy from July.
 *
 *   Dry run (default):  npx tsx scripts/repair-duplicate-placeholder-registrations.mjs
 *   Apply:              npx tsx scripts/repair-duplicate-placeholder-registrations.mjs --apply
 */
import 'dotenv/config';
import { mkdirSync, writeFileSync } from 'node:fs';
import prisma from '../src/db/prisma.ts';

const apply = process.argv.includes('--apply');
const num = (value) => (value === null || value === undefined ? 0 : Number(value));
const json = (value) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? Number(v) : v), 2);

/** Placeholder registrations whose identity key already exists in CRM. */
const pairs = await prisma.$queryRawUnsafe(`
  SELECT m.[id] AS mgdId, m.[newKey] AS mgdKey, m.[keyForNoCRM], m.[plantCode],
         (SELECT TOP 1 c.[NewKey] FROM dbo.VW_CRM_RegistrationAll_1 c
          WHERE c.[KeyforNoCRM] = m.[keyForNoCRM]) AS crmKey
  FROM dbo.master_data_crm_registrations m
  WHERE EXISTS (SELECT 1 FROM dbo.VW_CRM_RegistrationAll_1 c
                WHERE c.[KeyforNoCRM] = m.[keyForNoCRM])
  ORDER BY m.[plantCode], m.[newKey]
`);

if (pairs.length === 0) {
  console.log('No placeholder registrations duplicate a CRM registration. Nothing to do.');
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`${pairs.length} placeholder registration(s) duplicate a CRM registration.\n`);

let totalMove = 0;
let totalDelete = 0;
let totalDeletedQty = 0;
const plan = [];

for (const pair of pairs) {
  const [counts] = await prisma.$queryRawUnsafe(`
    SELECT
      SUM(CASE WHEN dup.[registrationId] IS NULL THEN 1 ELSE 0 END) AS moveRows,
      SUM(CASE WHEN dup.[registrationId] IS NULL THEN 0 ELSE 1 END) AS deleteRows,
      ISNULL(SUM(CASE WHEN dup.[registrationId] IS NULL THEN 0 ELSE a.[qtyFcst] END), 0) AS deleteQty,
      ISNULL(SUM(CASE WHEN dup.[registrationId] IS NULL THEN a.[qtyFcst] ELSE 0 END), 0) AS moveQty
    FROM dbo.forecast_values a
    OUTER APPLY (
      SELECT TOP 1 b.[registrationId] FROM dbo.forecast_values b
      WHERE b.[registrationId] = @crmKey
        AND b.[versionName] = a.[versionName]
        AND b.[period] = a.[period]
        AND b.[granularity] = a.[granularity]
    ) dup
    WHERE a.[registrationId] = @mgdId
  `.replaceAll('@crmKey', `N'${String(pair.crmKey).replaceAll("'", "''")}'`)
   .replaceAll('@mgdId', `N'${String(pair.mgdId).replaceAll("'", "''")}'`));

  const entry = {
    plantCode: pair.plantCode,
    placeholder: pair.mgdKey,
    placeholderId: pair.mgdId,
    crmTarget: pair.crmKey,
    moveRows: num(counts.moveRows),
    moveQty: num(counts.moveQty),
    deleteRows: num(counts.deleteRows),
    deleteQty: num(counts.deleteQty),
  };
  plan.push(entry);
  totalMove += entry.moveRows;
  totalDelete += entry.deleteRows;
  totalDeletedQty += entry.deleteQty;

  console.log(`plant ${entry.plantCode}  ${entry.placeholder}`);
  console.log(`  -> ${entry.crmTarget}`);
  console.log(`     move ${entry.moveRows} row(s) (qty ${entry.moveQty.toFixed(4)}), ` +
              `drop ${entry.deleteRows} duplicate row(s) (qty ${entry.deleteQty.toFixed(4)})`);
}

console.log(`\nTotal: move ${totalMove} row(s), drop ${totalDelete} row(s), ` +
            `removing ${totalDeletedQty.toFixed(4)} from forecast totals.`);

if (!apply) {
  console.log('\nDry run. Re-run with --apply to make these changes.');
  await prisma.$disconnect();
  process.exit(0);
}

// Back up everything the run touches, so it can be reconstructed if needed.
const ids = pairs.map(p => `N'${String(p.mgdId).replaceAll("'", "''")}'`).join(',');
const backup = {
  takenAt: new Date().toISOString(),
  rule: 'CRM wins on conflict',
  pairs: plan,
  forecastValues: await prisma.$queryRawUnsafe(
    `SELECT * FROM dbo.forecast_values WHERE [registrationId] IN (${ids})`),
  registrations: await prisma.$queryRawUnsafe(
    `SELECT * FROM dbo.master_data_crm_registrations WHERE [id] IN (${ids})`),
  priceSettings: await prisma.$queryRawUnsafe(
    `SELECT * FROM dbo.registration_price_settings WHERE [registrationId] IN (${ids})`),
};
mkdirSync('backups', { recursive: true });
const backupPath = `backups/placeholder-reconcile-${Date.now()}.json`;
writeFileSync(backupPath, json(backup), 'utf8');
console.log(`\nBackup written to ${backupPath} ` +
            `(${backup.forecastValues.length} forecast rows, ${backup.registrations.length} registrations).`);

for (const pair of pairs) {
  const mgdId = pair.mgdId;
  const crmKey = pair.crmKey;
  await prisma.$transaction(async tx => {
    // Drop the placeholder rows the CRM twin already covers: CRM wins.
    await tx.$executeRaw`
      DELETE a FROM dbo.forecast_values a
      WHERE a.[registrationId] = ${mgdId}
        AND EXISTS (
          SELECT 1 FROM dbo.forecast_values b
          WHERE b.[registrationId] = ${crmKey}
            AND b.[versionName] = a.[versionName]
            AND b.[period] = a.[period]
            AND b.[granularity] = a.[granularity]
        )`;
    // Whatever is left has no counterpart, so it moves across.
    await tx.$executeRaw`
      UPDATE dbo.forecast_values SET [registrationId] = ${crmKey}
      WHERE [registrationId] = ${mgdId}`;
    await tx.$executeRaw`
      UPDATE dbo.registration_price_settings SET [registrationId] = ${crmKey}
      WHERE [registrationId] = ${mgdId}
        AND NOT EXISTS (SELECT 1 FROM dbo.registration_price_settings t
                        WHERE t.[registrationId] = ${crmKey})`;
    await tx.$executeRaw`
      DELETE FROM dbo.registration_price_settings WHERE [registrationId] = ${mgdId}`;
    await tx.$executeRaw`
      DELETE FROM dbo.master_data_crm_registrations WHERE [id] = ${mgdId}`;
  }, { timeout: 120_000 });
  console.log(`  reconciled ${pair.mgdKey}`);
}

const [left] = await prisma.$queryRawUnsafe(`
  SELECT COUNT(*) AS n FROM dbo.master_data_crm_registrations m
  WHERE EXISTS (SELECT 1 FROM dbo.VW_CRM_RegistrationAll_1 c
                WHERE c.[KeyforNoCRM] = m.[keyForNoCRM])`);
console.log(`\nDone. Duplicate placeholders remaining: ${num(left.n)} (expected 0).`);
await prisma.$disconnect();
