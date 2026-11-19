# EU Safety Gate & Recall API (GPSR, RAPEX & EAN Compliance)

[![Apify Actor](https://img.shields.io/badge/Apify-Pay--Per--Event-orange.svg)](https://apify.com)
[![GPSR Ready](https://img.shields.io/badge/EU%20GPSR%202023%2F988-Screening%20Engine-success.svg)](https://eur-lex.europa.eu/eli/reg/2023/988/oj)
[![EU Safety Gate](https://img.shields.io/badge/EU%20Safety%20Gate-RAPEX%20Indexed-green.svg)](https://ec.europa.eu/safety-gate-alerts/)
[![Pricing: $1.90/1k](https://img.shields.io/badge/Pricing-$1.90%20%2F%201k%20Results-blue.svg)](https://apify.com)

Automated EU Compliance & Recall Screening Actor for e-commerce merchants, Amazon FBA/FBM sellers, direct importers, marketplaces, and compliance officers. Screen product catalogs, GTIN/EAN barcodes, Amazon ASINs, and product URLs against official European Commission Safety Gate (RAPEX) and REACH chemical recall databases in real time under the **EU General Product Safety Regulation (GPSR – EU 2023/988)**.

---

## Key Capabilities

- **EAN/GTIN Barcode Screening:** Strict Modulo-10 checksum validation (EAN-8, EAN-13, UPC-A, UPC-E) and direct recall lookup.
- **Check Amazon ASINs & product URLs:** Automated resolution of book ISBN-10 ASINs, URL title slug keyword matching, and catalog EAN cross-referencing.
- **Bulk CSV screening (up to 10,000 SKUs):** High-speed catalog batch ingestion via direct CSV upload or remote HTTPS URL (including Google Sheets).
- **Webhook alerts (Slack, Discord, Make, Zapier, ERP):** Real-time HMAC-SHA256 signed push notifications on recall matches.
- **Child, Baby & Toy Safety Intelligence:** Dedicated filter presets for choking, toxic chemicals (PFAS, phthalates), and high-flux magnets.
- **Transparent Pay-Per-Event (PPE) Billing:** Market entry pricing at **$1.90 / 1.000 Results** ($0.0019 per record). Free webhooks and free CSV ingestion.

---

## Check Amazon ASINs & product URLs

Screen Amazon Standard Identification Numbers (ASINs) and product detail page URLs against official EU Safety Gate recall notices.

### JSON Input Example

```json
{
  "asins": [
    "0306406152",
    "B08N5WRWNW"
  ],
  "amazonUrls": [
    "https://www.amazon.de/dp/0306406152",
    "https://www.amazon.co.uk/Motorcycle-Helmet-Bluetooth/dp/B08H93ZRK9",
    "https://amzn.to/3example"
  ],
  "childProductsOnly": false,
  "maxItems": 50
}
```

### Resolution Pipeline & Output Enrichment

When ASINs or Amazon URLs are supplied, the engine resolves identifiers through three compliant pathways:
1. **ISBN-10 to EAN Conversion:** 10-digit book ASINs (e.g. `0306406152`) are mathematically converted into EAN-13 barcodes (`9780306406157`) and queried via the standard barcode index (`resolution_method: "isbn10_conversion"`).
2. **Catalog Mapping:** Cross-referenced against EAN mappings provided in your catalog CSV (`resolution_method: "csv_mapping"`).
3. **URL Title Slug Search:** Product detail page URLs containing descriptive slugs (e.g. `.../Motorcycle-Helmet-Bluetooth/dp/...`) extract product keywords to execute targeted Safety Gate queries (`resolution_method: "url_slug_keywords"`, marked with `match_confidence: "keyword"`).

Matching dataset items are automatically enriched with `input_identifier`, `input_kind`, and `resolution_method`.

> [!NOTE]
> **Honest Notice on Resolution Boundaries (Zero-Scraping Compliance):**  
> ProductSafetyEngine operates strictly within compliance boundaries and does **not** scrape live Amazon product pages, bypass anti-bot challenges, or violate marketplace terms of service. ASIN resolution is performed either algorithmically (ISBN-10 to EAN calculation), via user-supplied catalog mappings (in Bulk CSV imports), or via semantic URL slug keywords. Proprietary non-book `B0...` ASINs that lack an associated EAN in your catalog or clean title tokens in their URL cannot be resolved to a barcode and will be reported as `unresolved` in `RUN_SUMMARY` and `BATCH_REPORT`. Unresolved identifiers incur **$0.00** (no PPE charges applied).

---

## Bulk CSV screening (up to 10,000 SKUs)

Screen entire supplier catalogs and product inventory lists up to **10,000 SKUs** or **5 MB** in a single execution.

### CSV Format Example

You can download or view the sample catalog at [examples/bulk-sample.csv](examples/bulk-sample.csv):

```csv
sku,ean,asin,name,url
SKU-1001,5054298241091,,Wooden Building Blocks,https://www.amazon.de/dp/B08N5WRWNW
SKU-1002,4006381333931,,Magnetic Drawing Board,
SKU-1003,,0306406152,Science Experiment Manual,https://www.amazon.co.uk/dp/0306406152
SKU-1004,4099979071513,B08H93ZRK9,Baby Teething Ring,https://www.amazon.de/Baby-Teething-Ring/dp/B08H93ZRK9
SKU-1005,5901234123457,,Plush Animal Toy,
```

### JSON Input Example

Provide either a public HTTPS URL (`csvUrl`) or paste raw CSV text (`csvContent`):

```json
{
  "csvUrl": "https://example.com/catalogs/inventory_2026.csv",
  "childProductsOnly": false,
  "maxItems": 50,
  "webhookUrl": "https://api.yourdomain.com/webhooks/safety-alerts",
  "webhookFormat": "generic"
}
```

Or using inline raw CSV content:

```json
{
  "csvContent": "sku,ean,name\nSKU-1001,5054298241091,Wooden Toy\nSKU-1002,4006381333931,Drawing Board",
  "webhookOnlyOnMatch": true
}
```

### Key Processing Features

- **Header Auto-Mapping:** Flexible detection of column names (`sku`, `ean`, `gtin`, `barcode`, `asin`, `url`, `name`, `title`).
- **Delimiter Auto-Detection:** Automatically handles comma (`,`), semicolon (`;`), and tab (`\t`) delimiters, as well as UTF-8 BOM.
- **Google Sheets Support:** Google Sheets share links (e.g. `https://docs.google.com/spreadsheets/d/.../edit?usp=sharing`) are automatically rewritten to direct CSV export URLs.
- **SSRF Protection:** Remote URLs enforce HTTPS and strictly prohibit private, loopback, link-local, and cloud metadata IP ranges.
- **Smart Deduplication:** Duplicate barcodes within the file are checked and billed only once.
- **Batch Report:** Generates a structured `BATCH_REPORT` record in the default Key-Value store (`totalRows`, `validRows`, `duplicates`, `matchedRows`, `durationMs`).

---

## Webhook alerts (Slack, Discord, Make, Zapier, ERP)

Receive instant push notifications when product recalls or safety violations are detected in your catalog.

### JSON Input Example

```json
{
  "eans": ["5054298241091", "4006381333931"],
  "webhookUrl": "https://api.yourdomain.com/webhooks/safety-alerts",
  "webhookFormat": "generic",
  "webhookSecret": "whsec_live_9a8b7c6d5e4f3a2b1c0d",
  "webhookOnlyOnMatch": true
}
```

### Supported Payload Formats

1. **`generic` (Default):** Standardized `pse.alert.v1` JSON structure containing run metadata, totals, and an array of matches with product details, risk classifications, and official EU Safety Gate URLs.
2. **`slack`:** Native Slack Block Kit blocks (bounded to Slack's 50-block and 3,000-character limits) ready for Slack Incoming Webhooks.
3. **`discord`:** Discord webhook format with rich Embed cards (bounded to 10 embeds and 4,096 characters).

### HMAC-SHA256 Signature Verification (Node.js Snippet)

When `webhookSecret` is configured, each outbound HTTP request includes an `X-Hub-Signature-256` header formatted as `sha256=<hex_digest>`. Verify the authenticity of incoming alerts with this Node.js snippet:

```javascript
import crypto from 'node:crypto';

/**
 * Verify incoming ProductSafetyEngine webhook signature.
 * @param {string} rawBody - Raw unparsed HTTP request body string
 * @param {string} signatureHeader - Value of 'X-Hub-Signature-256' header (e.g. 'sha256=abcdef...')
 * @param {string} secret - Shared webhook secret configured in Actor input
 * @returns {boolean} True if signature is authentic and valid
 */
export function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=' || !secret)) {
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

---

## Pay-Per-Event (PPE) Pricing

ProductSafetyEngine provides an industry-leading entry pricing model of **$1.90 / 1.000 Results** ($0.0019 per delivered record):

| Event | Description | Price (USD) |
|:---|:---|:---|
| **`ean-checked`** | Validation and database screening of a unique GTIN / EAN barcode | **$0.005** |
| **`alert-returned`** | Complete, normalized recall record delivered ($1.90 / 1.000 Results) | **$0.0019** |
| **`query-executed`** | Full-text, category, or URL slug search query | **$0.002** |
| **`weekly-monitored`** | Systematic batch retrieval of a weekly Safety Gate publication | **$0.020** |
| **Webhooks** | Real-time Slack, Discord, or generic webhook dispatch | **FREE ($0.00)** |
| **Bulk CSV Ingestion** | Parsing and mapping of catalog CSV files (up to 10,000 SKUs) | **FREE ($0.00)** |

*No new billing events are added for ASIN resolution, bulk CSV parsing, or Webhook alerts. See [PRICING.md](https://github.com/thartmannsgruber-ai/ProductSafetyEngine/blob/main/PRICING.md) for full pricing details.*

---

## Legal & Compliance Notice

Data is sourced from official European Commission Safety Gate publications under **Commission Decision 2011/833/EU**. Results are provided for preliminary screening and informational compliance purposes. A zero-match result ("Kein Treffer bedeutet nicht, dass das Produkt sicher ist") indicates that no alert matching that specific barcode was recorded in the database; it does not replace statutory obligations under the EU General Product Safety Regulation (GPSR).
