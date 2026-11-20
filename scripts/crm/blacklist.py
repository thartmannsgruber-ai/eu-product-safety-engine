"""
scripts/crm/blacklist.py
Permanente Opt-Out Blacklist & Golden Rule Invariant Enforcement.

Invariante (Goldene Regel):
Sobald ein Empfaenger Opt-Out signalisiert (Absage, Abmeldung),
wird die Adresse permanent in .crm/blacklist.json persistiert.
can_contact(email) liefert zwingend False.
Jeglicher weiterer Kontaktversuch wirft BlacklistedRecipientError.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional


class BlacklistedRecipientError(Exception):
    """Geworfen wenn ein Kontakt an eine geblacklistete Adresse versucht wird."""
    pass


def normalize_email(email: str) -> str:
    """Normalisiert eine E-Mail-Adresse (Lowercase, Leerzeichen entfernt)."""
    if not email:
        return ""
    return str(email).strip().lower()


class BlacklistManager:
    """Verwaltet die permanente Opt-Out Blacklist in .crm/blacklist.json."""

    def __init__(self, blacklist_file: Optional[str | Path] = None) -> None:
        if blacklist_file:
            self.filepath = Path(blacklist_file)
        else:
            base_dir = Path(__file__).resolve().parent.parent.parent
            self.filepath = base_dir / ".crm" / "blacklist.json"
        
        # Sicherstellen, dass das Verzeichnis existiert
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        self._entries: Dict[str, Dict[str, Any]] = {}
        self._load_error: bool = False
        self.load()

    def load(self) -> Dict[str, Dict[str, Any]]:
        """
        Laedt die Blacklist aus der JSON-Datei.
        Fail-Closed Schranke: Falls die Datei existiert aber unlesbar/korrupt ist,
        wird self._load_error = True gesetzt, sodass can_contact() False liefert!
        """
        if not self.filepath.exists():
            self._entries = {}
            self._load_error = False
            return self._entries

        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            normalized_entries: Dict[str, Dict[str, Any]] = {}
            if isinstance(data, dict):
                # Format: { "email": { "email": ..., "reason": ... } }
                for k, v in data.items():
                    norm_k = normalize_email(k)
                    if isinstance(v, dict):
                        norm_entry = dict(v)
                        norm_entry["email"] = norm_k
                        normalized_entries[norm_k] = norm_entry
                    else:
                        normalized_entries[norm_k] = {
                            "email": norm_k,
                            "reason": str(v),
                            "snippet": "",
                            "blacklisted_at": datetime.now(timezone.utc).isoformat()
                        }
            elif isinstance(data, list):
                # Format: [ { "email": ..., "reason": ... }, ... ]
                for item in data:
                    if isinstance(item, dict) and "email" in item:
                        norm_k = normalize_email(item["email"])
                        item_copy = dict(item)
                        item_copy["email"] = norm_k
                        normalized_entries[norm_k] = item_copy
            
            self._entries = normalized_entries
            self._load_error = False
        except Exception as exc:
            # Sicherheits-Schranke (Fail-Closed): Niemals stillschweigend mit leerer Liste fortfahren!
            self._entries = {}
            self._load_error = True

        return self._entries

    def save(self) -> None:
        """Speichert die Blacklist atomar in die JSON-Datei (mit Re-Merge und unique temp)."""
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        # Disk-Merge: Vor dem Schreiben frische Eintraege von der Platte zusammenfuehren
        if self.filepath.exists():
            try:
                with open(self.filepath, "r", encoding="utf-8") as f:
                    disk_data = json.load(f)
                if isinstance(disk_data, dict):
                    for k, v in disk_data.items():
                        norm_k = normalize_email(k)
                        if norm_k not in self._entries:
                            self._entries[norm_k] = v
            except Exception:
                pass

        import uuid
        temp_path = self.filepath.with_suffix(f".tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self._entries, f, indent=2, ensure_ascii=False)
        temp_path.replace(self.filepath)
        self._load_error = False

    def is_blacklisted(self, email: str) -> bool:
        """Liefert True fuer gelistete Adressen, sonst False."""
        norm_email = normalize_email(email)
        if not norm_email:
            return False
        return norm_email in self._entries

    def add_to_blacklist(
        self,
        email: str,
        reason: str = "Opt-Out / Absage",
        snippet: str = ""
    ) -> Dict[str, Any]:
        """
        Fuegt eine E-Mail-Adresse permanent zur Blacklist hinzu
        und speichert sofort in .crm/blacklist.json.
        """
        norm_email = normalize_email(email)
        if not norm_email:
            raise ValueError("Email address cannot be empty.")

        entry = {
            "email": norm_email,
            "reason": reason,
            "snippet": snippet,
            "blacklisted_at": datetime.now(timezone.utc).isoformat()
        }
        self._entries[norm_email] = entry
        self.save()
        return entry

    def remove_from_blacklist(self, email: str) -> bool:
        """Entfernt eine E-Mail (fuer Tests oder manuelle Korrektur)."""
        norm_email = normalize_email(email)
        if norm_email in self._entries:
            del self._entries[norm_email]
            self.save()
            return True
        return False

    def can_contact(self, email: str) -> bool:
        """
        Goldene Regel (Fail-Closed):
        Sobald eine Adresse blacklisted ist, ODER wenn die Blacklist-Datei
        einen Ladefehler aufweist, ist can_contact(email) zwingend False.
        """
        if getattr(self, "_load_error", False):
            return False
        return not self.is_blacklisted(email)

    def assert_can_contact(self, email: str) -> None:
        """
        Wirft BlacklistedRecipientError wenn ein Kontakt an eine geblacklistete
        Adresse versucht wird, oder wenn die Blacklist defekt ist (Fail-Closed).
        """
        if getattr(self, "_load_error", False):
            raise BlacklistedRecipientError(
                f"Sicherheits-Blockade: Blacklist-Datei '{self.filepath}' konnte nicht fehlersicher geladen werden. "
                f"Ausnahmsloser Fail-Closed Schutz aktiv fuer '{email}'."
            )
        if self.is_blacklisted(email):
            raise BlacklistedRecipientError(
                f"Blacklisted recipient: '{email}' is on the permanent opt-out blacklist and cannot be contacted."
            )

    def get_blacklist(self) -> Dict[str, Dict[str, Any]]:
        """Gibt alle geblacklisteten Eintraege zurueck."""
        return dict(self._entries)

    def list_entries(self) -> List[Dict[str, Any]]:
        """Gibt die Liste aller Blacklist-Eintraege zurueck."""
        return list(self._entries.values())


# Globales Singleton fuer direkte Modulnutzung
_default_manager: Optional[BlacklistManager] = None


def get_default_manager() -> BlacklistManager:
    global _default_manager
    if _default_manager is None:
        _default_manager = BlacklistManager()
    return _default_manager


def set_default_manager(manager: BlacklistManager) -> None:
    global _default_manager
    _default_manager = manager


def is_blacklisted(email: str) -> bool:
    """Modul-Funktion: Prueft ob die Adresse auf der Blacklist steht."""
    return get_default_manager().is_blacklisted(email)


def add_to_blacklist(email: str, reason: str = "Opt-Out / Absage", snippet: str = "") -> Dict[str, Any]:
    """Modul-Funktion: Persistiert E-Mail in .crm/blacklist.json."""
    return get_default_manager().add_to_blacklist(email, reason=reason, snippet=snippet)


def can_contact(email: str) -> bool:
    """Modul-Funktion: Liefert False falls blacklisted, sonst True."""
    return get_default_manager().can_contact(email)


def assert_can_contact(email: str) -> None:
    """Modul-Funktion: Wirft BlacklistedRecipientError falls blacklisted."""
    return get_default_manager().assert_can_contact(email)
