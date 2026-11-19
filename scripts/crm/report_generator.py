"""
scripts/crm/report_generator.py
ProductSafetyEngine Structured Audit Report & Disclaimer Generator.

Erzeugt strukturierte Auswertungs-Reports fuer B2B-Kunden und HITL-Mail-Entwuerfe
mit den gesetzlich und regulatorisch zwingenden Schutz-Disclaimern:

1. Zwingender Standard-Disclaimer mit dynamischem Datumsstempel:
   'Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom TT.MM.JJJJ'

2. Zwingender Sicherheits-Hinweis bei 0 Treffern bzw. im Report:
   'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).'

Unterstuetzt Text-, Markdown- und strukturierte Datenformate sowie
mehrsprachige Ergaenzungen (FR, NL, EN).
"""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Dict, List, Optional, Union

from scripts.crm.engine_runner import (
    AuditHit,
    AuditItem,
    AuditResult,
    AuditRunReport,
)

# Zwingende Invarianten-Texte
STANDARD_DISCLAIMER_TEMPLATE = (
    "Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom {date}"
)

ZERO_HITS_NOTE = (
    "Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN)."
)

# Mehrsprachige Uebersetzungen fuer Outreach-Antworten
MULTILINGUAL_TRANSLATIONS = {
    "fr": {
        "title": "Rapport de conformité EU Safety Gate",
        "summary": "Résumé de l'audit",
        "checked": "articles vérifiés",
        "hits": "signalement(s) critique(s)",
        "clean": "sans signalement direct",
        "hit_status": "SIGNALEMENT DÉTECTÉ",
        "clean_status": "Aucun signalement",
        "risk_type": "Type de risque",
        "country": "Pays d'origine",
        "disclaimer_note": "Contrôle technique documentaire, ne constitue pas un conseil juridique.",
    },
    "nl": {
        "title": "EU Safety Gate Conformiteitsrapport",
        "summary": "Overzicht van de audit",
        "checked": "artikelen gecontroleerd",
        "hits": "kritieke melding(en)",
        "clean": "zonder directe melding",
        "hit_status": "MELDING GEVONDEN",
        "clean_status": "Geen melding",
        "risk_type": "Risicotype",
        "country": "Land van herkomst",
        "disclaimer_note": "Technische documentcontroles, geen juridisch advies.",
    },
    "en": {
        "title": "EU Safety Gate Compliance Report",
        "summary": "Audit Summary",
        "checked": "items checked",
        "hits": "alert(s) identified",
        "clean": "no direct alerts",
        "hit_status": "ALERT DETECTED",
        "clean_status": "No alert found",
        "risk_type": "Risk type",
        "country": "Country of origin",
        "disclaimer_note": "Technical screening only, does not constitute legal advice.",
    },
}


def format_safety_gate_date(date_val: Optional[Union[str, datetime]] = None) -> str:
    """
    Formatiert ein Datum in das Format TT.MM.JJJJ (z. B. 13.11.2026).
    Akzeptiert ISO-Strings, Slash-Strings (13/11/2026) oder datetime-Objekte.
    """
    if not date_val:
        return "13.11.2026"

    if isinstance(date_val, datetime):
        return date_val.strftime("%d.%m.%Y")

    s = str(date_val).strip()
    # Format: 13/11/2026 -> 13.11.2026
    if "/" in s:
        parts = s.split("/")
        if len(parts) == 3:
            return f"{parts[0].zfill(2)}.{parts[1].zfill(2)}.{parts[2]}"

    # Format: 2026-11-13 -> 13.11.2026
    if "-" in s:
        parts = s.split("-")
        if len(parts) == 3 and len(parts[0]) == 4:
            return f"{parts[2].zfill(2)}.{parts[1].zfill(2)}.{parts[0]}"

    # Bereits TT.MM.JJJJ
    if "." in s:
        return s

    return s


def get_standard_disclaimer(date_str: Optional[Union[str, datetime]] = None) -> str:
    """
    Erzeugt den zwingenden Standard-Disclaimer mit Datum:
    'Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom TT.MM.JJJJ'
    """
    formatted_date = format_safety_gate_date(date_str)
    return STANDARD_DISCLAIMER_TEMPLATE.format(date=formatted_date)


def get_zero_hits_note() -> str:
    """
    Liefert den zwingenden Hinweis zu Non-Hit-Szenarien:
    'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).'
    """
    return ZERO_HITS_NOTE


def generate_text_report(
    report_data: Union[AuditRunReport, List[AuditResult], Dict[str, Any]],
    data_date: Optional[str] = None,
    language: str = "de",
) -> str:
    """
    Erzeugt einen strukturierten Reintext-Report inklusive Standard-Disclaimer und Hinweis.
    """
    results: List[AuditResult] = []
    eff_date = data_date or "13.11.2026"

    if isinstance(report_data, AuditRunReport):
        results = report_data.results
        if report_data.data_date:
            eff_date = report_data.data_date
    elif isinstance(report_data, list):
        results = report_data
    elif isinstance(report_data, dict):
        raw_results = report_data.get("results", [])
        if "data_date" in report_data and report_data["data_date"]:
            eff_date = report_data["data_date"]
        # Falls dicts uebergeben wurden
        for r in raw_results:
            if isinstance(r, AuditResult):
                results.append(r)
            elif isinstance(r, dict):
                item = AuditItem(
                    gtin=r.get("gtin", ""),
                    product_name=r.get("product_name", ""),
                )
                hits = [
                    AuditHit(**h) if isinstance(h, dict) else h
                    for h in r.get("hits", [])
                ]
                results.append(
                    AuditResult(item=item, found=r.get("found", False), hits=hits)
                )

    formatted_date = format_safety_gate_date(eff_date)
    total_checked = len(results)
    total_hits = sum(1 for r in results if r.found)
    total_clean = total_checked - total_hits

    lines: List[str] = []
    lines.append("================================================================================")
    lines.append("PRODUCT SAFETY ENGINE — EU SAFETY GATE (RAPEX) AUDIT-REPORT")
    lines.append("================================================================================")
    lines.append(f"Prüfstand / Datenstand : {formatted_date}")
    lines.append(f"Geprüfte Artikel       : {total_checked}")
    lines.append(f"Treffer (Sicherheitswarnungen) : {total_hits}")
    lines.append(f"Unauffällige Barcodes          : {total_clean}")
    lines.append("--------------------------------------------------------------------------------")
    lines.append("DETAIL-ERGEBNISSE:")
    lines.append("")

    if not results:
        lines.append("Keine Artikel zur Prüfung übergeben.")
        lines.append("")
    else:
        for idx, res in enumerate(results, 1):
            status_symbol = "⚠️ [TREFFER]" if res.found else "✅ [KEIN TREFFER]"
            name_str = f" - {res.product_name}" if res.product_name else ""
            lines.append(f"#{idx:02d} {status_symbol} GTIN/EAN: {res.gtin}{name_str}")

            if res.found:
                for hit in res.hits:
                    lines.append(f"     Fallnummer       : {hit.case_number or hit.alert_number}")
                    lines.append(f"     Produktrisiko    : {hit.risk_type or 'N/A'}")
                    lines.append(f"     Risikostufe      : {hit.risk_level or 'Serious risk'}")
                    lines.append(f"     Herkunftsland    : {hit.country_of_origin or 'Unbekannt'}")
                    if hit.notifying_country:
                        lines.append(f"     Meldebehörde     : {hit.notifying_country}")
                    if hit.danger_description:
                        # Gekuerzte Gefahrenbeschreibung
                        short_danger = (
                            hit.danger_description[:160] + "..."
                            if len(hit.danger_description) > 160
                            else hit.danger_description
                        )
                        lines.append(f"     Gefahr           : {short_danger}")
                    if hit.measures:
                        short_meas = (
                            hit.measures[:140] + "..."
                            if len(hit.measures) > 140
                            else hit.measures
                        )
                        lines.append(f"     Maßnahme         : {short_meas}")
                    if hit.source_url:
                        lines.append(f"     Referenz-Link    : {hit.source_url}")
            else:
                lines.append("     Status           : Kein behördlicher RAPEX-Treffer für diese EAN.")

            lines.append("")

    # Zwingender Disclaimer- & Hinweis-Abschnitt
    lines.append("--------------------------------------------------------------------------------")
    lines.append("WICHTIGE HINWEISE & DISCLAIMER:")
    lines.append(f"- {ZERO_HITS_NOTE}")
    lines.append(f"- {get_standard_disclaimer(formatted_date)}")
    lines.append("================================================================================")

    return "\n".join(lines)


def generate_markdown_report(
    report_data: Union[AuditRunReport, List[AuditResult], Dict[str, Any]],
    data_date: Optional[str] = None,
    language: str = "de",
) -> str:
    """
    Erzeugt einen strukturierten GitHub-Flavored-Markdown-Report.
    """
    results: List[AuditResult] = []
    eff_date = data_date or "13.11.2026"

    if isinstance(report_data, AuditRunReport):
        results = report_data.results
        if report_data.data_date:
            eff_date = report_data.data_date
    elif isinstance(report_data, list):
        results = report_data
    elif isinstance(report_data, dict):
        raw_results = report_data.get("results", [])
        if "data_date" in report_data and report_data["data_date"]:
            eff_date = report_data["data_date"]
        for r in raw_results:
            if isinstance(r, AuditResult):
                results.append(r)
            elif isinstance(r, dict):
                item = AuditItem(
                    gtin=r.get("gtin", ""),
                    product_name=r.get("product_name", ""),
                )
                hits = [
                    AuditHit(**h) if isinstance(h, dict) else h
                    for h in r.get("hits", [])
                ]
                results.append(
                    AuditResult(item=item, found=r.get("found", False), hits=hits)
                )

    formatted_date = format_safety_gate_date(eff_date)
    total_checked = len(results)
    total_hits = sum(1 for r in results if r.found)
    total_clean = total_checked - total_hits

    md: List[str] = []
    md.append("### ProductSafetyEngine — EU Safety Gate Audit-Report")
    md.append("")
    md.append(f"**Datenstand:** EU Safety Gate vom {formatted_date} | **Geprüft:** {total_checked} Artikel | **Treffer:** {total_hits} | **Unauffällig:** {total_clean}")
    md.append("")

    if results:
        md.append("| Status | EAN / GTIN | Produktname | Produktrisiko | Herkunftsland | Fallnummer |")
        md.append("| :--- | :--- | :--- | :--- | :--- | :--- |")

        for res in results:
            clean_name = res.product_name or "-"
            if res.found:
                hit = res.hits[0] if res.hits else AuditHit()
                status = "⚠️ **TREFFER**"
                risk = hit.risk_type or "Gefahr gemeldet"
                origin = hit.country_of_origin or "Unbekannt"
                case_no = hit.case_number or hit.alert_number or "-"
            else:
                status = "✅ Kein Treffer"
                risk = "-"
                origin = "-"
                case_no = "-"

            md.append(f"| {status} | `{res.gtin}` | {clean_name} | {risk} | {origin} | {case_no} |")

        md.append("")

    # Zwingender Standard-Disclaimer und Hinweis
    md.append("> [!NOTE]")
    md.append(f"> **Sicherheits-Hinweis:** {ZERO_HITS_NOTE}")
    md.append(">")
    md.append(f"> **Standard-Disclaimer:** {get_standard_disclaimer(formatted_date)}")

    return "\n".join(md)


def generate_report(
    report_data: Union[AuditRunReport, List[AuditResult], Dict[str, Any]],
    format: str = "text",
    data_date: Optional[str] = None,
    language: str = "de",
) -> str:
    """
    Zentrale Report-Generierungs-Funktion.
    Unterstuetzt die Formate 'text', 'markdown' / 'md'.
    """
    fmt = str(format or "text").strip().lower()
    if fmt in ("markdown", "md"):
        return generate_markdown_report(
            report_data=report_data, data_date=data_date, language=language
        )
    return generate_text_report(
        report_data=report_data, data_date=data_date, language=language
    )
