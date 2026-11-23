import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { SqliteAlertStorage } from '@productsafetyengine/core';
import {
  syncSafetyGateHistory,
  generateWeekList,
  getIsoWeeksInYear,
  resolveSafetyGateDbPath,
  type HistoricalSyncResult,
} from '../src/history.js';
import { ComplianceFetcher } from '../src/fetcher.js';

describe('Safety Gate Historical Sync (syncSafetyGateHistory)', () => {
  let tempDir: string;
  let testDbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pse-history-test-'));
    testDbPath = path.join(tempDir, 'safety_gate_test.db');
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const sampleXmlWeek45 = `<?xml version="1.0" encoding="UTF-8"?>
<Safety-Gate>
  <report_year>2026</report_year>
  <report_week>45</report_week>
  <notifications>
    <order>1</order>
    <caseNumber>SR/03208/26</caseNumber>
    <publicationDate>10-11-2026</publicationDate>
    <category><![CDATA[Clothing, textiles and fashion items]]></category>
    <product><![CDATA[Children's jacket]]></product>
    <brand><![CDATA[BabyJoy]]></brand>
    <name><![CDATA[Baby Jacket Flower]]></name>
    <barcode><![CDATA[5054298241091]]></barcode>
    <riskType><![CDATA[Chemical]]></riskType>
    <danger><![CDATA[Toxic substances]]></danger>
    <level>Serious risk</level>
  </notifications>
</Safety-Gate>`;

  const sampleXmlWeek46 = `<?xml version="1.0" encoding="UTF-8"?>
<Safety-Gate>
  <report_year>2026</report_year>
  <report_week>46</report_week>
  <notifications>
    <order>1</order>
    <caseNumber>SR/03209/26</caseNumber>
    <publicationDate>17-11-2026</publicationDate>
    <category><![CDATA[Toys]]></category>
    <product><![CDATA[Wooden puzzle]]></product>
    <brand><![CDATA[ToyCraft]]></brand>
    <name><![CDATA[Forest Animals]]></name>
    <barcode><![CDATA[4006381333931]]></barcode>
    <riskType><![CDATA[Choking]]></riskType>
    <danger><![CDATA[Small wooden pieces]]></danger>
    <level>Serious risk</level>
  </notifications>
</Safety-Gate>`;

  const emptyXml = `<?xml version="1.0" encoding="UTF-8"?>
<Safety-Gate>
  <report_year>2026</report_year>
  <report_week>47</report_week>
</Safety-Gate>`;

  it('generates configured calendar week list for 2024-2026 by default or custom range', () => {
    const defaultList = generateWeekList({ startYear: 2024, endYear: 2026, weeks: [1, 2] });
    expect(defaultList.length).toBe(6);
    expect(defaultList[0]).toEqual({ year: 2024, week: 1 });
    expect(defaultList[5]).toEqual({ year: 2026, week: 2 });

    const singleYearList = generateWeekList({ years: [2025], startWeek: 10, endWeek: 12 });
    expect(singleYearList).toEqual([
      { year: 2025, week: 10 },
      { year: 2025, week: 11 },
      { year: 2025, week: 12 },
    ]);

    expect(getIsoWeeksInYear(2024)).toBe(52);
    expect(getIsoWeeksInYear(2026)).toBe(53);
  });

  it('syncs configured calendar weeks reliably into SqliteAlertStorage', async () => {
    const storage = new SqliteAlertStorage(testDbPath);

    const result = await syncSafetyGateHistory(storage, {
      weekRange: [
        { year: 2026, week: 45 },
        { year: 2026, week: 46 },
      ],
      customXmlProvider: (year, week) => {
        if (week === 45) return sampleXmlWeek45;
        if (week === 46) return sampleXmlWeek46;
        return null;
      },
    });

    expect(result.success).toBe(true);
    expect(result.totalWeeks).toBe(2);
    expect(result.syncedWeeks).toBe(2);
    expect(result.totalAlerts).toBe(2);
    expect(await storage.count()).toBe(2);

    const byEan = await storage.getByEan('5054298241091');
    expect(byEan.length).toBe(1);
    expect(byEan[0].brand).toBe('BabyJoy');

    storage.close();
  });

  it('persists alerts idempotently without duplicates on repeated runs', async () => {
    const storage = new SqliteAlertStorage(testDbPath);

    const runSync = () =>
      syncSafetyGateHistory(storage, {
        weekRange: [{ year: 2026, week: 45 }],
        customXmlProvider: () => sampleXmlWeek45,
      });

    const res1 = await runSync();
    expect(res1.totalAlerts).toBe(1);
    expect(await storage.count()).toBe(1);

    // Second run with the same data should upsert and keep count = 1
    const res2 = await runSync();
    expect(res2.totalAlerts).toBe(1);
    expect(await storage.count()).toBe(1);

    storage.close();
  });

  it('handles empty weeks and 404 errors without aborting, logging them cleanly', async () => {
    const storage = new SqliteAlertStorage(testDbPath);
    const loggedWarns: string[] = [];
    const loggedInfos: string[] = [];

    const mockLogger = {
      warn: (msg: string) => loggedWarns.push(msg),
      info: (msg: string) => loggedInfos.push(msg),
      error: vi.fn(),
    };

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('week=45')) {
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => sampleXmlWeek45,
          headers: new Headers(),
        };
      }
      if (url.includes('week=47')) {
        // Empty week
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => emptyXml,
          headers: new Headers(),
        };
      }
      // 404 Not Found for any other week
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        text: async () => 'Not Found',
        headers: new Headers(),
      };
    });

    const fetcher = new ComplianceFetcher({
      customFetch: mockFetch,
      checkRobotsTxt: false,
      requestsPerSecond: 100,
    });

    const result = await syncSafetyGateHistory(storage, {
      weekRange: [
        { year: 2026, week: 45 }, // 200 OK with alert
        { year: 2026, week: 47 }, // 200 OK empty
        { year: 2026, week: 48 }, // 404 Not Found
      ],
      fetcher,
      logger: mockLogger,
    });

    expect(result.success).toBe(true);
    expect(result.totalWeeks).toBe(3);
    expect(result.syncedWeeks).toBe(1);
    expect(result.emptyWeeks).toBe(1);
    expect(result.notFoundWeeks).toBe(1);
    expect(result.failedWeeks).toBe(0);
    expect(await storage.count()).toBe(1);

    // Check that 404 was logged
    expect(loggedWarns.some((w) => w.includes('HTTP 404 Not Found'))).toBe(true);
    // Check that empty week was logged
    expect(loggedInfos.some((i) => i.includes('empty week') || i.includes('0 alerts'))).toBe(true);

    storage.close();
  });

  it('ensures indexes for ean, brand, category, year and week exist in SQLite storage', async () => {
    const storage = new SqliteAlertStorage(testDbPath);

    // Populate some data to verify indexes work
    await storage.insertAlerts([
      {
        alert_number: 'TEST-001',
        case_number: 'SR/0015/25',
        brand: 'Sony',
        category: 'Electronics',
        product: 'Headphones',
        model: 'WH-1000XM5',
        ean_barcodes: ['4012345678901'],
        publication_date: '10-04-2025',
        risk_type: 'Electrical',
        danger_description: 'Battery overheat',
        measures: 'Withdrawal',
        notifying_country: 'Germany',
        country_of_origin: 'Japan',
        risk_level: 'Serious risk',
        source_url: 'https://example.com/alert/1',
      },
    ]);

    const indexes = storage.getIndexNames();
    expect(indexes).toContain('idx_alert_eans_ean');
    expect(indexes).toContain('idx_alerts_brand');
    expect(indexes).toContain('idx_alerts_category');
    expect(indexes).toContain('idx_alerts_year');
    expect(indexes).toContain('idx_alerts_week');

    // Verify search works across brand, category, and EAN
    const brandResults = await storage.findAlerts({ brand: 'Sony' });
    expect(brandResults.length).toBe(1);

    const categoryResults = await storage.findAlerts({ category: 'Electronics' });
    expect(categoryResults.length).toBe(1);

    const eanResults = await storage.getByEan('4012345678901');
    expect(eanResults.length).toBe(1);

    const weeklyResults = await storage.getWeeklyAlerts({ year: 2025, week: 15 });
    expect(weeklyResults.length).toBe(1);

    storage.close();
  });

  it('supports concurrency and tracks onProgress callbacks', async () => {
    const storage = new SqliteAlertStorage(testDbPath);
    const progressUpdates: number[] = [];

    const result = await syncSafetyGateHistory(storage, {
      weeks: [1, 2, 3, 4],
      years: [2026],
      concurrency: 2,
      customXmlProvider: (_year, week) => {
        if (week % 2 === 0) return sampleXmlWeek45;
        return emptyXml;
      },
      onProgress: (p) => {
        progressUpdates.push(p.percent);
      },
    });

    expect(result.totalWeeks).toBe(4);
    expect(result.syncedWeeks).toBe(2);
    expect(result.emptyWeeks).toBe(2);
    expect(progressUpdates.length).toBe(4);
    expect(progressUpdates[progressUpdates.length - 1]).toBe(100);

    storage.close();
  });

  it('initializes persistent SQLite storage at default or custom path when no storage is provided', async () => {
    const customDbFile = path.join(tempDir, 'custom_safety_gate.db');

    const result = await syncSafetyGateHistory({
      storagePath: customDbFile,
      weekRange: [{ year: 2026, week: 45 }],
      customXmlProvider: () => sampleXmlWeek45,
    });

    expect(result.success).toBe(true);
    expect(fs.existsSync(customDbFile)).toBe(true);

    const checkStorage = new SqliteAlertStorage(customDbFile);
    expect(await checkStorage.count()).toBe(1);
    checkStorage.close();
  });
});
