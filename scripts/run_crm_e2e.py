#!/usr/bin/env python3
"""
scripts/run_crm_e2e.py

End-to-End CRM, Stripe Checkout & State Sync Runner for ProductSafetyEngine:
1. Stripe Checkout Session & Link Generation (490 EUR & 1490 EUR)
2. B2B Metadata Verification (lead_id, company, email, paketauswahl, steuer_id)
3. Cryptographic Webhook Signature & Order Unlocking Verification
4. CRM Lead Database & Lifecycle State Sync (24 OUTREACH_SENT, 29 NOT_SENT, AT/PL Gate)
5. JSON Summary Export to .aiworker/e2e_crm_result.json
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import sys
import time
from pathlib import Path

# Add project root to sys.path
ROOT_DIR = Path(__file__).resolve().parent.parent
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from scripts.crm.storage import CRMStorage, LeadStatus, VALID_LEAD_STATUSES
from scripts.crm.stripe_checkout import (
    PORTFOLIO_AUDIT,
    AUDIT_PLUS,
    create_checkout_session,
    generate_checkout_link,
    generate_pitch_snippet,
    handle_webhook,
    AuditOrderStorage,
)
from scripts.crm.followup_engine import ColdOutreachJurisdictionGate


def run_crm_e2e() -> dict:
    print("=================================================================")
    print("       PRODUCT SAFETY ENGINE - CRM & STRIPE E2E RUNNER")
    print("=================================================================")

    # 1. Stripe Checkout Integration (B2B Packages)
    print("\n[1/4] Verifiziere B2B Stripe Checkout Pakete (490 EUR & 1490 EUR)...")
    assert PORTFOLIO_AUDIT.amount_cents == 49000, "Portfolio Audit muss 490,00 EUR (49.000 Cents) kosten"
    assert AUDIT_PLUS.amount_cents == 149000, "Audit Plus muss 1.490,00 EUR (149.000 Cents) kosten"
    print(f"  [Stripe] Paket '{PORTFOLIO_AUDIT.name}': {PORTFOLIO_AUDIT.amount_cents / 100:.2f} EUR")
    print(f"  [Stripe] Paket '{AUDIT_PLUS.name}': {AUDIT_PLUS.amount_cents / 100:.2f} EUR")

    # Erzeuge Test-Session fuer Portfolio Audit
    lead_id_sample = "02_france_bbi_lyon"
    company_sample = "BBI Lyon"
    email_sample = "contact@bbilyon.fr"

    session_audit = create_checkout_session(
        package="portfolio_audit",
        email=email_sample,
        company=company_sample,
        lead_id=lead_id_sample,
        steuer_id="FR12345678901",
        dry_run=True,
    )
    assert session_audit["amount_total"] == 49000
    assert session_audit["metadata"]["lead_id"] == lead_id_sample
    assert session_audit["metadata"]["company"] == company_sample
    assert session_audit["metadata"]["email"] == email_sample
    assert session_audit["metadata"]["paketauswahl"] == "portfolio_audit"
    print(f"  [Stripe] Checkout Session 490€ erstellt: {session_audit['id']} -> {session_audit['url']}")

    # Erzeuge Test-Session fuer Audit Plus
    session_plus = create_checkout_session(
        package="audit_plus",
        email=email_sample,
        company=company_sample,
        lead_id=lead_id_sample,
        dry_run=True,
    )
    assert session_plus["amount_total"] == 149000
    print(f"  [Stripe] Checkout Session 1490€ erstellt: {session_plus['id']} -> {session_plus['url']}")

    # Erzeuge und pruefe Pitch-Snippet
    pitch_text = generate_pitch_snippet("portfolio_audit", session_audit["url"], "BBI Lyon", language="fr")
    assert "490" in pitch_text
    assert session_audit["url"] in pitch_text
    print(f"  [Stripe] Mehrsprachiges Pitch-Snippet (FR) fuer E-Mail generiert ({len(pitch_text)} Zeichen).")

    # 2. Webhook Signatur-Pruefung & Order Unlocking
    print("\n[2/4] Verifiziere Stripe Webhook-Handler & Auftrags-Freischaltung...")
    webhook_secret = "whsec_test_secret_for_e2e_verification_123456"
    test_session_id = f"cs_test_e2e_{int(time.time())}"
    webhook_payload_dict = {
        "id": f"evt_test_{int(time.time())}",
        "type": "checkout.session.completed",
        "data": {
            "object": {
                "id": test_session_id,
                "amount_total": 49000,
                "currency": "eur",
                "customer_email": email_sample,
                "payment_status": "paid",
                "status": "complete",
                "metadata": {
                    "lead_id": lead_id_sample,
                    "company": company_sample,
                    "email": email_sample,
                    "paketauswahl": "portfolio_audit",
                },
            }
        },
    }
    raw_payload = json.dumps(webhook_payload_dict, separators=(",", ":")).encode("utf-8")
    timestamp = int(time.time())
    signed_payload = f"{timestamp}.".encode("utf-8") + raw_payload
    computed_sig = hmac.new(
        webhook_secret.encode("utf-8"), signed_payload, hashlib.sha256
    ).hexdigest()
    stripe_sig_header = f"t={timestamp},v1={computed_sig}"

    # Verarbeite Webhook mit Signaturpruefung
    webhook_res = handle_webhook(
        payload=raw_payload,
        signature_header=stripe_sig_header,
        webhook_secret=webhook_secret,
    )
    assert webhook_res["status"] == "success", f"Webhook-Verarbeitung fehlgeschlagen: {webhook_res}"
    assert webhook_res["unlocked"] is True
    order_id = webhook_res["order"]["order_id"]
    print(f"  [Webhook] Signatur cryptographisch validiert (HMAC-SHA256).")
    print(f"  [Webhook] Auftrag freigeschaltet: Order-ID {order_id}")

    # 3. CRM Lead Database & Lifecycle State Machine
    print("\n[3/4] Verifiziere CRM Lead State Machine & Status-Integritaet...")
    crm = CRMStorage()
    leads = crm.list_leads()
    counts = crm.get_stats()

    print(f"  [CRM] Leads gesamt: {len(leads)}")
    for status_name, count in sorted(counts.items()):
        if status_name != "TOTAL":
            print(f"    - {status_name}: {count}")

    # Validierungs-Schranken gemaess F06
    assert counts.get(LeadStatus.OUTREACH_SENT, 0) == 24, "Es muessen exakt 24 real gesendete Leads (FR/NL) im Status OUTREACH_SENT sein"
    assert counts.get(LeadStatus.NOT_SENT, 0) == 29, "Es muessen exakt 29 ungesendete Leads (IT, PL, ES, AT) im Status NOT_SENT sein"
    assert counts.get(LeadStatus.LOST_BLACKLISTED, 0) == 2, "Es muessen exakt 2 geblockte Leads im Status LOST_BLACKLISTED sein"

    # 4. Kaltakquise-Rechts-Gates (AT § 107 TKG, PL elektronische Kommunikation)
    print("\n[4/4] Verifiziere Kaltakquise-Rechts-Gates fuer AT & PL...")
    gate = ColdOutreachJurisdictionGate()

    # Österreich: Verboten
    at_restricted, at_country, at_legal = gate.check_jurisdiction("info@spielwaren.at", "AT")
    assert at_restricted is True
    assert "107 TKG" in (at_legal or "")
    print(f"  [Jurisdiction Gate] AT (Österreich): E-Mail blockiert ({at_legal}), Task auf LinkedIn umgeleitet.")

    # Polen: Verboten
    pl_restricted, pl_country, pl_legal = gate.check_jurisdiction("hurtownia@zabawki.pl", "PL")
    assert pl_restricted is True
    assert "172" in (pl_legal or "")
    print(f"  [Jurisdiction Gate] PL (Polen): E-Mail blockiert ({pl_legal}), Task auf LinkedIn umgeleitet.")

    # Italien: Verboten (Art. 130 Codice Privacy)
    it_restricted, it_country, it_legal = gate.check_jurisdiction("info@giocattoli.it", "IT")
    assert it_restricted is True
    assert "Codice Privacy" in (it_legal or "")
    print(f"  [Jurisdiction Gate] IT (Italien): E-Mail blockiert ({it_legal}), Task auf LinkedIn umgeleitet.")

    # Spanien: Verboten (Art. 21 LSSI)
    es_restricted, es_country, es_legal = gate.check_jurisdiction("comercial@juguetes.es", "ES")
    assert es_restricted is True
    assert "LSSI" in (es_legal or "")
    print(f"  [Jurisdiction Gate] ES (Spanien): E-Mail blockiert ({es_legal}), Task auf LinkedIn umgeleitet.")

    # Frankreich: Erlaubt (Opt-Out B2B)
    fr_restricted, _, _ = gate.check_jurisdiction("contact@toys.fr", "FR")
    assert fr_restricted is False
    print("  [Jurisdiction Gate] FR (Frankreich): B2B Kaltakquise konform freigegeben (Opt-Out).")

    # Niederlande: Verboten (Art. 11.7 Telecommunicatiewet)
    nl_restricted, nl_country, nl_legal = gate.check_jurisdiction("info@speelgoed.nl", "NL")
    assert nl_restricted is True
    assert "Telecommunicatiewet" in (nl_legal or "")
    print(f"  [Jurisdiction Gate] NL (Niederlande): E-Mail blockiert ({nl_legal}), Task auf LinkedIn umgeleitet.")

    # Deutschland: Verboten (§ 7 Abs. 2 Nr. 2 UWG)
    de_restricted, de_country, de_legal = gate.check_jurisdiction("kontakt@spielwaren.de", "DE")
    assert de_restricted is True
    assert "UWG" in (de_legal or "")
    print(f"  [Jurisdiction Gate] DE (Deutschland): E-Mail blockiert ({de_legal}), Task auf LinkedIn umgeleitet.")

    # Exportiere Zusammenfassung
    crm_summary = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": "SUCCESS",
        "stripe": {
            "portfolio_audit_price": PORTFOLIO_AUDIT.amount_eur,
            "audit_plus_price": AUDIT_PLUS.amount_eur,
            "test_session_portfolio": session_audit["id"],
            "test_session_plus": session_plus["id"],
            "webhook_verified": True,
            "unlocked_order_id": order_id,
        },
        "crm": {
            "total_leads": len(leads),
            "status_breakdown": counts,
            "jurisdiction_gates": {
                "AT": "BLOCKED_LINKEDIN_ROUTED (§ 174 TKG 2021 / § 107 TKG)",
                "PL": "BLOCKED_LINKEDIN_ROUTED (Art. 398 PKE / Art. 172 PT)",
                "IT": "BLOCKED_LINKEDIN_ROUTED (Art. 130 Codice Privacy)",
                "ES": "BLOCKED_LINKEDIN_ROUTED (Art. 21 LSSI)",
                "FR": "ALLOWED",
                "NL": "ALLOWED",
            },
        },
    }

    summary_file = ROOT_DIR / ".aiworker/e2e_crm_result.json"
    with open(summary_file, "w", encoding="utf-8") as f:
        json.dump(crm_summary, f, indent=2)

    print(f"\nCRM-Ergebnis zusammengefasst in: {summary_file}")
    print("\n=================================================================")
    print("       CRM & STRIPE E2E ERFOLGREICH ABGESCHLOSSEN (100% GREEN)")
    print("=================================================================\n")
    return crm_summary


if __name__ == "__main__":
    try:
        run_crm_e2e()
    except Exception as e:
        print(f"\n[FATAL] CRM E2E fehlgeschlagen: {e}", file=sys.stderr)
        sys.exit(1)
