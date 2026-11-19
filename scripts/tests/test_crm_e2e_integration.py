"""
scripts/tests/test_crm_e2e_integration.py
End-to-End Workflow & Integration Verification for ProductSafetyEngine CRM.

Simuliert den vollstaendigen End-to-End-Zyklus:
1. Negativ-Antwort 'Non, pas intéressé' fuehrt direkt zur Blacklist (Goldene Regel).
2. Positiv-Antwort mit EANs stoesst Engine an, erzeugt Report mit Disclaimer, Draft landet in Queue.
3. Freigabe durch Thomas (Human-in-the-Loop HITL).
4. Versand mit RFC 2822 Threading-Headern (In-Reply-To, References).
5. Blacklist-Praevention bei Neuversand (100% Kontaktschutz vor Folgekontakten).

Akzeptanzkriterien:
- Vollstaendiger Workflow-Durchlauf von Inbound-Mail bis zum versendeten Report laeuft fehlerfrei.
- Goldene Regel schuetzt 100% vor Folgekontakten nach Opt-Out.
- Disclaimer und Datumsstempel sind im finalen E-Mail-Body nachweisbar vorhanden.
- Alle Test-Suiten laufen mit Exit-Code 0 durch.
"""

from __future__ import annotations

import argparse
import email
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    assert_can_contact,
    can_contact,
    is_blacklisted,
    set_default_manager,
)
from scripts.crm.classifier import (
    ClassificationResult,
    Intent,
    classify_intent,
)
from scripts.crm.crawler import (
    InboundMailCrawler,
)
from scripts.crm.dispatcher import (
    DispatchResult,
    EmailDispatcher,
    UnapprovedDraftError,
    format_message_id_header,
    format_references_header,
    set_default_dispatcher,
)
from scripts.crm.drafter import (
    APIFY_ACTOR_URL,
    ResponseDraft,
    ResponseDrafter,
    get_default_drafter,
)
from scripts.crm.engine_runner import (
    AuditHit,
    AuditItem,
    AuditResult,
    AuditRunReport,
    SafetyGateEngine,
)
from scripts.crm.report_generator import (
    STANDARD_DISCLAIMER_TEMPLATE,
    ZERO_HITS_NOTE,
    format_safety_gate_date,
)
from scripts.crm.review_queue import (
    DraftNotFoundError,
    DraftStatus,
    InvalidStatusTransitionError,
    ReviewQueue,
    set_default_queue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    set_default_storage,
)
from scripts.crm_cli import (
    cmd_approve,
    cmd_blacklist,
    cmd_queue,
    cmd_reject,
    cmd_send,
    cmd_show,
    cmd_status,
)


class TestCRME2EIntegration(unittest.TestCase):
    """Vollstaendige E2E-Integrations- und Workflow-Verifikation."""

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

        self.queue_file = self.temp_path / "review_queue.json"
        self.blacklist_file = self.temp_path / "blacklist.json"
        self.leads_file = self.temp_path / "leads_db.json"
        self.state_file = self.temp_path / "crawler_state.json"

        # Isolierte Komponenten-Instanzen
        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(
            leads_file=self.leads_file,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.queue = ReviewQueue(
            queue_file=self.queue_file,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.drafter = ResponseDrafter(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.engine = SafetyGateEngine(auto_load=True)
        self.dispatcher = EmailDispatcher(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
            storage=self.storage,
            provider="resend",
            dry_run=True,
            resend_api_key="re_mock_test_key_e2e_999",
        )
        self.crawler = InboundMailCrawler(
            storage=self.storage,
            blacklist_mgr=self.blacklist_mgr,
            state_file=self.state_file,
            engine=self.engine,
            drafter=self.drafter,
            auto_draft=True,
        )

        # Singletons fuer CLI-Befehle konfigurieren
        set_default_manager(self.blacklist_mgr)
        set_default_storage(self.storage)
        set_default_queue(self.queue)
        set_default_dispatcher(self.dispatcher)

        # Ausgangsbasis: Zwei Kampagnen-Leads anlegen
        # Lead 1: Franzoesischer Spielwaren-Direktor (wird fuer Negativ-Test verwendet)
        self.lead_fr_email = "directeur@jouets-france.fr"
        self.lead_fr_outreach_msg_id = "<outreach-fr-001@system.thfc-consulting.de>"
        self.storage.update_lead_status(
            self.lead_fr_email,
            LeadStatus.OUTREACH_SENT,
            reason="Campaign batch FR-01",
        )
        lead_fr = self.storage.get_lead(self.lead_fr_email)
        assert lead_fr is not None
        lead_fr.update(
            {
                "company": "Jouets France SAS",
                "country": "France",
                "language": "fr",
                "subject": "Vérification Safety Gate pour Jouets France ?",
                "message_id": self.lead_fr_outreach_msg_id,
                "resend_id": "resend_fr_outreach_001",
            }
        )

        # Lead 2: Deutsche Spielwaren KG (wird fuer Positiv-Test mit EANs verwendet)
        self.lead_de_email = "clara@spielwaren-hamburg.de"
        self.lead_de_outreach_msg_id = "<outreach-de-002@system.thfc-consulting.de>"
        self.storage.update_lead_status(
            self.lead_de_email,
            LeadStatus.OUTREACH_SENT,
            reason="Campaign batch DE-01",
        )
        lead_de = self.storage.get_lead(self.lead_de_email)
        assert lead_de is not None
        lead_de.update(
            {
                "company": "Spielwaren Hamburg KG",
                "country": "Germany",
                "language": "de",
                "subject": "Produktsicherheit & EU Safety Gate Schnelltest",
                "message_id": self.lead_de_outreach_msg_id,
                "resend_id": "resend_de_outreach_002",
            }
        )

        self.storage.save()

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # TEST 1: Der vollstaendige 5-Stufen-Zyklus (End-to-End Haupttest)
    # -----------------------------------------------------------------------

    def test_complete_end_to_end_cycle_step1_to_step5(self) -> None:
        """
        Simuliert exakt den vollstaendigen Zyklus gemaess Feature-Beschreibung:
        1. Negativ-Antwort 'Non, pas intéressé' fuehrt direkt zur Blacklist.
        2. Positiv-Antwort mit EANs stoesst Engine an, erzeugt Report mit Disclaimer, Draft landet in Queue.
        3. Freigabe durch Thomas (HITL).
        4. Versand mit Threading-Header (In-Reply-To, References).
        5. Blacklist-Praevention bei Neuversand.
        """

        # ===================================================================
        # STUFE 1: Negativ-Antwort 'Non, pas intéressé' fuehrt direkt zur Blacklist
        # ===================================================================
        inbound_neg = {
            "from": "Pierre Dubois <directeur@jouets-france.fr>",
            "subject": "Re: Vérification Safety Gate pour Jouets France ?",
            "in_reply_to": self.lead_fr_outreach_msg_id,
            "references": self.lead_fr_outreach_msg_id,
            "message_id": "<reply-neg-fr-101@jouets-france.fr>",
            "body": "Non, pas intéressé. Merci de ne plus nous contacter et de supprimer nos données.",
        }

        crawl_res_neg = self.crawler.process_message(inbound_neg)

        # Verifikation Stufe 1
        self.assertEqual(crawl_res_neg["status"], "PROCESSED")
        self.assertEqual(crawl_res_neg["intent"], Intent.NEGATIVE_OPTOUT)
        self.assertEqual(crawl_res_neg["lead_email"], self.lead_fr_email)

        # Goldene Regel: Sofortige permanente Blacklistierung
        self.assertTrue(self.blacklist_mgr.is_blacklisted(self.lead_fr_email))
        self.assertFalse(self.blacklist_mgr.can_contact(self.lead_fr_email))
        with self.assertRaises(BlacklistedRecipientError):
            self.blacklist_mgr.assert_can_contact(self.lead_fr_email)

        # CRM Lead Status aktualisiert
        lead_fr_updated = self.storage.get_lead(self.lead_fr_email)
        self.assertIsNotNone(lead_fr_updated)
        self.assertEqual(lead_fr_updated["status"], LeadStatus.LOST_BLACKLISTED)
        self.assertTrue(any(e["action"] == "INBOUND_REPLY" for e in lead_fr_updated.get("history", [])))

        # ===================================================================
        # STUFE 2: Positiv-Antwort mit EANs stoesst Engine an,
        #          erzeugt Report mit Disclaimer, Draft landet in Queue
        # ===================================================================
        inbound_pos = {
            "from": "Clara Schmidt <clara@spielwaren-hamburg.de>",
            "subject": "Re: Produktsicherheit & EU Safety Gate Schnelltest",
            "in_reply_to": self.lead_de_outreach_msg_id,
            "references": self.lead_de_outreach_msg_id,
            "message_id": "<reply-pos-de-202@spielwaren-hamburg.de>",
            "body": (
                "Hallo Thomas,\n\n"
                "vielen Dank für das Anschreiben. Ja, das klingt spannend und wir testen Ihren Schnelltest gerne!\n"
                "Können Sie bitte folgende Artikel für uns prüfen:\n"
                "- Flashing Baby Shoes: 1072105714 (GTIN-10 / Barcode)\n"
                "- Holz-Puzzle Bauernhof: 4006381333931 (EAN-13)\n\n"
                "Herzliche Grüße,\n"
                "Clara Schmidt\n"
                "Spielwaren Hamburg KG"
            ),
        }

        crawl_res_pos = self.crawler.process_message(inbound_pos)

        # Verifikation Stufe 2
        self.assertEqual(crawl_res_pos["status"], "PROCESSED")
        self.assertEqual(crawl_res_pos["intent"], Intent.POSITIVE_TEST_REQUEST)
        self.assertEqual(crawl_res_pos["lead_email"], self.lead_de_email)

        # Lead-Status auf REPLIED_POSITIVE
        lead_de_updated = self.storage.get_lead(self.lead_de_email)
        self.assertIsNotNone(lead_de_updated)
        self.assertEqual(lead_de_updated["status"], LeadStatus.REPLIED_POSITIVE)

        # Entwurf wurde automatisch generiert und in Queue eingereiht
        self.assertIn("draft_id", crawl_res_pos)
        draft_id = crawl_res_pos["draft_id"]
        self.assertTrue(draft_id.startswith("draft_"))

        draft = self.queue.get_draft(draft_id)
        self.assertIsNotNone(draft)
        self.assertEqual(draft["status"], DraftStatus.PENDING_REVIEW)
        self.assertEqual(draft["lead_email"], self.lead_de_email)
        self.assertEqual(draft["language"], "de")

        # Zwingender Disclaimer & Datumsstempel nachweisbar im Body vorhanden
        draft_body = draft["body"]
        self.assertIn("Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom", draft_body)
        self.assertIn("13.11.2026", draft_body)
        self.assertIn(APIFY_ACTOR_URL, draft_body)
        self.assertTrue("5$" in draft_body or "$5" in draft_body or "Startguthaben" in draft_body)

        # ===================================================================
        # STUFE 3: Freigabe durch Thomas (Human-in-the-Loop)
        # ===================================================================
        # Versuch des unberechtigten Versands VOR Freigabe MUSS strikt scheitern
        with self.assertRaises(UnapprovedDraftError):
            self.dispatcher.dispatch_draft(draft_id, dry_run=True)

        # Freigabe durch Thomas via Queue (oder CLI)
        approved_draft = self.queue.approve(
            draft_id=draft_id,
            reviewer="Thomas",
            note="E2E Verifikation: Audit-Report plausibel, Freigabe erteilt.",
        )

        self.assertEqual(approved_draft["status"], DraftStatus.APPROVED)
        self.assertEqual(approved_draft["reviewed_by"], "Thomas")
        self.assertIsNotNone(approved_draft.get("approved_at"))

        # ===================================================================
        # STUFE 4: Versand mit Threading-Header
        # ===================================================================
        # Simulation mit Resend API Dispatch (Mocked Response)
        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps({"id": "resend_msg_e2e_success_777"}).encode("utf-8")
            mock_urlopen.return_value.__enter__.return_value = mock_resp

            live_dispatcher = EmailDispatcher(
                queue=self.queue,
                blacklist_mgr=self.blacklist_mgr,
                storage=self.storage,
                provider="resend",
                dry_run=False,
                resend_api_key="re_valid_dummy_key_e2e",
            )

            dispatch_result = live_dispatcher.dispatch_draft(draft_id)

        self.assertEqual(dispatch_result.status, "SENT")
        self.assertEqual(dispatch_result.recipient, self.lead_de_email)
        self.assertEqual(dispatch_result.message_id, "resend_msg_e2e_success_777")

        # Threading-Header verifizieren (In-Reply-To und References zur urspruenglichen Inbound/Outreach-Mail)
        headers = dispatch_result.headers
        self.assertIn("In-Reply-To", headers)
        self.assertEqual(headers["In-Reply-To"], "<reply-pos-de-202@spielwaren-hamburg.de>")
        self.assertIn("References", headers)
        self.assertIn(self.lead_de_outreach_msg_id, headers["References"])
        self.assertIn("<reply-pos-de-202@spielwaren-hamburg.de>", headers["References"])

        # Status in Queue atomar auf SENT gesetzt
        final_draft = self.queue.get_draft(draft_id)
        self.assertEqual(final_draft["status"], DraftStatus.SENT)
        dispatch_data = final_draft.get("dispatch_info") or final_draft.get("dispatch_meta") or {}
        self.assertEqual(dispatch_data.get("message_id"), "resend_msg_e2e_success_777")

        # Disclaimer und Datumsstempel sind im finalen E-Mail-Body nachweisbar vorhanden
        final_body = final_draft["body"]
        self.assertIn("Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026", final_body)
        self.assertIn("13.11.2026", final_body)

        # ===================================================================
        # STUFE 5: Blacklist-Praevention bei Neuversand (Goldene Regel)
        # ===================================================================
        # 5a. Neuer Entwurf fuer geblacklisteten Empfaenger wird sofort abgewiesen
        with self.assertRaises(BlacklistedRecipientError):
            self.drafter.draft_and_enqueue(
                lead={"email": self.lead_fr_email, "company": "Jouets France SAS"},
                inbound_message={"subject": "Re: Test", "message_id": "<test-msg-1>"},
                check_blacklist=True,
            )

        # 5b. Falls ein Entwurf manuell manipuliert waere: add_draft blockiert geblacklistete Empfaenger
        manipulated_draft = {
            "draft_id": "draft_illegal_blacklisted_recipient",
            "lead_email": self.lead_fr_email,
            "status": DraftStatus.PENDING_REVIEW,
            "subject": "Follow-Up trotz Opt-Out",
            "body": "Guten Tag, wir wollten noch einmal nachfragen...",
        }
        with self.assertRaises(BlacklistedRecipientError):
            self.queue.add_draft(manipulated_draft, check_blacklist=True)

        # 5c. Falls ein genehmigter Entwurf existierte: Dispatcher blockiert geblacklisteten Empfaenger
        approved_illegal_draft = {
            "draft_id": "draft_illegal_approved",
            "lead_email": self.lead_fr_email,
            "status": DraftStatus.APPROVED,
            "subject": "Illegal Approved",
            "body": "Illegal Body",
        }
        # In Queue ohne Blacklist-Check zu Testzwecken einfuegen
        self.queue.add_draft(approved_illegal_draft, check_blacklist=False)
        with self.assertRaises(BlacklistedRecipientError):
            self.dispatcher.dispatch_draft("draft_illegal_approved")

        # 5d. Batch Dispatch prueft Blacklist und ueberspringt geblacklistete Leads sicher
        batch_results = self.dispatcher.dispatch_all_approved(dry_run=True)
        blocked_entries = [r for r in batch_results if r.status == "BLOCKED_BLACKLIST"]
        self.assertEqual(len(blocked_entries), 1)
        self.assertEqual(blocked_entries[0].recipient, self.lead_fr_email)

        # 5e. Kampagnen-Versand via send_outreach filtert geblacklistete Leads vollstaendig aus
        from scripts.send_outreach import is_blacklisted, can_contact
        self.assertTrue(is_blacklisted(self.lead_fr_email))
        self.assertFalse(can_contact(self.lead_fr_email))

    # -----------------------------------------------------------------------
    # TEST 2: Goldene Regel schuetzt 100% vor Folgekontakten nach Opt-Out
    # -----------------------------------------------------------------------

    def test_golden_rule_multilingual_opt_out_protection(self) -> None:
        """
        Prueft die absolute Goldene Regel ueber alle Sprachen (FR, NL, DE, EN):
        Jedes Opt-Out fuehrt unverzueglich zu can_contact == False und blockiert
        jeglichen weiteren Folgekontakt.
        """
        test_cases = [
            # Franzoesisch
            ("optout_fr@client.fr", "Non, pas intéressé, merci de nous retirer.", "fr"),
            # Niederlaendisch
            ("optout_nl@bedrijf.nl", "Nee, geen interesse. Schrap ons a.u.b. uit uw bestand.", "nl"),
            # Deutsch
            ("optout_de@firma.de", "Nein danke, bitte keine weiteren E-Mails mehr zusenden.", "de"),
            # Englisch
            ("optout_en@store.co.uk", "Not interested. Unsubscribe us immediately.", "en"),
        ]

        for email_addr, reply_text, lang in test_cases:
            # Lead anlegen
            self.storage.update_lead_status(
                email_addr,
                LeadStatus.OUTREACH_SENT,
                reason="Initial outreach",
            )
            lead = self.storage.get_lead(email_addr)
            assert lead is not None
            lead["language"] = lang
            self.storage.save()

            inbound_msg = {
                "from": f"Contact <{email_addr}>",
                "subject": "Re: Product Safety Outreach",
                "message_id": f"<msg-{email_addr}>",
                "body": reply_text,
            }

            res = self.crawler.process_message(inbound_msg)
            self.assertEqual(res["intent"], Intent.NEGATIVE_OPTOUT)

            # 1. Blacklist-Pruefung
            self.assertTrue(
                self.blacklist_mgr.is_blacklisted(email_addr),
                f"E-Mail {email_addr} muss in Blacklist sein!",
            )
            self.assertFalse(
                self.blacklist_mgr.can_contact(email_addr),
                f"can_contact({email_addr}) muss zwingend False liefern!",
            )

            # 2. Lead-Status Pruefung
            lead_updated = self.storage.get_lead(email_addr)
            self.assertIsNotNone(lead_updated)
            self.assertEqual(lead_updated["status"], LeadStatus.LOST_BLACKLISTED)

            # 3. Sicherheits-Schranke bei Kontaktversuch
            with self.assertRaises(BlacklistedRecipientError):
                assert_can_contact(email_addr)

            # 4. Enqueue-Schutz
            with self.assertRaises(BlacklistedRecipientError):
                self.queue.add_draft(
                    {
                        "draft_id": f"draft_{email_addr}",
                        "lead_email": email_addr,
                        "status": DraftStatus.PENDING_REVIEW,
                        "subject": "Follow-Up",
                        "body": "Follow-up body",
                    },
                    check_blacklist=True,
                )

    # -----------------------------------------------------------------------
    # TEST 3: Disclaimer und Datumsstempel nachweisbar im E-Mail-Body
    # -----------------------------------------------------------------------

    def test_disclaimer_and_date_stamp_in_email_body_invariant(self) -> None:
        """
        Prueft die gesetzliche & fachliche Invariante:
        Disclaimer und Datumsstempel 'TT.MM.JJJJ' sind in jedem finalen Antwortentwurf
        nachweisbar vorhanden (sowohl mit Treffern als auch mit 0 Treffern).
        """
        lead = {
            "email": "test-disclaimer@compliance-toys.de",
            "company": "Compliance Toys GmbH",
            "language": "de",
        }

        # Fall A: Report mit 0 Treffern (Saubere Artikel)
        clean_report = AuditRunReport(
            results=[
                AuditResult(
                    item=AuditItem(gtin="4006381333931", product_name="Holzbaukasten"),
                    found=False,
                    hits=[],
                )
            ],
            data_date="13.11.2026",
            data_source="safety_gate_2026_45.xml",
        )

        draft_a = self.drafter.draft_response(
            lead=lead,
            report_data=clean_report,
            language="de",
            data_date="13.11.2026",
        )

        # Verifikation Fall A
        self.assertIn("Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026", draft_a.body)
        self.assertIn(ZERO_HITS_NOTE, draft_a.body)
        self.assertIn("13.11.2026", draft_a.body)
        self.assertRegex(draft_a.body, r"\b\d{2}\.\d{2}\.\d{4}\b")

        # Fall B: Report mit Treffern (RAPEX Alert)
        hit_report = AuditRunReport(
            results=[
                AuditResult(
                    item=AuditItem(gtin="1072105714", product_name="Flashing Shoes"),
                    found=True,
                    hits=[
                        AuditHit(
                            alert_number="A12/00001/26",
                            case_number="CAS-2026-0001",
                            publication_date="13.11.2026",
                            risk_type="Chemical",
                            risk_level="Serious",
                            danger_description="Phthalates exceed limit",
                            measures="Ban on the marketing of the product",
                            country_of_origin="China",
                            notifying_country="France",
                            source_url="https://ec.europa.eu/safety-gate-alerts/",
                        )
                    ],
                )
            ],
            data_date="13.11.2026",
            data_source="safety_gate_2026_45.xml",
        )

        draft_b = self.drafter.draft_response(
            lead=lead,
            report_data=hit_report,
            language="de",
            data_date="13.11.2026",
        )

        # Verifikation Fall B
        self.assertIn("Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026", draft_b.body)
        self.assertIn("13.11.2026", draft_b.body)
        self.assertIn("1072105714", draft_b.body)
        self.assertIn("Chemical", draft_b.body)

    # -----------------------------------------------------------------------
    # TEST 4: Human-in-the-Loop CLI Workflow
    # -----------------------------------------------------------------------

    def test_crm_cli_human_in_the_loop_workflow(self) -> None:
        """
        Verifiziert, dass Thomas den kompletten Workflow ueber die CLI steuern kann:
        status -> queue -> show -> approve -> send -> blacklist
        """
        # 1. Draft anlegen mit Status PENDING_REVIEW
        draft_dict = {
            "draft_id": "draft_cli_workflow_01",
            "lead_email": "kontakt@spielwaren-berlin.de",
            "company": "Spielwaren Berlin e.K.",
            "language": "de",
            "subject": "Re: Schnelltest Safety Gate",
            "body": (
                "Sehr geehrte Damen und Herren,\n\n"
                "hier ist Ihr Recherche-Bericht.\n"
                "Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026\n"
            ),
            "status": DraftStatus.PENDING_REVIEW,
            "in_reply_to": "<inbound-berlin-01@domain.de>",
            "references": "<outreach-berlin-01@thfc.de>",
        }
        self.queue.add_draft(draft_dict)

        # CLI: status
        args_status = argparse.Namespace()
        exit_code_status = cmd_status(args_status)
        self.assertEqual(exit_code_status, 0)

        # CLI: queue
        args_queue = argparse.Namespace(status="PENDING_REVIEW")
        exit_code_queue = cmd_queue(args_queue)
        self.assertEqual(exit_code_queue, 0)

        # CLI: show
        args_show = argparse.Namespace(id="draft_cli_workflow_01")
        exit_code_show = cmd_show(args_show)
        self.assertEqual(exit_code_show, 0)

        # CLI: approve durch Thomas
        args_approve = argparse.Namespace(
            id="draft_cli_workflow_01",
            reviewer="Thomas",
            note="Freigegeben fuer B2B-Kunden nach Durchsicht.",
        )
        exit_code_approve = cmd_approve(args_approve)
        self.assertEqual(exit_code_approve, 0)

        approved = self.queue.get_draft("draft_cli_workflow_01")
        self.assertIsNotNone(approved)
        self.assertEqual(approved["status"], DraftStatus.APPROVED)
        self.assertEqual(approved["reviewed_by"], "Thomas")

        # CLI: send (dry-run)
        args_send = argparse.Namespace(
            id="draft_cli_workflow_01",
            all=False,
            dry_run=True,
            provider="resend",
            limit=None,
            delay=0.0,
        )
        exit_code_send = cmd_send(args_send)
        self.assertEqual(exit_code_send, 0)

        # CLI: blacklist add, check, list
        args_bl_add = argparse.Namespace(
            blacklist_action="add",
            email="spam-lead@test-bad.com",
            reason="Manuelles Opt-Out via CLI",
        )
        self.assertEqual(cmd_blacklist(args_bl_add), 0)
        self.assertTrue(self.blacklist_mgr.is_blacklisted("spam-lead@test-bad.com"))

        args_bl_check = argparse.Namespace(
            blacklist_action="check",
            email="spam-lead@test-bad.com",
        )
        self.assertEqual(cmd_blacklist(args_bl_check), 0)

        args_bl_list = argparse.Namespace(blacklist_action="list")
        self.assertEqual(cmd_blacklist(args_bl_list), 0)


if __name__ == "__main__":
    unittest.main()
