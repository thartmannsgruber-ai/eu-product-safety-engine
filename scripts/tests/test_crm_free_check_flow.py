"""
scripts/tests/test_crm_free_check_flow.py
Unit- und Integrationstests fuer Feature: Automatisierter Ablauf fuer Gratis-Checks (10 SKUs).

Akzeptanzkriterien:
1. Ingestion: Parst CSV, TSV und XLSX-Dateien sauber (auch ohne externe Bibliotheken via zipfile).
2. Schutz vor Excel-Korruption (B1):
   - Exponentialnotation (4.00638E+12) wird als EAN_CORRUPTED_EXCEL erkannt.
   - Zero-Padded Truncation (4006380000000) wird als EAN_SUSPECT_TRUNCATED erkannt.
3. 10-SKU-Limit:
   - Maximal 10 SKUs werden gratis gescreent.
   - Bei > 10 SKUs wird truncated=True gesetzt und ein klarer Upsell-Hinweis auf das 490 € Vollaudit generiert.
4. Monetarisierung & Stripe-Links:
   - Erzeugt Stripe-Links fuer Portfolio Audit (490 €) und Audit Plus (1.490 €).
5. RDG-Disclaimer:
   - Enthaelt den § 2 RDG Hinweis in Text, Markdown und HTML.
6. ReviewQueue & CRM:
   - Entwurf landet in ReviewQueue (PENDING_REVIEW).
   - Lead wird auf REPLIED_POSITIVE gesetzt.
   - Geblockte/gebouncte Leads werden abgewiesen.
7. Crawler-Integration:
   - Inbound-Mail mit Anhang stoesst automatisch den Free-Check Flow an.
"""

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch

from scripts.crm.blacklist import BlacklistedRecipientError, BlacklistManager
from scripts.crm.crawler import InboundMailCrawler
from scripts.crm.engine_runner import SafetyGateEngine
from scripts.crm.free_check_flow import (
    MAX_FREE_CHECK_SKUS,
    FreeCheckResult,
    enqueue_free_check_draft,
    execute_free_check,
    is_scientific_notation,
    is_suspect_zero_padded,
    parse_attachment_items,
    parse_xlsx_sheets,
)
from scripts.crm.review_queue import DraftStatus, ReviewQueue
from scripts.crm.storage import CRMStorage, LeadStatus


def create_in_memory_xlsx(rows: list[list[str]]) -> bytes:
    """Erzeugt eine minimale gueltige XLSX-Datei im Speicher fuer Tests."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # sharedStrings.xml
        unique_strings = []
        string_to_idx = {}
        for r in rows:
            for cell in r:
                if cell not in string_to_idx:
                    string_to_idx[cell] = len(unique_strings)
                    unique_strings.append(cell)

        ss_xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                  f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="{len(unique_strings)}" uniqueCount="{len(unique_strings)}">']
        for s in unique_strings:
            ss_xml.append(f'<si><t>{s}</t></si>')
        ss_xml.append('</sst>')
        z.writestr("xl/sharedStrings.xml", "".join(ss_xml))

        # sheet1.xml
        ws_xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
                  '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
                  '<sheetData>']
        for r_idx, r in enumerate(rows, start=1):
            ws_xml.append(f'<row r="{r_idx}">')
            for c_idx, cell in enumerate(r):
                col_letter = chr(ord('A') + c_idx)
                s_idx = string_to_idx[cell]
                ws_xml.append(f'<c r="{col_letter}{r_idx}" t="s"><v>{s_idx}</v></c>')
            ws_xml.append('</row>')
        ws_xml.append('</sheetData></worksheet>')
        z.writestr("xl/worksheets/sheet1.xml", "".join(ws_xml))

    return buf.getvalue()


class TestCRMFreeCheckFlow(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"
        self.leads_file = Path(self.temp_dir.name) / "leads_db.json"
        self.queue_file = Path(self.temp_dir.name) / "review_queue.json"
        self.state_file = Path(self.temp_dir.name) / "crawler_state.json"

        self.blacklist_mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        self.storage = CRMStorage(leads_file=self.leads_file, blacklist_mgr=self.blacklist_mgr)
        self.queue = ReviewQueue(queue_file=self.queue_file)

        # Mock Engine mit bekannten Test-EANs
        self.engine = MagicMock()
        self.engine.lookup_barcode.side_effect = lambda ean: [
            MagicMock(alert_number="A12/0001/26", risk_type="Chemical, Choking")
        ] if ean == "4006381333931" else []

    def tearDown(self):
        self.temp_dir.cleanup()

    # --- 1. Parser Tests (CSV, TSV, XLSX) ---

    def test_parse_csv_and_tsv(self):
        csv_content = (
            "sku,ean,title,brand\n"
            "SKU-1,4006381333931,Holzbausteine Set,PlayWood\n"
            "SKU-2,5054298241091,Winterjacke Blau,FashionLine\n"
        )
        items = parse_attachment_items("katalog.csv", csv_content)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["sku"], "SKU-1")
        self.assertEqual(items[0]["ean"], "4006381333931")
        self.assertIsNone(items[0]["warning"])

        tsv_content = (
            "seller-sku\tbarcode\titem-name\n"
            "SKU-TSV-1\t4006381333931\tTestartikel\n"
        )
        items_tsv = parse_attachment_items("export.tsv", tsv_content)
        self.assertEqual(len(items_tsv), 1)
        self.assertEqual(items_tsv[0]["sku"], "SKU-TSV-1")
        self.assertEqual(items_tsv[0]["ean"], "4006381333931")

    def test_parse_xlsx_in_memory(self):
        rows = [
            ["SKU", "EAN", "Produktname", "Marke"],
            ["SKU-XLSX-1", "4006381333931", "Kinderwagen Deluxe", "BabySafe"],
            ["SKU-XLSX-2", "400638E+12", "Kaputter Artikel", "ExcelGlitch"],
        ]
        xlsx_bytes = create_in_memory_xlsx(rows)
        items = parse_attachment_items("catalog.xlsx", xlsx_bytes)

        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["sku"], "SKU-XLSX-1")
        self.assertEqual(items[0]["ean"], "4006381333931")
        self.assertIsNone(items[0]["warning"])

        # B1 Check: Exponentialnotation als korrumpiert erkannt
        self.assertEqual(items[1]["sku"], "SKU-XLSX-2")
        self.assertEqual(items[1]["ean"], "")
        self.assertEqual(items[1]["warning"], "EAN_CORRUPTED_EXCEL")

    # --- 2. B1 Corruption Protection Tests ---

    def test_scientific_notation_and_zero_padded_detection(self):
        self.assertTrue(is_scientific_notation("4.00638E+12"))
        self.assertTrue(is_scientific_notation("4.00638e+12"))
        self.assertFalse(is_scientific_notation("4006381333931"))

        self.assertTrue(is_suspect_zero_padded("4006380000000"))
        self.assertFalse(is_suspect_zero_padded("4006381333931"))

    # --- 3. 10-SKU-Limit & Screening Tests ---

    def test_execute_free_check_within_limit(self):
        items = [
            {"sku": f"SKU-{i}", "ean": "4006381333931" if i == 1 else "4099979071513", "title": f"Item {i}"}
            for i in range(1, 6)
        ]
        res = execute_free_check(
            sender_email="haendler@shop-fba.de",
            items=items,
            company="FBA Toys GmbH",
            engine=self.engine,
        )

        self.assertEqual(res.total_items, 5)
        self.assertEqual(res.screened_items, 5)
        self.assertFalse(res.truncated)
        self.assertEqual(res.barcode_hits, 1)  # 4006381333931 hit
        self.assertIn("§ 2 RDG", res.email_body_text)
        self.assertTrue(res.stripe_link_490.startswith("https://checkout.stripe.com"))
        self.assertTrue(res.stripe_link_1490.startswith("https://checkout.stripe.com"))

    def test_execute_free_check_truncation_over_10_skus(self):
        items = [
            {"sku": f"SKU-{i}", "ean": "4006381333931" if i == 1 else "4099979071513", "title": f"Item {i}"}
            for i in range(1, 26)  # 25 SKUs
        ]
        res = execute_free_check(
            sender_email="grosshaendler@b2b-katalog.de",
            items=items,
            company="Grosshandel B2B",
            engine=self.engine,
        )

        self.assertEqual(res.total_items, 25)
        self.assertEqual(res.screened_items, MAX_FREE_CHECK_SKUS)  # 10
        self.assertTrue(res.truncated)
        # Upsell Text muss die verbleibenden 15 Artikel erwaehnen
        self.assertIn("15 Artikel", res.email_body_text)
        self.assertIn("Portfolio-Audit", res.email_body_text)

    # --- 4. ReviewQueue & CRM Integration Tests ---

    def test_enqueue_free_check_draft_sets_replied_positive_and_enqueues(self):
        email = "partner@fba-seller.de"
        self.storage.update_lead_status(email, LeadStatus.OUTREACH_SENT)

        items = [{"sku": "SKU-1", "ean": "4006381333931", "title": "Produkt"}]
        res = execute_free_check(
            sender_email=email,
            items=items,
            company="Seller e.K.",
            engine=self.engine,
        )

        with patch("scripts.crm.telegram_bot.get_default_bot") as mock_bot:
            draft = enqueue_free_check_draft(
                result=res,
                storage=self.storage,
                queue=self.queue,
                blacklist_mgr=self.blacklist_mgr,
            )

        self.assertIsNotNone(draft)
        self.assertEqual(draft.get("status"), DraftStatus.PENDING_REVIEW)
        self.assertEqual(draft.get("recipient"), email)

        # CRM Lead Status muss REPLIED_POSITIVE sein
        lead = self.storage.get_lead(email)
        self.assertEqual(lead["status"], LeadStatus.REPLIED_POSITIVE)

    def test_enqueue_free_check_draft_rejects_bounced_or_blacklisted(self):
        bounced_email = "bounced-client@toys.nl"
        self.storage.mark_bounced(bounced_email)

        items = [{"sku": "SKU-1", "ean": "4006381333931"}]
        res = execute_free_check(sender_email=bounced_email, items=items, engine=self.engine)

        with self.assertRaises(BlacklistedRecipientError):
            enqueue_free_check_draft(
                result=res,
                storage=self.storage,
                queue=self.queue,
                blacklist_mgr=self.blacklist_mgr,
            )

    # --- 5. InboundMailCrawler Integration Test ---

    def test_crawler_auto_processes_inbound_with_csv_attachment(self):
        lead_email = "interessent@fba-retail.de"
        self.storage.update_lead_status(lead_email, LeadStatus.OUTREACH_SENT)

        crawler = InboundMailCrawler(
            storage=self.storage,
            blacklist_mgr=self.blacklist_mgr,
            state_file=self.state_file,
            auto_draft=True,
        )
        crawler.engine = self.engine

        csv_bytes = b"sku,ean,title\nSKU-A,4006381333931,Holzente\nSKU-B,4099979071513,Kappe\n"
        raw_msg = {
            "from": lead_email,
            "subject": "Re: Produktsicherheit & Safety Gate Check unserer Artikel",
            "body": "Hallo Thomas, anbei ist unser Katalog mit den Artikeln. Bitte um Pruefung.",
            "message_id": "<inbound-test-csv-1@fba-retail.de>",
            "attachments": [
                {
                    "filename": "meine_artikel.csv",
                    "content": csv_bytes,
                    "content_type": "text/csv",
                }
            ],
        }

        with patch("scripts.crm.telegram_bot.get_default_bot"):
            action = crawler.process_message(raw_msg)

        self.assertFalse(action.get("skipped", False))
        lead = self.storage.get_lead(lead_email)
        self.assertEqual(lead["status"], LeadStatus.REPLIED_POSITIVE)

    # --- 6. Security & Resource Guard Tests (P1, P3, P5) ---

    def test_html_escaping_in_free_check_output(self):
        """P1: Verhindert HTML/Script-Injektionen durch unsichere Eingabewerte."""
        malicious_sku = "<script>alert('xss')</script>"
        items = [{"sku": malicious_sku, "ean": "4006381333931"}]
        res = execute_free_check(
            sender_email="test@shop.de",
            items=items,
            company="<img src=x onerror=alert(1)>",
            engine=self.engine,
        )
        self.assertNotIn("<script>", res.email_body_html)
        self.assertIn("&lt;script&gt;alert(&#x27;xss&#x27;)&lt;/script&gt;", res.email_body_html)

    def test_zero_hits_disclaimer(self):
        """P5: 0-Treffer Hinweis wird bei 0 Barcode-Hits korrekt eingebunden."""
        self.engine.lookup_barcode.side_effect = None
        self.engine.lookup_barcode.return_value = []
        items = [{"sku": "SKU-OK", "ean": "4099979071513"}]
        res = execute_free_check(
            sender_email="test@shop.de",
            items=items,
            engine=self.engine,
        )
        self.assertEqual(res.barcode_hits, 0)
        self.assertIn("Hinweis zu 0 Treffern", res.email_body_html)
        self.assertIn("0 Treffer im EU Safety Gate bedeuten nicht automatisch", res.report_markdown)

    def test_attachment_max_size_rejection(self):
        """P3: Uebergrosse Dateien (> 10 MB) werden verworfen."""
        huge_bytes = b"x" * (11 * 1024 * 1024)
        parsed = parse_attachment_items("huge.xlsx", huge_bytes)
        self.assertEqual(parsed, [])

    def test_zip_bomb_rejection(self):
        """P3: Zip-Bombs mit unkomprimierter Groesse > 25 MB werden abgewiesen."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            # Erzeuge virtuelle Datei mit unkomprimiert 30 MB
            info = zipfile.ZipInfo("xl/worksheets/sheet1.xml")
            info.file_size = 30 * 1024 * 1024
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, b"0" * 1000)

        bomb_bytes = buf.getvalue()
        parsed = parse_xlsx_sheets(bomb_bytes)
        self.assertEqual(parsed, [])

    def test_execute_free_check_with_real_safety_gate_engine(self):
        """Verifiziert, dass execute_free_check auch ohne Mocks mit der echten SafetyGateEngine laeuft."""
        real_engine = SafetyGateEngine()
        items = [{"sku": "REAL-1", "ean": "4006381333931"}]
        res = execute_free_check(
            sender_email="real@fba.de",
            items=items,
            company="Real Shop GmbH",
            engine=real_engine,
        )
        self.assertEqual(res.screened_items, 1)
        self.assertTrue(len(res.report_markdown) > 0)
        self.assertTrue(len(res.report_html) > 0)


if __name__ == "__main__":
    unittest.main()
