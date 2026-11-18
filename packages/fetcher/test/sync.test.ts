import { describe, it, expect, vi } from 'vitest';
import { SqliteAlertStorage } from '@productsafetyengine/core';
import { syncSafetyGate, buildSafetyGateWeeklyUrl } from '../src/sync.js';
import { ComplianceFetcher } from '../src/fetcher.js';

describe('Safety Gate Live-Data-Refresh (syncSafetyGate)', () => {
  const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<Safety-Gate>
  <report_language>en</report_language>
  <report_date>13/11/2026</report_date>
  <report_year>2026</report_year>
  <report_week>45</report_week>
  <notifications>
    <order>1</order>
    <caseNumber>SR/03208/26</caseNumber>
    <publicationDate>10-11-2026</publicationDate>
    <reference><![CDATA[https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118633]]></reference>
    <category><![CDATA[Clothing, textiles and fashion items]]></category>
    <product><![CDATA[Children's jacket]]></product>
    <brand><![CDATA[BabyJoy]]></brand>
    <name><![CDATA[Baby Jacket Flower]]></name>
    <barcode><![CDATA[5054298241091]]></barcode>
    <riskType><![CDATA[Chemical]]></riskType>
    <danger><![CDATA[High concentration of toxic substances.]]></danger>
    <measures><![CDATA[Withdrawal from market]]></measures>
    <notifyingCountry>Luxembourg</notifyingCountry>
    <countryOfOrigin>People's Republic of China</countryOfOrigin>
    <level>Serious risk</level>
  </notifications>
</Safety-Gate>`;

  it('builds official Safety Gate weekly URL correctly', () => {
    const url = buildSafetyGateWeeklyUrl(2026, 45);
    expect(url).toBe('https://ec.europa.eu/safety-gate-alerts/screen/webreport/download/xml?year=2026&week=45');

    const urlWithW = buildSafetyGateWeeklyUrl('2026', 'W46');
    expect(urlWithW).toBe('https://ec.europa.eu/safety-gate-alerts/screen/webreport/download/xml?year=2026&week=46');
  });

  it('syncs alerts from XML data directly into SQLite storage', async () => {
    const storage = new SqliteAlertStorage(':memory:', { autoSeed: false });
    expect(await storage.count()).toBe(0);

    const result = await syncSafetyGate(storage, {
      xmlData: sampleXml,
      year: 2026,
      week: 45,
    });

    expect(result.success).toBe(true);
    expect(result.alertsCount).toBe(1);
    expect(result.insertedCount).toBe(1);
    expect(await storage.count()).toBe(1);

    const matches = await storage.getByEan('5054298241091');
    expect(matches.length).toBe(1);
    expect(matches[0].brand).toBe('BabyJoy');

    storage.close();
  });

  it('is idempotent when syncing duplicate records', async () => {
    const storage = new SqliteAlertStorage(':memory:', { autoSeed: false });

    await syncSafetyGate(storage, { xmlData: sampleXml });
    expect(await storage.count()).toBe(1);

    // Second sync should upsert without increasing total count
    await syncSafetyGate(storage, { xmlData: sampleXml });
    expect(await storage.count()).toBe(1);

    storage.close();
  });

  it('syncs via mock ComplianceFetcher over HTTP', async () => {
    const storage = new SqliteAlertStorage(':memory:', { autoSeed: false });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => sampleXml,
      headers: new Headers({ 'etag': '"12345"' }),
    });

    const fetcher = new ComplianceFetcher({ customFetch: mockFetch, checkRobotsTxt: false });

    const result = await syncSafetyGate(storage, {
      url: 'https://ec.europa.eu/test-safety-gate.xml',
      fetcher,
    });

    expect(result.success).toBe(true);
    expect(result.alertsCount).toBe(1);
    expect(mockFetch).toHaveBeenCalled();
    expect(await storage.count()).toBe(1);

    storage.close();
  });

  it('throws an error if HTTP fetch fails', async () => {
    const storage = new SqliteAlertStorage(':memory:', { autoSeed: false });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => '',
      headers: new Headers(),
    });

    const fetcher = new ComplianceFetcher({ customFetch: mockFetch, checkRobotsTxt: false });

    await expect(
      syncSafetyGate(storage, {
        url: 'https://ec.europa.eu/missing.xml',
        fetcher,
      })
    ).rejects.toThrow('Failed to fetch Safety Gate XML');

    storage.close();
  });
});
