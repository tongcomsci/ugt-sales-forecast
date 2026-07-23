# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

UGT Sales Forecast — a React + Express single-page app for entering and reviewing sales forecast data (quantity, price, amount) by registration/customer/period, with imports from Excel, CPL/price-management, inventory, and an "overplan" (actual vs. plan) comparison feature. Backed by SQL Server via Prisma.

## Commands

```bash
npm install              # install deps
npm run dev               # frontend (Vite) on :3000
npm run server             # backend (Express, via tsx) on :3001 — run alongside `dev`
npm run lint               # tsc --noEmit — this IS the lint/typecheck step, no eslint
npm run build               # vite build (frontend only)
npm run build:server         # esbuild bundle of src/server.ts -> server.js
npm run build:docker          # build + build:server (what CI/Docker runs)
npm run test:mode              # tsx scripts/verify-query-mode.mjs — the only assert-based test in the repo
npm run db:generate             # prisma generate
npm run db:migrate               # prisma migrate deploy
npm run db:studio                 # prisma studio
npm run seed                       # tsx src/db/seed.ts
```

There is no Jest/Vitest suite. `npm run lint` (tsc) and `npm run test:mode` are what CI (Jenkinsfile) runs, alongside SonarQube and OWASP dependency-check. When adding logic worth covering, follow the existing pattern: a standalone `tsx`-run script under `scripts/` using `node:assert/strict` (see `scripts/verify-query-mode.mjs`), not a new test framework.

Local run needs both `npm run dev` and `npm run server` at once (Vite proxies `/api` and `/auth` to the Express port). Configure `.env` from `.env.example` first — set `DEV_AUTH_BYPASS=true` for local auth-less dev.

`scripts/*.mjs` (audit-*, check-*, investigate-*, repair-*, verify-*) are one-off operational/data-debugging scripts written against production data issues as they came up — not a maintained CLI or test suite. Treat them as historical/reference, not something to keep in sync.

## Architecture

### Single deployment, two "modes" (Nylon vs UFA)

One codebase, one running server, **one database** — there is no per-mode deployment. The app mode (`nyl`/`nylon` or `ufa`) is resolved per-request from `?mode=` (or `x-app-mode` header) in [src/config/appMode.ts](src/config/appMode.ts), stored in an `AsyncLocalStorage` for the life of the request, and used to:
- filter which Business Units are visible (`nyl` → Polymer/Composite, `ufa` → UFA, keyed off `BusinessUnit`/`PlantCode`)
- pick the display name / preferred import sheet names
- scope every registration query (`buildAppModeRegistrationScopeSql`) and reject writes to out-of-mode registrations (`assertRegistrationIdsInAppMode`)

Data is **never deleted or duplicated** per mode — mode only filters visibility. When touching registration/forecast queries, always route business-unit scoping through `appMode.ts` helpers rather than hardcoding a BU list.

### Registration data model: CRM (read-only) ∪ managed (app-owned)

Registrations come from two unioned sources, both exposed by `getRegistrationSourceSql()` in [src/api/routes/registrations.ts](src/api/routes/registrations.ts):
1. **CRM registrations** — read from `dbo.VW_CRM_RegistrationAll_1` (or, if `USE_LOCAL_SNAPSHOT=true`, a local mirrored snapshot `crm_registration_snapshot`/`actual_sales_snapshot`, refreshed every 5 min by [src/api/services/dataSnapshot.ts](src/api/services/dataSnapshot.ts)). CRM data is **never written to** by this app.
2. **Managed registrations** — created inside this app, stored in `master_data_crm_registrations` (Prisma model `MasterDataCrmRegistration`), used for registrations that don't exist in CRM yet ("draft" registrations, see `DraftRegistrationPanel.tsx`).

Two read-model SQL views (created via raw-SQL Prisma migrations, not Prisma models) union these sources for BI/reporting consumption: `DimRegistration` and `FactForecast` (see `prisma/migrations/20260622094000_create_fact_forecast_view` and `20260706140000_create_dim_registration_view`). Power BI reads these views directly — changing registration/forecast schema requires updating the views too, and `registrationKeyReconcile.ts` re-points forecast rows when a CRM key changes underneath a snapshot refresh.

### Forecast values, versions, and pricing

- `forecast_values` (Prisma `ForecastValue`) is keyed by `(registrationId, versionName, period)` and stores qty/price/amount per version per period (month or week granularity, see `granularity` column).
- `forecast_versions` holds named versions (e.g. "Current Forecast", "BB FY26"); `Current Forecast` is the live/default version most UI flows key off (`CURRENT_FORECAST_VERSION` constant, duplicated in both `App.tsx` and `forecastImport/constants.ts`).
- Every save goes through `ForecastCommitBatch` + `ForecastChangeLog` for audit history, keyed by a batch id (`lastBatchId` on `ForecastValue`).
- Price resolution ("effective price") depends on a per-registration **price formula** (`CPL`, `Fixed Price`, `Naphtha`, `Benzene`, ...) plus a **spread**/pricing-policy override in `registration_price_settings` — see [src/lib/pricingPolicy.ts](src/lib/pricingPolicy.ts) and the `effectivePrice` CASE expression in the `FactForecast` view for the canonical formula. `price_management_values` holds the underlying CPL/Naphtha/Benzene/FX rates by month+version.

### Excel import pipeline

`src/api/services/forecastImport/` is a multi-stage pipeline: `detectFormat` (legacy single-sheet vs. versioned workbook) → `legacySheetParse`/`versionedSheetParse` → `matching`/`registrationResolver` (map Excel rows to registration IDs, optionally auto-creating managed registrations via `autoCreateRegistrations`) → `buildLegacyPreview`/`buildVersionedPreview` (cached preview via `previewCache`, so the UI can show a diff before committing) → `confirmImport` (writes `ForecastValue` + batch/change-log rows). `currentForecastImport.ts` and `forecastImport.ts` are separate route entry points for the two import flows. When changing import matching logic, check `keyDiagnostics.ts` and the `audit-*`/`investigate-*` scripts in `scripts/` for the edge cases that motivated the current matching rules.

### Auth

Custom Keycloak OIDC (authorization code + PKCE) implementation in [src/api/auth.ts](src/api/auth.ts) — no `passport`/`openid-client` dependency, hand-rolled with `node:crypto`. Sessions are an in-memory `Map` (cookie `sf_session`), so **auth state does not survive a server restart or multiple instances** — be aware of this if adding horizontal scaling or session persistence work. `DEV_AUTH_BYPASS=true` short-circuits everything to a fixed dev user (`dev.local`); [src/lib/permissions.ts](src/lib/permissions.ts) additionally grants that dev user client-side admin permissions for local UI testing (server-side APIs still enforce real roles via `appRoles.ts`).

### Server routing quirks (read before touching `server.ts`/`vite.config.ts`)

The app is served under a configurable base path (`APP_BASE_PATH`, default `/ugt-sales-forecast`) behind an nginx/Keycloak reverse proxy. Past production incidents (see recent git history) were caused by trailing-slash redirects fighting the proxy — `server.ts` and `vite.config.ts` both deliberately avoid HTTP redirects between the slash/no-slash variants of the base path, and `server.ts` collapses accidental `//` from proxy path-joining. Legacy `/ugt-sales-forecast/nylon` and `/ugt-sales-forecast/ufa` paths still exist as 302 redirects to `?mode=`. Don't reintroduce slash-normalizing redirects without re-reading this section — see [docs/deploy-proxy-keycloak.md](docs/deploy-proxy-keycloak.md).

### Frontend shape

[src/App.tsx](src/App.tsx) is a large single top-level component (~5800 lines) owning most cross-cutting state (forecast data, pending edits, versions, price maps, filters) and passing it down to feature components in `src/components/forecast/` (the main editable grid — `ForecastInputTable`, `RegTableCell`, column/pane management) and `src/components/overplan/` (actual-vs-plan view, lazy-loaded). `src/lib/api.ts` is the typed fetch client for every backend route; `src/types/forecast.ts` holds the shared domain types. Recharts and its subcomponents are lazily imported per-chart-type (`lazyRechart` helper) to keep the initial bundle small.

### SonarQube clean code

New TypeScript/React code should follow the idioms in [.agents/sonarqube-clean-code.md](.agents/sonarqube-clean-code.md) (modern JS idioms SonarQube enforces, `Readonly<>` on component props, duplication handling) since the CI Quality Gate blocks merges to `master`/`main` on new violations and >5% duplication.

## Deployment

Jenkins (`Jenkinsfile`) builds and deploys only from `master`/`main`: lint + build → OWASP dependency-check → SonarQube quality gate → Docker build → `docker compose up -d` with a healthcheck wait. The Docker image runs `prisma migrate deploy` before starting (`Dockerfile` CMD). See [README.md](README.md) for the `.env` variables required in production and the two live URLs (`?mode=nylon` / `?mode=ufa`).
