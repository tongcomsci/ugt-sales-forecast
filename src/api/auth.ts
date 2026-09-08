import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import {
  DEFAULT_APP_BASE_PATH,
  parsePublicAppMode,
  toPublicAppMode,
  type AppMode,
} from '../config/appMode';
import { resolveSessionPermissions } from './services/appRoles';
import { dropExpired } from './services/boundedCache';

export interface AuthUser {
  name: string;
  email: string;
  loginName?: string;
}

interface OidcMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
  userinfo_endpoint?: string;
}

interface AuthState {
  nonce: string;
  codeVerifier: string;
  createdAt: number;
  returnMode?: AppMode;
}

interface SessionData {
  user: AuthUser;
  idToken?: string;
}

const SESSION_COOKIE = 'sf_session';
const OAUTH_STATE_COOKIE = 'sf_oauth_state';
const STATE_TTL_MS = 30 * 60 * 1000;
/**
 * Server-side session lifetime. The cookie carries the same maxAge, but that is
 * only enforced by the browser: without an expiry held here, a captured cookie
 * value would stay valid forever and the map would never shrink.
 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map<string, SessionData & { expiresAt: number }>();
const authStates = new Map<string, AuthState>();

/** Store a freshly authenticated session and clear out any that have lapsed. */
function storeSession(sessionId: string, session: SessionData) {
  dropExpired(sessions);
  sessions.set(sessionId, { ...session, expiresAt: Date.now() + SESSION_TTL_MS });
}

/** Resolve a session id, treating a lapsed session as absent. */
function readSession(sessionId: string | undefined): SessionData | null {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return entry;
}

/** Abandoned login attempts are never completed, so sweep them by age. */
function sweepAuthStates() {
  const cutoff = Date.now() - STATE_TTL_MS;
  for (const [key, state] of authStates) {
    if (state.createdAt <= cutoff) authStates.delete(key);
  }
}

class AuthHttpError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'AuthHttpError';
  }
}

export function normalizeBasePath(value = process.env.APP_BASE_PATH ?? DEFAULT_APP_BASE_PATH) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') return '';
  return `/${trimmed.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

function resolveReturnMode(req?: Request, fallback?: AppMode): AppMode {
  if (req) {
    const queryMode = typeof req.query.mode === 'string' ? req.query.mode : undefined;
    const headerMode = req.header('x-app-mode') ?? undefined;
    if (queryMode || headerMode) return parsePublicAppMode(queryMode ?? headerMode);
  }
  return fallback ?? 'nyl';
}

export function getAppPath(req?: Request, mode?: AppMode) {
  const basePath = normalizeBasePath();
  const resolvedMode = mode ?? resolveReturnMode(req);
  const publicMode = toPublicAppMode(resolvedMode);
  // Keep a trailing slash before ? so Vite base (/ugt-sales-forecast/) and
  // Keycloak Root/Home URLs resolve assets correctly after SSO.
  const path = basePath ? `${basePath}/` : '/';
  return `${path}?mode=${publicMode}`;
}

/** Absolute post-login / post-logout URL (required behind reverse proxies). */
export function getAbsoluteAppUrl(req?: Request, mode?: AppMode) {
  return `${getPublicBaseUrl(req)}${getAppPath(req, mode)}`;
}

function isDevAuthBypass() {
  return process.env.DEV_AUTH_BYPASS === 'true';
}

function getDevUser(): AuthUser {
  return { name: 'User (Dev)', email: 'dev.local', loginName: 'dev' };
}

function parseCookies(cookieHeader: string | undefined) {
  const cookies = new Map<string, string>();
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(part => {
    const [name, ...valueParts] = part.trim().split('=');
    if (name) cookies.set(name, decodeURIComponent(valueParts.join('=')));
  });
  return cookies;
}

function setSessionCookie(res: Response, sessionId: string) {
  const basePath = normalizeBasePath();
  const secure = process.env.NODE_ENV === 'production';
  res.cookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: basePath || '/',
    // Same lifetime the server enforces, so the two cannot drift apart.
    maxAge: SESSION_TTL_MS,
  });
}

function clearSessionCookie(res: Response) {
  const basePath = normalizeBasePath();
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: basePath || '/',
  });
}

function getCookieOptions(path: string, maxAge?: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path,
    ...(maxAge ? { maxAge } : {}),
  };
}

function getStateCookiePath() {
  const basePath = normalizeBasePath();
  return `${basePath || ''}/auth`;
}

function getSigningSecret() {
  return process.env.SESSION_SECRET || 'sales-forecast-dev-session-secret';
}

function getStateEncryptionKey() {
  return crypto.createHash('sha256').update(getSigningSecret()).digest();
}

function encodeAuthStateToken(authState: AuthState) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getStateEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(authState), 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString('base64url');
}

function decodeAuthStateToken(value: string) {
  if (!value) return null;
  try {
    const payload = Buffer.from(value, 'base64url');
    if (payload.length <= 28) return null;
    const iv = payload.subarray(0, 12);
    const authTag = payload.subarray(12, 28);
    const encrypted = payload.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', getStateEncryptionKey(), iv);
    decipher.setAuthTag(authTag);
    const decoded = JSON.parse(
      Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    ) as Partial<AuthState>;
    if (
      typeof decoded.nonce !== 'string' ||
      typeof decoded.codeVerifier !== 'string' ||
      typeof decoded.createdAt !== 'number'
    ) {
      return null;
    }
    return {
      nonce: decoded.nonce,
      codeVerifier: decoded.codeVerifier,
      createdAt: decoded.createdAt,
      returnMode: decoded.returnMode === 'ufa' ? 'ufa' : decoded.returnMode === 'nyl' ? 'nyl' : undefined,
    };
  } catch {
    return null;
  }
}

function signStatePayload(payload: string) {
  return crypto
    .createHmac('sha256', getSigningSecret())
    .update(payload)
    .digest('base64url');
}

function encodeStateCookie(state: string, authState: AuthState) {
  const payload = Buffer.from(JSON.stringify({ state, ...authState })).toString('base64url');
  const signature = signStatePayload(payload);
  return `${payload}.${signature}`;
}

function decodeStateCookie(value: string | undefined) {
  if (!value) return null;
  const [payload, signature] = value.split('.');
  if (!payload || !signature || signStatePayload(payload) !== signature) return null;
  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as AuthState & { state?: unknown };
    if (
      typeof decoded.state !== 'string' ||
      typeof decoded.nonce !== 'string' ||
      typeof decoded.codeVerifier !== 'string' ||
      typeof decoded.createdAt !== 'number'
    ) {
      return null;
    }
    return {
      state: decoded.state,
      authState: {
        nonce: decoded.nonce,
        codeVerifier: decoded.codeVerifier,
        createdAt: decoded.createdAt,
        returnMode: decoded.returnMode === 'ufa' ? 'ufa' : decoded.returnMode === 'nyl' ? 'nyl' : undefined,
      },
    };
  } catch {
    return null;
  }
}

function setOAuthStateCookie(res: Response, state: string, authState: AuthState) {
  res.cookie(
    OAUTH_STATE_COOKIE,
    encodeStateCookie(state, authState),
    getCookieOptions(getStateCookiePath(), STATE_TTL_MS)
  );
}

function clearOAuthStateCookie(res: Response) {
  res.clearCookie(OAUTH_STATE_COOKIE, getCookieOptions(getStateCookiePath()));
}

function getUserFromRequest(req: Request): AuthUser | null {
  if (isDevAuthBypass()) return getDevUser();
  const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  return readSession(sessionId)?.user ?? null;
}

function getSessionFromRequest(req: Request): SessionData | null {
  if (isDevAuthBypass()) return { user: getDevUser() };
  const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  return readSession(sessionId);
}

function base64UrlDecode(value: string) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split('.');
  if (!payload) return {};
  return JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
}

function runCurl(args: string[], input?: string) {
  return new Promise<string>((resolve, reject) => {
    const command = process.platform === 'win32' ? 'curl.exe' : 'curl';
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`curl failed with exit code ${code}: ${stderr.slice(0, 160)}`));
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function postFormJson<T>(url: string, params: URLSearchParams): Promise<T> {
  const body = params.toString();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new AuthHttpError('Token exchange failed', response.status);
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof AuthHttpError) throw error;
    console.warn('[auth] Keycloak token fetch failed; retrying with curl fallback.');
    const output = await runCurl([
      '-sS',
      '-X',
      'POST',
      url,
      '-H',
      'Content-Type: application/x-www-form-urlencoded',
      '--data-binary',
      '@-',
      '-w',
      '\n%{http_code}',
    ], body);
    const markerIndex = output.lastIndexOf('\n');
    const responseBody = markerIndex >= 0 ? output.slice(0, markerIndex) : output;
    const status = Number(markerIndex >= 0 ? output.slice(markerIndex + 1).trim() : 0);
    if (status < 200 || status >= 300) {
      throw new AuthHttpError('Token exchange failed', status || undefined);
    }
    return JSON.parse(responseBody) as T;
  }
}

function userFromClaims(claims: Record<string, unknown>): AuthUser {
  const preferredUsername = String(claims.preferred_username ?? '').trim();
  const displayName = String(claims.name ?? claims.displayName ?? '').trim();
  const email = String(
    claims.email ||
    preferredUsername ||
    ''
  ).trim();
  const name = String(displayName || preferredUsername || email || 'User').trim();
  const loginName = preferredUsername || (email.includes('@') ? email.split('@')[0] : email) || name;
  return {
    name: name || email || 'User',
    email: email || 'unknown',
    loginName: loginName.trim() || undefined,
  };
}

async function getOidcMetadata(): Promise<OidcMetadata> {
  const issuer = process.env.KEYCLOAK_ISSUER;
  if (!issuer) throw new Error('KEYCLOAK_ISSUER is not configured');
  const normalizedIssuer = issuer.replace(/\/+$/, '');
  const discoveryUrl = `${normalizedIssuer}/.well-known/openid-configuration`;
  try {
    const response = await fetch(discoveryUrl);
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`);
    return response.json() as Promise<OidcMetadata>;
  } catch (error) {
    console.warn('[auth] Keycloak discovery failed; using issuer-derived endpoints.');
    return {
      authorization_endpoint: `${normalizedIssuer}/protocol/openid-connect/auth`,
      token_endpoint: `${normalizedIssuer}/protocol/openid-connect/token`,
      userinfo_endpoint: `${normalizedIssuer}/protocol/openid-connect/userinfo`,
      end_session_endpoint: `${normalizedIssuer}/protocol/openid-connect/logout`,
    };
  }
}

function randomBase64Url(byteLength: number) {
  return crypto.randomBytes(byteLength).toString('base64url');
}

function createCodeChallenge(codeVerifier: string) {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function getPublicBaseUrl(req?: Request) {
  // Explicit override wins (set this in production, e.g. https://ugtweb.ube.co.th).
  const configured = process.env.APP_BASE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  // Otherwise derive from the incoming request so the deployed host is used
  // instead of a hardcoded localhost. Honors reverse-proxy forwarded headers.
  if (req) {
    const forwardedProto = String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim();
    const forwardedHost = String(req.headers['x-forwarded-host'] ?? '')
      .split(',')[0]
      .trim();
    const proto = forwardedProto || req.protocol || 'http';
    const host = forwardedHost || String(req.headers.host ?? '').trim();
    if (host) return `${proto}://${host}`.replace(/\/+$/, '');
  }

  // Last-resort dev fallback only (never reached in production where the host
  // is always known from the request or APP_BASE_URL).
  return 'http://localhost:3000';
}

function getCallbackUrl(req?: Request) {
  return `${getPublicBaseUrl(req)}${normalizeBasePath()}/auth/callback`;
}

function getPostLogoutUrl(req?: Request) {
  return getAbsoluteAppUrl(req);
}

function renderLoginPage(message?: string, authStartPath = `${normalizeBasePath()}/auth/start?mode=nylon`) {
  const safeMessage = message
    ? [...message].map(char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      }[char] ?? char)).join('')
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>UGT Sales Forecast</title>
  <style>
    :root {
      --brand: #007ABE;
      --brand-dark: #005f96;
      --ink: #172033;
      --muted: #7b879c;
      --line: #dce5ef;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      font-family: Inter, "Segoe UI", Arial, sans-serif;
      color: var(--ink);
      background: #f8fbff;
    }
    .page {
      min-height: 100%;
      display: grid;
      grid-template-columns: minmax(420px, 50vw) minmax(420px, 1fr);
    }
    .panel {
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      background: #fff;
      border-right: 1px solid rgba(15, 23, 42, 0.08);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 38px 44px;
      font-weight: 800;
      letter-spacing: -0.02em;
      font-size: 20px;
    }
    .mark {
      display: grid;
      place-items: center;
      width: 34px;
      height: 34px;
      border-radius: 8px;
      background: var(--brand);
      color: white;
      box-shadow: 0 10px 22px rgba(0, 122, 190, 0.22);
    }
    .mark svg { width: 19px; height: 19px; }
    .content {
      flex: 1;
      display: grid;
      place-items: center;
      padding: 28px 42px 80px;
    }
    .card {
      width: min(460px, 100%);
      text-align: center;
    }
    .eyebrow {
      color: var(--brand);
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.18em;
      font-weight: 800;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      font-size: clamp(28px, 3vw, 38px);
      line-height: 1.05;
      letter-spacing: -0.05em;
    }
    .subtitle {
      margin: 14px 0 0;
      font-size: 14px;
      line-height: 1.7;
      color: var(--muted);
    }
    .login-button {
      margin-top: 34px;
      width: 100%;
      height: 52px;
      border: 0;
      border-radius: 8px;
      background: var(--brand);
      color: #fff;
      font-size: 14px;
      font-weight: 800;
      letter-spacing: 0.02em;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      text-decoration: none;
      box-shadow: 0 14px 28px rgba(0, 122, 190, 0.24);
      transition: transform 150ms ease, background 150ms ease, box-shadow 150ms ease;
    }
    .login-button:hover {
      background: var(--brand-dark);
      transform: translateY(-1px);
      box-shadow: 0 18px 36px rgba(0, 122, 190, 0.26);
    }
    .login-button svg { width: 18px; height: 18px; }
    .note {
      margin-top: 18px;
      color: #98a4b8;
      font-size: 12px;
    }
    .error {
      margin-top: 18px;
      padding: 12px 14px;
      border: 1px solid #fecaca;
      border-radius: 8px;
      color: #b91c1c;
      background: #fff1f2;
      font-size: 12px;
      text-align: left;
    }
    .visual {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
      background:
        linear-gradient(90deg, rgba(0, 55, 87, 0.45), rgba(0, 122, 190, 0.08)),
        linear-gradient(180deg, rgba(10, 50, 86, 0.18), rgba(2, 22, 37, 0.72)),
        radial-gradient(circle at 78% 38%, rgba(95, 211, 255, 0.32), transparent 20%),
        linear-gradient(160deg, #56b4f2 0%, #6ec7ff 28%, #f0a8a0 46%, #104d79 72%, #061927 100%);
    }
    .visual::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        repeating-linear-gradient(90deg, transparent 0 72px, rgba(255,255,255,0.12) 73px 75px),
        repeating-linear-gradient(0deg, transparent 0 82px, rgba(255,255,255,0.08) 83px 85px);
      mask-image: linear-gradient(115deg, transparent 0 23%, black 23% 100%);
      opacity: 0.55;
    }
    .plant {
      position: absolute;
      right: -40px;
      bottom: -12px;
      width: min(720px, 78vw);
      height: 72vh;
      opacity: 0.9;
    }
    .tower, .pipe, .tank, .stack { position: absolute; border: 3px solid rgba(10, 31, 45, 0.82); }
    .tower {
      right: 40px;
      bottom: 110px;
      width: 240px;
      height: 440px;
      background: linear-gradient(180deg, rgba(255,255,255,0.05), rgba(0,0,0,0.08));
      box-shadow: inset 0 0 0 999px rgba(255,255,255,0.03);
    }
    .tower::before, .tower::after {
      content: "";
      position: absolute;
      inset: 42px 0 auto;
      height: 3px;
      background: rgba(10,31,45,0.8);
      box-shadow: 0 92px rgba(10,31,45,0.8), 0 184px rgba(10,31,45,0.8), 0 276px rgba(10,31,45,0.8);
    }
    .tower::after {
      inset: 0 auto 0 50%;
      width: 3px;
      height: auto;
      box-shadow: 72px 0 rgba(10,31,45,0.8), -72px 0 rgba(10,31,45,0.8);
    }
    .tank {
      left: 30px;
      bottom: 118px;
      width: 132px;
      height: 220px;
      border-radius: 58px 58px 12px 12px;
      background: rgba(255,255,255,0.09);
    }
    .stack {
      left: 238px;
      bottom: 112px;
      width: 22px;
      height: 360px;
      background: rgba(10,31,45,0.32);
    }
    .stack::before {
      content: "";
      position: absolute;
      left: -15px;
      top: -40px;
      width: 58px;
      height: 62px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(250, 206, 183, 0.55), transparent 65%);
      filter: blur(2px);
    }
    .pipe {
      left: 0;
      bottom: 78px;
      width: 86%;
      height: 46px;
      border-left: 0;
      border-right: 0;
      background: rgba(6, 25, 39, 0.18);
    }
    .glow {
      position: absolute;
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: #d9ff73;
      box-shadow: 0 0 14px 5px rgba(194, 255, 95, 0.8);
    }
    .g1 { right: 252px; bottom: 378px; }
    .g2 { right: 112px; bottom: 286px; }
    .g3 { left: 132px; bottom: 286px; }
    .g4 { left: 332px; bottom: 184px; }
    .network {
      position: absolute;
      inset: auto 0 12% 0;
      height: 28%;
      opacity: 0.28;
      background:
        linear-gradient(24deg, transparent 0 44%, #9beaff 45% 46%, transparent 47%),
        linear-gradient(155deg, transparent 0 48%, #9beaff 49% 50%, transparent 51%),
        linear-gradient(5deg, transparent 0 50%, #9beaff 51% 52%, transparent 53%);
    }
    .footer-dot {
      position: fixed;
      left: 22px;
      bottom: 22px;
      width: 44px;
      height: 44px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      color: white;
      background: #222;
      font-weight: 800;
      border: 2px solid rgba(255,255,255,0.8);
      box-shadow: 0 8px 18px rgba(0,0,0,0.22);
    }
    @media (max-width: 900px) {
      .page { grid-template-columns: 1fr; }
      .visual { display: none; }
      .brand { padding: 26px 24px; }
      .content { padding: 40px 24px 80px; }
    }
  </style>
</head>
<body>
  <main class="page">
    <section class="panel">
      <div class="brand">
        <span class="mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none">
            <path d="M7 4h10a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" stroke="currentColor" stroke-width="2"/>
            <path d="M8 8h8M8 12h8M8 16h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </span>
        <span>UGT Sales Forecast</span>
      </div>
      <div class="content">
        <div class="card">
          <div class="eyebrow">SalesNexus</div>
          <h1>UGT Sales Forecast</h1>
          <p class="subtitle">Sign in with your organization account through Keycloak SSO to continue.</p>
          <a class="login-button" href="${authStartPath}">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
              <path d="M10 17l5-5-5-5M15 12H3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Sign in with SSO
          </a>
          <p class="note">Secure access for sales forecast planning and reporting.</p>
          ${safeMessage ? `<div class="error">${safeMessage}</div>` : ''}
        </div>
      </div>
    </section>
    <section class="visual" aria-label="Industrial plant illustration">
      <div class="network"></div>
      <div class="plant">
        <div class="tower"></div>
        <div class="tank"></div>
        <div class="stack"></div>
        <div class="pipe"></div>
        <span class="glow g1"></span>
        <span class="glow g2"></span>
        <span class="glow g3"></span>
        <span class="glow g4"></span>
      </div>
    </section>
  </main>
  <div class="footer-dot">N</div>
</body>
</html>`;
}

async function exchangeCodeForSession(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  metadata: OidcMetadata
): Promise<SessionData> {
  const clientId = process.env.KEYCLOAK_CLIENT_ID;
  if (!clientId) throw new Error('KEYCLOAK_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: codeVerifier,
  });
  const clientSecret = process.env.KEYCLOAK_CLIENT_SECRET;
  if (clientSecret) params.set('client_secret', clientSecret);

  const tokenBody = await postFormJson<{
    access_token?: string;
    id_token?: string;
  }>(metadata.token_endpoint, params);

  let user: AuthUser | null = null;
  if (tokenBody.id_token) user = userFromClaims(decodeJwtPayload(tokenBody.id_token));

  if (!user && metadata.userinfo_endpoint && tokenBody.access_token) {
    const userInfoResponse = await fetch(metadata.userinfo_endpoint, {
      headers: { Authorization: `Bearer ${tokenBody.access_token}` },
    });
    if (userInfoResponse.ok) {
      user = userFromClaims(await userInfoResponse.json() as Record<string, unknown>);
    }
  }

  if (!user) throw new Error('Keycloak did not return usable user claims');
  return { user, idToken: tokenBody.id_token };
}

export function currentUser(req: Request) {
  return getUserFromRequest(req);
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = getUserFromRequest(req);
  if (!user) {
    const basePath = normalizeBasePath();
    const mode = toPublicAppMode(resolveReturnMode(req));
    return res.status(401).json({
      error: 'AUTH_REQUIRED',
      loginUrl: `${basePath}/auth/login?mode=${mode}`,
    });
  }
  (req as Request & { user?: AuthUser }).user = user;
  next();
}

export function createAuthRouter() {
  const router = Router();

  router.get('/me', async (req, res) => {
    const user = getUserFromRequest(req);
    if (!user) {
      const basePath = normalizeBasePath();
      const mode = toPublicAppMode(resolveReturnMode(req));
      return res.status(401).json({
        authenticated: false,
        loginUrl: `${basePath}/auth/login?mode=${mode}`,
      });
    }
    const permissions = await resolveSessionPermissions(user);
    res.json({ authenticated: true, user, permissions });
  });

  router.get('/login', (req, res) => {
    const mode = toPublicAppMode(resolveReturnMode(req));
    const authStartPath = `${normalizeBasePath()}/auth/start?mode=${mode}`;
    res.type('html').send(renderLoginPage(undefined, authStartPath));
  });

  router.get('/start', async (req, res) => {
    const returnMode = resolveReturnMode(req);
    if (isDevAuthBypass()) {
      const sessionId = crypto.randomUUID();
      storeSession(sessionId, { user: getDevUser() });
      setSessionCookie(res, sessionId);
      return res.redirect(getAbsoluteAppUrl(req, returnMode));
    }

    try {
      const metadata = await getOidcMetadata();
      const nonce = crypto.randomUUID();
      const codeVerifier = randomBase64Url(64);
      const codeChallenge = createCodeChallenge(codeVerifier);
      const authState: AuthState = {
        nonce,
        codeVerifier,
        createdAt: Date.now(),
        returnMode,
      };
      const state = encodeAuthStateToken(authState);
      sweepAuthStates();
      authStates.set(state, authState);
      setOAuthStateCookie(res, state, authState);
      const redirectUri = getCallbackUrl(req);
      const authUrl = new URL(metadata.authorization_endpoint);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('client_id', process.env.KEYCLOAK_CLIENT_ID ?? 'ugt-sales-forecast');
      authUrl.searchParams.set('redirect_uri', redirectUri);
      authUrl.searchParams.set('scope', 'openid profile email');
      authUrl.searchParams.set('state', state);
      authUrl.searchParams.set('nonce', nonce);
      authUrl.searchParams.set('code_challenge', codeChallenge);
      authUrl.searchParams.set('code_challenge_method', 'S256');
      res.redirect(authUrl.toString());
    } catch (error) {
      console.error('[auth] login failed:', error);
      res.status(503).type('html').send(renderLoginPage('Keycloak SSO is not configured. Set DEV_AUTH_BYPASS=true for local development or configure Keycloak env vars.'));
    }
  });

  router.get('/callback', async (req, res) => {
    const code = String(req.query.code ?? '');
    const state = String(req.query.state ?? '');
    const stateCookie = decodeStateCookie(parseCookies(req.headers.cookie).get(OAUTH_STATE_COOKIE));
    const savedState = decodeAuthStateToken(state) ??
      authStates.get(state) ??
      (stateCookie?.state === state ? stateCookie.authState : undefined);
    authStates.delete(state);
    clearOAuthStateCookie(res);
    if (!code || !savedState || Date.now() - savedState.createdAt > STATE_TTL_MS) {
      return res.status(400).type('html').send(
        renderLoginPage('Your sign-in session expired or could not be verified. Please start SSO again.')
      );
    }

    try {
      const metadata = await getOidcMetadata();
      const redirectUri = getCallbackUrl(req);
      const session = await exchangeCodeForSession(code, redirectUri, savedState.codeVerifier, metadata);
      const sessionId = crypto.randomUUID();
      storeSession(sessionId, session);
      setSessionCookie(res, sessionId);
      const returnMode: AppMode = savedState.returnMode === 'ufa' ? 'ufa' : 'nyl';
      res.redirect(getAbsoluteAppUrl(req, returnMode));
    } catch (error) {
      console.error('[auth] callback failed:', error);
      res.status(401).type('html').send(
        renderLoginPage('Keycloak could not complete sign-in. Please try SSO again or contact the system administrator.')
      );
    }
  });

  router.post('/logout', async (req, res) => {
    if (isDevAuthBypass()) {
      const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
      if (sessionId) sessions.delete(sessionId);
      clearSessionCookie(res);
      return res.json({ ok: true, logoutUrl: getPostLogoutUrl(req) });
    }

    const metadata = await getOidcMetadata().catch(error => {
      console.error('[auth] logout metadata failed:', error);
      return null;
    });
    const session = getSessionFromRequest(req);
    const sessionId = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
    if (sessionId) sessions.delete(sessionId);
    clearSessionCookie(res);
    const logoutUrl = metadata?.end_session_endpoint
      ? new URL(metadata.end_session_endpoint)
      : null;
    if (logoutUrl) {
      logoutUrl.searchParams.set('post_logout_redirect_uri', getPostLogoutUrl(req));
      if (session?.idToken) logoutUrl.searchParams.set('id_token_hint', session.idToken);
      return res.json({
        ok: true,
        logoutUrl: logoutUrl.toString(),
      });
    }
    res.json({ ok: true, logoutUrl: getPostLogoutUrl(req) });
  });

  return router;
}
