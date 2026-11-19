/**
 * apps/mcp/test/amazon-batch-tools.test.ts
 *
 * Unit-Tests fuer Feature F11:
 * - check_amazon_product({ input: ASIN oder Amazon-URL })
 * - check_product_batch({ identifiers: string[] (≤500), childProductsOnly? })
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  parseSafetyGateFileSync,
  normalizeAlerts,
  MemoryAlertStorage,
  type AlertRecord,
} from '@productsafetyengine/core';
import {
  createMcpServer,
  executeCheckAmazonProduct,
  executeCheckProductBatch,
  CheckAmazonProductSchema,
  CheckProductBatchSchema,
} from '../src/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.resolve(__dirname, '../../../fixtures/safety_gate_2026_45.xml');

describe('F11: MCP Tools check_amazon_product und check_product_batch', () => {
  let storage: MemoryAlertStorage;
  let server: ReturnType<typeof createMcpServer>;
  let client: Client;
  let clientTransport: InMemoryTransport;
  let serverTransport: InMemoryTransport;
  let fixtureAlerts: AlertRecord[];

  beforeEach(async () => {
    // 1. Fixture-Alerts laden
    const rawReport = parseSafetyGateFileSync(FIXTURE_PATH);
    fixtureAlerts = normalizeAlerts(rawReport.notifications).map((alert) => ({
      ...alert,
      year: rawReport.reportYear,
      week: rawReport.reportWeek,
    }));

    // Alert mit ISBN-13 barcode anreichern (entspricht ISBN-10 '0306406152')
    fixtureAlerts[0] = {
      ...fixtureAlerts[0],
      ean_barcodes: [...fixtureAlerts[0].ean_barcodes, '9780306406157'],
    };

    // 2. Storage aufsetzen
    storage = new MemoryAlertStorage();
    await storage.insertAlerts(fixtureAlerts);

    // Alert mit spezifischen Keywords und Brand hinzufuegen (fuer URL slug Suche)
    const retroAlert: AlertRecord & { year: string; week: string } = {
      alert_number: 'SR/02999/26',
      case_number: 'SR/02999/26',
      publication_date: '28-10-2026',
      category: 'Toys',
      product: 'Wooden Toy Train',
      brand: 'RetroTrain',
      model: 'RT-100',
      ean_barcodes: ['4012345678901'],
      risk_type: 'Choking',
      danger_description: 'Small wooden parts can easily detach and cause choking in infants.',
      measures: 'Withdrawal of the product from the market',
      notifying_country: 'Germany',
      country_of_origin: 'Poland',
      risk_level: 'Serious risk',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/sample-44',
      year: '2026',
      week: '44',
    };
    await storage.insertAlerts([retroAlert]);

    // 3. MCP Server verbinden
    server = createMcpServer({ storage });
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  // ==========================================================================
  // Akzeptanzkriterium 1: Beide Tools in Tool-Liste mit validem Input-Schema
  // ==========================================================================
  describe('Akzeptanzkriterium 1: Registrierung in Tool-Liste & valides Input-Schema', () => {
    it('listet check_amazon_product und check_product_batch in tools/list auf', async () => {
      const response = await client.listTools();
      const toolNames = response.tools.map((t) => t.name);

      expect(toolNames).toContain('check_amazon_product');
      expect(toolNames).toContain('check_product_batch');
    });

    it('besitzt Zod-Schemas und LLM-optimierte Beschreibungen mit FBA, GPSR, Bulk, Recall', async () => {
      const response = await client.listTools();

      const amazonTool = response.tools.find((t) => t.name === 'check_amazon_product');
      expect(amazonTool).toBeDefined();
      expect(amazonTool?.description).toContain('Amazon FBA');
      expect(amazonTool?.description).toContain('GPSR');
      expect(amazonTool?.description).toMatch(/recall/i);

      const batchTool = response.tools.find((t) => t.name === 'check_product_batch');
      expect(batchTool).toBeDefined();
      expect(batchTool?.description).toContain('Amazon FBA');
      expect(batchTool?.description).toContain('GPSR');
      expect(batchTool?.description).toContain('Bulk');
      expect(batchTool?.description).toMatch(/recall/i);

      // Validierung des Input-Schemas
      expect(amazonTool?.inputSchema.type).toBe('object');
      expect(amazonTool?.inputSchema.properties).toHaveProperty('input');
      expect(amazonTool?.inputSchema.required).toContain('input');

      expect(batchTool?.inputSchema.type).toBe('object');
      expect(batchTool?.inputSchema.properties).toHaveProperty('identifiers');
      expect(batchTool?.inputSchema.properties).toHaveProperty('childProductsOnly');
      expect(batchTool?.inputSchema.required).toContain('identifiers');
    });
  });

  // ==========================================================================
  // Tool: check_amazon_product Tests
  // ==========================================================================
  describe('Tool: check_amazon_product', () => {
    it('loest eine ISBN-10 ASIN auf und liefert Treffer', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: '0306406152' },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.resolved).toBe(true);
      expect(parsed.resolution.kind).toBe('isbn10');
      expect(parsed.resolution.resolution_method).toBe('isbn10_conversion');
      expect(parsed.resolution.ean).toBe('9780306406157');
      expect(parsed.match_count).toBeGreaterThanOrEqual(1);
      expect(parsed.alerts.length).toBeGreaterThanOrEqual(1);
    });

    it('loest eine Amazon-URL mit ISBN-10 auf', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: 'https://www.amazon.de/dp/0306406152' },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.resolved).toBe(true);
      expect(parsed.resolution.kind).toBe('amazon_url');
      expect(parsed.resolution.resolution_method).toBe('isbn10_conversion');
      expect(parsed.resolution.ean).toBe('9780306406157');
      expect(parsed.match_count).toBeGreaterThanOrEqual(1);
    });

    it('loest eine Amazon-URL mit Produkttitel-Keywords auf', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: 'https://www.amazon.de/RetroTrain-Wooden-Train/dp/B009999999' },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.resolved).toBe(true);
      expect(parsed.resolution.kind).toBe('amazon_url');
      expect(parsed.resolution.resolution_method).toBe('url_slug_keywords');
      expect(parsed.resolution.keywords).toContain('retrotrain');
      expect(parsed.match_count).toBeGreaterThanOrEqual(1);
      expect(parsed.alerts[0].brand).toBe('RetroTrain');
    });

    it('liefert Hinweis bei Kurzlinks (Redirect erforderlich)', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: 'https://amzn.to/3xyz' },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.resolved).toBe(false);
      expect(parsed.resolution.needsRedirect).toBe(true);
      expect(parsed.match_count).toBe(0);
      expect(parsed.note).toContain('Redirect');
    });

    it('liefert Hinweis bei nicht auflösbarer B0-ASIN ohne Titel im URL-Pfad', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: 'B08XYZ1234' },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.resolved).toBe(false);
      expect(parsed.match_count).toBe(0);
      expect(parsed.note).toBeDefined();
      expect(parsed.note).toContain('nicht auflösbar');
    });

    it('lehnt leeren Input mit Validierungsfehler ab', async () => {
      const res = await client.callTool({
        name: 'check_amazon_product',
        arguments: { input: '' },
      });

      expect(res.isError).toBe(true);
    });
  });

  // ==========================================================================
  // Akzeptanzkriterium 2: Gemischter Batch aus EAN, ISBN-ASIN, URL und ungültigen Einträgen
  // ==========================================================================
  describe('Akzeptanzkriterium 2: Gemischter Batch & korrekte Einzelergebnisse', () => {
    it('verarbeitet gemischten Batch korrekt pro Eintrag mit top_alerts[<=3] und Gesamtwerten', async () => {
      const mixedBatch = [
        '5054298241091', // 1. Direkte EAN mit Match (Jojo Maman Bébé)
        '0306406152', // 2. ISBN-10 ASIN mit Match (via 9780306406157)
        'https://www.amazon.de/RetroTrain-Wooden-Train/dp/B009999999', // 3. URL mit Keywords & Match
        'https://www.amazon.de/dp/0306406152', // 4. URL mit ISBN-10 ASIN & Match
        'https://amzn.to/3shortlink', // 5. Kurzlink (unaufgelöst, needsRedirect)
        'B08XYZ9999', // 6. B0-ASIN ohne Provider (unaufgelöst)
        'UNKNOWN_GARBAGE_12345', // 7. Ungültige Kennung
      ];

      const res = await client.callTool({
        name: 'check_product_batch',
        arguments: {
          identifiers: mixedBatch,
        },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      // Gesamtwerte
      expect(parsed.total).toBe(7);
      expect(parsed.total_identifiers).toBe(7);
      expect(parsed.resolved_count).toBe(4);
      expect(parsed.unresolved_count).toBe(3);
      expect(parsed.matched_count).toBe(4);
      expect(parsed.total_matches).toBeGreaterThanOrEqual(4);
      expect(parsed.summary).toEqual({
        total: 7,
        resolved: 4,
        unresolved: 3,
        matched: 4,
        total_matches: parsed.total_matches,
      });

      // Einzelergebnisse
      expect(parsed.results).toHaveLength(7);

      // 1. EAN
      const itemEan = parsed.results[0];
      expect(itemEan.input).toBe('5054298241091');
      expect(itemEan.kind).toBe('gtin');
      expect(itemEan.resolution_method).toBe('direct_gtin');
      expect(itemEan.match_count).toBe(1);
      expect(itemEan.top_alerts).toHaveLength(1);
      expect(itemEan.top_alerts[0].brand).toBe('Jojo Maman Bébé');

      // 2. ISBN-10 ASIN
      const itemIsbn = parsed.results[1];
      expect(itemIsbn.input).toBe('0306406152');
      expect(itemIsbn.kind).toBe('isbn10');
      expect(itemIsbn.resolution_method).toBe('isbn10_conversion');
      expect(itemIsbn.match_count).toBeGreaterThanOrEqual(1);
      expect(itemIsbn.top_alerts.length).toBeLessThanOrEqual(3);

      // 3. Amazon URL mit Titel-Keywords
      const itemUrlSlug = parsed.results[2];
      expect(itemUrlSlug.input).toContain('RetroTrain');
      expect(itemUrlSlug.kind).toBe('amazon_url');
      expect(itemUrlSlug.resolution_method).toBe('url_slug_keywords');
      expect(itemUrlSlug.match_count).toBe(1);
      expect(itemUrlSlug.top_alerts[0].brand).toBe('RetroTrain');

      // 4. Amazon URL mit ISBN-10 ASIN
      const itemUrlIsbn = parsed.results[3];
      expect(itemUrlIsbn.input).toBe('https://www.amazon.de/dp/0306406152');
      expect(itemUrlIsbn.kind).toBe('amazon_url');
      expect(itemUrlIsbn.resolution_method).toBe('isbn10_conversion');
      expect(itemUrlIsbn.match_count).toBeGreaterThanOrEqual(1);

      // 5. Kurzlink
      const itemShortlink = parsed.results[4];
      expect(itemShortlink.input).toBe('https://amzn.to/3shortlink');
      expect(itemShortlink.kind).toBe('amazon_url');
      expect(itemShortlink.resolution_method).toBeNull();
      expect(itemShortlink.match_count).toBe(0);
      expect(itemShortlink.top_alerts).toHaveLength(0);

      // 6. B0-ASIN unaufgelöst
      const itemAsin = parsed.results[5];
      expect(itemAsin.input).toBe('B08XYZ9999');
      expect(itemAsin.kind).toBe('asin');
      expect(itemAsin.resolution_method).toBeNull();
      expect(itemAsin.match_count).toBe(0);
      expect(itemAsin.top_alerts).toHaveLength(0);

      // 7. Ungültige Kennung
      const itemUnknown = parsed.results[6];
      expect(itemUnknown.input).toBe('UNKNOWN_GARBAGE_12345');
      expect(itemUnknown.kind).toBe('unknown');
      expect(itemUnknown.resolution_method).toBeNull();
      expect(itemUnknown.match_count).toBe(0);
      expect(itemUnknown.top_alerts).toHaveLength(0);
    });

    it('unterstuetzt den Filter childProductsOnly im Batch-Screening', async () => {
      // 5054298241091 ist 'Children\'s jacket' (Child product)
      const res = await client.callTool({
        name: 'check_product_batch',
        arguments: {
          identifiers: ['5054298241091'],
          childProductsOnly: true,
        },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);

      expect(parsed.childProductsOnly).toBe(true);
      expect(parsed.results[0].match_count).toBe(1);
    });
  });

  // ==========================================================================
  // Akzeptanzkriterium 3: Mehr als 500 Kennungen werden mit klarem Fehler abgelehnt
  // ==========================================================================
  describe('Akzeptanzkriterium 3: Limitierung auf höchstens 500 Kennungen', () => {
    it('lehnt mehr als 500 Kennungen im MCP-Clientaufruf ab (Zod Schema Validation)', async () => {
      const overlimit = new Array(501).fill('4012345678901');

      const res = await client.callTool({
        name: 'check_product_batch',
        arguments: {
          identifiers: overlimit,
        },
      });

      // Zod-Validierungsfehler fuehrt zu isError: true
      expect(res.isError).toBe(true);
      const contentList = res.content as Array<{ type: string; text: string }>;
      expect(contentList[0].text).toContain('500');
    });

    it('akzeptiert genau 500 Kennungen ohne Validierungsfehler', async () => {
      const exactly500 = new Array(500).fill('4012345678901');

      const res = await client.callTool({
        name: 'check_product_batch',
        arguments: {
          identifiers: exactly500,
        },
      });

      expect(res.isError).toBeFalsy();
      const contentList = res.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(contentList[0].text);
      expect(parsed.total).toBe(500);
      expect(parsed.results).toHaveLength(500);
    });

    it('executeCheckProductBatch lehnt mehr als 500 Kennungen bei Direktaufruf ab', async () => {
      const overlimit = new Array(505).fill('4012345678901');

      const res = await executeCheckProductBatch(
        { identifiers: overlimit },
        storage
      );

      expect(res.isError).toBe(true);
      const data = JSON.parse(res.content[0].text);
      expect(data.error).toContain('500');
    });
  });
});
