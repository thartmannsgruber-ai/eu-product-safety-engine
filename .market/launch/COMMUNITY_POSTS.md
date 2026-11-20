# Community Posts & Attention Push: EU Product Safety Engine

---

## 1. LinkedIn B2B Founder Post (Thomas Hartmannsgruber)
**Zielgruppe:** Großhändler, E-Commerce-Geschäftsführer, Head of Compliance, Marktplatz-Händler  
**Tonalität:** Authentische Gründer-Perspektive (Solo-FinTech & Compliance-Architekt, 13 J. DAX-Konzernfinanzsteuerung, 20+ J. Kapitalmarkt)

```text
Seit dem 13. Dezember 2024 gilt die EU-Produktsicherheitsverordnung (GPSR / EU 2023/988) vollumfänglich. 

Was viele Händler und Importeure erst jetzt im operativen Tagesgeschäft spüren: 
Amazon, eBay und Kaufland sperren betroffene ASINs bei EU Safety Gate (RAPEX) Meldungen mittlerweile vollautomatisch und binnen weniger Stunden. 

Wer als Großhändler oder Importeur Produkte vertreibt, bei denen Herstellerdaten unvollständig sind oder Rückrufe (z. B. Phthalate in Spielwaren, Brandgefahr bei Netzteilen, Lilial in Kosmetik) übersehen wurden, haftet direkt – mit Kontensperren, Zollbeschlagnahme und Bußgeldern bis zu 4 % des Jahresumsatzes.

Manuelle PDF-Recherche im Safety Gate Portal für Hunderte Artikel? Im Alltag völlig unmöglich.

Deshalb habe ich die EU Product Safety & Recall Engine gebaut:
- Batch EAN-Screening: 500 Barcodes in unter 2 Sekunden gegen alle aktuellen EU Safety Gate & REACH-Rückrufe verifizieren
- Modulo-10 Barcode-Prüfung & Erkennung gefährlicher chemischer Substanzen
- Nahtlos als Pay-Per-Event Actor auf Apify oder als nativer MCP-Server für KI-Agenten (Claude, Cursor, Antigravity)

Für B2B-Großhändler und Händler bieten wir aktuell einen kostenlosen Quick-Audit an: 
Senden Sie uns eine Liste von bis zu 100 EANs aus Ihrem aktuellen Sortiment – wir prüfen Ihren Katalog kostenfrei gegen die EU-Rückrufdatenbank und liefern einen strukturierten Compliance-Report.

Link zum Apify-Actor & API: https://apify.com/thfc_labs/eu-product-safety-actor
Oder direkt PN für den kostenlosen 100-EAN-Check.
```

---

## 2. Reddit Post (r/AmazonFBATips, r/FulfillmentByAmazon, r/ecommerce)
**Titel:** `[Tool / PSA] Built a free tool to batch-check EAN/UPC catalogs against EU Safety Gate (RAPEX/GPSR) recalls to prevent account suspensions`

```markdown
Hey everyone,

With the EU General Product Safety Regulation (GPSR) enforcement in full swing, Amazon Europe has been aggressively suspending listings and holding inventory whenever a supplier product gets flagged in the EU Safety Gate (formerly RAPEX).

The biggest pain point for sellers sourcing from wholesalers or private label manufacturers is that checking products manually against EU recall lists is almost impossible once you have dozens of SKUs.

To solve this, I built the **EU Product Safety & Recall Engine**:
- **Batch Barcode Validation:** Paste up to 500 EAN/UPC barcodes and get immediate recall flags, member state notifications, and hazard descriptions.
- **Chemical & REACH screening:** Detects banned phthalates, lead, cadmium, and dangerous substances before European customs seize shipments.
- **Pay-Per-Event on Apify:** No expensive monthly compliance retainer ($0.05 per run + $1.90 per 1,000 screened alerts).
- **Open MCP Server:** Also runs locally via `npx eu-product-safety-mcp` inside Claude Desktop or Cursor for AI-automated sourcing checks.

Actor Link: https://apify.com/thfc_labs/eu-product-safety-actor  
Open Source / MCP: https://github.com/thartmannsgruber-ai/eu-product-safety-engine

If anyone wants a free sanity check on their top 100 EANs before ordering new inventory, drop me a DM or run the Apify test console. Feedback and feature requests are very welcome!
```

---

## 3. Show HN (Hacker News)
**Titel:** `Show HN: EU Product Safety Engine – Open MCP Server & Batch API for GPSR / RAPEX Recalls`

```markdown
Hi HN,

Under the new EU General Product Safety Regulation (GPSR 2023/988), European marketplaces (Amazon, eBay, etc.) and customs authorities are aggressively blocking products flagged in the EU Safety Gate (RAPEX) recall database.

The official EU portal provides weekly HTML/PDF alerts, but lacks a fast, programmatically queryable batch API for supply chain auditing and automated agent workflows.

I built the **EU Product Safety Engine** to bridge this gap:
- Fast batch screening for EAN/GTIN barcodes with Modulo-10 checksum pre-validation.
- Chemical hazard extraction (REACH SVHC, phthalates, heavy metals, PFAS).
- Model Context Protocol (MCP) server for Claude Desktop, Cursor, and agentic workflows (`npx eu-product-safety-mcp`).
- Production Pay-Per-Event Actor on the Apify platform (`thfc_labs/eu-product-safety-actor`).

Repository: https://github.com/thartmannsgruber-ai/eu-product-safety-engine  
Apify Actor: https://apify.com/thfc_labs/eu-product-safety-actor

I’d love your feedback on our MCP schema design and batch query performance!
```

---

## 4. Apify Community / Discord / Marketplace Announcement
**Titel:** `New Actor: EU Product Safety & Recall Engine (GPSR, RAPEX & EAN Compliance)`

```markdown
Hey Apify Community! 🚀

Excited to share our newly published Actor: **EU Product Safety & Recall Engine** (`thfc_labs/eu-product-safety-actor`).

**What does it do?**
It cross-references supplier catalogs and EAN/GTIN barcodes against the official European Commission EU Safety Gate (RAPEX) alerts in real time. 

**Highlights:**
- Batch EAN screening (up to 500 barcodes per run)
- Chemical restriction alerts (REACH, Phthalates, Cadmium, Lead)
- Built-in MCP server for AI agents
- Pay-Per-Event pricing ($0.05 base + $1.90 / 1k results)

Try it here: https://apify.com/thfc_labs/eu-product-safety-actor
```
