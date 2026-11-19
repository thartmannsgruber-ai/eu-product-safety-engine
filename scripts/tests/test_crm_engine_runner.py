"""
scripts/tests/test_crm_engine_runner.py
Unit-Tests fuer Feature F03: ProductSafetyEngine Direct Audit Runner & Disclaimer Generator.

Akzeptanzkriterien:
1. Extrahiert valide GTINs und Produktnamen aus E-Mail-Texten oder Anhaengen (CSV/Text)
2. Prueft Barcodes gegen den Safety-Gate-Datenbestand (Treffer/Kein Treffer, Produktrisiko, Herkunftsland)
3. Generiert den Report mit zwingendem Standard-Disclaimer inklusive Datumsstempel:
   'Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom TT.MM.JJJJ'
4. Enthaelt den Hinweis:
   'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).'
"""

import os
import sqlite3
import tempfile
import unittest
from pathlib import Path

from scripts.crm.engine_runner import (
    AuditHit,
    AuditItem,
    AuditResult,
    AuditRunReport,
    SafetyGateEngine,
    extract_from_csv,
    extract_from_email_or_attachments,
    extract_gtins_and_products,
    normalize_to_gtin14,
    validate_gtin_checksum,
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


class TestCRMEngineRunnerAndReportGenerator(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture_xml = (
            Path(__file__).resolve().parent.parent.parent
            / "fixtures"
            / "safety_gate_2026_45.xml"
        )
        assert cls.fixture_xml.exists(), f"XML Fixture fehlt: {cls.fixture_xml}"

    def setUp(self):
        self.engine = SafetyGateEngine(xml_path=self.fixture_xml)

    # -----------------------------------------------------------------------
    # Kriterium 1: Extraktion valider GTINs und Produktnamen
    # -----------------------------------------------------------------------

    def test_criterion_1_extract_gtin_and_product_from_email_text(self):
        """Kriterium 1: Extrahiert GTINs und Produktnamen aus diversen E-Mail-Freitextformaten."""
        sample_email = """
        Bonjour Thomas,
        Voici les articles que nous souhaitons soumettre à votre test gratuit de 50 articles :

        - 5054298241091 - Baby Jacket Flower
        - 4099979071513 : s.Oliver Cap
        - 4001234567890 | Holzeisenbahn Klassik
        - Flashing Shoes (GTIN: 2401550113741)
        * 3760407016796 Pantalon pluie enfant

        Pourriez-vous nous envoyer les résultats rapidement ?
        Merci,
        Jean Dupont
        """
        items = extract_gtins_and_products(sample_email)

        extracted_dict = {item.gtin: item.product_name for item in items}

        self.assertIn("5054298241091", extracted_dict)
        self.assertEqual(extracted_dict["5054298241091"], "Baby Jacket Flower")

        self.assertIn("4099979071513", extracted_dict)
        self.assertIn("s.Oliver Cap", extracted_dict["4099979071513"])

        self.assertIn("4001234567890", extracted_dict)
        self.assertEqual(extracted_dict["4001234567890"], "Holzeisenbahn Klassik")

        self.assertIn("2401550113741", extracted_dict)
        self.assertIn("Flashing Shoes", extracted_dict["2401550113741"])

        self.assertIn("3760407016796", extracted_dict)
        self.assertIn("Pantalon pluie enfant", extracted_dict["3760407016796"])

    def test_criterion_1_extract_from_csv_attachments(self):
        """Kriterium 1: Extrahiert GTINs und Produktnamen aus CSV-Anhaengen (Komma, Semikolon, NL/FR)."""
        # Fall A: Standard CSV (Englisch / Deutsch)
        csv_content_a = """gtin,product_name
5054298241091,Baby Jacket Flower
4099979071513,s.Oliver Cap
"""
        items_a = extract_from_csv(csv_content_a)
        self.assertEqual(len(items_a), 2)
        self.assertEqual(items_a[0].gtin, "5054298241091")
        self.assertEqual(items_a[0].product_name, "Baby Jacket Flower")
        self.assertEqual(items_a[1].gtin, "4099979071513")
        self.assertEqual(items_a[1].product_name, "s.Oliver Cap")

        # Fall B: Franzoesische Header mit Semikolon
        csv_content_b = """code_barre;nom_produit
3760407016796;Pantalon de pluie
2401550113741;Chaîne pendentif argent
"""
        items_b = extract_from_csv(csv_content_b)
        self.assertEqual(len(items_b), 2)
        self.assertEqual(items_b[0].gtin, "3760407016796")
        self.assertEqual(items_b[0].product_name, "Pantalon de pluie")

        # Fall C: Niederlaendische Header
        csv_content_c = """streepjescode;productnaam
4062075224596;Regenjas Geel
"""
        items_c = extract_from_csv(csv_content_c)
        self.assertEqual(len(items_c), 1)
        self.assertEqual(items_c[0].gtin, "4062075224596")
        self.assertEqual(items_c[0].product_name, "Regenjas Geel")

        # Fall D: CSV ohne Header (automatische Zellerkennung)
        csv_content_d = """5054298241091,Baby Jacket Flower
4099979071513,s.Oliver Cap
"""
        items_d = extract_from_csv(csv_content_d)
        self.assertEqual(len(items_d), 2)
        self.assertEqual(items_d[0].gtin, "5054298241091")
        self.assertEqual(items_d[0].product_name, "Baby Jacket Flower")

    def test_criterion_1_gtin_checksum_validation(self):
        """Kriterium 1: GS1 Modulo-10 Pruefziffern-Validierung fuer GTIN-8, 12, 13, 14."""
        # Valide GTINs
        self.assertTrue(validate_gtin_checksum("96385074"))  # GTIN-8
        self.assertTrue(validate_gtin_checksum("036000291452"))  # GTIN-12 (UPC-A)
        self.assertTrue(validate_gtin_checksum("5054298241091"))  # GTIN-13
        self.assertTrue(validate_gtin_checksum("4099979071513"))  # GTIN-13
        self.assertTrue(validate_gtin_checksum("3760407016796"))  # GTIN-13
        self.assertTrue(validate_gtin_checksum("15054298241098"))  # GTIN-14

        # Invalide GTINs (falsche Pruefziffer)
        self.assertFalse(validate_gtin_checksum("5054298241090"))
        self.assertFalse(validate_gtin_checksum("4099979071512"))
        self.assertFalse(validate_gtin_checksum("12345678"))  # Ungueltig
        self.assertFalse(validate_gtin_checksum("abc"))

    def test_criterion_1_combined_email_and_attachment_extraction(self):
        """Kriterium 1: Kombinierte Extraktion aus Freitext und Anhang."""
        body = "Hier ist unser erster Test-Artikel: 5054298241091 - Baby Jacke."
        attachments = [
            {
                "filename": "articles.csv",
                "content": "ean,product\n4099979071513,s.Oliver Cap\n",
            }
        ]
        items = extract_from_email_or_attachments(body, attachments)
        gtins = [it.gtin for it in items]
        self.assertIn("5054298241091", gtins)
        self.assertIn("4099979071513", gtins)

    # -----------------------------------------------------------------------
    # Kriterium 2: Safety Gate Pruefung (Treffer/Kein Treffer, Risiko, Herkunft)
    # -----------------------------------------------------------------------

    def test_criterion_2_hit_detection_produktrisiko_herkunftsland(self):
        """Kriterium 2: Prueft Barcodes gegen Safety Gate (Treffer, Produktrisiko, Herkunftsland)."""
        # Bekannter Treffer 1: 5054298241091 (Baby Jacket Flower, Order 1)
        res1 = self.engine.check_item("5054298241091")
        self.assertTrue(res1.found)
        self.assertGreater(len(res1.hits), 0)
        self.assertIn("Chemical", res1.risk_type)
        self.assertEqual(res1.country_of_origin, "People's Republic of China")
        self.assertEqual(res1.hits[0].case_number, "SR/03208/26")

        # Bekannter Treffer 2: 3760407016796 (Children's rain trousers, Order 5)
        res2 = self.engine.check_item("3760407016796")
        self.assertTrue(res2.found)
        self.assertIn("Chemical", res2.risk_type)
        self.assertEqual(res2.country_of_origin, "Burkina Faso")
        self.assertEqual(res2.hits[0].case_number, "SR/03209/26")

        # Bekannter Treffer 3: 4062075224596 (Rain jacket, Order 9)
        res3 = self.engine.check_item("4062075224596")
        self.assertTrue(res3.found)
        self.assertIn("Chemical", res3.risk_type)
        self.assertEqual(res3.country_of_origin, "Pakistan")

    def test_criterion_2_no_hit_detection(self):
        """Kriterium 2: Barcode ohne Meldung wird korrekt als 'Kein Treffer' erkannt."""
        clean_barcode = "4001234567890"  # Phantasie-EAN nicht in Fixture
        res = self.engine.check_item(clean_barcode)
        self.assertFalse(res.found)
        self.assertEqual(len(res.hits), 0)
        self.assertEqual(res.risk_type, "")
        self.assertEqual(res.country_of_origin, "")

    def test_criterion_2_sqlite_lookup_parity(self):
        """Kriterium 2: Safety Gate Recherche ueber SQLite liefert identische Ergebnisse."""
        with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as tmp_db:
            db_path = tmp_db.name

        try:
            # SQLite initialisieren und aus XML befuellen
            sqlite_conn = sqlite3.connect(db_path)
            self.engine._populate_sqlite(sqlite_conn)
            sqlite_conn.close()

            # Neue Engine rein ueber SQLite laden
            sqlite_engine = SafetyGateEngine(sqlite_path=db_path)

            # Hit-Pruefung
            res_hit = sqlite_engine.check_item("5054298241091")
            self.assertTrue(res_hit.found)
            self.assertIn("Chemical", res_hit.risk_type)
            self.assertEqual(res_hit.country_of_origin, "People's Republic of China")

            # No-Hit-Pruefung
            res_clean = sqlite_engine.check_item("4001234567890")
            self.assertFalse(res_clean.found)
        finally:
            if os.path.exists(db_path):
                os.remove(db_path)

    # -----------------------------------------------------------------------
    # Kriterium 3: Zwingender Standard-Disclaimer inklusive Datumsstempel
    # -----------------------------------------------------------------------

    def test_criterion_3_mandatory_standard_disclaimer_with_date(self):
        """Kriterium 3: Generiert den Report mit zwingendem Standard-Disclaimer und Datumsstempel."""
        items = [
            AuditItem(gtin="5054298241091", product_name="Baby Jacket Flower"),
            AuditItem(gtin="4001234567890", product_name="Unauffälliges Spielzeug"),
        ]
        results = self.engine.check_items(items)

        # 1. Text-Report
        text_report = generate_text_report(results, data_date="13.11.2026")
        expected_disclaimer = (
            "Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026"
        )
        self.assertIn(expected_disclaimer, text_report)

        # 2. Markdown-Report
        md_report = generate_markdown_report(results, data_date="13.11.2026")
        self.assertIn(expected_disclaimer, md_report)

        # 3. Standard Disclaimer Helper
        disclaimer_helper = get_standard_disclaimer("13/11/2026")
        self.assertEqual(disclaimer_helper, expected_disclaimer)

        # 4. Automatisches Datums-Formatting
        self.assertEqual(format_safety_gate_date("13/11/2026"), "13.11.2026")
        self.assertEqual(format_safety_gate_date("2026-11-13"), "13.11.2026")

    # -----------------------------------------------------------------------
    # Kriterium 4: Zwingender Hinweis bei 0 Treffern bzw. im Report
    # -----------------------------------------------------------------------

    def test_criterion_4_mandatory_zero_hits_note(self):
        """Kriterium 4: Enthaelt den Hinweis 'Kein Treffer bedeutet nicht, dass das Produkt sicher ist...'."""
        expected_note = (
            "Kein Treffer bedeutet nicht, dass das Produkt sicher ist "
            "(viele Meldungen besitzen keine hinterlegte EAN)."
        )

        # Fall 1: Reine Non-Hit Liste (0 Treffer)
        clean_items = [
            AuditItem(gtin="4001234567890", product_name="Holzspielzeug"),
            AuditItem(gtin="4009876543210", product_name="Plüschbär"),
        ]
        clean_results = self.engine.check_items(clean_items)

        report_clean = generate_text_report(clean_results, data_date="13.11.2026")
        self.assertIn(expected_note, report_clean)

        report_clean_md = generate_markdown_report(
            clean_results, data_date="13.11.2026"
        )
        self.assertIn(expected_note, report_clean_md)

        # Fall 2: Gemischte Liste mit Treffern
        mixed_items = [
            AuditItem(gtin="5054298241091", product_name="Baby Jacket Flower"),
            AuditItem(gtin="4001234567890", product_name="Holzspielzeug"),
        ]
        mixed_results = self.engine.check_items(mixed_items)
        report_mixed = generate_text_report(mixed_results, data_date="13.11.2026")
        self.assertIn(expected_note, report_mixed)

        # Helper-Funktion
        self.assertEqual(get_zero_hits_note(), expected_note)

    # -----------------------------------------------------------------------
    # End-to-End Audit-Run Test
    # -----------------------------------------------------------------------

    def test_end_to_end_audit_runner_and_report_generation(self):
        """End-to-End: Liest Mail-Text mit EANs, fuehrt Recherche durch und erzeugt vollstaendigen Report."""
        inbound_email = """
        Hallo Thomas,
        wir testen gerne Ihren Service mit folgenden 2 Artikeln:
        1. 5054298241091 - Baby Jacket Flower
        2. 4001234567890 - Bausteine Holz
        Danke!
        """
        audit_report = self.engine.run_audit(text=inbound_email)

        self.assertEqual(audit_report.total_checked, 2)
        self.assertEqual(audit_report.total_hits, 1)
        self.assertEqual(audit_report.total_clean, 1)
        self.assertEqual(audit_report.data_date, "13.11.2026")

        final_report = generate_report(audit_report, format="text")
        self.assertIn("PRODUCT SAFETY ENGINE", final_report)
        self.assertIn("Baby Jacket Flower", final_report)
        self.assertIn("People's Republic of China", final_report)
        self.assertIn("Chemical", final_report)
        self.assertIn(
            "Technischer Rechercheabgleich, keine Rechtsberatung, Datenstand EU Safety Gate vom 13.11.2026",
            final_report,
        )
        self.assertIn(
            "Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).",
            final_report,
        )


if __name__ == "__main__":
    unittest.main()
