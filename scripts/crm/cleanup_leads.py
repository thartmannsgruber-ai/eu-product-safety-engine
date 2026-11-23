#!/usr/bin/env python3
"""
scripts/crm/cleanup_leads.py
CRM Lead Database Sanitation & State Machine Expansion (Feature F06).

Bereinigt .crm/leads_db.json durch Abgleich mit .market/leads/sent_log.json:
- 24 real gesendete Leads (10 Frankreich, 14 Niederlande) behalten den Status OUTREACH_SENT.
- 29 ungesendete Leads (IT, PL, ES, AT) werden auf den Status NOT_SENT korrigiert.
- Geblockte Leads im Status LOST_BLACKLISTED bleiben unangetastet (Goldene Regel).
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, Optional

# Add project root to path
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from scripts.crm.blacklist import BlacklistManager, normalize_email
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
    cleanup_leads_db,
    get_default_storage,
)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Bereinigt .crm/leads_db.json durch Abgleich mit .market/leads/sent_log.json"
    )
    parser.add_argument(
        "--leads-file",
        type=str,
        default=None,
        help="Pfad zu leads_db.json (Default: .crm/leads_db.json)",
    )
    parser.add_argument(
        "--sent-log",
        type=str,
        default=None,
        help="Pfad zu sent_log.json (Default: .market/leads/sent_log.json)",
    )

    args = parser.parse_args()
    stats = cleanup_leads_db(leads_path=args.leads_file, sent_log_path=args.sent_log)

    print("=" * 65)
    print("        CRM LEADS DATABASE SANITATION (Feature F06)")
    print("=" * 65)
    print(f"Gesamtanzahl Leads:            {stats['total']}")
    print(f"Korrigiert auf NOT_SENT:       {stats['corrected_to_not_sent']}")
    print(f"Bestehend OUTREACH_SENT:       {stats['kept_outreach_sent']}")
    print(f"Bestehend LOST_BLACKLISTED:    {stats['kept_lost_blacklisted']}")
    print("=" * 65)
    return 0


if __name__ == "__main__":
    sys.exit(main())
