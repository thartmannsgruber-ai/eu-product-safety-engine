# ZIEL: Monorepo "ProductSafetyEngine" (Node 22, TypeScript strict, npm workspaces, vitest)
Phase-1-Kern einer hochperformanten B2B-Daten-API & MCP-Server fuer EU-Produktsicherheit (Safety Gate / RAPEX & ECHA SCIP).

## 1. ARCHITEKTUR & PACKAGES
- **packages/core**:
  - XML/JSON-Parser fuer offizielle Safety-Gate-Rohdaten (nutzt reale Fixture `fixtures/safety_gate_2026_45.xml`).
  - Normalisierung in ein typisiertes Zod-Schema (alert_number, case_number, publication_date, category, product, brand, model, ean_barcodes[], risk_type[], danger_description, measures, notifying_country, country_of_origin, risk_level).
  - Robuste GTIN/EAN-Pruefziffernvalidierung (EAN-8, EAN-13, UPC).
  - Storage-Interface mit In-Memory- und lokaler SQLite-Implementierung (`node:sqlite`).
- **packages/fetcher**:
  - HTTP-Client (nur fetch, kein Browser) mit Rate-Limiting, Exponential Backoff, ETag-Handling und robots.txt-Compliance-Pruefung.
  - In Tests ausschliesslich offline gemockt.
- **apps/actor**:
  - Apify-Actor-Struktur (.actor/actor.json, input_schema.json, dataset_schema.json).
  - Pay-Per-Event (PPE) Ereignisse als Typen/Konstanten definiert (`ean-checked`, `alert-returned`).
- **apps/mcp**:
  - MCP-Server (stdio, offizielles `@modelcontextprotocol/sdk`, Zod-Validierung).
  - Exakt 4 spezialisierte Tools:
    1. `check_ean_safety`: Validiert EANs gegen RAPEX-Datenbank. WICHTIG: Antwort bei 0 Treffern MUSS explizit enthalten: "Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN)."
    2. `search_product_recalls`: Semantische Suche nach Marke, Modell, Kategorie und Risiko.
    3. `get_chemical_restrictions`: Abfrage von REACH/SVHC-Gefahrenstoffen.
    4. `monitor_weekly_alerts`: Strukturierte Rueckgabe der juengsten Wochenmeldungen.
  - Security-Haertung: Input-Sanitizing gegen Prompt-Injection, Laengenbeschraenkung, XML-Entity-Schutz.
  - PaymentGate-Interface mit Noop-Implementierung (Vorbereitung fuer HTTP 402 / Stripe MPP).

## 2. REGELN FUER DIE UMSETZUNG
- **Strict Offline Tests**: Alle Tests laufen 100 % offline gegen `fixtures/` und Mocks. Kein Live-Netzwerk im Test.
- **Echte Test-Kommandos**: Jedes Feature MUSS ein echtes, ausfuehrbares Testkommando besitzen (z. B. `npm test -w packages/core` oder `npm run typecheck`). "true" oder leere Kommandos sind streng verboten.
- **Minimal Dependencies**: Schlanke Abhaengigkeiten (fast-xml-parser, zod, vitest, typescript).

## 3. DOKUMENTATION & METADATEN
- Am Ende muessen folgende Dateien vorliegen:
  - `README.md`: Gesamtarchitektur und Entwickler-Guide.
  - `STORE_DESCRIPTION.md`: Verkaufspsychologische Beschreibung fuer den Apify Store & MCP-Verzeichnisse (PulseMCP, Smithery).
  - `PRICING.md`: Pay-Per-Event Preismodell-Vorschlag.
  - `COMPLIANCE.md`: Rechtliche Leitplanken (Weiterverwendung EU-Beschluss 2011/833/EU, Haftungsausschluss, Quellenangaben).

VERBOTEN: Deployment, Veroeffentlichen, apify push, echte API-Keys, Live-Scraping, externe Cloud-Accounts.
