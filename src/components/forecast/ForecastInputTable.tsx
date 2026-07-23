import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CheckCircle2, Columns3, Copy, Download, FilePlus2, FileSpreadsheet, Info, LoaderCircle, ShieldAlert, Upload, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import {
  api,
  ApiError,
  isVersionedImportPreview,
  LEGACY_FORECAST_IMPORT_CONTRACT_VERSION,
  VERSIONED_FORECAST_IMPORT_CONTRACT_VERSION,
  type CurrentForecastImportPreview,
  type FilterOptionsPage,
  type ForecastImportPreview,
} from '../../lib/api';
import type {
  ColumnFilterValue,
  ColumnFiltersState,
  CPLPrice,
  CarryDetailKey,
  CarryDetailVisibility,
  CustomColumnDef,
  CustomColumnValuesMap,
  Dimension,
  ForecastValue,
  ForecastSummary,
  ForecastLoadProgress,
  PriceFormula,
  Registration,
  RegColumnKey,
  ValueType,
} from '../../types/forecast';
import { ColumnReorderPanel } from './ColumnReorderPanel';
import { DraftRegistrationPanel } from './DraftRegistrationPanel';
import { FixedColumnsTable } from './FixedColumnsTable';
import { ResizablePaneLayout } from './ResizablePaneLayout';
import { ScrollableMonthGrid } from './ScrollableMonthGrid';
import {
  getCustomColumnsTotalWidth,
  getRegColumnsTotalWidth,
  REG_PANE_MAX_RATIO,
  REG_PANE_MIN_WIDTH,
} from './regTableColumns';
import { usePaneResize } from './usePaneResize';
import { useRegTableLayout } from './useRegTableLayout';
import { useScrollSync } from './useScrollSync';
import { ImportModalErrorBoundary } from './ImportModalErrorBoundary';

export interface ForecastInputTableProps {
  registrations: Registration[];
  allRegistrations: Registration[];
  columnFilters: ColumnFiltersState;
  onColumnFiltersChange: React.Dispatch<React.SetStateAction<ColumnFiltersState>>;
  monthsToShow: string[];
  forecastData: ForecastValue[];
  cplPrices: CPLPrice[];
  selectedVersion: string;
  selectedDimension: Dimension;
  selectedType: ValueType;
  onForecastChange: (regId: string, month: string, value: number) => void;
  onExport: () => void;
  forecastMode: 'month' | 'week' | 'day';
  planningView: 'sale' | 'accounting' | 'production';
  formulaMap: Map<string, PriceFormula>;
  onFormulaChange: (regId: string, formula: PriceFormula) => void;
  pricingPolicyMap?: Map<string, string | null>;
  onPricingPolicyChange?: (regId: string, pricingPolicy: string | null) => void;
  spreadMap: Map<string, string>;
  onSpreadChange: (regId: string, spread: string | null) => void;
  onSpreadCommit: (regId: string, spread: string | null) => void;
  formulaFilter: ColumnFilterValue;
  onFormulaFilterChange: (v: ColumnFilterValue) => void;
  naphthaprices: CPLPrice[];
  benzeneprices: CPLPrice[];
  jpyRates?: CPLPrice[];
  thbRates?: CPLPrice[];
  tecnonPrices?: CPLPrice[];
  pciPrices?: CPLPrice[];
  latestActualPriceMap?: Map<string, number>;
  fixedPriceMap: Map<string, Map<string, number>>;
  onFixedPriceChange: (regId: string, month: string, price: number) => void;
  onAmountChange: (regId: string, month: string, amount: number) => void;
  isTableDataLoading: boolean;
  forecastLoadProgress: ForecastLoadProgress | null;
  isLoadingMore: boolean;
  hasMoreRows: boolean;
  onLoadMore: () => void;
  loadFilterOptions: (
    columnKey: string,
    search: string,
    cursor?: string | null
  ) => Promise<FilterOptionsPage>;
  onCreateManagedRegistration: (registration: Registration) => Promise<Registration>;
  onImportComplete: (
    targetVersion?: string,
    options?: { startMonth?: string; endMonth?: string }
  ) => Promise<void>;
  forecastSummary: ForecastSummary | null;
  isForecastSummaryUpdating: boolean;
  forecastAuditVersion: number;
  stampPeriod: string;
  customColumnDefs?: CustomColumnDef[];
  customColumnValues?: CustomColumnValuesMap;
  canManageCustomColumns?: boolean;
  onOpenManageColumns?: (section?: 'add' | 'manage') => void;
  onCustomColumnValueChange?: (columnId: string, registrationId: string, value: string | null) => void;
  onOpenCopyForecast?: () => void;
  canCopyForecast?: boolean;
  appMode?: 'nyl' | 'ufa' | null;
}

function ForecastInputTableComponent({
  registrations,
  allRegistrations,
  columnFilters,
  onColumnFiltersChange,
  monthsToShow,
  forecastData,
  cplPrices,
  selectedVersion,
  selectedDimension,
  selectedType,
  onForecastChange,
  onExport,
  forecastMode,
  planningView,
  formulaMap,
  onFormulaChange,
  pricingPolicyMap,
  onPricingPolicyChange,
  spreadMap,
  onSpreadChange,
  onSpreadCommit,
  formulaFilter,
  onFormulaFilterChange,
  naphthaprices,
  benzeneprices,
  jpyRates,
  thbRates,
  tecnonPrices,
  pciPrices,
  latestActualPriceMap,
  fixedPriceMap,
  onFixedPriceChange,
  onAmountChange,
  isTableDataLoading,
  forecastLoadProgress,
  isLoadingMore,
  hasMoreRows,
  onLoadMore,
  loadFilterOptions,
  onCreateManagedRegistration,
  onImportComplete,
  forecastSummary,
  isForecastSummaryUpdating,
  forecastAuditVersion,
  stampPeriod,
  customColumnDefs = [],
  customColumnValues,
  canManageCustomColumns = false,
  onOpenManageColumns,
  onCustomColumnValueChange,
  onOpenCopyForecast,
  canCopyForecast = false,
  appMode = null,
}: ForecastInputTableProps) {
  const isScopeDataLoading = isTableDataLoading || Boolean(
    forecastLoadProgress?.active && forecastLoadProgress.version === selectedVersion,
  );

  const {
    columnOrder,
    settingsOpen,
    setSettingsOpen,
    orderedColumns,
    draggedColumnKey,
    setDraggedColumnKey,
    resetColumnOrder,
    handleColumnDrop,
    handlePanelReorder,
    columnVisibility,
    toggleColumnVisibility,
  } = useRegTableLayout(appMode);

  const visibleOrderedColumns = orderedColumns.filter(c => {
    return columnVisibility ? columnVisibility[c.key] !== false : true;
  });

  const { regPaneRef, monthPaneRef, scrollTop, syncFromReg, syncFromMonth, resetScrollTop } = useScrollSync();
  const [dragOverColumnKey, setDragOverColumnKey] = useState<RegColumnKey | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importPreview, setImportPreview] = useState<ForecastImportPreview | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [isPreviewingImport, setIsPreviewingImport] = useState(false);
  const [isConfirmingImport, setIsConfirmingImport] = useState(false);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [showScrollLoader, setShowScrollLoader] = useState(false);
  const [draftPanelOpen, setDraftPanelOpen] = useState(false);
  const [carryDetailVisibility, setCarryDetailVisibility] = useState<CarryDetailVisibility>({
    carryIn: false,
    carryOut: false,
    carryTotal: false,
  });
  const [customColumnVisibility, setCustomColumnVisibility] = useState<Record<string, boolean>>({});

  useEffect(() => {
    setCustomColumnVisibility(previous => {
      const next: Record<string, boolean> = {};
      for (const column of customColumnDefs) {
        next[column.id] = previous[column.id] !== false;
      }
      return next;
    });
  }, [customColumnDefs]);

  const visibleCustomColumns = useMemo(
    () => customColumnDefs.filter(column => customColumnVisibility[column.id] !== false),
    [customColumnDefs, customColumnVisibility],
  );

  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [splitContainerWidth, setSplitContainerWidth] = useState(900);

  useEffect(() => {
    const el = splitContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setSplitContainerWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const paneMinWidth = REG_PANE_MIN_WIDTH;
  const regContentWidth = getRegColumnsTotalWidth(visibleOrderedColumns)
    + getCustomColumnsTotalWidth(visibleCustomColumns.length, canManageCustomColumns);
  const paneMaxWidth = Math.max(
    regContentWidth,
    Math.floor(splitContainerWidth * REG_PANE_MAX_RATIO)
  );
  const paneInitialWidth = Math.min(
    paneMaxWidth,
    Math.max(paneMinWidth, Math.min(regContentWidth, Math.floor(splitContainerWidth * 0.38)))
  );

  const { regPaneWidth, onDividerPointerDown, isDragging } = usePaneResize({
    initialWidth: paneInitialWidth,
    minWidth: paneMinWidth,
    maxWidth: paneMaxWidth,
  });

  const setColumnFilter = useCallback(
    (key: string, value: ColumnFilterValue) => {
      onColumnFiltersChange(prev => ({ ...prev, [key]: value }));
    },
    [onColumnFiltersChange]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedColumnKey(null);
    setDragOverColumnKey(null);
  }, [setDraggedColumnKey]);

  const resetImportPreview = useCallback(() => {
    setImportFile(null);
    setImportPreview(null);
    setImportError(null);
    setIsPreviewingImport(false);
    setIsConfirmingImport(false);
    setImportSuccess(null);
  }, []);

  useEffect(() => {
    const panes = [regPaneRef.current, monthPaneRef.current].filter(
      (pane): pane is HTMLDivElement => Boolean(pane)
    );

    const checkLoadMore = () => {
      const pane = monthPaneRef.current ?? regPaneRef.current;
      if (!pane) return;
      const remaining = pane.scrollHeight - pane.scrollTop - pane.clientHeight;
      if (remaining < 700 && hasMoreRows) {
        setShowScrollLoader(true);
        if (!isLoadingMore) onLoadMore();
      } else if (remaining >= 700 || !hasMoreRows) {
        setShowScrollLoader(false);
      }
    };

    panes.forEach(pane => pane.addEventListener('scroll', checkLoadMore, { passive: true }));
    return () => {
      panes.forEach(pane => pane.removeEventListener('scroll', checkLoadMore));
    };
  }, [hasMoreRows, isLoadingMore, onLoadMore, registrations.length, regPaneRef, monthPaneRef]);

  useEffect(() => {
    if (!hasMoreRows) setShowScrollLoader(false);
  }, [hasMoreRows]);

  useEffect(() => {
    resetScrollTop();
    setShowScrollLoader(false);
  }, [columnFilters, resetScrollTop]);

  useEffect(() => {
    resetScrollTop();
  }, [selectedVersion, resetScrollTop]);

  const closeImportModal = useCallback(() => {
    setImportOpen(false);
    resetImportPreview();
  }, [resetImportPreview]);

  const toggleCarryDetail = useCallback((key: CarryDetailKey) => {
    setCarryDetailVisibility(previous => ({
      ...previous,
      [key]: !previous[key],
    }));
  }, []);

  const toggleCustomColumnVisibility = useCallback((columnId: string) => {
    setCustomColumnVisibility(previous => ({
      ...previous,
      [columnId]: previous[columnId] === false,
    }));
  }, []);

  const handleImportPreview = useCallback(async () => {
    if (!importFile) {
      setImportError('Please select an Excel file (.xlsx) first.');
      return;
    }
    try {
      setIsPreviewingImport(true);
      setImportError(null);
      setImportSuccess(null);
      const preview = await api.imports.forecastPreview(importFile);
      setImportPreview(preview);
    } catch (error) {
      let msg = error instanceof ApiError ? error.message : 'Failed to preview forecast import';
      if (error instanceof ApiError && Array.isArray(error.details.sheets)) {
        msg += ` Sheets in file: ${(error.details.sheets as string[]).join(', ')}`;
      }
      setImportError(msg);
      setImportPreview(null);
    } finally {
      setIsPreviewingImport(false);
    }
  }, [importFile]);

  const handleImportConfirm = useCallback(async () => {
    if (!importPreview) return;
    try {
      setIsConfirmingImport(true);
      setImportError(null);
      setImportSuccess(null);
      const result = await api.imports.forecastConfirm(importPreview, stampPeriod);
      const targetVersion = isVersionedImportPreview(importPreview)
        ? importPreview.targetVersion
        : 'Current Forecast';
      const importMonthRange = isVersionedImportPreview(importPreview) && importPreview.expectedColumns.length > 0
        ? {
            startMonth: importPreview.expectedColumns[0].month,
            endMonth: importPreview.expectedColumns.at(-1)?.month,
          }
        : undefined;
      await onImportComplete(targetVersion, importMonthRange);
      const versionNote = isVersionedImportPreview(importPreview)
        ? ` View switched to ${targetVersion}.`
        : '';
      const registrationsNote = (result.registrationsCreated ?? 0) > 0
        ? ` Created ${result.registrationsCreated!.toLocaleString()} registration${result.registrationsCreated === 1 ? '' : 's'} — see Manage Registration.`
        : '';
      setImportSuccess(
        `Imported ${result.imported.toLocaleString()} records: ${result.created.toLocaleString()} created, ${result.overwritten.toLocaleString()} overwritten.${registrationsNote}${versionNote}`
      );
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Failed to import forecast';
      setImportError(message);
    } finally {
      setIsConfirmingImport(false);
    }
  }, [importPreview, onImportComplete, stampPeriod]);

  return (
    <div className="flex-1 flex flex-col overflow-hidden relative min-h-0 w-full">
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-b border-slate-100 bg-slate-50/80">
        <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest truncate">
          Business columns ↔ · Months ↔ · drag divider to resize
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenCopyForecast}
            disabled={!canCopyForecast}
            className={cn(
              'flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg border transition-all duration-200',
              canCopyForecast
                ? 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                : 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
            )}
          >
            <Copy size={12} />
            Copy
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingsOpen(false);
              setDraftPanelOpen(true);
            }}
            className={cn(
              'flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg border transition-all duration-200',
              draftPanelOpen
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
            )}
          >
            <FilePlus2 size={12} />
            Add Registration
          </button>
          <button
            type="button"
            onClick={() => {
              setDraftPanelOpen(false);
              setSettingsOpen(true);
            }}
            className={cn(
              'flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg border transition-all duration-200',
              settingsOpen
                ? 'bg-blue-50 border-blue-300 text-blue-700'
                : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
            )}
          >
            <Columns3 size={12} />
            Column Settings
          </button>
          <button
            type="button"
            onClick={() => setImportOpen(true)}
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg border bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all duration-200"
          >
            <Upload size={12} />
            Import
          </button>
          <button
            type="button"
            onClick={onExport}
            className="flex items-center gap-1.5 text-[10px] font-bold uppercase px-3 py-1.5 rounded-lg border bg-white border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50 transition-all duration-200"
          >
            <Download size={12} />
            Export
          </button>
        </div>
      </div>

      <ColumnReorderPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        columnOrder={columnOrder}
        onReorder={handlePanelReorder}
        onReset={resetColumnOrder}
        columnVisibility={columnVisibility}
        onToggleVisibility={toggleColumnVisibility}
        carryDetailVisibility={carryDetailVisibility}
        onToggleCarryDetail={toggleCarryDetail}
        customColumns={customColumnDefs}
        customColumnVisibility={customColumnVisibility}
        onToggleCustomColumnVisibility={toggleCustomColumnVisibility}
        appMode={appMode}
      />

      <DraftRegistrationPanel
        open={draftPanelOpen}
        onClose={() => setDraftPanelOpen(false)}
        onCreate={async registration => {
          const saved = await onCreateManagedRegistration(registration);
          if (
            !Object.values(columnFilters).some(filter => filter.selectedValues.length > 0) &&
            formulaFilter.selectedValues.length === 0
          ) {
            resetScrollTop();
          }
          return saved;
        }}
      />

      <ImportPreviewModal
        open={importOpen}
        file={importFile}
        preview={importPreview}
        error={importError}
        success={importSuccess}
        loading={isPreviewingImport}
        confirming={isConfirmingImport}
        onClose={closeImportModal}
        onFileChange={file => {
          setImportFile(file);
          setImportPreview(null);
          setImportError(null);
          setImportSuccess(null);
        }}
        onPreview={handleImportPreview}
        onConfirm={handleImportConfirm}
      />

      <ResizablePaneLayout
        splitContainerRef={splitContainerRef}
        regPaneWidth={regPaneWidth}
        isDragging={isDragging}
        onDividerPointerDown={onDividerPointerDown}
        fixedPane={
          <FixedColumnsTable
            scrollRef={regPaneRef}
            scrollTop={scrollTop}
            onScroll={syncFromReg}
            tableWidth={regContentWidth}
            columns={visibleOrderedColumns}
            customColumns={visibleCustomColumns}
            customColumnValues={customColumnValues}
            canManageCustomColumns={canManageCustomColumns}
            onAddCustomColumn={() => onOpenManageColumns?.('add')}
            onCustomColumnValueChange={onCustomColumnValueChange}
            registrations={registrations}
            allRegistrations={allRegistrations}
            columnFilters={columnFilters}
            onColumnFilterChange={setColumnFilter}
            draggedColumnKey={draggedColumnKey}
            dragOverColumnKey={dragOverColumnKey}
            onDragStart={setDraggedColumnKey}
            onDragEnd={handleDragEnd}
            onDragOver={setDragOverColumnKey}
            onDragLeave={() => setDragOverColumnKey(null)}
            onColumnDrop={handleColumnDrop}
            selectedDimension={selectedDimension}
            formulaMap={formulaMap}
            onFormulaChange={onFormulaChange}
            pricingPolicyMap={pricingPolicyMap}
            onPricingPolicyChange={onPricingPolicyChange}
            spreadMap={spreadMap}
            onSpreadChange={onSpreadChange}
            onSpreadCommit={onSpreadCommit}
            formulaFilter={formulaFilter}
            onFormulaFilterChange={onFormulaFilterChange}
            loadFilterOptions={loadFilterOptions}
          />
        }
        monthPane={
          <ScrollableMonthGrid
            scrollRef={monthPaneRef}
            scrollTop={scrollTop}
            onScroll={syncFromMonth}
            monthsToShow={monthsToShow}
            registrations={registrations}
            forecastData={forecastData}
            cplPrices={cplPrices}
            selectedVersion={selectedVersion}
            selectedDimension={selectedDimension}
            selectedType={selectedType}
            onForecastChange={onForecastChange}
            forecastMode={forecastMode}
            planningView={planningView}
            formulaMap={formulaMap}
            spreadMap={spreadMap}
            naphthaprices={naphthaprices}
            benzeneprices={benzeneprices}
            jpyRates={jpyRates}
            thbRates={thbRates}
            tecnonPrices={tecnonPrices}
            pciPrices={pciPrices}
            pricingPolicyMap={pricingPolicyMap}
            latestActualPriceMap={latestActualPriceMap}
            fixedPriceMap={fixedPriceMap}
            onFixedPriceChange={onFixedPriceChange}
            onAmountChange={onAmountChange}
            carryDetailVisibility={carryDetailVisibility}
            forecastSummary={forecastSummary}
            isForecastSummaryUpdating={isForecastSummaryUpdating}
            isScopeDataLoading={isScopeDataLoading}
            forecastAuditVersion={forecastAuditVersion}
          />
        }
      />
      {forecastLoadProgress?.active && (
        <div className="pointer-events-none absolute right-3 top-2 z-40 rounded border border-blue-200 bg-white/95 px-2.5 py-1 text-[10px] font-semibold text-blue-700 shadow-sm">
          <span className="inline-flex items-center gap-1.5">
            <LoaderCircle size={12} className="animate-spin" />
            Loading {forecastLoadProgress.version}… {forecastLoadProgress.completedChunks}/{forecastLoadProgress.totalChunks}
          </span>
        </div>
      )}
      {showScrollLoader && (isTableDataLoading || isLoadingMore || hasMoreRows) && (
        <div className="pointer-events-none absolute bottom-14 left-1/2 z-30 -translate-x-1/2">
          <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white/95 px-3 py-2 text-[11px] font-semibold text-slate-600 shadow-md">
            <LoaderCircle size={15} className="animate-spin text-blue-600" />
            Loading more rows...
          </div>
        </div>
      )}
    </div>
  );
}

export const ForecastInputTable = React.memo(ForecastInputTableComponent);

const UNMATCHED_ISSUE_LABELS: Record<string, string> = {
  invalid_key_format: 'Invalid Key Format',
  has_actual_no_crm: 'Actual Without CRM',
  non_main_registration: 'Non-Main Registration',
  onoff_mismatch: 'On/Off Mismatch',
  crm_not_found: 'Not in CRM',
};

function formatUnmatchedIssueLabel(reasonCode?: string) {
  if (!reasonCode) return 'Not in CRM';
  return UNMATCHED_ISSUE_LABELS[reasonCode] ?? reasonCode.replaceAll('_', ' ');
}

function formatUnmatchedReason(
  item: CurrentForecastImportPreview['unmatchedRows'][number]
) {
  if (item.reason) {
    if (item.parsedKey && !item.reason.includes('SoldTo=')) {
      const segments = `SoldTo=${item.parsedKey.soldTo}, ShipTo=${item.parsedKey.shipTo}, EndUser=${item.parsedKey.enduser}, Plant=${item.parsedKey.plant}, Material=${item.parsedKey.material}, OnOff=${item.parsedKey.onOff}`;
      return `${item.reason} — ${segments}`;
    }
    return item.reason;
  }
  return 'No matching CRM registration — a new registration will be created on confirm';
}

const UNMATCHED_HINT_LABELS: Record<string, string> = {
  invalid_key_format: 'Invalid key format — registration will be created from the Excel key on confirm',
  non_main_registration: 'Non-main CRM registration — a new master registration will be created from the Excel key on confirm',
  onoff_mismatch: 'On/Off mismatch with CRM — a new registration will be created from the Excel key on confirm',
  has_actual_no_crm: 'Actual exists without CRM — registration will be created automatically on confirm',
  crm_not_found: 'Not in CRM — registration will be created automatically on confirm',
};

function formatUnmatchedHint(
  item: CurrentForecastImportPreview['unmatchedRows'][number],
  isStalePreviewBackend: boolean
) {
  if (item.hint) return item.hint;
  if (isStalePreviewBackend) return 'Restart API server and preview again';
  if (item.reasonCode && UNMATCHED_HINT_LABELS[item.reasonCode]) {
    return UNMATCHED_HINT_LABELS[item.reasonCode];
  }
  return '—';
}

function formatSheetLabel(sourceSheet?: string) {
  return sourceSheet?.trim() || '—';
}

function formatExcelRowRef(sourceSheet?: string, sourceRow?: number) {
  if (!sourceSheet?.trim() || !sourceRow) return '—';
  return `${sourceSheet.trim()} row ${sourceRow}`;
}

function formatMissingKeyRowsSummary(
  rows: CurrentForecastImportPreview['missingKeyRows']
) {
  const bySheet = new Map<string, number[]>();
  for (const row of rows) {
    const sheet = formatSheetLabel(row.sourceSheet);
    const existing = bySheet.get(sheet) ?? [];
    existing.push(row.sourceRow);
    bySheet.set(sheet, existing);
  }
  return [...bySheet.entries()]
    .map(([sheet, sheetRows]) => `${sheet}: ${[...sheetRows].sort((a, b) => a - b).join(', ')}`)
    .join(' · ');
}

function formatPreviewNumber(value: number | null | undefined, fractionDigits = 3) {
  if (value == null || !Number.isFinite(value)) return '—';
  return value.toLocaleString(undefined, { maximumFractionDigits: fractionDigits });
}

function isPreviewStale(preview: ForecastImportPreview) {
  if (isVersionedImportPreview(preview)) {
    return preview.previewContractVersion !== VERSIONED_FORECAST_IMPORT_CONTRACT_VERSION;
  }
  return preview.previewContractVersion !== LEGACY_FORECAST_IMPORT_CONTRACT_VERSION;
}

function countVersionedAmountWarnings(preview: ForecastImportPreview | null, isVersioned: boolean) {
  if (!isVersioned || !preview || !isVersionedImportPreview(preview)) return 0;
  return preview.summary.amountMismatchWarnings ?? preview.amountMismatchWarnings.length;
}

function getImportConfirmReadyText(preview: ForecastImportPreview | null, isVersioned: boolean) {
  const registrationsToCreate = preview?.summary?.registrationsToCreate ?? 0;
  const autoCreateNote = registrationsToCreate > 0
    ? ` ${registrationsToCreate.toLocaleString()} registration${registrationsToCreate === 1 ? '' : 's'} with no CRM match (including invalid key format) will be created automatically on confirm.`
    : '';
  if (!isVersioned) {
    return `Review the summary and validation details, then confirm to save Current Forecast.${autoCreateNote}`;
  }
  const targetVersion = preview && isVersionedImportPreview(preview)
    ? preview.targetVersion
    : 'forecast';
  return `Review the summary and validation details, then confirm to save ${targetVersion}.${autoCreateNote}`;
}

function ImportPreviewModal({
  open,
  file,
  preview,
  error,
  success,
  loading,
  confirming,
  onClose,
  onFileChange,
  onPreview,
  onConfirm,
}: Readonly<{
  open: boolean;
  file: File | null;
  preview: ForecastImportPreview | null;
  error: string | null;
  success: string | null;
  loading: boolean;
  confirming: boolean;
  onClose: () => void;
  onFileChange: (file: File | null) => void;
  onPreview: () => void;
  onConfirm: () => void;
}>) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const isVersioned = Boolean(preview && isVersionedImportPreview(preview));
  const summary = preview?.summary;
  const unifiedPreviewRows = preview?.unifiedPreviewRows ?? [];
  const isStalePreviewBackend = Boolean(preview && isPreviewStale(preview));
  const hasBlockingIssues = summary
    ? isStalePreviewBackend ||
      summary.headerErrors > 0 ||
      (isVersioned && isVersionedImportPreview(preview!) && !preview!.versionExists)
    : isStalePreviewBackend;
  const warningCount = summary
    ? summary.missingKeyRows +
      summary.unmatchedRows +
      summary.invalidNumericValues +
      summary.duplicateRegistrationMatches +
      (summary.crossSheetDuplicateKeys ?? 0) +
      countVersionedAmountWarnings(preview, isVersioned)
    : 0;
  const importTitle = isVersioned ? 'Versioned Forecast Import' : 'Current Forecast Import';
  const importSubtitle = isVersioned
    ? 'Qty, price, and amount validation before committing to the selected forecast version.'
    : 'Preview validation results before committing to the database.';
  const confirmReadyText = getImportConfirmReadyText(preview, isVersioned);

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        className="absolute inset-0 bg-slate-900/65 backdrop-blur-md"
        onClick={onClose}
        aria-label="Close import preview"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-preview-title"
        className="relative flex h-[min(92dvh,920px)] max-h-[min(92dvh,920px)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-slate-300 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.28)]"
        onMouseDown={event => event.stopPropagation()}
      >
        <div className="shrink-0 bg-[#003d6b] px-6 py-4 text-white">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/20">
                <FileSpreadsheet size={22} />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-blue-100/80">Data Import</p>
                <h3 id="import-preview-title" className="text-lg font-bold tracking-tight">{importTitle}</h3>
                <p className="mt-0.5 text-sm text-blue-100/90">{importSubtitle}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-2 text-blue-100 transition-colors hover:bg-white/10 hover:text-white"
              aria-label="Close import preview"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {isVersioned && preview && isVersionedImportPreview(preview) && (
          <div className="shrink-0 border-b border-slate-200 bg-white px-6 py-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">Version</p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Excel version</p>
                <p className="font-mono text-sm font-semibold text-slate-800">{preview.excelVersionLabel}</p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Target version</p>
                <p className={cn(
                  'text-sm font-semibold',
                  preview.versionExists ? 'text-slate-800' : 'text-red-700'
                )}>
                  {preview.targetVersion}
                  {!preview.versionExists && (
                    <span className="ml-1.5 text-xs font-medium text-red-600">(not found)</span>
                  )}
                </p>
              </div>
              <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <p className="text-[10px] font-semibold uppercase text-slate-500">Sheets</p>
                <p className="text-sm font-medium text-slate-800">
                  {preview.summary.sheetNames?.join(' + ') ?? preview.summary.sheetName}
                </p>
              </div>
              {preview.expectedColumns.length > 0 && (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                  <p className="text-[10px] font-semibold uppercase text-slate-500">Month range</p>
                  <p className="font-mono text-sm font-semibold text-slate-800">
                    {preview.expectedColumns[0].qty.header} → {preview.expectedColumns.at(-1)?.qty.header}
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="shrink-0 border-b border-slate-200 bg-slate-50 px-6 py-3">
          {preview && file ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs text-slate-600">
                File: <span className="font-medium text-slate-800">{file.name}</span>
              </p>
              <div className="flex items-center gap-2">
                <label className="inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-600 hover:bg-slate-50">
                  Change file
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={e => onFileChange(e.target.files?.[0] ?? null)}
                    className="sr-only"
                  />
                </label>
                <button
                  type="button"
                  onClick={onPreview}
                  disabled={loading || confirming}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#007ABE] px-3 text-[11px] font-semibold text-white hover:bg-[#006aa3] disabled:opacity-50"
                >
                  <Upload size={12} />
                  {loading ? 'Validating…' : 'Re-run Preview'}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className="mb-1.5 block text-xs font-semibold text-slate-600">Source file</span>
                <input
                  type="file"
                  accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={e => onFileChange(e.target.files?.[0] ?? null)}
                  className="block w-full rounded-lg border border-slate-300 bg-white px-1 py-1 text-sm text-slate-700 file:mr-3 file:rounded-md file:border-0 file:bg-[#003d6b] file:px-4 file:py-2 file:text-xs file:font-semibold file:text-white hover:file:bg-[#002f52]"
                />
              </label>
              <button
                type="button"
                onClick={onPreview}
                disabled={loading || confirming || !file}
                className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-lg bg-[#007ABE] px-5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#006aa3] disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                <Upload size={14} />
                {loading ? 'Validating...' : 'Run Preview'}
              </button>
            </div>
          )}
          {file && !preview && (
            <p className="mt-2 text-xs text-slate-500">
              Selected: <span className="font-medium text-slate-700">{file.name}</span>
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-[#f4f7fb] [scrollbar-gutter:stable]">
          <div className="space-y-5 px-6 py-5">
            {error && (
              <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-white px-4 py-3 shadow-sm">
                <ShieldAlert size={18} className="mt-0.5 shrink-0 text-red-600" />
                <p className="text-sm font-medium text-red-800">{error}</p>
              </div>
            )}

            {success && (
              <div className="flex items-start gap-3 rounded-lg border border-emerald-200 bg-white px-4 py-3 shadow-sm">
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-600" />
                <p className="text-sm font-medium text-emerald-800">{success}</p>
              </div>
            )}

            {isStalePreviewBackend && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 shadow-sm">
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-700" />
                <div className="text-sm text-amber-900">
                  <p className="font-semibold">Preview is outdated</p>
                  <p className="mt-1 text-amber-800/90">
                    Restart the API server (`npm run server`), hard-refresh the page, then run Preview again before confirming.
                  </p>
                </div>
              </div>
            )}

            {loading && (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-8 text-sm text-slate-600 shadow-sm">
                <LoaderCircle size={18} className="animate-spin text-[#007ABE]" />
                Validating Excel file…
              </div>
            )}

            {!loading && summary && (
              <>
                <div className={cn(
                  'rounded-lg border bg-white px-5 py-4 shadow-sm',
                  hasBlockingIssues ? 'border-amber-300' : 'border-emerald-300'
                )}>
                  <div className="flex items-start gap-3">
                    {hasBlockingIssues
                      ? <AlertTriangle size={22} className="shrink-0 text-amber-600" />
                      : <CheckCircle2 size={22} className="shrink-0 text-emerald-600" />}
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold text-slate-900">
                        {isStalePreviewBackend
                          ? 'Preview outdated — cannot import yet'
                          : hasBlockingIssues
                            ? 'Validation completed with blocking issues'
                            : 'Validation passed — ready to import'}
                      </p>
                      <p className="mt-1 text-sm text-slate-600">
                        {isStalePreviewBackend
                          ? 'Restart the API server and run Preview again so validation details match this app version.'
                          : hasBlockingIssues
                            ? 'Resolve blocking issues below, then run Preview again before confirming.'
                            : confirmReadyText}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <PreviewStat label="Total Rows" value={summary.totalRows} variant="primary" />
                  <PreviewStat label="Valid Rows" value={summary.validRows} variant="primary" />
                  <PreviewStat label="Importable Records" value={summary.importableRecords} variant="success" />
                  <PreviewStat label="Warnings" value={warningCount} variant={warningCount > 0 ? 'warning' : 'neutral'} />
                </div>

                <div className="grid grid-cols-2 gap-3 md:grid-cols-4 lg:grid-cols-6">
                  <PreviewStat label="Unique Keys" value={summary.uniqueExcelKeys} />
                  <PreviewStat label="Duplicate Keys" value={summary.groupedDuplicateKeys ?? summary.duplicateExcelKeys} />
                  <PreviewStat
                    label="Missing Key"
                    value={summary.missingKeyRows}
                    variant={summary.missingKeyRows > 0 ? 'warning' : 'neutral'}
                  />
                  <PreviewStat label="Invalid Numbers" value={summary.invalidNumericValues} variant={summary.invalidNumericValues > 0 ? 'danger' : 'neutral'} />
                  <PreviewStat label="Create" value={summary.createRecords ?? 0} variant="success" />
                  <PreviewStat label="Overwrite" value={summary.overwriteRecords ?? 0} variant={(summary.overwriteRecords ?? 0) > 0 ? 'warning' : 'neutral'} />
                  {(summary.skippedKeyGroups ?? 0) > 0 && (
                    <PreviewStat
                      label="Skipped Keys"
                      value={summary.skippedKeyGroups ?? 0}
                      variant="danger"
                    />
                  )}
                  {(summary.excludedQty ?? 0) > 0 && (
                    <PreviewStat
                      label="Excluded Qty (not saved)"
                      value={summary.excludedQty ?? 0}
                      variant="danger"
                    />
                  )}
                  {(summary.pricingPoliciesDetected ?? 0) > 0 && (
                    <PreviewStat
                      label="Pricing Policies"
                      value={summary.pricingPoliciesDetected ?? 0}
                      variant="primary"
                    />
                  )}
                  {(summary.unknownPricingPolicies ?? 0) > 0 && (
                    <PreviewStat
                      label="Unknown Policies"
                      value={summary.unknownPricingPolicies ?? 0}
                      variant="warning"
                    />
                  )}
                  <PreviewStat label="Matched" value={summary.matchedRows ?? 0} />
                  <PreviewStat label="Actual Only" value={summary.actualOnlyRows ?? 0} variant={(summary.actualOnlyRows ?? 0) > 0 ? 'warning' : 'neutral'} />
                  <PreviewStat label="Reg. Only" value={summary.registrationOnlyRows ?? 0} />
                  <PreviewStat label="New Reg." value={summary.proposedRegistrationRows ?? 0} variant={(summary.proposedRegistrationRows ?? 0) > 0 ? 'warning' : 'neutral'} />
                  {(summary.registrationsToCreate ?? 0) > 0 && (
                    <PreviewStat
                      label="Auto-create"
                      value={summary.registrationsToCreate ?? 0}
                      variant="warning"
                    />
                  )}
                </div>

                {(summary.registrationsToCreate ?? 0) > 0 && (
                  <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
                    <span className="font-semibold">{summary.registrationsToCreate?.toLocaleString()} key{(summary.registrationsToCreate ?? 0) === 1 ? '' : 's'}</span>
                    {' '}with no CRM match (including invalid key format) will create registrations automatically on confirm, then forecast values will be imported.
                  </p>
                )}

                {summary.excelTotalQty != null && summary.importTotalQty != null && (
                  <p className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-xs text-slate-700">
                    <span className="font-semibold">Total check — </span>
                    Excel qty {summary.excelTotalQty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    {' · '}
                    Import qty {summary.importTotalQty.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    {summary.excelTotalAmount != null && summary.importTotalAmount != null && (
                      <>
                        {' · '}
                        Excel amount {summary.excelTotalAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        {' · '}
                        Import amount {summary.importTotalAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </>
                    )}
                  </p>
                )}

                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                  Validation details — scroll for tables and issue lists
                </p>

                <ImportModalErrorBoundary key={preview?.previewId ?? preview?.previewContractVersion ?? 'empty'}>
                <div className="space-y-5">
                <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
                    {isVersioned ? 'Detected column map' : 'Forecast period coverage'}
                  </p>
                  {isVersioned && preview && isVersionedImportPreview(preview) ? (
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="border-b-2 border-slate-200 bg-slate-100 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                          <th className="border border-slate-200 p-2 text-left">Month</th>
                          <th className="border border-slate-200 p-2 text-left">Qty</th>
                          <th className="border border-slate-200 p-2 text-left">Price</th>
                          <th className="border border-slate-200 p-2 text-left">Amount</th>
                          <th className="border border-slate-200 p-2 text-left">Period</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.expectedColumns.map(column => (
                          <tr key={column.month} className="font-mono text-slate-700 even:bg-slate-50/80">
                            <td className="border border-slate-200 p-2">{column.month}</td>
                            <td className="border border-slate-200 p-2">{column.qty.header}</td>
                            <td className="border border-slate-200 p-2">{column.price.header}</td>
                            <td className="border border-slate-200 p-2">{column.amount.header}</td>
                            <td className="border border-slate-200 p-2">{column.period}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {preview && !isVersionedImportPreview(preview) && preview.expectedForecastColumns.map(column => (
                          <span
                            key={`${column.index}-${column.header}`}
                            className="rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 font-mono text-xs font-semibold text-slate-700"
                          >
                            {column.header}
                          </span>
                        ))}
                      </div>
                      <p className="mt-3 text-xs text-slate-500">Months not present in the file will not be changed.</p>
                    </>
                  )}
                </div>

                {isVersioned && preview && isVersionedImportPreview(preview) && preview.amountMismatchWarnings.length > 0 && (
                  <PreviewDataPanel
                    title="Amount Check Warnings"
                    count={preview.summary.amountMismatchWarnings ?? preview.amountMismatchWarnings.length}
                    emptyText="No amount mismatches"
                  >
                    <table className="w-full border-collapse text-xs">
                      <thead>
                        <tr className="border-b-2 border-slate-200 bg-slate-100 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                          <th className="border border-slate-200 p-2 text-left">Row</th>
                          <th className="border border-slate-200 p-2 text-left">Key</th>
                          <th className="border border-slate-200 p-2 text-left">Month</th>
                          <th className="border border-slate-200 p-2 text-right">Qty</th>
                          <th className="border border-slate-200 p-2 text-right">Price</th>
                          <th className="border border-slate-200 p-2 text-right">Amount</th>
                          <th className="border border-slate-200 p-2 text-right">Qty × Price</th>
                          <th className="border border-slate-200 p-2 text-right">Diff</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.amountMismatchWarnings.slice(0, 100).map(item => (
                          <tr key={`${item.sourceSheet}-${item.sourceRow}-${item.forecastMonth}-${item.excelKeyForNoRegist}`} className="font-mono text-slate-700 even:bg-slate-50/80">
                            <td className="border border-slate-200 p-2">{item.sourceRow}</td>
                            <td className="border border-slate-200 p-2 max-w-[220px] truncate">{item.excelKeyForNoRegist}</td>
                            <td className="border border-slate-200 p-2">{item.forecastMonth}</td>
                            <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(item.qtyFcst)}</td>
                            <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(item.priceFcst, 2)}</td>
                            <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(item.amountFcst, 2)}</td>
                            <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(item.expectedAmount, 2)}</td>
                            <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(item.difference, 2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </PreviewDataPanel>
                )}

                {summary.missingKeyRows > 0 && (
                  <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 shadow-sm">
                    <Info size={18} className="mt-0.5 shrink-0 text-amber-700" />
                    <div className="text-sm text-amber-950">
                      <p className="font-semibold">
                        {summary.missingKeyRows} row{summary.missingKeyRows === 1 ? '' : 's'} with no key in column A
                      </p>
                      <p className="mt-1 text-amber-900/90">
                        These rows are counted in Total Rows but not in Unique Keys or Valid Rows, and will not be imported.
                        See the Missing Key table below for the exact sheet and row numbers.
                      </p>
                      {(preview.missingKeyRows?.length ?? 0) > 0 && (
                        <p className="mt-2 font-mono text-xs text-amber-900">
                          {formatMissingKeyRowsSummary(preview.missingKeyRows ?? [])}
                        </p>
                      )}
                    </div>
                  </div>
                )}

                <ImportValidationIssues preview={preview} isStalePreviewBackend={isStalePreviewBackend} />

                <p className="text-xs text-slate-500">
                  Detailed tables below show a sample for performance. Full counts are in the summary cards above.
                </p>

                <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <PreviewList
                    title="Missing Key Rows"
                    emptyText="No rows with empty column A"
                    items={(preview.missingKeyRows ?? []).slice(0, 12).map(item =>
                      `${formatExcelRowRef(item.sourceSheet, item.sourceRow)} — column A is empty`
                    )}
                  />
                  <PreviewList
                    title="Grouped Duplicate Keys"
                    emptyText="No duplicate keys required grouping"
                    items={(preview.duplicateExcelKeys ?? []).slice(0, 8).map(item => `${item.excelKeyForNoRegist} — rows ${item.sourceRows.join(', ')}`)}
                  />
                  <PreviewList
                    title="Proposed New Registrations (auto-created on confirm)"
                    emptyText="No new registrations required"
                    items={unifiedPreviewRows
                      .filter(row => row.status === 'proposed_registration')
                      .slice(0, 8)
                      .map(row => `Rows ${row.sourceRows.join(', ')} — ${row.keyNoRegist}`)}
                  />
                  <PreviewList
                    title="Duplicate Registration Matches"
                    emptyText="No duplicate registration matches"
                    items={preview.duplicateRegistrationMatches.slice(0, 8).map(item => `Row ${item.sourceRow} — ${item.matchedRegistrationIds.join(', ')}`)}
                  />
                  <PreviewList
                    title="Forecast Values to Overwrite"
                    emptyText="No existing values will be overwritten"
                    items={(preview.overwriteRecords ?? []).slice(0, 8).map(item =>
                      `Row ${item.sourceRow} — ${item.sourceMonthHeader}: ${item.oldQtyFcst} → ${item.newQtyFcst}`
                    )}
                  />
                </div>

                <PreviewDataPanel
                  title="Registration & Actual Preview"
                  count={unifiedPreviewRows.length}
                  totalCount={
                    (summary.matchedRows ?? 0) +
                    (summary.registrationOnlyRows ?? 0) +
                    (summary.proposedRegistrationRows ?? 0) +
                    (summary.actualOnlyRows ?? 0)
                  }
                  emptyText="No registration or actual preview rows"
                >
                  <table className="min-w-[1500px] w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b-2 border-slate-200 bg-slate-100 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                        <th className="border border-slate-200 p-2 text-left">Status</th>
                        <th className="border border-slate-200 p-2 text-left">Key Regist</th>
                        <th className="border border-slate-200 p-2 text-left">Key No Regist</th>
                        <th className="border border-slate-200 p-2 text-left">Country</th>
                        <th className="border border-slate-200 p-2 text-left">Sold To</th>
                        <th className="border border-slate-200 p-2 text-left">Ship To</th>
                        <th className="border border-slate-200 p-2 text-left">Enduser</th>
                        <th className="border border-slate-200 p-2 text-left">Plant</th>
                        <th className="border border-slate-200 p-2 text-left">Material</th>
                        <th className="border border-slate-200 p-2 text-left">BU</th>
                        <th className="border border-slate-200 p-2 text-left">On/Off</th>
                        <th className="border border-slate-200 p-2 text-left">Process</th>
                        <th className="border border-slate-200 p-2 text-left">Application</th>
                        <th className="border border-slate-200 p-2 text-left">Sub App</th>
                        <th className="border border-slate-200 p-2 text-left">Owner</th>
                        <th className="border border-slate-200 p-2 text-right">Qty Actual</th>
                        <th className="border border-slate-200 p-2 text-right">Qty Fcst</th>
                      </tr>
                    </thead>
                    <tbody>
                      {unifiedPreviewRows.slice(0, 100).map(row => (
                        <tr key={`${row.status}-${row.keyNoRegist}-${row.sourceRows.join('-')}`} className="text-slate-700 even:bg-slate-50/80">
                          <td className="border border-slate-200 p-2">
                            <span className={cn(
                              'inline-flex whitespace-nowrap rounded px-2 py-0.5 text-[10px] font-semibold',
                              row.status === 'matched'
                                ? 'bg-emerald-100 text-emerald-800'
                                : row.status === 'actual_only'
                                  ? 'bg-amber-100 text-amber-800'
                                  : row.status === 'proposed_registration'
                                    ? 'bg-violet-100 text-violet-800'
                                    : 'bg-blue-100 text-blue-800'
                            )}>
                              {row.status === 'matched'
                                ? 'Matched'
                                : row.status === 'actual_only'
                                  ? 'Actual Only'
                                  : row.status === 'proposed_registration'
                                    ? 'New Registration'
                                    : 'Registration Only'}
                            </span>
                          </td>
                          <td className="border border-slate-200 p-2 font-mono">{row.keyRegist ?? '—'}</td>
                          <td className="border border-slate-200 p-2 font-mono max-w-[260px] truncate" title={row.keyNoRegist}>{row.keyNoRegist}</td>
                          <td className="border border-slate-200 p-2">{row.country ?? '—'}</td>
                          <td className="border border-slate-200 p-2 max-w-[180px] truncate" title={row.soldTo ?? undefined}>{row.soldTo ?? '—'}</td>
                          <td className="border border-slate-200 p-2 max-w-[180px] truncate" title={row.shipTo ?? undefined}>{row.shipTo ?? '—'}</td>
                          <td className="border border-slate-200 p-2 max-w-[180px] truncate" title={row.enduser ?? undefined}>{row.enduser ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.plant ?? '—'}</td>
                          <td className="border border-slate-200 p-2 font-mono">{row.materialCode ?? '—'}</td>
                          <td className="border border-slate-200 p-2 font-semibold text-sky-800">{row.businessUnit ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.onOff ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.process ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.application ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.subApplication ?? '—'}</td>
                          <td className="border border-slate-200 p-2">{row.owner ?? '—'}</td>
                          <td className="border border-slate-200 p-2 text-right font-mono">{formatPreviewNumber(row.qtyActual)}</td>
                          <td className="border border-slate-200 p-2 text-right font-mono">{formatPreviewNumber(row.qtyFcst)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </PreviewDataPanel>

                <PreviewDataPanel
                  title="Sample Importable Records"
                  count={preview.importableRecords.length}
                  totalCount={summary.importableRecords}
                  emptyText="No importable records"
                >
                  <table className="w-full border-collapse text-xs">
                    <thead>
                      <tr className="border-b-2 border-slate-200 bg-slate-100 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                        <th className="border border-slate-200 p-2 text-left">Row</th>
                        <th className="border border-slate-200 p-2 text-left">Key</th>
                        <th className="border border-slate-200 p-2 text-left">Month</th>
                        <th className="border border-slate-200 p-2 text-left">Period</th>
                        <th className="border border-slate-200 p-2 text-left">Action</th>
                        {isVersioned && (
                          <>
                            <th className="border border-slate-200 p-2 text-right">Qty</th>
                            <th className="border border-slate-200 p-2 text-right">Price</th>
                            <th className="border border-slate-200 p-2 text-right">Amount</th>
                          </>
                        )}
                        {!isVersioned && (
                          <>
                            <th className="border border-slate-200 p-2 text-right">Old Qty</th>
                            <th className="border border-slate-200 p-2 text-right">New Qty</th>
                          </>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.importableRecords.slice(0, 20).map(record => (
                        <tr key={`${record.excelKeyForNoRegist}-${record.sourceRow}-${record.sourceColumn}-${record.period}`} className="font-mono text-slate-700 even:bg-slate-50/80">
                          <td className="border border-slate-200 p-2">{record.sourceRow}</td>
                          <td className="border border-slate-200 p-2 max-w-[260px] truncate">{record.excelKeyForNoRegist}</td>
                          <td className="border border-slate-200 p-2">{record.sourceMonthHeader}</td>
                          <td className="border border-slate-200 p-2">{record.period}</td>
                          <td className="border border-slate-200 p-2">
                            <span className={cn(
                              'inline-flex rounded px-2 py-0.5 text-[10px] font-semibold uppercase',
                              record.action === 'overwrite'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-100 text-emerald-800'
                            )}>
                              {record.action}
                            </span>
                          </td>
                          {isVersioned && 'priceFcst' in record && (
                            <>
                              <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(record.qtyFcst)}</td>
                              <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(record.priceFcst, 2)}</td>
                              <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(record.amountFcst, 2)}</td>
                            </>
                          )}
                          {!isVersioned && (
                            <>
                              <td className="border border-slate-200 p-2 text-right">
                                {formatPreviewNumber(record.oldQtyFcst)}
                              </td>
                              <td className="border border-slate-200 p-2 text-right">{formatPreviewNumber(record.qtyFcst)}</td>
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </PreviewDataPanel>
                </div>
                </ImportModalErrorBoundary>
              </>
            )}

            {!loading && preview && !summary && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                Preview response is missing summary data. Restart the API server and run Preview again.
              </div>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-4 border-t border-slate-200 bg-white px-6 py-4">
          <p className="min-w-0 text-xs text-slate-500">
            {loading
              ? 'Validating Excel file — please wait…'
              : summary
                ? hasBlockingIssues
                  ? `${summary.importableRecords.toLocaleString()} importable records — fix blocking issues before confirming`
                  : `${summary.importableRecords.toLocaleString()} records ready to import · review details above before confirming`
                : file
                  ? `Selected ${file.name} — run Preview to validate`
                  : 'Upload an Excel file and run Preview to continue'}
          </p>
          <div className="ml-auto flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-300 bg-white px-5 py-2.5 text-xs font-semibold text-slate-700 transition-colors hover:bg-slate-50"
            >
              Close
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={
                confirming ||
                loading ||
                !preview ||
                !summary ||
                hasBlockingIssues ||
                summary.importableRecords === 0 ||
                Boolean(success)
              }
              className="rounded-lg bg-emerald-700 px-5 py-2.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-emerald-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {confirming ? 'Importing...' : 'Confirm Import'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function ImportValidationIssues({
  preview,
  isStalePreviewBackend,
}: Readonly<{
  preview: ForecastImportPreview;
  isStalePreviewBackend: boolean;
}>) {
  const UNMATCHED_DISPLAY_LIMIT = 75;
  const headerErrors = preview.headerErrors ?? [];
  const invalidNumericValues = preview.invalidNumericValues ?? [];
  const duplicateRegistrationMatches = preview.duplicateRegistrationMatches ?? [];
  const missingKeyRows = preview.missingKeyRows ?? [];
  const unmatchedRows = preview.unmatchedRows ?? [];
  const skippedKeyGroups = preview.skippedKeyGroups ?? [];
  const crossSheetDuplicateKeys = preview.crossSheetDuplicateKeys ?? [];
  const unmatchedTotal = preview.summary?.unmatchedRows ?? unmatchedRows.length;
  const visibleUnmatchedRows = unmatchedRows.slice(0, UNMATCHED_DISPLAY_LIMIT);

  const hasIssues =
    headerErrors.length > 0 ||
    invalidNumericValues.length > 0 ||
    duplicateRegistrationMatches.length > 0 ||
    missingKeyRows.length > 0 ||
    unmatchedRows.length > 0 ||
    skippedKeyGroups.length > 0 ||
    crossSheetDuplicateKeys.length > 0;

  if (!hasIssues) return null;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-[#003d6b] px-4 py-3">
        <h4 className="text-sm font-semibold text-white">Validation Issues</h4>
        <p className="mt-0.5 text-xs text-blue-100/90">Review each issue before confirming the import.</p>
      </div>
      <div className="space-y-4 p-4 max-h-[32rem] overflow-auto">
        {headerErrors.length > 0 && (
          <ValidationIssueTable
            title="Header Errors"
            subtitle="Blocking — fix the Excel header row and preview again"
            severity="error"
            columns={['Sheet', 'Column', 'Expected', 'Actual']}
            rows={headerErrors.map(item => [
              formatSheetLabel(item.sourceSheet),
              item.column,
              item.expected,
              item.actual,
            ])}
          />
        )}
        {missingKeyRows.length > 0 && (
          <ValidationIssueTable
            title="Missing Key"
            subtitle={`Warning — ${missingKeyRows.length} row${missingKeyRows.length === 1 ? '' : 's'} with empty column A; a synthetic key was assigned for import`}
            severity="warning"
            columns={['Sheet', 'Row', 'Excel Location', 'Issue', 'Reason', 'Suggested Fix']}
            rows={missingKeyRows.map(item => [
              formatSheetLabel(item.sourceSheet),
              String(item.sourceRow),
              formatExcelRowRef(item.sourceSheet, item.sourceRow),
              'Missing Key',
              'Column A (Key for no regist) is empty — not counted as a unique key and excluded from import',
              'Open the sheet at the row listed, enter the registration key, or delete the blank row',
            ])}
            wideColumns={[4, 5]}
          />
        )}
        {crossSheetDuplicateKeys.length > 0 && (
          <ValidationIssueTable
            title="Cross-Sheet Duplicate Keys"
            subtitle="Warning — the same key appears on multiple sheets; values were merged for import"
            severity="warning"
            columns={['Key', 'Sheet', 'Row']}
            rows={crossSheetDuplicateKeys.flatMap(item =>
              item.entries.map(entry => [
                item.excelKeyForNoRegist,
                entry.sourceSheet,
                String(entry.sourceRow),
              ])
            )}
            wideColumns={[0]}
          />
        )}
        {invalidNumericValues.length > 0 && (
          <ValidationIssueTable
            title="Invalid Numbers"
            subtitle="Warning — invalid cells were treated as 0; review before confirming"
            severity="warning"
            columns={['Sheet', 'Row', 'Column', 'Month', 'Key', 'Value', 'Reason']}
            rows={invalidNumericValues.map(item => [
              formatSheetLabel(item.sourceSheet),
              String(item.sourceRow),
              item.column,
              item.header,
              item.excelKeyForNoRegist,
              String(item.value ?? ''),
              item.reason ?? 'Not a valid number',
            ])}
            wideColumns={[6]}
          />
        )}
        {duplicateRegistrationMatches.length > 0 && (
          <ValidationIssueTable
            title="Duplicate Registration Matches"
            subtitle="Warning — multiple CRM matches; the first match is used for import"
            severity="warning"
            columns={['Sheet', 'Row', 'Key', 'Matched Registration IDs']}
            rows={duplicateRegistrationMatches.map(item => [
              formatSheetLabel(item.sourceSheet),
              String(item.sourceRow),
              item.excelKeyForNoRegist,
              item.matchedRegistrationIds.join(', '),
            ])}
            wideColumns={[3]}
          />
        )}
        {skippedKeyGroups.length > 0 && (
          <ValidationIssueTable
            title="Skipped Keys"
            subtitle="Not saved to database — excluded plant/business unit keys are dropped entirely; invalid-number keys are imported only for their valid months"
            severity="error"
            columns={['Sheet', 'Key', 'Rows', 'Qty', 'Reason']}
            rows={skippedKeyGroups.map(item => [
              formatSheetLabel(item.sourceSheet),
              item.excelKeyForNoRegist,
              item.sourceRows.join(', '),
              (item.qtyExcluded ?? 0).toLocaleString(undefined, { maximumFractionDigits: 4 }),
              item.reason,
            ])}
            wideColumns={[4]}
          />
        )}
        {unmatchedTotal > 0 && (
          <ValidationIssueTable
            title="No CRM Registration"
            subtitle={isStalePreviewBackend
              ? 'Warning — restart API server for detailed reasons'
              : unmatchedTotal > visibleUnmatchedRows.length
                ? `Warning — showing ${visibleUnmatchedRows.length} of ${unmatchedTotal} keys; registrations will be auto-created on confirm`
                : 'Warning — registrations will be auto-created on confirm for these keys'}
            severity="warning"
            columns={['Sheet', 'Row', 'Key', 'Issue', 'Reason', 'Suggested Fix']}
            rows={visibleUnmatchedRows.map(item => [
              formatSheetLabel(item.sourceSheet),
              String(item.sourceRow),
              item.excelKeyForNoRegist,
              formatUnmatchedIssueLabel(item.reasonCode),
              formatUnmatchedReason(item),
              formatUnmatchedHint(item, isStalePreviewBackend),
            ])}
            wideColumns={[2, 4, 5]}
          />
        )}
      </div>
    </div>
  );
}

function ValidationIssueTable({
  title,
  subtitle,
  severity,
  columns,
  rows,
  wideColumns = [],
}: Readonly<{
  title: string;
  subtitle: string;
  severity: 'error' | 'warning';
  columns: string[];
  rows: string[][];
  wideColumns?: number[];
}>) {
  const accentClass = severity === 'error' ? 'border-l-red-500' : 'border-l-amber-500';
  const badgeClass = severity === 'error'
    ? 'bg-red-100 text-red-800'
    : 'bg-amber-100 text-amber-900';
  const wideColumnSet = new Set(wideColumns);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-slate-200 border-l-4 bg-white shadow-sm', accentClass)}>
      <div className="border-b border-slate-200 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h5 className="text-sm font-semibold text-slate-900">{title}</h5>
          <span className={cn('rounded px-2 py-0.5 text-[10px] font-semibold uppercase', badgeClass)}>
            {severity}
          </span>
        </div>
        <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
      </div>
      <div className="max-h-56 overflow-auto">
        <table className="w-full border-collapse text-xs text-slate-700">
          <thead className="sticky top-0 z-10 bg-slate-100">
            <tr>
              {columns.map(column => (
                <th key={column} className="border border-slate-200 p-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.join('|')} className="even:bg-slate-50/70">
                {columns.map((column, cellIdx) => {
                  const cell = row[cellIdx] ?? '';
                  return (
                  <td
                    key={`${column}-${cell}`}
                    className={cn(
                      'border border-slate-200 p-2 align-top',
                      cellIdx === 0 || cellIdx === 1 ? 'font-mono' : '',
                      wideColumnSet.has(cellIdx)
                        ? 'max-w-[380px] whitespace-normal break-words'
                        : 'max-w-[200px] truncate'
                    )}
                    title={cell}
                  >
                    {cell || '—'}
                  </td>
                );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PreviewDataPanel({
  title,
  count,
  totalCount,
  emptyText,
  children,
}: Readonly<{
  title: string;
  count: number;
  totalCount?: number;
  emptyText: string;
  children: React.ReactNode;
}>) {
  const total = totalCount ?? count;
  const isSample = total > count;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 bg-slate-100 px-4 py-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-800">{title}</h4>
          {isSample && (
            <p className="mt-0.5 text-[11px] text-slate-500">
              Showing {count.toLocaleString()} of {total.toLocaleString()} — scroll inside table
            </p>
          )}
        </div>
        <span className="rounded-full bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-600 ring-1 ring-slate-200">
          {isSample ? `${count.toLocaleString()} / ${total.toLocaleString()}` : count.toLocaleString()}
        </span>
      </div>
      <div className="max-h-80 overflow-auto">
        {count === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">{emptyText}</p>
        ) : children}
      </div>
    </div>
  );
}

function PreviewStat({
  label,
  value,
  variant = 'neutral',
}: Readonly<{
  label: string;
  value: number | null | undefined;
  variant?: 'neutral' | 'primary' | 'success' | 'warning' | 'danger';
}>) {
  const displayValue = value ?? 0;
  const variantClass = {
    neutral: 'border-slate-200 bg-white text-slate-900',
    primary: 'border-[#003d6b]/20 bg-white text-[#003d6b]',
    success: 'border-emerald-200 bg-emerald-50/50 text-emerald-900',
    warning: 'border-amber-200 bg-amber-50/50 text-amber-900',
    danger: 'border-red-200 bg-red-50/50 text-red-900',
  }[variant];

  return (
    <div className={cn('rounded-lg border p-3 shadow-sm', variantClass)}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-bold font-mono tracking-tight">{displayValue.toLocaleString()}</p>
    </div>
  );
}

function PreviewList({
  title,
  emptyText,
  items,
}: Readonly<{
  title: string;
  emptyText: string;
  items: string[];
}>) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-200 bg-slate-100 px-4 py-2.5">
        <h4 className="text-xs font-semibold text-slate-800">{title}</h4>
      </div>
      <div className="max-h-36 overflow-auto p-3">
        {items.length > 0 ? (
          <ul className="space-y-2">
            {items.map(item => (
              <li
                key={item}
                className="rounded-md border border-slate-100 bg-slate-50 px-2.5 py-2 font-mono text-[11px] text-slate-700 break-all"
                title={item}
              >
                {item}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-500">{emptyText}</p>
        )}
      </div>
    </div>
  );
}
