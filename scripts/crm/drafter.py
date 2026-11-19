"""
scripts/crm/drafter.py
Targeted Response Drafter & Human-in-the-Loop (HITL) Queue Ingestion.

Erzeugt zielgerichtete, personalisierte Antwort-Mailentwuerfe in der
jeweiligen Kundensprache (FR, NL, DE, EN) mit:
1. Rechercheergebnissen & strukturiertem Auswertungs-Report
2. Zwingendem Standard-Disclaimer und 0-Treffer-Sicherheits-Hinweis:
   - 'Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom TT.MM.JJJJ'
   - 'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).'
3. Apify Actor Link: https://apify.com/thfc_labs/eu-product-safety-actor
4. 5$ Willkommensguthaben-Hinweis in der jeweiligen Sprache
5. Eindeutiger draft_id und Status PENDING_REVIEW

Sicherheitsgarantie:
Entwuerfe werden mit Status PENDING_REVIEW in .crm/review_queue.json abgelegt.
Es erfolgt KEIN automatischer Versand ohne Freigabe (HITL).
"""

from __future__ import annotations

import os
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)
from scripts.crm.crawler import clean_subject_prefix
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
    generate_markdown_report,
    generate_report,
    generate_text_report,
    get_standard_disclaimer,
    get_zero_hits_note,
)
from scripts.crm.review_queue import (
    DraftStatus,
    ReviewQueue,
    get_default_queue,
)

APIFY_ACTOR_URL = "https://apify.com/thfc_labs/eu-product-safety-actor"
THFC_LABS_URL = "https://thfc-consulting.de"

SUPPORTED_LANGUAGES = {"de", "fr", "nl", "en"}

# 5$ Startguthaben-Textbausteine nach Sprache
WELCOME_CREDIT_SNIPPETS = {
    "de": (
        "Sollten Sie bei der Apify Plattform noch keinen Account besitzen: "
        "Sie können sich kostenlos registrieren und erhalten 5$ Startguthaben "
        "(damit können Sie mit der Product-Safety Engine z. B. 1.000 Produkte prüfen lassen "
        "oder 100 Artikel über 10 Wochen lang wöchentlich überwachen)."
    ),
    "fr": (
        "Si vous ne possédez pas encore de compte sur la plateforme Apify : "
        "l'inscription est gratuite et vous bénéficiez de 5 $ de crédit de bienvenue "
        "(ce qui vous permet avec le moteur Product-Safety par exemple de vérifier 1 000 produits "
        "ou d'assurer le suivi hebdomadaire de 100 articles pendant 10 semaines)."
    ),
    "nl": (
        "Mocht u bij het Apify-platform nog geen account hebben: "
        "u kunt zich gratis registreren en ontvangt $ 5 starttegoed "
        "(waarmee u met de Product-Safety engine bijv. 1.000 producten kunt laten controleren "
        "of 100 artikelen gedurende 10 weken wekelijks kunt monitoren)."
    ),
    "en": (
        "If you do not have an account on the Apify platform yet: "
        "registration is free and includes $5 in welcome credits "
        "(allowing you with the Product-Safety engine, for example, to screen 1,000 products "
        "or monitor 100 SKUs weekly over 10 weeks)."
    ),
}

# Weiterfuehrende Apify-Erläuterungen
APIFY_INTRO_SNIPPETS = {
    "de": (
        f"Wenn Sie anschließend mit dem Ergebnis zufrieden sind, können Sie für die weitere "
        f"Verwendung meiner entwickelten Engine „Product-Safety“ über die international renommierte "
        f"SaaS-Plattform Apify zugreifen - zuverlässig und nahtlos an Ihre IT-Systeme angebunden. "
        f"Hier der Link: {APIFY_ACTOR_URL}"
    ),
    "fr": (
        f"Si vous êtes ensuite satisfait du résultat, vous pourrez accéder pour la suite à mon moteur "
        f"« Product-Safety » via la plateforme SaaS reconnue Apify – de manière fiable et parfaitement "
        f"intégrée à vos systèmes informatiques. Voici le lien : {APIFY_ACTOR_URL}"
    ),
    "nl": (
        f"Indien u vervolgens tevreden bent over het resultaat, kunt u voor het verdere gebruik van "
        f"mijn ontwikkelde engine \"Product-Safety\" terecht via het internationaal gerenommeerde "
        f"SaaS-platform Apify – betrouwbaar en naadloos gekoppeld aan uw IT-systemen. Hier is de link: {APIFY_ACTOR_URL}"
    ),
    "en": (
        f"If you are subsequently satisfied with the results, you can access my \"Product-Safety\" "
        f"engine for continued use via the internationally renowned SaaS platform Apify – reliably "
        f"and seamlessly integrated into your IT systems. Here is the link: {APIFY_ACTOR_URL}"
    ),
}


def normalize_language_code(lang: Optional[str]) -> str:
    """Normalisiert Sprachcodes (z. B. 'FR', 'fr-FR', 'France', 'Dutch' -> 'fr', 'nl', 'de', 'en')."""
    if not lang:
        return "de"
    l = str(lang).strip().lower()
    if l.startswith("fr") or "french" in l or "france" in l:
        return "fr"
    if l.startswith("nl") or "dutch" in l or "netherland" in l or "holland" in l:
        return "nl"
    if l.startswith("de") or "german" in l or "deutsch" in l or "austria" in l:
        return "de"
    if l.startswith("en") or "engl" in l or "uk" in l or "us" in l:
        return "en"
    if l in ("es", "it", "pl"):
        # Fuer diese Sprachen nutzen wir Englisch als Business-Standard
        return "en"
    return "de"


@dataclass
class ResponseDraft:
    """Repraesentiert einen vollstaendigen Antwort-Mailentwurf."""
    draft_id: str
    lead_email: str
    company: str
    language: str
    subject: str
    body: str
    status: str = DraftStatus.PENDING_REVIEW
    intent: str = "POSITIVE_TEST_REQUEST"
    in_reply_to: Optional[str] = None
    references: Optional[str] = None
    report_text: Optional[str] = None
    report_markdown: Optional[str] = None
    meta: Dict[str, Any] = field(default_factory=dict)
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )
    updated_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    def to_dict(self) -> Dict[str, Any]:
        """Konvertiert den Draft in ein JSON-serialisierbares Dictionary."""
        return asdict(self)


class ResponseDrafter:
    """
    Erzeugt hochgradig personalisierte Antwort-Entwuerfe in FR, NL, DE, EN
    und reiht sie in die HITL-Review-Queue ein.
    """

    def __init__(
        self,
        queue: Optional[ReviewQueue] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
    ) -> None:
        self.queue = queue or get_default_queue()
        self.blacklist_mgr = blacklist_mgr or getattr(self.queue, "blacklist_mgr", get_default_manager())

    def draft_response(
        self,
        lead: Union[Dict[str, Any], str],
        inbound_message: Optional[Dict[str, Any]] = None,
        report_data: Optional[Union[AuditRunReport, List[AuditResult], Dict[str, Any], str]] = None,
        language: Optional[str] = None,
        intent: Optional[str] = None,
        data_date: Optional[str] = None,
        draft_id: Optional[str] = None,
    ) -> ResponseDraft:
        """
        Erstellt einen personalisierten Antwortentwurf gemaess den Akzeptanzkriterien:
        1. Hochgradig personalisiert in Sprache des Leads (FR/NL/DE/EN)
        2. Fuegt Auswertungs-Report mit Standard-Disclaimer und 0-Treffer-Hinweis ein
        3. Enthaelt Apify Actor Link und 5$ Willkommensguthaben-Hinweis
        4. Eindeutige draft_id und Status PENDING_REVIEW
        """
        # Lead-Daten vorbereiten
        if isinstance(lead, str):
            lead_data = {"email": lead, "company": lead.split("@")[0].capitalize()}
        elif isinstance(lead, dict):
            lead_data = dict(lead)
        else:
            lead_data = {}

        lead_email = normalize_email(lead_data.get("email") or lead_data.get("lead_email") or "")
        company = str(lead_data.get("company") or "Ihr Unternehmen").strip()
        contact_name = str(lead_data.get("contact_name") or lead_data.get("name") or "").strip()

        # Sprache bestimmen
        eff_lang = normalize_language_code(
            language or lead_data.get("language") or (inbound_message.get("language") if inbound_message else None)
        )

        eff_intent = intent or (inbound_message.get("intent") if inbound_message else None) or "POSITIVE_TEST_REQUEST"

        # Eindeutige draft_id
        if not draft_id:
            draft_id = ReviewQueue.generate_draft_id()

        # Threading-Header
        in_reply_to: Optional[str] = None
        references: Optional[str] = None
        orig_subject = ""
        if inbound_message:
            in_reply_to = inbound_message.get("message_id")
            orig_references = inbound_message.get("references") or ""
            if in_reply_to:
                references = f"{orig_references} {in_reply_to}".strip()
            orig_subject = inbound_message.get("subject", "")

        if not orig_subject:
            orig_subject = lead_data.get("subject", "")

        # Betreff generieren
        subject = self._build_subject(eff_lang, company, orig_subject)

        # Auswertungs-Report & Disclaimer generieren
        report_text, report_md = self._build_report(report_data, data_date=data_date, language=eff_lang)

        # Mail-Körper erstellen
        body = self._build_body(
            lang=eff_lang,
            company=company,
            contact_name=contact_name,
            report_text=report_text,
            intent=eff_intent,
        )

        draft = ResponseDraft(
            draft_id=draft_id,
            lead_email=lead_email,
            company=company,
            language=eff_lang,
            subject=subject,
            body=body,
            status=DraftStatus.PENDING_REVIEW,
            intent=eff_intent,
            in_reply_to=in_reply_to,
            references=references,
            report_text=report_text,
            report_markdown=report_md,
            meta={
                "data_date": format_safety_gate_date(data_date),
                "generated_by": "ProductSafetyEngine Targeted Response Drafter",
                "lead_country": lead_data.get("country", ""),
            },
        )
        return draft

    def enqueue_draft(
        self,
        draft: Union[ResponseDraft, Dict[str, Any]],
        check_blacklist: bool = True,
    ) -> Dict[str, Any]:
        """
        Reiht einen Entwurf in die ReviewQueue (.crm/review_queue.json) ein.
        Status: PENDING_REVIEW.
        """
        return self.queue.add_draft(draft, check_blacklist=check_blacklist)

    def draft_and_enqueue(
        self,
        lead: Union[Dict[str, Any], str],
        inbound_message: Optional[Dict[str, Any]] = None,
        report_data: Optional[Union[AuditRunReport, List[AuditResult], Dict[str, Any], str]] = None,
        language: Optional[str] = None,
        intent: Optional[str] = None,
        data_date: Optional[str] = None,
        draft_id: Optional[str] = None,
        check_blacklist: bool = True,
    ) -> Dict[str, Any]:
        """
        Kombinierte Helfer-Methode:
        Erzeugt den personalisierten Entwurf und reiht ihn direkt in die Review Queue ein.
        """
        draft = self.draft_response(
            lead=lead,
            inbound_message=inbound_message,
            report_data=report_data,
            language=language,
            intent=intent,
            data_date=data_date,
            draft_id=draft_id,
        )
        return self.enqueue_draft(draft, check_blacklist=check_blacklist)

    # -----------------------------------------------------------------------
    # Interne Formatierungs- & Template-Methoden
    # -----------------------------------------------------------------------

    def _build_subject(self, lang: str, company: str, orig_subject: str) -> str:
        """Erzeugt eine saubere Betreffzeile mit Re: Praefix."""
        if orig_subject:
            clean = clean_subject_prefix(orig_subject)
            if clean:
                return f"Re: {clean}"

        if lang == "fr":
            return f"Re: Vérification Safety Gate pour {company}"
        elif lang == "nl":
            return f"Re: Safety Gate controle voor {company}"
        elif lang == "en":
            return f"Re: Safety Gate compliance check for {company}"
        return f"Re: Safety-Gate-Abgleich für {company}"

    def _build_report(
        self,
        report_data: Optional[Union[AuditRunReport, List[AuditResult], Dict[str, Any], str]],
        data_date: Optional[str] = None,
        language: str = "de",
    ) -> tuple[str, str]:
        """
        Erzeugt Text- und Markdown-Reports inklusive des zwingenden Standard-Disclaimers
        und des Sicherheits-Hinweises bei 0 Treffern.
        """
        formatted_date = format_safety_gate_date(data_date)
        standard_disclaimer = get_standard_disclaimer(formatted_date)
        zero_hits_note = get_zero_hits_note()

        # Fall 1: Bereits ein formatierter String
        if isinstance(report_data, str) and report_data.strip():
            rep = report_data.strip()
            # Pruefen ob Disclaimer enthalten ist
            if standard_disclaimer not in rep:
                rep = f"{rep}\n\nStandard-Disclaimer:\n{standard_disclaimer}\n\nHinweis:\n{zero_hits_note}"
            return rep, rep

        # Fall 2: Strukturierte Daten (AuditRunReport, List[AuditResult], Dict)
        if report_data is not None:
            text_rep = generate_text_report(report_data, data_date=formatted_date, language=language)
            md_rep = generate_markdown_report(report_data, data_date=formatted_date, language=language)
            return text_rep, md_rep

        # Fall 3: Kein Report uebergeben -> Standard-Initialreport erzeugen
        mock_report_dict = {
            "data_date": formatted_date,
            "results": [],
            "total_checked": 0,
            "total_hits": 0,
        }
        text_rep = generate_text_report(mock_report_dict, data_date=formatted_date, language=language)
        md_rep = generate_markdown_report(mock_report_dict, data_date=formatted_date, language=language)
        return text_rep, md_rep

    def _build_body(
        self,
        lang: str,
        company: str,
        contact_name: str,
        report_text: str,
        intent: str,
    ) -> str:
        """Baut den vollstaendigen E-Mail-Körper in der gewuenschten Kundensprache."""
        welcome_credit = WELCOME_CREDIT_SNIPPETS.get(lang, WELCOME_CREDIT_SNIPPETS["de"])
        apify_intro = APIFY_INTRO_SNIPPETS.get(lang, APIFY_INTRO_SNIPPETS["de"])

        if lang == "fr":
            salutation = f"Bonjour {contact_name}," if contact_name else "Madame, Monsieur,"
            body = f"""{salutation}

Merci pour votre retour et votre intérêt pour notre moteur de conformité « Product-Safety ».

Comme convenu, j'ai effectué le contrôle de conformité pour {company} par rapport à la base officielle européenne EU Safety Gate. Vous trouverez ci-dessous le rapport d'analyse structuré :

--------------------------------------------------------------------------------
{report_text}
--------------------------------------------------------------------------------

{apify_intro}

{welcome_credit}

Si vous avez d'autres articles ou fichiers de catalogue (CSV, Excel ou liste d'EAN) que vous souhaitez faire vérifier, n'hésitez pas à me les transmettre directement en réponse à cet email.

Bien cordialement depuis l'Allemagne,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Allemagne
Mentions légales & Confidentialité : thfc-consulting.de/impressum

Pas intéressé par d'autres échanges ? Répondez simplement « Non » et je ne vous recontacterai pas.
"""
        elif lang == "nl":
            salutation = f"Beste {contact_name}," if contact_name else "Geachte heer, mevrouw,"
            body = f"""{salutation}

Hartelijk dank voor uw reactie en uw interesse in onze compliance-engine "Product-Safety".

Zoals besproken heb ik de controle voor {company} uitgevoerd ten opzichte van de officiële Europese EU Safety Gate-database. Hieronder treft u het gestructureerde analyserapport aan:

--------------------------------------------------------------------------------
{report_text}
--------------------------------------------------------------------------------

{apify_intro}

{welcome_credit}

Mocht u aanvullende artikelen of catalogusbestanden (CSV, Excel of EAN-lijst) willen laten controleren, dan kunt u deze eenvoudig rechtstreeks als reactie op deze e-mail toesturen.

Met vriendelijke groet uit Duitsland,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Duitsland
Colofon & Privacy : thfc-consulting.de/impressum

Geen interesse in verdere berichten? Antwoord dan simpelweg met "Nee", dan neem ik geen contact meer met u op.
"""
        elif lang == "en":
            salutation = f"Dear {contact_name}," if contact_name else "Dear Sir or Madam,"
            body = f"""{salutation}

Thank you for your reply and your interest in our "Product-Safety" compliance engine.

As requested, I have screened the product data for {company} against the official EU Safety Gate database. Please find the structured audit report below:

--------------------------------------------------------------------------------
{report_text}
--------------------------------------------------------------------------------

{apify_intro}

{welcome_credit}

If you have additional product catalogues or inventory files (CSV, Excel, or EAN lists) you would like screened, please feel free to send them directly in reply to this email.

Best regards from Germany,
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden, Germany
Legal Notice & Privacy : thfc-consulting.de/impressum

Not interested in further updates? Simply reply "No" and I will not contact you again.
"""
        else: # de (Standard)
            salutation = f"Sehr geehrte/r Frau/Herr {contact_name}," if contact_name else "Sehr geehrte Damen und Herren,"
            body = f"""{salutation}

vielen Dank für Ihre Rückmeldung und Ihr Interesse an unserer Product-Safety Engine.

Wie gewünscht habe ich den automatisierten Rechercheabgleich für {company} gegen den offiziellen Datenbestand des EU Safety Gate durchgeführt. Nachfolgend finden Sie den strukturierten Auswertungs-Report:

--------------------------------------------------------------------------------
{report_text}
--------------------------------------------------------------------------------

{apify_intro}

{welcome_credit}

Falls Sie weitere Artikel oder Sortimentslisten (CSV, Excel oder EAN-Listen) prüfen lassen möchten, können Sie mir diese gerne jederzeit direkt als Antwort auf diese E-Mail zukommen lassen.

Mit freundlichen Grüßen
Thomas Hartmannsgruber
THFC Consulting · thfc-consulting.de
Großheppacherstraße 16/1 · 71364 Winnenden
Impressum & Datenschutz: thfc-consulting.de/impressum

Kein Interesse an weiteren Nachrichten? Antworten Sie einfach kurz mit „Nein“ – dann melde ich mich nicht wieder.
"""
        return body.strip() + "\n"


# Modulfunktionen
_default_drafter: Optional[ResponseDrafter] = None


def get_default_drafter() -> ResponseDrafter:
    global _default_drafter
    if _default_drafter is None:
        _default_drafter = ResponseDrafter()
    return _default_drafter


def draft_response(
    lead: Union[Dict[str, Any], str],
    inbound_message: Optional[Dict[str, Any]] = None,
    report_data: Optional[Union[AuditRunReport, List[AuditResult], Dict[str, Any], str]] = None,
    language: Optional[str] = None,
    intent: Optional[str] = None,
    data_date: Optional[str] = None,
) -> ResponseDraft:
    """Modulfunktion zur Erstellung eines personalisierten Mailentwurfs."""
    return get_default_drafter().draft_response(
        lead=lead,
        inbound_message=inbound_message,
        report_data=report_data,
        language=language,
        intent=intent,
        data_date=data_date,
    )


def draft_and_enqueue(
    lead: Union[Dict[str, Any], str],
    inbound_message: Optional[Dict[str, Any]] = None,
    report_data: Optional[Union[AuditRunReport, List[AuditResult], Dict[str, Any], str]] = None,
    language: Optional[str] = None,
    intent: Optional[str] = None,
    data_date: Optional[str] = None,
    check_blacklist: bool = True,
) -> Dict[str, Any]:
    """Modulfunktion zur Erstellung und sofortigen Einreihung in die Review Queue."""
    return get_default_drafter().draft_and_enqueue(
        lead=lead,
        inbound_message=inbound_message,
        report_data=report_data,
        language=language,
        intent=intent,
        data_date=data_date,
        check_blacklist=check_blacklist,
    )
