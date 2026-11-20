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
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

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
    CRMStorage,
    LeadStatus,
    get_default_storage,
)


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
                        text = re.sub(r"<[^>]+>", " ", html)
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

            if not message_id:
                hash_input = f"{sender_email}_{subj}_{date_str}_{body[:100]}".encode("utf-8")
                message_id = f"gen-{hashlib.sha256(hash_input).hexdigest()[:16]}"

            return {
                "from_email": normalize_email(sender_email),
                "from_raw": sender,
                "subject": subj,
                "body": body,
                "in_reply_to": in_reply_to.strip("<> ").strip(),
                "references": str(references).strip("<> ").strip(),
                "message_id": message_id.strip("<> ").strip(),
                "date": date_str,
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

        subject = decode_mime_header(msg.get("Subject", ""))
        body = extract_message_body(msg)
        in_reply_to = decode_mime_header(msg.get("In-Reply-To", "")).strip("<> ")
        references = decode_mime_header(msg.get("References", "")).strip("<> ")
        message_id = decode_mime_header(msg.get("Message-ID", "")).strip("<> ")
        date_str = decode_mime_header(msg.get("Date", "")) or datetime.now(timezone.utc).isoformat()

        if not message_id:
            hash_input = f"{sender_email}_{subject}_{date_str}_{body[:100]}".encode("utf-8")
            message_id = f"gen-{hashlib.sha256(hash_input).hexdigest()[:16]}"

        return {
            "from_email": normalize_email(sender_email),
            "from_raw": from_hdr,
            "subject": subject,
            "body": body,
            "in_reply_to": in_reply_to,
            "references": references,
            "message_id": message_id,
            "date": date_str,
        }

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

        # 2. Lead matchen
        lead_email, lead_obj, match_method = self.match_lead(
            from_email=parsed["from_email"],
            in_reply_to=parsed["in_reply_to"],
            references=parsed["references"],
            subject=parsed["subject"],
        )
        target_email = lead_email or parsed["from_email"]

        # Relevanz-Pruefung fuer Sammelpostfaecher:
        # Falls kein bekannter Kampagnen-Lead gematcht wurde, pruefen ob Nachricht Kampagnen-Bezug hat
        if not lead_obj:
            to_raw = (parsed.get("to") or "").lower()
            from_raw = (parsed.get("from_raw") or "").lower()
            subject_raw = unicodedata.normalize("NFKC", str(parsed.get("subject") or "")).casefold().replace("’", "'")
            body_raw = unicodedata.normalize("NFKC", str(parsed.get("body") or "")).casefold().replace("’", "'")
            
            is_campaign_target = "thfc-consulting.de" in to_raw or "thfc-consulting.de" in from_raw
            has_campaign_keywords = any(kw in subject_raw or kw in body_raw for kw in [
                "safety gate", "rapex", "produktsicherheit", "sécurité", "securite", "veiligheid", 
                "gtin", "spielwaren", "jouet", "speelgoed", "compliance", "rückruf", "ruckruf", "rappel"
            ])
            # F-04: Goldene Regel absichern - Opt-Out-Signalwoerter (multilingual inkl. Apostroph-Varianten) nie als unrelated verwerfen
            has_optout_keywords = any(kw in subject_raw or kw in body_raw for kw in [
                "nein", "kein interesse", "kein bedarf", "nicht mehr kontaktieren", "austragen", "abmelden",
                "stop", "unsubscribe", "remove", "pas d'intérêt", "pas d'interet", "non merci", "désinscrire", "desinscrire",
                "geen interesse", "nee", "niet geïnteresseerd", "niet geinteresseerd", "afmelden", "uitschrijven"
            ])
            # Falls weder Kampagnen-Zieladresse noch relevante Keywords oder Opt-Outs -> als unbeteiligte Mail ignorieren
            if not is_campaign_target and not has_campaign_keywords and not has_optout_keywords:
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

        now_iso = datetime.now(timezone.utc).isoformat()
        snippet = classification.clean_text[:300].strip()

        # 4. CRM Status & Blacklist aktualisieren
        if classification.intent == Intent.NEGATIVE_OPTOUT:
            # Goldene Regel: Sofortige permanente Blacklistierung
            self.blacklist_mgr.add_to_blacklist(
                target_email,
                reason=classification.reason,
                snippet=snippet
            )
            self.storage.update_lead_status(
                target_email,
                LeadStatus.LOST_BLACKLISTED,
                reason=classification.reason,
                snippet=snippet
            )
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
        if self.auto_draft and self.engine and self.drafter and classification.intent == Intent.POSITIVE_TEST_REQUEST:
            try:
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
            except Exception:
                pass

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

    def crawl(
        self,
        mock_messages: Optional[List[Union[Dict[str, Any], email.message.Message, str, bytes]]] = None,
        folder: str = "INBOX",
        unread_only: bool = True,
        mark_seen: bool = True,
    ) -> List[Dict[str, Any]]:
        """
        Haupt-Einstiegspunkt des Crawlers:
        Falls mock_messages uebergeben wurden, wird crawl_mock genutzt.
        Andernfalls wird ueber IMAP SSL gecrawlt.
        """
        if mock_messages is not None:
            return self.crawl_mock(mock_messages)
        return self.crawl_imap(folder=folder, unread_only=unread_only, mark_seen=mark_seen)
