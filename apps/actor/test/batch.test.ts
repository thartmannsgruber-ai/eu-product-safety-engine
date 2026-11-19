import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import { Actor } from 'apify';
import {
  PPE_EVENTS,
  PpeEventEmitter,
  runActor,
  rewriteGoogleSheetsUrl,
  loadCsvContent,
  processBatchCsv,
  failActor,
  type BatchReport,
} from '../src/index.js';
import {
  MemoryAlertStorage,
  parseSafetyGateFileSync,
  normalizeAlerts,
  MapAsinEanProvider,
  type AlertRecord,
} from '@productsafetyengine/core';

const ACTOR_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ACTOR_DIR, '../..');
const FIXTURE_PATH = path.resolve(REPO_ROOT, 'fixtures/safety_gate_2026_45.xml');

describe('F09: Actor Bulk-CSV-Import', () => {
  let storage: MemoryAlertStorage;
  let parsedAlerts: AlertRecord[];

  beforeEach(async () => {
    storage = new MemoryAlertStorage();
    const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
    parsedAlerts = normalizeAlerts(parsed.notifications);
    await storage.insertAlerts(parsedAlerts);
  });

  describe('Akzeptanzkriterium 4: Ein Google-Sheets-Link wird korrekt in eine export?format=csv-URL umgeschrieben (Unit-Test)', () => {
    it('schreibt einen Google-Sheets-Edit-Link mit Freigabeparameter um', () => {
      const url = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing';
      const rewritten = rewriteGoogleSheetsUrl(url);
      expect(rewritten).toBe(
        'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=csv'
      );
    });

    it('behaelt gid aus dem Hash bei', () => {
      const url = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=12345678';
      const rewritten = rewriteGoogleSheetsUrl(url);
      expect(rewritten).toBe(
        'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=csv&gid=12345678'
      );
    });

    it('behaelt gid aus dem Query-Parameter bei', () => {
      const url = 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?gid=987654321';
      const rewritten = rewriteGoogleSheetsUrl(url);
      expect(rewritten).toBe(
        'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=csv&gid=987654321'
      );
    });

    it('schreibt Google-Sheets-Link mit /view oder ohne Suffix um', () => {
      const url1 = 'https://docs.google.com/spreadsheets/d/abc-123_XYZ/view';
      expect(rewriteGoogleSheetsUrl(url1)).toBe(
        'https://docs.google.com/spreadsheets/d/abc-123_XYZ/export?format=csv'
      );

      const url2 = 'https://docs.google.com/spreadsheets/d/abc-123_XYZ';
      expect(rewriteGoogleSheetsUrl(url2)).toBe(
        'https://docs.google.com/spreadsheets/d/abc-123_XYZ/export?format=csv'
      );
    });

    it('laesst regulaere URLs unveraendert', () => {
      const regularUrl = 'https://example.com/data/products.csv';
      expect(rewriteGoogleSheetsUrl(regularUrl)).toBe(regularUrl);
    });
  });

  describe('Akzeptanzkriterium 3: csvUrl mit http:// oder einer privaten IP wird vor jedem Netzwerkzugriff abgelehnt', () => {
    it('lehnt http:// URL vor Netzwerkzugriff ab und ruft Actor.fail auf', async () => {
      const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as any);
      const customFetch = vi.fn();

      await expect(
        loadCsvContent(
          { csvUrl: 'http://example.com/products.csv' },
          { customFetch }
        )
      ).rejects.toThrow(/csvUrl/);

      expect(customFetch).not.toHaveBeenCalled();
      expect(failSpy).toHaveBeenCalledWith(
        expect.stringMatching(/http/i)
      );
      failSpy.mockRestore();
    });

    it('lehnt private IPv4 (192.168.x.x, 10.x.x.x, 127.0.0.1) vor Netzwerkzugriff ab', async () => {
      const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as any);
      const customFetch = vi.fn();

      // 192.168.1.1
      await expect(
        loadCsvContent(
          { csvUrl: 'https://192.168.1.1/products.csv' },
          { customFetch }
        )
      ).rejects.toThrow(/csvUrl/);
      expect(customFetch).not.toHaveBeenCalled();

      // 10.0.0.1
      await expect(
        loadCsvContent(
          { csvUrl: 'https://10.0.0.1/products.csv' },
          { customFetch }
        )
      ).rejects.toThrow(/csvUrl/);
      expect(customFetch).not.toHaveBeenCalled();

      // 127.0.0.1
      await expect(
        loadCsvContent(
          { csvUrl: 'https://127.0.0.1:8080/products.csv' },
          { customFetch }
        )
      ).rejects.toThrow(/csvUrl/);
      expect(customFetch).not.toHaveBeenCalled();

      // localhost
      await expect(
        loadCsvContent(
          { csvUrl: 'https://localhost/products.csv' },
          { customFetch }
        )
      ).rejects.toThrow(/csvUrl/);
      expect(customFetch).not.toHaveBeenCalled();

      expect(failSpy).toHaveBeenCalled();
      failSpy.mockRestore();
    });

    it('lehnt private IP auch im runActor-Workflow ab', async () => {
      const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as any);
      const customFetch = vi.fn();

      const result = await runActor(
        { csvUrl: 'https://192.168.0.50/catalog.csv' },
        { storage, customFetch, pushData: false }
      );

      expect(result.error).toBeDefined();
      expect(result.items).toHaveLength(0);
      expect(customFetch).not.toHaveBeenCalled();
      expect(failSpy).toHaveBeenCalledWith(
        expect.stringMatching(/192\.168/i)
      );
      failSpy.mockRestore();
    });
  });

  describe('Akzeptanzkriterium 2: Doppelte EANs werden nur einmal abgerechnet', () => {
    it('rechnet gleiche EAN bei mehrfachem Vorkommen genau 1x als ean-checked ab', async () => {
      const emitter = new PpeEventEmitter();
      // EAN 5054298241091 taucht 4-mal auf (2x direkt, 1x via ASIN-Mapping, 1x als GTIN)
      // EAN 4099979071513 taucht 2-mal auf
      const csv = [
        'sku,ean,asin',
        'SKU-1,5054298241091,',
        'SKU-2,5054298241091,',
        'SKU-3,,B08N5WRWNW', // ASIN die in asinEanMap auf 5054298241091 gemappt ist
        'SKU-4,5054298241091,B08N5WRWNW', // Definiert das Mapping für B08N5WRWNW -> 5054298241091
        'SKU-5,4099979071513,',
        'SKU-6,4099979071513,',
      ].join('\n');

      const result = await processBatchCsv(
        { csvContent: csv },
        { storage, emitter }
      );

      // Genau 2 eindeutige gueltige EANs wurden geprueft
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(2);

      // Duplikate wurden korrekt gezaehlt: 6 Datenzeilen, 2 Unique = 4 Duplikate
      expect(result.report.duplicates).toBe(4);
      expect(result.report.validRows).toBe(6);
      expect(result.report.totalRows).toBe(6);
      expect(result.report.matchedRows).toBe(6); // Alle 6 Zeilen matchen die Alerts im Fixture
    });

    it('speichert gefundene Alert-Items fuer alle Zeilen inklusive sku, csv_row und input_identifier', async () => {
      const csv = [
        'sku,ean',
        'SKU-ALPHA,5054298241091',
        'SKU-BETA,5054298241091',
      ].join('\n');

      const result = await processBatchCsv(
        { csvContent: csv },
        { storage }
      );

      expect(result.items.length).toBe(2);
      expect(result.items[0].sku).toBe('SKU-ALPHA');
      expect(result.items[0].csv_row).toBe(2);
      expect(result.items[0].input_identifier).toBe('5054298241091');
      expect(result.items[0].alert_number).toBe('1');

      expect(result.items[1].sku).toBe('SKU-BETA');
      expect(result.items[1].csv_row).toBe(3);
      expect(result.items[1].input_identifier).toBe('5054298241091');
      expect(result.items[1].alert_number).toBe('1');
    });
  });

  describe('Akzeptanzkriterium 1: Eine CSV mit 1.000 Zeilen inkl. Duplikaten und ungültigen Zeilen wird in unter 3 s verarbeitet, die Werte in BATCH_REPORT stimmen', () => {
    it('verarbeitet 1.000 Zeilen in unter 3 s und liefert exakte BATCH_REPORT Werte', async () => {
      const kvStoreMap = new Map<string, unknown>();
      const mockKvStore = {
        setValue: vi.fn(async (key: string, val: unknown) => {
          kvStoreMap.set(key, val);
        }),
      };
      const emitter = new PpeEventEmitter();

      // Erzeuge 1.000 Zeilen:
      // - 10 ungueltige Zeilen (wissenschaftliche Excel-Notation) -> invalidRows
      // - 90 unaufloesbare Kennungen (Zufallstext) -> unresolved
      // - 900 Zeilen mit EANs:
      //   - 100 Zeilen mit EAN 5054298241091 (1 unique + 99 Duplikate, matches Alert 1)
      //   - 100 Zeilen mit EAN 4099979071513 (1 unique + 99 Duplikate, matches Alert 2)
      //   - 700 Zeilen mit gueltiger EAN 4006381333931 (1 unique + 699 Duplikate, kein Alert)
      // Duplikate insgesamt: 99 + 99 + 699 = 897 Duplikate
      // Resolved: 900 Zeilen
      // Matched Rows: 100 + 100 = 200 Zeilen
      const csvLines = ['sku,ean'];

      // 1. 10 ungueltige Zeilen (Excel-Notation)
      for (let i = 1; i <= 10; i++) {
        csvLines.push(`SKU-INV-${i},5.0543E+12`);
      }

      // 2. 90 unaufloesbare Kennungen
      for (let i = 1; i <= 90; i++) {
        csvLines.push(`SKU-UNRES-${i},NOT_AN_IDENTIFIER_${i}`);
      }

      // 3. 100 Zeilen EAN 5054298241091 (matches Alert 1)
      for (let i = 1; i <= 100; i++) {
        csvLines.push(`SKU-MATCH1-${i},5054298241091`);
      }

      // 4. 100 Zeilen EAN 4099979071513 (matches Alert 2)
      for (let i = 1; i <= 100; i++) {
        csvLines.push(`SKU-MATCH2-${i},4099979071513`);
      }

      // 5. 700 Zeilen EAN 4006381333931 (valid EAN, no Alert)
      for (let i = 1; i <= 700; i++) {
        csvLines.push(`SKU-VALID-${i},4006381333931`);
      }

      // Gesamt: genau 1.000 Datenzeilen
      expect(csvLines.length - 1).toBe(1000);

      const csvContent = csvLines.join('\n');

      const start = Date.now();
      const result = await processBatchCsv(
        { csvContent, maxItems: 50 },
        { storage, emitter, keyValueStore: mockKvStore }
      );
      const elapsed = Date.now() - start;

      // Kriterium: Verarbeitungszeit < 3.000 ms
      expect(elapsed).toBeLessThan(3000);
      expect(result.report.durationMs).toBeLessThan(3000);

      // Pruefung der BATCH_REPORT Werte
      const report = result.report;
      expect(report.totalRows).toBe(1000);
      expect(report.validRows).toBe(990);
      expect(report.invalidRows).toHaveLength(10);
      expect(report.resolved).toBe(900);
      expect(report.unresolved).toHaveLength(90);
      expect(report.duplicates).toBe(897);
      expect(report.matchedRows).toBe(200);

      // Key-Value-Store BATCH_REPORT geschrieben
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'BATCH_REPORT',
        expect.objectContaining({
          totalRows: 1000,
          validRows: 990,
          duplicates: 897,
          matchedRows: 200,
        })
      );

      // PPE-Accounting: genau 3 unique valid EANs abgerechnet
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(3);
    });
  });

  describe('Akzeptanzkriterium 5: Ohne CSV-Input bleibt das Verhalten des Actors unverändert', () => {
    it('laeuft ohne csvContent und ohne csvUrl vollstaendig im Standard-Modus', async () => {
      const emitter = new PpeEventEmitter();
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        { ean: '5054298241091' },
        { storage, emitter, keyValueStore: mockKvStore, pushData: false }
      );

      // Treffer wie bisher vorhanden
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].alert_number).toBe('1');
      expect(result.batchReport).toBeUndefined();

      // BATCH_REPORT wurde NICHT in KV-Store geschrieben, nur RUN_SUMMARY
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'RUN_SUMMARY',
        expect.anything()
      );
      expect(mockKvStore.setValue).not.toHaveBeenCalledWith(
        'BATCH_REPORT',
        expect.anything()
      );

      // PPE: 1x ean-checked
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
    });

    it('laeuft mit Suchbegriff (query) ohne CSV unverändert', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { query: 'jacket' },
        { storage, emitter, pushData: false }
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);
      expect(result.batchReport).toBeUndefined();
    });
  });

  describe('Fehlerbehandlung: Fehlerhafte CSV ergibt klare Fehlermeldung (Actor.fail mit Grund) statt eines Absturzes', () => {
    it('ruft Actor.fail auf, wenn CSV 5 MB ueberschreitet', async () => {
      const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as any);
      const hugeCsv = 'sku,ean\n' + 'SKU,5054298241091\n'.repeat(300_000); // > 5 MB

      const result = await runActor(
        { csvContent: hugeCsv },
        { storage, pushData: false }
      );

      expect(result.error).toMatch(/5 MB/i);
      expect(result.items).toHaveLength(0);
      expect(failSpy).toHaveBeenCalledWith(
        expect.stringMatching(/5 MB/i)
      );
      failSpy.mockRestore();
    });

    it('ruft Actor.fail auf, wenn Remote-Download fehlschlägt (404)', async () => {
      const failSpy = vi.spyOn(Actor, 'fail').mockResolvedValue(undefined as any);
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        headers: new Headers(),
        text: async () => 'Not Found',
        arrayBuffer: async () => new ArrayBuffer(0),
      });

      const result = await runActor(
        { csvUrl: 'https://example.com/notfound.csv' },
        { storage, customFetch: mockFetch, pushData: false }
      );

      expect(result.error).toMatch(/404/);
      expect(result.items).toHaveLength(0);
      expect(failSpy).toHaveBeenCalledWith(
        expect.stringMatching(/404/)
      );
      failSpy.mockRestore();
    });

    it('laedt CSV via Remote-URL erfolgreich herunter und ueberschreibt Google-Sheets-Links', async () => {
      const validCsv = 'sku,ean\nSKU-GDRIVE,5054298241091\n';
      const mockFetch = vi.fn().mockImplementation(async (url: string) => {
        // Sicherstellen, dass die umgeschriebene export-URL angefragt wurde
        expect(url).toContain('export?format=csv');
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-type': 'text/csv' }),
          text: async () => validCsv,
        };
      });

      const result = await runActor(
        { csvUrl: 'https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?usp=sharing' },
        { storage, customFetch: mockFetch, pushData: false }
      );

      expect(result.items).toHaveLength(1);
      expect(result.items[0].sku).toBe('SKU-GDRIVE');
      expect(result.items[0].csv_row).toBe(2);
      expect(result.items[0].input_identifier).toBe('5054298241091');
      expect(result.batchReport?.totalRows).toBe(1);
      expect(result.batchReport?.matchedRows).toBe(1);
    });
  });
});
