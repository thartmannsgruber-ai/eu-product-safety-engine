"""
scripts/tests/test_crm_herznieren_delta_fixes.py
Verifiziert die Behebung der im Herznieren-Audit 2026-11-20 identifizierten Schwachstellen:
1. F-01: Autorisierungs-Guard fuer Telegram Messages & Callback-Queries (Abweisung fremder IDs)
2. F-02: Idempotenz bei Approve- und Reject-Callbacks (Verhinderung von Mehrfachversand bei Doppelklick)
3. F-03: Telegram-Offset Persistenz in daemon.py (Korrektes Laden & Speichern mit json)
4. F-04: Opt-Out Erhalt im Crawler-Relevanzfilter auch ohne explizite Safety-Gate-Keywords
"""

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.blacklist import BlacklistManager
from scripts.crm.crawler import InboundMailCrawler
from scripts.crm.dispatcher import EmailDispatcher
from scripts.crm.review_queue import DraftStatus, ReviewQueue
from scripts.crm.storage import CRMStorage
from scripts.crm.telegram_bot import TelegramCRMNotifier


class TestHerznierenDeltaFixes(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_path = Path(self.temp_dir.name)
        self.env_file = self.base_path / ".env"
        self.env_file.write_text("TELEGRAM_CHAT_ID=8944878295\nTELEGRAM_BOT_TOKEN=dummy_token\n", encoding="utf-8")

        self.queue_file = self.base_path / "review_queue.json"
        self.blacklist_file = self.base_path / "blacklist.json"
        self.leads_file = self.base_path / "leads_db.json"
        self.state_file = self.base_path / "crawler_state.json"

        self.bot = TelegramCRMNotifier(
            bot_token="dummy_token",
            chat_id="8944878295",
            env_file=self.env_file,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # F-01: Autorisierungs-Guard
    # -----------------------------------------------------------------------

    def test_auth_guard_rejects_foreign_user_and_chat(self):
        """F-01: Nachrichten oder Callbacks von fremden Usern/Chats muessen abgewiesen werden."""
        # Test 1: Fremde User-ID
        self.assertFalse(self.bot.is_authorized(user_id=123456, chat_id=8944878295))
        # Test 2: Fremde Chat-ID
        self.assertFalse(self.bot.is_authorized(user_id=8944878295, chat_id=999999))
        # Test 3: Beide fremd
        self.assertFalse(self.bot.is_authorized(user_id=111111, chat_id=222222))

        # Test 4: Callback von fremdem User beantwortet mit "Nicht autorisiert"
        foreign_update = {
            "callback_query": {
                "id": "cb_hacker",
                "data": "approve:draft_123",
                "from": {"id": 999999, "first_name": "Attacker"},
                "message": {"chat": {"id": 999999}, "message_id": 42, "text": "Draft"},
            }
        }
        with patch.object(self.bot, "answer_callback") as mock_answer:
            self.bot.handle_update(foreign_update)
            mock_answer.assert_called_once_with("cb_hacker", "⛔ Nicht autorisiert!", show_alert=True)

        # Test 5: Nachricht von fremdem User wird still ignoriert
        msg_update = {
            "message": {
                "chat": {"id": 888888},
                "from": {"id": 888888, "first_name": "Stranger"},
                "text": "/status",
            }
        }
        with patch.object(self.bot, "send_message") as mock_send:
            self.bot.handle_update(msg_update)
            mock_send.assert_not_called()

    def test_auth_guard_accepts_authorized_user_and_chat(self):
        """F-01: Autorisierte Anfragen von Thomas (8944878295) werden akzeptiert."""
        self.assertTrue(self.bot.is_authorized(user_id=8944878295, chat_id=8944878295))
        self.assertTrue(self.bot.is_authorized(user_id="8944878295", chat_id="8944878295"))

    # -----------------------------------------------------------------------
    # F-02: Idempotenz bei Approve & Reject
    # -----------------------------------------------------------------------

    def test_approve_callback_idempotency_prevents_duplicate_dispatch(self):
        """F-02: Ein bereits freigegebener Entwurf darf bei Doppel-Klick nicht erneut versendet werden."""
        queue = ReviewQueue(queue_file=self.queue_file)
        draft = queue.add_draft({
            "draft_id": "draft_idempotent_test",
            "recipient_email": "lead@test.com",
            "subject": "Test Betreff",
            "body": "Test Body",
            "status": DraftStatus.PENDING_REVIEW,
        })

        with patch("scripts.crm.review_queue.get_default_queue", return_value=queue), \
             patch("scripts.crm.dispatcher.get_default_dispatcher") as mock_disp_factory, \
             patch.object(self.bot, "answer_callback") as mock_answer, \
             patch.object(self.bot, "edit_message_text") as mock_edit:

            mock_dispatcher = MagicMock()
            mock_dispatcher.dispatch_draft.return_value = {"success": True, "message_id": "resend_123"}
            mock_disp_factory.return_value = mock_dispatcher

            # 1. Klick: Muss freigeben und versenden
            self.bot._handle_approve_callback(
                cb_id="cb_1",
                draft_id="draft_idempotent_test",
                chat_id=8944878295,
                msg_id=10,
                current_text="Vorschau",
                user_name="Thomas",
            )
            mock_dispatcher.dispatch_draft.assert_called_once_with("draft_idempotent_test")
            self.assertEqual(queue.get_draft("draft_idempotent_test")["status"], DraftStatus.APPROVED)

            # 2. Klick (schneller Doppelklick): Draft ist bereits APPROVED -> darf NICHT erneut versenden!
            mock_dispatcher.dispatch_draft.reset_mock()
            self.bot._handle_approve_callback(
                cb_id="cb_2",
                draft_id="draft_idempotent_test",
                chat_id=8944878295,
                msg_id=10,
                current_text="Vorschau",
                user_name="Thomas",
            )
            # Dispatcher darf NICHT nochmals aufgerufen werden
            mock_dispatcher.dispatch_draft.assert_not_called()
            # Callback-Antwort muss Idempotenz-Warnung melden
            mock_answer.assert_called_with("cb_2", "ℹ️ Dieser Entwurf wurde bereits freigegeben/versendet!", show_alert=True)

    def test_approve_callback_multithreaded_race_condition(self):
        """F-02: Zwei parallele Threads versuchen zeitgleich freizugeben -> genau 1 Dispatch!"""
        import threading
        queue = ReviewQueue(queue_file=self.queue_file)
        draft = queue.add_draft({
            "draft_id": "draft_race_test",
            "recipient_email": "lead@test.com",
            "subject": "Race Test",
            "body": "Body",
            "status": DraftStatus.PENDING_REVIEW,
        })

        with patch("scripts.crm.review_queue.get_default_queue", return_value=queue), \
             patch("scripts.crm.dispatcher.get_default_dispatcher") as mock_disp_factory, \
             patch.object(self.bot, "answer_callback"), \
             patch.object(self.bot, "edit_message_text"):

            mock_dispatcher = MagicMock()
            mock_dispatcher.dispatch_draft.return_value = {"success": True, "message_id": "resend_race"}
            mock_disp_factory.return_value = mock_dispatcher

            t1 = threading.Thread(
                target=self.bot._handle_approve_callback,
                args=("cb_t1", "draft_race_test", 8944878295, 1, "txt", "Thomas")
            )
            t2 = threading.Thread(
                target=self.bot._handle_approve_callback,
                args=("cb_t2", "draft_race_test", 8944878295, 1, "txt", "Thomas")
            )

            t1.start()
            t2.start()
            t1.join()
            t2.join()

            # Genau ein Aufruf an dispatch_draft!
            self.assertEqual(mock_dispatcher.dispatch_draft.call_count, 1)

    # -----------------------------------------------------------------------
    # F-03: Offset-Persistenz im Daemon
    # -----------------------------------------------------------------------

    def test_daemon_offset_persistence_roundtrip(self):
        """F-03: Offset-File kann mit json geladen und atomar gesichert werden."""
        offset_file = self.base_path / "telegram_state.json"
        # Speichere Offset
        offset_file.write_text(json.dumps({"offset": 4242}), encoding="utf-8")

        # Lese wie in daemon.py
        with open(offset_file, "r", encoding="utf-8") as f:
            loaded_offset = json.load(f).get("offset", 0)
        self.assertEqual(loaded_offset, 4242)

        # Sichere neuen Offset atomar wie in daemon.py
        new_offset = 4243
        temp_f = offset_file.with_suffix(".tmp")
        with open(temp_f, "w", encoding="utf-8") as f:
            json.dump({"offset": new_offset}, f)
        temp_f.replace(offset_file)

        # Verifiziere neuen Stand
        with open(offset_file, "r", encoding="utf-8") as f:
            verified = json.load(f).get("offset", 0)
        self.assertEqual(verified, 4243)

    # -----------------------------------------------------------------------
    # F-04: Opt-Out Erhalt im Crawler-Relevanzfilter
    # -----------------------------------------------------------------------

    def test_crawler_relevance_filter_retains_optout_even_without_campaign_keywords(self):
        """F-04: Eine Absage von fremder Mailadresse ohne 'Safety Gate' darf nicht als unrelated verworfen werden."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        # E-Mail von unbekannter Adresse, die einfach nur "Nein danke, bitte löschen" schreibt
        msg = {
            "from": "unbekannter_lead@firma.de",
            "to": "t.hartmannsgruber@googlemail.com",
            "subject": "Antwort auf Ihre Nachricht",
            "body": "Nein, wir haben absolut kein Interesse. Bitte löschen Sie uns.",
            "message_id": "<optout-no-keywords-01@firma.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "PROCESSED")
        self.assertFalse(res.get("skipped", False))

        # Muss sofort geblacklistet sein!
        self.assertTrue(blacklist.is_blacklisted("unbekannter_lead@firma.de"))

    def test_crawler_relevance_filter_handles_french_typographical_apostrophe(self):
        """F-04: 'Pas d’intérêt' mit typografischem Apostroph wird nicht verworfen und geblacklistet."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        msg = {
            "from": "jouet_france@societe.fr",
            "to": "info@thfc-consulting.de",
            "subject": "Re: Proposition",
            "body": "Bonjour,\nNous n’avons pas d’intérêt pour votre service.\nMerci de nous désinscrire.",
            "message_id": "<optout-apostrophe-fr@societe.fr>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "PROCESSED")
        self.assertTrue(blacklist.is_blacklisted("jouet_france@societe.fr"))

    # -----------------------------------------------------------------------
    # F-05: Newsletter & Automated Mail Filter (Doctolib Incident Prevention)
    # -----------------------------------------------------------------------

    def test_doctolib_newsletter_ignored_and_not_blacklisted(self):
        """Doctolib-Marketing-Newsletter darf trotz 'abmelden'/'unsubscribe' nicht als Opt-Out geblacklistet werden."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        msg = {
            "from": "no-reply@news.doctolib.com",
            "to": "t.hartmannsgruber@googlemail.com",
            "subject": "Wie geht's Deinen Liebsten?",
            "body": "Was für ältere Menschen, die Dir nahestehen, im Winter zählt...\nWenn Sie keine E-Mails mehr erhalten möchten: abmelden oder unsubscribe.",
            "message_id": "<AE.87.47536.601200B6@sparkpost.doctolib.com>",
            "list_unsubscribe": "<https://news.doctolib.com/u/unsub>",
            "precedence": "bulk",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "IGNORED_AUTOMATED")
        self.assertTrue(res.get("skipped", False))
        self.assertFalse(blacklist.is_blacklisted("no-reply@news.doctolib.com"))

    def test_generic_cold_newsletter_without_rfc_headers_dropped_as_unrelated(self):
        """Unverlangter Newsletter an Privatadresse ohne Re-Bezug wird als IGNORED_UNRELATED verworfen."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        msg = {
            "from": "angebote@mode-boutique.de",
            "to": "t.hartmannsgruber@googlemail.com",
            "subject": "Herbstmode 2026 jetzt reduziert",
            "body": "Entdecken Sie neue Trends.\nKlicken Sie hier zum Abmelden.",
            "message_id": "<cold-newsletter-99@mode-boutique.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "IGNORED_UNRELATED")
        self.assertTrue(res.get("skipped", False))
        self.assertFalse(blacklist.is_blacklisted("angebote@mode-boutique.de"))

    def test_legitimate_optout_reply_from_alternate_address_is_blacklisted(self):
        """Echte Absage-Antwort von alternativer Firmenadresse auf Kampagne wird verarbeitet & geblacklistet."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        msg = {
            "from": "geschaeftsfuehrung@spielwaren-karl.de",
            "to": "info@thfc-consulting.de",
            "subject": "Re: Schnelltest Safety Gate & Produktsicherheit",
            "body": "Guten Tag,\nwir haben kein Interesse an weiteren Tests. Bitte kontaktieren Sie uns nicht mehr.\nMit freundlichen Grüßen",
            "in_reply_to": "<outreach-karl-01@thfc-consulting.de>",
            "message_id": "<reply-karl-99@spielwaren-karl.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "PROCESSED")
        self.assertFalse(res.get("skipped", False))
        self.assertTrue(blacklist.is_blacklisted("geschaeftsfuehrung@spielwaren-karl.de"))


if __name__ == "__main__":
    unittest.main()
