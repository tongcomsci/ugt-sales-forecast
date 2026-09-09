import * as XLSX from 'xlsx';
import prisma from '../../../db/prisma';
import {
  formatForecastPeriodForApi,
  parseForecastPeriodToDate,
} from '../../../lib/forecastPeriod';
import { businessUnitFromPlantCode } from '../businessUnit';
import {
  AMOUNT_MISMATCH_TOLERANCE,
  FCST_VERSION_SHEET,
  PREVIEW_IMPORTABLE_SAMPLE_SIZE,
  PREVIEW_OVERWRITE_SAMPLE_SIZE,
  PREVIEW_ISSUE_SAMPLE_SIZE,
  PREVIEW_UNIFIED_ROWS_SAMPLE_SIZE,
  PREVIEW_UNMATCHED_ROWS_SAMPLE_SIZE,
  VERSIONED_PREVIEW_CONTRACT_VERSION,
} from './constants';
import {
  chunkArray,
  getOnOffFromKey,
  primarySourceEntry,
  unknownToDisplayString,
} from './excelUtils';
import {
  diagnoseUnmatchedRows,
  findActualSummaries,
  findRegistrationMatches,
  isExcludedImportPlantKey,
  parseExcelKey,
} from './matching';
import { isOutOfAppModeImportKey } from '../../../config/appMode';
import {
  buildVersionedAutoCreatePackage,
  collectAutoCreateCandidates,
} from './autoCreateRegistrations';
import { isKnownPricingPolicy } from '../../../lib/pricingPolicy';
import { buildPricingPolicyByRegistrationId, buildSpreadByRegistrationId } from './importSpread';
import { storePreviewCache } from './previewCache';
import type {
  AmountMismatchWarning,
  ConfirmVersionedImportRecord,
  ImportHeaderError,
  UnifiedPreviewRow,
  UnmatchedRowDiagnostic,
  VersionedForecastColumn,
  VersionedNormalizedImportRecord,
} from './types';
import {
  mergeVersionedSheetResults,
  parseVersionedImportSheet,
  resolveVersionedImportSheets,
} from './versionedSheetParse';

const EXISTING_LOOKUP_CHUNK_SIZE = 500;

export type VersionedExpectedColumn = {
  month: string;
  period: string;
  qty: { col: string; index: number; header: string };
  price: { col: string; index: number; header: string };
  amount: { col: string; index: number; header: string };
};

export type VersionedPreviewResult = {
  previewId: string;
  previewContractVersion: number;
  importMode: 'versioned';
  targetVersion: string;
  excelVersionLabel: string;
  summary: {
    sheetName: string;
    sheetNames: string[];
    version: string;
    totalRows: number;
    validRows: number;
    importableRecords: number;
    candidateRecords: number;
    headerErrors: number;
    missingKeyRows: number;
    unmatchedRows: number;
    duplicateExcelKeys: number;
    duplicateRegistrationMatches: number;
    crossSheetDuplicateKeys: number;
    invalidNumericValues: number;
    existingDbConflicts: number;
    createRecords: number;
    overwriteRecords: number;
    matchedRows: number;
    actualOnlyRows: number;
    registrationOnlyRows: number;
    proposedRegistrationRows: number;
    registrationsToCreate: number;
    uniqueExcelKeys: number;
    groupedDuplicateKeys: number;
    skippedKeyGroups: number;
    excludedQty?: number;
    amountMismatchWarnings: number;
    pricingPoliciesDetected?: number;
    unknownPricingPolicies?: number;
    excelTotalQty?: number;
    excelTotalAmount?: number;
    importTotalQty?: number;
    importTotalAmount?: number;
  };
  expectedColumns: VersionedExpectedColumn[];
  detectedHeaders: Array<{ index: number; name: string }>;
  headerErrors: ImportHeaderError[];
  missingKeyRows: Array<{ sourceSheet: string; sourceRow: number }>;
  duplicateExcelKeys: Array<{
    excelKeyForNoRegist: string;
    sourceRows: number[];
    sourceSheet: string;
    entries: Array<{ sourceSheet: string; sourceRow: number }>;
  }>;
  crossSheetDuplicateKeys: Array<{
    excelKeyForNoRegist: string;
    entries: Array<{ sourceSheet: string; sourceRow: number }>;
  }>;
  skippedKeyGroups: Array<{
    excelKeyForNoRegist: string;
    sourceRows: number[];
    sourceSheet: string;
    reason: string;
    reasonCode: 'invalid_forecast_number' | 'excluded_plant';
    qtyExcluded: number;
  }>;
  unmatchedRows: UnmatchedRowDiagnostic[];
  duplicateRegistrationMatches: Array<{
    sourceSheet: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationIds: string[];
  }>;
  invalidNumericValues: Array<{
    sourceSheet: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    column: string;
    header: string;
    value: unknown;
    reason: string;
  }>;
  existingDbConflicts: [];
  overwriteRecords: Array<{
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationId: string;
    period: string;
    sourceMonthHeader: string;
    oldQtyFcst: number;
    newQtyFcst: number;
    oldPriceFcst: number;
    newPriceFcst: number;
  }>;
  amountMismatchWarnings: AmountMismatchWarning[];
  unifiedPreviewRows: UnifiedPreviewRow[];
  importableRecords: VersionedNormalizedImportRecord[];
};

function buildExpectedColumns(forecastColumns: VersionedForecastColumn[]): VersionedExpectedColumn[] {
  return forecastColumns.map(column => ({
    month: column.month,
    period: column.period,
    qty: {
      col: column.col,
      index: column.qtyIndex,
      header: column.header,
    },
    price: {
      col: column.priceIndex >= 0 ? XLSX.utils.encode_col(column.priceIndex) : '-',
      index: column.priceIndex,
      header: column.priceHeader,
    },
    amount: {
      col: column.amountIndex >= 0 ? XLSX.utils.encode_col(column.amountIndex) : '-',
      index: column.amountIndex,
      header: column.amountHeader,
    },
  }));
}

function toConfirmRecords(records: VersionedNormalizedImportRecord[]): ConfirmVersionedImportRecord[] {
  return records.map(record => ({
    excelKeyForNoRegist: record.excelKeyForNoRegist,
    matchedRegistrationId: record.matchedRegistrationId,
    period: record.period,
    granularity: record.granularity,
    qtyFcst: record.qtyFcst,
    priceFcst: record.priceFcst,
    amountFcst: record.amountFcst,
  }));
}

async function loadExistingForecastRows(
  versionName: string,
  registrationIds: string[],
  periods: string[]
) {
  if (registrationIds.length === 0 || periods.length === 0) return [];

  const periodDates = periods.map(period => parseForecastPeriodToDate(period, 'month'));
  const rows = [];

  for (const registrationChunk of chunkArray(registrationIds, EXISTING_LOOKUP_CHUNK_SIZE)) {
    const chunkRows = await prisma.forecastValue.findMany({
      where: {
        versionName,
        registrationId: { in: registrationChunk },
        period: { in: periodDates },
      },
      select: {
        registrationId: true,
        period: true,
        qtyFcst: true,
        priceFcst: true,
        amountFcst: true,
        granularity: true,
      },
    });
    rows.push(...chunkRows);
  }

  return rows;
}

export async function buildVersionedImportPreview(
  workbook: XLSX.WorkBook,
  targetVersion: string,
  excelVersionLabel: string,
  versionExists: boolean
): Promise<VersionedPreviewResult> {
  const resolvedSheets = resolveVersionedImportSheets(workbook);
  const sheetResults = resolvedSheets.map(({ sheetName, sheet }) =>
    parseVersionedImportSheet(sheetName, sheet)
  );
  const merged = mergeVersionedSheetResults(sheetResults);
  const {
    sheetNames,
    totalDataRows,
    forecastColumns,
    hasPriceColumns,
    hasAmountColumns,
    detectedHeaders,
    missingKeyRows,
    invalidNumericValues,
    excelGroups,
    crossSheetDuplicateKeys,
  } = merged;

  const headerErrors: ImportHeaderError[] = [...merged.headerErrors];
  if (!versionExists) {
    headerErrors.push({
      sourceSheet: FCST_VERSION_SHEET,
      column: 'A2',
      expected: `Forecast version "${targetVersion}" must exist in forecast_versions`,
      actual: excelVersionLabel,
    });
  }

  const sheetNameLabel = sheetNames.length > 0 ? sheetNames.join(' + ') : '';
  const expectedColumns = buildExpectedColumns(forecastColumns);

  const duplicateExcelKeys = [...excelGroups.values()]
    .filter(group => group.sourceSheetRows.length > 1)
    .map(group => ({
      excelKeyForNoRegist: group.keyNoRegist,
      sourceRows: group.sourceRows,
      sourceSheet: primarySourceEntry(group).sourceSheet,
      entries: group.sourceSheetRows,
    }));

  const skippedKeyGroups = [...excelGroups.values()]
    .flatMap(group => {
      const primary = primarySourceEntry(group);
      const qtyExcluded = group.forecastValues.reduce((sum, value) => sum + value, 0);
      const items: Array<{
        excelKeyForNoRegist: string;
        sourceRows: number[];
        sourceSheet: string;
        reason: string;
        reasonCode: 'invalid_forecast_number' | 'excluded_plant';
        qtyExcluded: number;
      }> = [];

      if (isExcludedImportPlantKey(group.keyNoRegist)) {
        items.push({
          excelKeyForNoRegist: group.keyNoRegist,
          sourceRows: group.sourceRows,
          sourceSheet: primary.sourceSheet,
          reason: `Plant ${parseExcelKey(group.keyNoRegist).plant || 'excluded'} is excluded from import`,
          reasonCode: 'excluded_plant',
          qtyExcluded,
        });
      } else if (isOutOfAppModeImportKey(group.keyNoRegist, group.businessUnit)) {
        items.push({
          excelKeyForNoRegist: group.keyNoRegist,
          sourceRows: group.sourceRows,
          sourceSheet: primary.sourceSheet,
          reason: 'Business unit is outside this application mode',
          reasonCode: 'excluded_plant',
          qtyExcluded,
        });
      }

      if (group.hasInvalidNumber) {
        const invalids = invalidNumericValues.filter(
          item => item.excelKeyForNoRegist === group.keyNoRegist
        );
        const reason = invalids.length > 0
          ? invalids
            .map(item => `Invalid number in ${item.header} (col ${item.column}): "${unknownToDisplayString(item.value)}"`)
            .join('; ')
          : 'Invalid forecast number in one or more month columns';
        items.push({
          excelKeyForNoRegist: group.keyNoRegist,
          sourceRows: group.sourceRows,
          sourceSheet: primary.sourceSheet,
          reason,
          reasonCode: 'invalid_forecast_number',
          qtyExcluded,
        });
      }

      return items;
    });
  const excludedQty = skippedKeyGroups
    .filter(item => item.reasonCode === 'excluded_plant')
    .reduce((sum, item) => sum + item.qtyExcluded, 0);
  const excludedPlantKeys = new Set(
    skippedKeyGroups
      .filter(item => item.reasonCode === 'excluded_plant')
      .map(item => item.excelKeyForNoRegist)
  );
  const importableExcelKeys = [...excelGroups.keys()].filter(key => !excludedPlantKeys.has(key));

  const [registrationMatches, actualSummaries] = await Promise.all([
    findRegistrationMatches(importableExcelKeys),
    findActualSummaries(importableExcelKeys, forecastColumns),
  ]);
  const spreadByRegistrationId = buildSpreadByRegistrationId(excelGroups, registrationMatches);
  const pricingPolicyByRegistrationId = buildPricingPolicyByRegistrationId(
    excelGroups,
    registrationMatches,
  );

  const unmatchedRows: UnmatchedRowDiagnostic[] = [];
  const duplicateRegistrationMatches: Array<{
    sourceSheet: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationIds: string[];
  }> = [];
  const candidateRecords: VersionedNormalizedImportRecord[] = [];
  const amountMismatchWarnings: AmountMismatchWarning[] = [];
  const rawUnmatchedRows: Array<{ sourceSheet: string; sourceRow: number; excelKeyForNoRegist: string }> = [];

  for (const group of excelGroups.values()) {
    if (excludedPlantKeys.has(group.keyNoRegist)) continue;

    const primary = primarySourceEntry(group);
    const sourceRow = primary.sourceRow;
    const excelKeyForNoRegist = group.keyNoRegist;
    const matches = registrationMatches.get(group.keyNoRegist) ?? [];

    if (matches.length === 0) {
      rawUnmatchedRows.push({
        sourceSheet: primary.sourceSheet,
        sourceRow,
        excelKeyForNoRegist,
      });
      continue;
    }

    if (matches.length > 1) {
      duplicateRegistrationMatches.push({
        sourceSheet: primary.sourceSheet,
        sourceRow,
        excelKeyForNoRegist,
        matchedRegistrationIds: matches.map(match => match.registrationId),
      });
    }

    const rowRecords: VersionedNormalizedImportRecord[] = forecastColumns.map((forecastColumn, forecastIndex) => {
      const qtyFcst = group.forecastValues[forecastIndex];
      const priceFcst = group.priceValues[forecastIndex];
      const amountFcst = group.amountValues[forecastIndex];

      if (amountFcst > 0) {
        const expectedAmount = qtyFcst * priceFcst;
        const difference = Math.abs(expectedAmount - amountFcst);
        if (difference / amountFcst > AMOUNT_MISMATCH_TOLERANCE) {
          amountMismatchWarnings.push({
            sourceSheet: primary.sourceSheet,
            sourceRow,
            excelKeyForNoRegist,
            forecastMonth: forecastColumn.month,
            qtyFcst,
            priceFcst,
            amountFcst,
            expectedAmount,
            difference,
          });
        }
      }

      return {
        sourceRow,
        excelKeyForNoRegist,
        matchedRegistrationId: matches[0].registrationId,
        version: targetVersion,
        sourceColumn: forecastColumn.col,
        sourceMonthHeader: forecastColumn.header,
        forecastMonth: forecastColumn.month,
        period: forecastColumn.period,
        granularity: 'month' as const,
        qtyFcst,
        priceFcst,
        amountFcst,
      };
    });

    candidateRecords.push(...rowRecords);
  }

  unmatchedRows.push(...await diagnoseUnmatchedRows(rawUnmatchedRows, actualSummaries));

  const autoCreateCandidates = collectAutoCreateCandidates(
    excelGroups,
    rawUnmatchedRows.map(row => row.excelKeyForNoRegist),
    group => buildVersionedAutoCreatePackage(group, forecastColumns)
  );

  const hasBlockingHeaderErrors = headerErrors.length > 0;
  const matchedRegistrationIds = hasBlockingHeaderErrors
    ? []
    : [...new Set(candidateRecords.map(record => record.matchedRegistrationId))];
  const periods = forecastColumns.map(column => column.period);
  const existingRows = hasBlockingHeaderErrors
    ? []
    : await loadExistingForecastRows(targetVersion, matchedRegistrationIds, periods);

  const existingRowMap = new Map(
    existingRows.map(row => [
      `${row.registrationId}|${formatForecastPeriodForApi(row.period, row.granularity)}`,
      row,
    ])
  );

  const importableRecords = hasBlockingHeaderErrors
    ? []
    : candidateRecords.map(record => {
        const existing = existingRowMap.get(
          `${record.matchedRegistrationId}|${formatForecastPeriodForApi(
            parseForecastPeriodToDate(record.period, 'month'),
            'month'
          )}`
        );
        return {
          ...record,
          action: existing ? 'overwrite' as const : 'create' as const,
          oldQtyFcst: existing ? Number(existing.qtyFcst) : null,
          oldPriceFcst: existing ? Number(existing.priceFcst) : null,
          oldAmountFcst: existing ? Number(existing.amountFcst) : null,
        };
      });

  const overwriteRecords = importableRecords
    .filter(record => record.action === 'overwrite')
    .map(record => ({
      sourceRow: record.sourceRow,
      excelKeyForNoRegist: record.excelKeyForNoRegist,
      matchedRegistrationId: record.matchedRegistrationId,
      period: record.period,
      sourceMonthHeader: record.sourceMonthHeader,
      oldQtyFcst: record.oldQtyFcst ?? 0,
      newQtyFcst: record.qtyFcst,
      oldPriceFcst: record.oldPriceFcst ?? 0,
      newPriceFcst: record.priceFcst,
    }));
  const createRecords = importableRecords.filter(record => record.action === 'create');

  const unifiedPreviewRows: UnifiedPreviewRow[] = [];
  const previewKeySet = new Set<string>();

  for (const group of excelGroups.values()) {
    const matches = registrationMatches.get(group.keyNoRegist) ?? [];
    const registration = matches[0];
    const actual = actualSummaries.get(group.keyNoRegist);
    const hasActual = Boolean(actual);
    previewKeySet.add(group.keyNoRegist);

    if (!registration) {
      unifiedPreviewRows.push({
        sourceRow: group.sourceRows[0],
        sourceRows: group.sourceRows,
        status: 'proposed_registration',
        keyRegist: null,
        keyNoRegist: group.keyNoRegist,
        country: actual?.country ?? group.country,
        soldTo: actual?.soldTo ?? group.soldTo,
        shipTo: actual?.shipTo ?? group.shipTo,
        enduser: actual?.enduser ?? group.enduser,
        plant: actual?.plant ?? group.plant,
        materialCode: actual?.materialCode ?? group.materialCode,
        onOff: group.onOff ?? getOnOffFromKey(group.keyNoRegist),
        process: group.process,
        application: group.application,
        subApplication: group.subApplication,
        owner: group.owner,
        qtyActual: Number(actual?.qtyActual ?? 0),
        qtyFcst: group.forecastValues.reduce((sum, value) => sum + value, 0),
        businessUnit: group.businessUnit ?? businessUnitFromPlantCode(actual?.plant ?? group.plant),
        dimensionSource: actual ? 'actual_with_excel_fallback' : 'excel',
      });
      continue;
    }

    unifiedPreviewRows.push({
      sourceRow: group.sourceRows[0],
      sourceRows: group.sourceRows,
      status: hasActual ? 'matched' : 'registration_only',
      keyRegist: registration.registrationId,
      keyNoRegist: group.keyNoRegist,
      country: registration.country ?? actual?.country ?? null,
      soldTo: registration.soldTo ?? actual?.soldTo ?? null,
      shipTo: registration.shipTo ?? actual?.shipTo ?? null,
      enduser: registration.enduser ?? actual?.enduser ?? null,
      plant: registration.plant ?? actual?.plant ?? null,
      materialCode: registration.materialCode ?? actual?.materialCode ?? null,
      onOff: registration.onOff ?? getOnOffFromKey(group.keyNoRegist),
      process: registration.process,
      application: registration.application,
      subApplication: registration.subApplication,
      owner: registration.owner,
      qtyActual: Number(actual?.qtyActual ?? 0),
      qtyFcst: group.forecastValues.reduce((sum, value) => sum + value, 0),
      businessUnit: registration.businessUnit ?? group.businessUnit,
      dimensionSource: hasActual ? 'registration_with_actual_fallback' : 'registration',
    });
  }

  for (const actual of actualSummaries.values()) {
    if (actual.keyForRegist || previewKeySet.has(actual.keyForNoRegist)) continue;
    unifiedPreviewRows.push({
      sourceRow: null,
      sourceRows: [],
      status: 'actual_only',
      keyRegist: null,
      keyNoRegist: actual.keyForNoRegist,
      country: actual.country,
      soldTo: actual.soldTo,
      shipTo: actual.shipTo,
      enduser: actual.enduser,
      plant: actual.plant,
      materialCode: actual.materialCode,
      onOff: getOnOffFromKey(actual.keyForNoRegist),
      process: null,
      application: null,
      subApplication: null,
      owner: null,
      qtyActual: Number(actual.qtyActual),
      qtyFcst: 0,
      businessUnit: null,
      dimensionSource: 'actual',
    });
  }

  unifiedPreviewRows.sort((left, right) => {
    const order = { matched: 0, registration_only: 1, proposed_registration: 2, actual_only: 3 };
    return order[left.status] - order[right.status] || left.keyNoRegist.localeCompare(right.keyNoRegist);
  });

  const matchedRows = unifiedPreviewRows.filter(row => row.status === 'matched').length;
  const actualOnlyRows = unifiedPreviewRows.filter(row => row.status === 'actual_only').length;
  const registrationOnlyRows = unifiedPreviewRows.filter(row => row.status === 'registration_only').length;
  const proposedRegistrationRows = unifiedPreviewRows.filter(row => row.status === 'proposed_registration').length;

  const pendingImportRecords = autoCreateCandidates.reduce(
    (sum, candidate) => sum + candidate.pendingForecastRecords.length,
    0
  );
  const excelTotalQty = [...excelGroups.values()].reduce(
    (sum, group) => sum + group.forecastValues.reduce((groupSum, value) => groupSum + value, 0),
    0
  );
  const excelTotalAmount = [...excelGroups.values()].reduce(
    (sum, group) => sum + group.amountValues.reduce((groupSum, value) => groupSum + value, 0),
    0
  );
  const importTotalQty = candidateRecords.reduce((sum, record) => sum + record.qtyFcst, 0)
    + autoCreateCandidates.reduce(
      (sum, candidate) => sum + candidate.pendingForecastRecords.reduce((inner, record) => inner + record.qtyFcst, 0),
      0
    );
  const importTotalAmount = candidateRecords.reduce((sum, record) => sum + record.amountFcst, 0)
    + autoCreateCandidates.reduce(
      (sum, candidate) => sum + candidate.pendingForecastRecords.reduce((inner, record) => inner + record.amountFcst, 0),
      0
    );
  const pricingPoliciesDetected = [...excelGroups.values()].filter(group => group.pricingPolicy).length;
  const unknownPricingPolicies = [...excelGroups.values()].filter(
    group => group.pricingPolicy && !isKnownPricingPolicy(group.pricingPolicy)
  ).length;

  const cacheEntry = storePreviewCache({
    importMode: 'versioned',
    previewContractVersion: VERSIONED_PREVIEW_CONTRACT_VERSION,
    targetVersion,
    versionedRecords: toConfirmRecords(importableRecords),
    versionedHasPriceColumns: hasPriceColumns,
    versionedHasAmountColumns: hasAmountColumns,
    amountMismatchCount: amountMismatchWarnings.length,
    autoCreateCandidates,
    spreadByRegistrationId,
    pricingPolicyByRegistrationId,
  });

  return {
    previewId: cacheEntry.previewId,
    previewContractVersion: VERSIONED_PREVIEW_CONTRACT_VERSION,
    importMode: 'versioned',
    targetVersion,
    excelVersionLabel,
    summary: {
      sheetName: sheetNameLabel,
      sheetNames,
      version: targetVersion,
      totalRows: totalDataRows,
      validRows: hasBlockingHeaderErrors ? 0 : totalDataRows,
      importableRecords: importableRecords.length + pendingImportRecords,
      candidateRecords: candidateRecords.length + pendingImportRecords,
      headerErrors: headerErrors.length,
      missingKeyRows: missingKeyRows.length,
      unmatchedRows: unmatchedRows.length,
      duplicateExcelKeys: duplicateExcelKeys.length,
      duplicateRegistrationMatches: duplicateRegistrationMatches.length,
      crossSheetDuplicateKeys: crossSheetDuplicateKeys.length,
      invalidNumericValues: invalidNumericValues.length,
      existingDbConflicts: 0,
      createRecords: createRecords.length,
      overwriteRecords: overwriteRecords.length,
      matchedRows,
      actualOnlyRows,
      registrationOnlyRows,
      proposedRegistrationRows,
      registrationsToCreate: autoCreateCandidates.length,
      uniqueExcelKeys: excelGroups.size,
      groupedDuplicateKeys: duplicateExcelKeys.length,
      skippedKeyGroups: skippedKeyGroups.length,
      excludedQty,
      amountMismatchWarnings: amountMismatchWarnings.length,
      pricingPoliciesDetected,
      unknownPricingPolicies,
      excelTotalQty,
      excelTotalAmount,
      importTotalQty,
      importTotalAmount,
    },
    expectedColumns,
    detectedHeaders,
    headerErrors: headerErrors.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    missingKeyRows: missingKeyRows.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    duplicateExcelKeys: duplicateExcelKeys.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    crossSheetDuplicateKeys: crossSheetDuplicateKeys.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    skippedKeyGroups: skippedKeyGroups.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    unmatchedRows: unmatchedRows.slice(0, PREVIEW_UNMATCHED_ROWS_SAMPLE_SIZE),
    duplicateRegistrationMatches: duplicateRegistrationMatches.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    invalidNumericValues: invalidNumericValues.slice(0, PREVIEW_ISSUE_SAMPLE_SIZE),
    existingDbConflicts: [],
    overwriteRecords: overwriteRecords.slice(0, PREVIEW_OVERWRITE_SAMPLE_SIZE),
    amountMismatchWarnings: amountMismatchWarnings.slice(0, PREVIEW_UNMATCHED_ROWS_SAMPLE_SIZE),
    unifiedPreviewRows: unifiedPreviewRows.slice(0, PREVIEW_UNIFIED_ROWS_SAMPLE_SIZE),
    importableRecords: importableRecords.slice(0, PREVIEW_IMPORTABLE_SAMPLE_SIZE),
  };
}
