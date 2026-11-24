"""
scripts/tests/test_crm_followup_and_jurisdiction.py
Unit- & Integrationstests fuer Feature F07:
CRM Automated Follow-Up Dispatcher & Cold-Outreach Jurisdiction Gate.

Akzeptanzkriterien:
1. Generiert zielgerichtete Follow-Up Entwuerfe fuer Leads im Status OUTREACH_SENT nach definierter Wartezeit
2. Setzt nach erfolgreichem Versand den Status der Leads atomar auf FOLLOWUP_SENT
3. Blockiert unaufgeforderte Kaltakquise-E-Mails fuer AT und PL strikt gemaess lokalen Rechtsvorschriften
4. Routet Leads aus AT und PL auf manuelle LinkedIn/Social-Selling-Tasks um
"""

import datetime
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
    ColdOutreachJurisdictionError,
    DispatchResult,
    EmailDispatcher,
    UnapprovedDraftError,
)
from scripts.crm.followup_engine import (
    APIFY_ACTOR_URL,
    ColdOutreachJurisdictionGate,
    FollowUpEngine,
    LinkedInTask,
    LinkedInTaskManager,
)
from scripts.crm.review_queue import (
    DraftStatus,
    ReviewQueue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    VALID_LEAD_STATUSES,
)


class TestCRMFollowupAndJurisdiction(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.temp_path = Path(self.temp_dir.name)

        self.leads_file = self.temp_path / "leads_db.json"
        self.queue_file = self.temp_path / "review_queue.json"
        self.blacklist_file = self.temp_path / "blacklist.json"
        self.tasks_file = self.temp_path / "linkedin_tasks.json"

        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(leads_file=self.leads_file, blacklist_mgr=self.blacklist_mgr)
        self.queue = ReviewQueue(queue_file=self.queue_file, blacklist_mgr=self.blacklist_mgr)
        self.li_mgr = LinkedInTaskManager(tasks_file=self.tasks_file)
        self.gate = ColdOutreachJurisdictionGate(task_manager=self.li_mgr, storage=self.storage)

        self.dispatcher = EmailDispatcher(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
            storage=self.storage,
            provider="resend",
            dry_run=True,
        )

        self.engine = FollowUpEngine(
            storage=self.storage,
            queue=self.queue,
            dispatcher=self.dispatcher,
            jurisdiction_gate=self.gate,
            blacklist_mgr=self.blacklist_mgr,
            grace_period_days=4.0,
        )

        self.ref_now = datetime.datetime(2026, 11, 23, 22, 0, 0, tzinfo=datetime.timezone.utc)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_criterion_1_generate_targeted_followup_drafts_after_grace_period(self):
        """
        Kriterium 1: Generiert zielgerichtete Follow-Up Entwuerfe fuer Leads
        im Status OUTREACH_SENT nach definierter Wartezeit (Grace Period >= 4 Tage).
        """
        # 1. Testdaten vorbereiten
        # Lead 1: FR Lead, gesendet vor 5 Tagen -> eligible!
        sent_5_days_ago = (self.ref_now - datetime.timedelta(days=5)).isoformat()
        self.storage._leads["contact@fr-toys.fr"] = {
            "email": "contact@fr-toys.fr",
            "company": "Jouets France SAS",
            "country": "France",
            "language": "fr",
            "status": LeadStatus.OUTREACH_SENT,
            "subject": "Vérification Safety Gate pour Jouets France SAS ?",
            "sent_at": sent_5_days_ago,
            "resend_id": "resend_fr_123",
            "history": [],
            "created_at": sent_5_days_ago,
            "updated_at": sent_5_days_ago,
        }

        # Lead 2: Zweiter FR Lead, gesendet vor 4.2 Tagen -> eligible!
        sent_4_days_ago = (self.ref_now - datetime.timedelta(days=4.2)).isoformat()
        self.storage._leads["contact2@fr-jouets.fr"] = {
            "email": "contact2@fr-jouets.fr",
            "company": "Jouets Lyon SAS",
            "country": "France",
            "language": "fr",
            "status": LeadStatus.OUTREACH_SENT,
            "subject": "Vérification Safety Gate pour Jouets Lyon SAS ?",
            "sent_at": sent_4_days_ago,
            "resend_id": "resend_fr_456",
            "history": [],
            "created_at": sent_4_days_ago,
            "updated_at": sent_4_days_ago,
        }

        # Lead 3: Zu jung (vor 1 Tag gesendet) -> NICHT eligible
        sent_1_day_ago = (self.ref_now - datetime.timedelta(days=1)).isoformat()
        self.storage._leads["fresh@fr-toys.fr"] = {
            "email": "fresh@fr-toys.fr",
            "company": "Fresh FR SAS",
            "country": "France",
            "status": LeadStatus.OUTREACH_SENT,
            "sent_at": sent_1_day_ago,
            "resend_id": "resend_fresh_789",
        }

        # Lead 4: Bereits geantwortet -> NICHT eligible
        self.storage._leads["replied@nl-toys.nl"] = {
            "email": "replied@nl-toys.nl",
            "company": "Replied BV",
            "country": "Netherlands",
            "status": LeadStatus.REPLIED_POSITIVE,
            "sent_at": sent_5_days_ago,
        }

        # Lead 5: Blacklisted -> NICHT eligible
        self.blacklist_mgr.add_to_blacklist("blocked@fr-toys.fr", reason="Opt-out")
        self.storage._leads["blocked@fr-toys.fr"] = {
            "email": "blocked@fr-toys.fr",
            "company": "Blocked SAS",
            "country": "France",
            "status": LeadStatus.OUTREACH_SENT,
            "sent_at": sent_5_days_ago,
        }
        self.storage.save()

        # Eligible Leads ermitteln
        eligible = self.engine.find_eligible_leads(
            reference_time=self.ref_now,
            grace_period_days=4.0,
        )
        eligible_emails = {l["email"] for l in eligible}
        self.assertEqual(eligible_emails, {"contact@fr-toys.fr", "contact2@fr-jouets.fr"})

        # Entwuerfe generieren
        drafts = self.engine.generate_followup_drafts(
            reference_time=self.ref_now,
            grace_period_days=4.0,
            auto_approve=False,
        )
        self.assertEqual(len(drafts), 2)

        # Pruefe ersten franzoesischen Entwurf
        fr_draft = next(d for d in drafts if d["lead_email"] == "contact@fr-toys.fr")
        self.assertEqual(fr_draft["language"], "fr")
        self.assertTrue(fr_draft["subject"].startswith("Re: Vérification Safety Gate"))
        self.assertEqual(fr_draft["in_reply_to"], "resend_fr_123")
        self.assertIn("Jouets France SAS", fr_draft["body"])
        self.assertIn(APIFY_ACTOR_URL, fr_draft["body"])
        self.assertIn("5 $ de crédit de bienvenue", fr_draft["body"])
        self.assertEqual(fr_draft["status"], DraftStatus.PENDING_REVIEW)
        self.assertEqual(fr_draft["intent"], "FOLLOW_UP")

        # Pruefe zweiten franzoesischen Entwurf
        fr2_draft = next(d for d in drafts if d["lead_email"] == "contact2@fr-jouets.fr")
        self.assertEqual(fr2_draft["language"], "fr")
        self.assertTrue(fr2_draft["subject"].startswith("Re: Vérification Safety Gate"))
        self.assertEqual(fr2_draft["in_reply_to"], "resend_fr_456")
        self.assertIn("Jouets Lyon SAS", fr2_draft["body"])
        self.assertIn(APIFY_ACTOR_URL, fr2_draft["body"])
        self.assertIn("5 $ de crédit de bienvenue", fr2_draft["body"])
        self.assertEqual(fr2_draft["status"], DraftStatus.PENDING_REVIEW)

        # Pruefe Speicherung in ReviewQueue
        queued_drafts = self.queue.list_drafts()
        self.assertEqual(len(queued_drafts), 2)

    def test_criterion_2_atomic_status_update_to_followup_sent_after_dispatch(self):
        """
        Kriterium 2: Setzt nach erfolgreichem Versand den Status der Leads atomar auf FOLLOWUP_SENT.
        """
        email = "partner@retailer-fr.fr"
        sent_5_days_ago = (self.ref_now - datetime.timedelta(days=5)).isoformat()
        self.storage._leads[email] = {
            "email": email,
            "company": "Retailer FR",
            "country": "France",
            "language": "fr",
            "status": LeadStatus.OUTREACH_SENT,
            "subject": "Safety Gate check pour Retailer FR?",
            "sent_at": sent_5_days_ago,
            "resend_id": "resend_original_999",
            "history": [],
            "created_at": sent_5_days_ago,
            "updated_at": sent_5_days_ago,
        }
        self.storage.save()

        # Follow-Up mit auto_approve=True generieren
        draft_obj = self.engine.generate_followup_draft(self.storage.get_lead(email), auto_approve=True)
        self.queue.save_draft(draft_obj.__dict__)

        # Vor Versand pruefen
        lead_before = self.storage.get_lead(email)
        self.assertEqual(lead_before["status"], LeadStatus.OUTREACH_SENT)

        # Dispatch via FollowUpEngine (dry_run=True simuliert erfolgreichen Versand)
        result = self.engine.dispatch_followup(draft_obj.draft_id, dry_run=True)
        self.assertEqual(result.status, "DRY_RUN")

        # Nach Versand: Status muss atomar auf FOLLOWUP_SENT stehen!
        lead_after = self.storage.get_lead(email)
        self.assertEqual(lead_after["status"], LeadStatus.FOLLOWUP_SENT)

        # Pruefe History-Event
        history_actions = [h.get("action") for h in lead_after.get("history", [])]
        self.assertIn("STATUS_CHANGE", history_actions)
        last_event = lead_after["history"][-1]
        self.assertEqual(last_event.get("new_status"), LeadStatus.FOLLOWUP_SENT)

        # Pruefe auch direkten Versand via EmailDispatcher (mit mock Resend API)
        email2 = "direct@retailer-fr.fr"
        self.storage._leads[email2] = {
            "email": email2,
            "company": "Direct FR",
            "country": "France",
            "language": "fr",
            "status": LeadStatus.OUTREACH_SENT,
            "subject": "Vérification Safety Gate pour Direct FR ?",
            "sent_at": sent_5_days_ago,
            "history": [],
        }
        self.storage.save()

        draft_obj2 = self.engine.generate_followup_draft(self.storage.get_lead(email2), auto_approve=True)
        self.queue.save_draft(draft_obj2.__dict__)

        dispatcher_live = EmailDispatcher(
            queue=self.queue,
            blacklist_mgr=self.blacklist_mgr,
            storage=self.storage,
            provider="resend",
            dry_run=False,
            resend_api_key="test_dummy_key",
        )

        with patch.object(dispatcher_live, "send_via_resend", return_value={"id": "resend_followup_id_123"}):
            dispatch_res = dispatcher_live.dispatch_draft(draft_obj2.draft_id)
            self.assertEqual(dispatch_res.status, "SENT")
            self.assertEqual(dispatch_res.message_id, "resend_followup_id_123")

            lead2_after = self.storage.get_lead(email2)
            self.assertEqual(lead2_after["status"], LeadStatus.FOLLOWUP_SENT)

    def test_criterion_3_blocks_cold_outreach_for_at_and_pl_according_to_jurisdiction(self):
        """
        Kriterium 3: Blockiert unaufgeforderte Kaltakquise-E-Mails fuer AT und PL
        strikt gemaess lokalen Rechtsvorschriften (AT: § 107 TKG, PL: Art. 172 Fernmeldegesetz).
        """
        # Test 1: Oesterreichischer Empfaenger
        at_lead = {
            "email": "geschaeftsleitung@spielwaren-wien.at",
            "company": "Wiener Spielwaren GmbH",
            "country": "Austria",
            "status": LeadStatus.NOT_SENT,
        }
        self.storage._leads[at_lead["email"]] = at_lead
        self.storage.save()

        # Gate pruefen
        is_restr, code, basis = self.gate.check_jurisdiction(at_lead["email"], at_lead["country"])
        self.assertTrue(is_restr)
        self.assertEqual(code, "AT")
        self.assertIn("§ 107 TKG", basis)

        # Test 2: Polnischer Empfaenger
        pl_lead = {
            "email": "kontakt@zabawki-krakow.pl",
            "company": "Kraków Zabawki Sp. z o.o.",
            "country": "Poland",
            "status": LeadStatus.NOT_SENT,
        }
        self.storage._leads[pl_lead["email"]] = pl_lead
        self.storage.save()

        is_restr_pl, code_pl, basis_pl = self.gate.check_jurisdiction(pl_lead["email"], pl_lead["country"])
        self.assertTrue(is_restr_pl)
        self.assertEqual(code_pl, "PL")
        self.assertIn("Art. 172", basis_pl)

        # Test 3: Gesperrtes Land (Niederlande Art. 11.7 Telecommunicatiewet) vs. Unbedenkliches Land (Frankreich)
        is_restr_nl, code_nl, basis_nl = self.gate.check_jurisdiction("info@speelgoed.nl", "Netherlands")
        self.assertTrue(is_restr_nl)
        self.assertEqual(code_nl, "NL")
        self.assertIn("Telecommunicatiewet", basis_nl)

        is_restr_fr, _, _ = self.gate.check_jurisdiction("contact@jouets.fr", "France")
        self.assertFalse(is_restr_fr)

        # Test 3b: Fail-Closed bei unbekanntem oder leerem Land (F3)
        is_restr_unknown, code_unk, basis_unk = self.gate.check_jurisdiction("ceo@mystery-shop.com", "")
        self.assertTrue(is_restr_unknown, "Empty country must fail closed")
        self.assertEqual(code_unk, "UNKNOWN")
        self.assertIn("Fail-Closed", basis_unk)

        is_restr_none, code_none, basis_none = self.gate.check_jurisdiction("sales@global-trade.net", None)
        self.assertTrue(is_restr_none, "None country must fail closed")
        self.assertEqual(code_none, "UNKNOWN")

        # Test 3c: Deutschland (§ 7 UWG)
        is_restr_de, code_de, basis_de = self.gate.check_jurisdiction("info@spielzeug-muenchen.de", "Deutschland")
        self.assertTrue(is_restr_de, "Germany must be restricted under § 7 UWG")
        self.assertEqual(code_de, "DE")
        self.assertIn("UWG", basis_de)

        # Test 3d: Parametrisierte Normalisierung (FR) und Fail-Closed
        for c in ["fr", " FR ", "Fr", "france", " France ", "FRANKREICH"]:
            is_restr_n, _, _ = self.gate.check_jurisdiction("a@b.fr", c)
            self.assertFalse(is_restr_n, f"Country '{c}' with .fr must be permitted")

        for c in ["XX", "  ", "", None, "USA", "UK", "China", "Unknown"]:
            is_restr_fc, code_fc, _ = self.gate.check_jurisdiction("a@b.com", c)
            self.assertTrue(is_restr_fc, f"Country '{c}' must fail closed")
            self.assertEqual(code_fc, "UNKNOWN")

        # Test 4: Versuchter Dispatch an AT muss strikt mit ColdOutreachJurisdictionError abbrechen
        draft_at = {
            "draft_id": "draft_illegal_at_1",
            "lead_email": at_lead["email"],
            "company": at_lead["company"],
            "country": "Austria",
            "subject": "Kaltakquise Test",
            "body": "Angebot fuer Wien",
            "status": DraftStatus.APPROVED,
        }
        self.queue.save_draft(draft_at)

        with self.assertRaises(ColdOutreachJurisdictionError) as ctx:
            self.dispatcher.dispatch_draft("draft_illegal_at_1")
        self.assertIn("AT", str(ctx.exception))
        self.assertIn("§ 107 TKG", str(ctx.exception))

        # Status in CRMStorage muss nun CHANNEL_RESTRICTED sein
        at_lead_stored = self.storage.get_lead(at_lead["email"])
        self.assertEqual(at_lead_stored["status"], LeadStatus.CHANNEL_RESTRICTED)

        # can_contact muss zwingend False liefern!
        self.assertFalse(self.storage.can_contact(at_lead["email"]))

        # Test 5: Versuchter Dispatch an PL muss ebenso abbrechen
        draft_pl = {
            "draft_id": "draft_illegal_pl_2",
            "lead_email": pl_lead["email"],
            "company": pl_lead["company"],
            "country": "Poland",
            "subject": "Oferta",
            "body": "Propozycja biznesowa",
            "status": DraftStatus.APPROVED,
        }
        self.queue.save_draft(draft_pl)

        with self.assertRaises(ColdOutreachJurisdictionError) as ctx_pl:
            self.dispatcher.dispatch_draft("draft_illegal_pl_2")
        self.assertIn("PL", str(ctx_pl.exception))
        self.assertIn("Art. 172", str(ctx_pl.exception))

        pl_lead_stored = self.storage.get_lead(pl_lead["email"])
        self.assertEqual(pl_lead_stored["status"], LeadStatus.CHANNEL_RESTRICTED)
        self.assertFalse(self.storage.can_contact(pl_lead["email"]))

    def test_criterion_4_routes_leads_from_at_and_pl_to_manual_linkedin_tasks(self):
        """
        Kriterium 4: Routet Leads aus AT und PL auf manuelle LinkedIn/Social-Selling-Tasks um.
        """
        # Testlead aus Oesterreich
        at_lead = {
            "email": "ceo@alpen-toys.at",
            "company": "Alpen Toys Handels GmbH",
            "country": "Austria",
            "status": LeadStatus.NOT_SENT,
        }
        self.storage._leads[at_lead["email"]] = at_lead

        # Testlead aus Polen
        pl_lead = {
            "email": "hurtownia@warszawa-toys.pl",
            "company": "Warszawa Dystrybucja Sp. z o.o.",
            "country": "Poland",
            "status": LeadStatus.NOT_SENT,
        }
        self.storage._leads[pl_lead["email"]] = pl_lead
        self.storage.save()

        # Batch-Enforcement durchfuehren
        created_tasks = self.gate.enforce_jurisdiction_on_all_leads()
        self.assertEqual(len(created_tasks), 2)

        # Tasks aus Manager abfragen
        all_tasks = self.li_mgr.list_tasks()
        self.assertEqual(len(all_tasks), 2)

        # Task fuer AT untersuchen
        at_task = next(t for t in all_tasks if t["country"] == "Austria")
        self.assertEqual(at_task["status"], "PENDING")
        self.assertIn("§ 107 TKG", at_task["legal_basis"])
        self.assertIn("https://www.linkedin.com/search/results/all/?keywords=", at_task["linkedin_search_url"])
        self.assertIn("Alpen%20Toys%20Handels", at_task["linkedin_search_url"])
        self.assertIn("GPSR", at_task["suggested_message"])
        self.assertIn("Safety-Gate", at_task["suggested_message"])

        # Task fuer PL untersuchen
        pl_task = next(t for t in all_tasks if t["country"] == "Poland")
        self.assertEqual(pl_task["status"], "PENDING")
        self.assertIn("Art. 172", pl_task["legal_basis"])
        self.assertIn("Warszawa%20Dystrybucja", pl_task["linkedin_search_url"])
        self.assertIn("LinkedIn", pl_task["suggested_message"])

        # Beide Leads muessen auf CHANNEL_RESTRICTED gesetzt worden sein
        self.assertEqual(self.storage.get_lead("ceo@alpen-toys.at")["status"], LeadStatus.CHANNEL_RESTRICTED)
        self.assertEqual(self.storage.get_lead("hurtownia@warszawa-toys.pl")["status"], LeadStatus.CHANNEL_RESTRICTED)

        # Task als erledigt markieren
        completed = self.li_mgr.complete_task(at_task["task_id"], note="Kontaktanfrage versendet")
        self.assertIsNotNone(completed)
        self.assertEqual(completed["status"], "COMPLETED")
        self.assertEqual(self.li_mgr.get_task(at_task["task_id"])["status"], "COMPLETED")

    def test_workspace_24_leads_followup_and_jurisdiction_gate_integration(self):
        """
        Integrationstest gegen die realen Workspace-Dateien:
        1. Die 24 realen Leads in .crm/leads_db.json (FR/NL, gesendet am 19.11.2026)
           sind am aktuellen Datum (23.11.2026) nach Ablauf der 4-Tage-Grace-Period
           vollstaendig eligible fuer Follow-Up Entwuerfe.
        2. Die 10 Leads aus AT (3) und PL (7) in .crm/leads_db.json
           werden durch das Jurisdiktions-Gate korrekt als CHANNEL_RESTRICTED klassifiziert.
        """
        workspace_leads = Path(__file__).resolve().parent.parent.parent / ".crm" / "leads_db.json"
        self.assertTrue(workspace_leads.exists(), "leads_db.json must exist in workspace")

        with open(workspace_leads, "r", encoding="utf-8") as f:
            data = json.load(f)

        ws_storage = CRMStorage(leads_file=workspace_leads)
        ws_gate = ColdOutreachJurisdictionGate(storage=ws_storage)
        ws_engine = FollowUpEngine(storage=ws_storage, jurisdiction_gate=ws_gate, grace_period_days=4.0)

        # Pruefe reale gesendete Leads
        eligible = ws_engine.find_eligible_leads(reference_time=self.ref_now, grace_period_days=4.0)
        self.assertEqual(len(eligible), 10, "Only the 10 real leads from FR are eligible for email follow-up; 14 NL leads are blocked by Art. 11.7 Telecommunicatiewet")

        countries = {l.get("country") for l in eligible}
        self.assertEqual(countries, {"France"})

        # Pruefe NL Leads (14 Leads muessen unter Kaltakquise-Sperre fallen)
        nl_leads = [
            l for l in ws_storage.list_leads()
            if l.get("country") == "Netherlands" or l.get("email", "").endswith(".nl")
        ]
        self.assertEqual(len(nl_leads), 14, "There must be exactly 14 leads from Netherlands")
        for l in nl_leads:
            is_restr, code, basis = ws_gate.check_jurisdiction(l.get("email"), l.get("country"))
            self.assertTrue(is_restr, f"Lead {l.get('email')} must be restricted")
            self.assertEqual(code, "NL")
            self.assertIn("Telecommunicatiewet", basis)

        # Pruefe AT & PL Leads
        at_pl_leads = [
            l for l in ws_storage.list_leads()
            if l.get("country") in ("Austria", "Poland") or l.get("email", "").endswith((".at", ".pl"))
        ]
        self.assertEqual(len(at_pl_leads), 10, "There must be exactly 10 leads from Austria (3) and Poland (7)")

        for l in at_pl_leads:
            is_restr, code, basis = ws_gate.check_jurisdiction(l.get("email"), l.get("country"))
            self.assertTrue(is_restr, f"Lead {l.get('email')} must be restricted")
            self.assertIn(code, ("AT", "PL"))
