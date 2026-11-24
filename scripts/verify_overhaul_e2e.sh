#!/usr/bin/env bash
set -e

echo "=== 1. TypeScript Vitest Suite (516 Tests) ==="
npm test

echo "=== 2. Python Pytest Suite (103 Tests) ==="
/home/thomas_admin/.copilot/mcp/venv/bin/pytest scripts/tests/

echo "=== 3. End-to-End Pipeline Runner ==="
node scripts/run_e2e_pipeline.js

echo "=== 4. End-to-End CRM & Stripe Runner ==="
/home/thomas_admin/.copilot/mcp/venv/bin/python scripts/run_crm_e2e.py

echo "=== ALL VERIFICATIONS PASSED SUCCESSFULLY (100% GREEN) ==="
