"""
scripts/crm/engine_runner.py
ProductSafetyEngine Direct Audit Runner.

Extrahiert EANs/Barcodes (GTIN-8/12/13/14) und Produktnamen aus:
- E-Mail-Freitexten (Zeilen, Tabellen, Aufzaehlungen)
- CSV- / TSV-Anhaengen (automatische Spaltenerkennung)
- Rohdaten und Artikellisten

Fuehrt Sicherheitsabgleiche gegen den EU Safety Gate (RAPEX) Datenbestand durch:
- XML-Fixtures (z. B. fixtures/safety_gate_2026_45.xml)
- SQLite-Datenbank (in-memory oder persistent)

Liefert strukturierte Audit-Ergebnisse mit:
- Treffer / Kein Treffer
- Produktrisiko (risk_type)
- Risikostufe (risk_level)
- Herkunftsland (country_of_origin)
- Notifizierender Staat, Gefahrenbeschreibung und behoerdliche Massnahmen.
"""

from __future__ import annotations

import csv
import io
import os
import re
import sqlite3
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple, Union

# Regex fuer Barcode-Kandidaten (8, 12, 13 oder 14 Ziffern)
GTIN_REGEX = re.compile(r"\b(\d{8}|\d{12}|\d{13}|\d{14})\b")

# Regex fuer Zeilen-Trennzeichen zwischen EAN und Produktname
DELIMITER_REGEX = re.compile(r"\s*[-–—|:;,]\s*")


def validate_gtin_checksum(digits: str) -> bool:
    """
    Prueft die offizielle GS1/GTIN Modulo-10 Pruefziffer fuer GTIN-8, 12, 13, 14.
    """
    if not digits or not digits.isdigit() or len(digits) not in (8, 12, 13, 14):
        return False
    body = digits[:-1]
    check_digit = int(digits[-1])

    total = 0
    multiplier = 3
    for d in reversed(body):
        total += int(d) * multiplier
        multiplier = 1 if multiplier == 3 else 3

    calc_check = (10 - (total % 10)) % 10
    return calc_check == check_digit


def normalize_to_gtin14(barcode: str) -> str:
    """Normalisiert einen Barcode auf GTIN-14 (14 Ziffern mit fuehrenden Nullen)."""
    digits = re.sub(r"\D", "", str(barcode or ""))
    if not digits:
        return ""
    return digits.zfill(14)


def clean_product_name(name: str) -> str:
    """Bereinigt Produktnamen von Artefakten, Praefixen und ueberfluessigen Zeichen."""
    if not name:
        return ""
    cleaned = name.strip()
    # Entferne fuehrende Aufzaehlungszeichen
    cleaned = re.sub(r"^[-*•\d+.)\]\s]+", "", cleaned)
    # Entferne typische Praefixe
    cleaned = re.sub(
        r"^(produkt|product|produit|name|nom|artikel|article|bezeichnung|title|titel)\s*[:=]\s*",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    # Entferne aeussere Quotes
    cleaned = cleaned.strip("\"' \t\r\n")
    return cleaned


@dataclass
class AuditItem:
    """Repraesentiert einen zu pruefenden Artikel mit Barcode und optionalem Produktnamen."""

    gtin: str
    product_name: str = ""
    raw_source: str = ""

    def __post_init__(self):
        self.gtin = str(self.gtin).strip()
        self.product_name = clean_product_name(self.product_name)

    @property
    def gtin14(self) -> str:
        return normalize_to_gtin14(self.gtin)

    @property
    def is_valid_checksum(self) -> bool:
        return validate_gtin_checksum(self.gtin)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "gtin": self.gtin,
            "gtin14": self.gtin14,
            "product_name": self.product_name,
            "raw_source": self.raw_source,
            "is_valid_checksum": self.is_valid_checksum,
        }


@dataclass
class AuditHit:
    """Repraesentiert einen Treffer im EU Safety Gate RAPEX Datenbestand."""

    alert_number: str = ""
    case_number: str = ""
    publication_date: str = ""
    category: str = ""
    product: str = ""
    brand: str = ""
    model: str = ""
    barcodes: List[str] = field(default_factory=list)
    risk_type: str = ""
    risk_level: str = ""
    danger_description: str = ""
    measures: str = ""
    country_of_origin: str = ""
    notifying_country: str = ""
    source_url: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "alert_number": self.alert_number,
            "case_number": self.case_number,
            "publication_date": self.publication_date,
            "category": self.category,
            "product": self.product,
            "brand": self.brand,
            "model": self.model,
            "barcodes": self.barcodes,
            "risk_type": self.risk_type,
            "risk_level": self.risk_level,
            "danger_description": self.danger_description,
            "measures": self.measures,
            "country_of_origin": self.country_of_origin,
            "notifying_country": self.notifying_country,
            "source_url": self.source_url,
        }


@dataclass
class AuditResult:
    """Ergebnis fuer einen einzelnen geprueften Artikel."""

    item: AuditItem
    found: bool = False
    hits: List[AuditHit] = field(default_factory=list)

    @property
    def gtin(self) -> str:
        return self.item.gtin

    @property
    def product_name(self) -> str:
        return self.item.product_name

    @property
    def risk_type(self) -> str:
        """Primaeres Produktrisiko des ersten Treffers oder leer."""
        return self.hits[0].risk_type if self.hits else ""

    @property
    def country_of_origin(self) -> str:
        """Primaeres Herkunftsland des ersten Treffers oder leer."""
        return self.hits[0].country_of_origin if self.hits else ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "gtin": self.gtin,
            "product_name": self.product_name,
            "found": self.found,
            "hit_count": len(self.hits),
            "risk_type": self.risk_type,
            "country_of_origin": self.country_of_origin,
            "hits": [h.to_dict() for h in self.hits],
        }


@dataclass
class AuditRunReport:
    """Zusammenfassender Gesamtbericht eines Recherche-Laufs."""

    results: List[AuditResult]
    data_date: str = ""
    data_source: str = ""
    timestamp: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )

    @property
    def total_checked(self) -> int:
        return len(self.results)

    @property
    def total_hits(self) -> int:
        return sum(1 for r in self.results if r.found)

    @property
    def total_clean(self) -> int:
        return sum(1 for r in self.results if not r.found)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_checked": self.total_checked,
            "total_hits": self.total_hits,
            "total_clean": self.total_clean,
            "data_date": self.data_date,
            "data_source": self.data_source,
            "timestamp": self.timestamp,
            "results": [r.to_dict() for r in self.results],
        }


# ============================================================================
# Extraktions-Funktionen (E-Mail, Text, CSV)
# ============================================================================


def extract_gtins_and_products(
    text: str, validate_checksum: bool = False
) -> List[AuditItem]:
    """
    Extrahiert valide GTINs (GTIN-8, 12, 13, 14) und zugehoerige Produktnamen
    aus E-Mail-Freitexten, Listen oder tabellarischen Notizen.
    """
    if not text:
        return []

    items: List[AuditItem] = []
    seen_gtins: Set[str] = set()

    lines = text.splitlines()
    for line in lines:
        raw_line = line.strip()
        if not raw_line:
            continue

        # Fuehrende Zitate (>) ueberspringen
        if raw_line.startswith(">"):
            continue

        # Suche nach allen Barcode-Kandidaten in der Zeile
        candidates = GTIN_REGEX.findall(raw_line)
        if not candidates:
            continue

        # Pruefe jeden Kandidaten
        for gtin in candidates:
            if gtin in seen_gtins:
                continue

            # Checksum-Validierung
            if validate_checksum and not validate_gtin_checksum(gtin):
                continue
            elif not validate_checksum and len(set(gtin)) <= 1:
                # Ausschluss von z. B. '00000000'
                continue

            # Versuche den Produktnamen aus der Zeile zu extrahieren
            product_name = ""

            # Fall 1: Klammern, z. B. "Flashing Shoes (GTIN: 1072105714)" oder "1072105714 (Flashing Shoes)"
            paren_match = re.search(
                rf"\((?:(?:ean|gtin|barcode)\s*[:=]?\s*)?{re.escape(gtin)}\)",
                raw_line,
                re.IGNORECASE,
            )
            if paren_match:
                prefix = raw_line[: paren_match.start()].strip()
                suffix = raw_line[paren_match.end() :].strip()
                candidate_name = f"{prefix} {suffix}".strip()
                product_name = clean_product_name(candidate_name)
            else:
                # Fall 2: Trennzeichen wie " - ", " : ", " | ", "\t", ","
                parts = re.split(rf"\b{re.escape(gtin)}\b", raw_line, maxsplit=1)
                if len(parts) == 2:
                    before, after = parts[0].strip(), parts[1].strip()
                    # Wenn 'before' laenger/aussagekraeftiger ist als Trennzeichen
                    clean_b = clean_product_name(re.sub(r"[-–—|:;,]\s*$", "", before))
                    clean_a = clean_product_name(re.sub(r"^[-–—|:;,]\s*", "", after))

                    if clean_b and not re.search(
                        r"^(ean|gtin|barcode|code)\b", clean_b, re.IGNORECASE
                    ):
                        product_name = clean_b
                    elif clean_a:
                        product_name = clean_a

            item = AuditItem(
                gtin=gtin, product_name=product_name, raw_source=raw_line
            )
            items.append(item)
            seen_gtins.add(gtin)

    return items


def extract_from_csv(
    csv_data: Union[str, bytes, io.StringIO, io.TextIOBase],
    validate_checksum: bool = False,
) -> List[AuditItem]:
    """
    Extrahiert GTINs und Produktnamen aus CSV- oder TSV-Daten.
    Erkennt automatisch Trennzeichen und Spaltennamen (DE, EN, FR, NL).
    """
    if isinstance(csv_data, bytes):
        text = csv_data.decode("utf-8", errors="replace")
    elif hasattr(csv_data, "read"):
        text = csv_data.read()
    else:
        text = str(csv_data)

    if not text.strip():
        return []

    # Delimiter-Erkennung
    sample = text[:2048]
    delimiter = ","
    for cand in [";", "\t", ",", "|"]:
        if cand in sample:
            delimiter = cand
            break

    reader = csv.reader(io.StringIO(text), delimiter=delimiter)
    rows = list(reader)
    if not rows:
        return []

    # Spaltenkoepfe analysieren
    header = [c.strip().lower() for c in rows[0]]
    gtin_col_idx = -1
    name_col_idx = -1

    gtin_keywords = [
        "gtin",
        "ean",
        "barcode",
        "code_barre",
        "code-barre",
        "streepjescode",
        "barcodes",
        "gtin13",
        "gtin14",
        "gtin8",
        "gtin12",
        "code",
        "artnr",
    ]
    name_keywords = [
        "product_name",
        "product",
        "name",
        "nom",
        "nom_du_produit",
        "produit",
        "productnaam",
        "title",
        "titel",
        "artikel",
        "artikelname",
        "artikelbezeichnung",
        "bezeichnung",
        "description",
    ]

    for idx, col in enumerate(header):
        col_clean = re.sub(r"[^a-z0-9_]", "", col)
        if gtin_col_idx == -1 and any(k in col_clean for k in gtin_keywords):
            gtin_col_idx = idx
        if name_col_idx == -1 and any(k in col_clean for k in name_keywords):
            name_col_idx = idx

    start_row = 1 if (gtin_col_idx != -1 or name_col_idx != -1) else 0

    items: List[AuditItem] = []
    seen_gtins: Set[str] = set()

    for row_idx in range(start_row, len(rows)):
        row = rows[row_idx]
        if not row or not any(row):
            continue

        gtin_val = ""
        name_val = ""

        if gtin_col_idx != -1 and gtin_col_idx < len(row):
            gtin_candidates = GTIN_REGEX.findall(row[gtin_col_idx])
            if gtin_candidates:
                gtin_val = gtin_candidates[0]

        if name_col_idx != -1 and name_col_idx < len(row):
            name_val = row[name_col_idx].strip()

        # Fallback: Keine Header-Zuordnung moeglich
        if not gtin_val:
            for cell_idx, cell in enumerate(row):
                found = GTIN_REGEX.findall(cell)
                if found:
                    gtin_val = found[0]
                    # Eine andere Zelle als Name waehlen
                    for other_idx, other_cell in enumerate(row):
                        if other_idx != cell_idx and len(other_cell.strip()) > 2:
                            name_val = other_cell.strip()
                            break
                    break

        if not gtin_val or gtin_val in seen_gtins:
            continue

        if validate_checksum and not validate_gtin_checksum(gtin_val):
            continue
        elif not validate_checksum and len(set(gtin_val)) <= 1:
            continue

        item = AuditItem(
            gtin=gtin_val,
            product_name=clean_product_name(name_val),
            raw_source=delimiter.join(row),
        )
        items.append(item)
        seen_gtins.add(gtin_val)

    return items


def extract_from_email_or_attachments(
    body: str,
    attachments: Optional[List[Dict[str, Any]]] = None,
    validate_checksum: bool = False,
) -> List[AuditItem]:
    """
    Kombinierte Extraktion aus E-Mail-Freitext und evtl. vorhandenen Anhaengen.
    """
    items: List[AuditItem] = []
    seen_gtins: Set[str] = set()

    # 1. Aus Body extrahieren
    if body:
        body_items = extract_gtins_and_products(
            body, validate_checksum=validate_checksum
        )
        for it in body_items:
            if it.gtin not in seen_gtins:
                items.append(it)
                seen_gtins.add(it.gtin)

    # 2. Aus Anhaengen extrahieren
    if attachments:
        for att in attachments:
            filename = str(att.get("filename", "")).lower()
            content = att.get("content", "")
            if filename.endswith((".csv", ".tsv", ".txt")):
                csv_items = extract_from_csv(
                    content, validate_checksum=validate_checksum
                )
                for it in csv_items:
                    if it.gtin not in seen_gtins:
                        items.append(it)
                        seen_gtins.add(it.gtin)
                    else:
                        # Wenn bestehender Item noch keinen Namen hatte, ergaenzen
                        for existing in items:
                            if (
                                existing.gtin == it.gtin
                                and not existing.product_name
                                and it.product_name
                            ):
                                existing.product_name = it.product_name

    return items


# ============================================================================
# SafetyGateEngine (XML & SQLite Lookup)
# ============================================================================


class SafetyGateEngine:
    """
    Recherche-Engine gegen EU Safety Gate RAPEX Datenbestaende.
    Unterstuetzt direkte XML-Fixtures und SQLite-Tabellen.
    """

    def __init__(
        self,
        xml_path: Optional[Union[str, Path]] = None,
        sqlite_path: Optional[Union[str, Path]] = None,
        auto_load: bool = True,
    ) -> None:
        self.project_root = Path(__file__).resolve().parent.parent.parent

        if xml_path:
            self.xml_path: Optional[Path] = Path(xml_path)
        else:
            default_xml = self.project_root / "fixtures" / "safety_gate_2026_45.xml"
            self.xml_path = default_xml if default_xml.exists() else None

        self.sqlite_path: Optional[Path] = Path(sqlite_path) if sqlite_path else None

        self.report_date: str = "13.11.2026"
        self.report_year: str = "2026"
        self.report_week: str = "45"

        # In-Memory Alerts & Barcode Index
        self.alerts: List[AuditHit] = []
        self.barcode_index: Dict[str, List[AuditHit]] = {}
        self.gtin14_index: Dict[str, List[AuditHit]] = {}

        # SQLite Connection
        self.db_conn: Optional[sqlite3.Connection] = None

        if auto_load:
            self._initialize()

    def _initialize(self) -> None:
        """Initialisiert die Engine aus SQLite oder XML."""
        if self.sqlite_path and self.sqlite_path.exists():
            self.load_sqlite(self.sqlite_path)
        elif self.xml_path and self.xml_path.exists():
            self.load_xml(self.xml_path)
            self._init_in_memory_sqlite()

    def load_xml(self, xml_path: Union[str, Path]) -> None:
        """Laedt und indiziert eine Safety-Gate XML-Fixture."""
        path = Path(xml_path)
        if not path.exists():
            raise FileNotFoundError(f"Safety Gate XML nicht gefunden: {path}")

        tree = ET.parse(str(path))
        root = tree.getroot()

        raw_date = root.findtext("report_date") or "13/11/2026"
        self.report_date = raw_date.strip().replace("/", ".")
        self.report_year = (root.findtext("report_year") or "2026").strip()
        self.report_week = (root.findtext("report_week") or "45").strip()

        self.alerts.clear()
        self.barcode_index.clear()
        self.gtin14_index.clear()

        for notif in root.findall("notifications"):
            hit = self._parse_notification_element(notif)
            self.alerts.append(hit)

            for bc in hit.barcodes:
                clean_bc = bc.strip()
                if not clean_bc:
                    continue

                if clean_bc not in self.barcode_index:
                    self.barcode_index[clean_bc] = []
                self.barcode_index[clean_bc].append(hit)

                g14 = normalize_to_gtin14(clean_bc)
                if g14:
                    if g14 not in self.gtin14_index:
                        self.gtin14_index[g14] = []
                    self.gtin14_index[g14].append(hit)

    def _parse_notification_element(self, notif: ET.Element) -> AuditHit:
        """Extrahiert einen AuditHit aus einem XML-Notification-Element."""

        def get_text(tag: str) -> str:
            el = notif.find(tag)
            return el.text.strip() if el is not None and el.text else ""

        raw_barcodes = get_text("barcode")
        extracted_barcodes: List[str] = []

        if raw_barcodes:
            # Manchmal sind Barcodes aneinandergehaengt oder durch Leerzeichen/Kommas getrennt
            found = GTIN_REGEX.findall(raw_barcodes)
            if found:
                extracted_barcodes = found
            elif len(raw_barcodes.strip()) >= 8:
                extracted_barcodes = [raw_barcodes.strip()]

        source_url = get_text("reference") or get_text("URLrecall")

        return AuditHit(
            alert_number=get_text("order"),
            case_number=get_text("caseNumber"),
            publication_date=get_text("publicationDate"),
            category=get_text("category"),
            product=get_text("product"),
            brand=get_text("brand"),
            model=get_text("name") or get_text("type_numberOfModel"),
            barcodes=extracted_barcodes,
            risk_type=get_text("riskType"),
            risk_level=get_text("level"),
            danger_description=get_text("danger") or get_text("description"),
            measures=get_text("measures"),
            country_of_origin=get_text("countryOfOrigin"),
            notifying_country=get_text("notifyingCountry"),
            source_url=source_url,
        )

    def _init_in_memory_sqlite(self) -> None:
        """Baut eine In-Memory SQLite-Datenbank fuer optimierte Abfragen auf."""
        self.db_conn = sqlite3.connect(":memory:")
        self._populate_sqlite(self.db_conn)

    def _populate_sqlite(self, conn: sqlite3.Connection) -> None:
        """Erstellt Schemas und befuellt die SQLite-Verbindung mit Alerts."""
        cur = conn.cursor()
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS alerts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                alert_number TEXT,
                case_number TEXT,
                publication_date TEXT,
                category TEXT,
                product TEXT,
                brand TEXT,
                model TEXT,
                risk_type TEXT,
                risk_level TEXT,
                danger_description TEXT,
                measures TEXT,
                country_of_origin TEXT,
                notifying_country TEXT,
                source_url TEXT
            );
        """
        )
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS alert_barcodes (
                alert_id INTEGER,
                barcode TEXT,
                gtin14 TEXT,
                FOREIGN KEY(alert_id) REFERENCES alerts(id)
            );
        """
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_barcodes_bc ON alert_barcodes(barcode);"
        )
        cur.execute(
            "CREATE INDEX IF NOT EXISTS idx_barcodes_g14 ON alert_barcodes(gtin14);"
        )

        for hit in self.alerts:
            cur.execute(
                """
                INSERT INTO alerts (
                    alert_number, case_number, publication_date, category,
                    product, brand, model, risk_type, risk_level,
                    danger_description, measures, country_of_origin,
                    notifying_country, source_url
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
                (
                    hit.alert_number,
                    hit.case_number,
                    hit.publication_date,
                    hit.category,
                    hit.product,
                    hit.brand,
                    hit.model,
                    hit.risk_type,
                    hit.risk_level,
                    hit.danger_description,
                    hit.measures,
                    hit.country_of_origin,
                    hit.notifying_country,
                    hit.source_url,
                ),
            )
            alert_id = cur.lastrowid
            for bc in hit.barcodes:
                cur.execute(
                    """
                    INSERT INTO alert_barcodes (alert_id, barcode, gtin14)
                    VALUES (?, ?, ?)
                """,
                    (alert_id, bc, normalize_to_gtin14(bc)),
                )

        conn.commit()

    def load_sqlite(self, sqlite_path: Union[str, Path]) -> None:
        """Laedt Alerts aus einer bestehenden SQLite-Datenbankdatei."""
        path = Path(sqlite_path)
        if not path.exists():
            raise FileNotFoundError(f"SQLite-Datenbank nicht gefunden: {path}")

        self.db_conn = sqlite3.connect(str(path))
        self.alerts.clear()
        self.barcode_index.clear()
        self.gtin14_index.clear()

        cur = self.db_conn.cursor()
        cur.execute(
            """
            SELECT id, alert_number, case_number, publication_date, category,
                   product, brand, model, risk_type, risk_level,
                   danger_description, measures, country_of_origin,
                   notifying_country, source_url
            FROM alerts
        """
        )
        rows = cur.fetchall()
        for row in rows:
            (
                alert_id,
                alt_num,
                case_num,
                pub_date,
                cat,
                prod,
                brand,
                model,
                risk_t,
                risk_l,
                danger,
                meas,
                origin,
                notif_c,
                url,
            ) = row

            # Barcodes laden
            cur.execute(
                "SELECT barcode FROM alert_barcodes WHERE alert_id = ?",
                (alert_id,),
            )
            bcs = [r[0] for r in cur.fetchall()]

            hit = AuditHit(
                alert_number=str(alt_num or ""),
                case_number=str(case_num or ""),
                publication_date=str(pub_date or ""),
                category=str(cat or ""),
                product=str(prod or ""),
                brand=str(brand or ""),
                model=str(model or ""),
                barcodes=bcs,
                risk_type=str(risk_t or ""),
                risk_level=str(risk_l or ""),
                danger_description=str(danger or ""),
                measures=str(meas or ""),
                country_of_origin=str(origin or ""),
                notifying_country=str(notif_c or ""),
                source_url=str(url or ""),
            )
            self.alerts.append(hit)
            for bc in bcs:
                if bc not in self.barcode_index:
                    self.barcode_index[bc] = []
                self.barcode_index[bc].append(hit)
                g14 = normalize_to_gtin14(bc)
                if g14:
                    if g14 not in self.gtin14_index:
                        self.gtin14_index[g14] = []
                    self.gtin14_index[g14].append(hit)

    def check_gtin(self, gtin: str) -> List[AuditHit]:
        """
        Prueft einen Barcode / GTIN gegen den Datenbestand.
        Unterstuetzt exakten Treffer, GTIN-14 Normalisierung und Substring-Treffer.
        """
        clean_gtin = str(gtin or "").strip()
        if not clean_gtin:
            return []

        hits: List[AuditHit] = []
        seen_cases: Set[str] = set()

        # 1. Direkter Match im Barcode-Index
        if clean_gtin in self.barcode_index:
            for hit in self.barcode_index[clean_gtin]:
                if hit.case_number not in seen_cases:
                    hits.append(hit)
                    seen_cases.add(hit.case_number)

        # 2. GTIN-14 Match
        g14 = normalize_to_gtin14(clean_gtin)
        if g14 and g14 in self.gtin14_index:
            for hit in self.gtin14_index[g14]:
                if hit.case_number not in seen_cases:
                    hits.append(hit)
                    seen_cases.add(hit.case_number)

        # 3. Falls noch kein Treffer: Suche in verbundenen/mehrteiligen Barcodes
        if not hits:
            for hit in self.alerts:
                if hit.case_number in seen_cases:
                    continue
                for bc in hit.barcodes:
                    if clean_gtin in bc or bc in clean_gtin:
                        hits.append(hit)
                        seen_cases.add(hit.case_number)
                        break

        return hits

    def check_item(
        self, item: Union[AuditItem, str, Dict[str, Any]]
    ) -> AuditResult:
        """Prueft einen einzelnen Artikel oder Barcode-String."""
        if isinstance(item, str):
            audit_item = AuditItem(gtin=item)
        elif isinstance(item, dict):
            audit_item = AuditItem(
                gtin=item.get("gtin", item.get("barcode", "")),
                product_name=item.get("product_name", item.get("name", "")),
            )
        else:
            audit_item = item

        hits = self.check_gtin(audit_item.gtin)
        return AuditResult(item=audit_item, found=len(hits) > 0, hits=hits)

    def check_items(
        self, items: List[Union[AuditItem, str, Dict[str, Any]]]
    ) -> List[AuditResult]:
        """Prueft eine Liste von Artikeln."""
        return [self.check_item(it) for it in items]

    def run_audit(
        self,
        text: str = "",
        attachments: Optional[List[Dict[str, Any]]] = None,
        items: Optional[List[AuditItem]] = None,
    ) -> AuditRunReport:
        """
        Fuehrt einen vollstaendigen Recherche-Lauf durch.
        Extrahiert Items aus Text/Anhaengen (falls nicht direkt uebergeben),
        prueft jeden Artikel gegen den Safety-Gate-Datenbestand und
        liefert den AuditRunReport zurueck.
        """
        audit_items: List[AuditItem] = []
        if items:
            audit_items.extend(items)
        elif text or attachments:
            extracted = extract_from_email_or_attachments(text, attachments)
            audit_items.extend(extracted)

        results = self.check_items(audit_items)
        source_name = (
            self.xml_path.name
            if self.xml_path
            else (self.sqlite_path.name if self.sqlite_path else "Safety Gate")
        )

        return AuditRunReport(
            results=results,
            data_date=self.report_date,
            data_source=source_name,
        )
