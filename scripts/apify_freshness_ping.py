#!/usr/bin/env python3
"""
scripts/apify_freshness_ping.py

Automated daily freshness and reliability ping for the Apify Actor:
thfc_labs/eu-product-safety-actor

Startet einen leichtgewichtigen Single-EAN-Run direkt ueber die Apify REST-API
(Bearer-Token aus APIFY_TOKEN, keine CLI / kein lokaler Login-Zustand), pollt
bis zu einem Endzustand (max. 5 Minuten) und schreibt Telemetrie atomar nach
.market/apify_ping_log.json. Bei fehlendem Token, HTTP-Fehler, Timeout oder
Status != SUCCEEDED wird ein Telegram-Alarm ausgeloest.
"""

from __future__ import annotations

import fcntl
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

LOG_FILE = BASE_DIR / ".market" / "apify_ping_log.json"
ENV_FILE = BASE_DIR / ".env"
ACTOR_ID = "thfc_labs/eu-product-safety-actor"
API_BASE = "https://api.apify.com/v2"
TEST_INPUT: Dict[str, Any] = {"ean": "5054298241091", "maxItems": 1}

WAIT_FOR_FINISH_SECS = 60          # Server-seitiges Long-Polling beim Start (Apify max. 60)
MAX_TOTAL_WAIT_SECS = 300          # Gesamtbudget bis Endzustand (5 Min)
POLL_INTERVAL_SECS = 10
HTTP_TIMEOUT_SECS = 90

TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT", "TIMED_OUT"}

# Injizierbar fuer Tests
sleep: Callable[[float], None] = time.sleep
monotonic: Callable[[], float] = time.monotonic


class PingError(Exception):
    """Fehler beim Ping mit klassifiziertem Status fuer das Log."""

    def __init__(self, status: str, detail: str, run_id: Optional[str] = None) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.run_id = run_id


# --------------------------------------------------------------------------- #
# Konfiguration
# --------------------------------------------------------------------------- #
def load_token(env_file: Optional[Path] = None) -> Optional[str]:
    """APIFY_TOKEN aus Umgebung, sonst aus .env. Leere Werte zaehlen als fehlend."""
    token = (os.environ.get("APIFY_TOKEN") or "").strip()
    if token:
        return token
    path = env_file or ENV_FILE
    if path.exists():
        try:
            for line in path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("APIFY_TOKEN="):
                    val = line.split("=", 1)[1].strip().strip("'\"")
                    return val or None
        except Exception:
            return None
    return None


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def _api_request(method: str, url: str, token: str, body: Optional[Dict[str, Any]] = None,
                 timeout: float = HTTP_TIMEOUT_SECS) -> Dict[str, Any]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/json")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read().decode("utf-8")
    try:
        parsed = json.loads(raw) if raw else {}
    except json.JSONDecodeError as e:
        raise PingError("FAILED", f"Invalid JSON from Apify API: {e}") from e
    if not isinstance(parsed, dict):
        raise PingError("FAILED", "Unexpected Apify API response shape")
    return parsed


def _extract_run(payload: Dict[str, Any]) -> Tuple[Optional[str], Optional[str]]:
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    return data.get("id"), data.get("status")


def start_run(token: str) -> Tuple[Optional[str], Optional[str]]:
    actor_path = urllib.parse.quote(ACTOR_ID.replace("/", "~"), safe="~")
    url = f"{API_BASE}/acts/{actor_path}/runs?waitForFinish={WAIT_FOR_FINISH_SECS}"
    return _extract_run(_api_request("POST", url, token, TEST_INPUT))


def get_run(token: str, run_id: str) -> Tuple[Optional[str], Optional[str]]:
    url = f"{API_BASE}/actor-runs/{urllib.parse.quote(run_id)}?waitForFinish={POLL_INTERVAL_SECS}"
    return _extract_run(_api_request("GET", url, token))


def execute_run(token: str) -> Tuple[str, str]:
    """Startet den Run und pollt bis Endzustand. Gibt (run_id, status) zurueck."""
    started = monotonic()
    try:
        run_id, status = start_run(token)
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise PingError("HTTP_ERROR", f"HTTP {e.code} on run start: {detail}".strip()) from e
    except urllib.error.URLError as e:
        kind = "TIMEOUT" if isinstance(e.reason, TimeoutError) else "HTTP_ERROR"
        raise PingError(kind, f"Network error on run start: {e.reason}") from e
    except TimeoutError as e:
        raise PingError("TIMEOUT", f"Timeout on run start: {e}") from e

    if not run_id:
        raise PingError("FAILED", "Apify API response contained no run id")

    status = (status or "").upper()
    while status not in TERMINAL_STATUSES:
        if monotonic() - started >= MAX_TOTAL_WAIT_SECS:
            raise PingError("TIMEOUT",
                            f"Run did not reach terminal state within {MAX_TOTAL_WAIT_SECS}s "
                            f"(last status: {status or 'UNKNOWN'})", run_id)
        sleep(POLL_INTERVAL_SECS)
        try:
            _, new_status = get_run(token, run_id)
        except urllib.error.HTTPError as e:
            raise PingError("HTTP_ERROR", f"HTTP {e.code} while polling run", run_id) from e
        except urllib.error.URLError as e:
            kind = "TIMEOUT" if isinstance(e.reason, TimeoutError) else "HTTP_ERROR"
            raise PingError(kind, f"Network error while polling run: {e.reason}", run_id) from e
        except TimeoutError as e:
            raise PingError("TIMEOUT", f"Timeout while polling run: {e}", run_id) from e
        status = (new_status or "").upper()

    return run_id, status


# --------------------------------------------------------------------------- #
# Logging & Alarm
# --------------------------------------------------------------------------- #
def save_log_entry(entry: dict) -> None:
    """Schreibt den Log-Eintrag atomar unter Prozess-Locking und haelt max. 50 Eintraege."""
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    lock_file = LOG_FILE.with_suffix(".lock")

    with open(lock_file, "w") as lock_fd:
        fcntl.flock(lock_fd, fcntl.LOCK_EX)
        try:
            history = []
            if LOG_FILE.exists():
                try:
                    with open(LOG_FILE, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        if isinstance(data, list):
                            history = data
                        elif isinstance(data, dict):
                            history = [data]
                except Exception as e:
                    backup_path = LOG_FILE.with_suffix(f".corrupt.{int(time.time())}")
                    try:
                        LOG_FILE.rename(backup_path)
                        print(f"[WARN] Corrupt logfile moved to {backup_path.name}: {e}", file=sys.stderr)
                    except Exception:
                        pass
                    history = []

            history.append(entry)
            history = history[-50:]

            temp_path = LOG_FILE.with_suffix(f".tmp.{os.getpid()}")
            with open(temp_path, "w", encoding="utf-8") as f:
                json.dump(history, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            temp_path.replace(LOG_FILE)
        finally:
            fcntl.flock(lock_fd, fcntl.LOCK_UN)


def send_alert(text: str) -> bool:
    """Telegram-Alarm. Darf den Ping niemals zum Absturz bringen."""
    try:
        from scripts.crm.telegram_bot import get_default_bot
        res = get_default_bot().send_message(text, parse_mode="HTML")
        return bool(isinstance(res, dict) and res.get("ok"))
    except Exception as e:
        print(f"[WARN] Telegram alert failed: {e}", file=sys.stderr)
        return False


def _html_escape(s: str) -> str:
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #
def run_ping() -> bool:
    iso_now = datetime.now(timezone.utc).isoformat()
    print(f"[{iso_now}] Starting Apify Freshness Ping for {ACTOR_ID} (REST API)...")
    start_time = monotonic()

    run_id: Optional[str] = None
    status = "UNKNOWN"
    error_detail: Optional[str] = None

    token = load_token()
    if not token:
        status = "NO_TOKEN"
        error_detail = "APIFY_TOKEN missing in environment and .env"
    else:
        try:
            run_id, status = execute_run(token)
            if status != "SUCCEEDED":
                error_detail = f"Actor finished with non-success status: {status}"
        except PingError as e:
            status, error_detail, run_id = e.status, e.detail, e.run_id
        except Exception as e:  # Unerwartet -> trotzdem loggen + alarmieren
            status, error_detail = "FAILED", f"Unexpected error: {type(e).__name__}: {e}"

    success = status == "SUCCEEDED"
    duration = round(monotonic() - start_time, 2)

    log_entry = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "actor": ACTOR_ID,
        "status": status,
        "duration_seconds": duration,
        "run_id": run_id,
        "success": success,
        "error": error_detail,
        "method": "rest_api",
    }

    print(f"[{log_entry['timestamp']}] Ping finished in {duration}s. Status: {status} (Run ID: {run_id})")
    if error_detail:
        print(f"[ERROR] {error_detail}", file=sys.stderr)

    try:
        save_log_entry(log_entry)
    except Exception as save_err:
        print(f"[WARN] Failed to save log entry: {save_err}", file=sys.stderr)

    if not success:
        alert = (
            "🚨 <b>Apify Freshness Ping fehlgeschlagen</b>\n"
            f"Actor: <code>{ACTOR_ID}</code>\n"
            f"Status: <b>{_html_escape(status)}</b>\n"
            f"Run ID: <code>{run_id or '-'}</code>\n"
            f"Fehler: {_html_escape(error_detail or '-')[:500]}"
        )
        send_alert(alert)

    return success


if __name__ == "__main__":
    ok = run_ping()
    sys.exit(0 if ok else 1)
