#!/usr/bin/env python3
"""
scripts/crm_cli.py
Intuitive CRM CLI fuer Thomas (ProductSafetyEngine).

Befehle:
- status: Gesamtuebersicht ueber Leads, Review-Queue und Blacklist
- queue: Zeigt Entwuerfe in der HITL Review-Queue (optional gefiltert nach Status)
- show <id>: Zeigt vollstaendige Details eines Entwurfs (Header, Threading, Body, History)
- approve <id>: Gibt einen Entwurf fuer den Versand frei (Status -> APPROVED)
- reject <id>: Lehnt einen Entwurf ab (Status -> REJECTED)
- send: Versendet freigegebene Entwuerfe (Status APPROVED) via Resend API / SMTP
- blacklist: Verwaltet und visualisiert die permanente Opt-Out Blacklist (list, add, remove, check)
- scan: Scannt das Inbound-Postfach nach neuen Antworten und Leads via IMAP
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# Projekt-Root zum Python-Pfad hinzufuegen
BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    add_to_blacklist,
    get_default_manager,
    is_blacklisted,
    normalize_email,
)
from scripts.crm.dispatcher import (
    DispatchResult,
    EmailDispatcher,
    UnapprovedDraftError,
    get_default_dispatcher,
)
from scripts.crm.review_queue import (
    DraftNotFoundError,
    DraftStatus,
    InvalidStatusTransitionError,
    ReviewQueue,
    get_default_queue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    get_default_storage,
)


def cmd_status(args: argparse.Namespace) -> int:
    """Zeigt das CRM-Dashboard (Leads, Queue, Blacklist)."""
    storage = get_default_storage()
    queue = get_default_queue()
    blacklist_mgr = get_default_manager()

    leads = storage.list_leads()
    queue_counts = queue.count_by_status()
    blacklist_entries = blacklist_mgr.list_entries()

    # Zaehlung der Leads nach Status
    lead_counts: Dict[str, int] = {}
    for l in leads:
        st = l.get("status", "UNKNOWN")
        lead_counts[st] = lead_counts.get(st, 0) + 1

    print("\n" + "=" * 65)
    print("        PRODUCT SAFETY ENGINE - CRM DASHBOARD")
    print("=" * 65)

    print("\n[1] LEADS LIFECYCLE (leads_db.json):")
    print(f"    Gesamtanzahl Leads:      {len(leads)}")
    print(f"    - NOT_SENT:              {lead_counts.get(LeadStatus.NOT_SENT, 0)}")
    print(f"    - OUTREACH_SENT:         {lead_counts.get(LeadStatus.OUTREACH_SENT, 0)}")
    print(f"    - FOLLOWUP_SENT:         {lead_counts.get(LeadStatus.FOLLOWUP_SENT, 0)}")
    print(f"    - CHANNEL_RESTRICTED:    {lead_counts.get(LeadStatus.CHANNEL_RESTRICTED, 0)} (Kaltakquise-Rechts-Gate AT/PL)")
    print(f"    - REPLIED_POSITIVE:      {lead_counts.get(LeadStatus.REPLIED_POSITIVE, 0)}")
    print(f"    - REPLIED_INQUIRY:       {lead_counts.get(LeadStatus.REPLIED_INQUIRY, 0)}")
    print(f"    - LOST_BLACKLISTED:      {lead_counts.get(LeadStatus.LOST_BLACKLISTED, 0)}")
    print(f"    - BOUNCED:               {lead_counts.get(LeadStatus.BOUNCED, 0)} (Hard-Bounce 5.x.x, terminal)")

    print("\n[2] REVIEW QUEUE (review_queue.json):")
    total_drafts = sum(queue_counts.values())
    print(f"    Gesamtanzahl Entwuerfe:  {total_drafts}")
    print(f"    - PENDING_REVIEW:        {queue_counts.get(DraftStatus.PENDING_REVIEW, 0)} (Wartet auf Pruefung)")
    print(f"    - APPROVED:              {queue_counts.get(DraftStatus.APPROVED, 0)} (Bereit zum Versand)")
    print(f"    - REJECTED:              {queue_counts.get(DraftStatus.REJECTED, 0)} (Abgelehnt)")
    print(f"    - SENT:                  {queue_counts.get(DraftStatus.SENT, 0)} (Erfolgreich versendet)")

    print("\n[3] PERMANENTE OPT-OUT BLACKLIST (blacklist.json):")
    print(f"    Gesperrte Adressen:      {len(blacklist_entries)} (Ausnahmsloser Kontaktschutz)")

    from scripts.crm.followup_engine import get_default_linkedin_mgr
    li_mgr = get_default_linkedin_mgr()
    li_tasks = li_mgr.list_tasks()
    li_pending = len([t for t in li_tasks if t.get("status") == "PENDING"])
    print("\n[4] LINKEDIN SOCIAL-SELLING TASKS (linkedin_tasks.json):")
    print(f"    Offene Aufgaben:         {li_pending} (von {len(li_tasks)} gesamt)")
    print("=" * 65 + "\n")
    return 0


def cmd_queue(args: argparse.Namespace) -> int:
    """Listet Entwuerfe in der Review-Queue tabellarisch auf."""
    queue = get_default_queue()
    status_filter = getattr(args, "status", None)
    if status_filter:
        status_filter = status_filter.strip().upper()
        if status_filter == "ALL":
            status_filter = None

    drafts = queue.list_drafts(status=status_filter)

    print("\n" + "-" * 105)
    print(f"{'DRAFT ID':<26} | {'STATUS':<14} | {'RECIPIENT':<28} | {'LANG':<4} | {'SUBJECT'}")
    print("-" * 105)

    if not drafts:
        print(" Keine Entwuerfe vorhanden" + (f" mit Status {status_filter}" if status_filter else "") + ".")
    else:
        for d in drafts:
            draft_id = d.get("draft_id", "unknown")
            st = d.get("status", "UNKNOWN")
            recip = d.get("lead_email") or d.get("recipient") or "-"
            lang = (d.get("language") or "de").upper()
            subj = d.get("subject", "")
            if len(subj) > 30:
                subj = subj[:27] + "..."
            print(f"{draft_id:<26} | {st:<14} | {recip:<28} | {lang:<4} | {subj}")

    print("-" * 105)
    print(f"Gesamt: {len(drafts)} Entwuerfe angezeigt.\n")
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    """Zeigt vollstaendige Details eines Entwurfs an."""
    draft_id = getattr(args, "id", None)
    if not draft_id:
        print("[ERROR] Please provide a draft ID: crm_cli show <draft_id>")
        return 1

    queue = get_default_queue()
    draft = queue.get_draft(draft_id)
    if not draft:
        print(f"[ERROR] Draft '{draft_id}' not found in review queue.")
        return 1

    print("\n" + "=" * 80)
    print(f" DRAFT DETAILS: {draft_id}")
    print("=" * 80)
    print(f"Status:        {draft.get('status')}")
    print(f"Recipient:     {draft.get('lead_email') or draft.get('recipient')}")
    print(f"Company:       {draft.get('company', '-')}")
    print(f"Language:      {draft.get('language', '-').upper()}")
    print(f"Intent:        {draft.get('intent', '-')}")
    print(f"Subject:       {draft.get('subject', '-')}")
    print(f"In-Reply-To:   {draft.get('in_reply_to') or '(none)'}")
    print(f"References:    {draft.get('references') or '(none)'}")
    print(f"Created:       {draft.get('created_at', '-')}")
    print(f"Updated:       {draft.get('updated_at', '-')}")

    if draft.get("reviewed_by"):
        print(f"Reviewed by:   {draft.get('reviewed_by')} at {draft.get('approved_at') or draft.get('rejected_at')}")
    if draft.get("approval_note"):
        print(f"Approval Note: {draft.get('approval_note')}")
    if draft.get("rejection_reason"):
        print(f"Reject Reason: {draft.get('rejection_reason')}")

    print("\n" + "-" * 35 + " MAIL BODY " + "-" * 34)
    print(draft.get("body", "(Empty body)"))
    print("-" * 80)

    history = draft.get("history", [])
    if history:
        print("\nHISTORY / AUDIT TRAIL:")
        for h in history:
            print(f"  [{h.get('timestamp')}] {h.get('action')} - {h.get('note', '')}")

    print("=" * 80 + "\n")
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    """Gibt einen Entwurf frei (Status -> APPROVED)."""
    draft_id = getattr(args, "id", None)
    if not draft_id:
        print("[ERROR] Please provide a draft ID: crm_cli approve <draft_id>")
        return 1

    reviewer = getattr(args, "reviewer", "Thomas")
    note = getattr(args, "note", "") or ""

    queue = get_default_queue()
    draft = queue.get_draft(draft_id)
    if not draft:
        print(f"[ERROR] Draft '{draft_id}' not found in review queue.")
        return 1

    try:
        updated = queue.approve(draft_id=draft_id, reviewer=reviewer, note=note)
        print(f"[SUCCESS] Draft '{draft_id}' approved successfully for dispatch.")
        print(f"          Recipient: {updated.get('lead_email')}")
        print(f"          Status:    {updated.get('status')}")
        return 0
    except BlacklistedRecipientError as bre:
        print(f"[SECURITY BLOCKED] Cannot approve draft '{draft_id}': {bre}")
        return 1
    except InvalidStatusTransitionError as iste:
        print(f"[ERROR] Invalid status transition: {iste}")
        return 1
    except Exception as e:
        print(f"[ERROR] Failed to approve draft '{draft_id}': {e}")
        return 1


def cmd_reject(args: argparse.Namespace) -> int:
    """Lehnt einen Entwurf ab (Status -> REJECTED)."""
    draft_id = getattr(args, "id", None)
    if not draft_id:
        print("[ERROR] Please provide a draft ID: crm_cli reject <draft_id>")
        return 1

    reviewer = getattr(args, "reviewer", "Thomas")
    reason = getattr(args, "reason", "") or getattr(args, "note", "") or "Manuell abgelehnt"

    queue = get_default_queue()
    draft = queue.get_draft(draft_id)
    if not draft:
        print(f"[ERROR] Draft '{draft_id}' not found in review queue.")
        return 1

    try:
        updated = queue.reject(draft_id=draft_id, reviewer=reviewer, reason=reason)
        print(f"[SUCCESS] Draft '{draft_id}' rejected successfully.")
        print(f"          Reason: {reason}")
        print(f"          Status: {updated.get('status')}")
        return 0
    except InvalidStatusTransitionError as iste:
        print(f"[ERROR] Invalid status transition: {iste}")
        return 1
    except Exception as e:
        print(f"[ERROR] Failed to reject draft '{draft_id}': {e}")
        return 1


def cmd_send(args: argparse.Namespace) -> int:
    """Versendet freigegebene Entwuerfe (Status APPROVED) via Resend oder SMTP."""
    draft_id = getattr(args, "id", None)
    send_all = getattr(args, "all", False)
    dry_run = getattr(args, "dry_run", False)
    provider = getattr(args, "provider", "resend")
    limit = getattr(args, "limit", None)
    delay = getattr(args, "delay", 0.0)

    if not draft_id and not send_all:
        print("[ERROR] Please specify either --id <draft_id> or --all to dispatch approved drafts.")
        return 1

    dispatcher = EmailDispatcher(
        queue=get_default_queue(),
        blacklist_mgr=get_default_manager(),
        storage=get_default_storage(),
        provider=provider,
        dry_run=dry_run,
    )

    # Einzelempfaenger versenden
    if draft_id:
        print(f"\n[DISPATCH] Processing draft '{draft_id}' (Provider: {provider.upper()}, Dry-Run: {dry_run})...")
        try:
            res = dispatcher.dispatch_draft(draft_id, dry_run=dry_run)
            if res.status == "SENT":
                print(f"[SUCCESS] Dispatched successfully!")
                print(f"          Draft ID:   {res.draft_id}")
                print(f"          Recipient:  {res.recipient}")
                print(f"          Message ID: {res.message_id}")
                print(f"          Headers:    {res.headers}")
                return 0
            elif res.status == "DRY_RUN":
                print(f"[DRY RUN] Simulation successful (no email sent)!")
                print(f"          Draft ID:   {res.draft_id}")
                print(f"          Recipient:  {res.recipient}")
                print(f"          Headers:    {res.headers}")
                return 0
            else:
                print(f"[FAILED] Dispatch failed: {res.error}")
                return 1
        except UnapprovedDraftError as ude:
            print(f"[ERROR] Unapproved draft rejected: {ude}")
            return 1
        except BlacklistedRecipientError as bre:
            print(f"[SECURITY BLOCKED] Dispatch aborted: {bre}")
            return 1
        except DraftNotFoundError as dnfe:
            print(f"[ERROR] {dnfe}")
            return 1
        except Exception as e:
            print(f"[ERROR] Dispatch failed with unexpected exception: {e}")
            return 1

    # Alle APPROVED Entwuerfe versenden
    if send_all:
        queue = get_default_queue()
        approved_drafts = queue.list_drafts(status=DraftStatus.APPROVED)
        print(f"\n[DISPATCH] Found {len(approved_drafts)} approved drafts in review queue.")
        if not approved_drafts:
            print("[INFO] No approved drafts to send. Approve drafts first using 'crm_cli approve <id>'.")
            return 0

        results = dispatcher.dispatch_all_approved(limit=limit, delay_seconds=delay, dry_run=dry_run)
        sent_count = sum(1 for r in results if r.status in ("SENT", "DRY_RUN"))
        blocked_count = sum(1 for r in results if r.status == "BLOCKED_BLACKLIST")
        failed_count = sum(1 for r in results if r.status == "FAILED")

        print("\n" + "=" * 65)
        print(" DISPATCH SUMMARY")
        print("=" * 65)
        print(f" Total processed:       {len(results)}")
        print(f" Successfully sent:     {sent_count}")
        print(f" Blocked (Blacklist):   {blocked_count}")
        print(f" Failed:                {failed_count}")
        print("=" * 65 + "\n")
        return 0 if failed_count == 0 else 1

    return 0


def cmd_blacklist(args: argparse.Namespace) -> int:
    """Verwaltet die permanente Opt-Out Blacklist."""
    blacklist_mgr = get_default_manager()
    subaction = getattr(args, "blacklist_action", "list") or "list"

    if subaction == "list":
        entries = blacklist_mgr.list_entries()
        print("\n" + "=" * 80)
        print(f" PERMANENTE OPT-OUT BLACKLIST ({len(entries)} Eintraege)")
        print("=" * 80)
        if not entries:
            print(" Keine geblacklisteten E-Mail-Adressen vorhanden.")
        else:
            print(f"{'EMAIL':<35} | {'GRUND':<25} | {'DATUM'}")
            print("-" * 80)
            for e in entries:
                email_str = e.get("email", "")
                reason_str = e.get("reason", "")[:24]
                date_str = (e.get("blacklisted_at") or "")[:19]
                print(f"{email_str:<35} | {reason_str:<25} | {date_str}")
        print("=" * 80 + "\n")
        return 0

    elif subaction == "add":
        email_to_add = getattr(args, "email", None)
        if not email_to_add:
            print("[ERROR] Please specify an email to blacklist: crm_cli blacklist add <email>")
            return 1
        reason = getattr(args, "reason", "Opt-Out via CRM CLI") or "Opt-Out via CRM CLI"
        blacklist_mgr.add_to_blacklist(email=email_to_add, reason=reason)
        print(f"[SUCCESS] Added '{email_to_add}' permanently to blacklist.")
        return 0

    elif subaction == "remove":
        email_to_rm = getattr(args, "email", None)
        if not email_to_rm:
            print("[ERROR] Please specify an email to remove: crm_cli blacklist remove <email>")
            return 1
        removed = blacklist_mgr.remove_from_blacklist(email=email_to_rm)
        if removed:
            print(f"[SUCCESS] Removed '{email_to_rm}' from blacklist.")
        else:
            print(f"[INFO] '{email_to_rm}' was not in blacklist.")
        return 0

    elif subaction == "check":
        email_to_check = getattr(args, "email", None)
        if not email_to_check:
            print("[ERROR] Please specify an email to check: crm_cli blacklist check <email>")
            return 1
        norm_email = normalize_email(email_to_check)
        blocked = blacklist_mgr.is_blacklisted(norm_email)
        if blocked:
            entry = blacklist_mgr.get_blacklist().get(norm_email, {})
            print(f"[BLACKLISTED] '{norm_email}' is BLACKLISTED!")
            print(f"              Reason: {entry.get('reason')}")
            print(f"              Date:   {entry.get('blacklisted_at')}")
        else:
            print(f"[CLEAN] '{norm_email}' is NOT blacklisted (can be contacted).")
        return 0

    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    """Scannt das Postfach via Microsoft Graph oder IMAP nach neuen Inbound-Mails."""
    folder = getattr(args, "folder", "INBOX") or "INBOX"
    unread_only = not getattr(args, "all", False)

    try:
        from scripts.crm.crawler import InboundMailCrawler
        crawler = InboundMailCrawler()
        print(f"\n[SCAN] Scanning mailbox (Folder: '{folder}', Unread only: {unread_only})...")
        results = crawler.crawl(folder=folder, unread_only=unread_only)
        print(f"[SUCCESS] Scan completed. Processed {len(results)} inbound messages.\n")
        return 0
    except ValueError as ve:
        print(f"[WARNING] IMAP credentials missing or invalid: {ve}")
        print("          Please configure IMAP_HOST, IMAP_USER, IMAP_PASS in .env or environment.")
        return 1
    except Exception as e:
        print(f"[ERROR] Inbound scan failed: {e}")
        return 1


def cmd_cleanup(args: argparse.Namespace) -> int:
    """Bereinigt die Leads-Datenbank durch Abgleich mit sent_log.json."""
    from scripts.crm.storage import cleanup_leads_db
    stats = cleanup_leads_db()
    print("\n" + "=" * 65)
    print("        CRM LEADS DATABASE SANITATION (Feature F06)")
    print("=" * 65)
    print(f"    Gesamtanzahl Leads:            {stats['total']}")
    print(f"    Korrigiert auf NOT_SENT:       {stats['corrected_to_not_sent']}")
    print(f"    Bestehend OUTREACH_SENT:       {stats['kept_outreach_sent']}")
    print(f"    Bestehend LOST_BLACKLISTED:    {stats['kept_lost_blacklisted']}")
    print("=" * 65 + "\n")
    return 0


def cmd_bot(args: argparse.Namespace) -> int:
    """Verwaltet den 2-Wege Telegram Bot."""
    from scripts.crm.telegram_bot import get_default_bot
    bot = get_default_bot()

    action = getattr(args, "bot_action", "status")

    if action == "status":
        me = bot.get_me()
        print("\n=================================================================")
        print("          PRODUCT SAFETY ENGINE - TELEGRAM BOT STATUS")
        print("=================================================================")
        if me.get("ok"):
            res = me.get("result", {})
            print(f"Bot Name:      {res.get('first_name')}")
            print(f"Username:      @{res.get('username')}")
            print(f"Bot ID:        {res.get('id')}")
            print(f"Link:          https://t.me/{res.get('username')}")
            print(f"Chat-ID:       {bot.chat_id or '[NOCH NICHT GEKOPPELT - Drücke Start auf Telegram!]'}")
            print("Status:        ONLINE (Bereit für Push & HITL-Freigaben)")
        else:
            print(f"[ERROR] Bot Verbindung fehlgeschlagen: {me.get('error')}")
        print("=================================================================\n")
        return 0

    elif action == "poll":
        updates = bot.get_updates()
        print(f"[BOT] {len(updates)} Telegram Updates empfangen.")
        for u in updates:
            bot.handle_update(u)
        print(f"[BOT] Chat-ID Status: {bot.chat_id or 'Noch keine Chat-ID erfasst'}")
        return 0

    elif action == "test":
        if not bot.chat_id:
            print("[ERROR] Keine Chat-ID hinterlegt! Bitte zuerst t.me/ProductSafety_communicationbot öffnen und /start drücken.")
            return 1
        res = bot.send_message("👋 <b>Test-Push von der ProductSafetyEngine</b>\nVerbindung steht! Human-in-the-Loop Freigaben kommen hier an.")
        if res.get("ok"):
            print("[SUCCESS] Test-Nachricht erfolgreich an Thomas' iPhone gesendet!")
            return 0
        else:
            print(f"[ERROR] Senden fehlgeschlagen: {res.get('error')}")
            return 1

    return 0


def cmd_followup(args: argparse.Namespace) -> int:
    """Steuert den Follow-Up Zyklus fuer Leads im Status OUTREACH_SENT nach Grace Period."""
    from scripts.crm.followup_engine import get_default_followup_engine

    engine = get_default_followup_engine()
    action = getattr(args, "followup_action", "list")

    if action == "list":
        days = getattr(args, "days", 4.0)
        force = getattr(args, "force", False)
        eligible = engine.find_eligible_leads(grace_period_days=days, force=force)
        print("\n" + "=" * 75)
        print(f"   CRM FOLLOW-UP ENGINE: BERECHTIGTE LEADS (Grace Period: {days} Tage)")
        print("=" * 75)
        if not eligible:
            print(" Keine Leads erfuellen derzeit die Kriterien fuer einen Follow-Up.")
        else:
            for l in eligible:
                print(f" - {l.get('email'):<30} | {l.get('country', ''):<12} | {l.get('company', '')[:25]}")
        print(f"\n Gesamt: {len(eligible)} berechtigte Leads.\n")
        return 0

    elif action == "generate":
        days = getattr(args, "days", 4.0)
        auto_approve = getattr(args, "auto_approve", False)
        force = getattr(args, "force", False)
        drafts = engine.generate_followup_drafts(
            grace_period_days=days,
            auto_approve=auto_approve,
            force=force,
        )
        print(f"\n[SUCCESS] {len(drafts)} Follow-Up Entwuerfe generiert und in Review-Queue eingereiht.")
        for d in drafts:
            print(f" - [{d.get('draft_id')}] an {d.get('lead_email')} ({d.get('language')}) Status: {d.get('status')}")
        print("")
        return 0

    elif action == "dispatch":
        dry_run = getattr(args, "dry_run", False)
        limit = getattr(args, "limit", None)
        results = engine.dispatch_all_approved_followups(limit=limit, dry_run=dry_run)
        print(f"\n[DISPATCH] {len(results)} Follow-Up Entwuerfe abgearbeitet.")
        for r in results:
            print(f" - {r.draft_id} -> {r.recipient}: {r.status} (Provider: {r.provider})")
        print("")
        return 0

    return 0


def cmd_jurisdiction(args: argparse.Namespace) -> int:
    """Verwaltet das Kaltakquise-Rechts-Gate fuer AT (§ 107 TKG) und PL (Art. 172 Fernmeldegesetz)."""
    from scripts.crm.followup_engine import (
        get_default_jurisdiction_gate,
        get_default_linkedin_mgr,
    )

    gate = get_default_jurisdiction_gate()
    li_mgr = get_default_linkedin_mgr()
    action = getattr(args, "jurisdiction_action", "status")

    if action == "enforce":
        tasks = gate.enforce_jurisdiction_on_all_leads()
        print(f"\n[JURISDICTION GATE] {len(tasks)} Leads aus AT/PL identifiziert und umgeleitet:")
        for t in tasks:
            print(f" - {t.email} ({t.country}) -> Task {t.task_id} [{t.legal_basis[:40]}...]")
        print("")
        return 0

    elif action == "tasks":
        tasks = li_mgr.list_tasks()
        print("\n" + "=" * 85)
        print("        MANUELLE LINKEDIN / SOCIAL-SELLING OUTREACH AUFGABEN")
        print("=" * 85)
        if not tasks:
            print(" Keine LinkedIn-Tasks vorhanden.")
        else:
            for t in tasks:
                st = t.get("status", "PENDING")
                print(f" [{st:<9}] {t.get('task_id'):<18} | {t.get('company'):<25} | {t.get('country')}")
                print(f"              URL: {t.get('linkedin_search_url')}")
        print("=" * 85 + "\n")
        return 0

    elif action == "complete":
        task_id = getattr(args, "task_id", None)
        if not task_id:
            print("[ERROR] Bitte task_id angeben.")
            return 1
        res = li_mgr.complete_task(task_id, note="Erledigt via CLI")
        if res:
            print(f"[SUCCESS] Task {task_id} als COMPLETED markiert.")
            return 0
        else:
            print(f"[ERROR] Task {task_id} nicht gefunden.")
            return 1

    return 0


def build_parser() -> argparse.ArgumentParser:
    """Erstellt den ArgumentParser mit allen CLI-Befehlen."""
    parser = argparse.ArgumentParser(
        prog="crm_cli",
        description="ProductSafetyEngine CRM Command Line Interface for Thomas Hartmannsgruber.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Verfuegbare CRM-Befehle")

    # 1. status
    subparsers.add_parser("status", help="Zeigt CRM-Status (Leads, Queue, Blacklist)")

    # 2. queue
    p_queue = subparsers.add_parser("queue", help="Zeigt Entwuerfe in der HITL Review-Queue")
    p_queue.add_argument("--status", "-s", type=str, default=None, help="Filtert nach Status (PENDING_REVIEW, APPROVED, REJECTED, SENT, ALL)")

    # 3. show <id>
    p_show = subparsers.add_parser("show", help="Zeigt vollstaendige Details eines Entwurfs")
    p_show.add_argument("id", type=str, nargs="?", default=None, help="Die ID des Entwurfs (z.B. draft_2026...)")

    # 4. approve <id>
    p_approve = subparsers.add_parser("approve", help="Gibt einen Entwurf frei (Status -> APPROVED)")
    p_approve.add_argument("id", type=str, nargs="?", default=None, help="Die ID des Entwurfs")
    p_approve.add_argument("--reviewer", "-r", type=str, default="Thomas", help="Name des Pruefers (Default: Thomas)")
    p_approve.add_argument("--note", "-n", type=str, default="", help="Optionale Freigabe-Notiz")

    # 5. reject <id>
    p_reject = subparsers.add_parser("reject", help="Lehnt einen Entwurf ab (Status -> REJECTED)")
    p_reject.add_argument("id", type=str, nargs="?", default=None, help="Die ID des Entwurfs")
    p_reject.add_argument("--reviewer", "-r", type=str, default="Thomas", help="Name des Pruefers (Default: Thomas)")
    p_reject.add_argument("--reason", "--note", "-n", type=str, default="Abgelehnt durch Thomas", help="Grund der Ablehnung")

    # 6. send
    p_send = subparsers.add_parser("send", help="Versendet freigegebene Entwuerfe (Status APPROVED)")
    p_send.add_argument("--id", type=str, default=None, help="Einzelne Entwurfs-ID zum Versenden")
    p_send.add_argument("--all", action="store_true", default=False, help="Alle APPROVED Entwuerfe versenden")
    p_send.add_argument("--dry-run", action="store_true", default=False, help="Simuliert den Versand ohne Netzwerkaufruf")
    p_send.add_argument("--provider", choices=["resend", "exchange", "smtp"], default="resend", help="Versand-Provider (Default: resend)")
    p_send.add_argument("--limit", type=int, default=None, help="Maximale Anzahl zu versendender Mails")
    p_send.add_argument("--delay", type=float, default=0.0, help="Pause in Sekunden zwischen zwei Mails")

    # 7. blacklist
    p_bl = subparsers.add_parser("blacklist", help="Verwaltet die permanente Opt-Out Blacklist")
    bl_subparsers = p_bl.add_subparsers(dest="blacklist_action", help="Blacklist Aktionen")
    
    bl_subparsers.add_parser("list", help="Listet alle geblockten E-Mails auf")
    
    p_bl_add = bl_subparsers.add_parser("add", help="Fuegt eine E-Mail zur Blacklist hinzu")
    p_bl_add.add_argument("email", type=str, help="E-Mail-Adresse")
    p_bl_add.add_argument("--reason", "-r", type=str, default="Opt-Out via CRM CLI", help="Grund des Eintrags")
    
    p_bl_rm = bl_subparsers.add_parser("remove", help="Entfernt eine E-Mail von der Blacklist")
    p_bl_rm.add_argument("email", type=str, help="E-Mail-Adresse")
    
    p_bl_check = bl_subparsers.add_parser("check", help="Prueft ob eine E-Mail geblacklistet ist")
    p_bl_check.add_argument("email", type=str, help="E-Mail-Adresse")

    # 8. scan
    p_scan = subparsers.add_parser("scan", help="Scannt Inbound-Postfach nach Antworten via IMAP")
    p_scan.add_argument("--folder", type=str, default="INBOX", help="IMAP-Ordner (Default: INBOX)")
    p_scan.add_argument("--all", action="store_true", default=False, help="Alle Nachrichten scannen (Default: nur ungelesene)")

    # 9. bot
    p_bot = subparsers.add_parser("bot", help="Verwaltet den Telegram Bot (status, poll, test)")
    p_bot.add_argument("bot_action", choices=["status", "poll", "test"], nargs="?", default="status", help="Aktion (Default: status)")

    # 10. cleanup
    subparsers.add_parser("cleanup", help="Bereinigt Leads-Datenbank durch Abgleich mit sent_log.json (Feature F06)")

    # 11. followup
    p_fu = subparsers.add_parser("followup", help="Verwaltet den Follow-Up Zyklus fuer Leads im Status OUTREACH_SENT")
    p_fu_sub = p_fu.add_subparsers(dest="followup_action", help="Follow-Up Aktionen")
    
    p_fu_list = p_fu_sub.add_parser("list", help="Listet berechtigte Leads fuer Follow-Up auf")
    p_fu_list.add_argument("--days", type=float, default=4.0, help="Grace Period in Tagen (Default: 4)")
    p_fu_list.add_argument("--force", action="store_true", default=False, help="Erzwingt Einbezug unabhaengig vom Datum")

    p_fu_gen = p_fu_sub.add_parser("generate", help="Erstellt Follow-Up Entwuerfe in der Review Queue")
    p_fu_gen.add_argument("--days", type=float, default=4.0, help="Grace Period in Tagen (Default: 4)")
    p_fu_gen.add_argument("--auto-approve", action="store_true", default=False, help="Direkt als APPROVED markieren")
    p_fu_gen.add_argument("--force", action="store_true", default=False, help="Erzwingt Generierung unabhaengig vom Datum")

    p_fu_disp = p_fu_sub.add_parser("dispatch", help="Versendet freigegebene Follow-Up Entwuerfe")
    p_fu_disp.add_argument("--limit", type=int, default=None, help="Maximale Anzahl")
    p_fu_disp.add_argument("--dry-run", action="store_true", default=False, help="Simulierter Versand")

    # 12. jurisdiction
    p_jur = subparsers.add_parser("jurisdiction", help="Kaltakquise-Rechts-Gate fuer AT und PL")
    p_jur_sub = p_jur.add_subparsers(dest="jurisdiction_action", help="Jurisdiction Aktionen")
    
    p_jur_sub.add_parser("enforce", help="Leitet alle ungesendeten Leads aus AT/PL auf LinkedIn um")
    p_jur_sub.add_parser("tasks", help="Zeigt LinkedIn Outreach Tasks an")
    p_jur_comp = p_jur_sub.add_parser("complete", help="Markiert einen LinkedIn-Task als erledigt")
    p_jur_comp.add_argument("task_id", type=str, help="ID des Tasks")

    # 13. checkout
    p_chk = subparsers.add_parser("checkout", help="Erzeugt Stripe Checkout-Zahlungslinks fuer B2B Audits (Feature F08)")
    p_chk.add_argument("--package", "-p", required=True, help="Paket: portfolio_audit (490) oder audit_plus (1490)")
    p_chk.add_argument("--email", "-e", required=True, help="E-Mail-Adresse des Kunden/Leads")
    p_chk.add_argument("--company", "-c", default="", help="Unternehmensname")
    p_chk.add_argument("--lead-id", "-l", default="", help="Optionale Lead-ID")
    p_chk.add_argument("--steuer-id", "-t", default="", help="USt-IdNr. / Steuer-ID")
    p_chk.add_argument("--format", "-f", choices=["link", "text", "markdown", "json"], default="link", help="Ausgabeformat")
    p_chk.add_argument("--lang", choices=["de", "en", "fr", "nl"], default="de", help="Sprache fuer Snippet")
    p_chk.add_argument("--dry-run", action="store_true", default=False, help="Test-/Mock-Link")

    return parser


def cmd_checkout(args: argparse.Namespace) -> int:
    """Erzeugt Stripe-Checkout-Links fuer B2B High-Ticket Audits (Feature F08)."""
    from scripts.crm.stripe_checkout import (
        create_checkout_session,
        generate_pitch_snippet,
        get_package,
    )

    try:
        pkg = get_package(args.package)
    except ValueError as e:
        print(f"[FEHLER] {e}", file=sys.stderr)
        return 1

    company_name = args.company
    if not company_name and "@" in args.email:
        domain = args.email.split("@")[-1]
        company_name = domain.split(".")[0].capitalize()

    try:
        session = create_checkout_session(
            package=pkg,
            email=args.email,
            company=company_name,
            lead_id=args.lead_id,
            steuer_id=args.steuer_id,
            dry_run=args.dry_run,
        )
    except Exception as e:
        print(f"[FEHLER] Checkout-Session konnte nicht erstellt werden: {e}", file=sys.stderr)
        return 1

    url = session.get("url") or session.get("payment_link") or ""

    if args.format == "link":
        print(url)
    elif args.format == "json":
        print(json.dumps(session, indent=2, ensure_ascii=False))
    elif args.format == "text":
        snippet = generate_pitch_snippet(
            package=pkg,
            checkout_url=url,
            company=company_name,
            language=args.lang,
        )
        print(snippet)
    elif args.format == "markdown":
        print(f"### B2B Checkout: {pkg.name} ({pkg.amount_eur} € zzgl. USt.)")
        print(f"- **Unternehmen:** {company_name}")
        print(f"- **Lead-ID / E-Mail:** {session['metadata'].get('lead_id')} ({args.email})")
        print(f"- **Steuer-ID:** {args.steuer_id or 'Keine hinterlegt'}")
        print(f"\n[**Jetzt gesichert beauftragen ({pkg.name})**]({url})")

    return 0


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 0

    command_map = {
        "status": cmd_status,
        "queue": cmd_queue,
        "show": cmd_show,
        "approve": cmd_approve,
        "reject": cmd_reject,
        "send": cmd_send,
        "blacklist": cmd_blacklist,
        "scan": cmd_scan,
        "bot": cmd_bot,
        "cleanup": cmd_cleanup,
        "followup": cmd_followup,
        "jurisdiction": cmd_jurisdiction,
        "checkout": cmd_checkout,
    }

    handler = command_map.get(args.command)
    if handler:
        return handler(args)
    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
