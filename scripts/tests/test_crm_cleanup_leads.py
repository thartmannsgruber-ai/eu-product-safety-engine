"""
scripts/tests/test_crm_cleanup_leads.py
Unit- & Integrationstests fuer Feature F06:
CRM Lead Database Sanitation & State Machine Expansion.

Akzeptanzkriterien:
1. LeadStatus unterstuetzt NOT_SENT und FOLLOWUP_SENT als valide Zustaende in VALID_LEAD_STATUSES
2. Bereinigungs-Skript korrigiert exakt die 29 ungesendeten Leads aus IT, PL, ES und AT auf NOT_SENT
3. Die 24 real gesendeten Leads (10 Frankreich, 14 Niederlande) behalten den Status OUTREACH_SENT
4. Geblockte Leads im Status LOST_BLACKLISTED bleiben unangetastet
"""

import json
import os
import shutil
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from scripts.crm.blacklist import BlacklistManager, normalize_email
from scripts.crm.cleanup_leads import cleanup_leads_db
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
)


class TestCRMLeadDatabaseSanitation(unittest.TestCase):
    def setUp(self):
        self.project_root = Path(__file__).resolve().parent.parent.parent
        self.workspace_leads_file = self.project_root / ".crm" / "leads_db.json"
        self.workspace_sent_log = self.project_root / ".market" / "leads" / "sent_log.json"
        self.workspace_blacklist = self.project_root / ".crm" / "blacklist.json"

        # Isolierte Testumgebung
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_root = Path(self.temp_dir.name)
        self.test_leads_file = self.temp_root / "leads_db.json"
        self.test_sent_log = self.temp_root / "sent_log.json"
        self.test_blacklist = self.temp_root / "blacklist.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_criterion_1_lead_status_states_and_valid_lead_statuses(self):
        """
        Kriterium 1: LeadStatus unterstuetzt NOT_SENT und FOLLOWUP_SENT
        als valide Zustaende in VALID_LEAD_STATUSES.
        """
        self.assertTrue(hasattr(LeadStatus, "NOT_SENT"))
        self.assertTrue(hasattr(LeadStatus, "FOLLOWUP_SENT"))
        self.assertEqual(LeadStatus.NOT_SENT, "NOT_SENT")
        self.assertEqual(LeadStatus.FOLLOWUP_SENT, "FOLLOWUP_SENT")

        self.assertIn(LeadStatus.NOT_SENT, VALID_LEAD_STATUSES)
        self.assertIn(LeadStatus.FOLLOWUP_SENT, VALID_LEAD_STATUSES)
        self.assertIn(LeadStatus.OUTREACH_SENT, VALID_LEAD_STATUSES)
        self.assertIn(LeadStatus.REPLIED_POSITIVE, VALID_LEAD_STATUSES)
        self.assertIn(LeadStatus.REPLIED_INQUIRY, VALID_LEAD_STATUSES)
        self.assertIn(LeadStatus.LOST_BLACKLISTED, VALID_LEAD_STATUSES)

        # Pruefe ob CRMStorage Zustandswechsel auf NOT_SENT und FOLLOWUP_SENT erlaubt
        storage = CRMStorage(leads_file=self.test_leads_file)
        email = "partner@testcompany.eu"

        lead_not_sent = storage.update_lead_status(email, LeadStatus.NOT_SENT, reason="Database reset")
        self.assertEqual(lead_not_sent["status"], LeadStatus.NOT_SENT)
        self.assertEqual(storage.get_lead(email)["status"], LeadStatus.NOT_SENT)

        lead_followup = storage.update_lead_status(email, LeadStatus.FOLLOWUP_SENT, reason="Followup sent")
        self.assertEqual(lead_followup["status"], LeadStatus.FOLLOWUP_SENT)
        self.assertEqual(storage.get_lead(email)["status"], LeadStatus.FOLLOWUP_SENT)

    def test_criterion_2_3_4_cleanup_on_fixture_dataset(self):
        """
        Testet die Bereinigungslogik auf einem isolierten synthetischen Datensatz:
        - 2 real gesendete Leads -> bleiben OUTREACH_SENT
        - 3 ungesendete Leads -> werden auf NOT_SENT korrigiert
        - 1 geblockter Lead -> bleibt LOST_BLACKLISTED
        """
        synthetic_sent_log = {
            "sent1@fr-retailer.fr": {
                "sent_at": "2026-11-19T20:43:00+00:00",
                "country": "France",
                "company": "FR Toys 1",
            },
            "sent2@nl-wholesaler.nl": {
                "sent_at": "2026-11-19T20:50:00+00:00",
                "country": "Netherlands",
                "company": "NL Toys 2",
            },
        }
        with open(self.test_sent_log, "w", encoding="utf-8") as f:
            json.dump(synthetic_sent_log, f)

        synthetic_leads_db = {
            # Gesendete Leads:
            "sent1@fr-retailer.fr": {
                "email": "sent1@fr-retailer.fr",
                "company": "FR Toys 1",
                "country": "France",
                "status": "OUTREACH_SENT",
            },
            "sent2@nl-wholesaler.nl": {
                "email": "sent2@nl-wholesaler.nl",
                "company": "NL Toys 2",
                "country": "Netherlands",
                "status": "OUTREACH_SENT",
            },
            # Ungesendete Leads (faelschlich als OUTREACH_SENT initialisiert):
            "unsent1@it-distrib.it": {
                "email": "unsent1@it-distrib.it",
                "company": "IT Toys",
                "country": "Italy",
                "status": "OUTREACH_SENT",
            },
            "unsent2@pl-toys.pl": {
                "email": "unsent2@pl-toys.pl",
                "company": "PL Toys",
                "country": "Poland",
                "status": "OUTREACH_SENT",
            },
            "unsent3@es-juguetes.es": {
                "email": "unsent3@es-juguetes.es",
                "company": "ES Juguetes",
                "country": "Spain",
                "status": "OUTREACH_SENT",
            },
            # Geblockter Lead:
            "blocked@optout.com": {
                "email": "blocked@optout.com",
                "company": "OptOut AG",
                "country": "Germany",
                "status": "LOST_BLACKLISTED",
            },
        }
        with open(self.test_leads_file, "w", encoding="utf-8") as f:
            json.dump(synthetic_leads_db, f)

        # BlacklistManager
        bl_mgr = BlacklistManager(blacklist_file=self.test_blacklist)
        bl_mgr.add_to_blacklist("blocked@optout.com", reason="Unsubscribe")

        # Ausfuehrung Cleanup
        result = cleanup_leads_db(
            leads_path=self.test_leads_file,
            sent_log_path=self.test_sent_log,
            blacklist_mgr=bl_mgr,
        )

        self.assertEqual(result["total"], 6)
        self.assertEqual(result["corrected_to_not_sent"], 3)
        self.assertEqual(result["kept_outreach_sent"], 2)
        self.assertEqual(result["kept_lost_blacklisted"], 1)

        # Pruefe persistierte Datei
        with open(self.test_leads_file, "r", encoding="utf-8") as f:
            persisted = json.load(f)

        self.assertEqual(persisted["sent1@fr-retailer.fr"]["status"], LeadStatus.OUTREACH_SENT)
        self.assertEqual(persisted["sent2@nl-wholesaler.nl"]["status"], LeadStatus.OUTREACH_SENT)
        self.assertEqual(persisted["unsent1@it-distrib.it"]["status"], LeadStatus.NOT_SENT)
        self.assertEqual(persisted["unsent2@pl-toys.pl"]["status"], LeadStatus.NOT_SENT)
        self.assertEqual(persisted["unsent3@es-juguetes.es"]["status"], LeadStatus.NOT_SENT)
        self.assertEqual(persisted["blocked@optout.com"]["status"], LeadStatus.LOST_BLACKLISTED)

    def test_criterion_2_3_4_workspace_crm_leads_sanitation(self):
        """
        Verifiziert die exakten Kriterien auf der echten .crm/leads_db.json:
        - Exakt 29 ungesendete Leads aus IT, PL, ES, AT haben Status NOT_SENT
        - Exakt 24 real gesendete Leads (10 FR, 14 NL) behalten Status OUTREACH_SENT
        - Geblockte Leads im Status LOST_BLACKLISTED bleiben unangetastet
        """
        # Cleanup auf Workspace-DB ausfuehren (idempotent)
        stats = cleanup_leads_db(
            leads_path=self.workspace_leads_file,
            sent_log_path=self.workspace_sent_log,
        )

        with open(self.workspace_leads_file, "r", encoding="utf-8") as f:
            db = json.load(f)

        with open(self.workspace_sent_log, "r", encoding="utf-8") as f:
            sent_log = json.load(f)

        self.assertEqual(len(sent_log), 24, "sent_log.json muss exakt 24 Eintraege enthalten")
        self.assertEqual(len(db), 55, "leads_db.json muss genau 55 Eintraege umfassen")

        # 1. 24 real gesendete Leads (10 Frankreich, 14 Niederlande)
        sent_leads = [lead for email, lead in db.items() if email in sent_log]
        self.assertEqual(len(sent_leads), 24, "Es muessen exakt 24 real gesendete Leads sein")

        for lead in sent_leads:
            self.assertIn(
                lead["status"],
                (LeadStatus.OUTREACH_SENT, LeadStatus.BOUNCED),
                f"Lead {lead['email']} in sent_log muss OUTREACH_SENT oder BOUNCED behalten",
            )
        sent_countries = Counter(lead.get("country") for lead in sent_leads)
        self.assertEqual(sent_countries.get("France"), 10, "Exakt 10 gesendete Leads aus Frankreich")
        self.assertEqual(sent_countries.get("Netherlands"), 14, "Exakt 14 gesendete Leads aus den Niederlanden")

        # 2. 29 ungesendete Leads (IT, PL, ES, AT)
        not_sent_leads = [lead for email, lead in db.items() if lead.get("status") == LeadStatus.NOT_SENT]
        self.assertEqual(len(not_sent_leads), 29, "Exakt 29 ungesendete Leads muessen auf NOT_SENT korrigiert sein")

        not_sent_countries = Counter(lead.get("country") for lead in not_sent_leads)
        valid_not_sent_countries = {"Italy", "Poland", "Spain", "Austria"}
        self.assertTrue(
            set(not_sent_countries.keys()).issubset(valid_not_sent_countries),
            f"Ungesendete Leads duerfen nur aus IT, PL, ES, AT stammen: {not_sent_countries}",
        )
        self.assertEqual(
            sum(not_sent_countries.values()), 29, "Summe der ungesendeten Leads aus IT, PL, ES, AT muss 29 sein"
        )
        self.assertEqual(not_sent_countries.get("Spain"), 10)
        self.assertEqual(not_sent_countries.get("Italy"), 9)
        self.assertEqual(not_sent_countries.get("Poland"), 7)
        self.assertEqual(not_sent_countries.get("Austria"), 3)

        # 3. Geblockte Leads im Status LOST_BLACKLISTED
        blacklisted_leads = [
            lead for email, lead in db.items() if lead.get("status") == LeadStatus.LOST_BLACKLISTED
        ]
        self.assertEqual(len(blacklisted_leads), 2, "Exakt 2 geblockte Leads muessen erhalten bleiben")
        blacklisted_emails = {lead["email"] for lead in blacklisted_leads}
        self.assertIn("christian.wagner@pvm-ag.de", blacklisted_emails)
        self.assertIn("hello@apify.com", blacklisted_emails)

        # Gesamtsumme
        self.assertEqual(len(sent_leads) + len(not_sent_leads) + len(blacklisted_leads), 55)


if __name__ == "__main__":
    unittest.main()
