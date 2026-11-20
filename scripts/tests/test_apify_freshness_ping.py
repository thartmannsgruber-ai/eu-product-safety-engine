"""
scripts/tests/test_apify_freshness_ping.py
Unit tests for Apify freshness ping script (parsing, logging, timeouts, resilience).
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import scripts.apify_freshness_ping as ping_mod


class TestApifyFreshnessPing(unittest.TestCase):
    def setUp(self):
        self.test_dir = tempfile.mkdtemp(prefix="test_ping_")
        self.log_file = Path(self.test_dir) / "apify_ping_log.json"
        self._orig_log_file = ping_mod.LOG_FILE
        ping_mod.LOG_FILE = self.log_file

    def tearDown(self):
        ping_mod.LOG_FILE = self._orig_log_file
        shutil.rmtree(self.test_dir, ignore_errors=True)

    def test_run_ping_success_multiline_json(self):
        """Erfolgreicher Ping mit mehrzeiligem JSON-Output aus Apify CLI."""
        multiline_output = """
Warning: You are using an old version of Apify CLI.
{
  "id": "run_test_12345",
  "actId": "t77ASbKO8Ef7CFJhz",
  "status": "SUCCEEDED",
  "defaultDatasetId": "dataset_xyz"
}
"""
        mock_proc = MagicMock()
        mock_proc.returncode = 0
        mock_proc.stdout = multiline_output
        mock_proc.stderr = ""

        with patch("subprocess.run", return_value=mock_proc):
            res = ping_mod.run_ping()
            self.assertTrue(res)

        self.assertTrue(self.log_file.exists())
        with open(self.log_file, "r") as f:
            data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["status"], "SUCCEEDED")
            self.assertEqual(data[0]["run_id"], "run_test_12345")
            self.assertTrue(data[0]["success"])
            self.assertIsNone(data[0]["error"])

    def test_run_ping_cli_failure_logs_error(self):
        """Apify CLI schlaegt fehl (Code != 0) -> Fehler wird sauber protokolliert."""
        mock_proc = MagicMock()
        mock_proc.returncode = 1
        mock_proc.stdout = ""
        mock_proc.stderr = "Error: Authentication token expired. Please login."

        with patch("subprocess.run", return_value=mock_proc):
            res = ping_mod.run_ping()
            self.assertFalse(res)

        self.assertTrue(self.log_file.exists())
        with open(self.log_file, "r") as f:
            data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["status"], "FAILED")
            self.assertFalse(data[0]["success"])
            self.assertIn("Authentication token expired", data[0]["error"])

    def test_run_ping_timeout_logs_timed_out(self):
        """Subprocess laeuft ins Timeout -> status TIMED_OUT wird im Log festgehalten."""
        with patch("subprocess.run", side_effect=subprocess.TimeoutExpired(cmd=["apify"], timeout=120)):
            res = ping_mod.run_ping()
            self.assertFalse(res)

        self.assertTrue(self.log_file.exists())
        with open(self.log_file, "r") as f:
            data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["status"], "TIMED_OUT")
            self.assertIn("timed out after 120s", data[0]["error"])

    def test_save_log_entry_corrupt_file_backup(self):
        """Bestehendes Logfile ist korrupt -> Backup wird angelegt und Historie neu initialisiert."""
        with open(self.log_file, "w") as f:
            f.write("{ INVALID JSON NOT COMPLETE")

        ping_mod.save_log_entry({"status": "NEW_ENTRY"})

        # Backup-Datei muss existieren
        corrupt_backups = list(Path(self.test_dir).glob("apify_ping_log.corrupt.*"))
        self.assertTrue(len(corrupt_backups) >= 1)

        # Neues Logfile muss valide Liste sein
        with open(self.log_file, "r") as f:
            data = json.load(f)
            self.assertEqual(len(data), 1)
            self.assertEqual(data[0]["status"], "NEW_ENTRY")

    def test_save_log_entry_rotation_max_50(self):
        """Logfile wird auf maximal 50 Eintraege limitiert."""
        for i in range(60):
            ping_mod.save_log_entry({"index": i})

        with open(self.log_file, "r") as f:
            data = json.load(f)
            self.assertEqual(len(data), 50)
            self.assertEqual(data[0]["index"], 10)
            self.assertEqual(data[-1]["index"], 59)


if __name__ == "__main__":
    unittest.main()
