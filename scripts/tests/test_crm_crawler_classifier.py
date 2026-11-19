"""
scripts/tests/test_crm_crawler_classifier.py
Unit-Tests fuer Feature F02: Inbound Mail Crawler & Multilingual Intent Classifier.

Akzeptanzkriterien:
1. Negative Antworten in FR, NL, DE, EN werden zuverlaessig als NEGATIVE_OPTOUT klassifiziert und fuehren zum Blacklist-Eintrag
2. Antworten mit Test-Wunsch oder EAN-Nennung werden als POSITIVE_TEST_REQUEST klassifiziert
3. Crawler matcht Antworten ueber Sender-E-Mail, In-Reply-To Header oder Betreff mit dem versendeten Lead
4. Verarbeitete Nachrichten werden dedupliziert und markiert
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    can_contact,
    is_blacklisted,
)
from scripts.crm.classifier import (
    ClassificationResult,
    Intent,
    classify_intent,
    extract_eans,
    strip_quoted_reply,
)
from scripts.crm.crawler import (
    InboundMailCrawler,
    clean_subject_prefix,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
)


class TestCRMCrawlerAndClassifier(unittest.TestCase):
    def setUp(self):
        # Isoliertes temporaeres Test-Verzeichnis
        self.temp_dir = tempfile.TemporaryDirectory()
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"
        self.leads_file = Path(self.temp_dir.name) / "leads_db.json"
        self.state_file = Path(self.temp_dir.name) / "crawler_state.json"

        # Eigene Manager-Instanzen instanziieren
        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(
            leads_file=self.leads_file,
            blacklist_mgr=self.blacklist_mgr
        )
        self.crawler = InboundMailCrawler(
            storage=self.storage,
            blacklist_mgr=self.blacklist_mgr,
            state_file=self.state_file
        )

        # Einen Test-Lead anlegen
        self.test_lead_email = "directeur@jouets-lyon.fr"
        self.test_resend_id = "01a1f58d-9847-7735-b510-fb9aac1ae485"
        self.test_subject = "Vérification Safety Gate pour Jouets Lyon ?"
        self.test_company = "Jouets Lyon SAS"

        self.storage.update_lead_status(
            self.test_lead_email,
            LeadStatus.OUTREACH_SENT,
            reason="Initial outreach",
            snippet="Initial outreach sent"
        )
        lead = self.storage.get_lead(self.test_lead_email)
        lead["resend_id"] = self.test_resend_id
        lead["company"] = self.test_company
        lead["subject"] = self.test_subject
        self.storage.save()

    def tearDown(self):
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # Kriterium 1: Negative Antworten in FR, NL, DE, EN & Blacklist-Eintrag
    # -----------------------------------------------------------------------

    def test_criterion_1_multilingual_negative_optout_classification(self):
        """Kriterium 1: Negative Antworten in FR, NL, DE, EN werden als NEGATIVE_OPTOUT klassifiziert."""
        negative_cases = [
            # Franzoesisch
            ("Non, merci.", "Re: Safety Gate", "fr"),
            ("Pas intéressé par votre démarche.", "Re: Safety Gate", "fr"),
            ("Merci de ne plus me contacter et de supprimer mon adresse.", "Re: Safety Gate", "fr"),
            ("Désinscription immédiate svp.", "Re: Safety Gate", "fr"),
            ("Non merci, nous ne souhaitons pas tester.", "Re: Safety Gate", "fr"),
            # Niederlaendisch
            ("Nee, dank u.", "Re: Productveiligheid", "nl"),
            ("Geen interesse in deze dienst.", "Re: Productveiligheid", "nl"),
            ("Gelieve ons uit te schrijven en niet meer te contacteren.", "Re: Productveiligheid", "nl"),
            ("Wij hebben hier geen behoefte aan. Afmelden aub.", "Re: Productveiligheid", "nl"),
            # Deutsch
            ("Nein danke.", "Re: Produktsicherheit", "de"),
            ("Wir haben kein Interesse.", "Re: Produktsicherheit", "de"),
            ("Bitte löschen Sie unsere E-Mail-Adresse aus Ihrem Verteiler.", "Re: Produktsicherheit", "de"),
            ("Kein Bedarf, bitte kontakt unterlassen.", "Re: Produktsicherheit", "de"),
            # Englisch
            ("No, thank you.", "Re: Product Safety", "en"),
            ("Not interested.", "Re: Product Safety", "en"),
            ("Please unsubscribe our address immediately.", "Re: Product Safety", "en"),
            ("Do not contact us again.", "Re: Product Safety", "en"),
        ]

        for body, subj, expected_lang in negative_cases:
            res = classify_intent(body, subj)
            self.assertEqual(
                res.intent,
                Intent.NEGATIVE_OPTOUT,
                f"Failed for text '{body}': got {res.intent} instead of NEGATIVE_OPTOUT"
            )
            self.assertGreaterEqual(res.confidence, 0.90)
            self.assertTrue(len(res.matched_patterns) > 0)

    def test_criterion_1_negative_optout_leads_to_blacklist_entry(self):
        """Kriterium 1: Negative Antwort fuehrt zwingend zum Blacklist-Eintrag und LOST_BLACKLISTED Lead-Status."""
        raw_msg = {
            "message_id": "<msg-negative-fr-001@jouets-lyon.fr>",
            "from": f"{self.test_company} <{self.test_lead_email}>",
            "subject": f"Re: {self.test_subject}",
            "body": "Bonjour,\nNon, merci, nous ne sommes pas intéressés par votre démarche.\nCordialement",
            "date": "2026-11-19T21:00:00Z"
        }

        # Vor dem Crawlen: Adresse nicht blacklisted
        self.assertFalse(self.blacklist_mgr.is_blacklisted(self.test_lead_email))
        self.assertTrue(self.storage.can_contact(self.test_lead_email))

        result = self.crawler.process_message(raw_msg)

        # 1. Ergebnis pruefen
        self.assertEqual(result["status"], "PROCESSED")
        self.assertEqual(result["intent"], Intent.NEGATIVE_OPTOUT)
        self.assertEqual(result["lead_email"], self.test_lead_email)

        # 2. Blacklist-Eintrag verifizieren (Goldene Regel)
        self.assertTrue(self.blacklist_mgr.is_blacklisted(self.test_lead_email))
        self.assertFalse(self.storage.can_contact(self.test_lead_email))

        # 3. Lead-Status in CRM pruefen
        lead = self.storage.get_lead(self.test_lead_email)
        self.assertEqual(lead["status"], LeadStatus.LOST_BLACKLISTED)

        # 4. Kontaktversuch wirft BlacklistedRecipientError
        with self.assertRaises(BlacklistedRecipientError):
            self.storage.record_contact_attempt(self.test_lead_email, subject="Follow-up attempt")

    # -----------------------------------------------------------------------
    # Kriterium 2: Antworten mit Test-Wunsch oder EAN-Nennung -> POSITIVE_TEST_REQUEST
    # -----------------------------------------------------------------------

    def test_criterion_2_positive_test_request_classification(self):
        """Kriterium 2: Antworten mit Test-Wunsch oder EAN-Nennung werden als POSITIVE_TEST_REQUEST klassifiziert."""
        positive_cases = [
            # Mit EANs
            ("Bonjour, oui nous aimerions tester 50 articles. Voici les codes EAN: 4006381333931, 3147730001234", "Re: Safety Gate", True),
            ("Hierbij onze artikelen ter controle: 8710103854340", "Re: Productveiligheid", True),
            ("Guten Tag, bitte testen Sie diesen Artikel: 4006381333931", "Re: Produktsicherheit", True),
            ("Hello, please run a safety check on EAN 0123456789012", "Re: Audit", True),
            # Ohne EANs, aber mit explizitem Test-Wunsch
            ("Oui volontiers, nous aimerions faire vérifier 50 articles de notre catalogue.", "Re: Safety Gate", False),
            ("Ja graag, we willen graag die gratis test van 50 artikelen doen.", "Re: Productveiligheid", False),
            ("Ja sehr gerne, wir nehmen das Angebot des kostenlosen 50-Artikel-Tests an.", "Re: Produktsicherheit", False),
            ("Yes sure, sounds good. How do we submit our 50 products for testing?", "Re: Product Safety", False),
        ]

        for body, subj, has_eans in positive_cases:
            res = classify_intent(body, subj)
            self.assertEqual(
                res.intent,
                Intent.POSITIVE_TEST_REQUEST,
                f"Failed for text '{body}': got {res.intent} instead of POSITIVE_TEST_REQUEST"
            )
            self.assertGreaterEqual(res.confidence, 0.85)
            if has_eans:
                self.assertGreater(len(res.eans_detected), 0)

    def test_criterion_2_positive_updates_lead_status(self):
        """Kriterium 2: Positiver Test-Request aktualisiert den Lead-Status auf REPLIED_POSITIVE."""
        raw_msg = {
            "message_id": "<msg-positive-fr-002@jouets-lyon.fr>",
            "from": f"{self.test_company} <{self.test_lead_email}>",
            "subject": f"Re: {self.test_subject}",
            "body": "Bonjour Thomas,\nOui volontiers ! Voici 2 codes EAN pour le test gratuit :\n3147730001234\n3147730005678\nMerci.",
            "date": "2026-11-19T21:05:00Z"
        }

        result = self.crawler.process_message(raw_msg)
        self.assertEqual(result["status"], "PROCESSED")
        self.assertEqual(result["intent"], Intent.POSITIVE_TEST_REQUEST)

        lead = self.storage.get_lead(self.test_lead_email)
        self.assertEqual(lead["status"], LeadStatus.REPLIED_POSITIVE)
        # Kontakthistorie muss den Inbound-Event enthalten
        history = lead.get("history", [])
        inbound_events = [e for e in history if e.get("action") == "INBOUND_REPLY"]
        self.assertEqual(len(inbound_events), 1)
        self.assertEqual(inbound_events[0]["intent"], Intent.POSITIVE_TEST_REQUEST)
        self.assertIn("3147730001234", inbound_events[0]["eans_detected"])

    # -----------------------------------------------------------------------
    # Kriterium 3: Lead-Matching ueber Sender, In-Reply-To oder Betreff
    # -----------------------------------------------------------------------

    def test_criterion_3_matching_via_sender_email(self):
        """Kriterium 3: Matcht Antwort ueber Sender-E-Mail."""
        raw_msg = {
            "message_id": "<msg-sender-match@jouets-lyon.fr>",
            "from": f"Direction Commerciale <{self.test_lead_email}>",
            "subject": "Quelques informations svp",
            "body": "Bonjour, pouvez-vous nous préciser vos tarifs Apify ?",
        }

        matched_email, lead, method = self.crawler.match_lead(
            from_email=self.test_lead_email,
            subject=raw_msg["subject"]
        )
        self.assertEqual(matched_email, self.test_lead_email)
        self.assertEqual(method, "sender_email")
        self.assertIsNotNone(lead)

    def test_criterion_3_matching_via_in_reply_to_header(self):
        """Kriterium 3: Matcht Antwort ueber In-Reply-To Header (auch wenn Absender-Adresse abweicht)."""
        different_sender = "comptabilite@jouets-lyon.fr"
        raw_msg = {
            "message_id": "<msg-reply-match@jouets-lyon.fr>",
            "from": f"Finance Team <{different_sender}>",
            "in_reply_to": f"<{self.test_resend_id}>",
            "subject": "Re: Demande de contact",
            "body": "Bonjour, quel est le coût après les 50 articles gratuits ?",
        }

        matched_email, lead, method = self.crawler.match_lead(
            from_email=different_sender,
            in_reply_to=self.test_resend_id,
            subject=raw_msg["subject"]
        )
        self.assertEqual(matched_email, self.test_lead_email)
        self.assertEqual(method, "in_reply_to")
        self.assertIsNotNone(lead)

    def test_criterion_3_matching_via_subject(self):
        """Kriterium 3: Matcht Antwort ueber Betreff (auch wenn In-Reply-To fehlt und Absender neu ist)."""
        another_sender = "assistant@jouets-lyon.fr"
        raw_msg_subject = f"Re: {self.test_subject}"

        matched_email, lead, method = self.crawler.match_lead(
            from_email=another_sender,
            in_reply_to="",
            subject=raw_msg_subject
        )
        self.assertEqual(matched_email, self.test_lead_email)
        self.assertIn(method, ("subject", "subject_company"))
        self.assertIsNotNone(lead)

    # -----------------------------------------------------------------------
    # Kriterium 4: Deduplizierung und Markierung verarbeiteter Nachrichten
    # -----------------------------------------------------------------------

    def test_criterion_4_deduplication_and_marking(self):
        """Kriterium 4: Verarbeitete Nachrichten werden dedupliziert und markiert."""
        msg_id = "<unique-dedup-msg-12345@jouets-lyon.fr>"
        raw_msg = {
            "message_id": msg_id,
            "from": self.test_lead_email,
            "subject": f"Re: {self.test_subject}",
            "body": "Bonjour, quel est votre modèle de tarification après le test gratuit ?",
        }

        # 1. Erster Durchlauf: Status muss PROCESSED sein
        self.assertFalse(self.crawler.is_processed(msg_id))
        result1 = self.crawler.process_message(raw_msg)
        self.assertEqual(result1["status"], "PROCESSED")
        self.assertFalse(result1["skipped"])

        # 2. Nachricht muss nun im Status als verarbeitet markiert sein
        self.assertTrue(self.crawler.is_processed(msg_id))
        self.assertTrue(self.state_file.exists())

        # State aus Datei nachladen
        reloaded_state = InboundMailCrawler(
            storage=self.storage,
            blacklist_mgr=self.blacklist_mgr,
            state_file=self.state_file
        )
        self.assertTrue(reloaded_state.is_processed(msg_id))
        stored_info = reloaded_state.state["processed_message_ids"]["unique-dedup-msg-12345@jouets-lyon.fr"]
        self.assertEqual(stored_info["status"], "PROCESSED")
        self.assertEqual(stored_info["lead_email"], self.test_lead_email)

        # 3. Zweiter Durchlauf (gleiche Message-ID): Muss als DUPLICATE uebersprungen werden
        result2 = self.crawler.process_message(raw_msg)
        self.assertEqual(result2["status"], "DUPLICATE")
        self.assertTrue(result2["skipped"])

    # -----------------------------------------------------------------------
    # Zusätzliche Tests: Quoted Reply Stripping & General Inquiry
    # -----------------------------------------------------------------------

    def test_quoted_reply_stripping_prevents_false_positive(self):
        """Stellt sicher, dass Zitate aus der Outreach-Mail nicht faelschlich als positiver Test gewertet werden."""
        inbound_body = """Non merci.

Le 19/11/2026 à 20:43, Thomas Hartmannsgruber a écrit :
> Afin de découvrir cet outil, je vous propose de faire vérifier 50 articles de votre catalogue de manière sans engagement et d'abord gratuite par le moteur.
"""
        res = classify_intent(inbound_body, subject="Re: Safety Gate")
        self.assertEqual(res.intent, Intent.NEGATIVE_OPTOUT)

    def test_general_inquiry_classification(self):
        """Prueft, ob Fragen nach Preisen/APIs als GENERAL_INQUIRY klassifiziert werden."""
        inquiry_text = "Bonjour Thomas, nous souhaitons savoir comment s'intègre votre moteur avec notre ERP existant ?"
        res = classify_intent(inquiry_text, subject="Question technique")
        self.assertEqual(res.intent, Intent.GENERAL_INQUIRY)


if __name__ == "__main__":
    unittest.main()
