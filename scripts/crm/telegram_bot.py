"""
scripts/crm/telegram_bot.py
2-Wege Telegram Bot & Mobile HITL-Cockpit fuer die ProductSafetyEngine.

Features:
1. Push-Benachrichtigung aufs iPhone bei neuen eingehenden Lead-Antworten.
2. 1-Klick-Freigabe ('Approve & Send') und 'Reject' direkt via Telegram Inline-Buttons.
3. Push-Benachrichtigung bei Opt-Outs (sofortige Blacklist-Bestaetigung).
4. Auto-Erkennung der Thomas-Chat-ID beim ersten /start.
5. Vollstaendig autonom ohne externe Abhaengigkeiten (reines urllib mit IPv4-Hardening).
"""

from __future__ import annotations

import json
import logging
import os
import socket
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# IPv4 Force Patch fuer api.telegram.org (verhindert IPv6 Blackholing/Timeouts)
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_getaddrinfo

logger = logging.getLogger("CRM.TelegramBot")


def load_env_file(env_path: Optional[Path] = None) -> Dict[str, str]:
    """Laedt Schluessel aus der .env Datei."""
    if not env_path:
        env_path = Path(__file__).resolve().parent.parent.parent / ".env"
    env_vars: Dict[str, str] = {}
    if env_path.exists():
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    val = v.strip().strip("'\"")
                    env_vars[k.strip()] = val
                    if k.strip() not in os.environ:
                        os.environ[k.strip()] = val
    return env_vars


class TelegramCRMNotifier:
    """Steuert den Telegram-Push und die Human-in-the-Loop Freigaben."""

    BASE_URL = "https://api.telegram.org/bot{token}/{method}"

    def __init__(
        self,
        bot_token: Optional[str] = None,
        chat_id: Optional[str | int] = None,
        env_file: Optional[Path] = None
    ) -> None:
        self.project_dir = Path(__file__).resolve().parent.parent.parent
        self.env_file = env_file or (self.project_dir / ".env")
        env_vars = load_env_file(self.env_file)

        self.bot_token = bot_token or os.environ.get("TELEGRAM_BOT_TOKEN") or env_vars.get("TELEGRAM_BOT_TOKEN", "")
        self.chat_id = chat_id or os.environ.get("TELEGRAM_CHAT_ID") or env_vars.get("TELEGRAM_CHAT_ID", "")

        if not self.bot_token:
            logger.warning("[TelegramBot] Kein TELEGRAM_BOT_TOKEN hinterlegt.")

    def _api_call(self, method: str, data: Optional[Dict[str, Any]] = None, timeout: int = 10) -> Dict[str, Any]:
        """Fuehrt einen sicheren HTTPS-Call gegen die Telegram Bot API aus."""
        if not self.bot_token:
            return {"ok": False, "error": "No bot token configured"}

        url = self.BASE_URL.format(token=self.bot_token, method=method)
        req_data = None
        headers = {"User-Agent": "ProductSafetyEngine-CRM/1.0"}

        if data is not None:
            req_data = json.dumps(data).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib.request.Request(url, data=req_data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw)
        except Exception as exc:
            logger.error(f"[TelegramBot] API Error ({method}): {exc}")
            return {"ok": False, "error": str(exc)}

    def get_me(self) -> Dict[str, Any]:
        """Prueft die Verbindung zum Bot."""
        return self._api_call("getMe")

    def get_updates(self, offset: int = 0, timeout: int = 5) -> List[Dict[str, Any]]:
        """Liest neue Nachrichten / Callback-Events."""
        payload: Dict[str, Any] = {"timeout": timeout}
        if offset > 0:
            payload["offset"] = offset
        res = self._api_call("getUpdates", payload, timeout=timeout + 5)
        if res.get("ok"):
            return res.get("result", [])
        return []

    def save_chat_id(self, new_chat_id: str | int) -> None:
        """Persistiert die neu erkannte Chat-ID in .env."""
        str_id = str(new_chat_id).strip()
        self.chat_id = str_id
        os.environ["TELEGRAM_CHAT_ID"] = str_id

        if not self.env_file.exists():
            self.env_file.write_text(f"TELEGRAM_CHAT_ID={str_id}\n", encoding="utf-8")
            return

        lines = self.env_file.read_text(encoding="utf-8").splitlines()
        updated = False
        new_lines = []
        for line in lines:
            if line.strip().startswith("TELEGRAM_CHAT_ID="):
                new_lines.append(f"TELEGRAM_CHAT_ID={str_id}")
                updated = True
            else:
                new_lines.append(line)
        if not updated:
            new_lines.append(f"TELEGRAM_CHAT_ID={str_id}")

        self.env_file.write_text("\n".join(new_lines) + "\n", encoding="utf-8")
        logger.info(f"[TelegramBot] Chat ID {str_id} erfolgreich in {self.env_file} persistiert.")

    def send_message(
        self,
        text: str,
        chat_id: Optional[str | int] = None,
        reply_markup: Optional[Dict[str, Any]] = None,
        parse_mode: str = "HTML"
    ) -> Dict[str, Any]:
        """Sendet eine Nachricht an Thomas' Telegram-Account."""
        target_chat = chat_id or self.chat_id
        if not target_chat:
            logger.warning("[TelegramBot] Keine Chat-ID verfuegbar. Nachricht kann nicht versendet werden.")
            return {"ok": False, "error": "No chat_id"}

        payload = {
            "chat_id": target_chat,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup

        return self._api_call("sendMessage", payload)

    def edit_message_text(
        self,
        text: str,
        chat_id: str | int,
        message_id: int,
        reply_markup: Optional[Dict[str, Any]] = None,
        parse_mode: str = "HTML"
    ) -> Dict[str, Any]:
        """Aktualisiert eine bestehende Nachricht (z.B. nach Klick auf Freigeben)."""
        payload = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": parse_mode,
            "disable_web_page_preview": True
        }
        if reply_markup is not None:
            payload["reply_markup"] = reply_markup

        return self._api_call("editMessageText", payload)

    def answer_callback(self, callback_query_id: str, text: str = "", show_alert: bool = False) -> Dict[str, Any]:
        """Bestaetigt den Klick auf einen Inline-Button (Popup am Handy)."""
        return self._api_call("answerCallbackQuery", {
            "callback_query_id": callback_query_id,
            "text": text,
            "show_alert": show_alert
        })

    # -----------------------------------------------------------------------
    # Business-Level Notifier Methoden
    # -----------------------------------------------------------------------

    def notify_new_draft(self, draft: Dict[str, Any]) -> Dict[str, Any]:
        """
        Sendet einen neuen Entwurf zur Human-in-the-Loop Freigabe mit 1-Klick-Buttons.
        """
        draft_id = draft.get("draft_id", "unbekannt")
        recipient = draft.get("recipient", "")
        company = draft.get("company", "Lead")
        lang = draft.get("language", "de").upper()
        subject = draft.get("subject", "")
        body = draft.get("body", "")

        # Snippet des Bodys (die ersten 350 Zeichen)
        clean_snippet = body[:350].strip()
        if len(body) > 350:
            clean_snippet += "..."

        text = (
            f"🚨 <b>Neuer Lead-Entwurf wartet auf Freigabe!</b>\n\n"
            f"🏢 <b>Unternehmen:</b> {company}\n"
            f"📧 <b>Empfänger:</b> <code>{recipient}</code> ({lang})\n"
            f"📝 <b>Betreff:</b> {subject}\n"
            f"🆔 <b>Draft-ID:</b> <code>{draft_id}</code>\n\n"
            f"<b>Vorschau Entwurf:</b>\n"
            f"<blockquote>{clean_snippet}</blockquote>\n\n"
            f"<i>Möchtest du die Antwort jetzt via Resend freigeben und versenden?</i>"
        )

        reply_markup = {
            "inline_keyboard": [
                [
                    {"text": "✅ Freigeben & Senden", "callback_data": f"approve:{draft_id}"},
                    {"text": "❌ Ablehnen", "callback_data": f"reject:{draft_id}"}
                ],
                [
                    {"text": "👁️ Gesamten Entwurf ansehen", "callback_data": f"view:{draft_id}"}
                ]
            ]
        }

        return self.send_message(text, reply_markup=reply_markup)

    def notify_optout(self, email: str, reason: str, snippet: str = "") -> Dict[str, Any]:
        """
        Sendet eine Bestaetigung ueber ein automatisches Opt-Out (Goldene Regel).
        """
        text = (
            f"🚫 <b>Lead hat abgesagt (Opt-Out)</b>\n\n"
            f"📧 <b>Empfänger:</b> <code>{email}</code>\n"
            f"🛡️ <b>Status:</b> Dauerhaft in <code>.crm/blacklist.json</code> gesperrt (Goldene Regel).\n"
            f"📋 <b>Grund:</b> {reason}\n"
        )
        if snippet:
            text += f"\n<b>Antwort-Snippet:</b>\n<blockquote>{snippet[:200]}</blockquote>"

        return self.send_message(text)

    # -----------------------------------------------------------------------
    # Event-Loop & Callback-Dispatcher
    # -----------------------------------------------------------------------

    def handle_update(self, update: Dict[str, Any]) -> None:
        """Verarbeitet eingehende Telegram-Events (Nachrichten oder Button-Klicks)."""
        try:
            # 1. Callback Query (Button Klick)
            if "callback_query" in update:
                cb = update["callback_query"]
                cb_id = cb["id"]
                data = cb.get("data", "")
                from_user = cb.get("from", {})
                user_name = from_user.get("first_name", "Thomas")
                msg = cb.get("message", {})
                chat_id = msg.get("chat", {}).get("id")
                msg_id = msg.get("message_id")
                current_text = msg.get("text", "")

                logger.info(f"[TelegramBot] Callback empfangen von {user_name} (chat_id={chat_id}): '{data}'")

                # Sicherheitscheck: Chat-ID merken falls noetig
                if not self.chat_id and chat_id:
                    self.save_chat_id(chat_id)

                if data.startswith("approve:"):
                    draft_id = data.split(":", 1)[1]
                    self._handle_approve_callback(cb_id, draft_id, chat_id, msg_id, current_text, user_name)
                elif data.startswith("reject:"):
                    draft_id = data.split(":", 1)[1]
                    self._handle_reject_callback(cb_id, draft_id, chat_id, msg_id, current_text, user_name)
                elif data.startswith("view:"):
                    draft_id = data.split(":", 1)[1]
                    self._handle_view_callback(cb_id, draft_id, chat_id)
                return

            # 2. Normale Text-Nachricht (z.B. /start, /status, /queue, /help)
            if "message" in update:
                msg = update["message"]
                chat_id = msg.get("chat", {}).get("id")
                raw_text = (msg.get("text") or "").strip()
                user = msg.get("from", {})
                user_first = user.get("first_name", "Thomas")

                if chat_id and not self.chat_id:
                    self.save_chat_id(chat_id)

                # Robuste Normalisierung: Kleinbuchstaben, Bot-Handle (@BotName) entfernen
                clean_cmd = raw_text.lower().split()[0].split("@")[0] if raw_text else ""
                logger.info(f"[TelegramBot] Eingehende Nachricht: user='{user_first}' chat_id={chat_id} text='{raw_text}' cmd='{clean_cmd}'")

                if clean_cmd in ("/start", "start"):
                    welcome = (
                        f"👋 <b>Bereit, {user_first}!</b>\n\n"
                        f"Der <b>ProductSafetyEngine CRM-Bot</b> ist aktiv mit deinem Account verknüpft.\n\n"
                        f"🛡️ <b>Was ich tue:</b>\n"
                        f"• Ich scanne eingehende E-Mails auf <code>info@thfc-consulting.de</code>.\n"
                        f"• Absagen werden sofort geblacklistet (Goldene Regel).\n"
                        f"• Recherche-Entwürfe landen zur 1-Klick-Freigabe direkt hier auf deinem iPhone!\n\n"
                        f"<b>Befehle:</b>\n"
                        f"• <code>/status</code> - Zeigt aktuelle Lead-Zahlen & Pipeline-Status\n"
                        f"• <code>/queue</code> - Offene Recherche-Entwürfe anzeigen & prüfen\n"
                        f"• <code>/help</code> - Hilfe & Befehlsübersicht"
                    )
                    self.send_message(welcome, chat_id=chat_id)
                elif clean_cmd in ("/status", "status"):
                    self._send_status_reply(chat_id)
                elif clean_cmd in ("/queue", "queue"):
                    self._send_queue_reply(chat_id)
                elif clean_cmd in ("/help", "help", "hilfe"):
                    help_text = (
                        f"🤖 <b>ProductSafetyEngine CRM Cockpit</b>\n\n"
                        f"<b>Verfügbare Befehle:</b>\n"
                        f"• <code>/status</code> - Aktueller Stand Leads, Entwürfe & Blacklist\n"
                        f"• <code>/queue</code> - Offene Recherche-Entwürfe mit Freigabe-Buttons\n"
                        f"• <code>/help</code> - Diese Hilfe anzeigen\n\n"
                        f"<i>Hinweis: Eingehende Lead-Mails erzeugen automatisch Push-Nachrichten mit Freigabe-Buttons.</i>"
                    )
                    self.send_message(help_text, chat_id=chat_id)
                else:
                    fallback_text = (
                        f"ℹ️ Unbekannter Befehl: <code>{raw_text}</code>\n\n"
                        f"Nutze <code>/status</code> für Kennzahlen oder <code>/queue</code> für offene Entwürfe."
                    )
                    self.send_message(fallback_text, chat_id=chat_id)
        except Exception as exc:
            logger.error(f"[TelegramBot] Fehler beim Verarbeiten des Updates: {exc}", exc_info=True)

    def _handle_approve_callback(self, cb_id: str, draft_id: str, chat_id: int, msg_id: int, current_text: str, user_name: str) -> None:
        """Gibt den Entwurf frei und versendet ihn via Resend."""
        from scripts.crm.review_queue import get_default_queue, DraftStatus
        from scripts.crm.dispatcher import get_default_dispatcher

        queue = get_default_queue()
        draft = queue.get_draft(draft_id)
        if not draft:
            self.answer_callback(cb_id, f"Fehler: Draft {draft_id} nicht gefunden!", show_alert=True)
            return

        # Freigeben
        queue.approve(draft_id, reviewed_by=f"Telegram ({user_name})")

        # Versenden via Dispatcher
        dispatcher = get_default_dispatcher()
        dispatch_res = dispatcher.dispatch_draft(draft_id)

        now_str = datetime.now(timezone.utc).strftime("%d.%m.%Y %H:%M UTC")
        if dispatch_res.get("success"):
            self.answer_callback(cb_id, "✅ Freigegeben & via Resend versendet!")
            updated_text = (
                f"{current_text}\n\n"
                f"✅ <b>STATUS: FREIGEGEBEN & VERSENDET</b>\n"
                f"📅 {now_str} via Resend (Message-ID: <code>{dispatch_res.get('message_id')}</code>)"
            )
        else:
            err = dispatch_res.get("error", "Unbekannter Fehler")
            self.answer_callback(cb_id, f"Freigegeben, aber Versand fehlgeschlagen: {err}", show_alert=True)
            updated_text = (
                f"{current_text}\n\n"
                f"⚠️ <b>FREIGEGEBEN, ABER VERSANDFEHLER:</b> {err}\n"
                f"📅 {now_str}"
            )

        self.edit_message_text(updated_text, chat_id=chat_id, message_id=msg_id, reply_markup=None)

    def _handle_reject_callback(self, cb_id: str, draft_id: str, chat_id: int, msg_id: int, current_text: str, user_name: str) -> None:
        """Lehnt einen Entwurf ab."""
        from scripts.crm.review_queue import get_default_queue
        queue = get_default_queue()
        queue.reject(draft_id, reason=f"Abgelehnt via Telegram durch {user_name}")
        self.answer_callback(cb_id, "❌ Entwurf abgelehnt.")

        now_str = datetime.now(timezone.utc).strftime("%d.%m.%Y %H:%M UTC")
        updated_text = (
            f"{current_text}\n\n"
            f"❌ <b>STATUS: ABGELEHNT</b> (Kein Versand)\n"
            f"📅 {now_str}"
        )
        self.edit_message_text(updated_text, chat_id=chat_id, message_id=msg_id, reply_markup=None)

    def _handle_view_callback(self, cb_id: str, draft_id: str, chat_id: int) -> None:
        """Sendet den vollstaendigen E-Mail-Text."""
        from scripts.crm.review_queue import get_default_queue
        draft = get_default_queue().get_draft(draft_id)
        if not draft:
            self.answer_callback(cb_id, "Draft nicht gefunden!", show_alert=True)
            return

        self.answer_callback(cb_id, "Vollstaendiger Text wird gesendet...")
        body = draft.get("body", "")
        # In Chunks aufteilen falls laenger als 4000 Zeichen
        chunk_size = 3500
        for i in range(0, len(body), chunk_size):
            chunk = body[i:i + chunk_size]
            self.send_message(f"<pre>{chunk}</pre>", chat_id=chat_id)

    def _send_status_reply(self, chat_id: int) -> None:
        """Sendet schnelle CRM-Zahlen als Antwort auf /status."""
        from scripts.crm.storage import get_default_storage
        from scripts.crm.review_queue import get_default_queue
        from scripts.crm.blacklist import get_default_manager

        leads = get_default_storage().list_leads()
        queue_stats = get_default_queue().count_by_status()
        bl_count = len(get_default_manager().list_entries())

        text = (
            f"📊 <b>ProductSafetyEngine CRM Status</b>\n\n"
            f"👥 <b>Gesamtanzahl Leads:</b> {len(leads)}\n"
            f"⏳ <b>Wartend auf Freigabe:</b> {queue_stats.get('PENDING_REVIEW', 0)}\n"
            f"✅ <b>Erfolgreich versendet:</b> {queue_stats.get('SENT', 0)}\n"
            f"❌ <b>Abgelehnt:</b> {queue_stats.get('REJECTED', 0)}\n"
            f"🛡️ <b>Opt-Out Blacklist:</b> {bl_count} Adressen"
        )
        res = self.send_message(text, chat_id=chat_id)
        logger.info(f"[TelegramBot] Status-Antwort an chat_id={chat_id} gesendet: {res.get('ok')}")

    def _send_queue_reply(self, chat_id: int) -> None:
        """Sendet Liste wartender Entwuerfe auf /queue."""
        from scripts.crm.review_queue import get_default_queue, DraftStatus
        pending = get_default_queue().list_drafts(status=DraftStatus.PENDING_REVIEW)
        if not pending:
            res = self.send_message("🎉 Die Review-Queue ist aktuell leer. Keine offenen Entwürfe!", chat_id=chat_id)
            logger.info(f"[TelegramBot] Queue-Antwort (leer) an chat_id={chat_id} gesendet: {res.get('ok')}")
            return

        for draft in pending[:5]:
            self.notify_new_draft(draft)
        logger.info(f"[TelegramBot] {len(pending[:5])} Entwuerfe an chat_id={chat_id} gesendet.")


# Modul-Singleton
_default_bot: Optional[TelegramCRMNotifier] = None


def get_default_bot() -> TelegramCRMNotifier:
    global _default_bot
    if _default_bot is None:
        _default_bot = TelegramCRMNotifier()
    return _default_bot
