"""
scripts/tests/test_crm_dispatcher_cli.py
Unit-Tests fuer Feature F05: CRM CLI & Threaded Email Dispatcher.

Akzeptanzkriterien:
1. CLI-Befehle status, queue, show <id>, approve <id>, reject <id> funktionieren fehlerfrei
2. Dispatcher versendet ausschliesslich Entwuerfe mit Status APPROVED
3. Mails enthalten korrekte Threading-Header (In-Reply-To und References zur urspruenglichen Outreach-Mail)
4. Versandversuch an blacklisted E-Mail wird mit Sicherheits-Abbruch blockiert
"""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
)
from scripts.crm.dispatcher import (
    DispatchResult,
    EmailDispatcher,
    UnapprovedDraftError,
    format_message_id_header,
    format_references_header,
)
from scripts.crm.review_queue import (
    DraftNotFoundError,
    DraftStatus,
    ReviewQueue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
)
from scripts.crm_cli import (
    build_parser,
    cmd_approve,
    cmd_blacklist,
    cmd_queue,
    cmd_reject,
    cmd_send,
    cmd_show,
    cmd_status,
)


class TestCRMDispatcherAndCLI(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)
        self.queue_file = self.temp_path / "review_queue.json"
        self.blacklist_file = self.temp_path / "blacklist.json"
        self.leads_file = self.temp_path / "leads_db.json"

        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.queue = ReviewQueue(
            queue_file=self.queue_file,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.storage = CRMStorage(
            leads_file=self.leads_file,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.dispatcher = EmailDispatcher(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
            storage=self.storage,
            provider="resend",
            dry_run=True,
            resend_api_key="re_mock_test_key_123",
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # Kriterium 1: CLI-Befehle status, queue, show, approve, reject
    # -----------------------------------------------------------------------

    def test_criterion_1_cli_commands(self):
        """Prueft status, queue, show <id>, approve <id>, reject <id>."""
        parser = build_parser()

        # 1. Draft einreihen
        draft_dict = {
            "draft_id": "draft_test_cli_01",
            "lead_email": "max@spielwaren-test.de",
            "company": "Spielwaren Test GmbH",
            "language": "de",
            "subject": "Produktsicherheit & EU Safety Gate",
            "body": "Guten Tag Herr Test, hier ist Ihr Analyse-Report...",
            "status": DraftStatus.PENDING_REVIEW,
            "in_reply_to": "<outreach-123@thfc.de>",
            "references": "<outreach-123@thfc.de>",
        }
        self.queue.add_draft(draft_dict)

        # Patchen der Singletons im CLI-Modul
        with patch("scripts.crm_cli.get_default_queue", return_value=self.queue), \
             patch("scripts.crm_cli.get_default_storage", return_value=self.storage), \
             patch("scripts.crm_cli.get_default_manager", return_value=self.blacklist_mgr), \
             patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:

            # Befehl 1: status
            args_status = parser.parse_args(["status"])
            exit_code = cmd_status(args_status)
            self.assertEqual(exit_code, 0)
            status_output = mock_stdout.getvalue()
            self.assertIn("PRODUCT SAFETY ENGINE - CRM DASHBOARD", status_output)
            self.assertIn("PENDING_REVIEW", status_output)

            # Befehl 2: queue
            args_queue = parser.parse_args(["queue"])
            exit_code = cmd_queue(args_queue)
            self.assertEqual(exit_code, 0)
            queue_output = mock_stdout.getvalue()
            self.assertIn("draft_test_cli_01", queue_output)
            self.assertIn("max@spielwaren-test.de", queue_output)

            # Befehl 3: show <id>
            args_show = parser.parse_args(["show", "draft_test_cli_01"])
            exit_code = cmd_show(args_show)
            self.assertEqual(exit_code, 0)
            show_output = mock_stdout.getvalue()
            self.assertIn("DRAFT DETAILS: draft_test_cli_01", show_output)
            self.assertIn("In-Reply-To:   <outreach-123@thfc.de>", show_output)
            self.assertIn("Guten Tag Herr Test", show_output)

            # Befehl 4: approve <id>
            args_approve = parser.parse_args(["approve", "draft_test_cli_01", "--note", "Freigabe erteilt"])
            exit_code = cmd_approve(args_approve)
            self.assertEqual(exit_code, 0)
            updated_draft = self.queue.get_draft("draft_test_cli_01")
            self.assertEqual(updated_draft["status"], DraftStatus.APPROVED)
            self.assertEqual(updated_draft["reviewed_by"], "Thomas")
            self.assertEqual(updated_draft["approval_note"], "Freigabe erteilt")

            # Befehl 5: reject <id>
            # Uebergang von APPROVED zu REJECTED
            args_reject = parser.parse_args(["reject", "draft_test_cli_01", "--reason", "Doch nicht relevant"])
            exit_code = cmd_reject(args_reject)
            self.assertEqual(exit_code, 0)
            rejected_draft = self.queue.get_draft("draft_test_cli_01")
            self.assertEqual(rejected_draft["status"], DraftStatus.REJECTED)
            self.assertEqual(rejected_draft["rejection_reason"], "Doch nicht relevant")

    # -----------------------------------------------------------------------
    # Kriterium 2: Dispatcher versendet ausschliesslich Status APPROVED
    # -----------------------------------------------------------------------

    def test_criterion_2_dispatch_strictly_only_approved_drafts(self):
        """Dispatcher verweigert PENDING_REVIEW, REJECTED und SENT zwingend."""
        # 1. Draft mit PENDING_REVIEW
        pending_draft = {
            "draft_id": "draft_pending_01",
            "lead_email": "pending@example.com",
            "subject": "Pending Draft",
            "body": "Body text",
            "status": DraftStatus.PENDING_REVIEW,
        }
        self.queue.add_draft(pending_draft)

        # Versuch PENDING_REVIEW zu versenden -> UnapprovedDraftError
        with self.assertRaises(UnapprovedDraftError):
            self.dispatcher.dispatch_draft("draft_pending_01")

        # 2. Draft mit REJECTED
        rejected_draft = {
            "draft_id": "draft_rejected_01",
            "lead_email": "rejected@example.com",
            "subject": "Rejected Draft",
            "body": "Body text",
            "status": DraftStatus.PENDING_REVIEW,
        }
        self.queue.add_draft(rejected_draft)
        self.queue.reject("draft_rejected_01", reason="Manuell abgelehnt")

        # Versuch REJECTED zu versenden -> UnapprovedDraftError
        with self.assertRaises(UnapprovedDraftError):
            self.dispatcher.dispatch_draft("draft_rejected_01")

        # 3. Draft mit APPROVED darf versendet werden
        approved_draft = {
            "draft_id": "draft_approved_01",
            "lead_email": "approved@example.com",
            "subject": "Approved Draft",
            "body": "Body text",
            "status": DraftStatus.PENDING_REVIEW,
        }
        self.queue.add_draft(approved_draft)
        self.queue.approve("draft_approved_01", reviewer="Thomas")

        # Dry-run Dispatch muss gelingen
        result = self.dispatcher.dispatch_draft("draft_approved_01", dry_run=True)
        self.assertEqual(result.status, "DRY_RUN")
        self.assertEqual(result.recipient, "approved@example.com")

        # 4. Batch Dispatch: Selektiert ausschliesslich APPROVED
        all_results = self.dispatcher.dispatch_all_approved(dry_run=True)
        # Es sollte genau 1 Entwurf (draft_approved_01) verarbeitet werden
        self.assertEqual(len(all_results), 1)
        self.assertEqual(all_results[0].draft_id, "draft_approved_01")

    # -----------------------------------------------------------------------
    # Kriterium 3: Korrekte Threading-Header (In-Reply-To, References)
    # -----------------------------------------------------------------------

    def test_criterion_3_threaded_email_headers(self):
        """Prueft, dass In-Reply-To und References fuer Resend und MIME korrekt gesetzt werden."""
        # Test Format-Hilfsfunktionen
        self.assertEqual(format_message_id_header("msg-123@domain.com"), "<msg-123@domain.com>")
        self.assertEqual(format_message_id_header("<already-bracketed@domain.com>"), "<already-bracketed@domain.com>")

        refs = format_references_header("<outreach-1@domain.com>", "<inbound-2@domain.com>")
        self.assertEqual(refs, "<outreach-1@domain.com> <inbound-2@domain.com>")

        draft_dict = {
            "draft_id": "draft_threaded_01",
            "lead_email": "kunde@spielwaren-nord.de",
            "subject": "Re: Rueckfrage Produktsicherheits-Check",
            "body": "Sehr geehrte Damen und Herren...",
            "status": DraftStatus.APPROVED,
            "in_reply_to": "<inbound-reply-999@kunde.de>",
            "references": "<initial-outreach-111@thfc-consulting.de>",
        }
        self.queue.add_draft(draft_dict)

        headers = self.dispatcher.build_threading_headers(draft_dict)
        self.assertEqual(headers["In-Reply-To"], "<inbound-reply-999@kunde.de>")
        self.assertIn("<initial-outreach-111@thfc-consulting.de>", headers["References"])
        self.assertIn("<inbound-reply-999@kunde.de>", headers["References"])

        # MIME Message Headers pruefen
        mime_msg = self.dispatcher.create_mime_message(
            to_email="kunde@spielwaren-nord.de",
            subject="Re: Rueckfrage Produktsicherheits-Check",
            body="Test body",
            headers=headers,
        )
        self.assertEqual(mime_msg["In-Reply-To"], "<inbound-reply-999@kunde.de>")
        self.assertIn("<initial-outreach-111@thfc-consulting.de>", mime_msg["References"])

        # Resend API Payload Mock-Pruefung
        with patch("urllib.request.urlopen") as mock_urlopen:
            mock_resp = MagicMock()
            mock_resp.read.return_value = json.dumps({"id": "resend_msg_test_888"}).encode("utf-8")
            mock_urlopen.return_value.__enter__.return_value = mock_resp

            disp_live = EmailDispatcher(
                queue=self.queue,
                blacklist_mgr=self.blacklist_mgr,
                storage=self.storage,
                provider="resend",
                dry_run=False,
                resend_api_key="re_valid_dummy_key",
            )
            res = disp_live.dispatch_draft("draft_threaded_01")
            self.assertEqual(res.status, "SENT")
            self.assertEqual(res.message_id, "resend_msg_test_888")

            # Pruefen, was per HTTP geschickt wurde
            call_args = mock_urlopen.call_args
            req = call_args[0][0]
            sent_payload = json.loads(req.data.decode("utf-8"))
            self.assertIn("headers", sent_payload)
            self.assertEqual(sent_payload["headers"]["In-Reply-To"], "<inbound-reply-999@kunde.de>")
            self.assertIn("<initial-outreach-111@thfc-consulting.de>", sent_payload["headers"]["References"])

            # Entwurf muss jetzt den Status SENT haben
            final_draft = self.queue.get_draft("draft_threaded_01")
            self.assertEqual(final_draft["status"], DraftStatus.SENT)

    # -----------------------------------------------------------------------
    # Kriterium 4: Blacklist Hard-Gate Sicherheits-Abbruch
    # -----------------------------------------------------------------------

    def test_criterion_4_blacklist_hard_gate_security_block(self):
        """Versand an geblacklistete Adresse fuehrt zwingend zu Sicherheits-Abbruch."""
        blacklisted_email = "optout@blacklisted-domain.com"
        self.blacklist_mgr.add_to_blacklist(
            email=blacklisted_email,
            reason="Kunde wuenscht keine weiteren Nachrichten",
        )

        # Entwurf fuer diese Adresse vorbereiten und fiktiv auf APPROVED setzen
        draft_dict = {
            "draft_id": "draft_blacklisted_test",
            "lead_email": blacklisted_email,
            "subject": "Ungewollter Kontaktversuch",
            "body": "Diese Mail darf niemals rausgehen!",
            "status": DraftStatus.APPROVED,
        }
        self.queue.add_draft(draft_dict, check_blacklist=False)

        # 1. Direkter Aufruf am Dispatcher MUSS BlacklistedRecipientError werfen
        with self.assertRaises(BlacklistedRecipientError) as ctx:
            self.dispatcher.dispatch_draft("draft_blacklisted_test")

        self.assertIn("optout@blacklisted-domain.com", str(ctx.exception))
        self.assertIn("permanent opt-out blacklist", str(ctx.exception))

        # 2. Batch-Dispatcher faengt den Versuch ab und markiert ihn als BLOCKED_BLACKLIST
        results = self.dispatcher.dispatch_all_approved(dry_run=False)
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0].status, "BLOCKED_BLACKLIST")
        self.assertEqual(results[0].draft_id, "draft_blacklisted_test")

        # 3. CLI send mit geblacklisteter ID muss mit Sicherheits-Abbruch fehlschlagen
        parser = build_parser()
        with patch("scripts.crm_cli.get_default_queue", return_value=self.queue), \
             patch("scripts.crm_cli.get_default_manager", return_value=self.blacklist_mgr), \
             patch("sys.stdout", new_callable=io.StringIO) as mock_stdout:

            args_send = parser.parse_args(["send", "--id", "draft_blacklisted_test"])
            exit_code = cmd_send(args_send)
            self.assertEqual(exit_code, 1)
            cli_out = mock_stdout.getvalue()
            self.assertIn("SECURITY BLOCKED", cli_out)


if __name__ == "__main__":
    unittest.main()
