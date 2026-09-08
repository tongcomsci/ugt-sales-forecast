// READ-ONLY diagnostic for the 2026-09 audit (docs/system-audit.md).
// Sizes up the month/week PK collision and pricing-policy coverage. SELECT only.
import 'dotenv/config';
import prisma from '../src/db/prisma.ts';


const q = (label, sql) => prisma.$queryRawUnsafe(sql).then(rows => ({ label, rows }));

const checks = [
  ['1. จำนวนแถวแยกตาม granularity', `
    SELECT [granularity], COUNT(*) AS [rows], COUNT(DISTINCT [versionName]) AS [versions]
    FROM [dbo].[forecast_values] GROUP BY [granularity]`],

  ['2. week rows ที่ตกวันที่ 1 (ชนกับ month slot)', `
    SELECT [versionName], [period], COUNT(*) AS [rows], SUM([qtyFcst]) AS [totalQty]
    FROM [dbo].[forecast_values]
    WHERE [granularity] = N'week' AND DAY([period]) = 1
    GROUP BY [versionName], [period] ORDER BY [period]`],

  ['3. month rows ที่ไม่ได้ตกวันที่ 1 (ผิดปกติ)', `
    SELECT [versionName], [period], COUNT(*) AS [rows]
    FROM [dbo].[forecast_values]
    WHERE [granularity] = N'month' AND DAY([period]) <> 1
    GROUP BY [versionName], [period] ORDER BY [period]`],

  ['4. เดือนที่วันที่ 1 เป็นวันพุธ และมีข้อมูลอยู่', `
    SELECT [granularity], [period], COUNT(*) AS [rows]
    FROM [dbo].[forecast_values]
    WHERE DAY([period]) = 1 AND DATEPART(WEEKDAY, [period]) = 4
    GROUP BY [granularity], [period] ORDER BY [period]`],

  ['5. spread ที่เป็นข้อความ (ทำ FactForecast error - ข้อ 2)', `
    SELECT TOP 20 [registrationId], [pricingPolicy], [spread]
    FROM [dbo].[registration_price_settings]
    WHERE [spread] IS NOT NULL AND [spread] <> N''
      AND TRY_CONVERT(DECIMAL(18,4), [spread]) IS NULL`],

  ['6. นับ spread ข้อความ vs ตัวเลข', `
    SELECT
      SUM(CASE WHEN TRY_CONVERT(DECIMAL(18,4), [spread]) IS NULL
                AND [spread] IS NOT NULL AND [spread] <> N'' THEN 1 ELSE 0 END) AS [textSpread],
      SUM(CASE WHEN TRY_CONVERT(DECIMAL(18,4), [spread]) IS NOT NULL THEN 1 ELSE 0 END) AS [numericSpread],
      COUNT(*) AS [total]
    FROM [dbo].[registration_price_settings]`],

  ['7. pricingPolicy ที่ใช้จริง (FactForecast มองไม่เห็น - ข้อ 2)', `
    SELECT [pricingPolicy], COUNT(*) AS [registrations]
    FROM [dbo].[registration_price_settings]
    WHERE [pricingPolicy] IS NOT NULL AND [pricingPolicy] <> N''
    GROUP BY [pricingPolicy] ORDER BY COUNT(*) DESC`],
];

const json = (v) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? Number(x) : x, 2);

for (const [label, sql] of checks) {
  try {
    const { rows } = await q(label, sql);
    console.log(`\n=== ${label} ===`);
    console.log(rows.length === 0 ? '  (ไม่พบข้อมูล)' : json(rows));
  } catch (error) {
    console.log(`\n=== ${label} ===`);
    console.log(`  ERROR: ${error.message.split('\n')[0]}`);
  }
}

await prisma.$disconnect();
