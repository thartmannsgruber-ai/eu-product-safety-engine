"""
scripts/crm/stripe_checkout.py
ProductSafetyEngine Stripe Checkout & B2B High-Ticket Audit Integration.

Unterstuetzt:
1. Erstellung von Checkout-Sessions fuer B2B High-Ticket Pakete:
   - Portfolio Audit: 490 EUR (49.000 Cents, bis zu 1.000 SKUs)
   - Audit Plus: 1.490 EUR (149.000 Cents, unbegrenzte SKUs + REACH/SVHC + 12 Wochen Monitoring)
2. B2B-Metadaten-Handling:
   - lead_id, company, email, paketauswahl, steuer_id
3. CLI-Kommando:
   - Schnelle Erzeugung von Zahlungslinks zur Einbindung in Outreach- und Followup-Mails
   - Flexible Ausgabeformate: link, text, markdown, json
4. Stripe Webhook-Handler:
   - Verifiziert Signaturen (HMAC-SHA256 / stripe.Webhook)
   - Schaltet Audit-Auftraege nach Zahlungseingang (checkout.session.completed) frei
   - Persistiert Auftraege in .crm/audit_orders.json und synchronisiert Lead-Status in CRMStorage
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

try:
    import stripe
except ImportError:
    stripe = None  # type: ignore

# Add project root to sys.path so scripts.crm can be imported when run directly
_ROOT_DIR = Path(__file__).resolve().parent.parent.parent
if str(_ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(_ROOT_DIR))

from scripts.crm.storage import CRMStorage, normalize_email


# ==============================================================================
# 1. B2B PAKET-DEFINITIONEN (Portfolio Audit & Audit Plus)
# ==============================================================================

@dataclass(frozen=True)
class PackageInfo:
    key: str
    name: str
    amount_eur: int
    amount_cents: int
    currency: str = "eur"
    sku_limit: Optional[int] = None
    description: str = ""


PORTFOLIO_AUDIT = PackageInfo(
    key="portfolio_audit",
    name="Portfolio Audit",
    amount_eur=490,
    amount_cents=49000,
    currency="eur",
    sku_limit=1000,
    description=(
        "Umfassender EU Safety Gate (RAPEX) Compliance-Check für bis zu 1.000 SKUs "
        "inkl. Prüfzertifikat & Risikoanalyse."
    ),
)

AUDIT_PLUS = PackageInfo(
    key="audit_plus",
    name="Audit Plus",
    amount_eur=1490,
    amount_cents=149000,
    currency="eur",
    sku_limit=None,
    description=(
        "Enterprise Portfolio Audit (unbegrenzte SKUs) inkl. REACH/SVHC-Tiefenanalyse, "
        "wöchentlichem 12-Wochen-Monitoring & Vorstands-Prüfbericht."
    ),
)

PACKAGES: Dict[str, PackageInfo] = {
    "portfolio_audit": PORTFOLIO_AUDIT,
    "audit_plus": AUDIT_PLUS,
}

# Alias-Mapping fuer CLI und Eingaben
PACKAGE_ALIASES: Dict[str, str] = {
    "portfolio_audit": "portfolio_audit",
    "portfolio-audit": "portfolio_audit",
    "portfolioaudit": "portfolio_audit",
    "audit": "portfolio_audit",
    "490": "portfolio_audit",
    "490eur": "portfolio_audit",
    "basic": "portfolio_audit",
    "standard": "portfolio_audit",
    "audit_plus": "audit_plus",
    "audit-plus": "audit_plus",
    "auditplus": "audit_plus",
    "plus": "audit_plus",
    "1490": "audit_plus",
    "1490eur": "audit_plus",
    "enterprise": "audit_plus",
}


def get_package(identifier: str) -> PackageInfo:
    """Loest einen Paket-Bezeichner oder Preis auf und gibt PackageInfo zurueck."""
    clean = str(identifier).strip().lower()
    canonical_key = PACKAGE_ALIASES.get(clean)
    if not canonical_key or canonical_key not in PACKAGES:
        valid_opts = list(PACKAGES.keys()) + ["490", "1490"]
        raise ValueError(
            f"Ungueltiges Paket '{identifier}'. Erlaubt sind: {valid_opts}"
        )
    return PACKAGES[canonical_key]


# ==============================================================================
# 2. B2B METADATEN-HANDLING
# ==============================================================================

@dataclass
class B2BMetadata:
    lead_id: str
    company: str
    email: str
    paketauswahl: str
    steuer_id: str = ""
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_stripe_metadata(self) -> Dict[str, str]:
        """Konvertiert Metadaten in das flache String-Format fuer Stripe."""
        meta: Dict[str, str] = {
            "lead_id": str(self.lead_id).strip(),
            "company": str(self.company).strip(),
            "email": normalize_email(self.email),
            "paketauswahl": str(self.paketauswahl).strip(),
            "steuer_id": str(self.steuer_id).strip(),
            "steuer-id": str(self.steuer_id).strip(),
        }
        for k, v in self.extra.items():
            if k not in meta and v is not None:
                meta[str(k)] = str(v)[:500]
        return meta

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> B2BMetadata:
        """Erstellt B2BMetadata aus einem Dict (z. B. aus Stripe Session Metadaten)."""
        lead_id = str(data.get("lead_id") or "").strip()
        company = str(data.get("company") or "").strip()
        email = normalize_email(data.get("email") or "")
        paketauswahl = str(data.get("paketauswahl") or data.get("package") or "").strip()
        steuer_id = str(data.get("steuer_id") or data.get("steuer-id") or data.get("tax_id") or data.get("vat_id") or "").strip()

        extra = {
            k: v for k, v in data.items()
            if k not in {"lead_id", "company", "email", "paketauswahl", "steuer_id", "tax_id", "vat_id", "package"}
        }
        return cls(
            lead_id=lead_id,
            company=company,
            email=email,
            paketauswahl=paketauswahl,
            steuer_id=steuer_id,
            extra=extra,
        )


def build_b2b_metadata(
    lead_id: str,
    company: str,
    email: str,
    paketauswahl: str,
    steuer_id: str = "",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Erzeugt ein Stripe-kompatibles B2B-Metadaten-Dictionary."""
    pkg = get_package(paketauswahl)
    b2b = B2BMetadata(
        lead_id=lead_id or normalize_email(email),
        company=company,
        email=email,
        paketauswahl=pkg.key,
        steuer_id=steuer_id,
        extra=extra or {},
    )
    return b2b.to_stripe_metadata()


# ==============================================================================
# 3. STRIPE CHECKOUT-SESSION & LINK-GENERATOR
# ==============================================================================

DEFAULT_SUCCESS_URL = "https://productsafetyengine.com/checkout/success?session_id={CHECKOUT_SESSION_ID}"
DEFAULT_CANCEL_URL = "https://productsafetyengine.com/checkout/cancel?session_id={CHECKOUT_SESSION_ID}"


class StripeSignatureVerificationError(Exception):
    """Wird geworfen, wenn die Webhook-Signatur von Stripe ungueltig ist."""
    pass


def create_checkout_session(
    package: Union[str, PackageInfo],
    email: str,
    company: str,
    lead_id: Optional[str] = None,
    steuer_id: str = "",
    success_url: Optional[str] = None,
    cancel_url: Optional[str] = None,
    api_key: Optional[str] = None,
    dry_run: bool = False,
    extra_metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Erstellt eine Stripe Checkout-Session fuer B2B High-Ticket Pakete:
    - Portfolio Audit (490 EUR)
    - Audit Plus (1490 EUR)

    Uebergibt erforderliche B2B-Metadaten (lead_id, company, email, paketauswahl, steuer_id).
    """
    pkg = package if isinstance(package, PackageInfo) else get_package(package)
    norm_email = normalize_email(email)
    effective_lead_id = str(lead_id).strip() if lead_id else norm_email
    comp_clean = str(company).strip() or "B2B Kunde"

    metadata = build_b2b_metadata(
        lead_id=effective_lead_id,
        company=comp_clean,
        email=norm_email,
        paketauswahl=pkg.key,
        steuer_id=steuer_id,
        extra=extra_metadata,
    )

    succ_url = success_url or os.getenv("STRIPE_SUCCESS_URL") or DEFAULT_SUCCESS_URL
    canc_url = cancel_url or os.getenv("STRIPE_CANCEL_URL") or DEFAULT_CANCEL_URL

    active_api_key = api_key or os.getenv("STRIPE_SECRET_KEY")

    # Dry-Run Modus oder Fallback wenn kein API-Key konfiguriert ist
    if dry_run or not active_api_key or active_api_key.startswith("mock_") or active_api_key.startswith("dummy_"):
        session_id = f"cs_test_{uuid.uuid4().hex[:24]}"
        mock_url = f"https://checkout.stripe.com/c/pay/{session_id}"
        return {
            "id": session_id,
            "object": "checkout.session",
            "url": mock_url,
            "payment_link": mock_url,
            "amount_total": pkg.amount_cents,
            "currency": pkg.currency,
            "customer_email": norm_email,
            "package_key": pkg.key,
            "package_name": pkg.name,
            "metadata": metadata,
            "payment_status": "unpaid",
            "status": "open",
            "is_dry_run": True,
        }

    # Echter Stripe API Call
    if stripe is None:
        raise RuntimeError("Das Python-Paket 'stripe' ist nicht verfuegbar. Bitte 'pip install stripe' ausfuehren.")

    stripe.api_key = active_api_key

    session_params: Dict[str, Any] = {
        "payment_method_types": ["card"],
        "mode": "payment",
        "customer_email": norm_email if norm_email else None,
        "line_items": [
            {
                "price_data": {
                    "currency": pkg.currency,
                    "unit_amount": pkg.amount_cents,
                    "product_data": {
                        "name": f"ProductSafetyEngine — {pkg.name}",
                        "description": pkg.description,
                        "metadata": {
                            "package_key": pkg.key,
                            "sku_limit": str(pkg.sku_limit) if pkg.sku_limit else "unlimited",
                        },
                    },
                },
                "quantity": 1,
            }
        ],
        "metadata": metadata,
        "success_url": succ_url,
        "cancel_url": canc_url,
        "billing_address_collection": "required",
        "tax_id_collection": {"enabled": True},
    }

    # None-Werte entfernen
    clean_params = {k: v for k, v in session_params.items() if v is not None}
    session = stripe.checkout.Session.create(**clean_params)

    return {
        "id": session.id,
        "object": getattr(session, "object", "checkout.session"),
        "url": getattr(session, "url", ""),
        "payment_link": getattr(session, "url", ""),
        "amount_total": getattr(session, "amount_total", pkg.amount_cents),
        "currency": getattr(session, "currency", pkg.currency),
        "customer_email": getattr(session, "customer_email", norm_email),
        "package_key": pkg.key,
        "package_name": pkg.name,
        "metadata": dict(getattr(session, "metadata", metadata)),
        "payment_status": getattr(session, "payment_status", "unpaid"),
        "status": getattr(session, "status", "open"),
        "is_dry_run": False,
    }


def generate_checkout_link(
    package: Union[str, PackageInfo],
    email: str,
    company: str,
    lead_id: Optional[str] = None,
    steuer_id: str = "",
    api_key: Optional[str] = None,
    dry_run: bool = False,
    **kwargs: Any,
) -> str:
    """Erzeugt direkt den Zahlungslink fuer das gewaehlte Paket."""
    res = create_checkout_session(
        package=package,
        email=email,
        company=company,
        lead_id=lead_id,
        steuer_id=steuer_id,
        api_key=api_key,
        dry_run=dry_run,
        extra_metadata=kwargs,
    )
    return res.get("url") or res.get("payment_link") or ""


def generate_pitch_snippet(
    package: Union[str, PackageInfo],
    checkout_url: str,
    company: str,
    language: str = "de",
) -> str:
    """
    Erzeugt einen vorgefertigten Textbaustein zur nahtlosen Einbindung
    des Zahlungslinks in Outreach- und Followup-Mails.
    """
    pkg = package if isinstance(package, PackageInfo) else get_package(package)
    lang = language.lower()

    if lang == "de":
        if pkg.key == "portfolio_audit":
            return (
                f"Zur direkten Freischaltung Ihres Portfolio-Audits (490 € zzgl. USt. "
                f"für bis zu 1.000 SKUs inkl. Vollprüfung gegen das EU Safety Gate & Prüfbericht) "
                f"können Sie den gesicherten B2B-Auftrag hier abschließen:\n"
                f"👉 {checkout_url}"
            )
        else:
            return (
                f"Zur direkten Freischaltung des Enterprise Audit Plus (1.490 € zzgl. USt. "
                f"für Ihr gesamtes Sortiment inkl. REACH/SVHC-Tiefenanalyse & 12 Wochen Monitoring) "
                f"können Sie den gesicherten B2B-Auftrag hier abschließen:\n"
                f"👉 {checkout_url}"
            )
    elif lang == "fr":
        return (
            f"Pour activer immédiatement votre audit ({pkg.name} — {pkg.amount_eur} € HT) "
            f"via notre paiement sécurisé Stripe B2B, veuillez utiliser ce lien direct :\n"
            f"👉 {checkout_url}"
        )
    elif lang == "nl":
        return (
            f"Om uw audit ({pkg.name} — {pkg.amount_eur} € excl. btw) direct te activeren "
            f"via onze beveiligde Stripe B2B-checkout, kunt u de volgende link gebruiken:\n"
            f"👉 {checkout_url}"
        )
    else:
        # Englisch (Default)
        return (
            f"To immediately initiate your {pkg.name} ({pkg.amount_eur} EUR excl. VAT) "
            f"via our secure Stripe B2B checkout, please use the following link:\n"
            f"👉 {checkout_url}"
        )


# ==============================================================================
# 4. WEBHOOK-HANDLER & FREISCHALTUNG VON AUDIT-AUFTRAEGEN
# ==============================================================================

def verify_webhook_signature(
    payload: Union[bytes, str],
    signature_header: str,
    secret: Optional[str] = None,
    tolerance: int = 300,
) -> bool:
    """
    Verifiziert die Stripe-Webhook-Signatur nach dem offiziellen Stripe-Protokoll:
    Header-Format: t=timestamp,v1=signature[,v0=...]
    Signatur: HMAC-SHA256(secret, "{timestamp}.{payload}")
    """
    webhook_secret = secret or os.getenv("STRIPE_WEBHOOK_SECRET")
    if not webhook_secret:
        raise StripeSignatureVerificationError("Kein Stripe Webhook Secret konfiguriert (STRIPE_WEBHOOK_SECRET).")

    if not signature_header:
        raise StripeSignatureVerificationError("Fehlender Stripe-Signature Header.")

    # 1. Header zerlegen
    items = signature_header.split(",")
    timestamp = -1
    v1_signatures: List[str] = []

    for item in items:
        parts = item.strip().split("=", 1)
        if len(parts) == 2:
            key, val = parts[0].strip(), parts[1].strip()
            if key == "t":
                try:
                    timestamp = int(val)
                except ValueError:
                    raise StripeSignatureVerificationError("Ungueltiger Timestamp im Signature Header.")
            elif key == "v1":
                v1_signatures.append(val)

    if timestamp <= 0:
        raise StripeSignatureVerificationError("Timestamp 't' fehlt im Signature Header.")

    if not v1_signatures:
        raise StripeSignatureVerificationError("Signatur 'v1' fehlt im Signature Header.")

    # 2. Replay-Protection (Toleranzpruefung, standardmaessig 300s)
    if tolerance > 0:
        now = int(time.time())
        if abs(now - timestamp) > tolerance:
            raise StripeSignatureVerificationError(
                f"Timestamp ausserhalb der Toleranz ({abs(now - timestamp)}s > {tolerance}s)."
            )

    # 3. Payload als Bytes/String vereinheitlichen
    payload_bytes = payload if isinstance(payload, bytes) else payload.encode("utf-8")
    signed_payload = f"{timestamp}.".encode("utf-8") + payload_bytes

    expected_signature = hmac.new(
        webhook_secret.encode("utf-8"),
        signed_payload,
        hashlib.sha256,
    ).hexdigest()

    # 4. Constant-Time Signaturvergleich
    match = any(hmac.compare_digest(expected_signature, sig) for sig in v1_signatures)
    if not match:
        raise StripeSignatureVerificationError("Signatur-Abgleich fehlgeschlagen.")

    return True


class AuditOrderStorage:
    """Verwaltet und persistiert freigeschaltete Audit-Auftraege atomar in .crm/audit_orders.json."""

    def __init__(self, filepath: Optional[Union[str, Path]] = None) -> None:
        base_dir = Path(__file__).resolve().parent.parent.parent
        if filepath:
            self.filepath = Path(filepath)
        else:
            self.filepath = base_dir / ".crm" / "audit_orders.json"

        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        self._orders: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> Dict[str, Dict[str, Any]]:
        if not self.filepath.exists():
            self._orders = {}
            return self._orders
        try:
            with open(self.filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, dict):
                    self._orders = data
                elif isinstance(data, list):
                    self._orders = {o.get("order_id") or o.get("session_id"): o for o in data if isinstance(o, dict)}
        except Exception:
            self._orders = {}
        return self._orders

    def save(self) -> None:
        self.filepath.parent.mkdir(parents=True, exist_ok=True)
        lock_path = self.filepath.with_suffix(".lock")
        with open(lock_path, "w") as lock_fd:
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            try:
                temp_path = self.filepath.with_suffix(f".tmp.{os.getpid()}.{uuid.uuid4().hex[:8]}")
                with open(temp_path, "w", encoding="utf-8") as f:
                    json.dump(self._orders, f, indent=2, ensure_ascii=False)
                    f.flush()
                    os.fsync(f.fileno())
                temp_path.replace(self.filepath)
            finally:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)

    def record_order(self, order: Dict[str, Any]) -> Dict[str, Any]:
        order_id = order.get("order_id") or f"ord_{uuid.uuid4().hex[:12]}"
        order["order_id"] = order_id
        self._orders[order_id] = order
        self.save()
        return order

    def get_order(self, identifier: str) -> Optional[Dict[str, Any]]:
        if identifier in self._orders:
            return self._orders[identifier]
        for ord_data in self._orders.values():
            if ord_data.get("session_id") == identifier or ord_data.get("order_id") == identifier:
                return ord_data
        return None

    def list_orders(self) -> List[Dict[str, Any]]:
        return list(self._orders.values())


def unlock_audit_order(
    session_data: Dict[str, Any],
    crm_storage: Optional[CRMStorage] = None,
    orders_storage: Optional[AuditOrderStorage] = None,
) -> Dict[str, Any]:
    """
    Schaltet einen Audit-Auftrag nach erfolgreichem Stripe-Zahlungseingang frei:
    1. Erstellt strukturierten Audit-Auftrag mit Status UNLOCKED
    2. Speichert ihn in .crm/audit_orders.json
    3. Traegt Audit-Freischaltung in die History des CRM-Leads ein
    """
    raw_meta = session_data.get("metadata") or {}
    meta = B2BMetadata.from_dict(raw_meta)

    # Paket validieren
    try:
        pkg = get_package(meta.paketauswahl)
    except Exception:
        # Fallback falls Betrag Aufschluss gibt
        amt = session_data.get("amount_total", 0)
        pkg = AUDIT_PLUS if amt >= 100000 else PORTFOLIO_AUDIT

    now_iso = datetime.now(timezone.utc).isoformat()
    session_id = session_data.get("id", "")
    order_id = f"ord_{uuid.uuid4().hex[:12]}"

    order_record = {
        "order_id": order_id,
        "session_id": session_id,
        "payment_intent": session_data.get("payment_intent", ""),
        "lead_id": meta.lead_id or normalize_email(meta.email),
        "company": meta.company,
        "email": meta.email,
        "paketauswahl": pkg.key,
        "package_name": pkg.name,
        "amount_eur": pkg.amount_eur,
        "amount_cents": session_data.get("amount_total") or pkg.amount_cents,
        "currency": session_data.get("currency", "eur").lower(),
        "steuer_id": meta.steuer_id,
        "status": "UNLOCKED",
        "unlocked_at": now_iso,
        "metadata": meta.to_stripe_metadata(),
    }

    # 1. In audit_orders.json persistieren
    store = orders_storage or AuditOrderStorage()
    saved_order = store.record_order(order_record)

    # 2. In CRMStorage (leads_db.json) Lead aktualisieren
    try:
        crm = crm_storage or CRMStorage()
        lead = crm.get_lead(meta.email)
        if lead:
            history = lead.setdefault("history", [])
            history.append({
                "action": "AUDIT_ORDER_UNLOCKED",
                "timestamp": now_iso,
                "order_id": order_id,
                "session_id": session_id,
                "paketauswahl": pkg.key,
                "package_name": pkg.name,
                "amount_eur": pkg.amount_eur,
                "steuer_id": meta.steuer_id,
            })
            lead["audit_status"] = "UNLOCKED"
            lead["audit_package"] = pkg.key
            lead["audit_order_id"] = order_id
            lead["updated_at"] = now_iso
            crm.save()
    except Exception as e:
        print(f"[WARN] CRMStorage Update fuer Lead {meta.email} fehlgeschlagen: {e}")

    return saved_order


def handle_webhook(
    payload: Union[bytes, str],
    signature_header: str,
    webhook_secret: Optional[str] = None,
    crm_storage: Optional[CRMStorage] = None,
    orders_storage: Optional[AuditOrderStorage] = None,
    skip_signature_verification: bool = False,
) -> Dict[str, Any]:
    """
    Verarbeitet einen eingehenden Stripe-Webhook:
    1. Verifiziert die Signatur
    2. Behandelt 'checkout.session.completed'
    3. Schaltet den Audit-Auftrag frei
    """
    if not skip_signature_verification:
        verify_webhook_signature(
            payload=payload,
            signature_header=signature_header,
            secret=webhook_secret,
        )

    # Payload parsen
    payload_str = payload.decode("utf-8") if isinstance(payload, bytes) else payload
    try:
        event = json.loads(payload_str)
    except Exception as e:
        raise ValueError(f"Ungueltiges JSON im Webhook-Payload: {e}")

    event_type = event.get("type", "")
    event_id = event.get("id", "")

    if event_type == "checkout.session.completed":
        session_obj = event.get("data", {}).get("object", {})
        order = unlock_audit_order(
            session_data=session_obj,
            crm_storage=crm_storage,
            orders_storage=orders_storage,
        )
        return {
            "status": "success",
            "event_type": event_type,
            "event_id": event_id,
            "unlocked": True,
            "order": order,
        }

    return {
        "status": "ignored",
        "event_type": event_type,
        "event_id": event_id,
        "unlocked": False,
        "message": f"Event-Typ '{event_type}' erfordert keine Freischaltung.",
    }


# ==============================================================================
# 5. CLI-KOMMANDO (Zahlungslinks fuer Outreach & Follow-up generieren)
# ==============================================================================

def build_cli_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="ProductSafetyEngine Stripe Checkout & Payment-Link Generator fuer B2B High-Ticket Audits."
    )
    parser.add_argument(
        "--package", "-p",
        required=True,
        help="Paketauswahl: 'portfolio_audit' (490 EUR) oder 'audit_plus' (1490 EUR) [Aliases: 490, 1490, audit, plus]",
    )
    parser.add_argument(
        "--email", "-e",
        required=True,
        help="E-Mail-Adresse des Zielunternehmens / Leads.",
    )
    parser.add_argument(
        "--company", "-c",
        default="",
        help="Unternehmensname (z. B. 'ABC Spielwaren GmbH'). Falls leer, wird Domain verwendet.",
    )
    parser.add_argument(
        "--lead-id", "-l",
        default="",
        help="Optionale Lead-ID aus dem CRM (Standard: E-Mail).",
    )
    parser.add_argument(
        "--steuer-id", "-t",
        default="",
        help="USt-IdNr. / Steuer-ID des B2B-Kunden (z. B. 'DE123456789').",
    )
    parser.add_argument(
        "--format", "-f",
        choices=["link", "text", "markdown", "json"],
        default="link",
        help="Ausgabeformat: 'link' (nur URL), 'text' (Mail-Snippet), 'markdown' (Markdown-Pitch), 'json' (vollstaendige Session).",
    )
    parser.add_argument(
        "--lang",
        choices=["de", "en", "fr", "nl"],
        default="de",
        help="Sprache fuer das Text-/Markdown-Snippet (Standard: 'de').",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Erzeugt einen Test-/Mock-Link ohne echten Stripe-API-Aufruf.",
    )
    return parser


def main() -> None:
    parser = build_cli_parser()
    args = parser.parse_args()

    try:
        pkg = get_package(args.package)
    except ValueError as e:
        print(f"[FEHLER] {e}", file=sys.stderr)
        sys.exit(1)

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
        sys.exit(1)

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


if __name__ == "__main__":
    main()
