import { describe, it, expect } from 'vitest';
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
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../../..');

describe('End-to-End Pipeline Integration (F09)', () => {
  const tsvPath = path.join(ROOT_DIR, 'fixtures/amazon_catalog_sample.tsv');
  const xmlPath = path.join(ROOT_DIR, 'fixtures/safety_gate_2026_45.xml');

  it('verarbeitet einen realen Amazon Seller Central TSV Katalog vollstaendig', () => {
    expect(fs.existsSync(tsvPath)).toBe(true);
    const content = fs.readFileSync(tsvPath, 'utf-8');
    const parsed = parseAmazonInventoryReport(content);

    expect(parsed.stats.validItems).toBeGreaterThanOrEqual(5);
    expect(parsed.stats.delimiter).toBe('\t');
    expect(parsed.errors).toHaveLength(0);
    expect(parsed.items.length).toBe(parsed.stats.validItems);
  });

  it('gleicht Amazon-Katalog gegen persistente SQLite Safety Gate Datenbank ab (EAN + Fuzzy)', async () => {
    const storage = new SqliteAlertStorage(':memory:');
    const xml = fs.readFileSync(xmlPath, 'utf-8');
    const parsedXml = parseSafetyGateXml(xml);
    const alerts = normalizeAlerts(parsedXml.notifications);
    storage.insertAlertsSync(alerts);

    // 1. Exakter Barcode-Treffer fuer Jojo Maman Bébé Jacke (EAN 5054298241091)
    const hitsJojo = await storage.getByEan('5054298241091');
    expect(hitsJojo).toHaveLength(1);
    expect(hitsJojo[0].brand).toBe('Jojo Maman Bébé');
    expect(hitsJojo[0].risk_type).toContain('Chemical');

    // 2. Exakter Barcode-Treffer fuer s.Oliver Cap (EAN 4099979071513)
    const hitsSoliver = await storage.getByEan('4099979071513');
    expect(hitsSoliver).toHaveLength(1);
    expect(hitsSoliver[0].brand).toBe('s.Oliver');

    // 3. Fuzzy Match fuer HAPPY SMILE Schuhe (Modell 1072105714 ohne EAN)
    const allAlerts = await storage.findAlerts();
    const fuzzyResults = findMatchesForProduct(
      {
        brand: 'HAPPY SMILE',
        model: '1072105714',
        name: 'Children shoes with LED lights Flashing Shoes',
        category: 'Clothing, textiles and fashion items',
      },
      allAlerts,
      { minScore: 0.65 }
    );
    expect(fuzzyResults.length).toBeGreaterThan(0);
    expect(fuzzyResults[0].score).toBeGreaterThanOrEqual(0.85);
    expect(fuzzyResults[0].classification).toBe('Rot');
    expect(fuzzyResults[0].severity).toBe('RED');
  });

  it('generiert valide B2B-Auditberichte in allen 3 Formaten (MD, HTML, XLSX) mit Disclaimer', async () => {
    const storage = new SqliteAlertStorage(':memory:');
    const xml = fs.readFileSync(xmlPath, 'utf-8');
    const parsedXml = parseSafetyGateXml(xml);
    storage.insertAlertsSync(normalizeAlerts(parsedXml.notifications));

    const tsvContent = fs.readFileSync(tsvPath, 'utf-8');
    const parsed = parseAmazonInventoryReport(tsvContent);
    const allAlerts = await storage.findAlerts();

    const auditedItems = [];
    for (const item of parsed.items) {
      const raw = item.raw || {};
      const ean = item.ean || (item.productIdType === 'EAN' ? item.productId : undefined);
      const brand = raw.brand || '';
      const model = raw.model || '';
      const category = raw.category || '';
      const title = item.itemName || '';

      let barcodeHit = false;
      let barcodeMatch = undefined;
      if (ean) {
        const hits = await storage.getByEan(ean);
        if (hits.length > 0) {
          barcodeHit = true;
          barcodeMatch = {
            matched: true,
            alertNumber: hits[0].alert_number,
            riskType: hits[0].risk_type,
            riskLevel: hits[0].risk_level,
            dangerDescription: hits[0].danger_description,
          };
        }
      }

      let fuzzyMatch = undefined;
      if (!barcodeHit && (brand || model)) {
        const fHits = findMatchesForProduct({ brand, model, name: title, category }, allAlerts, { minScore: 0.65, limit: 1 });
        if (fHits.length > 0) {
          fuzzyMatch = fHits[0];
        }
      }

      const gpsrReport = checkGpsrListing({
        sku: item.sellerSku,
        asin: item.asin1 || item.asin,
        title,
        brand,
        model,
        responsiblePerson: raw['responsible-person-name'] ? {
          name: raw['responsible-person-name'],
          address: raw['responsible-person-address'],
          email: raw['responsible-person-email'],
        } : undefined,
        manufacturer: raw['manufacturer-name'] ? {
          name: raw['manufacturer-name'],
          address: raw['manufacturer-address'],
          email: raw['manufacturer-email'],
        } : undefined,
        warnings: raw['safety-warnings'] ? [raw['safety-warnings']] : [],
        ceMarking: raw['ce-marking'] === 'true',
      });

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

    const report = createAuditReport({
      merchantName: 'Enterprise Test Merchant',
      items: auditedItems,
      reportDate: new Date(),
    });

    // 1. Markdown Format
    const md = report.toMarkdown();
    expect(md.length).toBeGreaterThan(1000);
    expect(md).toContain('Rechtsberatung');
    expect(md).toContain('EU Safety Gate');
    expect(md).toContain('Enterprise Test Merchant');

    // 2. HTML Format
    const html = report.toHtml();
    expect(html.length).toBeGreaterThan(2000);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('Enterprise Test Merchant');

    // 3. XLSX Format
    const xlsx = report.toXlsx();
    expect(xlsx.byteLength).toBeGreaterThan(2000);
    // PKzip magic bytes (0x50, 0x4B, 0x03, 0x04)
    expect(xlsx[0]).toBe(0x50);
    expect(xlsx[1]).toBe(0x4b);
    expect(xlsx[2]).toBe(0x03);
    expect(xlsx[3]).toBe(0x04);
  });

  it('suspect zero-padded EAN never yields GREEN (F1 Integration)', () => {
    const rawTsv = [
      'seller-sku\tasin1\titem-name\tproduct-id\tproduct-id-type',
      'SKU-ZERO-EAN\tB08N5WRW99\tSuspect Toy\t4006380000000\t4',
    ].join('\n');

    const parsed = parseAmazonInventoryReport(rawTsv);
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].eanCorrupted).toBe(true);
    expect(parsed.items[0].ean).toBeUndefined();

    const report = createAuditReport({
      merchantName: 'Suspect Merchant',
      items: parsed.items,
    });

    expect(report.items[0].trafficLight).toBe('YELLOW');
    expect(report.items[0].trafficLight).not.toBe('GREEN');
    expect(report.summary.greenCount).toBe(0);
    expect(report.summary.yellowCount).toBe(1);
  });
});
