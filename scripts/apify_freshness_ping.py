#!/usr/bin/env python3
"""
scripts/apify_freshness_ping.py

Automated daily freshness and reliability ping for the Apify Actor:
thfc_labs/eu-product-safety-actor

Executes a lightweight single-EAN verification check via Apify CLI,
keeping the actor in "Active / Succeeded recently" status on Apify Store.
Records telemetry to .market/apify_ping_log.json with atomic writes.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
LOG_FILE = BASE_DIR / ".market" / "apify_ping_log.json"
ACTOR_ID = "thfc_labs/eu-product-safety-actor"
TEST_INPUT = json.dumps({"ean": "5054298241091", "maxItems": 1})


def find_apify_bin() -> str:
    """Findet das apify Binary portabel ueber PATH oder bekannte Installationspfade."""
    bin_path = shutil.which("apify")
    if bin_path and os.path.exists(bin_path):
        return bin_path

    # Fallback auf Standard-User-Pfade
    user_home = Path.home()
    candidates = [
        user_home / ".gemini" / "antigravity" / "bin" / "apify",
        user_home / ".nvm" / "versions" / "node" / "current" / "bin" / "apify",
        Path("/usr/local/bin/apify"),
        Path("/usr/bin/apify"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)

    return "apify"


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
                    # Backup des korrupten Files anlegen statt still zu ueberschreiben
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


def run_ping() -> bool:
    iso_now = datetime.now(timezone.utc).isoformat()
    print(f"[{iso_now}] Starting Apify Freshness Ping for {ACTOR_ID}...")
    start_time = time.monotonic()
    apify_bin = find_apify_bin()

    cmd = [
        apify_bin,
        "call",
        ACTOR_ID,
        "--input", TEST_INPUT,
        "--json"
    ]

    duration = 0.0
    run_id = None
    status = "FAILED"
    error_detail = None
    success = False

    sub_env = os.environ.copy()
    if not sub_env.get("APIFY_TOKEN"):
        env_file = BASE_DIR / ".env"
        if env_file.exists():
            try:
                with open(env_file, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line.startswith("APIFY_TOKEN="):
                            sub_env["APIFY_TOKEN"] = line.split("=", 1)[1].strip().strip("'\"")
                            break
            except Exception:
                pass

    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=120,
            env=sub_env
        )
        duration = round(time.monotonic() - start_time, 2)
        stdout_raw = proc.stdout.strip()
        stderr_raw = proc.stderr.strip()

        if proc.returncode == 0:
            # Versuche vollen JSON-String oder JSON-Block via Regex zu parsen
            parsed_data = None
            try:
                parsed_data = json.loads(stdout_raw)
            except Exception:
                json_match = re.search(r"(\{[\s\S]*\})", stdout_raw)
                if json_match:
                    try:
                        parsed_data = json.loads(json_match.group(1))
                    except Exception:
                        pass

            if isinstance(parsed_data, dict):
                run_id = parsed_data.get("id") or parsed_data.get("runId")
                status = parsed_data.get("status", "SUCCEEDED")
            else:
                status = "SUCCEEDED"

            # Nur wenn der Status auch wirklich SUCCEEDED ist, gilt der Ping als Erfolg
            success = (status == "SUCCEEDED")
            if not success:
                error_detail = f"Actor finished with non-success status: {status}"
        else:
            status = "FAILED"
            error_detail = stderr_raw or stdout_raw or f"Exit code {proc.returncode}"
            print(f"[ERROR] Apify CLI failed (code {proc.returncode}): {error_detail}", file=sys.stderr)

    except subprocess.TimeoutExpired as te:
        duration = round(time.monotonic() - start_time, 2)
        status = "TIMED_OUT"
        error_detail = f"Subprocess timed out after {te.timeout}s"
        print(f"[ERROR] {error_detail}", file=sys.stderr)
    except FileNotFoundError as fnf:
        duration = round(time.monotonic() - start_time, 2)
        status = "CLI_NOT_FOUND"
        error_detail = f"Apify binary not found: {fnf}"
        print(f"[ERROR] {error_detail}", file=sys.stderr)
    except Exception as e:
        duration = round(time.monotonic() - start_time, 2)
        status = "ERROR"
        error_detail = f"Unexpected exception: {e}"
        print(f"[ERROR] {error_detail}", file=sys.stderr)

    iso_done = datetime.now(timezone.utc).isoformat()
    print(f"[{iso_done}] Ping finished in {duration}s. Status: {status} (Run ID: {run_id})")

    log_entry = {
        "timestamp": iso_done,
        "actor": ACTOR_ID,
        "status": status,
        "duration_seconds": duration,
        "run_id": run_id,
        "success": success,
        "error": error_detail
    }

    try:
        save_log_entry(log_entry)
    except Exception as save_err:
        print(f"[WARN] Failed to save log entry: {save_err}", file=sys.stderr)

    return success


if __name__ == "__main__":
    ok = run_ping()
    sys.exit(0 if ok else 1)
