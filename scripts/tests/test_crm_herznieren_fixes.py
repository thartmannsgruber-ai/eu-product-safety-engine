"""
scripts/tests/test_crm_herznieren_fixes.py
Verifiziert die Behebung der von Opus 5.5 im Herznieren-Audit aufgedeckten Schwachstellen:
1. Fail-Closed Blacklist bei Dateifehlern/Korruption
2. Vermeidung von False-Positive Opt-Outs bei Redewendungen wie 'No problem' / 'Pas de problème'
3. Vermeidung von False-Positive Opt-Outs aus reinem Zitat-Text
"""

import tempfile
import unittest
from pathlib import Path

from scripts.crm.blacklist import (
    BlacklistManager,
    BlacklistedRecipientError,
)
from scripts.crm.classifier import Intent, classify_intent


class TestHerznierenFixes(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.blacklist_file = Path(self.temp_dir.name) / "blacklist.json"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_fail_closed_on_corrupt_blacklist_file(self):
        """Befund 1: Korrupte oder beschaedigte Blacklist-Datei muss fail-closed sperren!"""
        # Schreibe ungueltiges JSON
        self.blacklist_file.write_text("{corrupt-json", encoding="utf-8")
        
        mgr = BlacklistManager(blacklist_file=self.blacklist_file)
        # Darf keinesfalls stillschweigend True liefern!
        self.assertFalse(mgr.can_contact("lead@example.com"))
        with self.assertRaises(BlacklistedRecipientError):
            mgr.assert_can_contact("lead@example.com")

    def test_no_problem_does_not_trigger_optout(self):
        """Befund 4: 'No problem' oder 'Pas de problème' darf kein Opt-Out ausloesen."""
        res_en = classify_intent(
            "No problem, please check our barcode 4006501123456",
            "Re: Product Safety Quick Check"
        )
        self.assertNotEqual(res_en.intent, Intent.NEGATIVE_OPTOUT)
        self.assertEqual(res_en.intent, Intent.POSITIVE_TEST_REQUEST)

        res_fr = classify_intent(
            "Pas de problème, voici notre EAN 3017620422003 pour le test.",
            "Re: Vérification sécurité"
        )
        self.assertNotEqual(res_fr.intent, Intent.NEGATIVE_OPTOUT)
        self.assertEqual(res_fr.intent, Intent.POSITIVE_TEST_REQUEST)

    def test_pure_quoted_text_does_not_trigger_optout(self):
        """Befund 3: Reines Zitat alter E-Mails darf kein Opt-Out ausloesen."""
        quoted_body = (
            "> Falls Sie keine E-Mails mehr wuenschen, antworten Sie mit Stop oder Kein Interesse.\n"
            "> Mit freundlichen Gruessen\n"
            "> Thomas"
        )
        res = classify_intent(quoted_body, "Re: Kaltaquise")
        self.assertNotEqual(res.intent, Intent.NEGATIVE_OPTOUT)


if __name__ == "__main__":
    unittest.main()
