import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  PPE_EVENTS,
  PPE_EVENT_PRICES,
  PpeEventEmitter,
  runActor,
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

describe('F08: Actor - ASIN- und Amazon-URL-Prüfung verdrahten', () => {
  let storage: MemoryAlertStorage;
  let parsedAlerts: AlertRecord[];

  beforeEach(async () => {
    storage = new MemoryAlertStorage();
    const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
    parsedAlerts = normalizeAlerts(parsed.notifications);

    // EAN 9780306406157 (entspricht ISBN-10 '0306406152') zu einem Alert hinzufügen,
    // um die ISBN-10-Konvertierung gegen die echten Fixtures zu prüfen
    parsedAlerts[0] = {
      ...parsedAlerts[0],
      ean_barcodes: [...parsedAlerts[0].ean_barcodes, '9780306406157'],
    };

    await storage.insertAlerts(parsedAlerts);
  });

  describe('Akzeptanzkriterium 1: Eine ISBN-10-ASIN, deren EAN in den Fixtures vorkommt, liefert einen Treffer mit resolution_method isbn10_conversion', () => {
    it('löst Standalone-ISBN-10 auf und liefert Treffer mit resolution_method=isbn10_conversion', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { asins: ['0306406152'] },
        { storage, emitter, pushData: false }
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const item = result.items[0];
      expect(item.resolution_method).toBe('isbn10_conversion');
      expect(item.input_identifier).toBe('0306406152');
      expect(item.input_kind).toBe('isbn10');
      expect(item.ean_barcodes).toContain('9780306406157');

      // Pay-Per-Event: ean-checked und alert-returned wurden ausgelöst
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
    });

    it('löst Amazon-URL mit ISBN-10 im Pfad auf und liefert resolution_method=isbn10_conversion', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { amazonUrls: ['https://www.amazon.de/dp/0306406152'] },
        { storage, emitter, pushData: false }
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const item = result.items[0];
      expect(item.resolution_method).toBe('isbn10_conversion');
      expect(item.input_kind).toBe('amazon_url');
      expect(item.input_identifier).toBe('https://www.amazon.de/dp/0306406152');
      expect(item.ean_barcodes).toContain('9780306406157');

      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
    });
  });

  describe('Akzeptanzkriterium 2: Eine Amazon-URL mit Titel im Pfad löst eine Suche aus, die als query-executed abgerechnet wird', () => {
    it('führt Keyword-Suche aus und rechnet query-executed ab', async () => {
      const emitter = new PpeEventEmitter();
      // Honda Motorcycle (Alert 75 in Fixtures)
      const result = await runActor(
        { amazonUrls: ['https://www.amazon.de/Motorcycle-Honda/dp/B08H93ZRK9'] },
        { storage, emitter, pushData: false }
      );

      // query-executed wurde abgerechnet
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);

      // Alert wurde gefunden und angereichert
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const matchedHonda = result.items.find(
        (i) => i.brand?.toLowerCase() === 'honda' || i.product?.toLowerCase().includes('motorcycle')
      );
      expect(matchedHonda).toBeDefined();
      expect(matchedHonda!.input_identifier).toBe('https://www.amazon.de/Motorcycle-Honda/dp/B08H93ZRK9');
      expect(matchedHonda!.input_kind).toBe('amazon_url');
      expect(matchedHonda!.resolution_method).toBe('url_slug_keywords');
      expect(matchedHonda!.match_confidence).toBe('keyword');

      // alert-returned für den Treffer abgerechnet
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
    });

    it('rechnet query-executed auch ab, wenn die Suche 0 Treffer liefert', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { amazonUrls: ['https://www.amazon.de/Unicorn-Rainbow-Space-Laser/dp/B08H93ZRK9'] },
        { storage, emitter, pushData: false }
      );

      // query-executed muss ausgelöst werden (Suchausführung fand statt)
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);
      expect(result.items.length).toBe(0);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(0);
    });
  });

  describe('Akzeptanzkriterium 3: Eine nicht auflösbare B0-ASIN verursacht keine PPE-Kosten und bricht den Run nicht ab', () => {
    it('bricht nicht ab, erzeugt 0 PPE-Kosten und erfasst die ASIN in unresolved', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { asins: ['B08H93ZRK9'] },
        { storage, emitter, pushData: false }
      );

      // Run bricht nicht ab
      expect(result).toBeDefined();
      expect(result.items).toHaveLength(0);

      // Keine PPE-Kosten
      expect(emitter.getTotalEvents()).toBe(0);
      expect(result.totalCostUsd).toBe(0);
      expect(result.ppeEventsTriggered).toBe(0);
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(0);
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(0);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(0);

      // In unresolved festgehalten
      expect(result.unresolved).toContain('B08H93ZRK9');
    });

    it('erfasst nicht auflösbare Amazon-URL ohne Titel in unresolved ohne Kosten', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { amazonUrls: ['https://www.amazon.de/dp/B08H93ZRK9'] },
        { storage, emitter, pushData: false }
      );

      expect(result.items).toHaveLength(0);
      expect(emitter.getTotalEvents()).toBe(0);
      expect(result.totalCostUsd).toBe(0);
      expect(result.unresolved).toContain('https://www.amazon.de/dp/B08H93ZRK9');
    });
  });

  describe('Akzeptanzkriterium 4: Die PPE-Event-Zählung wird über den Mock-Emitter geprüft', () => {
    it('prüft exakte PPE-Event-Zählung über Mock-Emitter für kombinierten Input', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        {
          asins: ['0306406152', 'B08H93ZRK9'],
          amazonUrls: ['https://www.amazon.de/Motorcycle-Honda/dp/B08H93ZRK9'],
        },
        { storage, emitter, pushData: false }
      );

      // 1. ISBN-10 '0306406152' -> 1x ean-checked
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);

      // 2. Amazon-URL mit Titel -> 1x query-executed
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);

      // 3. alert-returned für jeden gefundenen Alert
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
      expect(result.items.length).toBeGreaterThanOrEqual(2);

      // 4. B08H93ZRK9 ist unauflösbar und erzeugt 0 PPE-Events
      expect(result.unresolved).toContain('B08H93ZRK9');

      // 5. Gesamt-Event-Zählung und Kosten stimmen überein
      const expectedTotalEvents = 1 + 1 + result.items.length;
      expect(emitter.getTotalEvents()).toBe(expectedTotalEvents);
      expect(result.ppeEventsTriggered).toBe(expectedTotalEvents);

      const expectedCost =
        PPE_EVENT_PRICES[PPE_EVENTS.EAN_CHECKED] +
        PPE_EVENT_PRICES[PPE_EVENTS.QUERY_EXECUTED] +
        result.items.length * PPE_EVENT_PRICES[PPE_EVENTS.ALERT_RETURNED];
      expect(result.totalCostUsd).toBeCloseTo(expectedCost, 5);
      expect(result.eventSummary[PPE_EVENTS.EAN_CHECKED]).toBe(1);
      expect(result.eventSummary[PPE_EVENTS.QUERY_EXECUTED]).toBe(1);
      expect(result.eventSummary[PPE_EVENTS.ALERT_RETURNED]).toBe(result.items.length);
    });
  });

  describe('Zusatz-Integration: Provider-Mapping & RUN_SUMMARY KeyValueStore', () => {
    it('löst B0-ASIN über AsinEanProvider via csv_mapping auf', async () => {
      const emitter = new PpeEventEmitter();
      const provider = new MapAsinEanProvider({
        'B08H93ZRK9': '5054298241091', // Jojo Maman Bébé Alert 1
      });

      const result = await runActor(
        { asins: ['B08H93ZRK9'] },
        { storage, emitter, asinEanProvider: provider, pushData: false }
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      const item = result.items[0];
      expect(item.resolution_method).toBe('csv_mapping');
      expect(item.input_identifier).toBe('B08H93ZRK9');
      expect(item.input_kind).toBe('asin');
      expect(item.ean_barcodes).toContain('5054298241091');
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
    });

    it('schreibt unresolved Kennungen in RUN_SUMMARY des KeyValueStores', async () => {
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        { asins: ['B08H93ZRK9', 'B000000000'] },
        { storage, keyValueStore: mockKvStore, pushData: false }
      );

      expect(result.unresolved).toEqual(['B08H93ZRK9', 'B000000000']);
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'RUN_SUMMARY',
        expect.objectContaining({
          unresolved: ['B08H93ZRK9', 'B000000000'],
        })
      );
    });

    it('beachtet maxItems auch bei ASINs und URL-Suche', async () => {
      const emitter = new PpeEventEmitter();
      // query mit vielen Treffern, aber maxItems auf 1 gedrosselt
      const result = await runActor(
        {
          amazonUrls: ['https://www.amazon.de/Children-Jacket/dp/B08H93ZRK9'],
          maxItems: 1,
        },
        { storage, emitter, pushData: false }
      );

      expect(result.items.length).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(1);
    });
  });
});
