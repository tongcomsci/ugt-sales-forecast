import { randomUUID } from 'node:crypto';
import { getAppMode, type AppMode } from '../../../config/appMode';
import type {
  AutoCreateRegistrationPackage,
  ConfirmLegacyImportRecord,
  ConfirmVersionedImportRecord,
  ImportMode,
  VersionedNormalizedImportRecord,
} from './types';
import { PREVIEW_CACHE_TTL_MS } from './constants';
import { pruneCache } from '../boundedCache';

export type CachedPreviewPayload = {
  previewId: string;
  appMode: AppMode;
  importMode: ImportMode;
  previewContractVersion: number;
  targetVersion: string;
  legacyRecords?: ConfirmLegacyImportRecord[];
  versionedRecords?: ConfirmVersionedImportRecord[];
  legacyHasPriceColumns?: boolean;
  legacyHasAmountColumns?: boolean;
  versionedHasPriceColumns?: boolean;
  versionedHasAmountColumns?: boolean;
  amountMismatchCount: number;
  autoCreateCandidates?: AutoCreateRegistrationPackage[];
  spreadByRegistrationId?: Record<string, string>;
  pricingPolicyByRegistrationId?: Record<string, string>;
  expiresAt: number;
};

const cache = new Map<string, CachedPreviewPayload>();
const MAX_PREVIEW_CACHE_ENTRIES = 16;

export function storePreviewCache(
  payload: Omit<CachedPreviewPayload, 'previewId' | 'expiresAt' | 'appMode'> & { appMode?: AppMode }
) {
  const previewId = randomUUID();
  const entry: CachedPreviewPayload = {
    ...payload,
    appMode: payload.appMode ?? getAppMode(),
    previewId,
    expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS,
  };
  cache.set(previewId, entry);
  pruneCache(cache, MAX_PREVIEW_CACHE_ENTRIES);
  return entry;
}

export function getPreviewCache(previewId: string) {
  const entry = cache.get(previewId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(previewId);
    return null;
  }
  if (entry.appMode !== getAppMode()) return null;
  return entry;
}

export function deletePreviewCache(previewId: string) {
  cache.delete(previewId);
}

export function sampleVersionedRecords(records: VersionedNormalizedImportRecord[], limit = 50) {
  return records.slice(0, limit);
}
