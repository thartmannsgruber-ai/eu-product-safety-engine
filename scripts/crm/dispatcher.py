"""
scripts/crm/dispatcher.py
Threaded Email Dispatcher for ProductSafetyEngine CRM.

Versendet freigegebene Antwort-Entwuerfe (Status APPROVED) aus der Review-Queue
ueber die Resend API (oder SMTP / Microsoft 365) mit vollstaendigen
Threading-Headern (In-Reply-To, References) zur urspruenglichen Outreach-Mail.

Hard-Gates (Sicherheitsregeln):
1. Ausschliesslich Entwuerfe mit Status APPROVED duerfen versendet werden.
   Entwuerfe mit PENDING_REVIEW, REJECTED, SENT oder anderem Status werden
   mit UnapprovedDraftError abgewiesen.
2. Geblacklistete Empfaenger werden vor dem Versand ausnahmslos abgefangen
   (Goldene Regel). Jeder Versandversuch an eine gelistete Adresse fuehrt
   zu einem sofortigen Sicherheits-Abbruch via BlacklistedRecipientError.
3. Nach erfolgreichem Versand wird der Entwurf atomar auf Status SENT gesetzt
   und Dispatch-Metadaten (Message-ID, Provider, Timestamp) werden protokolliert.
"""

from __future__ import annotations

import datetime
import json
import os
import smtplib
import time
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)
from scripts.crm.review_queue import (
    DraftNotFoundError,
    DraftStatus,
    ReviewQueue,
    get_default_queue,
)
from scripts.crm.storage import (
    CRMStorage,
    LeadStatus,
    get_default_storage,
)


class UnapprovedDraftError(ValueError):
    """Geworfen wenn ein Entwurf versendet werden soll, der nicht den Status APPROVED hat."""
    pass


def load_env() -> Dict[str, str]:
    """Laedt Umgebungsvariablen aus Projekt- und THFC-.env Dateien."""
    env: Dict[str, str] = {}
    base_dir = Path(__file__).resolve().parent.parent.parent
    thfc_env = Path("/mnt/devstorage/projects/THFC/SmartBetaFaktorEngine/.env.local")
    local_env = base_dir / ".env"

    for path in (thfc_env, local_env):
        if path.exists():
            try:
                with open(path, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            k, v = line.split("=", 1)
                            env[k.strip()] = v.strip().strip("'\"")
            except Exception:
                pass
    return env


def format_message_id_header(val: Optional[str]) -> str:
    """
    Formatiert eine Message-ID RFC 2822 konform mit spitzen Klammern,
    falls noch nicht vorhanden.
    """
    if not val:
        return ""
    clean = str(val).strip()
    if not clean:
        return ""
    if clean.startswith("<") and clean.endswith(">"):
        return clean
    return f"<{clean}>"


def format_references_header(references: Optional[str], in_reply_to: Optional[str] = None) -> str:
    """
    Baut einen gueltigen References-Header nach RFC 2822 zusammen.
    Enthaelt alle vorherigen References plus in_reply_to.
    """
    parts: List[str] = []
    if references:
        # Aufteilen nach Leerzeichen oder Klammern
        raw_tokens = [t.strip() for t in references.split() if t.strip()]
        for tok in raw_tokens:
            parts.append(format_message_id_header(tok))
    
    if in_reply_to:
        formatted_irt = format_message_id_header(in_reply_to)
        if formatted_irt and formatted_irt not in parts:
            parts.append(formatted_irt)
            
    return " ".join(parts).strip()


@dataclass
class DispatchResult:
    """Ergebnis eines E-Mail-Versandversuchs."""
    draft_id: str
    recipient: str
    status: str  # SENT, DRY_RUN, BLOCKED_BLACKLIST, FAILED
    provider: str
    message_id: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)
    error: Optional[str] = None
    timestamp: str = field(
        default_factory=lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
    )

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class EmailDispatcher:
    """
    Sicherer E-Mail-Dispatcher fuer freigegebene Entwuerfe (Status APPROVED).
    Setzt strikte Blacklist- und Status-Gates durch.
    """

    def __init__(
        self,
        queue: Optional[ReviewQueue] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
        storage: Optional[CRMStorage] = None,
        provider: str = "resend",
        dry_run: bool = False,
        resend_api_key: Optional[str] = None,
        resend_from: Optional[str] = None,
        reply_to: Optional[str] = None,
        smtp_host: Optional[str] = None,
        smtp_port: Optional[int] = None,
        smtp_user: Optional[str] = None,
        smtp_pass: Optional[str] = None,
        sender_name: Optional[str] = None,
    ) -> None:
        self.queue = queue or get_default_queue()
        self.blacklist_mgr = blacklist_mgr or getattr(self.queue, "blacklist_mgr", get_default_manager())
        self.storage = storage or get_default_storage()
        self.provider = (provider or "resend").lower()
        self.dry_run = dry_run

        env = load_env()

        # Resend-Konfiguration
        self.resend_api_key = (
            resend_api_key
            or os.environ.get("RESEND_API_KEY")
            or env.get("RESEND_API_KEY", "")
        )
        self.resend_from = (
            resend_from
            or os.environ.get("RESEND_FROM")
            or env.get("RESEND_FROM", "Thomas | THFC Consulting <leads@system.thfc-consulting.de>")
        )
        self.reply_to = (
            reply_to
            or os.environ.get("REPLY_TO")
            or env.get("REPLY_TO", "info@thfc-consulting.de")
        )

        # SMTP-Konfiguration (Microsoft 365 / Exchange)
        self.smtp_host = (
            smtp_host
            or os.environ.get("SMTP_HOST")
            or env.get("SMTP_HOST", "smtp.office365.com")
        )
        self.smtp_port = int(
            smtp_port
            or os.environ.get("SMTP_PORT")
            or env.get("SMTP_PORT", 587)
        )
        self.smtp_user = (
            smtp_user
            or os.environ.get("SMTP_USER")
            or env.get("SMTP_USER", "thomas@thfc-consulting.de")
        )
        self.smtp_pass = (
            smtp_pass
            or os.environ.get("SMTP_PASS")
            or env.get("SMTP_PASS", "")
        )
        self.sender_name = (
            sender_name
            or os.environ.get("SENDER_NAME")
            or env.get("SENDER_NAME", "Thomas | THFC Consulting")
        )

    def build_threading_headers(self, draft: Dict[str, Any]) -> Dict[str, str]:
        """
        Baut die Threading-Header (In-Reply-To, References) fuer eine Antwort-Mail.
        """
        raw_in_reply_to = draft.get("in_reply_to")
        raw_references = draft.get("references")

        headers: Dict[str, str] = {}
        if raw_in_reply_to:
            headers["In-Reply-To"] = format_message_id_header(raw_in_reply_to)

        formatted_refs = format_references_header(raw_references, raw_in_reply_to)
        if formatted_refs:
            headers["References"] = formatted_refs

        return headers

    def create_mime_message(
        self,
        to_email: str,
        subject: str,
        body: str,
        headers: Optional[Dict[str, str]] = None,
    ) -> MIMEMultipart:
        """Erstellt eine RFC-konforme MIME-Nachricht inklusive Threading-Headern."""
        msg = MIMEMultipart("alternative")
        msg["From"] = f"{self.sender_name} <{self.smtp_user}>" if self.sender_name else self.smtp_user
        msg["To"] = to_email
        msg["Subject"] = subject
        msg["Date"] = datetime.datetime.now(datetime.timezone.utc).strftime("%a, %d %b %Y %H:%M:%S %z")
        msg["Reply-To"] = self.reply_to

        if headers:
            for k, v in headers.items():
                if v:
                    msg[k] = v

        part_text = MIMEText(body, "plain", "utf-8")
        msg.attach(part_text)
        return msg

    def send_via_resend(
        self,
        to_email: str,
        subject: str,
        body: str,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Versendet eine E-Mail ueber die Resend REST API mit benutzerdefinierten Headern."""
        if not self.resend_api_key:
            raise ValueError("RESEND_API_KEY is not set or missing.")

        url = "https://api.resend.com/emails"
        req_headers = {
            "Authorization": f"Bearer {self.resend_api_key}",
            "Content-Type": "application/json",
            "User-Agent": "ProductSafetyEngine-Dispatcher/1.0",
        }
        payload: Dict[str, Any] = {
            "from": self.resend_from,
            "to": [to_email],
            "reply_to": self.reply_to,
            "subject": subject,
            "text": body,
        }

        if headers:
            payload["headers"] = headers

        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=req_headers,
        )

        with urllib.request.urlopen(req, timeout=15) as resp:
            resp_data = resp.read().decode("utf-8")
            return json.loads(resp_data)

    def send_via_smtp(
        self,
        to_email: str,
        subject: str,
        body: str,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Versendet eine E-Mail ueber SMTP (Microsoft 365 Exchange Online)."""
        if not self.smtp_pass:
            raise ValueError("SMTP_PASS is not set in environment for SMTP provider.")

        msg = self.create_mime_message(
            to_email=to_email,
            subject=subject,
            body=body,
            headers=headers,
        )

        with smtplib.SMTP(self.smtp_host, self.smtp_port) as server:
            server.starttls()
            server.login(self.smtp_user, self.smtp_pass)
            server.send_message(msg)

        return {
            "id": f"smtp_{int(time.time())}_{to_email}",
            "status": "delivered_via_smtp",
        }

    def dispatch_draft(
        self,
        draft_or_id: Union[str, Dict[str, Any]],
        dry_run: Optional[bool] = None,
    ) -> DispatchResult:
        """
        Versendet einen einzelnen Entwurf.
        
        Hard-Gates:
        1. Entwurf muss zwingend den Status APPROVED haben.
        2. Empfaenger darf unter keinen Umstaenden auf der Blacklist stehen.
        """
        is_dry_run = self.dry_run if dry_run is None else dry_run

        # Entwurf laden
        if isinstance(draft_or_id, str):
            draft_id = draft_or_id
            draft = self.queue.get_draft(draft_id)
            if not draft:
                raise DraftNotFoundError(f"Draft '{draft_id}' not found in review queue.")
        elif isinstance(draft_or_id, dict):
            draft = draft_or_id
            draft_id = draft.get("draft_id", "")
            if not draft_id:
                raise ValueError("Draft dictionary must contain 'draft_id'.")
        else:
            raise TypeError(f"Expected draft_id as str or dict, got {type(draft_or_id)}")

        current_status = draft.get("status")

        # -------------------------------------------------------------------
        # Hard-Gate 1: Ausschliesslich Status APPROVED
        # -------------------------------------------------------------------
        if current_status != DraftStatus.APPROVED:
            raise UnapprovedDraftError(
                f"Cannot dispatch draft '{draft_id}': status is '{current_status}', "
                f"but dispatcher dispatches exclusively drafts with status '{DraftStatus.APPROVED}'."
            )

        # Empfaenger ermitteln & normalisieren
        raw_email = draft.get("lead_email") or draft.get("recipient") or ""
        recipient = normalize_email(raw_email)
        if not recipient:
            raise ValueError(f"Draft '{draft_id}' has no valid recipient email.")

        # -------------------------------------------------------------------
        # Hard-Gate 2: Blacklist-Sicherheits-Abbruch (Goldene Regel)
        # -------------------------------------------------------------------
        if self.blacklist_mgr and self.blacklist_mgr.is_blacklisted(recipient):
            raise BlacklistedRecipientError(
                f"CRITICAL DISPATCH BLOCKED: Recipient '{recipient}' in draft '{draft_id}' "
                f"is on the permanent opt-out blacklist! Dispatch aborted immediately."
            )

        # Threading-Header erstellen
        threading_headers = self.build_threading_headers(draft)
        subject = draft.get("subject", "Product Safety Engine Report")
        body = draft.get("body", "")

        # Dry-Run Modus
        if is_dry_run:
            return DispatchResult(
                draft_id=draft_id,
                recipient=recipient,
                status="DRY_RUN",
                provider=self.provider,
                message_id=f"dry_run_{draft_id}",
                headers=threading_headers,
                error=None,
            )

        # Echter Versand
        try:
            if self.provider == "smtp" or self.provider == "exchange":
                res = self.send_via_smtp(
                    to_email=recipient,
                    subject=subject,
                    body=body,
                    headers=threading_headers,
                )
                message_id = res.get("id")
            else:
                # Default: Resend API
                res = self.send_via_resend(
                    to_email=recipient,
                    subject=subject,
                    body=body,
                    headers=threading_headers,
                )
                message_id = res.get("id")

            # Queue-Status aktualisieren: APPROVED -> SENT
            dispatch_meta = {
                "provider": self.provider,
                "message_id": message_id,
                "sent_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "headers": threading_headers,
            }
            self.queue.mark_as_sent(draft_id, dispatch_meta=dispatch_meta)

            # CRMStorage aktualisieren, falls Lead vorhanden
            if self.storage and self.storage.get_lead(recipient):
                try:
                    self.storage.update_lead_status(
                        email=recipient,
                        status=LeadStatus.OUTREACH_SENT,
                        note=f"Dispatched draft {draft_id} via {self.provider}",
                    )
                except Exception:
                    pass

            return DispatchResult(
                draft_id=draft_id,
                recipient=recipient,
                status="SENT",
                provider=self.provider,
                message_id=message_id,
                headers=threading_headers,
                error=None,
            )

        except Exception as e:
            return DispatchResult(
                draft_id=draft_id,
                recipient=recipient,
                status="FAILED",
                provider=self.provider,
                message_id=None,
                headers=threading_headers,
                error=str(e),
            )

    def dispatch_all_approved(
        self,
        limit: Optional[int] = None,
        delay_seconds: float = 0.0,
        dry_run: Optional[bool] = None,
    ) -> List[DispatchResult]:
        """
        Versendet alle freigegebenen Entwuerfe (Status APPROVED) aus der Queue.
        Gesperrte oder nicht freigegebene Entwuerfe werden nicht versendet.
        """
        approved_drafts = self.queue.list_drafts(status=DraftStatus.APPROVED)
        if limit and limit > 0:
            approved_drafts = approved_drafts[:limit]

        results: List[DispatchResult] = []
        total = len(approved_drafts)

        for idx, draft in enumerate(approved_drafts, 1):
            try:
                res = self.dispatch_draft(draft, dry_run=dry_run)
                results.append(res)
            except BlacklistedRecipientError as bre:
                results.append(
                    DispatchResult(
                        draft_id=draft.get("draft_id", "unknown"),
                        recipient=draft.get("lead_email", ""),
                        status="BLOCKED_BLACKLIST",
                        provider=self.provider,
                        error=str(bre),
                    )
                )
            except Exception as e:
                results.append(
                    DispatchResult(
                        draft_id=draft.get("draft_id", "unknown"),
                        recipient=draft.get("lead_email", ""),
                        status="FAILED",
                        provider=self.provider,
                        error=str(e),
                    )
                )

            if delay_seconds > 0 and idx < total:
                time.sleep(delay_seconds)

        return results


# Globales Singleton fuer direkte Modulnutzung
_default_dispatcher: Optional[EmailDispatcher] = None


def get_default_dispatcher() -> EmailDispatcher:
    global _default_dispatcher
    if _default_dispatcher is None:
        _default_dispatcher = EmailDispatcher()
    return _default_dispatcher


def set_default_dispatcher(dispatcher: EmailDispatcher) -> None:
    global _default_dispatcher
    _default_dispatcher = dispatcher


def dispatch_draft(
    draft_or_id: Union[str, Dict[str, Any]],
    dry_run: Optional[bool] = None,
) -> DispatchResult:
    """Modul-Funktion: Versendet einen einzelnen Entwurf."""
    return get_default_dispatcher().dispatch_draft(draft_or_id, dry_run=dry_run)


def dispatch_approved_drafts(
    limit: Optional[int] = None,
    delay_seconds: float = 0.0,
    dry_run: Optional[bool] = None,
) -> List[DispatchResult]:
    """Modul-Funktion: Versendet alle freigegebenen Entwuerfe."""
    return get_default_dispatcher().dispatch_all_approved(
        limit=limit,
        delay_seconds=delay_seconds,
        dry_run=dry_run,
    )
