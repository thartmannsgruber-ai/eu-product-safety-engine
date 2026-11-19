"""
scripts/tests/test_crm_drafter_queue.py
Unit-Tests fuer Feature F04: Targeted Response Drafter & Human-in-the-Loop (HITL) Review Queue.

Akzeptanzkriterien:
1. Erstellt hochgradig personalisierte Antwortentwuerfe in der Sprache des Leads (FR/NL/DE/EN)
2. Fuegt den generierten Auswertungs-Report mit Disclaimer in den Entwurf ein
3. Reiht alle Entwuerfe in die Review-Queue (.crm/review_queue.json) mit eindeutiger draft_id ein
4. Status-Uebergaenge: PENDING_REVIEW -> APPROVED oder REJECTED
"""

import json
import os
import tempfile
import unittest
from pathlib import Path

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
)
from scripts.crm.drafter import (
    APIFY_ACTOR_URL,
    ResponseDraft,
    ResponseDrafter,
    draft_and_enqueue,
    draft_response,
    normalize_language_code,
)
from scripts.crm.engine_runner import (
    AuditHit,
    AuditItem,
    AuditResult,
    AuditRunReport,
)
from scripts.crm.report_generator import (
    STANDARD_DISCLAIMER_TEMPLATE,
    ZERO_HITS_NOTE,
    format_safety_gate_date,
    get_standard_disclaimer,
    get_zero_hits_note,
)
from scripts.crm.review_queue import (
    DraftNotFoundError,
    DraftStatus,
    InvalidStatusTransitionError,
    ReviewQueue,
)


class TestCRMDrafterAndReviewQueue(unittest.TestCase):
    def setUp(self):
        # Temporaeres Verzeichnis fuer isolierte Tests
        self.temp_dir = tempfile.TemporaryDirectory()
        self.queue_file = Path(self.temp_dir.name) / "review_queue.json"
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"

        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.queue = ReviewQueue(
            queue_file=self.queue_file,
            blacklist_mgr=self.blacklist_mgr,
        )
        self.drafter = ResponseDrafter(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    # -----------------------------------------------------------------------
    # Kriterium 1: Personalisierte Antwortentwuerfe in FR, NL, DE, EN
    # -----------------------------------------------------------------------

    def test_criterion_1_multilingual_personalization_de(self):
        """DE: Erstellt personalisierten Entwurf mit Apify Link & 5$ Guthaben."""
        lead = {
            "email": "kontakt@spielwaren-schmidt.de",
            "company": "Spielwaren Schmidt GmbH",
            "language": "de",
            "contact_name": "Herr Schmidt",
            "country": "Germany",
        }
        draft = self.drafter.draft_response(lead=lead, data_date="13.11.2026")

        self.assertEqual(draft.language, "de")
        self.assertEqual(draft.lead_email, "kontakt@spielwaren-schmidt.de")
        self.assertIn("Spielwaren Schmidt GmbH", draft.subject)
        self.assertIn("Spielwaren Schmidt GmbH", draft.body)
        self.assertIn("Herr Schmidt", draft.body)
        self.assertIn("Thomas Hartmannsgruber", draft.body)

        # Apify Actor Link & 5$ Guthaben
        self.assertIn(APIFY_ACTOR_URL, draft.body)
        self.assertIn("5$ Startguthaben", draft.body)

    def test_criterion_1_multilingual_personalization_fr(self):
        """FR: Erstellt franzoesischen Entwurf mit Apify Link & 5$ Guthaben."""
        lead = {
            "email": "direction@jouets-lyon.fr",
            "company": "Jouets Lyon SAS",
            "language": "fr",
            "contact_name": "M. Dupont",
            "country": "France",
        }
        draft = self.drafter.draft_response(lead=lead, data_date="13.11.2026")

        self.assertEqual(draft.language, "fr")
        self.assertIn("Jouets Lyon SAS", draft.subject)
        self.assertIn("Jouets Lyon SAS", draft.body)
        self.assertIn("M. Dupont", draft.body)
        self.assertIn("Merci pour votre retour", draft.body)

        # Apify Actor Link & 5$ Guthaben
        self.assertIn(APIFY_ACTOR_URL, draft.body)
        self.assertIn("5 $ de crédit de bienvenue", draft.body)

    def test_criterion_1_multilingual_personalization_nl(self):
        """NL: Erstellt niederlaendischen Entwurf mit Apify Link & 5$ Guthaben."""
        lead = {
            "email": "inkoop@speelgoed-amsterdam.nl",
            "company": "Speelgoed Amsterdam B.V.",
            "language": "nl",
            "contact_name": "Dhr. Jansen",
            "country": "Netherlands",
        }
        draft = self.drafter.draft_response(lead=lead, data_date="13.11.2026")

        self.assertEqual(draft.language, "nl")
        self.assertIn("Speelgoed Amsterdam B.V.", draft.subject)
        self.assertIn("Speelgoed Amsterdam B.V.", draft.body)
        self.assertIn("Dhr. Jansen", draft.body)
        self.assertIn("Hartelijk dank voor uw reactie", draft.body)

        # Apify Actor Link & 5$ Guthaben
        self.assertIn(APIFY_ACTOR_URL, draft.body)
        self.assertIn("$ 5 starttegoed", draft.body)

    def test_criterion_1_multilingual_personalization_en(self):
        """EN: Erstellt englischen Entwurf mit Apify Link & 5$ Guthaben."""
        lead = {
            "email": "buyer@london-toys.co.uk",
            "company": "London Toys Ltd",
            "language": "en",
            "contact_name": "Ms. Smith",
            "country": "United Kingdom",
        }
        draft = self.drafter.draft_response(lead=lead, data_date="13.11.2026")

        self.assertEqual(draft.language, "en")
        self.assertIn("London Toys Ltd", draft.subject)
        self.assertIn("London Toys Ltd", draft.body)
        self.assertIn("Ms. Smith", draft.body)
        self.assertIn("Thank you for your reply", draft.body)

        # Apify Actor Link & 5$ Guthaben
        self.assertIn(APIFY_ACTOR_URL, draft.body)
        self.assertIn("$5 in welcome credits", draft.body)

    # -----------------------------------------------------------------------
    # Kriterium 2: Einfuegen des Auswertungs-Reports mit Disclaimer
    # -----------------------------------------------------------------------

    def test_criterion_2_report_and_disclaimer_integration(self):
        """Fuegt strukturierten Report mit zwingendem Disclaimer und Hinweis in den Entwurf ein."""
        item1 = AuditItem(gtin="4006592080007", product_name="Holzbausteine Bunt 50er")
        hit1 = AuditHit(
            case_number="A12/00123/26",
            product="Holzbausteine",
            risk_type="Erstickungsgefahr / Kleinteile",
            country_of_origin="China",
        )
        res1 = AuditResult(item=item1, found=True, hits=[hit1])

        item2 = AuditItem(gtin="4006592080014", product_name="Plüschbär Teddy")
        res2 = AuditResult(item=item2, found=False, hits=[])

        report = AuditRunReport(
            timestamp="2026-11-19T20:00:00Z",
            data_date="13.11.2026",
            results=[res1, res2],
        )

        lead = {
            "email": "quality@bavaria-toys.de",
            "company": "Bavaria Toys",
            "language": "de",
        }

        draft = self.drafter.draft_response(
            lead=lead,
            report_data=report,
            data_date="13.11.2026",
        )

        # 1. Report muss im Body enthalten sein
        self.assertIn("4006592080007", draft.body)
        self.assertIn("TREFFER", draft.body)
        self.assertIn("A12/00123/26", draft.body)
        self.assertIn("4006592080014", draft.body)
        self.assertIn("Kein Treffer", draft.body)

        # 2. Zwingender Standard-Disclaimer mit Datum
        expected_disclaimer = "Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026"
        self.assertIn(expected_disclaimer, draft.body)

        # 3. Zwingender 0-Treffer-Sicherheits-Hinweis
        expected_zero_hits = "Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN)."
        self.assertIn(expected_zero_hits, draft.body)

    # -----------------------------------------------------------------------
    # Kriterium 3: Einreihen in Review-Queue (.crm/review_queue.json) mit draft_id
    # -----------------------------------------------------------------------

    def test_criterion_3_enqueue_in_review_queue(self):
        """Reiht Entwuerfe mit eindeutiger draft_id und Status PENDING_REVIEW in review_queue.json ein."""
        lead = {
            "email": "test@intertoys.nl",
            "company": "Intertoys B.V.",
            "language": "nl",
        }

        # 1. Erstellen und Einreihen ueber draft_and_enqueue
        enqueued = self.drafter.draft_and_enqueue(lead=lead, data_date="13.11.2026")

        self.assertIn("draft_id", enqueued)
        draft_id = enqueued["draft_id"]
        self.assertTrue(draft_id.startswith("draft_"))
        self.assertEqual(enqueued["status"], DraftStatus.PENDING_REVIEW)
        self.assertEqual(enqueued["lead_email"], "test@intertoys.nl")

        # 2. Pruefen ob in Datei persistiert wurde
        self.assertTrue(self.queue_file.exists())
        with open(self.queue_file, "r", encoding="utf-8") as f:
            persisted = json.load(f)

        self.assertIn(draft_id, persisted)
        self.assertEqual(persisted[draft_id]["status"], "PENDING_REVIEW")
        self.assertIn(APIFY_ACTOR_URL, persisted[draft_id]["body"])

        # 3. Zweiter Entwurf muss eine andere eindeutige ID erhalten
        enqueued2 = self.drafter.draft_and_enqueue(lead={"email": "second@test.fr", "company": "Second FR", "language": "fr"})
        self.assertNotEqual(draft_id, enqueued2["draft_id"])

        # 4. Abfrage ueber queue.list_drafts(status="PENDING_REVIEW")
        pending = self.queue.list_drafts(status=DraftStatus.PENDING_REVIEW)
        self.assertEqual(len(pending), 2)

    # -----------------------------------------------------------------------
    # Kriterium 4: Status-Uebergaenge PENDING_REVIEW -> APPROVED oder REJECTED
    # -----------------------------------------------------------------------

    def test_criterion_4_status_transition_pending_to_approved(self):
        """Prueft gueltigen Uebergang: PENDING_REVIEW -> APPROVED."""
        draft_dict = self.drafter.draft_and_enqueue(
            lead={"email": "freigabe@firma.de", "company": "Firma DE"}
        )
        draft_id = draft_dict["draft_id"]
        self.assertEqual(draft_dict["status"], DraftStatus.PENDING_REVIEW)

        # Freigabe durch Thomas
        approved = self.queue.approve(draft_id, reviewer="Thomas", note="Geprueft und freigegeben")
        self.assertEqual(approved["status"], DraftStatus.APPROVED)
        self.assertEqual(approved["reviewed_by"], "Thomas")
        self.assertIn("approved_at", approved)

        # Nachladen aus Datei zur Pruefung der Persistenz
        reloaded_queue = ReviewQueue(queue_file=self.queue_file)
        persisted_draft = reloaded_queue.get_draft(draft_id)
        self.assertIsNotNone(persisted_draft)
        self.assertEqual(persisted_draft["status"], DraftStatus.APPROVED)

    def test_criterion_4_status_transition_pending_to_rejected(self):
        """Prueft gueltigen Uebergang: PENDING_REVIEW -> REJECTED."""
        draft_dict = self.drafter.draft_and_enqueue(
            lead={"email": "ablehnung@firma.de", "company": "Firma Reject"}
        )
        draft_id = draft_dict["draft_id"]

        # Ablehnung
        rejected = self.queue.reject(draft_id, reviewer="Thomas", reason="Empfaenger unpassend")
        self.assertEqual(rejected["status"], DraftStatus.REJECTED)
        self.assertEqual(rejected["rejected_by"], "Thomas")
        self.assertEqual(rejected["rejection_reason"], "Empfaenger unpassend")
        self.assertIn("rejected_at", rejected)

    def test_criterion_4_invalid_transition_and_safeguards(self):
        """Verhindert ungueltige Status-Uebergaenge und Blacklist-Verstoesse."""
        draft_dict = self.drafter.draft_and_enqueue(
            lead={"email": "safeguard@firma.de", "company": "Firma Safeguard"}
        )
        draft_id = draft_dict["draft_id"]

        # Ungueltiger Statuswert
        with self.assertRaises(InvalidStatusTransitionError):
            self.queue.update_status(draft_id, "FANTASY_STATUS")

        # Ablehnen
        self.queue.reject(draft_id, reason="Archiviert")

        # Unerlaubter direkter Uebergang von REJECTED nach APPROVED (ohne PENDING_REVIEW)
        with self.assertRaises(InvalidStatusTransitionError):
            self.queue.approve(draft_id)

        # Nicht existierende draft_id wirft DraftNotFoundError
        with self.assertRaises(DraftNotFoundError):
            self.queue.approve("non_existent_draft_123")

    def test_criterion_4_blacklist_blocks_approval(self):
        """Goldene Regel: Steht die Adresse nachtraeglich auf der Blacklist, scheitert approve zwingend."""
        target_email = "optout-afterwards@firma.de"
        draft_dict = self.drafter.draft_and_enqueue(
            lead={"email": target_email, "company": "Firma OptOut"}
        )
        draft_id = draft_dict["draft_id"]

        # Adresse landet nachtraeglich auf der Blacklist
        self.blacklist_mgr.add_to_blacklist(target_email, reason="Kunde will keine Mails mehr")

        # Freigabe muss mit BlacklistedRecipientError abbrechen
        with self.assertRaises(BlacklistedRecipientError):
            self.queue.approve(draft_id)


if __name__ == "__main__":
    unittest.main()
