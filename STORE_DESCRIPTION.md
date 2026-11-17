# EU Product Safety & Recall Engine (RAPEX & ECHA)

> **Automated EU Compliance & Recall Screening for E-Commerce Sellers, Importers, and AI Agents.**  
> Screen supplier catalogs, GTIN/EAN barcodes, and weekly recalls against official EU Safety Gate & REACH datasets in real time.

[![Apify Actor](https://img.shields.io/badge/Apify-Pay--Per--Event-orange.svg)](https://apify.com)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Certified%20Tools-blue.svg)](https://modelcontextprotocol.io)
[![EU Safety Gate](https://img.shields.io/badge/EU%20Safety%20Gate-RAPEX%20Indexed-green.svg)](https://ec.europa.eu/safety-gate-alerts/)
[![GPSR Ready](https://img.shields.io/badge/EU%20GPSR%202023%2F988-Compliant-success.svg)](https://eur-lex.europa.eu/eli/reg/2023/988/oj)

---

## The Problem: The High Cost of Non-Compliance in the EU

Under the **EU General Product Safety Regulation (GPSR - EU 2023/988)** and the **Market Surveillance Regulation (EU 2019/1020)**, market surveillance authorities across all 27 EU member states have drastically accelerated enforcement:

- **Instant Marketplace Suspensions:** Amazon, eBay, Otto, and Kaufland automatically suspend seller accounts upon receiving RAPEX notifications.
- **Customs Confiscations:** Non-compliant shipments containing prohibited chemicals (REACH/SVHC) or hazardous toys/electronics are seized and destroyed at European ports.
- **Drastic Fines & Liability:** Sellers and importers face severe civil liability and regulatory penalties up to **4% of annual turnover** for distributing recalled or hazardous goods.
- **Manual Screening is Impossible:** With dozens of new recalls and thousands of hazardous chemical records published every week across hundreds of categories, manual verification across PDFs and fragmented portals is slow, error-prone, and unsustainable.

---

## The Solution: Automated Product Safety & Recall Screening

**EU Product Safety & Recall Engine** is the enterprise-grade automated bridge between official EU Commission data and your daily operations. 

Whether you operate an automated Apify pipeline, an e-commerce catalog sync, or autonomous AI agents via the **Model Context Protocol (MCP)**, this engine enables you to:

1. **Verify EAN/GTIN Barcodes Instantly:** Screen entire product inventories against official EU Safety Gate (RAPEX) recall alerts before listing or buying inventory.
2. **Detect Chemical & REACH Restrictions:** Identify toxic substances, phthalates in toys, lead/cadmium in consumer items, and REACH Candidate List (SVHC) violations before goods leave the factory.
3. **Automate Weekly Vigilance:** Monitor all weekly EU notifications automatically and receive structured JSON alerts tailored to your product categories.
4. **Arm Your AI Agents with MCP Tools:** Connect Claude, Cursor, ChatGPT, or custom LLM agents directly to EU compliance intelligence with 4 dedicated, prompt-injection-safe tools.

---

## Key Features & Capabilities

### 1. Batch EAN/GTIN Barcode Validation
- Screens single barcodes or bulk lists of hundreds of EANs/UPCs.
- Built-in Modulo-10 checksum validation (EAN-8, EAN-13, UPC-A, UPC-E) weeds out corrupt data before querying.
- Provides immediate recall status, notifying member state, risk level (Serious / High / Medium), and exact measures taken (e.g. withdrawal from market, border rejection, recall from consumers).

### 2. Multi-Faceted Product & Brand Search
- Semantic and keyword search across brands, models, product categories, and dangerous defect descriptions.
- Search by country of origin (e.g. identify all toys originating from specific regions with electrical safety notices).

### 3. Dedicated Chemical & REACH Guard
- Targeted filtering for hazardous chemical alerts under the REACH regulation (EC 1907/2006).
- Instant detection of restricted substances: Lead, Cadmium, Nickel release, Phthalates (DEHP, DBP, BBP, DIBP), PFOS/PFAS, and SVHC candidates.

### 4. Zero-Friction AI Agent Integration (MCP Protocol)
- Full compatibility with the official **Model Context Protocol (MCP)** via `stdio`.
- 4 production-ready tools:
  - `check_ean_safety`: Validates barcodes with required legal disclaimers.
  - `search_product_recalls`: Structured recall lookup.
  - `get_chemical_restrictions`: Hazardous substance checks.
  - `monitor_weekly_alerts`: Timely weekly digests.
- Hardened against prompt-injection attacks with strict input sanitization.

---

## Who Is This For?

| Role / Business | Primary Use Case | Measurable Value |
|:---|:---|:---|
| **Amazon / Marketplace Sellers (FBA / FBM)** | Pre-purchase catalog scanning & ASIN monitoring | Prevents account bans and inventory stranding. |
| **Direct Importers & Wholesalers** | Customs pre-clearance and supplier verification | Eliminates container seizures at European ports. |
| **Brand Protection & Compliance Officers** | Automated audit logs & risk documentation | Verifiable GPSR compliance record with zero manual overhead. |
| **AI Engineers & Agent Builders** | Real-time tool-calling via MCP Server | Gives agents reliable ground-truth compliance intelligence. |

---

## How It Works

```
┌────────────────────┐     ┌───────────────────────┐     ┌───────────────────────┐
│ Your Input         │     │ ProductSafetyEngine   │     │ Actionable Output     │
│ • EAN List         │ ──> │ • Modulo-10 Check     │ ──> │ • Verified Safety     │
│ • Brand / Keyword  │     │ • RAPEX Index Lookup  │     │ • Detailed Risk Report│
│ • Weekly Category  │     │ • ECHA Chemical Match │     │ • Legal Measures Log  │
└────────────────────┘     └───────────────────────┘     └───────────────────────┘
```

1. **Provide Input:** Submit one or thousands of GTINs, a brand query, or select a category filter.
2. **Automated Cross-Reference:** The engine parses and queries official EU Commission Safety Gate records.
3. **Structured Response:** Receive high-precision JSON datasets including alert numbers, defect summaries, risk classifications, and official measure types.

---

## Transparent Pay-Per-Event (PPE) Pricing

No massive multi-thousand-dollar enterprise commitments. Only pay for the events you actually trigger:

- **EAN Check:** **$0.005** per barcode verified
- **Alert Matched:** **$0.010** per recall record returned
- **Query Executed:** **$0.002** per keyword search
- **Weekly Monitor:** **$0.020** per weekly digest batch

> Compare this to traditional enterprise compliance suites costing upwards of **$15,000/year** — ProductSafetyEngine gives you the exact same official data for a fraction of the cost.

*See [PRICING.md](PRICING.md) for detailed pricing examples and volume tier calculations.*

---

## Quick Integration Examples

### Apify Actor (JSON Input)
```json
{
  "mode": "ean_check",
  "eans": ["5054298241091", "4099979071513"],
  "category": "Toys",
  "maxItems": 100
}
```

### Model Context Protocol (Claude Desktop / Cursor)
```json
{
  "mcpServers": {
    "eu-product-safety": {
      "command": "npx",
      "args": ["-y", "@productsafetyengine/mcp"]
    }
  }
}
```

Prompt your AI assistant naturally:
> *"Check if EAN 5054298241091 has any active European Safety Gate recalls, and highlight any chemical or choking hazards."*

---

## Legal & Compliance Guarantee

Data published by this engine is sourced directly from the European Commission under **Commission Decision 2011/833/EU** on the reuse of Commission documents.

*Important Disclaimer: A zero-hit result indicates that no official RAPEX notice with that specific EAN was registered in the database; it does not constitute a legal certification of product conformity. See [COMPLIANCE.md](COMPLIANCE.md) for full legal notices.*

---

## Ready to Secure Your EU Supply Chain?

Start screening your catalog today. Protect your seller accounts, streamline your customs clearance, and automate European product safety compliance in minutes.
