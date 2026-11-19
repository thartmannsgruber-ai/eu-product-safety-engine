"""
scripts/tests/test_crm_storage_blacklist.py
Unit-Tests fuer Feature F01: CRM Data Storage, Lead Lifecycle & Golden Rule Blacklist.
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    add_to_blacklist,
    assert_can_contact,
    can_contact,
    is_blacklisted,
    set_default_manager,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
    set_default_storage,
)


class TestCRMStorageAndBlacklist(unittest.TestCase):
    def setUp(self):
        # Temporaeres Verzeichnis fuer isolierte Tests
        self.temp_dir = tempfile.TemporaryDirectory()
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"
        self.leads_file = Path(self.temp_dir.name) / "leads_db.json"

        # Eigene Manager-Instanzen instanziieren
        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(
            leads_file=self.leads_file,
            blacklist_mgr=self.blacklist_mgr
        )

        # Auch Standard-Singletons temporaer darauf umbiegen
        set_default_manager(self.blacklist_mgr)
        set_default_storage(self.storage)

    def tearDown(self):
        self.temp_dir.cleanup()
        # Reset default managers to normal paths
        set_default_manager(None)
        set_default_storage(None)

    def test_criterion_1_is_blacklisted(self):
        """Kriterium 1: is_blacklisted(email) liefert True fuer gelistete Adressen."""
        self.assertFalse(self.blacklist_mgr.is_blacklisted("test@toys-distrib.fr"))
        self.assertFalse(is_blacklisted("test@toys-distrib.fr"))

        self.blacklist_mgr.add_to_blacklist(
            "test@toys-distrib.fr",
            reason="Negative Opt-Out",
            snippet="Non, merci"
        )

        self.assertTrue(self.blacklist_mgr.is_blacklisted("test@toys-distrib.fr"))
        self.assertTrue(is_blacklisted("test@toys-distrib.fr"))
        # Pruefe Case-Insensitivity
        self.assertTrue(is_blacklisted("TEST@TOYS-DISTRIB.FR"))
        self.assertTrue(is_blacklisted("  test@toys-distrib.fr  "))

        # Nicht gelistete Adresse
        self.assertFalse(is_blacklisted("other@safe-toys.nl"))

    def test_criterion_2_add_to_blacklist_persists(self):
        """Kriterium 2: add_to_blacklist(email, reason, snippet) persistiert in .crm/blacklist.json."""
        email = "optout@wholesale-toys.nl"
        reason = "Pas intéressé"
        snippet = "Geen interesse, gelieve ons niet meer te contacteren."

        add_to_blacklist(email, reason=reason, snippet=snippet)

        # Datei muss existieren
        self.assertTrue(self.blacklist_file.exists())

        # Raw JSON pruefen
        with open(self.blacklist_file, "r", encoding="utf-8") as f:
            raw_data = json.load(f)

        self.assertIn(email, raw_data)
        entry = raw_data[email]
        self.assertEqual(entry["email"], email)
        self.assertEqual(entry["reason"], reason)
        self.assertEqual(entry["snippet"], snippet)
        self.assertIn("blacklisted_at", entry)

        # Neuer Manager liest Daten aus der Datei
        reloaded_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.assertTrue(reloaded_mgr.is_blacklisted(email))

    def test_criterion_3_lead_lifecycle_statuses(self):
        """Kriterium 3: Leads erhalten Status OUTREACH_SENT, REPLIED_POSITIVE, REPLIED_INQUIRY oder LOST_BLACKLISTED."""
        email = "client@jouets-france.fr"

        # 1. Lead initialisieren / anlegen mit OUTREACH_SENT
        self.storage.update_lead_status(email, LeadStatus.OUTREACH_SENT, reason="Initial campaign email")
        lead = self.storage.get_lead(email)
        self.assertIsNotNone(lead)
        self.assertEqual(lead["status"], LeadStatus.OUTREACH_SENT)

        # 2. Uebergang zu REPLIED_POSITIVE
        self.storage.update_lead_status(email, LeadStatus.REPLIED_POSITIVE, reason="Sent EANs for check")
        lead = self.storage.get_lead(email)
        self.assertEqual(lead["status"], LeadStatus.REPLIED_POSITIVE)

        # 3. Uebergang zu REPLIED_INQUIRY
        self.storage.update_lead_status(email, LeadStatus.REPLIED_INQUIRY, reason="Asked about pricing")
        lead = self.storage.get_lead(email)
        self.assertEqual(lead["status"], LeadStatus.REPLIED_INQUIRY)

        # 4. Uebergang zu LOST_BLACKLISTED
        self.storage.update_lead_status(
            email,
            LeadStatus.LOST_BLACKLISTED,
            reason="Unsubscribe",
            snippet="Stop sending emails"
        )
        lead = self.storage.get_lead(email)
        self.assertEqual(lead["status"], LeadStatus.LOST_BLACKLISTED)

        # Invariante: LOST_BLACKLISTED traegt die Adresse automatisch in die Blacklist ein
        self.assertTrue(self.blacklist_mgr.is_blacklisted(email))

        # Ungueltiger Status wird abgewiesen
        with self.assertRaises(ValueError):
            self.storage.update_lead_status(email, "INVALID_CUSTOM_STATUS")

    def test_criterion_4_golden_rule_blacklisted_recipient_error(self):
        """Kriterium 4: BlacklistedRecipientError wird geworfen wenn ein Kontakt an eine geblacklistete Adresse versucht wird."""
        email = "blocked@retailer.fr"

        # VOR Blacklisting: Kontakt ist erlaubt
        self.assertTrue(self.blacklist_mgr.can_contact(email))
        self.assertTrue(self.storage.can_contact(email))
        self.assertTrue(can_contact(email))
        # Keine Exception
        self.blacklist_mgr.assert_can_contact(email)
        self.storage.assert_can_contact(email)
        assert_can_contact(email)

        # Blacklisting durchfuehren (Goldene Regel schlaegt zu)
        self.blacklist_mgr.add_to_blacklist(email, reason="Opt-out requested", snippet="Non merci")

        # can_contact(email) ist zwingend False
        self.assertFalse(self.blacklist_mgr.can_contact(email))
        self.assertFalse(self.storage.can_contact(email))
        self.assertFalse(can_contact(email))

        # Kontaktversuche muessen zwingend BlacklistedRecipientError werfen
        with self.assertRaises(BlacklistedRecipientError):
            self.blacklist_mgr.assert_can_contact(email)

        with self.assertRaises(BlacklistedRecipientError):
            self.storage.assert_can_contact(email)

        with self.assertRaises(BlacklistedRecipientError):
            assert_can_contact(email)

        with self.assertRaises(BlacklistedRecipientError):
            self.storage.record_contact_attempt(email, subject="Test follow-up")

    def test_init_from_campaign_and_sent_log(self):
        """Testet die Initialisierung der Leads aus .market/leads/sent_log.json und outreach_campaign.json."""
        project_root = Path(__file__).resolve().parent.parent.parent
        sent_log = project_root / ".market" / "leads" / "sent_log.json"
        campaign = project_root / ".market" / "leads" / "outreach_campaign.json"

        if sent_log.exists() and campaign.exists():
            count = self.storage.init_from_campaign(sent_log, campaign)
            self.assertGreater(count, 0)

            # Pruefen ob ein bekannter Lead aus sent_log vorhanden ist
            known_email = "tsjj@wanadoo.fr"
            lead = self.storage.get_lead(known_email)
            self.assertIsNotNone(lead)
            self.assertEqual(lead["status"], LeadStatus.OUTREACH_SENT)
            self.assertEqual(lead["company"], "Télé Surprises Jeux et Jouets TSJJ")
            self.assertIn("history", lead)
            self.assertGreater(len(lead["history"]), 0)

            # Pruefen ob alle initialisierten Leads einen gueltigen Status haben
            all_leads = self.storage.list_leads()
            self.assertEqual(len(all_leads), count)
            for l in all_leads:
                self.assertIn(l["status"], VALID_LEAD_STATUSES)


if __name__ == "__main__":
    unittest.main()
