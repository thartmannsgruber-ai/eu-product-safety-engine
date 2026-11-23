# ProductSafetyEngine

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/Tests-Vitest%20100%25%20Offline-brightgreen.svg)](https://vitest.dev/)
[![Glama MCP server](https://glama.ai/mcp/servers/thartmannsgruber-ai/eu-product-safety-engine/badges/score.svg)](https://glama.ai/mcp/servers/thartmannsgruber-ai/eu-product-safety-engine)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> **High-Performance B2B Data Engine & Model Context Protocol (MCP) Server für EU-Produktsicherheits- und Rückrufdaten (Safety Gate / RAPEX & REACH Chemical Recall Screening).**

---

## Inhaltsverzeichnis

1. [Überblick & Kontext](#überblick--kontext)
2. [Gesamtarchitektur](#gesamtarchitektur)
3. [Package- & Workspace-Übersicht](#package--workspace-übersicht)
4. [Kernfunktionen](#kernfunktionen)
5. [Schnellstart & Lokales Setup](#schnellstart--lokales-setup)
6. [MCP Server Konfiguration](#mcp-server-konfiguration)
7. [Apify Actor & Pay-Per-Event (PPE)](#apify-actor--pay-per-event-ppe)
   - [Check Amazon ASINs & product URLs](#check-amazon-asins--product-urls)
   - [Bulk CSV screening (up to 10,000 SKUs)](#bulk-csv-screening-up-to-10000-skus)
   - [Webhook alerts (Slack, Discord, Make, Zapier, ERP)](#webhook-alerts-slack-discord-make-zapier-erp)
8. [Testing & Qualitätssicherung](#testing--qualitätssicherung)
9. [Compliance & Rechtliches](#compliance--rechtliches)

---

## Überblick & Kontext

Mit Inkrafttreten der europäischen Verordnung über die allgemeine Produktsicherheit (**GPSR – EU 2023/988**) und der Marktüberwachungsverordnung (**EU 2019/1020**) stehen Online-Händler, Importeure, Marktplätze und Fulfilment-Dienstleister unter strikter Sorgfaltspflicht: Produkte mit bekannten Sicherheitsmängeln, Produktrückrufen oder verbotenen chemischen Inhaltsstoffen (REACH/SVHC) dürfen im EU-Binnenmarkt weder vertrieben noch gelagert werden.

**ProductSafetyEngine** schließt die Brücke zwischen behördlichen Rohdaten-Veröffentlichungen der Europäischen Kommission und modernen B2B-Systemen sowie autonomen KI-Agenten:
- **Automatisiertes Ingestion-System:** Parst, bereinigt und normalisiert offizielle Safety-Gate-Meldungen (RAPEX).
- **Strikte GTIN/EAN-Validierung:** Prüft EAN-8, EAN-13, UPC-A und UPC-E mittels Modulo-10-Algorithmus.
- **Hybride Storage-Architektur:** Schnelle In-Memory-Verarbeitung oder persistente Speicherung via `node:sqlite`.
- **Model Context Protocol (MCP):** 5 spezialisierte Agenten-Tools mit integriertem Prompt-Injection-Schutz und HTTP 402 Vorbereitung (Stripe Machine Payments Protocol).
- **Apify Actor Integration:** Cloud-native Bereitstellung mit granularem Pay-Per-Event (PPE) Abrechnungsmodell.

---

## Gesamtarchitektur

```
                          ┌────────────────────────────────────────┐
                          │  EU Safety Gate (RAPEX) / REACH Data   │
                          │        (Official XML / JSON)           │
                          └───────────────────┬────────────────────┘
                                              │
                                              ▼
                                 ┌─────────────────────────┐
                                 │    packages/fetcher     │
                                 │  • Rate-Limiter (1 r/s) │
                                 │  • ETag / Caching       │
                                 │  • robots.txt TDM Guard │
                                 └────────────┬────────────┘
                                              │
                                              ▼
                                 ┌─────────────────────────┐
                                 │      packages/core      │
                                 │  • Fast XML Parser      │
                                 │  • Zod AlertRecordSchema│
                                 │  • Modulo-10 GTIN Check │
                                 │  • SQLite & Memory DB   │
                                 └──────┬───────────┬──────┘
                                        │           │
                     ┌──────────────────┴───┐   ┌───┴──────────────────┐
                     ▼                      │   │                      ▼
         ┌───────────────────────┐          │   │          ┌───────────────────────┐
         │      apps/actor       │          │   │          │       apps/mcp        │
         │  • Apify Actor CLI    │          │   │          │  • Stdio MCP Protocol │
         │  • Input/Dataset Zod  │          │   │          │  • Prompt-Sanitizer   │
         │  • Pay-Per-Event (PPE)│          │   │          │  • 5 Specialized Tools│
         │    Accounting Engine  │          │   │          │  • HTTP 402 Gate (MPP)│
         └───────────────────────┘          │   │          └───────────────────────┘
                     │                      │   │                      │
                     ▼                      │   │                      ▼
         ┌───────────────────────┐          │   │          ┌───────────────────────┐
         │      Apify Store      │          │   │          │ Claude / Cursor /     │
         │    REST / Webhooks    │          │   │          │ AI Agent Workflows    │
         └───────────────────────┘          │   │          └───────────────────────┘
```

---

## Package- & Workspace-Übersicht

Das Projekt ist als **npm Workspace-Monorepo** organisiert:

| Pfad | Typ | Name | Zweck |
|:---|:---|:---|:---|
| `packages/core` | Bibliothek | `@productsafetyengine/core` | Parsen von Safety-Gate XML, Zod-Schemas, EAN-Validierung, Speicher-Engines (`node:sqlite`, Memory). |
| `packages/fetcher` | Bibliothek | `@productsafetyengine/fetcher` | HTTP-Client mit Rate-Limiting, Exponential Backoff, ETag-Handling und robots.txt TDM-Prüfung. |
| `apps/actor` | Anwendung | `@productsafetyengine/actor` | Apify Actor für Batch-Überprüfungen im Apify Store mit Pay-Per-Event (PPE) Abrechnung. |
| `apps/mcp` | Anwendung | `@productsafetyengine/mcp` | Offizieller MCP-Server (stdio) für LLM-Agenten (Claude, Cursor, Antigravity) mit Security-Sanitizer. |

---

## Kernfunktionen

### 1. packages/core
- **XML-Parsing:** Robuste Extraktion von Attributen, CDATA-Blöcken und Namespaces aus offiziellen RAPEX-Dateien.
- **Typisiertes Zod-Schema (`AlertRecordSchema`):**
  - `alert_number`, `case_number`, `publication_date`, `category`, `product`, `brand`, `model`
  - `ean_barcodes`: Bereinigte Liste von EANs ohne Steuerzeichen und Trennstriche
  - `risk_type`, `danger_description`, `measures`, `notifying_country`, `country_of_origin`, `risk_level`
- **GTIN/EAN-Validierung (`isValidEan`):** Exakte Modulo-10-Prüfziffernberechnung für EAN-8, EAN-13, UPC-A und UPC-E.
- **Storage-Interface (`IAlertStorage`):**
  - `MemoryAlertStorage`: In-Memory-Map für höchste Durchsatzraten und Tests.
  - `SqliteAlertStorage`: Persistente Speicherung auf Basis von Node 22 nativem `node:sqlite`.

### 2. packages/fetcher
- **Gentle Crawling:** Fest verdrahtetes Rate-Limiting (max. 1 Request pro Sekunde).
- **Bandbreitenschonend:** ETag- und `If-None-Match`-Unterstützung (304 Not Modified).
- **Legal Compliance:** Automatischer Vorab-Check auf `robots.txt`-Ausschlüsse und TDM-Vorbehalte gemäß § 44b UrhG.

### 3. apps/actor
- **Apify Actor Spezifikation:** Vollständige Konfiguration via `.actor/actor.json`, `.actor/input_schema.json` und `dataset_schema.json`.
- **Pay-Per-Event Engine (`ppe.ts`):** Präzise Erfassung und Abrechnung pro Ereignis (`ean-checked`, `alert-returned`, `query-executed`, `weekly-monitored`).

### 4. apps/mcp
- **Offizieller MCP Stdio Transport:** Basiert auf `@modelcontextprotocol/sdk`.
- **Sicherheits-Sanitizer:** Filtert Prompt-Injections, Steuerzeichen und gefährliche Escape-Sequenzen.
- **Die 5 Agenten-Tools:**
  1. `check_ean_safety`: EAN-Prüfung gegen die Datenbank mit ZWINGENDEM Sicherheits-Disclaimer bei 0 Treffern.
  2. `screen_children_products`: Gezielte Erkennung von Spielzeug-, Baby- und Kindergefahren (Erstickung, PFAS/Phthalate, Magnete).
  3. `search_product_recalls`: Freitext- und Kategoriesuche nach Marke, Modell und Gefahrenart.
  4. `get_chemical_restrictions`: Gezielte Filterung nach chemischen Gefahren (REACH, Phthalate, Blei, Cadmium, SVHC).
  5. `monitor_weekly_alerts`: Abfrage der neuesten wöchentlichen Sicherheitsberichte.
- **PaymentGate (`payment.ts`):** Vorbereitetes Interface für HTTP 402 / Stripe Machine Payments Protocol (MPP).

---

## Schnellstart & Lokales Setup

### Voraussetzungen
- **Node.js:** `>= 22.0.0`
- **npm:** `>= 10.0.0`

### Installation
```bash
# Repository klonen
git clone https://github.com/thartmannsgruber-ai/ProductSafetyEngine.git
cd ProductSafetyEngine

# Abhängigkeiten im Monorepo installieren
npm install
```

### Build & Typecheck
```bash
# TypeScript-Prüfung über alle Workspaces
npm run typecheck
```

### Tests ausführen
```bash
# Alle Tests (100% offline gegen Fixtures) ausführen
npm test

# Nur Core-Tests ausführen
npm test -w packages/core

# Nur MCP-Tests ausführen
npm test -w apps/mcp
```

---

## MCP Server Konfiguration

Der MCP-Server kommuniziert über `stdio` und kann direkt in MCP-Clients (z. B. Claude Desktop, Cursor oder Antigravity) eingebunden werden.

### Einbindung in Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "product-safety": {
      "command": "node",
      "args": [
        "/absolute/path/to/ProductSafetyEngine/apps/mcp/dist/index.js"
      ],
      "env": {
        "NODE_ENV": "production"
      }
    }
  }
}
```

### Entwicklungsmodus via tsx
```bash
npx tsx apps/mcp/src/index.ts
```

---

## Apify Actor & Pay-Per-Event (PPE)

Der Actor in `apps/actor` ist für den Apify Store optimiert und bietet ein hochkompetitives Einstiegspreismodell von **$1.90 / 1.000 Results** ($0.0019 pro geliefertem Datensatz). Er ermöglicht es Nutzern, eigene Produktlisten oder EAN-Kataloge im Batch-Verfahren gegen alle EU-Rückrufe zu prüfen.

Abrechnung erfolgt verbrauchsgenau pro Event:
- **Einstiegspreismodell:** **$1.90 / 1.000 Results** ($0.0019 pro Resultat)
- `ean-checked`: **$0.005** pro geprüfter EAN
- `alert-returned`: **$0.0019** pro zurückgegebenem Alert ($1.90 / 1.000 Results)
- `query-executed`: **$0.002** pro Suchanfrage
- `weekly-monitored`: **$0.020** pro Wochenbericht
- **Webhooks & Bulk CSV Ingestion:** **Kostenlos ($0.00)** – keine zusätzlichen Abrechnungsevents

Details siehe [PRICING.md](PRICING.md).

### Check Amazon ASINs & product URLs

Überprüfung von Amazon ASINs und Produkt-Detailseiten-URLs gegen offizielle EU Safety Gate Rückrufe und GPSR-Mängel.

**JSON-Beispiel-Input:**
```json
{
  "asins": [
    "0306406152",
    "B08N5WRWNW"
  ],
  "amazonUrls": [
    "https://www.amazon.de/dp/0306406152",
    "https://www.amazon.co.uk/Motorcycle-Helmet-Bluetooth/dp/B08H93ZRK9"
  ],
  "childProductsOnly": false,
  "maxItems": 50
}
```

Die Auflösung erfolgt über drei konforme Mechanismen:
1. **ISBN-10 zu EAN-13 Konvertierung:** Mathematische Prüfziffernberechnung für Buch-ASINs (`resolution_method: "isbn10_conversion"`).
2. **Katalog-Mapping:** Zuordnung über mitgelieferte ASIN/EAN-Paare aus Bulk-CSV-Dateien (`resolution_method: "csv_mapping"`).
3. **URL-Slug-Keywords:** Extraktion von Produkttiteln aus Amazon-URLs für Volltextsuchen im Safety-Gate-Index (`resolution_method: "url_slug_keywords"`, gekennzeichnet mit `match_confidence: "keyword"`).

> [!NOTE]
> **Ehrlicher Hinweis zu den Grenzen der ASIN-Auflösung (Zero Scraping):**  
> ProductSafetyEngine agiert strikt datenschutz- und plattformkonform und betreibt **kein Scraping** von Amazon-Webseiten oder das Umgehen von Bot-Schutzmaßnahmen. Nicht auflösbare B0-ASINs (ohne ISBN-10-Muster, ohne CSV-Katalog-EAN und ohne sprechende URL-Slugs) werden im `RUN_SUMMARY` und `BATCH_REPORT` als nicht aufgelöst (`unresolved`) transparent ausgewiesen. Für nicht auflösbare Kennungen fallen **keine PPE-Kosten ($0.00)** an.

---

### Bulk CSV screening (up to 10,000 SKUs)

Automatisiertes Screening ganzer Lieferanten- und Marktplatzkataloge mit bis zu **10.000 SKUs** oder **5 MB** Dateigröße pro Run.

**CSV-Beispiel (`apps/actor/.actor/examples/bulk-sample.csv`):**
```csv
sku,ean,asin,name,url
SKU-1001,5054298241091,,Wooden Building Blocks,https://www.amazon.de/dp/B08N5WRWNW
SKU-1002,4006381333931,,Magnetic Drawing Board,
SKU-1003,,0306406152,Science Experiment Manual,https://www.amazon.co.uk/dp/0306406152
SKU-1004,4099979071513,B08H93ZRK9,Baby Teething Ring,https://www.amazon.de/Baby-Teething-Ring/dp/B08H93ZRK9
SKU-1005,5901234123457,,Plush Animal Toy,
```

**JSON-Beispiel-Input (Remote URL oder Direkt-Inhalt):**
```json
{
  "csvUrl": "https://example.com/catalogs/inventory_2026.csv",
  "childProductsOnly": false,
  "maxItems": 50,
  "webhookUrl": "https://api.yourdomain.com/webhooks/safety-alerts",
  "webhookFormat": "generic"
}
```

*Highlights:*
- Automatische Erkennung gängiger Header (`sku`, `ean`, `asin`, `url`, `name`) und Trennzeichen (`,`, `;`, `\t`).
- Direkte Unterstützung von Google-Sheets-Freigabelinks (automatische Konvertierung nach `/export?format=csv`).
- Duplikaterkennung: Mehrfach vorkommende EANs werden dedupliziert und nur ein einziges Mal abgerechnet.
- SSRF-Schutz: Remote-URLs werden auf HTTPS validiert und private IP-Bereiche, Localhost sowie Cloud-Metadaten-Endpunkte blockiert.

---

### Webhook alerts (Slack, Discord, Make, Zapier, ERP)

Echtzeit-Push-Benachrichtigungen bei Gefahren- und Produktrückruftreffern für automatisierte Workflows in Slack, Discord, Make, Zapier oder In-House-ERP-Systemen.

**JSON-Beispiel-Input:**
```json
{
  "eans": ["5054298241091", "4006381333931"],
  "webhookUrl": "https://api.yourdomain.com/webhooks/safety-alerts",
  "webhookFormat": "generic",
  "webhookSecret": "whsec_live_9a8b7c6d5e4f3a2b1c0d",
  "webhookOnlyOnMatch": true
}
```

Unterstützte Formate:
- `generic`: Vollständiges JSON-Schema `pse.alert.v1` mit Trefferdetails und EU-Safety-Gate-Referenzen.
- `slack`: Fertig gerenderte Slack Block-Kit-Payloads (max. 50 Blöcke).
- `discord`: Reichhaltige Embed-Karten für Discord-Webhooks (max. 10 Embeds).

**Signaturprüfung (Node.js Snippet):**
Zur Verifikation der Echtheit wird der Header `X-Hub-Signature-256` mit HMAC-SHA256 validiert:

```javascript
import crypto from 'node:crypto';

/**
 * Signaturprüfung für eingehende ProductSafetyEngine Webhooks
 * @param {string} rawBody - Ungeparster Roh-Request-Body als String
 * @param {string} signatureHeader - Wert des Headers 'X-Hub-Signature-256'
 * @param {string} secret - Konfiguriertes Webhook-Secret
 * @returns {boolean} True wenn die Signatur valide und authentisch ist
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=') || !secret) {
    return false;
  }

  const expectedSignature = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf-8')
    .digest('hex');

  const signatureBuffer = Buffer.from(signatureHeader, 'utf-8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(signatureBuffer, expectedBuffer);
}
```

*Kostenhinweis:* Webhooks und CSV-Parsing sind **100 % kostenlos ($0.00)**. Es fallen keine zusätzlichen Abrechnungsevents an.

---

## Testing & Qualitätssicherung

- **Strict Offline Rule:** Sämtliche Tests laufen strikt offline gegen die mitgelieferte Original-Fixture `fixtures/safety_gate_2026_45.xml`.
- **Keine externen Netzwerkaufrufe:** Der HTTP-Fetcher wird in allen Test-Suiten vollständig über Mocks isoliert.
- **100% Typabdeckung:** Strict TypeScript (`strict: true`, `noImplicitAny: true`).

---

## Compliance & Rechtliches

Die Nutzung von behördlichen Daten der Europäischen Union unterliegt den Regelungen des **EU-Beschlusses 2011/833/EU** über die Weiterverwendung von Kommissionsdokumenten.

Ausführliche rechtliche Hinweise, Haftungsausschlüsse und Quellenangaben finden Sie in [COMPLIANCE.md](COMPLIANCE.md).

---

## Lizenz

**MIT License.** Copyright (c) 2026 Thomas Hartmannsgruber. Weitere Details siehe [LICENSE](LICENSE).
