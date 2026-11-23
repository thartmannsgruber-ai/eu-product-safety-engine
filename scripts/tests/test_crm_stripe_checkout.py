"""
scripts/tests/test_crm_stripe_checkout.py
Unit-Tests fuer Stripe Checkout & B2B High-Ticket Audit Integration (Feature F08).
"""

import hashlib
import hmac
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.stripe_checkout import (
    AUDIT_PLUS,
    PORTFOLIO_AUDIT,
    AuditOrderStorage,
    B2BMetadata,
    StripeSignatureVerificationError,
    build_b2b_metadata,
    create_checkout_session,
    generate_checkout_link,
    generate_pitch_snippet,
    get_package,
    handle_webhook,
    unlock_audit_order,
    verify_webhook_signature,
)
from scripts.crm.storage import CRMStorage, LeadStatus


class TestStripeCheckoutPackagesAndMetadata(unittest.TestCase):
    """Prueft Akzeptanzkriterien 1 & 2: Pakete (490 EUR & 1490 EUR) und B2B-Metadaten."""

    def test_package_definitions(self):
        # Portfolio Audit: 490 EUR
        pa = get_package("portfolio_audit")
        self.assertEqual(pa.key, "portfolio_audit")
        self.assertEqual(pa.amount_eur, 490)
        self.assertEqual(pa.amount_cents, 49000)
        self.assertEqual(pa.currency, "eur")
        self.assertEqual(pa.sku_limit, 1000)

        # Audit Plus: 1490 EUR
        ap = get_package("audit_plus")
        self.assertEqual(ap.key, "audit_plus")
        self.assertEqual(ap.amount_eur, 1490)
        self.assertEqual(ap.amount_cents, 149000)
        self.assertEqual(ap.currency, "eur")
        self.assertIsNone(ap.sku_limit)

        # Aliases
        self.assertEqual(get_package("490").key, "portfolio_audit")
        self.assertEqual(get_package("1490").key, "audit_plus")
        self.assertEqual(get_package("audit").key, "portfolio_audit")
        self.assertEqual(get_package("plus").key, "audit_plus")

    def test_b2b_metadata_generation(self):
        meta = build_b2b_metadata(
            lead_id="lead_12345",
            company="Test Toys GmbH",
            email="TEST@Company.DE",
            paketauswahl="portfolio_audit",
            steuer_id="DE987654321",
        )
        self.assertEqual(meta["lead_id"], "lead_12345")
        self.assertEqual(meta["company"], "Test Toys GmbH")
        self.assertEqual(meta["email"], "test@company.de")  # normalisiert
        self.assertEqual(meta["paketauswahl"], "portfolio_audit")
        self.assertEqual(meta["steuer_id"], "DE987654321")

    def test_create_checkout_session_dry_run(self):
        session = create_checkout_session(
            package="portfolio_audit",
            email="buyer@testcorp.com",
            company="Test Corp",
            lead_id="ld_999",
            steuer_id="DE111222333",
            dry_run=True,
        )
        self.assertEqual(session["amount_total"], 49000)
        self.assertEqual(session["currency"], "eur")
        self.assertEqual(session["package_key"], "portfolio_audit")
        self.assertTrue(session["url"].startswith("https://checkout.stripe.com/c/pay/cs_test_"))
        self.assertEqual(session["metadata"]["lead_id"], "ld_999")
        self.assertEqual(session["metadata"]["company"], "Test Corp")
        self.assertEqual(session["metadata"]["email"], "buyer@testcorp.com")
        self.assertEqual(session["metadata"]["paketauswahl"], "portfolio_audit")
        self.assertEqual(session["metadata"]["steuer_id"], "DE111222333")

        # Auch fuer Audit Plus (1490 EUR)
        session_plus = create_checkout_session(
            package="audit_plus",
            email="enterprise@corp.com",
            company="Enterprise Corp",
            dry_run=True,
        )
        self.assertEqual(session_plus["amount_total"], 149000)
        self.assertEqual(session_plus["package_key"], "audit_plus")
        self.assertEqual(session_plus["metadata"]["paketauswahl"], "audit_plus")

    def test_generate_checkout_link_and_snippets(self):
        link = generate_checkout_link(
            package="portfolio_audit",
            email="test@sample.de",
            company="Sample Corp",
            dry_run=True,
        )
        self.assertTrue(link.startswith("https://checkout.stripe.com/c/pay/cs_test_"))

        # German snippet
        snippet_de = generate_pitch_snippet("portfolio_audit", link, "Sample Corp", language="de")
        self.assertIn("490 €", snippet_de)
        self.assertIn(link, snippet_de)

        # English snippet for Audit Plus
        snippet_en = generate_pitch_snippet("audit_plus", link, "Sample Corp", language="en")
        self.assertIn("1490 EUR", snippet_en)
        self.assertIn(link, snippet_en)


class TestStripeWebhookAndOrderUnlocking(unittest.TestCase):
    """Prueft Akzeptanzkriterium 4: Webhook-Signatur-Verifikation & Freischaltung von Audit-Auftraegen."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.orders_file = Path(self.temp_dir.name) / "audit_orders.json"
        self.leads_file = Path(self.temp_dir.name) / "leads_db.json"
        self.webhook_secret = "whsec_test_secret_key_12345"

        # CRM Storage initialisieren mit Test-Lead
        self.crm = CRMStorage(leads_file=self.leads_file)
        self.crm._leads["kunde@b2b.de"] = {
            "email": "kunde@b2b.de",
            "company": "B2B Spielwaren AG",
            "status": LeadStatus.REPLIED_POSITIVE,
            "history": [],
            "created_at": "2026-11-20T10:00:00+00:00",
            "updated_at": "2026-11-20T10:00:00+00:00",
        }
        self.crm.save()
        self.orders_storage = AuditOrderStorage(filepath=self.orders_file)

    def tearDown(self):
        self.temp_dir.cleanup()

    def _create_signed_header(self, payload_bytes: bytes, secret: str, timestamp: int = None) -> str:
        t = timestamp if timestamp is not None else int(time.time())
        signed_payload = f"{t}.".encode("utf-8") + payload_bytes
        sig = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        return f"t={t},v1={sig}"

    def test_verify_webhook_signature_valid(self):
        payload = b'{"type": "checkout.session.completed"}'
        sig_header = self._create_signed_header(payload, self.webhook_secret)
        self.assertTrue(verify_webhook_signature(payload, sig_header, self.webhook_secret))

    def test_verify_webhook_signature_invalid(self):
        payload = b'{"type": "checkout.session.completed"}'
        sig_header = "t=1700000000,v1=invalid_signature_hash"
        with self.assertRaises(StripeSignatureVerificationError):
            verify_webhook_signature(payload, sig_header, self.webhook_secret)

    def test_webhook_unlocks_audit_order(self):
        event_payload = {
            "id": "evt_test_webhook_123",
            "type": "checkout.session.completed",
            "data": {
                "object": {
                    "id": "cs_test_session_abc",
                    "payment_status": "paid",
                    "amount_total": 49000,
                    "currency": "eur",
                    "customer_email": "kunde@b2b.de",
                    "metadata": {
                        "lead_id": "lead_kunde_1",
                        "company": "B2B Spielwaren AG",
                        "email": "kunde@b2b.de",
                        "paketauswahl": "portfolio_audit",
                        "steuer_id": "DE998877665",
                    },
                }
            },
        }
        payload_bytes = json.dumps(event_payload).encode("utf-8")
        sig_header = self._create_signed_header(payload_bytes, self.webhook_secret)

        result = handle_webhook(
            payload=payload_bytes,
            signature_header=sig_header,
            webhook_secret=self.webhook_secret,
            crm_storage=self.crm,
            orders_storage=self.orders_storage,
        )

        self.assertEqual(result["status"], "success")
        self.assertTrue(result["unlocked"])
        order = result["order"]
        self.assertEqual(order["session_id"], "cs_test_session_abc")
        self.assertEqual(order["status"], "UNLOCKED")
        self.assertEqual(order["amount_eur"], 490)
        self.assertEqual(order["paketauswahl"], "portfolio_audit")
        self.assertEqual(order["steuer_id"], "DE998877665")

        # Pruefe Persistenz in audit_orders.json
        saved_orders = self.orders_storage.list_orders()
        self.assertEqual(len(saved_orders), 1)
        self.assertEqual(saved_orders[0]["session_id"], "cs_test_session_abc")
        self.assertEqual(saved_orders[0]["status"], "UNLOCKED")

        # Pruefe Aktualisierung des Leads in CRMStorage
        updated_lead = self.crm.get_lead("kunde@b2b.de")
        self.assertEqual(updated_lead["audit_status"], "UNLOCKED")
        self.assertEqual(updated_lead["audit_package"], "portfolio_audit")
        # History-Event
        actions = [h.get("action") for h in updated_lead.get("history", [])]
        self.assertIn("AUDIT_ORDER_UNLOCKED", actions)


class TestStripeCheckoutCLI(unittest.TestCase):
    """Prueft Akzeptanzkriterium 3: CLI-Kommando zur schnellen Erzeugung von Zahlungslinks."""

    def test_cli_link_generation(self):
        cmd = [
            sys.executable,
            "-m",
            "scripts.crm.stripe_checkout",
            "--package",
            "portfolio_audit",
            "--email",
            "contact@toys-direct.eu",
            "--company",
            "Toys Direct",
            "--steuer-id",
            "NL888999111B01",
            "--dry-run",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        url = res.stdout.strip()
        self.assertTrue(url.startswith("https://checkout.stripe.com/c/pay/cs_test_"))

    def test_cli_json_format(self):
        cmd = [
            sys.executable,
            "-m",
            "scripts.crm.stripe_checkout",
            "-p",
            "1490",
            "-e",
            "director@megacorp.de",
            "-c",
            "MegaCorp",
            "-t",
            "DE123456789",
            "-f",
            "json",
            "--dry-run",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        data = json.loads(res.stdout)
        self.assertEqual(data["amount_total"], 149000)
        self.assertEqual(data["package_key"], "audit_plus")
        self.assertEqual(data["metadata"]["paketauswahl"], "audit_plus")
        self.assertEqual(data["metadata"]["steuer_id"], "DE123456789")

    def test_cli_text_pitch_format(self):
        cmd = [
            sys.executable,
            "-m",
            "scripts.crm.stripe_checkout",
            "-p",
            "490",
            "-e",
            "lead@example.de",
            "-f",
            "text",
            "--lang",
            "de",
            "--dry-run",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, check=True)
        out = res.stdout
        self.assertIn("490 €", out)
        self.assertIn("https://checkout.stripe.com/c/pay/cs_test_", out)


if __name__ == "__main__":
    unittest.main()
