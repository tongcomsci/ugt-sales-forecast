import type { NextFunction, Request, Response } from 'express';
import prisma from '../../db/prisma';
import type { AuthUser } from '../auth';
import { ensureHrEmployeeCache, NYLON_COST_CENTER } from './employeeEmail';
import { pruneCache } from './boundedCache';

export type AppRole = 'admin' | 'super_user' | 'user';

export type SessionPermissions = {
  role: AppRole;
  canManageAdmin: boolean;
  canManageEmail: boolean;
  empCode: string | null;
};

export type RoleAssignmentDto = {
  empCode: string;
  fullNameEng: string;
  currentEmail: string;
  role: 'admin' | 'super_user';
  source: string;
  assignedBy: string | null;
  assignedAt: string;
};

/**
 * HR employee codes of the built-in administrators.
 *
 * Codes rather than names: a display name is not unique, and the one on the
 * session arrives from Keycloak unverified, so matching on it would grant admin
 * to anyone able to set their own name to match. An employee code comes from HR
 * and identifies exactly one person.
 *
 * 91207 Supachai Sumeteenarumit, 91008 Wittavin Ploysopon, 91226 Pakorn Worakarn
 */
const DEFAULT_ADMIN_EMP_CODES = new Set([
  '91207',
  '91008',
  '91226',
]);

const PERMISSIONS_CACHE_TTL_MS = 60_000;
const MAX_PERMISSIONS_CACHE_ENTRIES = 512;
const permissionsCache = new Map<string, { expiresAt: number; value: SessionPermissions }>();

function isDevAuthBypass() {
  return process.env.DEV_AUTH_BYPASS === 'true';
}

function normalizeKey(value: string) {
  return value.trim().toLowerCase();
}

function normalizePersonName(value: string) {
  return normalizeKey(value).split(/\s+/).join(' ');
}

function permissionsFromRole(role: AppRole, empCode: string | null): SessionPermissions {
  return {
    role,
    empCode,
    canManageAdmin: role === 'admin',
    canManageEmail: role === 'admin' || role === 'super_user',
  };
}

function cacheKeyForUser(user: AuthUser) {
  const login = normalizeKey(user.loginName ?? user.name);
  return `${normalizeKey(user.email)}|${login}|${normalizeKey(user.name)}`;
}

export function clearPermissionsCache() {
  permissionsCache.clear();
}

type HrIdentity = {
  empCode: string;
  fullNameEng: string;
  adLoginName: string;
  currentEmail: string;
};

function isDevSessionUser(user: AuthUser) {
  const email = normalizeKey(user.email);
  const name = normalizeKey(user.name);
  return email === 'dev.local' || name === 'user (dev)';
}

function isDefaultAdminIdentity(identity: HrIdentity | null) {
  if (identity === null) return false;
  return DEFAULT_ADMIN_EMP_CODES.has(identity.empCode.trim());
}

async function ensureDefaultAdminRow(identity: HrIdentity) {
  try {
    await prisma.appUserRole.upsert({
      where: { empCode: identity.empCode },
      create: {
        empCode: identity.empCode,
        fullNameEng: identity.fullNameEng,
        currentEmail: identity.currentEmail.trim().toLowerCase(),
        role: 'admin',
        source: 'seed_admin',
      },
      update: {},
    });
  } catch (error) {
    console.warn('[appRoles] ensureDefaultAdminRow failed:', error instanceof Error ? error.message : error);
  }
}

function scoreHrIdentity(row: HrIdentity, input: {
  email: string;
  emailLocal: string;
  loginName: string;
  nameKeys: string[];
}) {
  let score = 0;
  const rowEmail = normalizeKey(row.currentEmail);
  const rowLogin = normalizeKey(row.adLoginName);
  const rowName = normalizePersonName(row.fullNameEng);
  if (rowEmail === input.email) score += 100;
  if (input.loginName && rowLogin === input.loginName) score += 90;
  if (rowLogin === input.emailLocal) score += 80;
  for (const key of input.nameKeys) {
    if (rowLogin === key) score += 70;
    if (rowName === normalizePersonName(key)) score += 60;
  }
  if (DEFAULT_ADMIN_EMP_CODES.has(row.empCode.trim())) score += 10;
  return score;
}

async function resolveHrIdentityForUser(user: AuthUser): Promise<HrIdentity | null> {
  const email = normalizeKey(user.email);
  const loginName = normalizeKey(user.loginName ?? '');
  const displayName = normalizePersonName(user.name);
  const nameKeys = [...new Set([loginName, displayName].filter(Boolean))];
  const emailLocal = email.includes('@') ? email.split('@')[0]! : email;
  if (!email && nameKeys.length === 0) return null;

  await ensureHrEmployeeCache();

  const rows = await prisma.$queryRaw<HrIdentity[]>`
    SELECT c.empCode, c.fullNameEng, c.adLoginName, c.currentEmail
    FROM dbo.hr_employee_cache c
    WHERE LOWER(LTRIM(RTRIM(c.currentEmail))) = ${email}
       OR LOWER(LTRIM(RTRIM(c.adLoginName))) = ${loginName || displayName}
       OR LOWER(LTRIM(RTRIM(c.adLoginName))) = ${emailLocal}
       OR LOWER(LTRIM(RTRIM(c.currentEmail))) = ${emailLocal}
       OR LOWER(LTRIM(RTRIM(c.fullNameEng))) = ${displayName}
       OR LOWER(REPLACE(REPLACE(LTRIM(RTRIM(c.fullNameEng)), CHAR(9), N' '), N'  ', N' ')) = ${displayName}
  `;

  if (rows.length === 0) return null;

  let best = rows[0]!;
  let bestScore = -1;
  for (const row of rows) {
    const score = scoreHrIdentity(row, { email, emailLocal, loginName, nameKeys });
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best;
}

async function lookupRoleByEmpCode(empCode: string): Promise<AppRole> {
  const row = await prisma.appUserRole.findUnique({
    where: { empCode },
    select: { role: true },
  });
  if (row?.role === 'admin') return 'admin';
  if (row?.role === 'super_user') return 'super_user';
  return 'user';
}

async function lookupRoleByEmail(email: string): Promise<{ role: AppRole; empCode: string } | null> {
  const normalized = normalizeKey(email);
  if (!normalized) return null;

  const row = await prisma.appUserRole.findFirst({
    where: { currentEmail: normalized },
    select: { role: true, empCode: true },
  });
  if (!row) return null;
  if (row.role === 'admin') return { role: 'admin', empCode: row.empCode };
  if (row.role === 'super_user') return { role: 'super_user', empCode: row.empCode };
  return null;
}

export async function resolveSessionPermissions(user: AuthUser): Promise<SessionPermissions> {
  if (isDevAuthBypass() || isDevSessionUser(user)) {
    return permissionsFromRole('admin', null);
  }

  const cacheKey = cacheKeyForUser(user);
  const cached = permissionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const identity = await resolveHrIdentityForUser(user);
  let role: AppRole = 'user';
  let empCode: string | null = identity?.empCode ?? null;

  if (isDefaultAdminIdentity(identity)) {
    role = 'admin';
    await ensureDefaultAdminRow(identity!);
  } else if (identity?.empCode) {
    role = await lookupRoleByEmpCode(identity.empCode);
  }

  if (role === 'user') {
    const assignment = await lookupRoleByEmail(user.email);
    if (assignment) {
      role = assignment.role;
      empCode = assignment.empCode;
    }
  }

  const value = permissionsFromRole(role, empCode);
  permissionsCache.set(cacheKey, { value, expiresAt: Date.now() + PERMISSIONS_CACHE_TTL_MS });
  pruneCache(permissionsCache, MAX_PERMISSIONS_CACHE_ENTRIES);
  return value;
}

export async function ensureRoleDefaults(): Promise<void> {
  try {
    await ensureHrEmployeeCache();
    const existing = await prisma.appUserRole.findMany({ select: { empCode: true } });
    const assigned = new Set(existing.map(row => row.empCode));

    const hrEmployees = await prisma.hrEmployeeCache.findMany({
      select: {
        empCode: true,
        fullNameEng: true,
        currentEmail: true,
        adLoginName: true,
      },
    });

    for (const employee of hrEmployees) {
      if (assigned.has(employee.empCode)) continue;
      if (!DEFAULT_ADMIN_EMP_CODES.has(employee.empCode.trim())) continue;
      await prisma.appUserRole.create({
        data: {
          empCode: employee.empCode,
          fullNameEng: employee.fullNameEng,
          currentEmail: employee.currentEmail,
          role: 'admin',
          source: 'seed_admin',
        },
      });
      assigned.add(employee.empCode);
    }

    const nylonEmployees = await prisma.hrEmployeeCache.findMany({
      where: { costCenterEng: NYLON_COST_CENTER },
    });

    for (const employee of nylonEmployees) {
      if (assigned.has(employee.empCode)) continue;
      await prisma.appUserRole.create({
        data: {
          empCode: employee.empCode,
          fullNameEng: employee.fullNameEng,
          currentEmail: employee.currentEmail,
          role: 'super_user',
          source: 'seed_nylon_default',
        },
      });
      assigned.add(employee.empCode);
    }
  } catch (error) {
    console.warn('[appRoles] ensureRoleDefaults failed:', error instanceof Error ? error.message : error);
  }
}

function serializeAssignment(row: {
  empCode: string;
  fullNameEng: string;
  currentEmail: string;
  role: string;
  source: string;
  assignedBy: string | null;
  assignedAt: Date;
}): RoleAssignmentDto {
  return {
    empCode: row.empCode,
    fullNameEng: row.fullNameEng,
    currentEmail: row.currentEmail,
    role: row.role as 'admin' | 'super_user',
    source: row.source,
    assignedBy: row.assignedBy,
    assignedAt: row.assignedAt.toISOString(),
  };
}

export async function listRoleAssignments(): Promise<RoleAssignmentDto[]> {
  const rows = await prisma.appUserRole.findMany({
    orderBy: [{ role: 'asc' }, { fullNameEng: 'asc' }],
  });
  return rows.map(serializeAssignment);
}

export async function replaceRoleAssignments(
  assignments: Array<{
    empCode: string;
    fullNameEng: string;
    currentEmail: string;
    role: 'admin' | 'super_user';
    source?: string;
  }>,
  assignedBy: string
) {
  const normalized = assignments
    .map(item => ({
      empCode: item.empCode.trim(),
      fullNameEng: item.fullNameEng.trim(),
      currentEmail: item.currentEmail.trim().toLowerCase(),
      role: item.role,
      source: item.source?.trim() || 'manual',
      assignedBy,
    }))
    .filter(item => item.empCode && (item.role === 'admin' || item.role === 'super_user'));

  const seen = new Set<string>();
  const unique = normalized.filter(item => {
    if (seen.has(item.empCode)) return false;
    seen.add(item.empCode);
    return true;
  });

  await prisma.$transaction([
    prisma.appUserRole.deleteMany(),
    prisma.appUserRole.createMany({
      data: unique.map(item => ({
        empCode: item.empCode,
        fullNameEng: item.fullNameEng,
        currentEmail: item.currentEmail,
        role: item.role,
        source: item.source,
        assignedBy: item.assignedBy,
      })),
    }),
  ]);

  clearPermissionsCache();
  return listRoleAssignments();
}

export async function removeRoleAssignment(empCode: string) {
  await prisma.appUserRole.deleteMany({ where: { empCode: empCode.trim() } });
  clearPermissionsCache();
}

function getSessionUser(req: Request): AuthUser | null {
  return (req as Request & { user?: AuthUser }).user ?? null;
}

export async function requireManageEmail(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  const permissions = await resolveSessionPermissions(user);
  if (!permissions.canManageEmail) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Manage Email access required' });
  }
  (req as Request & { permissions?: SessionPermissions }).permissions = permissions;
  return next();
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'AUTH_REQUIRED' });
  const permissions = await resolveSessionPermissions(user);
  if (!permissions.canManageAdmin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Admin access required' });
  }
  (req as Request & { permissions?: SessionPermissions }).permissions = permissions;
  return next();
}
