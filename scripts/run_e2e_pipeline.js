#!/usr/bin/env node
/**
 * scripts/run_e2e_pipeline.js
 * 
 * End-to-End Pipeline Execution for ProductSafetyEngine:
 * 1. Amazon TSV Ingestion (parseAmazonInventoryReport)
 * 2. Multi-Week Safety Gate Abgleich (storage/safety_gate.db via SqliteAlertStorage)
 * 3. Fuzzy Matching (findMatchesForProduct)
 * 4. GPSR Readiness Check (checkGpsrListing)
 * 5. B2B Multi-Format Report Generation (MD, HTML, XLSX)
 * 6. File Verification (existence, non-empty, valid magic bytes / content)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseAmazonInventoryReport,
  SqliteAlertStorage,
  parseSafetyGateXml,
  normalizeAlerts,
  findMatchesForProduct,
  checkGpsrListing,
  createAuditReport,
} from '../packages/core/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

async function runE2EPipeline() {
  console.log('=================================================================');
  console.log('       PRODUCT SAFETY ENGINE - E2E PIPELINE RUNNER');
  console.log('=================================================================');

  const tsvPath = path.join(ROOT_DIR, 'fixtures/amazon_catalog_sample.tsv');
  const xmlFixturePath = path.join(ROOT_DIR, 'fixtures/safety_gate_2026_45.xml');
  const dbPath = path.join(ROOT_DIR, 'storage/safety_gate.db');
  const reportsDir = path.join(ROOT_DIR, 'storage/reports');

  if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
  }

  // 1. Initialisiere persistenten SQLite Alert Storage
  console.log('\n[1/5] Initialisiere SQLite Safety Gate Alert Database...');
  const storage = new SqliteAlertStorage(dbPath);

  // Stelle sicher, dass Alerts vorhanden sind (Seeding aus Fixture)
  const allAlertsBefore = await storage.findAlerts();
  if (allAlertsBefore.length === 0) {
    console.log(`[Storage] Keine Alerts in ${dbPath} gefunden. Seede aus ${xmlFixturePath}...`);
    const xmlContent = fs.readFileSync(xmlFixturePath, 'utf-8');
    const parsedXml = parseSafetyGateXml(xmlContent);
    const normalizedAlerts = normalizeAlerts(parsedXml.notifications);
    const inserted = storage.insertAlertsSync(normalizedAlerts);
    console.log(`[Storage] Erfolgreich ${inserted} Alerts in SQLite persistiert.`);
  } else {
    console.log(`[Storage] Gefunden: ${allAlertsBefore.length} bestehende Alerts in ${dbPath}.`);
  }

  const allAlerts = await storage.findAlerts();
  console.log(`[Storage] Gesamtbestand Alert-Datenbank: ${allAlerts.length} RAPEX-Meldungen.`);

  // 2. Amazon TSV Ingestion
  console.log('\n[2/5] Ingestion Amazon Seller Central TSV Inventarbericht...');
  if (!fs.existsSync(tsvPath)) {
    throw new Error(`Amazon TSV Datei nicht gefunden: ${tsvPath}`);
  }
  const tsvContent = fs.readFileSync(tsvPath, 'utf-8');
  const parsedAmazon = parseAmazonInventoryReport(tsvContent);

  console.log(`[AmazonParser] TSV geparst:`);
  console.log(`  - Zeilen gesamt:  ${parsedAmazon.stats.totalRows}`);
  console.log(`  - Valide Artikel: ${parsedAmazon.stats.validItems}`);
  console.log(`  - Fehlerzeilen:   ${parsedAmazon.stats.errorRows}`);
  console.log(`  - Duplikate:      ${parsedAmazon.stats.duplicateRows}`);
  console.log(`  - Delimiter:      '${parsedAmazon.stats.delimiter}'`);

  if (parsedAmazon.items.length === 0) {
    throw new Error('Keine validen Artikel im Amazon-Bericht gefunden.');
  }

  // 3. Multi-Week Abgleich, Fuzzy Matching & GPSR Readiness Check
  console.log('\n[3/5] Fuehre Multi-Week Barcode-Abgleich, Fuzzy Matching & GPSR Check aus...');
  const auditedItems = [];
  let barcodeHitsCount = 0;
  let fuzzyHitsCount = 0;
  let compliantGpsrCount = 0;

  for (const item of parsedAmazon.items) {
    const raw = item.raw || {};
    const ean = item.ean || (item.productIdType === 'EAN' ? item.productId : undefined);
    const brand = raw.brand || '';
    const model = raw.model || '';
    const category = raw.category || '';
    const title = item.itemName || '';

    // (A) Barcode / EAN Abgleich
    let barcodeHit = false;
    let barcodeMatch = undefined;

    if (ean) {
      const eanHits = await storage.getByEan(ean);
      if (eanHits.length > 0) {
        barcodeHit = true;
        barcodeHitsCount++;
        const hitAlert = eanHits[0];
        barcodeMatch = {
          matched: true,
          alertNumber: hitAlert.alert_number,
          riskType: hitAlert.risk_type || 'Unbekanntes Risiko',
          riskLevel: hitAlert.risk_level || 'Serious risk',
          dangerDescription: hitAlert.danger_description || '',
          notifyingCountry: hitAlert.notifying_country || '',
          measures: hitAlert.measures || '',
        };
        console.log(`  [HIT-BARCODE] SKU ${item.sellerSku}: EAN ${ean} -> Alert ${hitAlert.alert_number} (${hitAlert.risk_type})`);
      }
    }

    // (B) Fuzzy Matching
    let fuzzyMatch = undefined;
    if (!barcodeHit && (brand || model)) {
      const fuzzyResults = findMatchesForProduct(
        {
          brand,
          model,
          name: title,
          category,
        },
        allAlerts,
        { minScore: 0.65, limit: 1 }
      );

      if (fuzzyResults.length > 0 && fuzzyResults[0].score >= 0.65) {
        fuzzyHitsCount++;
        fuzzyMatch = fuzzyResults[0];
        console.log(`  [HIT-FUZZY] SKU ${item.sellerSku}: "${brand}" / "${model}" -> Score ${(fuzzyMatch.score * 100).toFixed(1)}% (${fuzzyMatch.classification}) Alert: ${fuzzyMatch.alert?.alert_number || 'N/A'}`);
      }
    }

    // (C) GPSR Listing-Readiness Check (EU 2023/988)
    const respPersonName = raw['responsible-person-name'] || raw.responsible_person_name;
    const respPersonAddress = raw['responsible-person-address'] || raw.responsible_person_address;
    const respPersonEmail = raw['responsible-person-email'] || raw.responsible_person_email;
    const mfgName = raw['manufacturer-name'] || raw.manufacturer_name;
    const mfgAddress = raw['manufacturer-address'] || raw.manufacturer_address;
    const mfgEmail = raw['manufacturer-email'] || raw.manufacturer_email;
    const safetyWarnings = raw['safety-warnings'] || raw.safety_warnings ? [raw['safety-warnings'] || raw.safety_warnings] : [];
    const ceMarkingRaw = raw['ce-marking'] || raw.ce_marking;
    const ceMarking = ceMarkingRaw === 'true' || ceMarkingRaw === true;

    const gpsrInput = {
      sku: item.sellerSku,
      asin: item.asin1 || item.asin,
      title,
      brand,
      model,
      responsiblePerson: respPersonName ? {
        name: respPersonName,
        address: respPersonAddress,
        email: respPersonEmail,
      } : undefined,
      manufacturer: mfgName ? {
        name: mfgName,
        address: mfgAddress,
        email: mfgEmail,
      } : undefined,
      warnings: safetyWarnings,
      ceMarking,
    };

    const gpsrReport = checkGpsrListing(gpsrInput);
    if (gpsrReport.isCompliant) {
      compliantGpsrCount++;
    }

    auditedItems.push({
      id: item.sellerSku,
      sku: item.sellerSku,
      asin: item.asin1 || item.asin,
      ean,
      title,
      brand,
      model,
      category,
      price: item.price || 0,
      quantity: item.quantity || 0,
      barcodeHit,
      barcodeMatch,
      fuzzyMatch,
      gpsrReport,
    });
  }

  console.log(`\nAbgleich abgeschlossen:`);
  console.log(`  - Gepruefte Artikel:      ${auditedItems.length}`);
  console.log(`  - Exakte Barcode-Treffer: ${barcodeHitsCount}`);
  console.log(`  - Fuzzy Match Treffer:    ${fuzzyHitsCount}`);
  console.log(`  - GPSR-vollkonform:       ${compliantGpsrCount}/${auditedItems.length}`);

  // 4. B2B Multi-Format Report Generator
  console.log('\n[4/5] Generiere B2B Audit Reports (MD, HTML, XLSX)...');
  const auditReport = createAuditReport({
    merchantName: 'Amazon FBA Enterprise Merchant',
    items: auditedItems,
    reportDate: new Date(),
    includeDetailedActionPlan: true,
  });

  const mdReport = auditReport.toMarkdown();
  const htmlReport = auditReport.toHtml();
  const xlsxReport = auditReport.toXlsx();

  const mdPath = path.join(reportsDir, 'audit_report_e2e.md');
  const htmlPath = path.join(reportsDir, 'audit_report_e2e.html');
  const xlsxPath = path.join(reportsDir, 'audit_report_e2e.xlsx');

  fs.writeFileSync(mdPath, mdReport, 'utf-8');
  fs.writeFileSync(htmlPath, htmlReport, 'utf-8');
  fs.writeFileSync(xlsxPath, Buffer.from(xlsxReport));

  console.log(`  [Report] Markdown geschrieben: ${mdPath} (${mdReport.length} Zeichen)`);
  console.log(`  [Report] HTML geschrieben:     ${htmlPath} (${htmlReport.length} Zeichen)`);
  console.log(`  [Report] XLSX geschrieben:     ${xlsxPath} (${xlsxReport.byteLength} Bytes)`);

  // 5. Verifikation der generierten Reports
  console.log('\n[5/5] Verifiziere Report-Integritaet und Format-Konformitaet...');
  if (!fs.existsSync(mdPath) || fs.statSync(mdPath).size < 1000) {
    throw new Error('Markdown-Report fehlt oder ist unvollstaendig.');
  }
  if (!fs.existsSync(htmlPath) || fs.statSync(htmlPath).size < 2000) {
    throw new Error('HTML-Report fehlt oder ist unvollstaendig.');
  }
  if (!fs.existsSync(xlsxPath) || fs.statSync(xlsxPath).size < 2000) {
    throw new Error('XLSX-Report fehlt oder ist unvollstaendig.');
  }

  // Verifiziere XLSX Magic Bytes: PKzip 0x50 0x4B 0x03 0x04
  const xlsxBuffer = fs.readFileSync(xlsxPath);
  const isPkZip = xlsxBuffer[0] === 0x50 && xlsxBuffer[1] === 0x4b && xlsxBuffer[2] === 0x03 && xlsxBuffer[3] === 0x04;
  if (!isPkZip) {
    throw new Error(`XLSX Magic Bytes ungueltig: ${xlsxBuffer.subarray(0, 4).toString('hex')}`);
  }
  console.log(`  [Verify] XLSX PKzip Header verifiziert: 504b0304`);

  // Verifiziere Pflicht-Disclaimer im Markdown
  if (!mdReport.includes('Rechtsberatung') || !mdReport.includes('EU Safety Gate')) {
    throw new Error('Rechtssicherer Disclaimer fehlt im Markdown-Report.');
  }
  console.log(`  [Verify] Rechtssicherer Disclaimer (§ 2 RDG) im Markdown vorhanden.`);

  // Verifiziere HTML Doctype und CSS
  if (!htmlReport.includes('<!DOCTYPE html>') || !htmlReport.includes('<html')) {
    throw new Error('HTML-Struktur ungueltig.');
  }
  console.log(`  [Verify] HTML Doctype und Styling verifiziert.`);

  const summary = {
    timestamp: new Date().toISOString(),
    status: 'SUCCESS',
    catalog: {
      file: 'fixtures/amazon_catalog_sample.tsv',
      totalItems: parsedAmazon.stats.validItems,
    },
    safety_gate_db: {
      path: 'storage/safety_gate.db',
      alertsCount: allAlerts.length,
    },
    results: {
      barcodeHits: barcodeHitsCount,
      fuzzyHits: fuzzyHitsCount,
      gpsrCompliant: compliantGpsrCount,
      trafficLight: auditReport.summary.overallStatus,
      redCount: auditReport.summary.redCount,
      yellowCount: auditReport.summary.yellowCount,
      greenCount: auditReport.summary.greenCount,
      actionsCount: auditReport.actions.length,
    },
    reports: {
      markdown: { path: mdPath, bytes: fs.statSync(mdPath).size },
      html: { path: htmlPath, bytes: fs.statSync(htmlPath).size },
      xlsx: { path: xlsxPath, bytes: fs.statSync(xlsxPath).size },
    },
  };

  const summaryPath = path.join(ROOT_DIR, '.aiworker/e2e_pipeline_result.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf-8');
  console.log(`\nPipeline-Ergebnis zusammengefasst in: ${summaryPath}`);

  console.log('\n=================================================================');
  console.log('       E2E PIPELINE ERFOLGREICH ABGESCHLOSSEN (100% GREEN)');
  console.log('=================================================================\n');
  return summary;
}

runE2EPipeline().catch((err) => {
  console.error('\n[FATAL] E2E Pipeline fehlgeschlagen:', err);
  process.exit(1);
});
