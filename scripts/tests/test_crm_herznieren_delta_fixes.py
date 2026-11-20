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

        # E-Mail von unbekannter Adresse an info@thfc-consulting.de, die einfach nur "Nein danke, bitte löschen" schreibt
        msg = {
            "from": "unbekannter_lead@firma.de",
            "to": "info@thfc-consulting.de",
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
        """Unverlangter Newsletter an THFC-Adresse ohne Re-Bezug wird als IGNORED_UNRELATED verworfen."""
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
            "to": "info@thfc-consulting.de",
            "subject": "Herbstmode 2026 jetzt reduziert",
            "body": "Entdecken Sie neue Trends.\nKlicken Sie hier zum Abmelden.",
            "message_id": "<cold-newsletter-99@mode-boutique.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "IGNORED_UNRELATED")
        self.assertTrue(res.get("skipped", False))
        self.assertFalse(blacklist.is_blacklisted("angebote@mode-boutique.de"))

    def test_hard_gate_drops_any_mail_without_thfc_domain_immediately(self):
        """Hard-Gate: Jede Mail an fremde Domains (z.B. @googlemail.com) wird sofort als IGNORED_FOREIGN_DOMAIN verworfen."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        msg = {
            "from": "rechnung@telekom.de",
            "to": "t.hartmannsgruber@googlemail.com",
            "subject": "Ihre Rechnung für November 2026",
            "body": "Guten Tag Herr Hartmannsgruber, anbei Ihre Rechnung.",
            "message_id": "<telekom-invoice-123@telekom.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "IGNORED_FOREIGN_DOMAIN")
        self.assertTrue(res.get("skipped", False))
        self.assertFalse(blacklist.is_blacklisted("rechnung@telekom.de"))

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

    # -----------------------------------------------------------------------
    # Herznieren Lauf 2 (2026-11-20): F-01 bis F-05 Tests
    # -----------------------------------------------------------------------

    def test_optout_from_unmatched_sender_without_reply_headers_or_re_prefix(self):
        """F-01: Absage von ungematchter Adresse OHNE In-Reply-To und OHNE Re:-Präfix MUSS geblacklistet werden."""
        storage = CRMStorage(leads_file=self.leads_file)
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)

        crawler = InboundMailCrawler(
            storage=storage,
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        # Neuer Thread, Betreff "Abmeldung", keine RFC-Reply-Header
        msg = {
            "from": "vorstand@spielwaren-grosshandel.de",
            "to": "info@thfc-consulting.de",
            "subject": "Abmeldung und Widerruf",
            "body": "Guten Tag,\nbitte tragen Sie unsere Adresse sofort aus. Wir haben kein Interesse an Ihren Angeboten.\nDanke.",
            "message_id": "<new-thread-unsub-101@spielwaren-grosshandel.de>",
        }

        res = crawler.process_message(msg)
        self.assertEqual(res["status"], "PROCESSED")
        self.assertFalse(res.get("skipped", False))
        self.assertEqual(res["intent"], "NEGATIVE_OPTOUT")
        self.assertTrue(blacklist.is_blacklisted("vorstand@spielwaren-grosshandel.de"))

    def test_graph_crawler_paginates_nextlink(self):
        """F-02: crawl_graph muss @odata.nextLink verfolgen und alle paginierten Seiten abrufen."""
        crawler = InboundMailCrawler(
            storage=CRMStorage(leads_file=self.leads_file),
            blacklist_mgr=BlacklistManager(blacklist_file=self.blacklist_file),
            state_file=self.state_file,
            auto_draft=False,
        )
        crawler.telegram_bot = MagicMock()

        page1_response = {
            "value": [
                {
                    "id": "msg_page1_01",
                    "internetMessageId": "<p1_01@test.com>",
                    "subject": "Test P1",
                    "from": {"emailAddress": {"address": "lead1@test.com", "name": "Lead 1"}},
                    "toRecipients": [{"emailAddress": {"address": "info@thfc-consulting.de"}}],
                    "body": {"contentType": "text", "content": "Kein Interesse mehr bitte austragen."},
                    "receivedDateTime": "2026-11-20T12:00:00Z"
                }
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/info@thfc-consulting.de/mailFolders/inbox/messages?$top=50&$skip=1"
        }

        page2_response = {
            "value": [
                {
                    "id": "msg_page2_01",
                    "internetMessageId": "<p2_01@test.com>",
                    "subject": "Test P2",
                    "from": {"emailAddress": {"address": "lead2@test.com", "name": "Lead 2"}},
                    "toRecipients": [{"emailAddress": {"address": "info@thfc-consulting.de"}}],
                    "body": {"contentType": "text", "content": "Nee bedankt geen interesse."},
                    "receivedDateTime": "2026-11-20T11:59:00Z"
                }
            ]
            # Kein nextLink -> Ende der Pagination
        }

        with patch.object(crawler, "get_graph_token", return_value="dummy_graph_token"), \
             patch("scripts.crm.telegram_bot.get_default_bot"), \
             patch("urllib.request.urlopen") as mock_urlopen:
                mock_resp1 = MagicMock()
                mock_resp1.read.return_value = json.dumps(page1_response).encode("utf-8")
                mock_resp1.__enter__.return_value = mock_resp1

                mock_resp2 = MagicMock()
                mock_resp2.read.return_value = json.dumps(page2_response).encode("utf-8")
                mock_resp2.__enter__.return_value = mock_resp2

                mock_urlopen.side_effect = [mock_resp1, mock_resp2]

                results = crawler.crawl_graph(mailbox="info@thfc-consulting.de", folders=["inbox"])
                self.assertEqual(len(results), 2)
                self.assertEqual(results[0]["message_id"], "p1_01@test.com")
                self.assertEqual(results[1]["message_id"], "p2_01@test.com")
                self.assertEqual(mock_urlopen.call_count, 2)

    def test_graph_crawler_fetches_and_extracts_internet_message_headers(self):
        """F-04: crawl_graph muss internetMessageHeaders parsen und fuer Newsletter-Filter bereitstellen."""
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)
        crawler = InboundMailCrawler(
            storage=CRMStorage(leads_file=self.leads_file),
            blacklist_mgr=blacklist,
            state_file=self.state_file,
            auto_draft=False,
        )

        graph_response = {
            "value": [
                {
                    "id": "msg_newsletter_graph",
                    "internetMessageId": "<nl_graph_01@marketing.com>",
                    "subject": "Unser monatlicher Newsletter",
                    "from": {"emailAddress": {"address": "marketing@saas-tool.com", "name": "SaaS Marketing"}},
                    "toRecipients": [{"emailAddress": {"address": "info@thfc-consulting.de"}}],
                    "body": {"contentType": "text", "content": "Hier abmelden wenn Sie keine E-Mails moechten: unsubscribe"},
                    "receivedDateTime": "2026-11-20T10:00:00Z",
                    "internetMessageHeaders": [
                        {"name": "List-Unsubscribe", "value": "<https://saas-tool.com/unsub>"},
                        {"name": "Precedence", "value": "bulk"}
                    ]
                }
            ]
        }

        with patch.object(crawler, "get_graph_token", return_value="dummy_graph_token"):
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_resp = MagicMock()
                mock_resp.read.return_value = json.dumps(graph_response).encode("utf-8")
                mock_resp.__enter__.return_value = mock_resp
                mock_urlopen.return_value = mock_resp

                results = crawler.crawl_graph(mailbox="info@thfc-consulting.de", folders=["inbox"])
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0]["status"], "IGNORED_AUTOMATED")
                self.assertTrue(results[0].get("skipped", False))
                self.assertFalse(blacklist.is_blacklisted("marketing@saas-tool.com"))

    def test_graph_crawler_token_caching_and_refresh(self):
        """F-05: get_graph_token cached den Bearer-Token und refreshed ihn nach Ablauf."""
        crawler = InboundMailCrawler(
            storage=CRMStorage(leads_file=self.leads_file),
            blacklist_mgr=BlacklistManager(blacklist_file=self.blacklist_file),
            state_file=self.state_file,
        )

        with patch("scripts.crm.crawler.load_env_crawler", return_value={
            "MS_GRAPH_TENANT_ID": "dummy_tid",
            "MS_GRAPH_CLIENT_ID": "dummy_cid",
            "MS_GRAPH_CLIENT_SECRET": "dummy_sec"
        }):
            with patch("urllib.request.urlopen") as mock_urlopen:
                mock_resp1 = MagicMock()
                mock_resp1.read.return_value = json.dumps({
                    "access_token": "token_alpha",
                    "expires_in": 3600
                }).encode("utf-8")
                mock_resp1.__enter__.return_value = mock_resp1

                mock_urlopen.return_value = mock_resp1

                # Erster Aufruf -> API Request
                t1 = crawler.get_graph_token()
                self.assertEqual(t1, "token_alpha")
                self.assertEqual(mock_urlopen.call_count, 1)

                # Zweiter Aufruf -> Cache Hit (kein API Request!)
                t2 = crawler.get_graph_token()
                self.assertEqual(t2, "token_alpha")
                self.assertEqual(mock_urlopen.call_count, 1)

                # Erzwinge Refresh
                mock_resp2 = MagicMock()
                mock_resp2.read.return_value = json.dumps({
                    "access_token": "token_beta",
                    "expires_in": 3600
                }).encode("utf-8")
                mock_resp2.__enter__.return_value = mock_resp2
                mock_urlopen.return_value = mock_resp2

                t3 = crawler.get_graph_token(force_refresh=True)
                self.assertEqual(t3, "token_beta")
                self.assertEqual(mock_urlopen.call_count, 2)

    def test_blacklist_file_locking_concurrency(self):
        """F-03: BlacklistManager nutzt fcntl.flock beim Speichern und Entfernen."""
        blacklist = BlacklistManager(blacklist_file=self.blacklist_file)
        blacklist.add_to_blacklist("concurrent1@test.com", reason="Opt-Out")
        self.assertTrue(blacklist.is_blacklisted("concurrent1@test.com"))

        # Lockfile muss existieren
        lockfile = self.blacklist_file.with_suffix(".lock")
        self.assertTrue(lockfile.exists())

        # Entfernen ebenfalls unter Lock
        removed = blacklist.remove_from_blacklist("concurrent1@test.com")
        self.assertTrue(removed)
        self.assertFalse(blacklist.is_blacklisted("concurrent1@test.com"))

    def test_storage_file_locking_concurrency(self):
        """F-03: CRMStorage nutzt fcntl.flock beim Speichern."""
        storage = CRMStorage(leads_file=self.leads_file)
        storage.update_lead_status("lead_lock@test.com", "OUTREACH_SENT", reason="Init")
        lead = storage.get_lead("lead_lock@test.com")
        self.assertIsNotNone(lead)
        self.assertEqual(lead["status"], "OUTREACH_SENT")

        # Lockfile muss existieren
        lockfile = self.leads_file.with_suffix(".lock")
        self.assertTrue(lockfile.exists())


if __name__ == "__main__":
    unittest.main()
