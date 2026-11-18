# Legal Compliance, Data Reuse Rights & Disclaimers

This document sets forth the legal framework, rights of reuse, official data citations, technical compliance parameters, and mandatory liability disclaimers governing the use of **ProductSafetyEngine**.

---

## 1. Legal Basis for Data Reuse: EU Decision 2011/833/EU

ProductSafetyEngine ingests, parses, normalizes, and indexes public documents and safety notifications issued by the European Union.

### Commission Decision 2011/833/EU
The reuse of European Commission documents is governed by:
> **Commission Decision 2011/833/EU of 12 December 2011 on the reuse of Commission documents**  
> *(OJ L 330, 14.12.2011, p. 39–42)*

Under Article 2 and Article 3 of Decision 2011/833/EU, documents produced by the Commission or by executive agencies are available for reuse for commercial or non-commercial purposes, provided that:
1. **The source is acknowledged:** Official citations and source references must be provided.
2. **The original meaning is not distorted:** The data must not be misrepresented, falsified, or altered in a manner that misleads recipients regarding the nature of the safety hazard.
3. **The Commission is not held liable:** The Commission accepts no responsibility or liability arising out of the reuse of the documents.

ProductSafetyEngine strictly satisfies all conditions of Decision 2011/833/EU and operates under the principles of European Open Data legislation (Directive (EU) 2019/1024 on open data and the re-use of public sector information).

---

## 2. Official Data Sources & Citations

All safety alerts, product recalls, and chemical hazard records ingested by ProductSafetyEngine originate from the following official public repositories:

1. **European Commission Safety Gate (formerly RAPEX):**
   - *System:* Rapid Alert System for dangerous non-food consumer products.
   - *Operating Authority:* European Commission, Directorate-General for Justice and Consumers (DG JUST).
   - *Official Portal:* [https://ec.europa.eu/safety-gate-alerts/](https://ec.europa.eu/safety-gate-alerts/)
   - *Content:* Weekly alert reports detailing product descriptions, photos, risk classifications, notifying member states, country of origin, and adopted corrective measures.

2. **European Chemicals Agency (ECHA) & REACH Chemical Recall Screening:**
   - *System:* Information on substances of very high concern (SVHC) and chemical recall screening under the REACH Regulation (EC No 1907/2006) and the SCIP database (Substances of Concern In articles as such or in complex objects / Products) under the Waste Framework Directive (2008/98/EC).
   - *Official Portal:* [https://echa.europa.eu/](https://echa.europa.eu/)

---

## 3. Mandatory Safety & Verification Disclaimers

### A. Critical EAN/Barcode Screening Disclaimer
The following notice is strictly embedded in all API and MCP tool responses:

> **IMPORTANT NOTICE:**  
> **Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).**  
> *(No hit does not signify that the product is safe; numerous official notifications do not contain a registered EAN or barcode).*

- Authorities frequently issue notifications based solely on brand names, model numbers, batch codes, or photographic evidence when barcodes are omitted by counterfeiters or manufacturers.
- A "zero matches" result from an EAN check merely confirms that no published recall in the Safety Gate index specifically matched the supplied barcode. It does not certify that the product is hazard-free, CE-compliant, or legal to distribute.

### B. No Certification of Conformity
ProductSafetyEngine is a high-speed data indexing and querying tool. It **does not issue conformity assessments**, CE markings, EU declarations of conformity, or laboratory test reports. 

The responsibility for verifying product safety, ensuring compliance with the **EU General Product Safety Regulation (GPSR - EU 2023/988)**, and maintaining technical documentation remains exclusively with the manufacturer, authorized representative, importer, or distributor.

---

## 4. Limitation of Liability

1. **Public Domain Data "As Is":**  
   The data provided by ProductSafetyEngine is delivered on an "as-is" and "as-available" basis. While ProductSafetyEngine utilizes strict automated validation, Zod schemas, and Modulo-10 checksum algorithms to guarantee accurate reflection of upstream records, no warranty—express or implied—is given regarding the absolute completeness, continuous availability, or real-time exhaustiveness of governmental notifications.

2. **No Legal or Regulatory Counseling:**  
   The output produced by this engine, its Apify Actor, and its MCP tools does not constitute legal, regulatory, or technical advisory services. Users must consult qualified legal counsel or accredited testing institutions (e.g. TÜV, Dekra, SGS) for formal compliance certification.

3. **Exclusion of Consequential Damages:**  
   To the maximum extent permitted by applicable law (including the German Civil Code / BGB and the German Telecommunications-Telemedia Data Protection Act / TDDDG), the developers, maintainers, and operators of ProductSafetyEngine shall not be held liable for any commercial losses, customs seizures, marketplace account suspensions, administrative fines, or loss of profits resulting from decisions made on the basis of query results.

---

## 5. Technical Crawling, Scraping & TDM Compliance

ProductSafetyEngine is architected to protect public European infrastructure and adhere to EU and German copyright laws:

- **Robots.txt & TDM Reservations:** The engine's fetcher (`packages/fetcher/src/fetcher.ts`) programmatically inspects `robots.txt` files and honors Text and Data Mining (TDM) opt-outs pursuant to **Article 4 of Directive (EU) 2019/790** on copyright in the Digital Single Market and **§ 44b UrhG** (German Copyright Act).
- **Hard Rate Limiting:** Outgoing network traffic is strictly throttled to a maximum of **1 request per second** with exponential backoff to eliminate any risk of server degradation or denial of service.
- **Cache Compliance:** Employs HTTP `ETag` and `If-None-Match` headers to minimize bandwidth consumption and prevent redundant data downloads.

---

## 6. Data Protection & Privacy (GDPR / DSGVO)

ProductSafetyEngine processes **exclusively public commercial and regulatory product safety information**. 
- No consumer personal identifiable information (PII), end-user tracking data, or private consumer profiles are collected, indexed, or stored.
- Operating member states, notifying authorities, and corporate manufacturer names contained in official alerts constitute public administrative information published pursuant to statutory EU transparency mandates.
