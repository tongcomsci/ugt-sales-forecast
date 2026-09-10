import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RegColumnKey } from '../../types/forecast';
import {
  DEFAULT_COLUMN_ORDER,
  getDefaultVisibleColumnKeys,
  getOrderedColumns,
  reorderColumns,
  type OrderedRegColumn,
} from './regTableColumns';

const COLUMN_LAYOUT_STORAGE_KEY_PREFIX = 'sales-forecast:column-layout:v1';
const KNOWN_COLUMN_KEYS = new Set<string>(DEFAULT_COLUMN_ORDER);

function columnLayoutStorageKey(appMode?: string | null) {
  return appMode ? `${COLUMN_LAYOUT_STORAGE_KEY_PREFIX}:${appMode}` : COLUMN_LAYOUT_STORAGE_KEY_PREFIX;
}

function loadStoredColumnLayout(appMode?: string | null): {
  order?: RegColumnKey[];
  visibility?: Partial<Record<RegColumnKey, boolean>>;
} {
  if (globalThis.localStorage === undefined) return {};
  try {
    const raw = globalThis.localStorage.getItem(columnLayoutStorageKey(appMode));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { order?: unknown; visibility?: unknown };

    const storedOrder = Array.isArray(parsed.order)
      ? parsed.order.filter((key): key is RegColumnKey => KNOWN_COLUMN_KEYS.has(String(key)))
      : undefined;
    // Append any columns missing from the saved order (e.g. added after the user last saved)
    // so new columns still show up instead of disappearing.
    const order = storedOrder
      ? [...storedOrder, ...DEFAULT_COLUMN_ORDER.filter(key => !storedOrder.includes(key))]
      : undefined;

    const visibility =
      parsed.visibility && typeof parsed.visibility === 'object'
        ? Object.fromEntries(
            Object.entries(parsed.visibility as Record<string, unknown>).filter(
              ([key, value]) => KNOWN_COLUMN_KEYS.has(key) && typeof value === 'boolean'
            )
          )
        : undefined;

    return { order, visibility };
  } catch {
    return {};
  }
}

function buildVisibility(
  appMode?: 'nyl' | 'ufa' | null,
  storedVisibility?: Partial<Record<RegColumnKey, boolean>>
): Record<RegColumnKey, boolean> {
  const visibility = DEFAULT_COLUMN_ORDER.reduce(
    (acc, key) => ({ ...acc, [key]: false }),
    {} as Record<RegColumnKey, boolean>
  );
  getDefaultVisibleColumnKeys(appMode).forEach(key => {
    visibility[key] = true;
  });
  return { ...visibility, ...storedVisibility };
}

export function useRegTableLayout(appMode?: 'nyl' | 'ufa' | null) {
  const [columnOrder, setColumnOrder] = useState<RegColumnKey[]>(
    () => loadStoredColumnLayout(appMode).order ?? DEFAULT_COLUMN_ORDER
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [draggedColumnKey, setDraggedColumnKey] = useState<RegColumnKey | null>(null);
  const [columnVisibility, setColumnVisibility] = useState<Record<RegColumnKey, boolean>>(
    () => buildVisibility(appMode, loadStoredColumnLayout(appMode).visibility)
  );
  // Which app mode the layout above was loaded for. `appMode` is null on the first render
  // (it comes from an async /app-config fetch), so the layout has to be re-read once the
  // real mode arrives -- and must not be written back under the new key before that, or
  // the save effect overwrites the user's saved layout with defaults on every page load.
  const [layoutMode, setLayoutMode] = useState(appMode);

  useEffect(() => {
    if (layoutMode === appMode) return;
    const reloaded = loadStoredColumnLayout(appMode);
    setColumnOrder(reloaded.order ?? DEFAULT_COLUMN_ORDER);
    setColumnVisibility(buildVisibility(appMode, reloaded.visibility));
    setLayoutMode(appMode);
  }, [appMode, layoutMode]);

  useEffect(() => {
    if (globalThis.localStorage === undefined || layoutMode !== appMode) return;
    globalThis.localStorage.setItem(
      columnLayoutStorageKey(appMode),
      JSON.stringify({ order: columnOrder, visibility: columnVisibility })
    );
  }, [appMode, layoutMode, columnOrder, columnVisibility]);

  useEffect(() => {
    if (appMode !== 'ufa') return;
    setColumnVisibility(prev => {
      const next = { ...prev };
      let changed = false;
      for (const key of getDefaultVisibleColumnKeys('ufa')) {
        if (!next[key]) {
          next[key] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [appMode]);

  const orderedColumns = useMemo(
    () => getOrderedColumns(columnOrder, appMode),
    [columnOrder, appMode]
  );

  const resetColumnOrder = useCallback(() => {
    setColumnOrder(DEFAULT_COLUMN_ORDER);
  }, []);

  const handleColumnDrop = useCallback(
    (targetKey: RegColumnKey) => {
      if (!draggedColumnKey) return;
      setColumnOrder(prev => reorderColumns(prev, draggedColumnKey, targetKey));
      setDraggedColumnKey(null);
    },
    [draggedColumnKey]
  );

  const handlePanelReorder = useCallback((draggedKey: RegColumnKey, targetKey: RegColumnKey) => {
    setColumnOrder(prev => reorderColumns(prev, draggedKey, targetKey));
  }, []);

  const toggleColumnVisibility = useCallback((key: RegColumnKey) => {
    setColumnVisibility(prev => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return {
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
  };
}

export type { OrderedRegColumn };
