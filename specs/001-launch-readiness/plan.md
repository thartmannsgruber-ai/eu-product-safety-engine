# Technical Plan: Launch Readiness & Hardening

## Architecture & Module Design

### 1. P1: Dynamic Live-Data Sync (`packages/fetcher/src/sync.ts`)
- Implement `syncSafetyGate(storage: SqliteAlertStorage, fetcher: ComplianceFetcher, options?: SyncOptions)`.
- Fetch Safety Gate weekly XML feed via `fetcher.fetch()`, respecting robots.txt and ETags.
- Parse XML using `parseSafetyGateXml()` from `@productsafetyengine/core`.
- Upsert alerts into `SqliteAlertStorage` with `insertAlerts()`.
- Return sync statistics: `{ week: string, alertsCount: number, inserted: number, durationMs: number }`.

### 2. P2: Pricing & Empty Database Guard (`apps/actor/src/ppe.ts`, `actor.ts`, `apps/mcp/src/tools.ts`)
- In `ppe.ts`: Update `PPE_EVENT_PRICES['alert-returned']` from `0.010` to `0.0019`.
- In `core/src/storage.ts`: Export `EmptyDatabaseError`.
- In `actor.ts` & `apps/mcp/src/tools.ts`: If `storage.count() === 0`, throw `EmptyDatabaseError("Safety Gate database is uninitialized (0 records). Ensure autoSeed is active or run syncSafetyGate().")`.

### 3. P3: Store Listing & Documentation Cleanup
- Ensure `STORE_DESCRIPTION.md` and `README.md` have no placeholder URLs (`your-org`).
- Synchronize all pricing tables to `$1.90 / 1,000 Results` ($0.0019/alert).

### 4. P4: Standalone MCP Packaging
- Add `esbuild` as devDependency in root/apps/mcp.
- Configure `npm run bundle` in `apps/mcp` to build `dist/standalone.cjs` or `dist/bundle.mjs` bundling `@productsafetyengine/core`.
- Ensure `smithery.yaml` and `bin/eu-product-safety-mcp.js` use the standalone entrypoint.
