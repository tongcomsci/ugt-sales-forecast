/**
 * Guards the month/week identity of forecast_values (audit item 3).
 *
 * A monthly row is stored on the 1st of the month; a weekly row is stored on the
 * first Wednesday. When the 1st IS a Wednesday both land on the same date, so
 * granularity has to be part of the row identity — otherwise one silently
 * overwrites the other and the MERGE flips the surviving row's granularity.
 *
 * Run: npx tsx scripts/verify-forecast-granularity-key.mjs
 *
 * The source checks run offline. The schema check needs DATABASE_URL and is
 * skipped (not failed) when the database is unreachable, so the offline checks
 * stay useful in CI.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import 'dotenv/config';

// --- 1. every MERGE into forecast_values must key on granularity ------------
// Without it a week import matches a month row, then rewrites its granularity.
const mergeSources = [
  'src/api/routes/forecast.ts',
  'src/api/services/forecastImport/confirmImport.ts',
];

let mergeBlocksChecked = 0;
for (const file of mergeSources) {
  const sql = readFileSync(file, 'utf8');
  // Each MERGE runs from the MERGE keyword to its first WHEN clause.
  const blocks = sql.matchAll(
    /MERGE\s+(?:\[dbo\]\.\[forecast_values\]|dbo\.forecast_values)[\s\S]*?WHEN\s+MATCHED/gi
  );
  for (const [block] of blocks) {
    mergeBlocksChecked += 1;
    const onClause = block.slice(block.search(/\bON\b/));
    assert.match(
      onClause,
      /granularity/i,
      `${file}: a MERGE into forecast_values does not match on granularity, so a ` +
      `week row can match a month row on the same date. ON clause:\n${onClause.trim()}`
    );
  }
}
assert.ok(
  mergeBlocksChecked >= 3,
  `expected at least 3 MERGE statements into forecast_values, found ${mergeBlocksChecked}`
);

// --- 2. the Prisma model must declare granularity in its id ----------------
const schema = readFileSync('prisma/schema.prisma', 'utf8');
const model = schema.slice(schema.indexOf('model ForecastValue'));
const idLine = model.slice(model.indexOf('@@id')).split('\n')[0];
assert.match(
  idLine,
  /granularity/,
  `prisma/schema.prisma: ForecastValue @@id must include granularity, got: ${idLine.trim()}`
);

// --- 3. the live primary key must match the model -------------------------
const { default: prisma } = await import('../src/db/prisma.ts');
let pkColumns;
try {
  const rows = await prisma.$queryRawUnsafe(`
    SELECT c.name AS columnName
    FROM sys.key_constraints kc
    JOIN sys.indexes i
      ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
    JOIN sys.index_columns ic
      ON ic.object_id = i.object_id AND ic.index_id = i.index_id
    JOIN sys.columns c
      ON c.object_id = ic.object_id AND c.column_id = ic.column_id
    WHERE kc.parent_object_id = OBJECT_ID(N'[dbo].[forecast_values]')
      AND kc.type = 'PK'
    ORDER BY ic.key_ordinal
  `);
  pkColumns = rows.map(row => row.columnName);
} catch (error) {
  console.log(`[verify-forecast-granularity-key] SKIP schema check — ${String(error.message).split('\n')[0]}`);
}
await prisma.$disconnect();

if (pkColumns) {
  assert.deepEqual(
    pkColumns,
    ['registrationId', 'versionName', 'period', 'granularity'],
    `live primary key on dbo.forecast_values is [${pkColumns.join(', ')}] — ` +
    'granularity is missing, so a week row and a month row on the same date collide'
  );
}

console.log(
  `[verify-forecast-granularity-key] OK (${mergeBlocksChecked} MERGE blocks` +
  `${pkColumns ? ', live PK verified' : ', schema check skipped'})`
);
