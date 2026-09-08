import prisma from '../../db/prisma';
import { normalizePricingPolicy } from '../../lib/pricingPolicy';

/** Keep raw text (including formula notes). Empty → null. */
export function normalizeSpread(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error('Spread must be text or a finite number'), { code: 'VALIDATION' });
    }
    return String(value);
  }
  const text = String(value).trim();
  return text === '' ? null : text;
}

/** Parse numeric-only spread for price math; notes / non-numeric → 0. */
export function parseNumericSpread(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  const text = String(value).trim().replaceAll(',', '');
  if (text === '') return 0;
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 0;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePricingPolicyInput(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === '') return null;
  const known = normalizePricingPolicy(text);
  if (known) return known;
  // Persist unknown Excel values as-is (truncated) so import doesn't lose them;
  // grid calc will ignore unknown policies via normalizePricingPolicy.
  return text.slice(0, 50);
}

export async function upsertRegistrationSpread(
  registrationId: string,
  spreadInput: unknown,
  updatedBy?: string,
) {
  const result = await upsertRegistrationPriceSettings(registrationId, {
    spread: spreadInput,
    updatedBy,
  });
  return { registrationId: result.registrationId, spread: result.spread };
}

export async function upsertRegistrationPriceSettings(
  registrationId: string,
  options: {
    spread?: unknown;
    pricingPolicy?: unknown;
    updatedBy?: string;
  },
) {
  const id = String(registrationId ?? '').trim();
  if (!id) {
    throw Object.assign(new Error('Registration id is required'), { code: 'VALIDATION' });
  }

  const hasSpread = Object.prototype.hasOwnProperty.call(options, 'spread');
  const hasPolicy = Object.prototype.hasOwnProperty.call(options, 'pricingPolicy');
  if (!hasSpread && !hasPolicy) {
    throw Object.assign(new Error('spread or pricingPolicy is required'), { code: 'VALIDATION' });
  }

  const spread = hasSpread ? normalizeSpread(options.spread) : undefined;
  const pricingPolicy = hasPolicy ? normalizePricingPolicyInput(options.pricingPolicy) : undefined;
  const updatedBy = options.updatedBy ?? null;

  const managed = await prisma.masterDataCrmRegistration.findFirst({
    where: { OR: [{ id }, { newKey: id }] },
    select: { id: true, spread: true, pricingPolicy: true },
  });

  if (managed) {
    await prisma.masterDataCrmRegistration.update({
      where: { id: managed.id },
      data: {
        ...(hasSpread ? { spread } : {}),
        ...(hasPolicy ? { pricingPolicy } : {}),
      },
    });
    return {
      registrationId: managed.id,
      spread: hasSpread ? spread ?? null : managed.spread,
      pricingPolicy: hasPolicy ? pricingPolicy ?? null : managed.pricingPolicy,
    };
  }

  const existing = await prisma.registrationPriceSetting.findUnique({
    where: { registrationId: id },
    select: { spread: true, pricingPolicy: true },
  });

  const nextSpread = hasSpread ? spread ?? null : existing?.spread ?? null;
  const nextPolicy = hasPolicy ? pricingPolicy ?? null : existing?.pricingPolicy ?? null;

  await prisma.$executeRaw`
    MERGE [dbo].[registration_price_settings] WITH (HOLDLOCK) AS target
    USING (
      SELECT
        ${id} AS registrationId,
        ${nextSpread} AS spread,
        ${nextPolicy} AS pricingPolicy,
        ${updatedBy} AS updatedBy
    ) AS source
    ON target.[registrationId] = source.registrationId
    WHEN MATCHED THEN
      UPDATE SET
        [spread] = source.spread,
        [pricingPolicy] = source.pricingPolicy,
        [updatedBy] = source.updatedBy,
        [updatedAt] = GETUTCDATE()
    WHEN NOT MATCHED THEN
      INSERT ([registrationId], [spread], [pricingPolicy], [updatedBy], [updatedAt])
      VALUES (source.registrationId, source.spread, source.pricingPolicy, source.updatedBy, GETUTCDATE());
  `;

  return {
    registrationId: id,
    spread: nextSpread,
    pricingPolicy: nextPolicy,
  };
}
