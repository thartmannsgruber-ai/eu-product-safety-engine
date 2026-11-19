# Lead-Analyse & Go-to-Market-Strategie: EU Product Safety Engine

## 1. Executive Summary: 56 Spielwaren-Leads aus Apify
- **Zielgruppe:** Europäische B2B-Großhändler (*Grossiste / Mayorista / Groothandelaar / Hurtownia*), Distributoren und Hersteller der Spielwaren- und Festartikelbranche.
- **Geografische Abdeckung (6 EU-Kernländer):**
  - **Niederlande (16 Leads):** Starker E-Commerce- und Importhafen-Fokus (Rotterdam/Amsterdam, Bol.com Ökosystem).
  - **Frankreich (10 Leads):** Hohe Behördendichte (DGCCRF), strikte Durchsetzung der EN 71 & GPSR.
  - **Italien (10 Leads):** Traditionelle Spielwaren-Großhändler mit hoher Reputationssensitivität.
  - **Spanien (10 Leads):** Stark regulierter Markt für Importwaren aus Drittstaaten.
  - **Polen (7 Leads):** Zentraler osteuropäischer Umschlagplatz (*Hurtownie Zabawek*).
  - **Österreich (3 Leads):** Qualitätsorientierte Großhändler & Holzspielzeug-Manufakturen.
- **Datenqualität:** 53 von 56 Leads besitzen eine verifizierte B2B-E-Mail (94,6 %), 36 mit Telefon und Website.

---

## 2. Der Kern-Schmerzpunkt (Pain Point): GPSR & EN 71
1. **GPSR-Haftungsfalle (VO EU 2023/988):** Seit Dezember 2024 haften Großhändler und Importeure direkt für Produktsicherheitsmängel, wenn Hersteller außerhalb der EU sitzen oder Daten unvollständig sind.
2. **Marktplatz-Sperren bei Händlerkunden:** Beliefern Großhändler Händler, deren Produkte auf Amazon, eBay, Kaufland oder Bol.com wegen Safety Gate (RAPEX)-Meldungen gesperrt werden, drohen Regressansprüche und Kundenverlust.
3. **Chemische Risiken (REACH & Spielzeugrichtlinie):** Spielwaren sind die #1 Kategorie in EU Safety Gate Warnungen (Phthalate, Weichmacher, Bor in Slime, Blei/Cadmium, lösliche Kleinteile).

---

## 3. Strategische Optionen: Wie bringen wir die Engine via Apify zum Kunden?

### Option 1: Direct Value-Hook ("Der kostenlose GPSR-Katalog-Audit") [EMPFOHLEN]
- **Mechanik:** Großhändler verstehen selten rohe APIs oder Apify-Code. Sie verstehen aber: *"Wir haben Ihr Sortiment gegen die aktuellen 2025/2026 EU Safety Gate Warnungen gescreent."*
- **Ablauf:**
  1. Outreach-E-Mail an die 53 B2B-Kontakte mit konkretem Aufhänger: *"Kostenloser 100-EAN-Check für Ihr Weihnachts-/Frühjahrssortiment auf EU-Konformität"*.
  2. Als Ziel-Link: Ein vorbereiteter Apify Actor Task mit einfacher Eingabemaske (Upload CSV oder EAN-Liste) oder direktem Report-Service.
  3. Konvertierung in Pay-Per-Event (PPE) oder Monats-Abo zur laufenden Wöchentlichen Überwachung.

### Option 2: Apify Store Integration als "No-Code Compliance Agent"
- **Mechanik:** Positionierung unseres Apify-Actors nicht nur für Coder, sondern als "CSV-in, Safety-Report-out" Tool im Apify Store.
- **Ablauf:** Der Großhändler lädt einmal pro Woche seine Lagerbestands-CSV hoch; der Actor liefert ein bereinigtes PDF/Excel-Zertifikat für Marktplätze (Amazon GPSR Compliance Proof).

### Option 3: Whitelabel / Partner-Modell für E-Commerce-Agenturen
- **Mechanik:** Ansprache der Dienstleister und Softwarehäuser, die diese Großhändler an Marktplätze anbinden (z. B. Channable, ChannelEngine, Plentymarkets).

---

## 4. Konkreter 3-Schritte-Fahrplan

| Phase | Maßnahme | Zeithorizont |
| :--- | :--- | :--- |
| **Phase 1: Actor Input-Schema Readiness** | Bereitstellung einer simplen EAN-Listen-Eingabe im Apify Actor (`apps/actor`), sodass Nicht-Entwickler sofort CSVs einfügen können. | Sofort |
| **Phase 2: Outreach-Templates (FR, IT, ES, NL, PL, DE)** | Vorbereitung nativer, personalisierter B2B-Cold-E-Mails mit Verweis auf den GPSR-Audit-Link. | Tag 1–2 |
| **Phase 3: Kampagnen-Pilot (Niederlande & Frankreich)** | Versand an die ersten 26 Leads (NL & FR) mit Tracking der Klickrate auf den Apify Actor. | Tag 3–5 |
