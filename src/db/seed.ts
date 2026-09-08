/**
 * Seed script: insert initial forecast versions and Price Management CPL rows.
 * Run with: npx tsx src/db/seed.ts
 * Reads DATABASE_URL from .env automatically.
 */
import 'dotenv/config';
import prisma from './prisma';

const INITIAL_VERSIONS = [
  { name: 'Current Forecast', versionKey: 1, isStandard: true },
  { name: 'BB FY26',          versionKey: 2, isStandard: true },
  { name: 'SepF FY26',        versionKey: 3, isStandard: true },
  { name: 'DecF FY26',        versionKey: 4, isStandard: true },
];

const INITIAL_CPL_PRICES = [
  { month: '2026-04', price: 1200 },
  { month: '2026-05', price: 1200 },
  { month: '2026-06', price: 1200 },
  { month: '2026-07', price: 1300 },
  { month: '2026-08', price: 1300 },
  { month: '2026-09', price: 1300 },
  { month: '2026-10', price: 1400 },
  { month: '2026-11', price: 1400 },
  { month: '2026-12', price: 1400 },
  { month: '2027-01', price: 1500 },
  { month: '2027-02', price: 1500 },
  { month: '2027-03', price: 1500 },
];

async function seed() {
  console.log('[seed] Starting...');

  // Upsert versions (skip if already exists)
  for (const v of INITIAL_VERSIONS) {
    await prisma.forecastVersion.upsert({
      where:  { name: v.name },
      update: { versionKey: v.versionKey, isStandard: v.isStandard },
      create: v,
    });
  }
  console.log(`[seed] Upserted ${INITIAL_VERSIONS.length} forecast versions`);

  // Upsert CPL prices (skip if already exists)
  for (const c of INITIAL_CPL_PRICES) {
    await prisma.cplPrice.upsert({
      where:  { month: c.month },
      update: {},
      create: c,
    });
    await prisma.$executeRaw`
      MERGE [dbo].[price_management_values] WITH (HOLDLOCK) AS target
      USING (SELECT ${c.month} AS [month], N'Fcst' AS [priceType], N'Current Forecast' AS [versionName]) AS source
      ON target.[month] = source.[month]
        AND target.[priceType] = source.[priceType]
        AND target.[versionName] = source.[versionName]
      WHEN NOT MATCHED THEN
        INSERT ([month], [priceType], [versionName], [cplPrice], [naphthaPrice], [benzenePrice])
        VALUES (${c.month}, N'Fcst', N'Current Forecast', ${c.price}, 0, 0);
    `;
  }
  console.log(`[seed] Upserted ${INITIAL_CPL_PRICES.length} CPL / Price Management rows`);

  await prisma.overplanConfig.upsert({
    where: { id: 'default' },
    update: {},
    create: { id: 'default' },
  });

  const recipientSeed = [
    { reportType: 'aggregate', email: 'taksaporn@ube.co.th', displayName: 'Taksaporn Poldongnok', sortOrder: 0 },
    { reportType: 'non_aggregate', email: 'taksaporn@ube.co.th', displayName: 'Taksaporn Poldongnok', sortOrder: 0 },
    { reportType: 'forecast_change', email: 'taksaporn@ube.co.th', displayName: 'Taksaporn Poldongnok', sortOrder: 0 },
  ] as const;

  for (const recipient of recipientSeed) {
    const existing = await prisma.overplanRecipient.findFirst({
      where: { reportType: recipient.reportType, email: recipient.email },
    });
    if (!existing) {
      await prisma.overplanRecipient.create({ data: recipient });
    }
  }
  console.log('[seed] Ensured overplan config and recipients');

  console.log('[seed] Done.');
  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error('[seed] Error:', err);
  prisma.$disconnect();
  process.exit(1);
});
