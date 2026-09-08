import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { getAppMode } from '../../config/appMode';
import prisma from '../../db/prisma';
import {
  aggregateOverplanRows,
  clearOverplanDetailQtyCache,
  getOverplanCompareDataStamp,
  loadOverplanDetailRows,
  resolveOverplanPeriods,
} from '../services/overplanData';
import {
  evaluateOverplanRow,
  type OverplanConfigThresholds,
  type OverplanResultRow,
} from '../services/overplanEvaluation';
import { normalizeRegistrationFilters } from './registrations';
import { sendOverplanNotificationEmails } from '../services/overplanNotification';
import { buildOverplanNotificationPreviews } from '../services/notificationPreview';
import { resolveComparePair } from '../services/overplanCompare';
import { pruneCache } from '../services/boundedCache';

const router = Router();
const CACHE_TTL_MS = 30 * 60 * 1000;
const CURRENT_FORECAST_VERSION = 'Current Forecast';
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

export const DEFAULT_OVERPLAN_EVALUATE_BODY = {
  startMonth: '2026-04',
  endMonth: '2027-03',
  granularity: 'month' as const,
};

let warmupPromise: Promise<void> | null = null;

type EvaluateView = 'aggregate' | 'detail';

const MAX_EVALUATION_CACHE_ENTRIES = 32;
const evaluationCoreCache = new Map<
  string,
  { expiresAt: number; promise: Promise<OverplanEvaluationCore> }
>();

type BreachStatus = 'over' | 'under';

type OverplanEvaluationCore = {
  evaluated: OverplanResultRow[];
  view: EvaluateView;
  compareLeft: string;
  compareRight: string;
  summary: {
    overCount: number;
    underCount: number;
  };
};

export type OverplanEvaluateResponse = {
  generatedAt: string;
  view: EvaluateView;
  compareLeft: string;
  compareRight: string;
  page: number;
  pageSize: number;
  totalRows: number;
  hasMore: boolean;
  breachOnly: boolean;
  summary: {
    overCount: number;
    underCount: number;
  };
  rows: OverplanResultRow[];
};

export function clearOverplanEvaluateCache(options?: { clearQty?: boolean }) {
  evaluationCoreCache.clear();
  // Threshold/config saves should keep qty cache; data imports must clear both.
  if (options?.clearQty !== false) {
    clearOverplanDetailQtyCache();
  }
  scheduleOverplanWarmup();
}

export function scheduleOverplanWarmup() {
  if (warmupPromise !== null) return warmupPromise;

  warmupPromise = (async () => {
    try {
      const config = await getOrCreateConfig();
      const configUpdatedAt = config.updatedAt.toISOString();
      const versions = await prisma.forecastVersion.findMany({
        select: { name: true },
        orderBy: { name: 'asc' },
        take: 40,
      });
      const versionNames = versions.map(row => row.name);
      const pairs = new Set<string>();
      const addPair = (left: string, right: string) => {
        if (!left || !right || left === right) return;
        pairs.add(`${left}\u0001${right}`);
      };
      addPair(config.compareLeft ?? 'Actual', config.compareRight ?? CURRENT_FORECAST_VERSION);
      addPair('Actual', CURRENT_FORECAST_VERSION);
      for (const name of versionNames) {
        if (/BB/i.test(name) || /baseline/i.test(name)) {
          addPair(name, CURRENT_FORECAST_VERSION);
        }
      }

      const jobs: Promise<unknown>[] = [];
      for (const pair of pairs) {
        const [compareLeft, compareRight] = pair.split('\u0001');
        // Detail first so aggregate reuses the shared qty cache.
        jobs.push(
          getEvaluationCore(configUpdatedAt, {
            ...DEFAULT_OVERPLAN_EVALUATE_BODY,
            compareLeft,
            compareRight,
            view: 'detail',
          }).then(() => getEvaluationCore(configUpdatedAt, {
            ...DEFAULT_OVERPLAN_EVALUATE_BODY,
            compareLeft,
            compareRight,
            view: 'aggregate',
          }))
        );
      }
      await Promise.all(jobs);
    } catch (error) {
      console.warn(
        '[overplan] warmup failed:',
        error instanceof Error ? error.message : error
      );
    } finally {
      warmupPromise = null;
    }
  })();

  return warmupPromise;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function getOrCreateConfig() {
  const existing = await prisma.overplanConfig.findUnique({ where: { id: 'default' } });
  if (existing) return existing;
  return prisma.overplanConfig.create({ data: { id: 'default' } });
}

function configToThresholds(config: Awaited<ReturnType<typeof getOrCreateConfig>>): OverplanConfigThresholds {
  return {
    aboveEnabled: config.aboveEnabled,
    belowEnabled: config.belowEnabled,
    aboveThresholdTon: decimalToNumber(config.aboveThresholdTon),
    aboveThresholdPercent: decimalToNumber(config.aboveThresholdPercent),
    belowThresholdTon: decimalToNumber(config.belowThresholdTon),
    belowThresholdPercent: decimalToNumber(config.belowThresholdPercent),
  };
}

function serializeConfig(config: Awaited<ReturnType<typeof getOrCreateConfig>>) {
  return {
    id: config.id,
    planVersionName: config.planVersionName,
    actualVsPlanEnabled: config.actualVsPlanEnabled,
    forecastVsPlanEnabled: config.forecastVsPlanEnabled,
    compareLeft: config.compareLeft ?? 'Actual',
    compareRight: config.compareRight ?? 'Current Forecast',
    aboveEnabled: config.aboveEnabled,
    belowEnabled: config.belowEnabled,
    aboveThresholdTon: decimalToNumber(config.aboveThresholdTon),
    aboveThresholdPercent: decimalToNumber(config.aboveThresholdPercent),
    belowThresholdTon: decimalToNumber(config.belowThresholdTon),
    belowThresholdPercent: decimalToNumber(config.belowThresholdPercent),
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt.toISOString(),
  };
}

router.get('/config', async (_req, res) => {
  try {
    const config = await getOrCreateConfig();
    res.json(serializeConfig(config));
  } catch (error) {
    console.error('[overplan] get config error:', error);
    res.status(500).json({ error: 'Failed to load overplan config' });
  }
});

router.get('/summary', async (req, res) => {
  try {
    const startMonth = String(req.query.startMonth ?? DEFAULT_OVERPLAN_EVALUATE_BODY.startMonth);
    const endMonth = String(req.query.endMonth ?? DEFAULT_OVERPLAN_EVALUATE_BODY.endMonth);
    const view: EvaluateView = req.query.view === 'detail' ? 'detail' : 'aggregate';
    const granularity = req.query.granularity === 'week' ? 'week' : 'month';

    const config = await getOrCreateConfig();
    const core = await getEvaluationCore(config.updatedAt.toISOString(), {
      startMonth,
      endMonth,
      view,
      granularity,
      compareLeft: config.compareLeft,
      compareRight: config.compareRight,
    });

    res.json({
      generatedAt: new Date().toISOString(),
      view: core.view,
      compareLeft: core.compareLeft,
      compareRight: core.compareRight,
      summary: core.summary,
    });
  } catch (error) {
    console.error('[overplan] get summary error:', error);
    const message = error instanceof Error ? error.message : 'Failed to load overplan summary';
    res.status(400).json({ error: message });
  }
});

router.patch('/config', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const sessionUser = (req as typeof req & { user?: { name?: string; email?: string } }).user;
    const updatedBy = String(sessionUser?.name ?? sessionUser?.email ?? 'sales-forecast-web').trim();
    const data: Record<string, unknown> = { updatedBy: updatedBy || 'sales-forecast-web' };

    if (typeof body.planVersionName === 'string' && body.planVersionName.trim()) {
      data.planVersionName = body.planVersionName.trim();
    }
    if (body.compareLeft !== undefined || body.compareRight !== undefined) {
      const current = await getOrCreateConfig();
      const resolved = await resolveComparePair({
        compareLeft: body.compareLeft ?? current.compareLeft,
        compareRight: body.compareRight ?? current.compareRight,
      });
      data.compareLeft = resolved.compareLeft;
      data.compareRight = resolved.compareRight;
    }
    for (const key of ['aboveEnabled', 'belowEnabled'] as const) {
      if (typeof body[key] === 'boolean') data[key] = body[key];
    }
    for (const key of [
      'aboveThresholdTon',
      'aboveThresholdPercent',
      'belowThresholdTon',
      'belowThresholdPercent',
    ] as const) {
      if (body[key] === null) {
        data[key] = null;
      } else if (body[key] !== undefined) {
        const parsed = Number(body[key]);
        if (!Number.isFinite(parsed)) {
          return res.status(400).json({ error: `Invalid ${key}` });
        }
        data[key] = parsed;
      }
    }

    const config = await prisma.overplanConfig.upsert({
      where: { id: 'default' },
      create: { id: 'default', ...(data as object) },
      update: data,
    });
    clearOverplanEvaluateCache({ clearQty: false });
    res.json(serializeConfig(config));
  } catch (error) {
    console.error('[overplan] patch config error:', error);
    res.status(500).json({ error: 'Failed to save overplan config' });
  }
});

router.get('/recipients', async (_req, res) => {
  try {
    const recipients = await prisma.overplanRecipient.findMany({
      orderBy: [{ reportType: 'asc' }, { sortOrder: 'asc' }, { email: 'asc' }],
    });
    res.json(recipients.map(recipient => ({
      id: recipient.id,
      reportType: recipient.reportType,
      email: recipient.email,
      displayName: recipient.displayName,
      isActive: recipient.isActive,
      sortOrder: recipient.sortOrder,
    })));
  } catch (error) {
    console.error('[overplan] get recipients error:', error);
    res.status(500).json({ error: 'Failed to load overplan recipients' });
  }
});

router.put('/recipients', async (req, res) => {
  try {
    const body = req.body as { recipients?: unknown };
    if (!Array.isArray(body.recipients)) {
      return res.status(400).json({ error: 'recipients array is required' });
    }

    const allowedTypes = new Set(['aggregate', 'non_aggregate', 'forecast_change']);
    const normalized = body.recipients
      .filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object')
      .map((value, index) => {
        const reportType = String(value.reportType ?? '').trim();
        const email = String(value.email ?? '').trim().toLowerCase();
        if (!allowedTypes.has(reportType) || !email) return null;
        return {
          id: typeof value.id === 'string' && value.id.trim() ? value.id.trim() : undefined,
          reportType,
          email,
          displayName: String(value.displayName ?? '').trim() || null,
          isActive: value.isActive !== false,
          sortOrder: Number.isFinite(Number(value.sortOrder)) ? Number(value.sortOrder) : index,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);

    await prisma.$transaction([
      prisma.overplanRecipient.deleteMany(),
      prisma.overplanRecipient.createMany({
        data: normalized.map(item => ({
          id: item.id ?? randomUUID(),
          reportType: item.reportType,
          email: item.email,
          displayName: item.displayName,
          isActive: item.isActive,
          sortOrder: item.sortOrder,
        })),
      }),
    ]);

    const recipients = await prisma.overplanRecipient.findMany({
      orderBy: [{ reportType: 'asc' }, { sortOrder: 'asc' }, { email: 'asc' }],
    });
    res.json(recipients);
  } catch (error) {
    console.error('[overplan] put recipients error:', error);
    res.status(500).json({ error: 'Failed to save overplan recipients' });
  }
});

async function buildEvaluationCore(body: Record<string, unknown>): Promise<OverplanEvaluationCore> {
  const startMonth = String(body.startMonth ?? '');
  const endMonth = String(body.endMonth ?? '');
  const view: EvaluateView = body.view === 'aggregate' ? 'aggregate' : 'detail';
  const granularity = body.granularity === 'week' ? 'week' : 'month';

  if (!/^\d{4}-\d{2}$/.test(startMonth) || !/^\d{4}-\d{2}$/.test(endMonth)) {
    throw new Error('Invalid startMonth or endMonth');
  }

  const config = await getOrCreateConfig();
  const thresholds = configToThresholds(config);
  const { compareLeft, compareRight } = await resolveComparePair({
    compareLeft: body.compareLeft,
    compareRight: body.compareRight,
    fallbackLeft: config.compareLeft,
    fallbackRight: config.compareRight,
  });
  const compareLabel = `${compareLeft} vs ${compareRight}`;
  const filters = normalizeRegistrationFilters(body.filters);
  // Detail qty is shared/cached across aggregate+detail and threshold-only cache busts.
  const detailRows = await loadOverplanDetailRows({
    filters,
    startMonth,
    endMonth,
    granularity,
    compareLeft,
    compareRight,
  });
  const sourceRows = view === 'aggregate' ? aggregateOverplanRows(detailRows) : detailRows;

  const evaluated = sourceRows.map(row => {
    const metrics = evaluateOverplanRow(
      {
        leftQty: row.leftQty,
        rightQty: row.rightQty,
      },
      thresholds,
      compareLabel
    );
    return {
      materialCode: row.materialCode,
      materialDescription: row.materialDescription,
      plantCode: row.plantCode,
      period: row.period,
      leftQty: metrics.leftQty,
      rightQty: metrics.rightQty,
      diffQty: metrics.diffQty,
      pctVsRight: metrics.pctVsRight,
      status: metrics.status,
      breachReasons: metrics.breachReasons,
      ownerName: row.ownerName || undefined,
      registrationId: view === 'detail' ? row.registrationId : undefined,
    } satisfies OverplanResultRow;
  });

  evaluated.sort((left, right) => {
    const statusOrder = { over: 0, under: 1, ok: 2 };
    return statusOrder[left.status] - statusOrder[right.status]
      || left.period.localeCompare(right.period)
      || left.materialCode.localeCompare(right.materialCode)
      || left.plantCode.localeCompare(right.plantCode);
  });

  return {
    evaluated,
    view,
    compareLeft,
    compareRight,
    summary: {
      overCount: evaluated.filter(row => row.status === 'over').length,
      underCount: evaluated.filter(row => row.status === 'under').length,
    },
  };
}

function evaluationCoreCacheKey(
  configUpdatedAt: string,
  body: Record<string, unknown>,
  dataStamp: string
) {
  return stableJson({
    appMode: getAppMode(),
    configUpdatedAt,
    dataStamp,
    startMonth: body.startMonth,
    endMonth: body.endMonth,
    view: body.view,
    granularity: body.granularity,
    compareLeft: body.compareLeft,
    compareRight: body.compareRight,
    filters: body.filters,
  });
}

async function getEvaluationCore(
  configUpdatedAt: string,
  body: Record<string, unknown>
): Promise<OverplanEvaluationCore> {
  const compareLeft = String(body.compareLeft ?? '');
  const compareRight = String(body.compareRight ?? '');
  const dataStamp = await getOverplanCompareDataStamp(compareLeft, compareRight);
  const cacheKey = evaluationCoreCacheKey(configUpdatedAt, body, dataStamp);
  const cached = evaluationCoreCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.promise;
  }

  const promise = buildEvaluationCore(body);
  evaluationCoreCache.set(cacheKey, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    promise,
  });
  pruneCache(evaluationCoreCache, MAX_EVALUATION_CACHE_ENTRIES);
  return promise;
}

function parseEvaluatePaging(body: Record<string, unknown>) {
  const page = Math.max(1, Math.floor(Number(body.page)) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(body.pageSize)) || DEFAULT_PAGE_SIZE)
  );
  const rawStatus = String(body.status ?? '').trim().toLowerCase();
  const status = rawStatus === 'over' || rawStatus === 'under' ? rawStatus as BreachStatus : null;
  return { page, pageSize, status };
}

function filterBreachRows(rows: OverplanResultRow[], status: BreachStatus | null) {
  const breaches = rows.filter(row => row.status !== 'ok');
  if (!status) return breaches;
  return breaches.filter(row => row.status === status);
}

function buildEvaluateResponse(
  core: OverplanEvaluationCore,
  body: Record<string, unknown>
): OverplanEvaluateResponse {
  const { page, pageSize, status } = parseEvaluatePaging(body);
  const breachRows = filterBreachRows(core.evaluated, status);
  const totalRows = breachRows.length;
  const start = (page - 1) * pageSize;
  const rows = breachRows.slice(start, start + pageSize);

  return {
    generatedAt: new Date().toISOString(),
    view: core.view,
    compareLeft: core.compareLeft,
    compareRight: core.compareRight,
    page,
    pageSize,
    totalRows,
    hasMore: start + rows.length < totalRows,
    breachOnly: true,
    summary: core.summary,
    rows,
  };
}


router.post('/evaluate', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const config = await getOrCreateConfig();
    const core = await getEvaluationCore(config.updatedAt.toISOString(), body);
    res.json(buildEvaluateResponse(core, body));
  } catch (error) {
    console.error('[overplan] evaluate error:', error);
    const message = error instanceof Error ? error.message : 'Failed to evaluate overplan';
    res.status(400).json({ error: message });
  }
});

router.post('/preview-notify', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    body.previewOnly = true;
    const config = await getOrCreateConfig();
    const configUpdatedAt = config.updatedAt.toISOString();
    const [detailCore, aggregateCore] = await Promise.all([
      getEvaluationCore(configUpdatedAt, { ...body, view: 'detail' }),
      getEvaluationCore(configUpdatedAt, { ...body, view: 'aggregate' }),
    ]);
    const breachedRows = detailCore.evaluated.filter(row => row.status !== 'ok');
    const aggregateBreached = aggregateCore.evaluated.filter(row => row.status !== 'ok');
    const startMonth = String(body.startMonth ?? '');
    const endMonth = String(body.endMonth ?? '');
    const previews = await buildOverplanNotificationPreviews({
      startMonth,
      endMonth,
      compareLeft: aggregateCore.compareLeft,
      compareRight: aggregateCore.compareRight,
      detailRows: breachedRows,
      aggregateRows: aggregateBreached,
    });
    res.json({
      ok: true,
      previewOnly: true,
      sent: 0,
      batches: previews,
      breachedDetailRows: breachedRows.length,
      breachedAggregateRows: aggregateBreached.length,
    });
  } catch (error) {
    console.error('[overplan] preview-notify error:', error);
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to preview overplan notifications' });
  }
});

router.post('/notify', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const previewOnly = body.previewOnly === true;
    const config = await getOrCreateConfig();
    const configUpdatedAt = config.updatedAt.toISOString();
    const [detailCore, aggregateCore] = await Promise.all([
      getEvaluationCore(configUpdatedAt, { ...body, view: 'detail' }),
      getEvaluationCore(configUpdatedAt, { ...body, view: 'aggregate' }),
    ]);
    const breachedRows = detailCore.evaluated.filter(row => row.status !== 'ok');
    const aggregateBreached = aggregateCore.evaluated.filter(row => row.status !== 'ok');

    if (previewOnly) {
      const startMonth = String(body.startMonth ?? '');
      const endMonth = String(body.endMonth ?? '');
      const previews = await buildOverplanNotificationPreviews({
        startMonth,
        endMonth,
        compareLeft: aggregateCore.compareLeft,
        compareRight: aggregateCore.compareRight,
        detailRows: breachedRows,
        aggregateRows: aggregateBreached,
      });
      res.json({
        ok: true,
        previewOnly: true,
        sent: 0,
        batches: previews,
        breachedDetailRows: breachedRows.length,
        breachedAggregateRows: aggregateBreached.length,
      });
      return;
    }

    const sendResult = await sendOverplanNotificationEmails({
      detailRows: breachedRows,
      aggregateRows: aggregateBreached,
      compareLeft: aggregateCore.compareLeft,
      compareRight: aggregateCore.compareRight,
    });

    res.json({
      ok: true,
      sent: sendResult.sent,
      skipped: sendResult.skipped,
      breachedDetailRows: breachedRows.length,
      breachedAggregateRows: aggregateBreached.length,
    });
  } catch (error) {
    console.error('[overplan] notify error:', error);
    res.status(500).json({ error: 'Failed to send overplan notifications' });
  }
});

export { CURRENT_FORECAST_VERSION, resolveOverplanPeriods };

export default router;
