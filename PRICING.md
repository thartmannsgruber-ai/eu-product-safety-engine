# Pricing Model & Pay-Per-Event (PPE) Breakdown

ProductSafetyEngine utilizes an event-driven, transparent **Pay-Per-Event (PPE)** pricing architecture with a competitive marketplace entry tier of **$1.90 / 1.000 Results** ($1.90 per 1,000 results / $0.0019 per record). There are no opaque setup fees, no mandatory multi-thousand-dollar annual contracts, and no idle retainer charges: **you only pay for the exact verification events and data points your systems consume.**

---

## 0. Competitive Marketplace Entry Pricing ($1.90 / 1.000 Results)

For bulk e-commerce catalog screenings and dataset ingestion in the Apify Store, ProductSafetyEngine provides an industry-leading entry pricing model:
- **Marketplace Entry Model:** **$1.90 / 1.000 Results** ($0.0019 per delivered result record).
- **Predictable Cost Control:** Transparent billing with automated usage ceilings. Screen thousands of ASINs, SKUs, and EANs with zero financial friction.
- **Pay-Per-Event Granularity:** Mix and match barcode checks, search queries, and weekly alert digests.

---

## 1. Pay-Per-Event (PPE) Tariff Structure

The official event definitions and standard unit prices (in USD) are strictly aligned with `apps/actor/src/ppe.ts`:

| Event Identifier (`PPE_EVENTS`) | Description | Unit Price (USD) | Unit Price (EUR approx.) | Billable Unit |
|:---|:---|:---|:---|:---|
| **`ean-checked`** | Validation and database screening of a single GTIN / EAN barcode (including Modulo-10 checksum validation). | **$0.005** | ~€0.0046 | Per unique barcode processed |
| **`alert-returned`** | Complete, normalized recall record delivered in the dataset (risk level, defects, legal measures, countries). Aligned with the **$1.90 / 1.000 Results** entry tier for bulk volume. | **$0.010** | ~€0.0092 | Per matching alert returned |
| **`query-executed`** | Full-text, category, or parameter-based search query across indexed RAPEX records. | **$0.002** | ~€0.0018 | Per executed search query |
| **`weekly-monitored`** | Systematic batch retrieval of an entire calendar week's official EU Safety Gate publications. | **$0.020** | ~€0.0185 | Per weekly batch fetched |

---

## 2. Realistic Usage Scenarios & Cost Estimations

To illustrate how the Pay-Per-Event model operates in real-world business environments, consider these three representative scenarios:

### Scenario A: Amazon & Marketplace Seller (FBA Catalog Screening)
*Profile:* A seller importing consumer electronics and toys checks their active inventory of **500 SKUs** once a month. Statistically, 0.4% (2 SKUs) trigger an active recall match.

- **500 EAN checks (`ean-checked`):** $500 \times \$0.005 = \$2.50$
- **2 Alert details delivered (`alert-returned`):** $2 \times \$0.010 = \$0.02$
- **Total Monthly Cost:** **$2.52 / month** (~€2.32)

---

### Scenario B: Mid-Sized Importer & Wholesaler (Supplier Pre-Clearance)
*Profile:* An importer screens **5,000 incoming products** from Asian manufacturers monthly, runs **250 custom keyword searches** on emerging brands, and subscribes to weekly alert summaries across 4 categories.

- **5,000 EAN checks (`ean-checked`):** $5,000 \times \$0.005 = \$25.00$
- **20 Alert matches delivered (`alert-returned`):** $20 \times \$0.010 = \$0.20$
- **250 Search queries (`query-executed`):** $250 \times \$0.002 = \$0.50$
- **4 Weekly digests monitored (`weekly-monitored`):** $4 \times \$0.020 = \$0.08$
- **Total Monthly Cost:** **$25.78 / month** (~€23.75)

---

### Scenario C: Large Enterprise E-Commerce Platform / Fulfilment Provider
*Profile:* An enterprise marketplace with **100,000 active listings** verifies its entire catalog monthly, performs automated nightly queries, and ingests all weekly European alerts.

- **100,000 EAN checks (`ean-checked`):** $100,000 \times \$0.005 = \$500.00$
- **400 Alert matches delivered (`alert-returned`):** $400 \times \$0.010 = \$4.00$
- **5,000 API queries (`query-executed`):** $5,000 \times \$0.002 = \$10.00$
- **52 Weekly digests (`weekly-monitored`):** $52 \times \$0.020 = \$1.04$
- **Total Monthly Cost:** **$515.04 / month** (~€475.00)

> **Industry Comparison:** Legacy compliance suites and enterprise ESG/product safety databases typically charge between **€12,000 and €45,000 annually** for static seat licenses with severe query caps. ProductSafetyEngine provides greater agility, sub-second latency, and official EU source data at a 90%+ cost reduction with entry pricing of **$1.90 / 1.000 Results**.

---

## 3. Machine Payments Protocol (MPP) & HTTP 402 Architecture

In addition to Apify Store PPE billing, the Model Context Protocol (MCP) server includes a native **PaymentGate architecture** (`apps/mcp/src/payment.ts`) prepared for autonomous agent micropayments via **HTTP 402 (Payment Required)** and Stripe Machine Payments Protocol (MPP).

### Credit-to-USD Mapping
The internal payment gateway converts dollar amounts into micro-credits:
- **1 Credit = $0.001 USD** (0.1 US cent)
- `ean-checked`: **5 Credits**
- `alert-returned`: **10 Credits**
- `query-executed`: **2 Credits**
- `weekly-monitored`: **20 Credits**

### HTTP 402 Protocol Headers
When agent budgets or authorized credit limits are reached, the server yields standardized 402 response headers enabling automated machine settlement:

```http
HTTP/1.1 402 Payment Required
X-Payment-Required: true
X-Payment-Protocol: stripe-mpp/1.0
X-Cost-Credits: 5
X-Payment-Amount: 0.005
X-Payment-Currency: USD
X-Payment-Tool: check_ean_safety
X-Payment-Url: https://api.productsafetyengine.io/pay/session_xyz
```

### Developer Evaluation Tier
For local testing, staging, and agent evaluation, the engine ships with `NoopPaymentGate`, allowing up to **100 free test requests** without active credit card or token credentials.

---

## 4. Volume Discounts & Marketplace Entry Model

For platforms screening more than **500,000 barcodes per month** or requiring dedicated private SQLite instances with sub-5ms SLA guarantees, custom volume pricing tiers and on-premise licensing agreements are available:

- **Marketplace Entry Model:** **$1.90 / 1.000 Results** ($0.0019 / record)
- **Tier 1 (Up to 50k events/mo):** Standard PPE Tariff
- **Tier 2 (50k - 500k events/mo):** 20% discount on `ean-checked` ($0.004 / unit)
- **Tier 3 (500k+ events/mo):** 40% discount on `ean-checked` ($0.003 / unit) or flat-rate cluster licensing.


---

## 5. Legal Disclaimer & Information Notice

*Important Legal Notice:* Data is derived from official European Commission Safety Gate notifications under Commission Decision 2011/833/EU. Screening results are provided for informational and preliminary compliance purposes only and do not constitute formal legal advice or a guarantee of non-recall. A zero-match result ("Kein Treffer bedeutet nicht, dass das Produkt sicher ist") indicates that no alert matching that specific barcode was recorded in the database; it does not replace the seller's or importer's statutory obligations under the EU General Product Safety Regulation (GPSR). Haftungsausschluss: Alle Angaben ohne Gewähr.
