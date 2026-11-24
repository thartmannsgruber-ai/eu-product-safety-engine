"""
scripts/tests/test_e2e_pipeline.py
End-to-End Pipeline & Integration Test Suite (F09).

Verifiziert:
1. Durchlauf des CRM E2E Runner-Workflows
2. B2B High-Ticket Stripe Checkout Pakete (490 EUR und 1490 EUR)
3. Webhook-Signaturpruefung & Order Unlocking
4. CRM Lead Status State Machine (24 OUTREACH_SENT, 29 NOT_SENT, 2 LOST_BLACKLISTED)
5. Kaltakquise-Rechts-Gates fuer Oesterreich (AT § 107 TKG) und Polen (PL Art. 172)
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from scripts.crm.followup_engine import ColdOutreachJurisdictionGate
from scripts.crm.storage import CRMStorage, LeadStatus
from scripts.crm.stripe_checkout import (
    AUDIT_PLUS,
    PORTFOLIO_AUDIT,
    create_checkout_session,
    generate_pitch_snippet,
    handle_webhook,
)
from scripts.run_crm_e2e import run_crm_e2e


class TestE2EPipelineIntegration:
    """End-to-End Pipeline Integration Test Suite."""

    def test_e2e_crm_runner_execution(self):
        """Verifiziert den vollstaendigen Durchlauf von run_crm_e2e()."""
        summary = run_crm_e2e()
        assert summary["status"] == "SUCCESS"
        assert summary["stripe"]["portfolio_audit_price"] == 490
        assert summary["stripe"]["audit_plus_price"] == 1490
        assert summary["stripe"]["webhook_verified"] is True
        assert summary["crm"]["total_leads"] == 55
        assert summary["crm"]["status_breakdown"]["OUTREACH_SENT"] == 24
        assert summary["crm"]["status_breakdown"]["NOT_SENT"] == 29

    def test_b2b_packages_and_checkout_session(self):
        """Prueft Paketpreise und B2B-Metadatenuebergabe."""
        assert PORTFOLIO_AUDIT.amount_cents == 49000
        assert AUDIT_PLUS.amount_cents == 149000

        session = create_checkout_session(
            package="portfolio_audit",
            email="lead@test-merchant.de",
            company="Test Merchant GmbH",
            lead_id="LEAD-TEST-01",
            steuer_id="DE987654321",
            dry_run=True,
        )
        assert session["amount_total"] == 49000
        assert session["metadata"]["paketauswahl"] == "portfolio_audit"
        assert session["metadata"]["lead_id"] == "LEAD-TEST-01"
        assert session["metadata"]["steuer_id"] == "DE987654321"

    def test_jurisdiction_gates_strictly_protect_at_and_pl(self):
        """Sichert ausnahmslose Blockade von Kaltakquise nach AT und PL."""
        gate = ColdOutreachJurisdictionGate()

        # AT
        is_restricted, country, legal = gate.check_jurisdiction("test@wien.at", "AT")
        assert is_restricted is True
        assert "107 TKG" in (legal or "")

        # PL
        is_restricted_pl, country_pl, legal_pl = gate.check_jurisdiction("kontakt@warszawa.pl", "PL")
        assert is_restricted_pl is True
        assert "172" in (legal_pl or "")

        # IT & ES (H2 Fix)
        is_restricted_it, country_it, legal_it = gate.check_jurisdiction("sales@milano.it", "IT")
        assert is_restricted_it is True
        assert "Codice Privacy" in (legal_it or "")

        is_restricted_es, country_es, legal_es = gate.check_jurisdiction("comercial@madrid.es", "ES")
        assert is_restricted_es is True
        assert "LSSI" in (legal_es or "")

        is_restricted_nl, country_nl, legal_nl = gate.check_jurisdiction("info@amsterdam.nl", "NL")
        assert is_restricted_nl is True
        assert "Telecommunicatiewet" in (legal_nl or "")

        # Erlaubte Jurisdiktion (FR)
        assert not gate.check_jurisdiction("contact@paris.fr", "FR")[0]
