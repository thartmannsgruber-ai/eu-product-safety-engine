"""
scripts/crm/daemon.py
24/7 Autonomer Hintergrund-Daemon fuer ProductSafetyEngine CRM:
- Scannt das Postfach kontinuierlich nach Lead-Antworten.
- Erkennung von Absagen -> Sofortige Blacklist (Goldene Regel) + Telegram-Ping.
- Erkennung von Testanfragen mit EANs -> Engine-Anstoss + Report + Telegram-HITL-Push.
- Verarbeitet Telegram-Klicks (Freigeben / Ablehnen) in Echtzeit.
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

# Sicherstellen, dass das Projektverzeichnis im sys.path liegt
project_root = Path(__file__).resolve().parent.parent.parent
if str(project_root) not in sys.path:
    sys.path.insert(0, str(project_root))

from scripts.crm.crawler import InboundMailCrawler
from scripts.crm.telegram_bot import get_default_bot

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger("CRM.Daemon")


def run_daemon(poll_interval: int = 15, mail_check_interval: int = 120, max_runs: int = 0) -> None:
    """
    Hauptschleife des Daemons:
    - poll_interval: Sekunden zwischen Telegram-Polls (fuer verzweiflungsfreie Echtzeit-Reaktion)
    - mail_check_interval: Sekunden zwischen Postfach-Scans
    - max_runs: 0 fuer Endlosschleife, > 0 fuer kontrollierte Test-Laeufe
    """
    bot = get_default_bot()
    crawler = InboundMailCrawler(auto_draft=True)

    logger.info("=========================================================")
    logger.info("  PRODUCT SAFETY ENGINE CRM - 24/7 DAEMON GESTARTET")
    logger.info(f"  Bot: @{bot.get_me().get('result', {}).get('username', 'unbekannt')}")
    logger.info(f"  Telegram Poll: alle {poll_interval}s | Mail Scan: alle {mail_check_interval}s")
    logger.info("=========================================================")

    last_mail_check = 0.0
    runs = 0
    telegram_offset = 0

    while True:
        try:
            # 1. Telegram Updates verarbeiten (Button-Klicks & Chat-ID Erfassung)
            updates = bot.get_updates(offset=telegram_offset, timeout=poll_interval)
            for u in updates:
                telegram_offset = max(telegram_offset, u.get("update_id", 0) + 1)
                bot.handle_update(u)

            # 2. Regelmaessiger Postfach-Scan
            now = time.time()
            if now - last_mail_check >= mail_check_interval:
                last_mail_check = now
                try:
                    logger.info("[DAEMON] Fuehre Postfach-Scan aus...")
                    # Versuche IMAP-Crawl (ignoriert Fehler sauber, falls Mailbox leer oder temporaer offline)
                    results = crawler.crawl_imap(folder="INBOX", unread_only=True)
                    if results:
                        logger.info(f"[DAEMON] {len(results)} neue Inbound-Nachrichten verarbeitet.")
                except ValueError as ve:
                    # Fehlende IMAP-Credentials werden protokolliert, blockieren den Daemon aber nicht
                    logger.debug(f"[DAEMON] IMAP Scan uebersprungen: {ve}")
                except Exception as mail_exc:
                    logger.warning(f"[DAEMON] Fehler beim IMAP-Scan: {mail_exc}")

            runs += 1
            if max_runs > 0 and runs >= max_runs:
                logger.info(f"[DAEMON] max_runs={max_runs} erreicht. Beende Schleife.")
                break

        except KeyboardInterrupt:
            logger.info("[DAEMON] Beende Daemon auf Nutzeranforderung.")
            break
        except Exception as loop_exc:
            logger.error(f"[DAEMON] Unerwarteter Fehler im Loop: {loop_exc}")
            time.sleep(5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="24/7 CRM Daemon")
    parser.add_argument("--poll-interval", type=int, default=10, help="Telegram-Poll Intervall in Sekunden")
    parser.add_argument("--mail-interval", type=int, default=120, help="E-Mail-Scan Intervall in Sekunden")
    parser.add_argument("--once", action="store_true", help="Einmaliger Durchlauf (kein Loop)")
    args = parser.parse_args()

    max_r = 1 if args.once else 0
    run_daemon(poll_interval=args.poll_interval, mail_check_interval=args.mail_interval, max_runs=max_r)
