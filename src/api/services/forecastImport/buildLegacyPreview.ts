import type * as XLSX from 'xlsx';
import prisma from '../../../db/prisma';
import {
  formatForecastPeriodForApi,
  parseForecastPeriodToDate,
} from '../../../lib/forecastPeriod';
import type { CurrentForecastImportPreview } from '../../../lib/api';
import { businessUnitFromPlantCode } from '../businessUnit';
import { isKnownPricingPolicy } from '../../../lib/pricingPolicy';
import { CURRENT_FORECAST_VERSION, LEGACY_PREVIEW_CONTRACT_VERSION, PREVIEW_IMPORTABLE_SAMPLE_SIZE, PREVIEW_OVERWRITE_SAMPLE_SIZE,
  PREVIEW_ISSUE_SAMPLE_SIZE, PREVIEW_UNIFIED_ROWS_SAMPLE_SIZE, PREVIEW_UNMATCHED_ROWS_SAMPLE_SIZE } from './constants';
import { getOnOffFromKey, primarySourceEntry, unknownToDisplayString } from './excelUtils';
import {
  mergeLegacySheetResults,
  parseLegacyImportSheet,
  resolveLegacyImportSheets,
} from './legacySheetParse';
import {
  diagnoseUnmatchedRows,
  findActualSummaries,
  findRegistrationMatches,
  isExcludedImportPlantKey,
  parseExcelKey,
} from './matching';
import { isOutOfAppModeImportKey } from '../../../config/appMode';
import {
  buildLegacyAutoCreatePackage,
  collectAutoCreateCandidates,
} from './autoCreateRegistrations';
import { buildPricingPolicyByRegistrationId, buildSpreadByRegistrationId } from './importSpread';
import type { ConfirmLegacyImportRecord, LegacyNormalizedImportRecord, UnifiedPreviewRow } from './types';
import { storePreviewCache } from './previewCache';

export type LegacyPreviewResult = CurrentForecastImportPreview & {
  importMode: 'current_forecast';
  previewId: string;
};

export class LegacyPreviewValidationError extends Error {
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'LegacyPreviewValidationError';
    this.details = details;
  }
}

export async function buildLegacyImportPreview(workbook: XLSX.WorkBook): Promise<LegacyPreviewResult> {
  const resolvedSheets = resolveLegacyImportSheets(workbook);
  if (resolvedSheets.length === 0) {
    throw new LegacyPreviewValidationError(
      'No import sheet found. A sheet must have column A header "Key for no regist" and at least one MMM-YY forecast column (for example JUL-26).',
      { sheets: workbook.SheetNames }
    );
  }

  const sheetResults = resolvedSheets.map(({ sheetName, sheet }) =>
    parseLegacyImportSheet(sheetName, sheet)
  );
  const merged = mergeLegacySheetResults(sheetResults);
  const {
    sheetNames,
    totalDataRows,
    forecastColumns,
    extendedColumns,
    hasPriceColumns,
    hasAmountColumns,
    headerErrors,
    detectedHeaders,
    missingKeyRows,
    invalidNumericValues,
    excelGroups,
    crossSheetDuplicateKeys,
  } = merged;

  if (forecastColumns.length === 0) {
    throw new LegacyPreviewValidationError(
      'No forecast month columns were found. Use headers such as JUN-26 or JUL-26.',
      { detectedHeaders, headerErrors }
    );
  }

  const sheetNameLabel = sheetNames.join(' + ');

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

  const unmatchedRows: Awaited<ReturnType<typeof diagnoseUnmatchedRows>> = [];
  const duplicateRegistrationMatches: Array<{
    sourceSheet: string;
    sourceRow: number;
    excelKeyForNoRegist: string;
    matchedRegistrationIds: string[];
  }> = [];
  const candidateRecords: LegacyNormalizedImportRecord[] = [];
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

    const rowRecords: LegacyNormalizedImportRecord[] = extendedColumns.map((forecastColumn, forecastIndex) => ({
      sourceRow,
      excelKeyForNoRegist,
      matchedRegistrationId: matches[0].registrationId,
      version: CURRENT_FORECAST_VERSION,
      sourceColumn: forecastColumn.col,
      sourceMonthHeader: forecastColumn.header,
      forecastMonth: forecastColumn.month,
      period: forecastColumn.period,
      granularity: 'week',
      qtyFcst: group.forecastValues[forecastIndex],
      priceFcst: hasPriceColumns ? group.priceValues[forecastIndex] : 0,
      amountFcst: hasAmountColumns ? group.amountValues[forecastIndex] : 0,
    }));

    candidateRecords.push(...rowRecords);
  }

  unmatchedRows.push(...await diagnoseUnmatchedRows(rawUnmatchedRows, actualSummaries));

  const autoCreateCandidates = collectAutoCreateCandidates(
    excelGroups,
    rawUnmatchedRows.map(row => row.excelKeyForNoRegist),
    group => buildLegacyAutoCreatePackage(group, extendedColumns, hasPriceColumns, hasAmountColumns)
  );

  const hasBlockingHeaderErrors = headerErrors.length > 0;
  const matchedRegistrationIds = hasBlockingHeaderErrors
    ? []
    : [...new Set(candidateRecords.map(record => record.matchedRegistrationId))];
  const periods = forecastColumns.map(column => column.period);
  const existingRows = matchedRegistrationIds.length > 0
    ? await prisma.forecastValue.findMany({
        where: {
          versionName: CURRENT_FORECAST_VERSION,
          registrationId: { in: matchedRegistrationIds },
          period: { in: periods.map(period => parseForecastPeriodToDate(period, 'week')) },
        },
        select: {
          registrationId: true,
          period: true,
          qtyFcst: true,
          priceFcst: true,
          amountFcst: true,
          granularity: true,
        },
      })
    : [];

  const existingRowMap = new Map(
    existingRows.map(row => [
      `${row.registrationId}|${formatForecastPeriodForApi(row.period, row.granularity)}`,
      row,
    ])
  );
  const importableRecords = hasBlockingHeaderErrors
    ? []
    : candidateRecords.map(record => {
        const existing = existingRowMap.get(`${record.matchedRegistrationId}|${record.period}`);
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
    }));
  const createRecords = importableRecords.filter(record => record.action === 'create');

  function toConfirmRecords(records: LegacyNormalizedImportRecord[]): ConfirmLegacyImportRecord[] {
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

  const cacheEntry = storePreviewCache({
    importMode: 'current_forecast',
    previewContractVersion: LEGACY_PREVIEW_CONTRACT_VERSION,
    targetVersion: CURRENT_FORECAST_VERSION,
    legacyRecords: toConfirmRecords(importableRecords),
    legacyHasPriceColumns: hasPriceColumns,
    legacyHasAmountColumns: hasAmountColumns,
    amountMismatchCount: 0,
    autoCreateCandidates,
    spreadByRegistrationId,
    pricingPolicyByRegistrationId,
  });

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

  unifiedPreviewRows.sort((a, b) => {
    const order = { matched: 0, registration_only: 1, proposed_registration: 2, actual_only: 3 };
    return order[a.status] - order[b.status] || a.keyNoRegist.localeCompare(b.keyNoRegist);
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

  return {
    previewId: cacheEntry.previewId,
    importMode: 'current_forecast',
    previewContractVersion: LEGACY_PREVIEW_CONTRACT_VERSION,
    summary: {
      sheetName: sheetNameLabel,
      sheetNames,
      version: CURRENT_FORECAST_VERSION,
      hasPriceColumns,
      hasAmountColumns,
      pricingPoliciesDetected,
      unknownPricingPolicies,
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
      excelTotalQty,
      excelTotalAmount,
      importTotalQty,
      importTotalAmount,
    },
    expectedForecastColumns: forecastColumns,
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
    // Forecast rows that do not exist yet, so the "N created" figure on the
    // result can be traced back to the Excel rows that produced it.
    createRecords: createRecords.slice(0, PREVIEW_OVERWRITE_SAMPLE_SIZE).map(record => ({
      sourceRow: record.sourceRow,
      excelKeyForNoRegist: record.excelKeyForNoRegist,
      matchedRegistrationId: record.matchedRegistrationId,
      period: record.period,
      sourceMonthHeader: record.sourceMonthHeader,
      newQtyFcst: record.qtyFcst,
    })),
    autoCreateRegistrations: autoCreateCandidates
      .slice(0, PREVIEW_ISSUE_SAMPLE_SIZE)
      .map(candidate => ({
        excelKeyForNoRegist: candidate.excelKeyForNoRegist,
        sourceSheet: candidate.sourceSheet,
        sourceRow: candidate.sourceRow,
        plantCode: candidate.plantCode,
        materialCode: candidate.materialCode,
        ownerName: candidate.ownerName,
      })),
    unifiedPreviewRows: unifiedPreviewRows.slice(0, PREVIEW_UNIFIED_ROWS_SAMPLE_SIZE),
    importableRecords: importableRecords.slice(0, PREVIEW_IMPORTABLE_SAMPLE_SIZE).map(record => ({
      ...record,
      action: record.action ?? 'create',
      oldQtyFcst: record.oldQtyFcst ?? null,
    })),
  };
}
