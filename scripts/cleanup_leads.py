#!/usr/bin/env python3
"""
scripts/cleanup_leads.py
CLI entrypoint for CRM Lead Database Sanitation (Feature F06).
"""
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.crm.cleanup_leads import cleanup_leads_db, main

if __name__ == "__main__":
    sys.exit(main())
