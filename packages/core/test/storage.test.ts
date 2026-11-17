import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  type IAlertStorage,
  type AlertSearchQuery,
  MemoryAlertStorage,
  SqliteAlertStorage,
} from '../src/storage.js';
import { type AlertRecord, normalizeAlerts } from '../src/schema.js';
import { parseSafetyGateFileSync } from '../src/parser.js';

describe('storage - IAlertStorage, MemoryAlertStorage & SqliteAlertStorage', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/safety_gate_2026_45.xml');

  const sampleAlerts: AlertRecord[] = [
    {
      alert_number: 'A01',
      case_number: 'SR/0001/26',
      publication_date: '10-11-2026',
      category: 'Clothing, textiles and fashion items',
      product: "Children's jacket",
      brand: 'Jojo Maman Bébé',
      model: 'C52-683-145-000161',
      ean_barcodes: ['5054298241091'],
      risk_type: 'Chemical, Environment',
      danger_description: 'High concentration of PFCA and PFOA toxic compounds.',
      measures: 'Withdrawal of the product from the market',
      notifying_country: 'Luxembourg',
      country_of_origin: "People's Republic of China",
      risk_level: 'Serious risk',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118633',
    },
    {
      alert_number: 'A02',
      case_number: 'SR/0002/26',
      publication_date: '10-11-2026',
      category: 'Clothing, textiles and fashion items',
      product: 'Outdoor Cap',
      brand: 's.Oliver',
      model: '10.2.17.25.271',
      ean_barcodes: ['4099979071513', '4006381333931'],
      risk_type: 'Chemical, Environment',
      danger_description: 'High concentration of PFCA compounds in outer fabric.',
      measures: 'Withdrawal of the product from the market',
      notifying_country: 'Luxembourg',
      country_of_origin: "People's Republic of China",
      risk_level: 'Serious risk',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118634',
    },
    {
      alert_number: 'A03',
      case_number: 'SR/0003/26',
      publication_date: '11-11-2026',
      category: 'Motor vehicles',
      product: 'Motorcycle',
      brand: 'Honda',
      model: 'CRF250R',
      ean_barcodes: [],
      risk_type: 'Injuries',
      danger_description: 'Handlebar pipe machining defect leading to loose handlebar.',
      measures: 'Recall of the product from end users',
      notifying_country: 'Portugal',
      country_of_origin: 'Japan',
      risk_level: 'Serious risk',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10119655',
    },
    {
      alert_number: 'A04',
      case_number: 'SR/0004/26',
      publication_date: '12-11-2026',
      category: 'Toys',
      product: 'Plush Doll Animal',
      brand: 'CuddlyToy',
      model: 'CT-2026',
      ean_barcodes: ['96385074'],
      risk_type: 'Choking',
      danger_description: 'Small parts can easily detach posing choking risk to infants.',
      measures: 'Ban on the marketing of the product',
      notifying_country: 'Germany',
      country_of_origin: 'Vietnam',
      risk_level: 'Serious risk',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10119999',
    },
  ];

  // Run the full test suite for both MemoryAlertStorage and SqliteAlertStorage
  const storagesToTest = [
    {
      name: 'MemoryAlertStorage',
      factory: () => new MemoryAlertStorage(),
    },
    {
      name: 'SqliteAlertStorage (:memory:)',
      factory: () => new SqliteAlertStorage(':memory:'),
    },
  ];

  for (const { name, factory } of storagesToTest) {
    describe(`${name} implementation`, () => {
      let storage: IAlertStorage;

      beforeEach(async () => {
        storage = factory();
        await storage.insertAlerts(sampleAlerts);
      });

      afterEach(async () => {
        await storage.close();
      });

      it('implements IAlertStorage interface with all required methods', () => {
        expect(typeof storage.insertAlerts).toBe('function');
        expect(typeof storage.getByEan).toBe('function');
        expect(typeof storage.findAlerts).toBe('function');
        expect(typeof storage.getWeeklyAlerts).toBe('function');
        expect(typeof storage.getAlertByNumber).toBe('function');
        expect(typeof storage.count).toBe('function');
        expect(typeof storage.clear).toBe('function');
        expect(typeof storage.close).toBe('function');
      });

      it('inserts alerts and returns correct count', async () => {
        const count = await storage.count();
        expect(count).toBe(4);

        const alertA01 = await storage.getAlertByNumber('A01');
        expect(alertA01).toBeDefined();
        expect(alertA01?.product).toBe("Children's jacket");
        expect(alertA01?.brand).toBe('Jojo Maman Bébé');
        expect(alertA01?.ean_barcodes).toEqual(['5054298241091']);
      });

      it('updates existing alerts on conflict without duplication (upsert)', async () => {
        const updatedA01: AlertRecord = {
          ...sampleAlerts[0],
          product: "Children's Waterproof Jacket",
          measures: 'Destroyed at customs',
        };

        const inserted = await storage.insertAlerts([updatedA01]);
        expect(inserted).toBe(1);

        const totalCount = await storage.count();
        expect(totalCount).toBe(4);

        const fetched = await storage.getAlertByNumber('A01');
        expect(fetched?.product).toBe("Children's Waterproof Jacket");
        expect(fetched?.measures).toBe('Destroyed at customs');
      });

      describe('getByEan', () => {
        it('finds alert by a single EAN string', async () => {
          const results = await storage.getByEan('5054298241091');
          expect(results).toHaveLength(1);
          expect(results[0].alert_number).toBe('A01');
          expect(results[0].brand).toBe('Jojo Maman Bébé');
        });

        it('finds alert when EAN is in an array with multiple barcodes', async () => {
          // A02 has both 4099979071513 and 4006381333931
          const res1 = await storage.getByEan('4099979071513');
          expect(res1).toHaveLength(1);
          expect(res1[0].alert_number).toBe('A02');

          const res2 = await storage.getByEan('4006381333931');
          expect(res2).toHaveLength(1);
          expect(res2[0].alert_number).toBe('A02');
        });

        it('finds multiple alerts when searching with an array of EANs', async () => {
          const results = await storage.getByEan(['5054298241091', '96385074']);
          expect(results).toHaveLength(2);
          const alertNumbers = results.map((r) => r.alert_number).sort();
          expect(alertNumbers).toEqual(['A01', 'A04']);
        });

        it('deduplicates results when an alert matches multiple queried EANs', async () => {
          // Both EANs belong to A02
          const results = await storage.getByEan(['4099979071513', '4006381333931']);
          expect(results).toHaveLength(1);
          expect(results[0].alert_number).toBe('A02');
        });

        it('matches formatted barcodes containing spaces or hyphens', async () => {
          const results = await storage.getByEan(' 5054-298-241091 ');
          expect(results).toHaveLength(1);
          expect(results[0].alert_number).toBe('A01');
        });

        it('returns empty array when EAN does not exist', async () => {
          const results = await storage.getByEan('9999999999999');
          expect(results).toEqual([]);
        });

        it('handles empty input gracefully', async () => {
          expect(await storage.getByEan('')).toEqual([]);
          expect(await storage.getByEan([])).toEqual([]);
        });
      });

      describe('findAlerts - Category and Freitext search', () => {
        it('searches alerts strictly by category (case-insensitive substring)', async () => {
          const clothingAlerts = await storage.findAlerts({ category: 'Clothing' });
          expect(clothingAlerts).toHaveLength(2);
          const numbers = clothingAlerts.map((a) => a.alert_number).sort();
          expect(numbers).toEqual(['A01', 'A02']);

          const vehicleAlerts = await storage.findAlerts({ category: 'Motor vehicles' });
          expect(vehicleAlerts).toHaveLength(1);
          expect(vehicleAlerts[0].alert_number).toBe('A03');

          const nonExistent = await storage.findAlerts({ category: 'Cosmetics' });
          expect(nonExistent).toHaveLength(0);
        });

        it('searches alerts by Freitext query in product, brand, and model', async () => {
          // Product name search
          const jacketSearch = await storage.findAlerts({ query: 'jacket' });
          expect(jacketSearch).toHaveLength(1);
          expect(jacketSearch[0].alert_number).toBe('A01');

          // Brand search
          const hondaSearch = await storage.findAlerts({ query: 'Honda' });
          expect(hondaSearch).toHaveLength(1);
          expect(hondaSearch[0].alert_number).toBe('A03');

          // Model search
          const modelSearch = await storage.findAlerts({ query: 'CRF250R' });
          expect(modelSearch).toHaveLength(1);
          expect(modelSearch[0].alert_number).toBe('A03');
        });

        it('searches alerts by Freitext query in danger description and risk type', async () => {
          // Danger description term
          const pfoaSearch = await storage.findAlerts({ query: 'PFOA' });
          expect(pfoaSearch).toHaveLength(1);
          expect(pfoaSearch[0].alert_number).toBe('A01');

          // Risk type term
          const chokingSearch = await storage.findAlerts({ query: 'Choking' });
          expect(chokingSearch).toHaveLength(1);
          expect(chokingSearch[0].alert_number).toBe('A04');
        });

        it('supports multi-word Freitext queries matching all words', async () => {
          const multiSearch = await storage.findAlerts({ query: 'Jojo jacket' });
          expect(multiSearch).toHaveLength(1);
          expect(multiSearch[0].alert_number).toBe('A01');
        });

        it('supports passing plain string directly as Freitext query', async () => {
          const directStringSearch = await storage.findAlerts('Plush Doll');
          expect(directStringSearch).toHaveLength(1);
          expect(directStringSearch[0].alert_number).toBe('A04');
        });

        it('combines category and Freitext filters simultaneously', async () => {
          // Both clothing and chemical risk
          const combined1 = await storage.findAlerts({
            category: 'Clothing',
            query: 'Cap',
          });
          expect(combined1).toHaveLength(1);
          expect(combined1[0].alert_number).toBe('A02');

          // Category matches, but query does not match within that category
          const combinedNoMatch = await storage.findAlerts({
            category: 'Clothing',
            query: 'Motorcycle',
          });
          expect(combinedNoMatch).toHaveLength(0);
        });

        it('supports pagination with limit and offset', async () => {
          const allAlerts = await storage.findAlerts();
          expect(allAlerts).toHaveLength(4);

          const page1 = await storage.findAlerts({ limit: 2, offset: 0 });
          expect(page1).toHaveLength(2);

          const page2 = await storage.findAlerts({ limit: 2, offset: 2 });
          expect(page2).toHaveLength(2);

          expect(page1[0].alert_number).not.toBe(page2[0].alert_number);
        });

        it('filters by brand and country directly', async () => {
          const brandSearch = await storage.findAlerts({ brand: 's.Oliver' });
          expect(brandSearch).toHaveLength(1);
          expect(brandSearch[0].alert_number).toBe('A02');

          const countrySearch = await storage.findAlerts({ country_of_origin: 'Japan' });
          expect(countrySearch).toHaveLength(1);
          expect(countrySearch[0].alert_number).toBe('A03');
        });
      });

      describe('getWeeklyAlerts', () => {
        it('returns all weekly alerts by default ordered by recency', async () => {
          const weekly = await storage.getWeeklyAlerts();
          expect(weekly).toHaveLength(4);
          expect(weekly[0].publication_date >= weekly[weekly.length - 1].publication_date).toBe(true);
        });

        it('supports limit parameter as number or options object', async () => {
          const limitedNum = await storage.getWeeklyAlerts(2);
          expect(limitedNum).toHaveLength(2);

          const limitedObj = await storage.getWeeklyAlerts({ limit: 2 });
          expect(limitedObj).toHaveLength(2);
        });

        it('filters weekly alerts by year and week', async () => {
          // All samples have caseNumber ending in /26 and date in Nov 2026
          const year2026 = await storage.getWeeklyAlerts({ year: 2026 });
          expect(year2026).toHaveLength(4);

          const nonExistentYear = await storage.getWeeklyAlerts({ year: 1999 });
          expect(nonExistentYear).toHaveLength(0);
        });
      });

      describe('clear', () => {
        it('clears all alerts and EAN index completely', async () => {
          expect(await storage.count()).toBe(4);
          await storage.clear();
          expect(await storage.count()).toBe(0);
          expect(await storage.getByEan('5054298241091')).toEqual([]);
          expect(await storage.findAlerts()).toEqual([]);
        });
      });
    });
  }

  describe('Real Safety Gate Fixture Integration (75 alerts)', () => {
    it('populates and verifies both MemoryAlertStorage and SqliteAlertStorage against real fixture data', async () => {
      const report = parseSafetyGateFileSync(fixturePath);
      expect(report.notifications).toHaveLength(75);

      const normalizedList = normalizeAlerts(report.notifications);
      expect(normalizedList).toHaveLength(75);

      const memStorage = new MemoryAlertStorage();
      const sqlStorage = new SqliteAlertStorage(':memory:');

      try {
        const memCount = await memStorage.insertAlerts(normalizedList);
        const sqlCount = await sqlStorage.insertAlerts(normalizedList);

        expect(memCount).toBe(75);
        expect(sqlCount).toBe(75);
        expect(await memStorage.count()).toBe(75);
        expect(await sqlStorage.count()).toBe(75);

        // 1. Check getByEan with real barcode from fixture (Order 1: Jojo Maman Bébé)
        const memEan1 = await memStorage.getByEan('5054298241091');
        const sqlEan1 = await sqlStorage.getByEan('5054298241091');
        expect(memEan1).toHaveLength(1);
        expect(sqlEan1).toHaveLength(1);
        expect(memEan1[0].product).toBe("Children's jacket");
        expect(sqlEan1[0].product).toBe("Children's jacket");
        expect(sqlEan1[0].brand).toBe('Jojo Maman Bébé');

        // 2. Check getByEan with another real barcode from fixture (Order 2: s.Oliver)
        const memEan2 = await memStorage.getByEan('4099979071513');
        const sqlEan2 = await sqlStorage.getByEan('4099979071513');
        expect(memEan2).toHaveLength(1);
        expect(sqlEan2).toHaveLength(1);
        expect(memEan2[0].brand).toBe('s.Oliver');
        expect(sqlEan2[0].brand).toBe('s.Oliver');

        // 3. Category search: Motor vehicles
        const memVehicles = await memStorage.findAlerts({ category: 'Motor vehicles' });
        const sqlVehicles = await sqlStorage.findAlerts({ category: 'Motor vehicles' });
        expect(memVehicles.length).toBeGreaterThan(0);
        expect(sqlVehicles.length).toBe(memVehicles.length);

        // 4. Freitext search: 'phthalate' in danger description
        const memPhthalate = await memStorage.findAlerts({ query: 'phthalate' });
        const sqlPhthalate = await sqlStorage.findAlerts({ query: 'phthalate' });
        expect(memPhthalate.length).toBeGreaterThan(0);
        expect(sqlPhthalate.length).toBe(memPhthalate.length);

        // 5. Combined category and Freitext search
        const memCombined = await memStorage.findAlerts({
          category: 'Clothing, textiles and fashion items',
          query: 'Jacket',
        });
        const sqlCombined = await sqlStorage.findAlerts({
          category: 'Clothing, textiles and fashion items',
          query: 'Jacket',
        });
        expect(memCombined.length).toBeGreaterThan(0);
        expect(sqlCombined.length).toBe(memCombined.length);
      } finally {
        memStorage.close();
        sqlStorage.close();
      }
    });
  });

  describe('SqliteAlertStorage File Persistence', () => {
    it('persists data to an actual SQLite file on disk and reloads it', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-sqlite-test-'));
      const dbPath = path.join(tempDir, 'test_alerts.db');

      try {
        const db1 = new SqliteAlertStorage(dbPath);
        await db1.insertAlerts(sampleAlerts);
        expect(await db1.count()).toBe(4);
        db1.close();

        // Reopen same database file
        const db2 = new SqliteAlertStorage(dbPath);
        expect(await db2.count()).toBe(4);

        const found = await db2.getByEan('5054298241091');
        expect(found).toHaveLength(1);
        expect(found[0].brand).toBe('Jojo Maman Bébé');

        db2.close();
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
