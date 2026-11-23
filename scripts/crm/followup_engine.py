"""
scripts/crm/followup_engine.py
Automated Follow-Up Dispatcher & Cold-Outreach Jurisdiction Gate.

Funktionen:
1. Cold-Outreach Jurisdiction Gate fuer Oesterreich (AT, § 107 TKG) und Polen (PL, Art. 172 Fernmeldegesetz):
   - Blockiert unaufgeforderte Kaltakquise-E-Mails an Empfaenger in AT und PL strikt.
   - Setzt den Lead-Status atomar auf CHANNEL_RESTRICTED.
   - Leitet Leads auf manuelle LinkedIn / Social-Selling-Tasks um (.crm/linkedin_tasks.json).
2. Follow-Up Engine fuer reale Leads (FR/NL) nach definierter Grace Period:
   - Identifiziert Leads im Status OUTREACH_SENT nach Ablauf der Wartezeit (z.B. >= 4 Tage).
   - Generiert zielgerichtete, personalisierte Follow-Up Entwuerfe in Landessprache (FR, NL, DE, EN).
   - Behaelt vollstaendige Threading-Header (In-Reply-To, References) zur vorangegangenen Mail.
   - Bindet den Standard-Disclaimer und 5$ Startguthaben-Hinweis ein.
   - Legt Entwuerfe in der HITL Review-Queue (.crm/review_queue.json) mit Intent FOLLOW_UP ab.
   - Setzt den Status nach erfolgreichem Versand atomar auf FOLLOWUP_SENT.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import urllib.parse
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)
from scripts.crm.crawler import clean_subject_prefix
from scripts.crm.dispatcher import (
    DispatchResult,
    EmailDispatcher,
    get_default_dispatcher,
)
from scripts.crm.drafter import (
    APIFY_ACTOR_URL,
    ResponseDraft,
    normalize_language_code,
)
from scripts.crm.report_generator import (
    get_standard_disclaimer,
    get_zero_hits_note,
)
from scripts.crm.review_queue import (
    DraftStatus,
    ReviewQueue,
    get_default_queue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    get_default_storage,
)


class ColdOutreachJurisdictionError(ValueError):
    """Geworfen wenn eine Kaltakquise-E-Mail an eine verbotene Jurisdiktion (AT, PL) versendet werden soll."""
    pass


# ---------------------------------------------------------------------------
# LinkedIn / Social Selling Task Management
# ---------------------------------------------------------------------------

@dataclass
class LinkedInTask:
    """Repraesentiert eine manuelle LinkedIn / Social-Selling-Aufgabe."""
    task_id: str
    email: str
    company: str
    country: str
    legal_basis: str
    linkedin_search_url: str
    suggested_message: str
    status: str = "PENDING"
    created_at: str = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    )
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class LinkedInTaskManager:
    """Verwaltet manuelle LinkedIn Outreach-Tasks in .crm/linkedin_tasks.json."""

    def __init__(self, tasks_file: Optional[Union[str, Path]] = None) -> None:
        if tasks_file:
            self.filepath = Path(tasks_file)
        else:
            base_dir = Path(__file__).resolve().parent.parent.parent
            self.filepath = base_dir / ".crm" / "linkedin_tasks.json"

        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        self._tasks: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> Dict[str, Dict[str, Any]]:
        """Laedt alle Tasks aus der Datei."""
        if not self.filepath.exists():
            self._tasks = {}
            return self._tasks

        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict):
                self._tasks = data
            elif isinstance(data, list):
                self._tasks = {item["task_id"]: item for item in data if "task_id" in item}
        except Exception:
            self._tasks = {}
        return self._tasks

    def save(self) -> None:
        """Speichert alle Tasks atomar."""
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.filepath.with_suffix(f".tmp.{os.getpid()}")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self._tasks, f, indent=2, ensure_ascii=False)
        temp_path.replace(self.filepath)

    def add_task(self, task: Union[LinkedInTask, Dict[str, Any]]) -> Dict[str, Any]:
        """Fuegt einen neuen Task hinzu oder aktualisiert einen bestehenden."""
        if isinstance(task, LinkedInTask):
            t_dict = task.to_dict()
        else:
            t_dict = dict(task)

        task_id = t_dict.get("task_id")
        if not task_id:
            task_id = f"li_{uuid.uuid4().hex[:8]}"
            t_dict["task_id"] = task_id

        self._tasks[task_id] = t_dict
        self.save()
        return t_dict

    def list_tasks(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """Listet Tasks auf, optional gefiltert nach Status."""
        tasks = list(self._tasks.values())
        if status:
            tasks = [t for t in tasks if t.get("status") == status]
        return tasks

    def get_task(self, task_id: str) -> Optional[Dict[str, Any]]:
        return self._tasks.get(task_id)

    def complete_task(self, task_id: str, note: str = "") -> Optional[Dict[str, Any]]:
        task = self._tasks.get(task_id)
        if not task:
            return None
        task["status"] = "COMPLETED"
        task["completed_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        if note:
            task["note"] = note
        self.save()
        return task


# ---------------------------------------------------------------------------
# Cold-Outreach Jurisdiction Gate (AT, PL)
# ---------------------------------------------------------------------------

class ColdOutreachJurisdictionGate:
    """
    Kaltakquise-Rechts-Gate fuer Laender mit strikten Opt-In Gesetzen:
    - Oesterreich: § 107 TKG (Telekommunikationsgesetz) verbietet unaufgeforderte elektronische Post.
    - Polen: Art. 172 Prawo telekomunikacyjne / Art. 10 uśude verbietet unaufgeforderte
      elektronische Kontaktaufnahme zu Marketingzwecken.
    
    Wirkung:
    - E-Mail Kaltakquise wird strikt abgewiesen.
    - Lead wird auf CHANNEL_RESTRICTED gesetzt.
    - Automatisches Routing auf LinkedIn / Social Outreach Task.
    """

    RESTRICTED_JURISDICTIONS = {
        "AT": {
            "country_names": {"austria", "österreich", "oesterreich", "at", "aut"},
            "tld": ".at",
            "legal_basis": "Österreich (§ 107 TKG): Verbot der unaufgeforderten E-Mail-Kaltakquise ohne vorherige Einwilligung.",
            "language": "de",
        },
        "PL": {
            "country_names": {"poland", "polska", "pl", "pol"},
            "tld": ".pl",
            "legal_basis": "Polen (Art. 172 Prawo telekomunikacyjne): Verbot unaufgeforderter elektronischer Kommunikation zu Direktmarketing-Zwecken.",
            "language": "en",
        },
    }

    def __init__(
        self,
        task_manager: Optional[LinkedInTaskManager] = None,
        storage: Optional[CRMStorage] = None,
    ) -> None:
        self.task_manager = task_manager or LinkedInTaskManager()
        self.storage = storage or get_default_storage()

    def check_jurisdiction(
        self,
        email: str,
        country: Optional[str] = None,
    ) -> Tuple[bool, Optional[str], Optional[str]]:
        """
        Prueft ob ein Empfaenger unter ein Kaltakquise-Verbot faellt.
        Rueckgabe: (is_restricted, country_code, legal_basis)
        """
        norm_email = normalize_email(email)
        norm_country = (country or "").strip().lower()

        # Pruefe auf AT
        at_info = self.RESTRICTED_JURISDICTIONS["AT"]
        if norm_country in at_info["country_names"] or norm_email.endswith(at_info["tld"]):
            return True, "AT", at_info["legal_basis"]

        # Pruefe auf PL
        pl_info = self.RESTRICTED_JURISDICTIONS["PL"]
        if norm_country in pl_info["country_names"] or norm_email.endswith(pl_info["tld"]):
            return True, "PL", pl_info["legal_basis"]

        return False, None, None

    def generate_linkedin_search_url(self, company: str) -> str:
        """Erzeugt eine LinkedIn-Such-URL fuer das Unternehmen."""
        clean_company = re.sub(r'\s+(gmbh|srl|sa|bv|sp\.\s*z\s*o\.o\.|spółka|ltd|inc|corp)\.?$', '', company, flags=re.I).strip()
        query = clean_company or company
        encoded = urllib.parse.quote(query)
        return f"https://www.linkedin.com/search/results/all/?keywords={encoded}"

    def generate_suggested_message(self, company: str, country_code: str) -> str:
        """Erzeugt einen zielgerichteten LinkedIn-Nachrichtenvorschlag."""
        comp = company or "Ihr Unternehmen"
        if country_code == "AT":
            return (
                f"Guten Tag, ich habe gesehen, dass Sie bei {comp} das Sortiment und die "
                f"Produktsicherheit steuern. Im Hinblick auf die EU-Produktsicherheitsverordnung (GPSR) "
                f"und wöchentliche Safety-Gate-Meldungen bieten wir einen automatisierten Abgleich. "
                f"Ich freue mich über einen kurzen fachlichen Austausch hier auf LinkedIn!"
            )
        elif country_code == "PL":
            return (
                f"Hello, I noticed your focus on product safety and retail distribution at {comp}. "
                f"With the EU General Product Safety Regulation (GPSR) and weekly Safety Gate alerts, "
                f"we provide automated catalog audits. Glad to connect here on LinkedIn!"
            )
        else:
            return (
                f"Hello, I saw your activities at {comp}. We provide automated EU Safety Gate & GPSR "
                f"compliance screening for European wholesale and retail portfolios. Let's connect!"
            )

    def route_lead_to_linkedin(
        self,
        lead_or_email: Union[str, Dict[str, Any]],
        country_code: str,
        legal_basis: str,
    ) -> LinkedInTask:
        """
        Routet einen Lead aus AT oder PL auf einen manuellen LinkedIn-Task um
        und setzt den Lead-Status in CRMStorage atomar auf CHANNEL_RESTRICTED.
        """
        if isinstance(lead_or_email, str):
            email = normalize_email(lead_or_email)
            lead = self.storage.get_lead(email) or {"email": email}
        else:
            lead = lead_or_email
            email = normalize_email(lead.get("email", ""))

        company = lead.get("company", "") or lead.get("company_name", "")
        country = lead.get("country", "") or country_code
        linkedin_url = self.generate_linkedin_search_url(company)
        suggested_msg = self.generate_suggested_message(company, country_code)

        task = LinkedInTask(
            task_id=f"li_{country_code.lower()}_{uuid.uuid4().hex[:8]}",
            email=email,
            company=company,
            country=country,
            legal_basis=legal_basis,
            linkedin_search_url=linkedin_url,
            suggested_message=suggested_msg,
            status="PENDING",
            metadata={
                "original_status": lead.get("status"),
                "routed_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            },
        )

        # In Task-Manager speichern
        self.task_manager.add_task(task)

        # Im Lead-Storage Status atomar auf CHANNEL_RESTRICTED setzen
        if self.storage:
            self.storage.update_lead_status(
                email=email,
                status=LeadStatus.CHANNEL_RESTRICTED,
                reason=f"Restricted by jurisdiction gate: {legal_basis} (Re-routed to LinkedIn task {task.task_id})",
            )

        return task

    def enforce_gate_on_recipient(
        self,
        email: str,
        country: Optional[str] = None,
        company: Optional[str] = None,
    ) -> Tuple[bool, Optional[LinkedInTask]]:
        """
        Prueft und erzwingt das Gate fuer einen einzelnen Empfaenger.
        Falls gesperrt: erzeugt LinkedInTask und setzt CHANNEL_RESTRICTED.
        """
        is_restricted, code, basis = self.check_jurisdiction(email, country)
        if not is_restricted or not code or not basis:
            return False, None

        lead = self.storage.get_lead(email) or {
            "email": email,
            "company": company or "",
            "country": country or code,
        }
        task = self.route_lead_to_linkedin(lead, code, basis)
        return True, task

    def enforce_jurisdiction_on_all_leads(self) -> List[LinkedInTask]:
        """
        Scannt die gesamte CRM-Datenbank und leitet alle ungesendeten Leads (NOT_SENT)
        aus AT und PL um.
        """
        created_tasks: List[LinkedInTask] = []
        leads = self.storage.list_leads()

        for lead in leads:
            email = lead.get("email", "")
            status = lead.get("status")
            # Wir pruefen Leads, die noch nicht gesendet sind oder bereits im Outreach-Fokus stehen
            if status in (LeadStatus.NOT_SENT, None):
                country = lead.get("country", "")
                is_restricted, code, basis = self.check_jurisdiction(email, country)
                if is_restricted and code and basis:
                    task = self.route_lead_to_linkedin(lead, code, basis)
                    created_tasks.append(task)

        return created_tasks


# ---------------------------------------------------------------------------
# Follow-Up Text Templates
# ---------------------------------------------------------------------------

FOLLOWUP_SUBJECTS = {
    "fr": "Suivi : Vérification Safety Gate pour {company} ?",
    "nl": "Opvolging: Safety Gate verificatie voor {company}?",
    "de": "Follow-up: Safety Gate Prüfung für {company}?",
    "en": "Follow-up: EU Safety Gate compliance check for {company}?",
}

FOLLOWUP_BODY_TEMPLATES = {
    "fr": """Bonjour,

Je me permets de revenir vers vous suite à mon précédent message concernant la conformité de votre catalogue {company} avec le règlement européen GPSR et les alertes hebdomadaires du Safety Gate (RAPEX).

Face aux contrôles renforcés des places de marché et des autorités européennes, nous aidons les distributeurs et importateurs à identifier en quelques minutes les articles rappelés ou à risque parmi leurs références.

Auriez-vous un créneau de 5 minutes cette semaine pour en discuter, ou souhaitez-vous que nous vous partagions une démonstration rapide de notre audit automatisé ?

Directement accessible sur Apify : {apify_url}
{welcome_credit}

Restant à votre entière disposition,

Bien cordialement,
Thomas | THFC Consulting
Product Safety Compliance Engine
{disclaimer}
""",
    "nl": """Beste,

Graag kom ik even terug op mijn eerdere bericht aangaande de conformiteit van het assortiment van {company} met betrekking tot de Europese GPSR-richtlijn en de wekelijkse Safety Gate (RAPEX) meldingen.

Gezien de aangescherpte controles door marktplaatsen en toezichthouders helpen wij groothandels en retailers om binnen enkele minuten teruggeroepen of risicovolle artikelen in hun catalogus te detecteren.

Schikt het u om hier deze week kort over van gedachten te wisselen, of zal ik u een beknopt voorbeeldrapport van onze geautomatiseerde audit toesturen?

Directe link naar onze engine op Apify: {apify_url}
{welcome_credit}

Met vriendelijke groet,
Thomas | THFC Consulting
Product Safety Compliance Engine
{disclaimer}
""",
    "de": """Guten Tag,

ich möchte kurz auf meine vorherige Nachricht bezüglich der Konformität Ihres Sortiments bei {company} mit der EU-Produktsicherheitsverordnung (GPSR) und den wöchentlichen Safety-Gate-Meldungen (RAPEX) zurückkommen.

Angesichts der verschärften Kontrollen durch Marktplätze und Marktüberwachungsbehörden unterstützen wir Händler und Importeure dabei, rückgerufene oder risikobehaftete Artikel automatisiert in Minutenschnelle zu identifizieren.

Passt es Ihnen diese Woche für ein kurzes 5-Minuten-Gespräch, oder darf ich Ihnen vorab einen kurzen Beispiel-Auditbericht zukommen lassen?

Direkter Link zu unserer Engine auf Apify: {apify_url}
{welcome_credit}

Mit freundlichen Grüßen
Thomas | THFC Consulting
Product Safety Compliance Engine
{disclaimer}
""",
    "en": """Hello,

I am following up on my previous note regarding product safety compliance and the EU General Product Safety Regulation (GPSR) for {company}.

With heightened enforcement across European marketplaces and regulators, we assist distributors and retailers in screening their product catalogues against weekly EU Safety Gate (RAPEX) alerts in minutes.

Would you have 5 minutes for a brief exchange this week, or may I share a quick sample audit report tailored to your product range?

Direct link to our engine on Apify: {apify_url}
{welcome_credit}

Best regards,
Thomas | THFC Consulting
Product Safety Compliance Engine
{disclaimer}
""",
}

WELCOME_CREDITS = {
    "fr": "L'inscription sur Apify est gratuite et inclut 5 $ de crédit de bienvenue pour tester vos premiers produits.",
    "nl": "Registratie op Apify is gratis en bevat $ 5 starttegoed om uw eerste producten direct te testen.",
    "de": "Die Registrierung auf Apify ist kostenlos und beinhaltet 5 $ Startguthaben für die ersten Produktprüfungen.",
    "en": "Registration on Apify is free and includes $5 in welcome credits to screen your initial SKUs.",
}


# ---------------------------------------------------------------------------
# Follow-Up Engine
# ---------------------------------------------------------------------------

class FollowUpEngine:
    """
    Automatisierter Nachfass-Zyklus fuer Leads im Status OUTREACH_SENT nach Grace Period.
    
    Verknuepft:
    - Lead Lifecycle Storage (CRMStorage)
    - Review Queue (ReviewQueue)
    - Jurisdiction Gate (ColdOutreachJurisdictionGate)
    - Dispatcher (EmailDispatcher)
    """

    DEFAULT_GRACE_PERIOD_DAYS = 4.0

    def __init__(
        self,
        storage: Optional[CRMStorage] = None,
        queue: Optional[ReviewQueue] = None,
        dispatcher: Optional[EmailDispatcher] = None,
        jurisdiction_gate: Optional[ColdOutreachJurisdictionGate] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
        grace_period_days: float = DEFAULT_GRACE_PERIOD_DAYS,
    ) -> None:
        self.storage = storage or get_default_storage()
        self.queue = queue or get_default_queue()
        self.blacklist_mgr = blacklist_mgr or get_default_manager()
        self.dispatcher = dispatcher or get_default_dispatcher()
        self.jurisdiction_gate = jurisdiction_gate or ColdOutreachJurisdictionGate(storage=self.storage)
        self.grace_period_days = float(grace_period_days)

    def parse_datetime(self, val: Any) -> Optional[datetime.datetime]:
        """Hilfsfunktion zum robusten Parsen von ISO-Datumsstrings."""
        if not val:
            return None
        if isinstance(val, datetime.datetime):
            if val.tzinfo is None:
                return val.replace(tzinfo=datetime.timezone.utc)
            return val
        try:
            val_str = str(val).strip()
            # z.B. 2026-11-19T20:43:37.893953+00:00 oder 2026-11-19T20:43:37Z
            if val_str.endswith("Z"):
                val_str = val_str[:-1] + "+00:00"
            return datetime.datetime.fromisoformat(val_str)
        except Exception:
            return None

    def find_eligible_leads(
        self,
        reference_time: Optional[datetime.datetime] = None,
        grace_period_days: Optional[float] = None,
        force: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Findet Leads im Status OUTREACH_SENT, deren Wartezeit abgelaufen ist.
        Kriterien:
        - Status == OUTREACH_SENT
        - Empfaenger ist nicht geblacklistet (can_contact == True)
        - Kein Jurisdiktions-Ausschluss (nicht AT oder PL)
        - Kein bereits existierender Follow-Up in Queue
        - (ref_time - sent_at) >= grace_period_days
        """
        ref_time = reference_time or datetime.datetime.now(datetime.timezone.utc)
        if ref_time.tzinfo is None:
            ref_time = ref_time.replace(tzinfo=datetime.timezone.utc)

        grace_days = self.grace_period_days if grace_period_days is None else float(grace_period_days)
        grace_seconds = grace_days * 86400.0

        all_leads = self.storage.list_leads()
        eligible: List[Dict[str, Any]] = []

        # Bestehende Follow-Up Entwuerfe in der Queue pruefen
        existing_drafts = self.queue.list_drafts()
        emails_with_queued_followup = {
            normalize_email(d.get("lead_email") or d.get("recipient", ""))
            for d in existing_drafts
            if d.get("intent") in ("FOLLOW_UP", "FOLLOWUP")
        }

        for lead in all_leads:
            email = normalize_email(lead.get("email", ""))
            if not email:
                continue

            status = lead.get("status")
            if status != LeadStatus.OUTREACH_SENT:
                continue

            # Kontaktschutz (Blacklist)
            if not self.storage.can_contact(email):
                continue

            # Jurisdiktions-Check: AT / PL duerfen keine Kaltakquise-Mails erhalten
            country = lead.get("country", "")
            is_restricted, _, _ = self.jurisdiction_gate.check_jurisdiction(email, country)
            if is_restricted:
                continue

            # Wurde bereits ein Follow-Up fuer diese Mail generiert?
            if email in emails_with_queued_followup:
                continue

            # Wartezeit / Grace Period pruefen
            sent_at = self.parse_datetime(lead.get("sent_at") or lead.get("created_at"))
            if not sent_at:
                if force:
                    eligible.append(lead)
                continue

            diff_seconds = (ref_time - sent_at).total_seconds()
            if diff_seconds >= grace_seconds or force:
                eligible.append(lead)

        return eligible

    def generate_followup_draft(
        self,
        lead: Dict[str, Any],
        auto_approve: bool = False,
    ) -> ResponseDraft:
        """
        Erstellt einen personalisierten Follow-Up Entwurf in der Sprache des Leads.
        """
        email = normalize_email(lead.get("email", ""))
        company = lead.get("company", "") or "Ihr Unternehmen"
        country = lead.get("country", "")

        # Sprache normalisieren
        raw_lang = lead.get("language") or country
        lang = normalize_language_code(raw_lang)

        # Betreff generieren
        orig_subject = lead.get("subject", "")
        if orig_subject:
            clean_sub = clean_subject_prefix(orig_subject)
            subject = f"Re: {clean_sub}"
        else:
            tmpl = FOLLOWUP_SUBJECTS.get(lang, FOLLOWUP_SUBJECTS["en"])
            subject = tmpl.format(company=company)

        # Body zusammenbauen
        body_tmpl = FOLLOWUP_BODY_TEMPLATES.get(lang, FOLLOWUP_BODY_TEMPLATES["en"])
        welcome_str = WELCOME_CREDITS.get(lang, WELCOME_CREDITS["en"])
        disclaimer_str = get_standard_disclaimer(lang)

        body = body_tmpl.format(
            company=company,
            apify_url=APIFY_ACTOR_URL,
            welcome_credit=welcome_str,
            disclaimer=disclaimer_str,
        ).strip()

        # Threading-Header (In-Reply-To / References)
        in_reply_to = lead.get("resend_id") or lead.get("message_id")
        references = in_reply_to

        draft_id = f"followup_{uuid.uuid4().hex[:8]}"
        initial_status = DraftStatus.APPROVED if auto_approve else DraftStatus.PENDING_REVIEW

        draft = ResponseDraft(
            draft_id=draft_id,
            lead_email=email,
            company=company,
            language=lang,
            subject=subject,
            body=body,
            status=initial_status,
            intent="FOLLOW_UP",
            in_reply_to=in_reply_to,
            references=references,
        )

        return draft

    def generate_followup_drafts(
        self,
        reference_time: Optional[datetime.datetime] = None,
        grace_period_days: Optional[float] = None,
        auto_approve: bool = False,
        force: bool = False,
    ) -> List[Dict[str, Any]]:
        """
        Generiert Follow-Up Entwuerfe fuer alle berechtigten Leads und reiht sie
        in die Review-Queue ein.
        """
        eligible = self.find_eligible_leads(
            reference_time=reference_time,
            grace_period_days=grace_period_days,
            force=force,
        )

        created_drafts: List[Dict[str, Any]] = []
        for lead in eligible:
            draft_obj = self.generate_followup_draft(lead, auto_approve=auto_approve)
            d_dict = asdict(draft_obj)
            self.queue.add_draft(d_dict)
            created_drafts.append(d_dict)

        return created_drafts

    def dispatch_followup(
        self,
        draft_or_id: Union[str, Dict[str, Any]],
        dry_run: Optional[bool] = None,
    ) -> DispatchResult:
        """
        Versendet einen einzelnen Follow-Up Entwurf und aktualisiert den Lead-Status
        im CRMStorage atomar auf FOLLOWUP_SENT.
        
        Hard-Gates:
        1. Jurisdiction Gate (AT / PL strikt blockiert mit ColdOutreachJurisdictionError).
        2. Blacklist-Schutz (Goldene Regel).
        3. Status APPROVED in Queue.
        """
        if isinstance(draft_or_id, str):
            draft = self.queue.get_draft(draft_or_id)
            if not draft:
                raise ValueError(f"Draft '{draft_or_id}' not found in review queue.")
        else:
            draft = draft_or_id

        draft_id = draft.get("draft_id", "")
        recipient = normalize_email(draft.get("lead_email") or draft.get("recipient", ""))

        # -------------------------------------------------------------------
        # Hard-Gate 1: Jurisdiction Check (AT / PL)
        # -------------------------------------------------------------------
        lead = self.storage.get_lead(recipient) or {}
        country = lead.get("country", "")
        is_restricted, code, basis = self.jurisdiction_gate.check_jurisdiction(recipient, country)
        if is_restricted and code and basis:
            # Automatisch auf LinkedIn-Task umrouten und atomar CHANNEL_RESTRICTED setzen
            self.jurisdiction_gate.route_lead_to_linkedin(lead or recipient, code, basis)
            raise ColdOutreachJurisdictionError(
                f"COLD OUTREACH BLOCKED: Lead '{recipient}' is in restricted jurisdiction {code} "
                f"({basis}). Re-routed to manual LinkedIn outreach task."
            )

        # -------------------------------------------------------------------
        # Hard-Gate 2: Blacklist Check
        # -------------------------------------------------------------------
        if not self.storage.can_contact(recipient):
            raise BlacklistedRecipientError(
                f"Cannot dispatch follow-up to '{recipient}': Recipient is blacklisted or opt-out."
            )

        # -------------------------------------------------------------------
        # Versand via Dispatcher
        # -------------------------------------------------------------------
        result = self.dispatcher.dispatch_draft(draft, dry_run=dry_run)

        # -------------------------------------------------------------------
        # Akzeptanzkriterium 2: Atomare Aktualisierung auf FOLLOWUP_SENT
        # -------------------------------------------------------------------
        if result.status in ("SENT", "DRY_RUN"):
            self.storage.update_lead_status(
                email=recipient,
                status=LeadStatus.FOLLOWUP_SENT,
                reason=f"Follow-up dispatched successfully via {result.provider} (Draft: {draft_id})",
            )

        return result

    def dispatch_all_approved_followups(
        self,
        limit: Optional[int] = None,
        dry_run: Optional[bool] = None,
    ) -> List[DispatchResult]:
        """
        Versendet alle freigegebenen Follow-Up Entwuerfe (Status APPROVED, Intent FOLLOW_UP).
        """
        approved_drafts = self.queue.list_drafts(status=DraftStatus.APPROVED)
        followup_drafts = [
            d for d in approved_drafts
            if d.get("intent") in ("FOLLOW_UP", "FOLLOWUP")
        ]

        if limit and limit > 0:
            followup_drafts = followup_drafts[:limit]

        results: List[DispatchResult] = []
        for draft in followup_drafts:
            try:
                res = self.dispatch_followup(draft, dry_run=dry_run)
                results.append(res)
            except Exception as e:
                results.append(
                    DispatchResult(
                        draft_id=draft.get("draft_id", ""),
                        recipient=draft.get("lead_email", ""),
                        status="FAILED",
                        provider=self.dispatcher.provider,
                        error=str(e),
                    )
                )
        return results


# ---------------------------------------------------------------------------
# Default Singletons & Hilfsfunktionen
# ---------------------------------------------------------------------------

_default_engine: Optional[FollowUpEngine] = None
_default_gate: Optional[ColdOutreachJurisdictionGate] = None
_default_li_mgr: Optional[LinkedInTaskManager] = None


def get_default_linkedin_mgr() -> LinkedInTaskManager:
    global _default_li_mgr
    if _default_li_mgr is None:
        _default_li_mgr = LinkedInTaskManager()
    return _default_li_mgr


def get_default_jurisdiction_gate() -> ColdOutreachJurisdictionGate:
    global _default_gate
    if _default_gate is None:
        _default_gate = ColdOutreachJurisdictionGate(
            task_manager=get_default_linkedin_mgr(),
            storage=get_default_storage(),
        )
    return _default_gate


def get_default_followup_engine() -> FollowUpEngine:
    global _default_engine
    if _default_engine is None:
        _default_engine = FollowUpEngine(
            storage=get_default_storage(),
            queue=get_default_queue(),
            dispatcher=get_default_dispatcher(),
            jurisdiction_gate=get_default_jurisdiction_gate(),
        )
    return _default_engine
