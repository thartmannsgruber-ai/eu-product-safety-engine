# ProductSafetyEngine

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x%20strict-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-22.x-green.svg)](https://nodejs.org/)
[![Vitest](https://img.shields.io/badge/Tests-Vitest%20100%25%20Offline-brightgreen.svg)](https://vitest.dev/)
[![License: Proprietary](https://img.shields.io/badge/License-Proprietary-red.svg)](LICENSE)

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
- `alert-returned`: **$0.010** pro zurückgegebenem Alert
- `query-executed`: **$0.002** pro Suchanfrage
- `weekly-monitored`: **$0.020** pro Wochenbericht

Details siehe [PRICING.md](PRICING.md).

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

**Proprietary / All rights reserved.** Copyright (c) 2026 Thomas Hartmannsgruber.
Die kommerzielle Weiterverbreitung, das Reverse Engineering oder das unautorisierte Hosting als eigener Service sind strengstens untersagt. Weitere Details siehe [LICENSE](LICENSE).
