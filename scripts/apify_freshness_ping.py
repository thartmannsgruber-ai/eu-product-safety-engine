#!/usr/bin/env python3
"""
scripts/apify_freshness_ping.py

Automated daily freshness and reliability ping for the Apify Actor:
thfc_labs/eu-product-safety-actor

Executes a lightweight single-EAN verification check via Apify CLI or Apify API,
keeping the actor in "Active / Succeeded recently" status on Apify Store.
Records telemetry to .market/apify_ping_log.json.
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
LOG_FILE = BASE_DIR / ".market" / "apify_ping_log.json"
ACTOR_ID = "thfc_labs/eu-product-safety-actor"
TEST_INPUT = json.dumps({"ean": "5054298241091", "maxItems": 1})


def run_ping() -> bool:
    print(f"[{datetime.now(timezone.utc).isoformat()}] Starting Apify Freshness Ping for {ACTOR_ID}...")
    start_time = time.time()

    # Find apify CLI
    apify_bin = "/home/thomas_admin/.gemini/antigravity/bin/apify"
    if not os.path.exists(apify_bin):
        import shutil
        apify_bin = shutil.which("apify") or "apify"

    cmd = [
        apify_bin,
        "call",
        ACTOR_ID,
        "--input", TEST_INPUT,
        "--json"
    ]

    try:
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=120)
        duration = round(time.time() - start_time, 2)
        success = proc.returncode == 0

        run_id = None
        status = "FAILED"
        if success:
            try:
                # Find JSON in stdout
                lines = [line.strip() for line in proc.stdout.splitlines() if line.strip().startswith("{")]
                if lines:
                    data = json.loads(lines[-1])
                    run_id = data.get("id") or data.get("runId")
                    status = data.get("status", "SUCCEEDED")
                else:
                    status = "SUCCEEDED"
            except Exception:
                status = "SUCCEEDED"

        print(f"[{datetime.now(timezone.utc).isoformat()}] Ping finished in {duration}s. Status: {status} (Run ID: {run_id})")

        # Save log entry
        log_entry = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "actor": ACTOR_ID,
            "status": status,
            "duration_seconds": duration,
            "run_id": run_id,
            "success": success
        }

        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        history = []
        if LOG_FILE.exists():
            try:
                with open(LOG_FILE, "r", encoding="utf-8") as f:
                    history = json.load(f)
            except Exception:
                history = []
        history.append(log_entry)
        # Keep last 50 entries
        history = history[-50:]
        with open(LOG_FILE, "w", encoding="utf-8") as f:
            json.dump(history, f, indent=2)

        return success

    except subprocess.TimeoutExpired:
        print(f"[{datetime.now(timezone.utc).isoformat()}] Error: Ping timed out after 120s.")
        return False
    except Exception as e:
        print(f"[{datetime.now(timezone.utc).isoformat()}] Error during ping: {e}")
        return False


if __name__ == "__main__":
    ok = run_ping()
    sys.exit(0 if ok else 1)
