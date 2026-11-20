"""
scripts/crm/storage.py
CRM Data Storage & Lead Lifecycle Management.

Verwaltet Leads in .crm/leads_db.json.
Erlaubte Status-Werte fuer Leads:
- OUTREACH_SENT
- REPLIED_POSITIVE
- REPLIED_INQUIRY
- LOST_BLACKLISTED

Setzt die Goldene Regel um:
Sobald eine Adresse blacklisted wird (oder Status LOST_BLACKLISTED erhaelt),
ist can_contact(email) zwingend False.
Kontaktversuche an geblacklistete Adressen werfen BlacklistedRecipientError.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)


class LeadStatus:
    OUTREACH_SENT = "OUTREACH_SENT"
    REPLIED_POSITIVE = "REPLIED_POSITIVE"
    REPLIED_INQUIRY = "REPLIED_INQUIRY"
    LOST_BLACKLISTED = "LOST_BLACKLISTED"


VALID_LEAD_STATUSES = {
    LeadStatus.OUTREACH_SENT,
    LeadStatus.REPLIED_POSITIVE,
    LeadStatus.REPLIED_INQUIRY,
    LeadStatus.LOST_BLACKLISTED,
}


class CRMStorage:
    """Verwaltet Leads in .crm/leads_db.json mit strikter Einhaltung der Goldenen Regel."""

    def __init__(
        self,
        leads_file: Optional[str | Path] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
    ) -> None:
        base_dir = Path(__file__).resolve().parent.parent.parent
        if leads_file:
            self.filepath = Path(leads_file)
        else:
            self.filepath = base_dir / ".crm" / "leads_db.json"

        self.blacklist_mgr = blacklist_mgr or get_default_manager()
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        self._leads: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> Dict[str, Dict[str, Any]]:
        """Laedt alle Leads aus der JSON-Datei."""
        if not self.filepath.exists():
            self._leads = {}
            return self._leads

        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            normalized: Dict[str, Dict[str, Any]] = {}
            if isinstance(data, dict):
                for k, v in data.items():
                    norm_k = normalize_email(k)
                    if not norm_k:
                        continue
                    if isinstance(v, dict):
                        entry = dict(v)
                        entry["email"] = norm_k
                        normalized[norm_k] = entry
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and "email" in item:
                        norm_k = normalize_email(item["email"])
                        if not norm_k:
                            continue
                        entry = dict(item)
                        entry["email"] = norm_k
                        normalized[norm_k] = entry

            self._leads = normalized
        except Exception:
            self._leads = {}

        return self._leads

    def save(self) -> None:
        """Speichert alle Leads atomar in die JSON-Datei."""
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.filepath.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self._leads, f, indent=2, ensure_ascii=False)
        temp_path.replace(self.filepath)

    def init_from_campaign(
        self,
        sent_log_path: Optional[str | Path] = None,
        campaign_path: Optional[str | Path] = None,
    ) -> int:
        """
        Initialisiert Leads aus .market/leads/sent_log.json und outreach_campaign.json.
        Weist initial den Status OUTREACH_SENT zu (oder LOST_BLACKLISTED falls Adresse
        bereits geblacklistet ist).
        """
        base_dir = Path(__file__).resolve().parent.parent.parent
        sent_file = Path(sent_log_path) if sent_log_path else base_dir / ".market" / "leads" / "sent_log.json"
        camp_file = Path(campaign_path) if campaign_path else base_dir / ".market" / "leads" / "outreach_campaign.json"

        campaign_data: Dict[str, Dict[str, Any]] = {}
        if camp_file.exists():
            try:
                with open(camp_file, "r", encoding="utf-8") as f:
                    c_list = json.load(f)
                    if isinstance(c_list, list):
                        for item in c_list:
                            if isinstance(item, dict) and "email" in item:
                                campaign_data[normalize_email(item["email"])] = item
                    elif isinstance(c_list, dict):
                        for k, item in c_list.items():
                            if isinstance(item, dict):
                                campaign_data[normalize_email(k)] = item
            except Exception as e:
                print(f"[WARN] Failed to load campaign file: {e}")

        sent_log_data: Dict[str, Dict[str, Any]] = {}
        if sent_file.exists():
            try:
                with open(sent_file, "r", encoding="utf-8") as f:
                    s_data = json.load(f)
                    if isinstance(s_data, dict):
                        for k, v in s_data.items():
                            sent_log_data[normalize_email(k)] = v
                    elif isinstance(s_data, list):
                        for item in s_data:
                            if isinstance(item, dict) and "email" in item:
                                sent_log_data[normalize_email(item["email"])] = item
            except Exception as e:
                print(f"[WARN] Failed to load sent_log file: {e}")

        now_iso = datetime.now(timezone.utc).isoformat()
        all_emails = set(campaign_data.keys()) | set(sent_log_data.keys())
        initialized_count = 0

        for norm_email in all_emails:
            if not norm_email:
                continue
            c_info = campaign_data.get(norm_email, {})
            s_info = sent_log_data.get(norm_email, {})

            # Existierenden Lead laden oder neuen erstellen
            lead = self._leads.get(norm_email, {})
            
            # Blacklist-Check (Goldene Regel)
            if self.blacklist_mgr.is_blacklisted(norm_email):
                status = LeadStatus.LOST_BLACKLISTED
            else:
                # Falls Lead schon einen Status hat, belassen; sonst OUTREACH_SENT
                status = lead.get("status", LeadStatus.OUTREACH_SENT)

            company = s_info.get("company") or c_info.get("company") or lead.get("company") or ""
            country = s_info.get("country") or c_info.get("country") or lead.get("country") or ""
            city = c_info.get("city") or lead.get("city") or ""
            language = c_info.get("language") or lead.get("language") or "en"
            subject = s_info.get("subject") or c_info.get("subject") or lead.get("subject") or ""
            sent_at = s_info.get("sent_at") or lead.get("sent_at") or now_iso
            provider = s_info.get("provider") or lead.get("provider") or "resend"
            resend_id = s_info.get("resend_id") or lead.get("resend_id") or ""

            history = lead.get("history", [])
            if not history and s_info:
                history.append({
                    "action": "OUTREACH_SENT",
                    "timestamp": sent_at,
                    "provider": provider,
                    "resend_id": resend_id,
                    "subject": subject
                })

            lead_entry = {
                "email": norm_email,
                "company": company,
                "country": country,
                "city": city,
                "language": language,
                "status": status,
                "subject": subject,
                "sent_at": sent_at,
                "provider": provider,
                "resend_id": resend_id,
                "history": history,
                "created_at": lead.get("created_at", now_iso),
                "updated_at": now_iso
            }

            self._leads[norm_email] = lead_entry
            initialized_count += 1

        self.save()
        return initialized_count

    def get_lead(self, email: str) -> Optional[Dict[str, Any]]:
        """Gibt den Lead zu einer E-Mail zurueck oder None."""
        norm_email = normalize_email(email)
        return self._leads.get(norm_email)

    def can_contact(self, email: str) -> bool:
        """
        Goldene Regel:
        Sobald eine Adresse blacklisted wird oder den Status LOST_BLACKLISTED hat,
        ist can_contact(email) zwingend False.
        """
        norm_email = normalize_email(email)
        if not norm_email:
            return False

        if self.blacklist_mgr.is_blacklisted(norm_email):
            return False

        lead = self.get_lead(norm_email)
        if lead and lead.get("status") == LeadStatus.LOST_BLACKLISTED:
            return False

        return True

    def assert_can_contact(self, email: str) -> None:
        """
        Wirft BlacklistedRecipientError wenn ein Kontakt an eine geblacklistete
        Adresse versucht wird.
        """
        norm_email = normalize_email(email)
        if not self.can_contact(norm_email):
            raise BlacklistedRecipientError(
                f"Cannot contact '{email}': Recipient is blacklisted or opted-out (LOST_BLACKLISTED)."
            )

    def record_contact_attempt(
        self,
        email: str,
        subject: str = "",
        body: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Registriert einen Kontaktversuch an einen Lead.
        Wirft BlacklistedRecipientError wenn der Empfaenger geblacklistet ist!
        """
        norm_email = normalize_email(email)
        self.assert_can_contact(norm_email)

        now_iso = datetime.now(timezone.utc).isoformat()
        lead = self.get_lead(norm_email)
        if not lead:
            lead = {
                "email": norm_email,
                "company": "",
                "status": LeadStatus.OUTREACH_SENT,
                "history": [],
                "created_at": now_iso,
                "updated_at": now_iso
            }
            self._leads[norm_email] = lead

        event = {
            "action": "CONTACT_DISPATCHED",
            "timestamp": now_iso,
            "subject": subject,
            "metadata": metadata or {}
        }
        lead.setdefault("history", []).append(event)
        lead["updated_at"] = now_iso
        self.save()
        return lead

    def update_lead_status(
        self,
        email: str,
        status: str,
        reason: str = "",
        snippet: str = ""
    ) -> Dict[str, Any]:
        """
        Aktualisiert den Status eines Leads.
        Erlaubte Status-Werte:
        OUTREACH_SENT, REPLIED_POSITIVE, REPLIED_INQUIRY, LOST_BLACKLISTED.
        
        Wenn status == LOST_BLACKLISTED wird die Adresse zwingend
        in .crm/blacklist.json persistiert (Goldene Regel).
        """
        norm_email = normalize_email(email)
        if status not in VALID_LEAD_STATUSES:
            raise ValueError(
                f"Ungueltiger Lead-Status: '{status}'. Erlaubt sind: {VALID_LEAD_STATUSES}"
            )

        now_iso = datetime.now(timezone.utc).isoformat()
        lead = self.get_lead(norm_email)
        if not lead:
            lead = {
                "email": norm_email,
                "company": "",
                "status": status,
                "history": [],
                "created_at": now_iso,
                "updated_at": now_iso
            }
            self._leads[norm_email] = lead

        old_status = lead.get("status")
        lead["status"] = status
        lead["updated_at"] = now_iso

        event = {
            "action": "STATUS_CHANGE",
            "old_status": old_status,
            "new_status": status,
            "timestamp": now_iso,
            "reason": reason,
            "snippet": snippet
        }
        lead.setdefault("history", []).append(event)

        # Wenn der Lead LOST_BLACKLISTED wird -> permanente Blacklistierung
        if status == LeadStatus.LOST_BLACKLISTED:
            self.blacklist_mgr.add_to_blacklist(
                norm_email,
                reason=reason or "Lead marked as LOST_BLACKLISTED",
                snippet=snippet
            )

        self.save()
        return lead

    def list_leads(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """Gibt alle Leads zurueck, optional gefiltert nach Status."""
        leads = list(self._leads.values())
        if status:
            return [l for l in leads if l.get("status") == status]
        return leads

    def get_stats(self) -> Dict[str, int]:
        """Gibt eine Zaehlung aller Leads gruppiert nach Status zurueck."""
        counts = {s: 0 for s in VALID_LEAD_STATUSES}
        counts["TOTAL"] = len(self._leads)
        for lead in self._leads.values():
            st = lead.get("status")
            if st in counts:
                counts[st] += 1
        return counts


# Globales Singleton fuer direkte Modulnutzung
_default_storage: Optional[CRMStorage] = None


def get_default_storage() -> CRMStorage:
    global _default_storage
    if _default_storage is None:
        _default_storage = CRMStorage()
    return _default_storage


def set_default_storage(storage: CRMStorage) -> None:
    global _default_storage
    _default_storage = storage


def get_lead(email: str) -> Optional[Dict[str, Any]]:
    return get_default_storage().get_lead(email)


def update_lead_status(
    email: str,
    status: str,
    reason: str = "",
    snippet: str = ""
) -> Dict[str, Any]:
    return get_default_storage().update_lead_status(email, status, reason=reason, snippet=snippet)


def list_leads(status: Optional[str] = None) -> List[Dict[str, Any]]:
    return get_default_storage().list_leads(status=status)


def init_from_campaign(
    sent_log_path: Optional[str | Path] = None,
    campaign_path: Optional[str | Path] = None
) -> int:
    return get_default_storage().init_from_campaign(sent_log_path, campaign_path)


def can_contact(email: str) -> bool:
    return get_default_storage().can_contact(email)


def assert_can_contact(email: str) -> None:
    return get_default_storage().assert_can_contact(email)
