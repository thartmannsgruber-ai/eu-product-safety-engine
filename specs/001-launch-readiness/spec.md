# Specification: Launch Readiness & Hardening (P1–P4)

## 1. Problem Statement & Motivation
Prior to public marketplace launch on Apify Store and MCP Registries (Smithery.ai, PulseMCP), the engine requires technical hardening to ensure:
1. **Dynamic Data Freshness:** Official Safety Gate XML alerts can be fetched, parsed, and synced on-demand instead of relying solely on a static fixture.
2. **Pricing & Seeding Integrity:** Pay-Per-Event pricing strictly matches the advertised marketplace tier of **$1.90 / 1,000 Results** ($0.0019 per `alert-returned`). An empty database must throw a clear `EmptyDatabaseError` rather than silently returning a false "0 recalls found" response.
3. **Store Listing & Documentation:** Public documentation in English without repository placeholders or unverified claims.
4. **Standalone MCP Packaging:** The MCP server can run as a self-contained executable without workspace dependency resolution issues.

---

## 2. Invariants & Guardrails
- **INV-1:** An empty SQLite alert database (`count() === 0`) must never return an empty result list without raising `EmptyDatabaseError`.
- **INV-2:** Unit price for `alert-returned` in `PPE_EVENT_PRICES` must be exactly `$0.0019` USD.
- **INV-3:** `syncSafetyGate()` must be idempotent: duplicate alert numbers must be updated, not duplicated.
- **INV-4:** Standalone executable starts cleanly via `npx` / node without missing workspace modules.
- **INV-5:** 100% test pass rate across all packages and workspaces.
