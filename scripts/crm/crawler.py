"""
scripts/crm/crawler.py
Inbound Mail Crawler & Lead Association Engine for ProductSafetyEngine CRM.

Liest Inbound-Mails (ueber IMAP mit SSL oder Mock-Objekte), matcht sie
mit den Kampagnen-Leads (ueber Sender-Adresse, In-Reply-To Header oder Betreff),
klassifiziert den Intent multilingual und setzt die CRM-Status sowie die
permanente Opt-Out Blacklist (Goldene Regel) um.
Verarbeitete Nachrichten werden dedupliziert und markiert.
"""

from __future__ import annotations

import email
import email.header
import email.policy
import email.utils
import hashlib
import imaplib
import json
import os
import re
import time
import logging
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set, Tuple, Union

from scripts.crm.blacklist import (
    BlacklistedRecipientError,
    BlacklistManager,
    get_default_manager,
    normalize_email,
)
from scripts.crm.classifier import (
    ClassificationResult,
    Intent,
    classify_intent,
    extract_eans,
    strip_quoted_reply,
)
from scripts.crm.storage import (
    TERMINAL_STATUSES,
    CRMStorage,
    LeadStatus,
    TerminalStatusTransitionError,
    get_default_storage,
)

_HTML_STRIP_RE = re.compile(r"<[^>]+>")
logger = logging.getLogger("CRM.Crawler")

# ---------------------------------------------------------------------------
# Bounce / DSN Erkennung (RFC 3464)
# ---------------------------------------------------------------------------
_BOUNCE_SENDER_RE = re.compile(r"^(mailer-daemon|postmaster|mail-daemon|bounces?)(\+[^@]*)?@", re.I)
_BOUNCE_SUBJECT_RE = re.compile(
    r"(undeliverable|undelivered mail|delivery status notification|delivery failure|"
    r"delivery has failed|mail delivery failed|returned mail|failure notice|"
    r"unzustellbar|nicht zustellbar|non remis|\bDSN\b)",
    re.I,
)
_DSN_STATUS_RE = re.compile(r"(?im)^\s*Status:\s*([245])\.(\d{1,3})\.(\d{1,3})")
_SMTP_ENH_RE = re.compile(r"\b([45])\.(\d{1,3})\.(\d{1,3})\b")
_FINAL_RCPT_RE = re.compile(r"(?im)^\s*(?:Final|Original)-Recipient:\s*(?:rfc822;)?\s*<?([^\s<>;]+@[^\s<>;]+)>?")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def _extract_dsn_text(msg: Any) -> str:
    """Sammelt den Text aller message/delivery-status Teile einer MIME-Nachricht."""
    chunks: List[str] = []
    try:
        for part in msg.walk():
            ctype = (part.get_content_type() or "").lower()
            if ctype in ("message/delivery-status", "message/global-delivery-status"):
                payload = part.get_payload()
                if isinstance(payload, list):
                    for sub in payload:
                        chunks.append(str(sub))
                elif isinstance(payload, (bytes, bytearray)):
                    chunks.append(payload.decode("utf-8", errors="replace"))
                elif payload:
                    chunks.append(str(payload))
    except Exception:  # pragma: no cover - defensiv
        pass
    return "\n".join(chunks)


def detect_bounce(
    parsed: Dict[str, Any],
    own_addresses: Optional[Set[str]] = None,
    is_known_lead: Optional[Callable[[str], bool]] = None,
) -> Optional[Dict[str, Any]]:
    """
    Erkennt Bounce-/DSN-Nachrichten.

    Rueckgabe None wenn keine Bounce, sonst Dict mit:
      kind: "HARD" (5.x.x) | "SOFT" (4.x.x) | "UNKNOWN"
      status_code, recipients (Liste), signals (Liste).

    Sicherheitsregeln (Risiko 1):
      - Eigene Adressen (own_addresses) und der DSN-Absender werden nie als
        Empfaenger gewertet.
      - Strukturierte Quellen (X-Failed-Recipients, Final-/Original-Recipient)
        werden direkt uebernommen.
      - Der Regex-Fallback ueber Freitext greift NUR fuer Adressen, die laut
        is_known_lead bereits als Lead im CRM existieren. Ohne Lookup ist der
        Fallback deaktiviert (fail-closed).
    """
    sender = (parsed.get("from_email") or "").lower()
    subject = parsed.get("subject") or ""
    ctype = (parsed.get("content_type") or "").lower()
    dsn_text = parsed.get("dsn_text") or ""
    body = parsed.get("body") or ""
    x_failed = parsed.get("x_failed_recipients") or ""

    signals: List[str] = []
    if _BOUNCE_SENDER_RE.match(sender):
        signals.append("sender")
    if "multipart/report" in ctype or "delivery-status" in ctype:
        signals.append("content_type")
    if dsn_text:
        signals.append("dsn_part")
    if x_failed:
        signals.append("x_failed_recipients")
    if _BOUNCE_SUBJECT_RE.search(subject):
        signals.append("subject")

    strong = {"sender", "content_type", "dsn_part", "x_failed_recipients"}
    # Betreff allein reicht nicht (Schutz vor Fehlklassifikation echter Antworten).
    if not strong.intersection(signals):
        return None

    combined = f"{dsn_text}\n{body}"
    status_code = ""
    m = _DSN_STATUS_RE.search(combined)
    if m:
        status_code = ".".join(m.groups())
    else:
        m2 = _SMTP_ENH_RE.search(combined)
        if m2:
            status_code = ".".join(m2.groups())

    if status_code.startswith("5"):
        kind = "HARD"
    elif status_code.startswith("4"):
        kind = "SOFT"
    else:
        kind = "UNKNOWN"

    own = {normalize_email(a) for a in (own_addresses or set()) if a}
    own.add(sender)

    recipients: List[str] = []

    def _add(addr: str) -> None:
        n = normalize_email(addr.strip().strip("<>;,"))
        if n and "@" in n and n not in own and not _BOUNCE_SENDER_RE.match(n) and n not in recipients:
            recipients.append(n)

    for addr in re.split(r"[,\s]+", x_failed):
        if "@" in addr:
            _add(addr)
    for fm in _FINAL_RCPT_RE.finditer(combined):
        _add(fm.group(1))
    if not recipients and is_known_lead is not None:
        for em in _EMAIL_RE.findall(combined):
            n = normalize_email(em.strip().strip("<>;,"))
            if not n or n in own:
                continue
            try:
                known = bool(is_known_lead(n))
            except Exception:  # pragma: no cover - defensiv
                known = False
            if known:
                _add(n)
                break

    return {
        "kind": kind,
        "status_code": status_code,
        "recipients": recipients,
        "signals": signals,
    }



def load_env_crawler() -> Dict[str, str]:
    """Laedt Umgebungsvariablen aus lokalen .env Dateien falls vorhanden."""
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


def decode_mime_header(header_val: Optional[str]) -> str:
    """Dekodiert RFC 2047 MIME Header (z.B. '=?UTF-8?B?...?=')."""
    if not header_val:
        return ""
    try:
        decoded_chunks = email.header.decode_header(header_val)
        parts = []
        for chunk, encoding in decoded_chunks:
            if isinstance(chunk, bytes):
                encoding = encoding or "utf-8"
                try:
                    parts.append(chunk.decode(encoding, errors="replace"))
                except LookupError:
                    parts.append(chunk.decode("utf-8", errors="replace"))
            else:
                parts.append(str(chunk))
        return "".join(parts).strip()
    except Exception:
        return str(header_val).strip()


def extract_message_body(msg: Union[email.message.Message, Any]) -> str:
    """Extrahiert den Klartext-Inhalt (text/plain) aus einer E-Mail-Nachricht."""
    body_parts: List[str] = []

    if isinstance(msg, dict):
        return msg.get("body", "")

    if hasattr(msg, "is_multipart") and msg.is_multipart():
        for part in msg.walk():
            content_type = part.get_content_type()
            content_disposition = str(part.get("Content-Disposition", ""))
            if "attachment" in content_disposition:
                continue

            if content_type == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    try:
                        body_parts.append(payload.decode(charset, errors="replace"))
                    except Exception:
                        body_parts.append(payload.decode("utf-8", errors="replace"))
            elif content_type == "text/html" and not body_parts:
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    try:
                        html = payload.decode(charset, errors="replace")
                        # Einfaches HTML-Tag Stripping als Fallback
                        text = _HTML_STRIP_RE.sub(" ", html)
                        body_parts.append(text)
                    except Exception:
                        pass
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            try:
                body_parts.append(payload.decode(charset, errors="replace"))
            except Exception:
                body_parts.append(payload.decode("utf-8", errors="replace"))
        elif isinstance(msg.get_payload(), str):
            body_parts.append(msg.get_payload())

    return "\n".join(body_parts).strip()


def clean_subject_prefix(subject: str) -> str:
    """Entfernt gaengige Antwort-Praefixe wie Re:, RE:, Fwd:, Aw:, Antw: etc."""
    if not subject:
        return ""
    cleaned = subject
    pattern = re.compile(r"^\s*(?:re|fwd|fw|aw|antw|vs)\s*:\s*", re.IGNORECASE)
    while pattern.search(cleaned):
        cleaned = pattern.sub("", cleaned).strip()
    return cleaned.strip()


class InboundMailCrawler:
    """
    Crawler fuer eingehende Kampagnen-Antworten.
    
    Funktionen:
    1. Crawlt Inbound-Nachrichten (IMAP SSL oder Mock-Objekte).
    2. Dedupliziert Nachrichten anhand der Message-ID (oder Hash) und markiert sie.
    3. Matcht E-Mails ueber Sender-Adresse, In-Reply-To Header oder Betreff mit Leads.
    4. Klassifiziert den Intent (NEGATIVE_OPTOUT, POSITIVE_TEST_REQUEST, GENERAL_INQUIRY).
    5. Setzt CRM Lead-Status und Opt-Out Blacklist (Goldene Regel) sofort um.
    """

    def __init__(
        self,
        storage: Optional[CRMStorage] = None,
        blacklist_mgr: Optional[BlacklistManager] = None,
        state_file: Optional[Union[str, Path]] = None,
        engine: Optional[Any] = None,
        drafter: Optional[Any] = None,
        auto_draft: bool = False,
        imap_host: Optional[str] = None,
        imap_port: int = 993,
        imap_user: Optional[str] = None,
        imap_pass: Optional[str] = None,
        own_addresses: Optional[Set[str]] = None,
    ) -> None:
        base_dir = Path(__file__).resolve().parent.parent.parent
        self.storage = storage or get_default_storage()
        self.blacklist_mgr = blacklist_mgr or getattr(self.storage, "blacklist_mgr", get_default_manager())
        self.engine = engine
        self.drafter = drafter
        self.auto_draft = auto_draft or (engine is not None and drafter is not None)

        if state_file:
            self.state_file = Path(state_file)
        else:
            self.state_file = base_dir / ".crm" / "crawler_state.json"

        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state: Dict[str, Any] = {}
        self.load_state()

        # IMAP Konfiguration
        env = load_env_crawler()
        self.imap_host = imap_host or os.environ.get("IMAP_HOST") or env.get("IMAP_HOST")
        self.imap_port = int(imap_port or os.environ.get("IMAP_PORT") or env.get("IMAP_PORT", 993))
        self.imap_user = imap_user or os.environ.get("IMAP_USER") or env.get("IMAP_USER") or env.get("SMTP_USER")
        self.imap_pass = imap_pass or os.environ.get("IMAP_PASS") or env.get("IMAP_PASS") or env.get("SMTP_PASS")

        # Eigene Postfach-/Absenderadressen: werden bei Bounce-Erkennung nie als
        # gebouncter Empfaenger gewertet (Schutz vor Selbst-Quarantaene).
        own: Set[str] = set()
        for key in ("IMAP_USER", "SMTP_USER", "MS_GRAPH_MAILBOX", "REPLY_TO",
                    "RESEND_FROM", "RESEND_FROM_EMAIL", "FROM_EMAIL", "OUTREACH_FROM"):
            val = os.environ.get(key) or env.get(key)
            if val:
                for em in _EMAIL_RE.findall(str(val)):
                    own.add(normalize_email(em))
        if self.imap_user and "@" in str(self.imap_user):
            own.add(normalize_email(str(self.imap_user)))
        if own_addresses:
            own.update(normalize_email(a) for a in own_addresses if a)
        self.own_addresses: Set[str] = {a for a in own if a}

        # Microsoft Graph Token Cache (TTL-gepuffert)
        self._graph_token: Optional[str] = None
        self._graph_token_expires_at: float = 0.0

    # -----------------------------------------------------------------------
    # State Management & Deduplication
    # -----------------------------------------------------------------------

    def load_state(self) -> Dict[str, Any]:
        """Laedt den Crawler-Status (verarbeitete Message-IDs) aus JSON."""
        if not self.state_file.exists():
            self.state = {
                "processed_message_ids": {},
                "last_crawl_at": None
            }
            return self.state

        try:
            with open(self.state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    self.state = data
                    self.state.setdefault("processed_message_ids", {})
                else:
                    self.state = {"processed_message_ids": {}, "last_crawl_at": None}
        except Exception:
            self.state = {"processed_message_ids": {}, "last_crawl_at": None}

        return self.state

    def save_state(self) -> None:
        """Speichert den Crawler-Status atomar in JSON."""
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        temp_path = self.state_file.with_suffix(".tmp")
        with open(temp_path, "w", encoding="utf-8") as f:
            json.dump(self.state, f, indent=2, ensure_ascii=False)
        temp_path.replace(self.state_file)

    def is_processed(self, message_id: str) -> bool:
        """Prueft, ob eine Nachricht bereits verarbeitet wurde (Deduplizierung)."""
        if not message_id:
            return False
        clean_id = message_id.strip("<> ").strip()
        return clean_id in self.state.get("processed_message_ids", {})

    def mark_processed(
        self,
        message_id: str,
        details: Optional[Dict[str, Any]] = None
    ) -> None:
        """Markiert eine Nachricht als verarbeitet und speichert den Status."""
        if not message_id:
            return
        clean_id = message_id.strip("<> ").strip()
        now_iso = datetime.now(timezone.utc).isoformat()
        
        info = {
            "processed_at": now_iso,
            "status": "PROCESSED",
        }
        if details:
            info.update(details)

        self.state.setdefault("processed_message_ids", {})[clean_id] = info
        self.state["last_crawl_at"] = now_iso
        self.save_state()

    # -----------------------------------------------------------------------
    # Message Normalization
    # -----------------------------------------------------------------------

    def parse_raw_message(self, raw_input: Union[Dict[str, Any], email.message.Message, str, bytes]) -> Dict[str, Any]:
        """Normalisiert unterschiedliche Eingabeformate in ein standardisiertes Nachrichten-Dict."""
        if isinstance(raw_input, dict):
            sender = raw_input.get("from") or raw_input.get("sender") or ""
            _, sender_email = email.utils.parseaddr(sender)
            if not sender_email and "@" in sender:
                sender_email = sender.strip()

            subj = raw_input.get("subject", "")
            body = raw_input.get("body", "")
            in_reply_to = raw_input.get("in_reply_to") or raw_input.get("In-Reply-To") or ""
            references = raw_input.get("references") or raw_input.get("References") or ""
            message_id = raw_input.get("message_id") or raw_input.get("Message-ID") or ""
            date_str = raw_input.get("date") or datetime.now(timezone.utc).isoformat()
            to_raw = raw_input.get("to") or raw_input.get("To") or ""
            cc_raw = raw_input.get("cc") or raw_input.get("Cc") or ""
            delivered_to = raw_input.get("delivered_to") or raw_input.get("Delivered-To") or ""
            x_original_to = raw_input.get("x_original_to") or raw_input.get("X-Original-To") or ""
            x_forwarded_for = raw_input.get("x_forwarded_for") or raw_input.get("X-Forwarded-For") or ""
            x_forwarded_to = raw_input.get("x_forwarded_to") or raw_input.get("X-Forwarded-To") or ""
            list_unsub = raw_input.get("list_unsubscribe") or raw_input.get("List-Unsubscribe") or ""
            list_unsub_post = raw_input.get("list_unsubscribe_post") or raw_input.get("List-Unsubscribe-Post") or ""
            precedence = raw_input.get("precedence") or raw_input.get("Precedence") or ""
            auto_submitted = raw_input.get("auto_submitted") or raw_input.get("Auto-Submitted") or ""
            content_type = raw_input.get("content_type") or raw_input.get("Content-Type") or ""
            x_failed = raw_input.get("x_failed_recipients") or raw_input.get("X-Failed-Recipients") or ""
            dsn_text = raw_input.get("dsn_text") or ""
            attachments = raw_input.get("attachments") or []

            if not message_id:
                hash_input = f"{sender_email}_{subj}_{date_str}_{body[:100]}".encode("utf-8")
                message_id = f"gen-{hashlib.sha256(hash_input).hexdigest()[:16]}"

            return {
                "from_email": normalize_email(sender_email),
                "from_raw": sender,
                "to": str(to_raw),
                "cc": str(cc_raw),
                "delivered_to": str(delivered_to),
                "x_original_to": str(x_original_to),
                "x_forwarded_for": str(x_forwarded_for),
                "x_forwarded_to": str(x_forwarded_to),
                "subject": subj,
                "body": body,
                "in_reply_to": in_reply_to.strip("<> ").strip(),
                "references": str(references).strip("<> ").strip(),
                "message_id": message_id.strip("<> ").strip(),
                "date": date_str,
                "list_unsubscribe": str(list_unsub).strip(),
                "list_unsubscribe_post": str(list_unsub_post).strip(),
                "precedence": str(precedence).strip(),
                "auto_submitted": str(auto_submitted).strip(),
                "content_type": str(content_type).strip(),
                "x_failed_recipients": str(x_failed).strip(),
                "dsn_text": str(dsn_text),
                "attachments": attachments,
            }

        # Falls RFC 822 Bytes oder String
        if isinstance(raw_input, (bytes, str)):
            if isinstance(raw_input, str):
                msg = email.message_from_string(raw_input, policy=email.policy.default)
            else:
                msg = email.message_from_bytes(raw_input, policy=email.policy.default)
        else:
            msg = raw_input

        from_hdr = decode_mime_header(msg.get("From", ""))
        _, sender_email = email.utils.parseaddr(from_hdr)
        if not sender_email and "@" in from_hdr:
            sender_email = from_hdr.strip()

        to_hdr = decode_mime_header(msg.get("To", ""))
        cc_hdr = decode_mime_header(msg.get("Cc", ""))
        delivered_to = decode_mime_header(msg.get("Delivered-To", ""))
        x_original_to = decode_mime_header(msg.get("X-Original-To", ""))
        x_forwarded_for = decode_mime_header(msg.get("X-Forwarded-For", ""))
        x_forwarded_to = decode_mime_header(msg.get("X-Forwarded-To", ""))
        subject = decode_mime_header(msg.get("Subject", ""))
        body = extract_message_body(msg)
        in_reply_to = decode_mime_header(msg.get("In-Reply-To", "")).strip("<> ")
        references = decode_mime_header(msg.get("References", "")).strip("<> ")
        message_id = decode_mime_header(msg.get("Message-ID", "")).strip("<> ")
        date_str = decode_mime_header(msg.get("Date", "")) or datetime.now(timezone.utc).isoformat()
        list_unsub = decode_mime_header(msg.get("List-Unsubscribe", "")).strip()
        list_unsub_post = decode_mime_header(msg.get("List-Unsubscribe-Post", "")).strip()
        precedence = decode_mime_header(msg.get("Precedence", "")).strip()
        auto_submitted = decode_mime_header(msg.get("Auto-Submitted", "")).strip()
        content_type = str(msg.get("Content-Type", "") or "").strip()
        x_failed = decode_mime_header(msg.get("X-Failed-Recipients", "")).strip()
        dsn_text = _extract_dsn_text(msg)

        attachments = []
        if hasattr(msg, "walk"):
            for part in msg.walk():
                fn = part.get_filename()
                if fn:
                    fn_decoded = decode_mime_header(fn)
                    payload = part.get_payload(decode=True)
                    if payload:
                        attachments.append({
                            "filename": fn_decoded,
                            "content": payload,
                            "content_type": str(part.get_content_type() or ""),
                        })

        if not message_id:
            hash_input = f"{sender_email}_{subject}_{date_str}_{body[:100]}".encode("utf-8")
            message_id = f"gen-{hashlib.sha256(hash_input).hexdigest()[:16]}"

        return {
            "from_email": normalize_email(sender_email),
            "from_raw": from_hdr,
            "to": to_hdr,
            "cc": cc_hdr,
            "delivered_to": delivered_to,
            "x_original_to": x_original_to,
            "x_forwarded_for": x_forwarded_for,
            "x_forwarded_to": x_forwarded_to,
            "subject": subject,
            "body": body,
            "in_reply_to": in_reply_to,
            "references": references,
            "message_id": message_id,
            "date": date_str,
            "list_unsubscribe": list_unsub,
            "list_unsubscribe_post": list_unsub_post,
            "precedence": precedence,
            "auto_submitted": auto_submitted,
            "content_type": content_type,
            "x_failed_recipients": x_failed,
            "dsn_text": dsn_text,
            "attachments": attachments,
        }

    @staticmethod
    def has_thfc_domain(parsed: Dict[str, Any]) -> bool:
        """
        Prueft, ob thfc-consulting.de in To, Cc, Delivered-To oder Weiterleitungs-Headern vorkommt.
        Strikte Domain-Isolation fuer Sammel- und Weiterleitungspostfaecher.
        """
        all_recipients = " ".join([
            str(parsed.get("to") or ""),
            str(parsed.get("cc") or ""),
            str(parsed.get("delivered_to") or ""),
            str(parsed.get("x_original_to") or ""),
            str(parsed.get("x_forwarded_for") or ""),
            str(parsed.get("x_forwarded_to") or ""),
            str(parsed.get("from_raw") or ""),
        ]).lower()
        return "thfc-consulting.de" in all_recipients

    @staticmethod
    def is_automated_or_newsletter(parsed: Dict[str, Any]) -> bool:
        """
        Erkennt automatisierte Newsletter, Transaktions- und System-Mails anhand von RFC-Headern
        und Absender-Mustern, um False-Positive Opt-Outs (z. B. Doctolib-Abmelde-Links) zu verhindern.
        """
        # 1. RFC List-Unsubscribe Header (Standard fuer Massen-Newsletter)
        if parsed.get("list_unsubscribe") or parsed.get("list_unsubscribe_post"):
            return True

        # 2. Precedence Header (bulk, list, junk)
        precedence = (parsed.get("precedence") or "").strip().lower()
        if precedence in ("bulk", "list", "junk"):
            return True

        # 3. Auto-Submitted Header (RFC 3834)
        auto_submitted = (parsed.get("auto_submitted") or "").strip().lower()
        if auto_submitted and auto_submitted != "no":
            return True

        # 4. Typische Newsletter- und No-Reply-Absenderadressen
        from_email = (parsed.get("from_email") or "").lower()
        sender_local = from_email.split("@")[0] if "@" in from_email else ""
        sender_domain = from_email.split("@")[1] if "@" in from_email else ""

        automated_prefixes = (
            "no-reply", "noreply", "newsletter", "news", "notifications",
            "notification", "mailer-daemon", "bounce", "marketing", "updates", "info-news"
        )
        if any(sender_local == p or sender_local.startswith(f"{p}-") or sender_local.startswith(f"{p}+") or sender_local.startswith(f"{p}_") or sender_local.startswith(f"{p}.") for p in automated_prefixes):
            return True

        # Subdomains wie news.doctolib.com, nl.company.com, mail.service.com
        automated_subdomains = ("news.", "newsletter.", "nl.", "bounce.", "marketing.", "mkt.")
        if any(sender_domain.startswith(sub) for sub in automated_subdomains):
            return True

        return False

    # -----------------------------------------------------------------------
    # Lead Matching Engine
    # -----------------------------------------------------------------------

    def match_lead(
        self,
        from_email: str,
        in_reply_to: str = "",
        references: str = "",
        subject: str = "",
    ) -> Tuple[Optional[str], Optional[Dict[str, Any]], str]:
        """
        Ordnet eine Inbound-E-Mail einem bestehenden Kampagnen-Lead zu.
        
        Reihenfolge:
        1. Sender-E-Mail: Exakter Abgleich mit CRM-Lead
        2. In-Reply-To / References: Abgleich mit hinterlegter resend_id oder message_id
        3. Betreff: Abgleich des bereinigten Betreffs oder des Firmennamens
        
        Gibt zurueck: (matched_email, lead_dict, match_method)
        """
        norm_email = normalize_email(from_email)
        all_leads = self.storage.list_leads()
        leads_map = {l["email"]: l for l in all_leads}

        # 1. Matching ueber Sender-E-Mail
        if norm_email and norm_email in leads_map:
            return norm_email, leads_map[norm_email], "sender_email"

        # 2. Matching ueber In-Reply-To Header oder References
        id_candidates = []
        if in_reply_to:
            id_candidates.append(in_reply_to.strip("<> "))
        if references:
            for ref in references.split():
                id_candidates.append(ref.strip("<> "))

        for cand in id_candidates:
            if not cand:
                continue
            # Pruefe auf Uebereinstimmung mit resend_id des Leads
            for l_email, lead in leads_map.items():
                r_id = lead.get("resend_id")
                if r_id and (r_id == cand or r_id in cand or cand in r_id):
                    return l_email, lead, "in_reply_to"

                # Auch Kontakthistorie nach der ID durchsuchen
                for event in lead.get("history", []):
                    evt_resend = event.get("resend_id")
                    evt_msg = event.get("message_id")
                    if evt_resend and (evt_resend == cand or evt_resend in cand or cand in evt_resend):
                        return l_email, lead, "in_reply_to"
                    if evt_msg and (evt_msg == cand or evt_msg in cand or cand in evt_msg):
                        return l_email, lead, "in_reply_to"

        # 3. Matching ueber Betreff (Subject)
        clean_subj = clean_subject_prefix(subject).lower()
        if clean_subj:
            # 3a. Direkter Betreff-Abgleich
            for l_email, lead in leads_map.items():
                lead_subj = clean_subject_prefix(lead.get("subject", "")).lower()
                if lead_subj and (clean_subj == lead_subj or clean_subj in lead_subj or lead_subj in clean_subj):
                    return l_email, lead, "subject"

            # 3b. Abgleich ueber Firmennamen im Betreff
            for l_email, lead in leads_map.items():
                company = lead.get("company", "").strip().lower()
                if company and len(company) > 3 and company in clean_subj:
                    return l_email, lead, "subject_company"

        # Fallback: Falls der Absender eine valide Adresse hat, geben wir sie als neuen Lead zurueck
        if norm_email:
            return norm_email, leads_map.get(norm_email), "new_sender"

        return None, None, "unmatched"

    # -----------------------------------------------------------------------
    # Message Processing & CRM / Blacklist Update
    # -----------------------------------------------------------------------

    def _handle_bounce(self, parsed: Dict[str, Any], bounce: Dict[str, Any]) -> Dict[str, Any]:
        """Verarbeitet eine erkannte Bounce: Hard -> mark_bounced, Soft/Unknown -> nur loggen."""
        msg_id = parsed["message_id"]
        kind = bounce["kind"]
        recipients = bounce["recipients"]
        code = bounce["status_code"]
        status = "BOUNCE_HARD" if kind == "HARD" else ("BOUNCE_SOFT" if kind == "SOFT" else "BOUNCE_UNKNOWN")
        marked: List[str] = []

        if kind == "HARD":
            for rcpt in recipients:
                # DSN-Spoofing-Schutz: Nur Leads bouncen, die wir tatsaechlich kontaktiert haben!
                lead = self.storage.get_lead(rcpt)
                current_status = lead.get("status") if lead else None
                if current_status not in (LeadStatus.OUTREACH_SENT, LeadStatus.FOLLOWUP_SENT):
                    logger.warning(
                        "Bounce fuer nicht kontaktierten Lead %s (Status: %s) ignoriert (DSN-Spoofing-Schutz).",
                        rcpt,
                        current_status,
                    )
                    continue

                try:
                    self.storage.mark_bounced(
                        rcpt,
                        detail=f"DSN {code}: {parsed.get('subject', '')}"[:300],
                        bounce_meta={
                            "status_code": code,
                            "message_id": msg_id,
                            "reporter": parsed.get("from_email", ""),
                            "signals": bounce["signals"],
                        },
                    )
                    marked.append(rcpt)
                except Exception as exc:  # pragma: no cover - defensiv
                    logger.error("mark_bounced fehlgeschlagen fuer %s: %s", rcpt, exc)
        else:
            logger.info("Bounce (%s, %s) ohne Statuswechsel fuer %s", kind, code or "-", recipients)

        self.mark_processed(msg_id, details={
            "status": status,
            "from": parsed.get("from_email", ""),
            "subject": parsed.get("subject", ""),
            "status_code": code,
            "recipients": recipients,
        })
        return {
            "status": status,
            "message_id": msg_id,
            "from_email": parsed.get("from_email", ""),
            "status_code": code,
            "recipients": recipients,
            "marked_bounced": marked,
            "skipped": True,
        }

    def process_message(
        self,
        raw_msg: Union[Dict[str, Any], email.message.Message, str, bytes]
    ) -> Dict[str, Any]:
        """
        Verarbeitet eine einzelne eingehende Nachricht vollstaendig:
        - Deduplizierung (prueft & markiert Nachricht)
        - Lead-Zuordnung (Sender, In-Reply-To, Betreff)
        - Intent-Klassifikation (NEGATIVE_OPTOUT, POSITIVE_TEST_REQUEST, GENERAL_INQUIRY)
        - CRM Lead-Status Aktualisierung & Blacklisting (Goldene Regel)
        """
        parsed = self.parse_raw_message(raw_msg)
        msg_id = parsed["message_id"]

        # 1. Deduplizierung: Bereits verarbeitete Nachrichten ueberspringen
        if self.is_processed(msg_id):
            return {
                "status": "DUPLICATE",
                "message_id": msg_id,
                "from_email": parsed["from_email"],
                "skipped": True,
            }

        # 1a. Bounce-/DSN-Erkennung (vor Newsletter-Filter, da DSNs oft Auto-Submitted tragen)
        bounce = detect_bounce(
            parsed,
            own_addresses=self.own_addresses,
            is_known_lead=lambda addr: self.storage.get_lead(addr) is not None,
        )
        if bounce is not None:
            return self._handle_bounce(parsed, bounce)

        # 1b. Newsletter- und Automated-Header-Filter (Schutz vor False-Positive Opt-Outs durch News-Footer)
        if self.is_automated_or_newsletter(parsed):
            self.mark_processed(msg_id, details={
                "status": "IGNORED_AUTOMATED",
                "from": parsed["from_email"],
                "subject": parsed.get("subject", "")
            })
            return {
                "status": "IGNORED_AUTOMATED",
                "message_id": msg_id,
                "from_email": parsed["from_email"],
                "skipped": True,
            }

        # 2. Lead matchen
        lead_email, lead_obj, match_method = self.match_lead(
            from_email=parsed["from_email"],
            in_reply_to=parsed["in_reply_to"],
            references=parsed["references"],
            subject=parsed["subject"],
        )
        target_email = lead_email or parsed["from_email"]

        # 2b. STRIKTES DOMAIN HARD-GATE:
        # Falls die Mail NICHT von einem bekannten Kampagnen-Lead stammt,
        # MUSS zwingend thfc-consulting.de als Empfaenger, Weiterleitung oder Absender vorliegen.
        # Saemtliche Mails an private Adressen (z.B. @googlemail.com) werden sofort verworfen.
        if not lead_obj and not self.has_thfc_domain(parsed):
            self.mark_processed(msg_id, details={
                "status": "IGNORED_FOREIGN_DOMAIN",
                "from": parsed["from_email"],
                "to": parsed.get("to", ""),
                "reason": "Hard-Gate: Keine thfc-consulting.de Domain in Empfaenger- oder Weiterleitungs-Headern",
            })
            return {
                "status": "IGNORED_FOREIGN_DOMAIN",
                "message_id": msg_id,
                "from_email": parsed["from_email"],
                "skipped": True,
            }

        # 2c. Relevanz-Pruefung fuer ungematchte Absender auf thfc-consulting.de:
        if not lead_obj:
            subject_raw = unicodedata.normalize("NFKC", str(parsed.get("subject") or "")).casefold().replace("’", "'")
            body_raw = unicodedata.normalize("NFKC", str(parsed.get("body") or "")).casefold().replace("’", "'")
            
            has_campaign_keywords = any(kw in subject_raw or kw in body_raw for kw in [
                "safety gate", "rapex", "produktsicherheit", "sécurité", "securite", "veiligheid", 
                "gtin", "spielwaren", "jouet", "speelgoed", "compliance", "rückruf", "ruckruf", "rappel"
            ])
            # F-01 FIX (Herznieren): Goldene Regel - Echte menschliche Opt-Out-Phrasen
            # fuehren IMMER zur Intent-Klassifikation und Blacklistierung, selbst wenn kein Re-Header vorliegt!
            human_optout_phrases = [
                "kein interesse", "kein bedarf", "nicht mehr kontaktieren", "austragen",
                "pas d'intérêt", "pas d'interet", "non merci", "geen interesse",
                "niet geïnteresseerd", "niet geinteresseerd", "nein danke", "nee bedankt"
            ]
            has_human_optout = any(phrase in subject_raw or phrase in body_raw for phrase in human_optout_phrases)

            # Generische Opt-Out-Keywords (die auch in Dritt-Newslettern vorkommen) erfordern Reply-Bezug
            generic_optout_keywords = [
                "nein", "abmelden", "stop", "unsubscribe", "remove", "désinscrire", "desinscrire",
                "afmelden", "uitschrijven", "nee"
            ]
            has_generic_optout = any(kw in subject_raw or kw in body_raw for kw in generic_optout_keywords)

            is_reply = bool(
                parsed.get("in_reply_to") 
                or parsed.get("references") 
                or any(subject_raw.startswith(pref) for pref in (
                    "re:", "re ", "aw:", "aw ", "antw:", "antw ", "antwort", 
                    "rep:", "rép:", "fwd:", "fw:", "wg:", "tr:", "vs:"
                ))
            )

            # Falls weder Kampagnen-Keywords noch Opt-Outs (menschlich oder generisch mit Reply) vorliegen -> ignorieren
            if not has_campaign_keywords and not (has_human_optout or (has_generic_optout and is_reply)):
                self.mark_processed(msg_id, details={"status": "IGNORED_UNRELATED", "from": parsed["from_email"]})
                return {
                    "status": "IGNORED_UNRELATED",
                    "message_id": msg_id,
                    "from_email": parsed["from_email"],
                    "skipped": True,
                }

        # 3. Intent klassifizieren
        classification: ClassificationResult = classify_intent(
            body=parsed["body"],
            subject=parsed["subject"]
        )

        # Wenn Anhang mit CSV/TSV/XLSX-Artikeln vorliegt und kein Opt-Out vorliegt:
        # Einstufung als POSITIVE_TEST_REQUEST fuer den automatisierten Free-Check Flow.
        if classification.intent != Intent.NEGATIVE_OPTOUT and parsed.get("attachments"):
            from scripts.crm.free_check_flow import parse_attachment_items
            for att in parsed["attachments"]:
                if parse_attachment_items(att.get("filename", ""), att.get("content", b"")):
                    classification.intent = Intent.POSITIVE_TEST_REQUEST
                    classification.reason = "Attachment with product catalog / EANs received for free check"
                    break

        now_iso = datetime.now(timezone.utc).isoformat()
        snippet = classification.clean_text[:300].strip()

        # 4. CRM Status & Blacklist aktualisieren
        _pre_lead = self.storage.get_lead(target_email) or {}
        lead_is_terminal = _pre_lead.get("status") in TERMINAL_STATUSES
        if lead_is_terminal and classification.intent != Intent.NEGATIVE_OPTOUT:
            # Terminale Leads (BOUNCED / LOST_BLACKLISTED) werden nie reaktiviert.
            logger.info("Inbound von terminalem Lead %s (%s) - Status bleibt.", target_email, _pre_lead.get("status"))
        elif classification.intent == Intent.NEGATIVE_OPTOUT:
            # Goldene Regel: Sofortige permanente Blacklistierung
            self.blacklist_mgr.add_to_blacklist(
                target_email,
                reason=classification.reason,
                snippet=snippet
            )
            try:
                self.storage.update_lead_status(
                    target_email,
                    LeadStatus.LOST_BLACKLISTED,
                    reason=classification.reason,
                    snippet=snippet
                )
            except TerminalStatusTransitionError:
                pass  # BOUNCED bleibt BOUNCED; Blacklist-Eintrag ist bereits gesetzt.
            # Telegram-Push fuer Opt-Out (Goldene Regel)
            try:
                from scripts.crm.telegram_bot import get_default_bot
                get_default_bot().notify_optout(target_email, reason=classification.reason, snippet=snippet)
            except Exception:
                pass
        elif classification.intent == Intent.POSITIVE_TEST_REQUEST:
            self.storage.update_lead_status(
                target_email,
                LeadStatus.REPLIED_POSITIVE,
                reason=classification.reason,
                snippet=snippet
            )
        else: # GENERAL_INQUIRY
            self.storage.update_lead_status(
                target_email,
                LeadStatus.REPLIED_INQUIRY,
                reason=classification.reason,
                snippet=snippet
            )

        # 5. E-Mail-Event in Kontakthistorie des Leads festhalten
        active_lead = self.storage.get_lead(target_email)
        generated_draft = None
        draft_id = None

        # Falls auto_draft aktiv: Safety Gate Engine & Response Drafter anstossen
        if self.auto_draft and not lead_is_terminal and classification.intent == Intent.POSITIVE_TEST_REQUEST:
            try:
                # 1. Pruefe zuerst auf CSV/TSV/XLSX-Anhaenge (Automatisierter Free-Check Flow)
                att_items = []
                for att in parsed.get("attachments") or []:
                    from scripts.crm.free_check_flow import parse_attachment_items
                    found = parse_attachment_items(att.get("filename", ""), att.get("content", b""))
                    if found:
                        att_items.extend(found)

                if att_items:
                    from scripts.crm.free_check_flow import execute_free_check, enqueue_free_check_draft
                    comp = (active_lead or {}).get("company", "")
                    free_res = execute_free_check(
                        sender_email=target_email,
                        items=att_items,
                        company=comp,
                        engine=self.engine,
                    )
                    generated_draft = enqueue_free_check_draft(
                        result=free_res,
                        storage=self.storage,
                        queue=self.drafter.queue if self.drafter else None,
                        blacklist_mgr=self.blacklist_mgr,
                    )
                    if isinstance(generated_draft, dict):
                        draft_id = generated_draft.get("draft_id")
                    elif hasattr(generated_draft, "draft_id"):
                        draft_id = getattr(generated_draft, "draft_id")
                elif self.engine and self.drafter:
                    # 2. Fallback: Freitext-EANs aus Body
                    audit_report = self.engine.run_audit(text=parsed["body"])
                    lead_data = active_lead or {"email": target_email}
                    lead_lang = lead_data.get("language") if isinstance(lead_data, dict) else None
                    generated_draft = self.drafter.draft_and_enqueue(
                        lead=lead_data,
                        inbound_message=parsed,
                        report_data=audit_report,
                        language=lead_lang,
                        intent=classification.intent,
                    )
                    if isinstance(generated_draft, dict):
                        draft_id = generated_draft.get("draft_id")
                    elif hasattr(generated_draft, "draft_id"):
                        draft_id = getattr(generated_draft, "draft_id")

                    # Telegram-Push fuer neuen Entwurf (Human-in-the-Loop)
                    if generated_draft:
                        try:
                            from scripts.crm.telegram_bot import get_default_bot
                            draft_payload = generated_draft if isinstance(generated_draft, dict) else (getattr(generated_draft, "__dict__", {}) or {})
                            get_default_bot().notify_new_draft(draft_payload)
                        except Exception:
                            pass
            except Exception as draft_err:
                logger.warning("Fehler beim Erzeugen des Antwortentwurfs fuer %s: %s", target_email, draft_err)

        if active_lead:
            inbound_event = {
                "action": "INBOUND_REPLY",
                "timestamp": now_iso,
                "message_id": msg_id,
                "from": parsed["from_raw"],
                "subject": parsed["subject"],
                "intent": classification.intent,
                "confidence": classification.confidence,
                "matched_by": match_method,
                "eans_detected": classification.eans_detected,
                "snippet": snippet,
            }
            if draft_id:
                inbound_event["draft_id"] = draft_id
            active_lead.setdefault("history", []).append(inbound_event)
            active_lead["updated_at"] = now_iso
            self.storage.save()

        # 6. Deduplizierung: Nachricht als verarbeitet markieren
        self.mark_processed(
            msg_id,
            details={
                "lead_email": target_email,
                "intent": classification.intent,
                "matched_by": match_method,
                "subject": parsed["subject"],
            }
        )

        res_dict = {
            "status": "PROCESSED",
            "message_id": msg_id,
            "lead_email": target_email,
            "intent": classification.intent,
            "confidence": classification.confidence,
            "matched_by": match_method,
            "classification": classification,
            "skipped": False,
        }
        if generated_draft:
            res_dict["draft"] = generated_draft
            res_dict["draft_id"] = draft_id
        return res_dict

    # -----------------------------------------------------------------------
    # Crawl Execution (Mock & Live IMAP)
    # -----------------------------------------------------------------------

    def crawl_mock(
        self,
        messages: List[Union[Dict[str, Any], email.message.Message, str, bytes]]
    ) -> List[Dict[str, Any]]:
        """Verarbeitet eine Liste von Mock-Nachrichten ohne Netzwerkaufruf."""
        results: List[Dict[str, Any]] = []
        for msg in messages:
            res = self.process_message(msg)
            results.append(res)
        return results

    def crawl_imap(
        self,
        folder: str = "INBOX",
        unread_only: bool = True,
        mark_seen: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Verbindet sich mit dem IMAP-Server via SSL, sucht Nachrichten,
        verarbeitet sie und setzt optional das Seen-Flag auf dem Server.
        """
        if not self.imap_host or not self.imap_user or not self.imap_pass:
            raise ValueError(
                "IMAP Zugangsdaten unvollstaendig. Bitte IMAP_HOST, IMAP_USER und IMAP_PASS setzen."
            )

        results: List[Dict[str, Any]] = []
        client = imaplib.IMAP4_SSL(self.imap_host, self.imap_port)
        try:
            client.login(self.imap_user, self.imap_pass)
            client.select(folder)

            search_criterion = "UNSEEN" if unread_only else "ALL"
            typ, data = client.search(None, search_criterion)
            if typ != "OK":
                return results

            msg_ids = data[0].split()
            for num in msg_ids:
                typ, msg_data = client.fetch(num, "(RFC822)")
                if typ != "OK" or not msg_data or not msg_data[0]:
                    continue

                raw_email = msg_data[0][1]
                res = self.process_message(raw_email)
                results.append(res)

                # Auf IMAP Server als gelesen markieren
                if mark_seen:
                    client.store(num, "+FLAGS", "(\\Seen)")

        finally:
            try:
                client.close()
            except Exception:
                pass
            try:
                client.logout()
            except Exception:
                pass

        return results

    def get_graph_token(self, force_refresh: bool = False) -> str:
        """
        Holt ein OAuth2 Access Token fuer Microsoft Graph via client_credentials.
        Cached das Token im Arbeitsspeicher mit 300s Sicherheits-Puffer gegen Ablauf.
        """
        import urllib.request
        import urllib.parse
        now = time.time()
        if not force_refresh and self._graph_token and now < self._graph_token_expires_at:
            return self._graph_token

        env = load_env_crawler()
        tenant_id = os.environ.get("MS_GRAPH_TENANT_ID") or env.get("MS_GRAPH_TENANT_ID")
        client_id = os.environ.get("MS_GRAPH_CLIENT_ID") or env.get("MS_GRAPH_CLIENT_ID")
        client_secret = os.environ.get("MS_GRAPH_CLIENT_SECRET") or env.get("MS_GRAPH_CLIENT_SECRET")

        if not tenant_id or not client_id or not client_secret:
            raise ValueError(
                "Microsoft Graph Zugangsdaten unvollstaendig (MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID, MS_GRAPH_CLIENT_SECRET)."
            )

        token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        data = urllib.parse.urlencode({
            "client_id": client_id,
            "client_secret": client_secret,
            "grant_type": "client_credentials",
            "scope": "https://graph.microsoft.com/.default"
        }).encode("utf-8")

        req = urllib.request.Request(token_url, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            token_data = json.loads(resp.read().decode("utf-8"))
            access_token = token_data["access_token"]
            expires_in = float(token_data.get("expires_in", 3600))
            self._graph_token = access_token
            self._graph_token_expires_at = now + expires_in - 300  # 5 Minuten Puffer
            return access_token

    def crawl_graph(
        self,
        mailbox: Optional[str] = None,
        folders: Optional[List[str]] = None,
        limit: int = 50,
        max_pages_per_folder: int = 10,
    ) -> List[Dict[str, Any]]:
        """
        Liest Inbound-Mails ueber die Microsoft Graph API fuer das angegebene Postfach (z. B. info@thfc-consulting.de).
        Scannt standardmaessig Posteingang (inbox) und Junk-E-Mail (junkemail).
        - Verfolgt @odata.nextLink Paging bis zu max_pages_per_folder (F-02).
        - Selektiert und parst internetMessageHeaders fuer Newsletter- und Auto-Reply-Filter (F-04).
        - Auto-Retry bei abgelaufenem Token (401) mitten im Scan.
        - Verarbeitet und dedupliziert alle Nachrichten automatisch.
        """
        import urllib.request
        env = load_env_crawler()
        target_mailbox = mailbox or os.environ.get("MS_GRAPH_MAILBOX") or env.get("MS_GRAPH_MAILBOX", "info@thfc-consulting.de")
        scan_folders = folders or ["inbox", "junkemail"]

        token = self.get_graph_token()
        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json"
        }

        results: List[Dict[str, Any]] = []

        for folder in scan_folders:
            graph_url = f"https://graph.microsoft.com/v1.0/users/{target_mailbox}/mailFolders/{folder}/messages?$top={limit}&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,body,bodyPreview,receivedDateTime,conversationId,isRead,hasAttachments,internetMessageHeaders&$orderby=receivedDateTime%20desc"
            pages = 0
            retried_auth = False

            while graph_url and pages < max_pages_per_folder:
                req = urllib.request.Request(graph_url, headers=headers)
                try:
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        data = json.loads(resp.read().decode("utf-8"))
                        messages = data.get("value", [])
                        for msg in messages:
                            from_email = msg.get("from", {}).get("emailAddress", {}).get("address", "")
                            from_name = msg.get("from", {}).get("emailAddress", {}).get("name", "")
                            from_raw = f"{from_name} <{from_email}>" if from_name else from_email
                            
                            to_list = [r.get("emailAddress", {}).get("address", "") for r in msg.get("toRecipients", [])]
                            to_str = ", ".join(to_list)

                            # Body ermitteln
                            body_content = msg.get("body", {}).get("content", "")
                            if msg.get("body", {}).get("contentType", "").lower() == "html":
                                body_content = _HTML_STRIP_RE.sub(" ", body_content)
                            if not body_content:
                                body_content = msg.get("bodyPreview", "")

                            # F-04: internetMessageHeaders extrahieren
                            headers_list = msg.get("internetMessageHeaders") or []
                            header_map: Dict[str, str] = {}
                            if isinstance(headers_list, list):
                                for h in headers_list:
                                    if isinstance(h, dict) and "name" in h:
                                        header_map[str(h.get("name", "")).lower()] = str(h.get("value", "")).strip()

                            msg_dict = {
                                "content_type": header_map.get("content-type", ""),
                                "x_failed_recipients": header_map.get("x-failed-recipients", ""),
                                "from": from_raw,
                                "to": to_str,
                                "subject": msg.get("subject", ""),
                                "body": body_content,
                                "message_id": msg.get("internetMessageId") or msg.get("id"),
                                "date": msg.get("receivedDateTime"),
                                "graph_id": msg.get("id"),
                                "conversation_id": msg.get("conversationId"),
                                "list_unsubscribe": header_map.get("list-unsubscribe", ""),
                                "list_unsubscribe_post": header_map.get("list-unsubscribe-post", ""),
                                "precedence": header_map.get("precedence", ""),
                                "auto_submitted": header_map.get("auto-submitted", ""),
                            }

                            res = self.process_message(msg_dict)
                            results.append(res)

                        # F-02: NextLink Paging
                        graph_url = data.get("@odata.nextLink")
                        pages += 1

                except urllib.error.HTTPError as he:
                    if he.code == 401 and not retried_auth:
                        # Token abgelaufen -> einmal Refresh und Retry
                        token = self.get_graph_token(force_refresh=True)
                        headers["Authorization"] = f"Bearer {token}"
                        retried_auth = True
                        continue
                    logging.getLogger("CRM.Crawler").warning(f"[GraphCrawler] HTTP Error {he.code} bei Ordner {folder}: {he}")
                    break
                except Exception as e:
                    logging.getLogger("CRM.Crawler").warning(f"[GraphCrawler] Fehler beim Scannen von {folder}: {e}")
                    break

        return results

    def crawl(
        self,
        mock_messages: Optional[List[Union[Dict[str, Any], email.message.Message, str, bytes]]] = None,
        folder: str = "INBOX",
        unread_only: bool = True,
        mark_seen: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Haupt-Einstiegspunkt des Crawlers:
        - Falls mock_messages uebergeben wurden, wird crawl_mock genutzt.
        - Falls CRM_MAIL_SOURCE == 'graph': Fail-Closed Pruefung und crawl_graph.
        - Falls Graph-Credentials vorliegen: crawl_graph.
        - Andernfalls Fallback auf crawl_imap.
        """
        if mock_messages is not None:
            return self.crawl_mock(mock_messages)

        env = load_env_crawler()
        source = os.environ.get("CRM_MAIL_SOURCE") or env.get("CRM_MAIL_SOURCE")
        if source == "graph":
            if not (env.get("MS_GRAPH_TENANT_ID") and env.get("MS_GRAPH_CLIENT_ID") and env.get("MS_GRAPH_CLIENT_SECRET")):
                raise ValueError("CRM_MAIL_SOURCE=graph konfiguriert, aber Microsoft Graph Zugangsdaten sind unvollstaendig!")
            return self.crawl_graph()
        elif env.get("MS_GRAPH_TENANT_ID") and env.get("MS_GRAPH_CLIENT_ID") and env.get("MS_GRAPH_CLIENT_SECRET"):
            return self.crawl_graph()

        return self.crawl_imap(folder=folder, unread_only=unread_only, mark_seen=mark_seen)
