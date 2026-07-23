// Compares an uploaded Excel forecast file against what the import pipeline
// would actually write, without sending the file anywhere — runs fully local
// against the same DB/pipeline code the app uses.
//
// Usage:
//   npx tsx scripts/check-excel-vs-platform.mjs <path-to-excel.xlsx> [targetVersion] [--plant=1104]
//
// targetVersion is only needed for versioned workbooks (e.g. "SepF FY26") if
// the "Fcst Version" sheet label doesn't match a version name in the DB.
// --plant=<code> narrows every section to keys whose plant segment matches,
// and additionally prints what's already sitting in forecast_values in the DB
// for the registrations those keys match.
// Set APP_MODE=ufa in the environment if the file is a UFA workbook.

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import prisma from '../src/db/prisma.ts';
import { detectImportFormat, readExcelVersionLabel } from '../src/api/services/forecastImport/detectFormat.ts';
import { buildLegacyImportPreview } from '../src/api/services/forecastImport/buildLegacyPreview.ts';
import { buildVersionedImportPreview } from '../src/api/services/forecastImport/buildVersionedPreview.ts';
import { findRegistrationMatches, parseExcelKey } from '../src/api/services/forecastImport/matching.ts';
import { parseForecastPeriodToDate } from '../src/lib/forecastPeriod.ts';
import {
  resolveVersionedImportSheets,
  parseVersionedImportSheet,
  mergeVersionedSheetResults,
} from '../src/api/services/forecastImport/versionedSheetParse.ts';
import {
  resolveLegacyImportSheets,
  parseLegacyImportSheet,
  mergeLegacySheetResults,
} from '../src/api/services/forecastImport/legacySheetParse.ts';

const positionalArgs = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const plantFilter = process.argv.slice(2).find(arg => arg.startsWith('--plant='))?.split('=')[1];
const filePath = positionalArgs[0];
if (!filePath) {
  console.error('Usage: npx tsx scripts/check-excel-vs-platform.mjs <path-to-excel.xlsx> [targetVersion] [--plant=1104]');
  process.exit(1);
}

function sumGroupQty(group) {
  return group.forecastValues.reduce((sum, value) => sum + value, 0);
}

function printKeyList(title, items, excelGroups) {
  console.log(`\n=== ${title} (${items.length}) ===`);
  if (items.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const item of items) {
    const group = excelGroups?.get(item.excelKeyForNoRegist);
    const qty = group ? sumGroupQty(group).toFixed(4) : 'n/a';
    const detail = item.matchedRegistrationIds
      ? `matches: ${item.matchedRegistrationIds.join(', ')}`
      : item.reason ?? item.reasonCode ?? '';
    console.log(`  key=${item.excelKeyForNoRegist}  qty=${qty}  ${detail}`);
  }
}

const workbook = XLSX.read(readFileSync(filePath), { type: 'buffer', cellDates: false });
const mode = detectImportFormat(workbook);
console.log(`File: ${filePath}`);
console.log(`Detected import mode: ${mode}`);

let preview;
let excelGroups;
let forecastColumns;

if (mode === 'versioned') {
  const excelVersionLabel = readExcelVersionLabel(workbook) ?? '';
  const targetVersion = positionalArgs[1] ?? excelVersionLabel;
  if (!targetVersion) {
    console.error('Could not detect target version from the "Fcst Version" sheet — pass it as the 2nd argument.');
    process.exit(1);
  }
  const version = await prisma.forecastVersion.findUnique({ where: { name: targetVersion } });
  console.log(`Target version: ${targetVersion} (exists in DB: ${Boolean(version)})`);

  preview = await buildVersionedImportPreview(workbook, targetVersion, excelVersionLabel, Boolean(version));

  const resolvedSheets = resolveVersionedImportSheets(workbook);
  const merged = mergeVersionedSheetResults(
    resolvedSheets.map(({ sheetName, sheet }) => parseVersionedImportSheet(sheetName, sheet))
  );
  excelGroups = merged.excelGroups;
  forecastColumns = merged.forecastColumns;
} else {
  preview = await buildLegacyImportPreview(workbook);

  const resolvedSheets = resolveLegacyImportSheets(workbook);
  const merged = mergeLegacySheetResults(
    resolvedSheets.map(({ sheetName, sheet }) => parseLegacyImportSheet(sheetName, sheet))
  );
  excelGroups = merged.excelGroups;
  forecastColumns = merged.extendedColumns;
}

const s = preview.summary;
console.log('\n=== TOTALS ===');
console.log(`Excel qty:    ${s.excelTotalQty?.toFixed(4)}`);
console.log(`Import qty:   ${s.importTotalQty?.toFixed(4)}`);
console.log(`Diff (qty):   ${(s.excelTotalQty - s.importTotalQty).toFixed(4)}`);
console.log(`Excel amount: ${s.excelTotalAmount?.toFixed(2)}`);
console.log(`Import amt:   ${s.importTotalAmount?.toFixed(2)}`);
console.log(`Diff (amt):   ${(s.excelTotalAmount - s.importTotalAmount).toFixed(2)}`);

printKeyList('Skipped Key Groups (excluded plant / invalid number — entire key dropped)', preview.skippedKeyGroups, excelGroups);
printKeyList('Duplicate Registration Matches (qty still imported, using 1st match)', preview.duplicateRegistrationMatches, excelGroups);
printKeyList(`Unmatched Rows (no registration found; showing up to 100, total=${s.unmatchedRows})`, preview.unmatchedRows, excelGroups);

if (plantFilter) {
  console.log(`\n\n########## PLANT FILTER: ${plantFilter} ##########`);

  const skippedKeys = new Set(preview.skippedKeyGroups.map(item => item.excelKeyForNoRegist));
  const unmatchedKeys = new Set(preview.unmatchedRows.map(item => item.excelKeyForNoRegist));
  const duplicateKeys = new Map(
    preview.duplicateRegistrationMatches.map(item => [item.excelKeyForNoRegist, item.matchedRegistrationIds])
  );

  const plantKeys = [...excelGroups.entries()].filter(
    ([key]) => parseExcelKey(key).plant === plantFilter
  );

  console.log(`\nKeys with plant=${plantFilter}: ${plantKeys.length}`);
  const matchesByKey = await findRegistrationMatches(plantKeys.map(([key]) => key));
  const allMatchedIds = new Set();

  for (const [key, group] of plantKeys) {
    const qty = sumGroupQty(group).toFixed(4);
    const status = skippedKeys.has(key)
      ? 'SKIPPED (not saved)'
      : duplicateKeys.has(key)
        ? `DUPLICATE MATCH → ${duplicateKeys.get(key).join(', ')}`
        : unmatchedKeys.has(key)
          ? 'UNMATCHED (auto-create on confirm)'
          : 'matched';
    const matches = matchesByKey.get(key) ?? [];
    for (const match of matches) allMatchedIds.add(match.registrationId);
    console.log(`  key=${key}  qty=${qty}  status=${status}`);
    for (const match of matches) {
      console.log(`      -> registrationId=${match.registrationId}  plant=${match.plant}  businessUnit=${match.businessUnit}`);
    }
  }

  const excelByPeriod = new Map();
  for (const [key, group] of plantKeys) {
    forecastColumns.forEach((column, index) => {
      excelByPeriod.set(column.period, (excelByPeriod.get(column.period) ?? 0) + group.forecastValues[index]);
    });
  }

  const matchedIds = [...allMatchedIds];
  const periods = forecastColumns.map(column => parseForecastPeriodToDate(column.period, mode === 'versioned' ? 'month' : 'week'));
  const dbRows = matchedIds.length > 0
    ? await prisma.forecastValue.findMany({
        where: { versionName: s.version, registrationId: { in: matchedIds }, period: { in: periods } },
        select: { period: true, qtyFcst: true },
      })
    : [];
  const dbByPeriod = new Map();
  for (const row of dbRows) {
    const key = row.period.toISOString().slice(0, 10);
    dbByPeriod.set(key, (dbByPeriod.get(key) ?? 0) + Number(row.qtyFcst));
  }

  console.log(`\nPer-period comparison for plant ${plantFilter} (version "${s.version}"):`);
  console.log('  period       excel_qty     db_qty        diff');
  let totalExcel = 0;
  let totalDb = 0;
  for (const column of forecastColumns) {
    const excelQty = excelByPeriod.get(column.period) ?? 0;
    const dbQty = dbByPeriod.get(column.period) ?? 0;
    totalExcel += excelQty;
    totalDb += dbQty;
    if (excelQty === 0 && dbQty === 0) continue;
    console.log(
      `  ${column.period}  ${excelQty.toFixed(4).padStart(10)}  ${dbQty.toFixed(4).padStart(10)}  ${(excelQty - dbQty).toFixed(4).padStart(10)}`
    );
  }
  console.log(`  TOTAL        ${totalExcel.toFixed(4).padStart(10)}  ${totalDb.toFixed(4).padStart(10)}  ${(totalExcel - totalDb).toFixed(4).padStart(10)}`);
}

await prisma.$disconnect();
process.exit(0);
