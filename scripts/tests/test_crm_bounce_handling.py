"""
scripts/tests/test_crm_bounce_handling.py
Unit- und Integrationstests fuer CRM Bounce-Handling & Bellustoys-Quarantaene.

Akzeptanzkriterien:
1. DSN 5.1.1 Hard-Bounces werden erkannt, Lead wird BOUNCED und blacklisted (reason="bounce").
2. DSN 4.2.2 Soft-Bounces werden geloggt, fuehren aber zu keinem Statuswechsel.
3. Header wie X-Failed-Recipients und Final-Recipient werden zuverlaessig ausgewertet.
4. Eigene Adressen und Bounce-Absender (mailer-daemon@) werden nie als Empfaenger gewertet.
5. Ein Betreff wie 'Undeliverable' allein ohne starkes Signal ist kein Bounce.
6. TerminalStatusTransitionError verhindert den Wechsel weg von BOUNCED / LOST_BLACKLISTED.
7. Jurisdiction-Gate und dispatch_followup() blockieren BOUNCED Leads mit BlacklistedRecipientError.
8. find_eligible_leads() schliesst BOUNCED Leads aus.
9. cmd_status in crm_cli.py zeigt die Zeile BOUNCED an.
"""

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
)
from scripts.crm.crawler import (
    InboundMailCrawler,
    detect_bounce,
)
from scripts.crm.dispatcher import (
    EmailDispatcher,
)
from scripts.crm.followup_engine import (
    ColdOutreachJurisdictionGate,
    FollowUpEngine,
    LinkedInTaskManager,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    TerminalStatusTransitionError,
)
from scripts.crm_cli import cmd_status


class TestCRMBounceHandling(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"
        self.leads_file = Path(self.temp_dir.name) / "leads_db.json"
        self.state_file = Path(self.temp_dir.name) / "crawler_state.json"
        self.tasks_file = Path(self.temp_dir.name) / "linkedin_tasks.json"

        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(
            leads_file=self.leads_file,
            blacklist_mgr=self.blacklist_mgr
        )
        self.task_mgr = LinkedInTaskManager(tasks_file=self.tasks_file)
        self.gate = ColdOutreachJurisdictionGate(
            task_manager=self.task_mgr,
            storage=self.storage
        )

        self.own_addresses = {"thomas@thfc-consulting.de", "info@thfc-consulting.de"}
        self.crawler = InboundMailCrawler(
            storage=self.storage,
            blacklist_mgr=self.blacklist_mgr,
            state_file=self.state_file,
            own_addresses=self.own_addresses
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    # --- 1. detect_bounce Tests ---

    def test_detect_bounce_hard_511(self):
        parsed = {
            "from": "mailer-daemon@mail.protection.outlook.com",
            "subject": "Delivery Status Notification (Failure)",
            "body": "Your message couldn't be delivered to lead@b2b-seller.de.",
            "content_type": "multipart/report; report-type=delivery-status",
            "dsn_text": "Action: failed\r\nStatus: 5.1.1\r\nFinal-Recipient: rfc822; lead@b2b-seller.de\r\n",
            "x_failed_recipients": "",
            "message_id": "<dsn-1@outlook.com>",
        }
        res = detect_bounce(parsed, own_addresses=self.own_addresses)
        self.assertIsNotNone(res)
        self.assertEqual(res["kind"], "HARD")
        self.assertEqual(res["status_code"], "5.1.1")
        self.assertIn("lead@b2b-seller.de", res["recipients"])

    def test_detect_bounce_soft_422(self):
        parsed = {
            "from": "postmaster@relay.example.org",
            "subject": "Undelivered Mail: Mailbox Full",
            "body": "Mailbox is full temporarily.",
            "content_type": "multipart/report",
            "dsn_text": "Action: delayed\r\nStatus: 4.2.2\r\nFinal-Recipient: rfc822; busy@b2b-seller.de\r\n",
            "x_failed_recipients": "",
            "message_id": "<dsn-2@relay.example.org>",
        }
        res = detect_bounce(parsed, own_addresses=self.own_addresses)
        self.assertIsNotNone(res)
        self.assertEqual(res["kind"], "SOFT")
        self.assertEqual(res["status_code"], "4.2.2")
        self.assertIn("busy@b2b-seller.de", res["recipients"])

    def test_detect_bounce_x_failed_recipients(self):
        parsed = {
            "from": "mailer-daemon@postfix.org",
            "subject": "Undelivered Mail Returned to Sender",
            "body": "Remote host said: 550 5.1.1 User unknown",
            "content_type": "text/plain",
            "dsn_text": "",
            "x_failed_recipients": "bad-address@b2b-seller.de",
            "message_id": "<dsn-3@postfix.org>",
        }
        res = detect_bounce(parsed, own_addresses=self.own_addresses)
        self.assertIsNotNone(res)
        self.assertEqual(res["kind"], "HARD")
        self.assertIn("bad-address@b2b-seller.de", res["recipients"])

    def test_detect_bounce_subject_alone_is_not_bounce(self):
        parsed = {
            "from": "kaufmann@echter-haendler.de",
            "subject": "Undeliverable: Unsere GPSR Unterlagen",
            "body": "Hallo, ich bin Kaufmann und habe eine Frage zu GPSR.",
            "content_type": "text/plain",
            "dsn_text": "",
            "x_failed_recipients": "",
            "message_id": "<normal-1@echter-haendler.de>",
        }
        res = detect_bounce(parsed, own_addresses=self.own_addresses)
        self.assertIsNone(res)

    def test_detect_bounce_own_addresses_never_treated_as_recipient(self):
        parsed = {
            "from": "mailer-daemon@postfix.org",
            "subject": "Mail delivery failed",
            "body": "Message sent from thomas@thfc-consulting.de failed for recipient target@shop.fr",
            "content_type": "multipart/report",
            "dsn_text": "Status: 5.0.0\r\nFinal-Recipient: rfc822; target@shop.fr",
            "x_failed_recipients": "",
            "message_id": "<dsn-4@postfix.org>",
        }
        res = detect_bounce(parsed, own_addresses=self.own_addresses)
        self.assertIsNotNone(res)
        self.assertNotIn("thomas@thfc-consulting.de", res["recipients"])
        self.assertIn("target@shop.fr", res["recipients"])

    def test_detect_bounce_regex_fallback_requires_known_lead(self):
        # Lead existiert nicht im CRM
        parsed = {
            "from": "mailer-daemon@postfix.org",
            "from_email": "mailer-daemon@postfix.org",
            "subject": "Undelivered Mail",
            "body": "Diagnostic-Code: smtp; 550 unknown user ghost@unknown-domain.de in message",
            "content_type": "text/plain",
            "dsn_text": "",
            "x_failed_recipients": "",
            "message_id": "<dsn-5@postfix.org>",
        }
        # Ohne is_known_lead matcht der Regex-Fallback nicht -> recipients ist leer
        res_no_lookup = detect_bounce(parsed, own_addresses=self.own_addresses, is_known_lead=None)
        self.assertIsNotNone(res_no_lookup)
        self.assertEqual(res_no_lookup["recipients"], [])

        # Mit is_known_lead Match
        is_known = lambda email: email == "ghost@unknown-domain.de"
        res_lookup = detect_bounce(parsed, own_addresses=self.own_addresses, is_known_lead=is_known)
        self.assertIsNotNone(res_lookup)
        self.assertIn("ghost@unknown-domain.de", res_lookup["recipients"])

    # --- 2. InboundMailCrawler Integration Tests ---

    def test_crawler_processes_hard_bounce_updates_lead_and_blacklist(self):
        lead_email = "bounced-lead@toys-nl.nl"
        self.storage.update_lead_status(lead_email, LeadStatus.OUTREACH_SENT)
        self.assertTrue(self.storage.can_contact(lead_email))

        raw_msg = {
            "from": "mailer-daemon@relay.net",
            "subject": "Delivery Status Notification (Failure)",
            "body": f"550 5.1.1 User unknown {lead_email}",
            "content_type": "multipart/report",
            "dsn_text": f"Status: 5.1.1\r\nFinal-Recipient: rfc822; {lead_email}\r\n",
            "x_failed_recipients": "",
            "message_id": "<crawl-bounce-1@relay.net>",
        }

        action = self.crawler.process_message(raw_msg)
        self.assertEqual(action.get("status"), "BOUNCE_HARD")

        # Lead muss Status BOUNCED haben
        lead = self.storage.get_lead(lead_email)
        self.assertIsNotNone(lead)
        self.assertEqual(lead["status"], LeadStatus.BOUNCED)

        # can_contact muss False sein
        self.assertFalse(self.storage.can_contact(lead_email))

        # Adresse muss in Blacklist mit reason='bounce' stehen
        self.assertTrue(self.blacklist_mgr.is_blacklisted(lead_email))
        bl_entry = self.blacklist_mgr.get_blacklist().get(lead_email)
        self.assertIsNotNone(bl_entry)
        self.assertEqual(bl_entry["reason"], "bounce")

    def test_crawler_processes_soft_bounce_no_status_change(self):
        lead_email = "soft-bounce@toys-nl.nl"
        self.storage.update_lead_status(lead_email, LeadStatus.OUTREACH_SENT)

        raw_msg = {
            "from": "mailer-daemon@relay.net",
            "subject": "Delivery Status Notification (Delay)",
            "body": f"4.2.2 Mailbox full for {lead_email}",
            "content_type": "multipart/report",
            "dsn_text": f"Status: 4.2.2\r\nFinal-Recipient: rfc822; {lead_email}\r\n",
            "x_failed_recipients": "",
            "message_id": "<crawl-bounce-2@relay.net>",
        }

        action = self.crawler.process_message(raw_msg)
        self.assertEqual(action.get("status"), "BOUNCE_SOFT")

        # Lead-Status darf NICHT BOUNCED sein
        lead = self.storage.get_lead(lead_email)
        self.assertEqual(lead["status"], LeadStatus.OUTREACH_SENT)
        self.assertFalse(self.blacklist_mgr.is_blacklisted(lead_email))

    # --- 3. Storage & Terminal Status Transition Tests ---

    def test_storage_mark_bounced_is_idempotent(self):
        email = "idempotent@bounce.de"
        self.storage.mark_bounced(email, detail="First 550 bounce")
        lead1 = self.storage.get_lead(email)
        self.assertEqual(lead1["status"], LeadStatus.BOUNCED)

        # Zweiter Aufruf
        self.storage.mark_bounced(email, detail="Second bounce notice")
        lead2 = self.storage.get_lead(email)
        self.assertEqual(lead2["status"], LeadStatus.BOUNCED)
        # 1 Erstellung/Statuswechsel + 2 Bounce-Recordings = 3 History-Eintraege
        self.assertEqual(len(lead2.get("history", [])), 3)

    def test_terminal_status_transition_error_on_reopening(self):
        email = "terminal-lead@shop.de"
        self.storage.mark_bounced(email, detail="Hard bounce")

        # Versuch, den Lead auf OUTREACH_SENT zurueckzusetzen, muss scheitern
        with self.assertRaises(TerminalStatusTransitionError):
            self.storage.update_lead_status(email, LeadStatus.OUTREACH_SENT)

        # Auch LOST_BLACKLISTED darf nicht auf OUTREACH_SENT gesetzt werden
        email2 = "blacklisted@shop.de"
        self.storage.update_lead_status(email2, LeadStatus.LOST_BLACKLISTED)
        with self.assertRaises(TerminalStatusTransitionError):
            self.storage.update_lead_status(email2, LeadStatus.NOT_SENT)

        # ABER: LOST_BLACKLISTED -> BOUNCED ist explizit erlaubt
        lead_bl_to_bounce = self.storage.update_lead_status(email2, LeadStatus.BOUNCED)
        self.assertEqual(lead_bl_to_bounce["status"], LeadStatus.BOUNCED)

    # --- 4. Follow-Up Engine & Gate Tests ---

    def test_find_eligible_leads_excludes_bounced_leads(self):
        bounced_email = "bounced@exclude.com"
        self.storage.mark_bounced(bounced_email)

        engine = FollowUpEngine(storage=self.storage, blacklist_mgr=self.blacklist_mgr)
        eligible = engine.find_eligible_leads()
        emails = [item["lead"]["email"] for item in eligible]
        self.assertNotIn(bounced_email, emails)

    def test_route_lead_to_linkedin_raises_for_bounced_lead_without_overwriting(self):
        bounced_nl = "bellustoys-test@bellustoys.nl"
        self.storage.mark_bounced(bounced_nl)

        # route_lead_to_linkedin darf den Status NICHT auf CHANNEL_RESTRICTED ueberschreiben
        with self.assertRaises(BlacklistedRecipientError):
            self.gate.route_lead_to_linkedin(
                bounced_nl,
                country_code="NL",
                legal_basis="Art. 11.7 Telecommunicatiewet"
            )

        lead = self.storage.get_lead(bounced_nl)
        self.assertEqual(lead["status"], LeadStatus.BOUNCED)

    def test_dispatch_followup_blocks_bounced_lead(self):
        bounced_email = "blocked-dispatch@shop.fr"
        self.storage.mark_bounced(bounced_email)

        dispatcher = EmailDispatcher(dry_run=True, storage=self.storage, blacklist_mgr=self.blacklist_mgr)
        engine = FollowUpEngine(
            storage=self.storage,
            dispatcher=dispatcher,
            blacklist_mgr=self.blacklist_mgr,
            jurisdiction_gate=self.gate
        )

        draft = {
            "draft_id": "draft-bounce-1",
            "lead_id": bounced_email,
            "recipient": bounced_email,
            "company": "Bounce SARL",
            "country": "France",
            "subject": "Follow-Up GPSR",
            "body_text": "Hallo...",
            "body_html": "<p>Hallo...</p>",
            "status": "APPROVED",
        }

        # Muss BlacklistedRecipientError werfen und Provider-Aufruf verhindern
        with self.assertRaises(BlacklistedRecipientError):
            engine.dispatch_followup(draft)

    # --- 5. CLI Output Test ---

    def test_cli_cmd_status_includes_bounced_line(self):
        args = MagicMock()
        buf = io.StringIO()
        with patch("scripts.crm_cli.get_default_storage", return_value=self.storage):
            with patch("scripts.crm_cli.get_default_manager", return_value=self.blacklist_mgr):
                with redirect_stdout(buf):
                    cmd_status(args)
        output = buf.getvalue()
        self.assertIn("- BOUNCED:", output)

    # --- 6. Security & Legal Audit Tests (P2 & P4) ---

    def test_opt_out_preservation_on_subsequent_bounce(self):
        """P2 (S2-2): Gesetzlicher Opt-Out Nachweis wird nicht durch Bounce ueberschrieben."""
        email = "optout-lead@seller.de"
        # 1. Lead erklaert Opt-Out
        self.blacklist_mgr.add_to_blacklist(
            email,
            reason="Widerspruch gem. Art. 21 DSGVO / Kein Interesse",
            snippet="Bitte loeschen Sie unsere Daten",
        )
        entry1 = self.blacklist_mgr.get_blacklist()[email]
        self.assertIn("Art. 21 DSGVO", entry1["reason"])

        # 2. Spaeter trifft ein technischer Hard-Bounce fuer dieselbe Adresse ein
        self.blacklist_mgr.add_to_blacklist(
            email,
            reason="bounce",
            snippet="550 5.1.1 User unknown",
        )
        entry2 = self.blacklist_mgr.get_blacklist()[email]
        # Grund MUSS weiterhin der urspruengliche Opt-Out sein
        self.assertIn("Art. 21 DSGVO", entry2["reason"])
        self.assertIn("[Nachtraeglicher Hard-Bounce erfasst: 550 5.1.1 User unknown]", entry2["snippet"])

    def test_crawler_dsn_spoofing_defense_ignores_uncontacted_lead(self):
        """P4 (S2-4): DSN fuer unkontaktierten Lead (NOT_SENT) fuehrt zu keinem Statuswechsel."""
        uncontacted_email = "never-sent@target-store.de"
        # Lead existiert, ist aber im Status NOT_SENT
        self.storage.update_lead_status(uncontacted_email, LeadStatus.NOT_SENT)
        self.assertEqual(self.storage.get_lead(uncontacted_email)["status"], LeadStatus.NOT_SENT)

        raw_msg = {
            "from": "mailer-daemon@spoofed-relay.com",
            "subject": "Delivery Status Notification (Failure)",
            "body": f"550 5.1.1 User unknown {uncontacted_email}",
            "content_type": "multipart/report",
            "dsn_text": f"Status: 5.1.1\r\nFinal-Recipient: rfc822; {uncontacted_email}\r\n",
            "x_failed_recipients": "",
            "message_id": "<spoofed-dsn-1@spoofed-relay.com>",
        }

        action = self.crawler.process_message(raw_msg)
        self.assertEqual(action.get("status"), "BOUNCE_HARD")
        # marked_bounced darf den unkontaktierten Lead NICHT enthalten
        self.assertNotIn(uncontacted_email, action.get("marked_bounced", []))

        # Status MUSS unveraendert NOT_SENT bleiben
        lead = self.storage.get_lead(uncontacted_email)
        self.assertEqual(lead["status"], LeadStatus.NOT_SENT)
        self.assertFalse(self.blacklist_mgr.is_blacklisted(uncontacted_email))


if __name__ == "__main__":
    unittest.main()
