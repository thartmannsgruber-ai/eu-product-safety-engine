"""
scripts/crm/review_queue.py
Human-in-the-Loop (HITL) Review Queue Management for ProductSafetyEngine CRM.

Verwaltet Antwort-Mailentwuerfe in .crm/review_queue.json.
Erlaubte Status-Werte:
- PENDING_REVIEW: Entwurf wartet auf manuelle Pruefung durch Thomas
- APPROVED: Freigegeben fuer den Versand durch den Dispatcher
- REJECTED: Entwurf abgelehnt / archiviert
- SENT: Erfolgreich versendet

Sicherheitsregeln:
- Es erfolgt KEIN automatischer Versand ohne Freigabe (APPROVED).
- Status-Uebergaenge werden strikt validiert:
  PENDING_REVIEW -> APPROVED oder REJECTED.
- Vor Freigabe (APPROVED) wird zwingend geprueft, ob der Empfaenger
  auf der permanenten Blacklist steht (Goldene Regel).
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Union

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)


class DraftStatus:
    PENDING_REVIEW = "PENDING_REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    SENT = "SENT"


VALID_DRAFT_STATUSES: Set[str] = {
    DraftStatus.PENDING_REVIEW,
    DraftStatus.APPROVED,
    DraftStatus.REJECTED,
    DraftStatus.SENT,
}

ALLOWED_TRANSITIONS: Dict[str, Set[str]] = {
    DraftStatus.PENDING_REVIEW: {DraftStatus.APPROVED, DraftStatus.REJECTED},
    DraftStatus.APPROVED: {DraftStatus.SENT, DraftStatus.REJECTED, DraftStatus.PENDING_REVIEW},
    DraftStatus.REJECTED: {DraftStatus.PENDING_REVIEW},
    DraftStatus.SENT: set(),
}


class DraftNotFoundError(KeyError):
    """Geworfen wenn eine draft_id in der Queue nicht gefunden wird."""
    pass


class InvalidStatusTransitionError(ValueError):
    """Geworfen wenn ein unerlaubter Status-Uebergang versucht wird."""
    pass


class ReviewQueue:
    """
    Verwaltet die HITL Review-Queue in .crm/review_queue.json.
    """

    def __init__(
        self,
        queue_file: Optional[Union[str, Path]] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
    ) -> None:
        if queue_file:
            self.filepath = Path(queue_file)
        else:
            base_dir = Path(__file__).resolve().parent.parent.parent
            self.filepath = base_dir / ".crm" / "review_queue.json"

        self.blacklist_mgr = blacklist_mgr or get_default_manager()
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        self._entries: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> Dict[str, Dict[str, Any]]:
        """Laedt alle Entwuerfe aus der JSON-Datei."""
        if not self.filepath.exists():
            self._entries = {}
            return self._entries

        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)

            if isinstance(data, dict):
                self._entries = data
            elif isinstance(data, list):
                # Falls als Liste gespeichert
                self._entries = {
                    item.get("draft_id", f"draft_{i}"): item
                    for i, item in enumerate(data)
                    if isinstance(item, dict)
                }
            else:
                self._entries = {}
        except Exception:
            self._entries = {}

        return self._entries

    def save(self) -> None:
        """Speichert die Queue atomar in die JSON-Datei."""
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.filepath.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self._entries, f, indent=2, ensure_ascii=False)
        temp_path.replace(self.filepath)

    @staticmethod
    def generate_draft_id() -> str:
        """Erzeugt eine eindeutige, nachvollziehbare draft_id."""
        ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        rand = uuid.uuid4().hex[:8]
        return f"draft_{ts}_{rand}"

    def add_draft(
        self,
        draft: Union[Dict[str, Any], Any],
        check_blacklist: bool = True,
    ) -> Dict[str, Any]:
        """
        Reiht einen neuen Mailentwurf mit Status PENDING_REVIEW in die Queue ein.
        Prueft bei Bedarf die Blacklist.
        """
        if hasattr(draft, "to_dict"):
            draft_dict = draft.to_dict()
        elif isinstance(draft, dict):
            draft_dict = dict(draft)
        else:
            raise TypeError(f"Unsupported draft type: {type(draft)}")

        # Eindeutige ID vergeben, falls nicht vorhanden
        draft_id = draft_dict.get("draft_id")
        if not draft_id:
            draft_id = self.generate_draft_id()
            draft_dict["draft_id"] = draft_id

        # Empfaenger ermitteln & normalisieren
        target_email = normalize_email(
            draft_dict.get("lead_email") or draft_dict.get("recipient") or ""
        )
        if "lead_email" in draft_dict:
            draft_dict["lead_email"] = target_email
        if "recipient" in draft_dict:
            draft_dict["recipient"] = target_email

        # Blacklist-Guard (Goldene Regel)
        if check_blacklist and target_email and self.blacklist_mgr:
            if not self.blacklist_mgr.can_contact(target_email):
                raise BlacklistedRecipientError(
                    f"Recipient '{target_email}' is on the permanent opt-out blacklist. Cannot enqueue draft."
                )

        now_iso = datetime.now(timezone.utc).isoformat()
        draft_dict.setdefault("status", DraftStatus.PENDING_REVIEW)
        draft_dict.setdefault("created_at", now_iso)
        draft_dict["updated_at"] = now_iso
        draft_dict.setdefault("history", [])

        # History-Eintrag
        draft_dict["history"].append({
            "action": "ENQUEUED",
            "status": draft_dict["status"],
            "timestamp": now_iso,
            "note": "Draft created and enqueued for HITL review."
        })

        self._entries[draft_id] = draft_dict
        self.save()
        return draft_dict

    def get_draft(self, draft_id: str) -> Optional[Dict[str, Any]]:
        """Gibt einen Entwurf anhand seiner ID zurueck oder None."""
        return self._entries.get(draft_id)

    def list_drafts(self, status: Optional[str] = None) -> List[Dict[str, Any]]:
        """Gibt alle Entwuerfe zurueck, optional gefiltert nach Status."""
        drafts = list(self._entries.values())
        if status:
            norm_status = status.strip().upper()
            drafts = [d for d in drafts if d.get("status") == norm_status]
        # Sortiert nach Aktualisierungsdatum absteigend
        drafts.sort(key=lambda d: d.get("created_at", ""), reverse=True)
        return drafts

    def update_status(
        self,
        draft_id: str,
        new_status: str,
        note: str = "",
        reviewer: str = "Thomas",
    ) -> Dict[str, Any]:
        """
        Fuehrt einen validierten Status-Uebergang durch.
        Erlaubt z. B. PENDING_REVIEW -> APPROVED oder REJECTED.
        """
        if draft_id not in self._entries:
            raise DraftNotFoundError(f"Draft with ID '{draft_id}' not found in review queue.")

        draft = self._entries[draft_id]
        current_status = draft.get("status", DraftStatus.PENDING_REVIEW)
        new_status = new_status.strip().upper()

        if new_status not in VALID_DRAFT_STATUSES:
            raise InvalidStatusTransitionError(
                f"Invalid draft status '{new_status}'. Allowed: {VALID_DRAFT_STATUSES}"
            )

        # Idempotenter Fall
        if current_status == new_status:
            return draft

        # Pruefe erlaubte Transition
        allowed = ALLOWED_TRANSITIONS.get(current_status, set())
        if new_status not in allowed:
            raise InvalidStatusTransitionError(
                f"Invalid status transition from '{current_status}' to '{new_status}' for draft '{draft_id}'."
            )

        # Sicherheits-Check: Falls APPROVED gewuenscht ist, darf der Empfaenger nicht blacklisted sein
        if new_status == DraftStatus.APPROVED:
            target_email = normalize_email(draft.get("lead_email") or draft.get("recipient") or "")
            if target_email and self.blacklist_mgr:
                if not self.blacklist_mgr.can_contact(target_email):
                    raise BlacklistedRecipientError(
                        f"Cannot approve draft '{draft_id}': Recipient '{target_email}' is on the permanent opt-out blacklist."
                    )

        now_iso = datetime.now(timezone.utc).isoformat()
        draft["status"] = new_status
        draft["updated_at"] = now_iso

        if new_status == DraftStatus.APPROVED:
            draft["reviewed_by"] = reviewer
            draft["approved_at"] = now_iso
            draft["approval_note"] = note
        elif new_status == DraftStatus.REJECTED:
            draft["rejected_by"] = reviewer
            draft["rejected_at"] = now_iso
            draft["rejection_reason"] = note
        elif new_status == DraftStatus.SENT:
            draft["dispatched_at"] = now_iso

        draft.setdefault("history", []).append({
            "action": f"STATUS_CHANGE_TO_{new_status}",
            "from_status": current_status,
            "to_status": new_status,
            "reviewer": reviewer,
            "timestamp": now_iso,
            "note": note,
        })

        self.save()
        return draft

    def approve(
        self,
        draft_id: str,
        reviewer: str = "Thomas",
        note: str = "",
    ) -> Dict[str, Any]:
        """
        Status-Uebergang: PENDING_REVIEW -> APPROVED.
        Gibt den Entwurf fuer den spaeteren Versand frei.
        """
        return self.update_status(
            draft_id=draft_id,
            new_status=DraftStatus.APPROVED,
            note=note,
            reviewer=reviewer,
        )

    def reject(
        self,
        draft_id: str,
        reviewer: str = "Thomas",
        reason: str = "",
    ) -> Dict[str, Any]:
        """
        Status-Uebergang: PENDING_REVIEW -> REJECTED.
        Lehnt den Entwurf ab und schliesst ihn vom Versand aus.
        """
        return self.update_status(
            draft_id=draft_id,
            new_status=DraftStatus.REJECTED,
            note=reason,
            reviewer=reviewer,
        )

    def mark_as_sent(
        self,
        draft_id: str,
        dispatch_meta: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """
        Status-Uebergang: APPROVED -> SENT (fuer Dispatcher).
        """
        draft = self.update_status(
            draft_id=draft_id,
            new_status=DraftStatus.SENT,
            note="Dispatched successfully",
        )
        if dispatch_meta:
            draft.setdefault("dispatch_info", {}).update(dispatch_meta)
            self.save()
        return draft

    def delete_draft(self, draft_id: str) -> bool:
        """Loescht einen Entwurf dauerhaft aus der Queue."""
        if draft_id in self._entries:
            del self._entries[draft_id]
            self.save()
            return True
        return False

    def count_by_status(self) -> Dict[str, int]:
        """Liefert die Anzahl der Entwuerfe pro Status."""
        counts = {s: 0 for s in VALID_DRAFT_STATUSES}
        for d in self._entries.values():
            s = d.get("status", DraftStatus.PENDING_REVIEW)
            counts[s] = counts.get(s, 0) + 1
        return counts

    def clear(self) -> None:
        """Leert die Queue (fuer Tests)."""
        self._entries = {}
        self.save()


# Globales Singleton fuer direkte Modulnutzung
_default_queue: Optional[ReviewQueue] = None


def get_default_queue() -> ReviewQueue:
    global _default_queue
    if _default_queue is None:
        _default_queue = ReviewQueue()
    return _default_queue


def set_default_queue(queue: ReviewQueue) -> None:
    global _default_queue
    _default_queue = queue
