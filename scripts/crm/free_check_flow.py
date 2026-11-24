"""
scripts/crm/free_check_flow.py
Automatisierter Ablauf fuer Gratis-Checks (10 SKUs) mit Upsell auf 490 € / 1.490 € B2B Audit.

Workflow:
1. Ingestion: Liest CSV, TSV oder XLSX-Anhaenge aus Inbound-Mails ein.
2. Schutz: Erkennt Excel-Exponentialnotation und kuerzende Rundung (B1) fail-closed.
3. Begrenzung: Hoechstens 10 SKUs werden gratis geprueft; darueber Hinweis auf Vollaudit.
4. Screening: Sicherheitsabgleich gegen den EU Safety Gate RAPEX-Bestand (Barcodes & Checksumme).
5. B2B Multi-Format Report: Strukturierte Auswertung mit § 2 RDG-Disclaimer.
6. Upsell & Monetarisierung: Stripe Checkout Links fuer 490 € (Portfolio Audit) und 1.490 € (Audit Plus).
7. Review-Queue (HITL): Entwurf landet standardmaessig in der ReviewQueue (PENDING_REVIEW)
   inklusive Telegram-Benachrichtigung mit Genehmigungs-Option.
"""

from __future__ import annotations

import csv
import html
import io
import json
import logging
import re
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

from scripts.crm.blacklist import BlacklistedRecipientError, BlacklistManager, normalize_email
from scripts.crm.engine_runner import (
    AuditItem,
    SafetyGateEngine,
    validate_gtin_checksum,
)
from scripts.crm.report_generator import (
    STANDARD_DISCLAIMER_TEMPLATE,
    format_safety_gate_date,
    get_standard_disclaimer,
)
from scripts.crm.review_queue import DraftStatus, ReviewQueue, get_default_queue
from scripts.crm.storage import CRMStorage, LeadStatus, get_default_storage
from scripts.crm.stripe_checkout import generate_checkout_link, generate_pitch_snippet

logger = logging.getLogger("CRM.FreeCheckFlow")

# Maximum SKUs gratis
MAX_FREE_CHECK_SKUS = 10

# Sicherheits- und Ressourcenschranken (Zip-Bomb- und Memory-Exhaustion-Schutz)
MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024  # 10 MB Dateigroesse
MAX_UNCOMPRESSED_ZIP_BYTES = 25 * 1024 * 1024  # 25 MB unkomprimiert
MAX_PARSED_ROWS = 200  # Ausreichend fuer 10-SKU Screening plus Puffer

# Regex fuer Excel Exponentialnotation (z. B. 4.00638E+12)
_SCI_NOTATION_RE = re.compile(r"^\s*([+-]?\d+(?:\.\d+)?)[eE]([+-]?\d+)\s*$")


def is_scientific_notation(val: str) -> bool:
    """Prueft, ob ein Wert in Exponentialnotation vorliegt (Datenverlust in Excel)."""
    if not val or not isinstance(val, str):
        return False
    return bool(_SCI_NOTATION_RE.match(val.strip()))


def is_suspect_zero_padded(val: str) -> bool:
    """Prueft, ob ein EAN-String auf >= 5 Nullen endet (typisches Excel Float-Truncation Artefakt)."""
    digits = re.sub(r"\D", "", str(val or ""))
    if len(digits) in (13, 14) and digits.endswith("00000"):
        return True
    return False


# ==============================================================================
# 1. ATTACHMENT PARSER (CSV, TSV, XLSX OHNE EXTERNE ABHAENGIGKEITEN)
# ==============================================================================

def parse_xlsx_sheets(data_bytes: bytes) -> List[List[str]]:
    """
    Parst das erste Arbeitsblatt einer XLSX-Datei ausschliesslich mit
    den Python-Standardmodulen zipfile und xml.etree.ElementTree.
    Enthaelt Ressourcenschranken gegen Zip-Bombs und Memory-Exhaustion.
    """
    if not data_bytes or len(data_bytes) > MAX_ATTACHMENT_BYTES:
        logger.warning(f"[FreeCheck] XLSX-Datei leer oder Groesse {len(data_bytes) if data_bytes else 0} > {MAX_ATTACHMENT_BYTES} Bytes.")
        return []

    rows: List[List[str]] = []
    try:
        with zipfile.ZipFile(io.BytesIO(data_bytes)) as z:
            # Schutz vor Zip-Bombs: Unkomprimierte Gesamtgroesse vor Extraktion validieren
            total_uncompressed = sum(info.file_size for info in z.infolist())
            if total_uncompressed > MAX_UNCOMPRESSED_ZIP_BYTES:
                logger.warning(
                    f"[FreeCheck] Zip-Bomb Verdacht: Unkomprimierte Groesse {total_uncompressed} Bytes > {MAX_UNCOMPRESSED_ZIP_BYTES} Bytes."
                )
                return []

            # 1. Shared Strings einlesen
            shared_strings: List[str] = []
            if "xl/sharedStrings.xml" in z.namelist():
                ss_tree = ET.fromstring(z.read("xl/sharedStrings.xml"))
                ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
                for si in ss_tree.findall(".//main:si", ns) or ss_tree.findall(".//si"):
                    texts = [t.text or "" for t in (si.findall(".//main:t", ns) or si.findall(".//t"))]
                    shared_strings.append("".join(texts))

            # 2. Erstes Worksheet suchen
            sheet_names = [n for n in z.namelist() if n.startswith("xl/worksheets/sheet") and n.endswith(".xml")]
            if not sheet_names:
                return []
            sheet_names.sort()
            ws_tree = ET.fromstring(z.read(sheet_names[0]))

            ns = {"main": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
            row_nodes = ws_tree.findall(".//main:row", ns) or ws_tree.findall(".//row")

            for r_node in row_nodes:
                if len(rows) >= MAX_PARSED_ROWS:
                    break
                c_nodes = r_node.findall(".//main:c", ns) or r_node.findall(".//c")
                row_vals: List[str] = []
                for c in c_nodes:
                    cell_type = c.get("t", "")
                    v_node = c.find(".//main:v", ns) if c.find(".//main:v", ns) is not None else c.find(".//v")
                    val_text = v_node.text if v_node is not None and v_node.text is not None else ""

                    if cell_type == "s" and val_text.isdigit():
                        idx = int(val_text)
                        cell_val = shared_strings[idx] if idx < len(shared_strings) else ""
                    elif cell_type == "inlineStr":
                        t_node = c.find(".//main:t", ns) or c.find(".//t")
                        cell_val = t_node.text if t_node is not None and t_node.text is not None else ""
                    else:
                        cell_val = val_text
                    row_vals.append(cell_val.strip())
                if any(row_vals):
                    rows.append(row_vals)
    except Exception as exc:
        logger.warning(f"[FreeCheck] Fehler beim Parsen der XLSX-Datei: {exc}")
        return []

    return rows


def parse_attachment_items(filename: str, content: Union[bytes, str]) -> List[Dict[str, Any]]:
    """
    Parst Tabellendaten aus CSV, TSV oder XLSX.
    Gibt normalisierte Dictionaries mit sku, ean, title, brand, warning zurueck.
    """
    filename_lower = filename.lower()
    raw_rows: List[List[str]] = []

    # Schutz vor uebergrossen Anhaengen
    content_len = len(content) if isinstance(content, (bytes, str)) else 0
    if content_len > MAX_ATTACHMENT_BYTES:
        logger.warning(f"[FreeCheck] Anhang {filename} ueberschreitet Maximalgroesse von {MAX_ATTACHMENT_BYTES} Bytes.")
        return []

    if filename_lower.endswith(".xlsx"):
        content_bytes = content if isinstance(content, bytes) else content.encode("utf-8", errors="replace")
        raw_rows = parse_xlsx_sheets(content_bytes)
    elif filename_lower.endswith((".csv", ".tsv", ".txt")):
        text_str = content.decode("utf-8", errors="replace") if isinstance(content, bytes) else str(content)
        sample = text_str[:2048]
        delimiter = "\t" if "\t" in sample or filename_lower.endswith(".tsv") else (";" if sample.count(";") > sample.count(",") else ",")
        reader = csv.reader(io.StringIO(text_str), delimiter=delimiter)
        for r in reader:
            if any(cell.strip() for cell in r):
                raw_rows.append([cell.strip() for cell in r])
                if len(raw_rows) >= MAX_PARSED_ROWS:
                    break

    if not raw_rows:
        return []

    # Spaltenidentifikation
    header = [h.lower() for h in raw_rows[0]]
    col_sku = -1
    col_ean = -1
    col_title = -1
    col_brand = -1

    for idx, name in enumerate(header):
        if any(k in name for k in ("sku", "artikelnummer", "asin", "item-sku", "seller-sku")):
            if col_sku == -1: col_sku = idx
        if any(k in name for k in ("ean", "gtin", "barcode", "upc", "product-id")):
            if col_ean == -1: col_ean = idx
        if any(k in name for k in ("title", "titel", "name", "produkt", "item-name", "description")):
            if col_title == -1: col_title = idx
        if any(k in name for k in ("brand", "marke", "hersteller", "manufacturer")):
            if col_brand == -1: col_brand = idx

    # Falls keine Kopfzeile erkannt wurde, suchen wir heuristisch nach der ersten EAN-Spalte
    has_header = (col_ean != -1 or col_sku != -1 or col_title != -1)
    start_row = 1 if has_header else 0

    items: List[Dict[str, Any]] = []
    for r_idx, row in enumerate(raw_rows[start_row:], start=start_row + 1):
        if not row:
            continue

        raw_ean = row[col_ean] if col_ean != -1 and col_ean < len(row) else ""
        raw_sku = row[col_sku] if col_sku != -1 and col_sku < len(row) else f"SKU-{r_idx}"
        raw_title = row[col_title] if col_title != -1 and col_title < len(row) else ""
        raw_brand = row[col_brand] if col_brand != -1 and col_brand < len(row) else ""

        # Wenn keine EAN-Spalte definiert war: Suche erste Ziffernfolge der Laenge 8, 12, 13, 14
        if not raw_ean:
            for cell in row:
                c_clean = re.sub(r"\D", "", cell)
                if len(c_clean) in (8, 12, 13, 14):
                    raw_ean = cell
                    break

        warning = None
        clean_ean = ""

        # B1 Prüfung: Exponentialnotation oder verdächtiges Zero-Padding
        if is_scientific_notation(raw_ean):
            warning = "EAN_CORRUPTED_EXCEL"
            clean_ean = ""
        elif is_suspect_zero_padded(raw_ean):
            warning = "EAN_SUSPECT_TRUNCATED"
            clean_ean = ""
        else:
            digits = re.sub(r"\D", "", str(raw_ean or ""))
            if len(digits) in (8, 12, 13, 14):
                if validate_gtin_checksum(digits):
                    clean_ean = digits
                else:
                    warning = "INVALID_EAN_CHECKSUM"

        items.append({
            "row": r_idx,
            "sku": raw_sku or f"SKU-{r_idx}",
            "ean": clean_ean,
            "raw_ean": raw_ean,
            "title": raw_title,
            "brand": raw_brand,
            "warning": warning,
        })

    return items


# ==============================================================================
# 2. FREE CHECK ENGINE & DISPATCHER
# ==============================================================================

@dataclass
class FreeCheckResult:
    sender_email: str
    company: str
    total_items: int
    screened_items: int
    truncated: bool
    barcode_hits: int
    corrupted_count: int
    report_markdown: str
    report_html: str
    stripe_link_490: str
    stripe_link_1490: str
    email_subject: str
    email_body_text: str
    email_body_html: str


def execute_free_check(
    sender_email: str,
    items: List[Dict[str, Any]],
    company: str = "",
    language: str = "de",
    engine: Optional[SafetyGateEngine] = None,
) -> FreeCheckResult:
    """
    Fuehrt das technische Screening fuer bis zu 10 SKUs aus
    und bereitet die Antwortmail inklusive B2B-Report und Stripe-Upsell vor.
    """
    norm_email = normalize_email(sender_email)
    total_count = len(items)
    screened_items_list = items[:MAX_FREE_CHECK_SKUS]
    truncated = total_count > MAX_FREE_CHECK_SKUS

    if engine is None:
        engine = SafetyGateEngine()

    barcode_hits = 0
    corrupted_count = 0
    audit_rows: List[Dict[str, Any]] = []

    for it in screened_items_list:
        ean = it.get("ean", "")
        sku = it.get("sku", "")
        title = it.get("title", "")
        warning = it.get("warning")

        if warning:
            corrupted_count += 1
            audit_rows.append({
                "sku": sku,
                "ean": it.get("raw_ean", ""),
                "status": "GELB_PRUEFUNG",
                "reason": f"Korrumpierte EAN ({warning}) - Manuelle Erfassung erforderlich",
            })
            continue

        if ean:
            hits = engine.lookup_barcode(ean)
            if hits:
                barcode_hits += 1
                hit = hits[0]
                audit_rows.append({
                    "sku": sku,
                    "ean": ean,
                    "status": "ROT_RUECKRUF",
                    "reason": f"EU Safety Gate Alert {hit.alert_number} ({hit.risk_type})",
                })
            else:
                audit_rows.append({
                    "sku": sku,
                    "ean": ean,
                    "status": "GRUEN_UNAUFFAELLIG",
                    "reason": "Keine behoerdliche Rueckrufmeldung erkannt",
                })
        else:
            audit_rows.append({
                "sku": sku,
                "ean": "-",
                "status": "GELB_FEHLT",
                "reason": "Keine EAN/GTIN im Datensatz vorhanden",
            })

    # Stripe Links generieren
    stripe_490 = generate_checkout_link("portfolio_audit", norm_email, company=company)
    stripe_1490 = generate_checkout_link("audit_plus", norm_email, company=company)

    # Markdown Report
    md_lines = [
        f"# EU Safety Gate Schnell-Audit: {company or norm_email}",
        f"**Datum:** {datetime.now(timezone.utc).strftime('%d.%m.%Y')} | **Gepruefte Artikel:** {len(screened_items_list)}/{total_count}\n",
        "| SKU | EAN | Ampel-Status | Befund / Risiko |",
        "| :--- | :--- | :---: | :--- |",
    ]
    for row in audit_rows:
        symbol = "🔴 ROT" if "ROT" in row["status"] else ("🟡 GELB" if "GELB" in row["status"] else "🟢 GRÜN")
        md_lines.append(f"| {row['sku']} | {row['ean']} | {symbol} | {row['reason']} |")

    md_lines.append("\n---\n")
    if barcode_hits == 0:
        md_lines.append(
            "> [!NOTE]\n"
            "> *Wichtiger Hinweis: 0 Treffer im EU Safety Gate bedeuten nicht automatisch, "
            "dass alle Produkte mangelfrei sind. Viele behoerdliche Rueckrufmeldungen enthalten "
            "keine registrierte Barcode/EAN-Nummer.*\n"
        )
    if truncated:
        md_lines.append(
            f"> [!IMPORTANT]\n"
            f"> **Katalog-Umfang:** Ihr Gratis-Check umfasst die ersten {MAX_FREE_CHECK_SKUS} SKUs. "
            f"Fuer die verbleibenden **{total_count - MAX_FREE_CHECK_SKUS} Artikel** empfehlen wir das "
            f"vollstaendige Portfolio-Audit (inkl. XLSX-Report & 48h-Aktionsplan) fuer 490 €:\n"
            f"> ➔ [Vollstaendiges Portfolio-Audit jetzt buchen (490 €)]({stripe_490})\n"
        )
    md_lines.append(
        "> [!NOTE]\n"
        "> *Hinweis gem. § 2 RDG: Dieses automatisierte Screening ist eine technische Checkliste und stellt keine Rechtsberatung dar. Keine behoerdliche Gewaehr.*"
    )
    report_md = "\n".join(md_lines)

    # HTML Body fuer Antwort-Mail
    table_rows_html = "".join([
        f"<tr><td style='padding:8px; border:1px solid #ddd;'>{html.escape(str(r['sku']))}</td>"
        f"<td style='padding:8px; border:1px solid #ddd;'>{html.escape(str(r['ean']))}</td>"
        f"<td style='padding:8px; border:1px solid #ddd; font-weight:bold; color:{'#d32f2f' if 'ROT' in r['status'] else ('#f57c00' if 'GELB' in r['status'] else '#388e3c')}'>{html.escape(str(r['status']))}</td>"
        f"<td style='padding:8px; border:1px solid #ddd;'>{html.escape(str(r['reason']))}</td></tr>"
        for r in audit_rows
    ])

    zero_hits_html = ""
    if barcode_hits == 0:
        zero_hits_html = """
        <p style="background-color: #f1f8e9; border-left: 4px solid #81c784; padding: 10px; margin: 16px 0; font-size: 13px; color: #2e7d32;">
            <strong>Hinweis zu 0 Treffern:</strong> Dies bedeutet nicht automatisch, dass alle Produkte mangelfrei sind, 
            da manche behoerdlichen Meldungen keine EAN hinterlegt haben.
        </p>
        """

    upsell_html = ""
    if truncated:
        upsell_html = f"""
        <div style="background-color: #fff3e0; border-left: 4px solid #ff9800; padding: 12px; margin: 20px 0;">
            <p style="margin: 0 0 8px 0; font-weight: bold; color: #e65100;">
                Katalog-Umfang: {total_count} Artikel eingereicht ({total_count - MAX_FREE_CHECK_SKUS} noch ungeprueft)
            </p>
            <p style="margin: 0 0 10px 0; color: #333;">
                Der Gratis-Check deckt die ersten {MAX_FREE_CHECK_SKUS} Artikel ab. Schuetzen Sie Ihren Amazon-Account vor GPSR-Sperren und pruefen Sie Ihren gesamten Katalog:
            </p>
            <a href="{stripe_490}" style="display: inline-block; background-color: #1976d2; color: #ffffff; padding: 10px 16px; text-decoration: none; border-radius: 4px; font-weight: bold;">
                Kompletten Katalog pruefen (Portfolio Audit 490 €)
            </a>
        </div>
        """

    email_body_html = f"""
    <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 1.5; color: #222;">
        <p>Hallo,</p>
        <p>vielen Dank fuer Ihre Einsendung. Wir haben die ersten {len(screened_items_list)} Artikel Ihres Katalogs gegen die aktuellen Meldungen des EU Safety Gate (RAPEX) abgeglichen:</p>
        
        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
            <thead>
                <tr style="background-color: #f5f5f5;">
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">SKU</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">EAN / Barcode</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Status</th>
                    <th style="padding: 8px; border: 1px solid #ddd; text-align: left;">Befund</th>
                </tr>
            </thead>
            <tbody>
                {table_rows_html}
            </tbody>
        </table>

        {zero_hits_html}

        {upsell_html}

        <p style="font-size: 12px; color: #777; margin-top: 24px; border-top: 1px solid #eee; padding-top: 8px;">
            Hinweis: Dieses automatisierte Screening ist eine technische Checkliste und stellt keine Rechtsberatung gem. § 2 RDG dar. Datenstand EU Safety Gate.
        </p>
    </div>
    """

    email_subject = f"Ihr EU Safety Gate Schnell-Audit ({barcode_hits} Treffer bei {len(screened_items_list)} SKUs)"

    return FreeCheckResult(
        sender_email=norm_email,
        company=company,
        total_items=total_count,
        screened_items=len(screened_items_list),
        truncated=truncated,
        barcode_hits=barcode_hits,
        corrupted_count=corrupted_count,
        report_markdown=report_md,
        report_html=email_body_html,
        stripe_link_490=stripe_490,
        stripe_link_1490=stripe_1490,
        email_subject=email_subject,
        email_body_text=report_md,
        email_body_html=email_body_html,
    )


def enqueue_free_check_draft(
    result: FreeCheckResult,
    storage: Optional[CRMStorage] = None,
    queue: Optional[ReviewQueue] = None,
    blacklist_mgr: Optional[BlacklistManager] = None,
) -> Dict[str, Any]:
    """
    Reiht den generierten Gratis-Check Report als Entwurf in die ReviewQueue ein
    und aktualisiert den Status im CRMStorage auf REPLIED_POSITIVE.
    """
    if storage is None:
        storage = get_default_storage()
    if queue is None:
        queue = get_default_queue()
    if blacklist_mgr is None:
        blacklist_mgr = storage.blacklist_mgr

    # Goldene Regel: Niemals an geblockte / gebouncte Adressen senden
    if not storage.can_contact(result.sender_email):
        raise BlacklistedRecipientError(f"Empfaenger '{result.sender_email}' ist gesperrt oder gebounct.")

    # CRM-Status aktualisieren
    lead = storage.update_lead_status(
        result.sender_email,
        LeadStatus.REPLIED_POSITIVE,
        reason=f"Gratis-Check ausgefuehrt ({result.screened_items}/{result.total_items} SKUs)",
        snippet=f"Hits: {result.barcode_hits}, Corrupted: {result.corrupted_count}",
    )
    if result.company and not lead.get("company"):
        lead["company"] = result.company
        storage.save()

    # In Review-Queue ablegen (Standard: PENDING_REVIEW, kein Auto-Send)
    draft_payload = {
        "recipient": result.sender_email,
        "company": result.company,
        "subject": result.email_subject,
        "body_text": result.email_body_text,
        "body_html": result.email_body_html,
        "language": "de",
        "metadata": {
            "flow": "free_check_10_skus",
            "total_items": result.total_items,
            "screened_items": result.screened_items,
            "truncated": result.truncated,
            "barcode_hits": result.barcode_hits,
            "stripe_link_490": result.stripe_link_490,
            "stripe_link_1490": result.stripe_link_1490,
        }
    }
    draft = queue.add_draft(draft_payload, check_blacklist=True)

    # Telegram Notification (Human-in-the-Loop)
    try:
        from scripts.crm.telegram_bot import get_default_bot
        bot = get_default_bot()
        msg_text = (
            f"📋 *Neuer Gratis-Check Report bereit zur Freigabe*\n"
            f"Empfaenger: `{result.sender_email}`\n"
            f"Artikel: {result.screened_items} geprueft ({result.total_items} gesamt)\n"
            f"Treffer: 🔴 {result.barcode_hits} | Korrupt: 🟡 {result.corrupted_count}\n"
            f"Upsell: [490 € Checkout]({result.stripe_link_490})\n"
            f"Entwurf-ID: `{draft.get('draft_id', '')}`"
        )
        bot.send_message(msg_text)
    except Exception as exc:
        logger.warning(f"[FreeCheck] Telegram-Benachrichtigung fehlgeschlagen: {exc}")

    return draft
