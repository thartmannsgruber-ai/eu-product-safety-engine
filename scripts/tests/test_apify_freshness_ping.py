"""
scripts/tests/test_apify_freshness_ping.py
Unit tests fuer den Apify Freshness Ping (REST-API, Polling, Logging, Alarmierung).
Alle HTTP-Aufrufe sind ueber urllib.request.urlopen gemockt.
"""

import io
import json
import shutil
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import MagicMock, patch

import scripts.apify_freshness_ping as ping_mod


def _resp(payload):
    """Fake-Response als Context-Manager wie von urlopen geliefert."""
    m = MagicMock()
    m.read.return_value = json.dumps(payload).encode("utf-8")
    m.__enter__.return_value = m
    m.__exit__.return_value = False
    return m


def _run(run_id="RUN123", status="SUCCEEDED"):
    return _resp({"data": {"id": run_id, "status": status}})


class TestApifyFreshnessPing(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.log_file = self.tmp / "apify_ping_log.json"
        self.patches = [
            patch.object(ping_mod, "LOG_FILE", self.log_file),
            patch.object(ping_mod, "ENV_FILE", self.tmp / ".env"),
            patch.object(ping_mod, "sleep", lambda s: None),
            patch.dict("os.environ", {"APIFY_TOKEN": "tok_test"}, clear=False),
        ]
        for p in self.patches:
            p.start()
        self.alert = patch.object(ping_mod, "send_alert", return_value=True).start()

    def tearDown(self):
        patch.stopall()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _log(self):
        return json.loads(self.log_file.read_text(encoding="utf-8"))

    # ------------------------------------------------------------------ #
    @patch("urllib.request.urlopen")
    def test_success_records_real_run_id(self, mock_open):
        mock_open.return_value = _run("YZj4fwBE5g4KWN1le", "SUCCEEDED")
        self.assertTrue(ping_mod.run_ping())

        entry = self._log()[-1]
        self.assertEqual(entry["run_id"], "YZj4fwBE5g4KWN1le")
        self.assertEqual(entry["status"], "SUCCEEDED")
        self.assertTrue(entry["success"])
        self.assertEqual(entry["method"], "rest_api")
        self.alert.assert_not_called()

        req = mock_open.call_args[0][0]
        self.assertEqual(req.get_method(), "POST")
        self.assertIn("/v2/acts/thfc_labs~eu-product-safety-actor/runs", req.full_url)
        self.assertIn("waitForFinish=60", req.full_url)
        self.assertEqual(req.get_header("Authorization"), "Bearer tok_test")
        self.assertEqual(json.loads(req.data), ping_mod.TEST_INPUT)

    def test_no_cli_dependency(self):
        src = Path(ping_mod.__file__).read_text(encoding="utf-8")
        self.assertNotIn("subprocess", src)
        self.assertNotIn("shutil.which", src)
        self.assertFalse(hasattr(ping_mod, "find_apify_bin"))

    @patch("urllib.request.urlopen")
    def test_missing_token_alerts_without_http(self, mock_open):
        with patch.dict("os.environ", {"APIFY_TOKEN": ""}):
            self.assertFalse(ping_mod.run_ping())
        mock_open.assert_not_called()
        entry = self._log()[-1]
        self.assertEqual(entry["status"], "NO_TOKEN")
        self.assertFalse(entry["success"])
        self.alert.assert_called_once()
        self.assertIn("NO_TOKEN", self.alert.call_args[0][0])

    def test_token_fallback_from_env_file(self):
        (self.tmp / ".env").write_text("FOO=1\nAPIFY_TOKEN='from_file'\n", encoding="utf-8")
        with patch.dict("os.environ", {"APIFY_TOKEN": ""}):
            self.assertEqual(ping_mod.load_token(), "from_file")

    @patch("urllib.request.urlopen")
    def test_http_401_alerts(self, mock_open):
        mock_open.side_effect = urllib.error.HTTPError(
            "url", 401, "Unauthorized", {}, io.BytesIO(b'{"error":"invalid token"}'))
        self.assertFalse(ping_mod.run_ping())
        entry = self._log()[-1]
        self.assertEqual(entry["status"], "HTTP_ERROR")
        self.assertIn("401", entry["error"])
        self.alert.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_http_500_alerts(self, mock_open):
        mock_open.side_effect = urllib.error.HTTPError("url", 500, "ISE", {}, io.BytesIO(b""))
        self.assertFalse(ping_mod.run_ping())
        self.assertEqual(self._log()[-1]["status"], "HTTP_ERROR")
        self.alert.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_network_timeout_alerts(self, mock_open):
        mock_open.side_effect = TimeoutError("timed out")
        self.assertFalse(ping_mod.run_ping())
        self.assertEqual(self._log()[-1]["status"], "TIMEOUT")
        self.alert.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_urlerror_with_timeout_reason(self, mock_open):
        mock_open.side_effect = urllib.error.URLError(TimeoutError("timed out"))
        self.assertFalse(ping_mod.run_ping())
        self.assertEqual(self._log()[-1]["status"], "TIMEOUT")

    @patch("urllib.request.urlopen")
    def test_failed_status_alerts(self, mock_open):
        mock_open.return_value = _run("RUNF", "FAILED")
        self.assertFalse(ping_mod.run_ping())
        entry = self._log()[-1]
        self.assertEqual(entry["status"], "FAILED")
        self.assertEqual(entry["run_id"], "RUNF")
        self.alert.assert_called_once()
        self.assertIn("RUNF", self.alert.call_args[0][0])

    @patch("urllib.request.urlopen")
    def test_polls_until_succeeded(self, mock_open):
        mock_open.side_effect = [_run("RUNP", "RUNNING"), _run("RUNP", "RUNNING"), _run("RUNP", "SUCCEEDED")]
        self.assertTrue(ping_mod.run_ping())
        self.assertEqual(mock_open.call_count, 3)
        poll_req = mock_open.call_args_list[1][0][0]
        self.assertEqual(poll_req.get_method(), "GET")
        self.assertIn("/v2/actor-runs/RUNP", poll_req.full_url)
        self.assertEqual(self._log()[-1]["run_id"], "RUNP")
        self.alert.assert_not_called()

    @patch("urllib.request.urlopen")
    def test_running_beyond_budget_is_timeout(self, mock_open):
        mock_open.return_value = _run("RUNT", "RUNNING")
        clock = iter([0, 0, 100, 200, 301, 400, 500, 600])
        with patch.object(ping_mod, "monotonic", lambda: next(clock)):
            self.assertFalse(ping_mod.run_ping())
        entry = self._log()[-1]
        self.assertEqual(entry["status"], "TIMEOUT")
        self.assertEqual(entry["run_id"], "RUNT")
        self.alert.assert_called_once()

    @patch("urllib.request.urlopen")
    def test_missing_run_id_is_failure(self, mock_open):
        mock_open.return_value = _resp({"data": {}})
        self.assertFalse(ping_mod.run_ping())
        self.assertEqual(self._log()[-1]["status"], "FAILED")

    @patch("urllib.request.urlopen")
    def test_log_rotation_and_corrupt_recovery(self, mock_open):
        mock_open.return_value = _run()
        self.log_file.write_text("{not json", encoding="utf-8")
        ping_mod.run_ping()
        self.assertEqual(len(self._log()), 1)
        self.assertTrue(list(self.tmp.glob("apify_ping_log.corrupt.*")))

        self.log_file.write_text(json.dumps([{"i": i} for i in range(60)]), encoding="utf-8")
        ping_mod.run_ping()
        log = self._log()
        self.assertEqual(len(log), 50)
        self.assertEqual(log[-1]["run_id"], "RUN123")

    def test_alert_failure_does_not_crash(self):
        patch.stopall()  # echte send_alert verwenden
        with patch("scripts.crm.telegram_bot.get_default_bot", side_effect=RuntimeError("boom")):
            self.assertFalse(ping_mod.send_alert("x"))

if __name__ == "__main__":
    unittest.main()
