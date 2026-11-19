import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Actor } from 'apify';
import {
  PPE_EVENTS,
  PPE_EVENT_PRICES,
  ALL_PPE_EVENTS,
  PpeEventEmitter,
  type PPEEventType,
  ActorInputSchema,
  runActor,
  isApifyEnvironment,
  chargeApify,
  pushApifyData,
  main,
  isDirectExecution,
} from '../src/index.js';
import {
  MemoryAlertStorage,
  SqliteAlertStorage,
  EmptyDatabaseError,
  parseSafetyGateFileSync,
  normalizeAlerts,
} from '@productsafetyengine/core';

const ACTOR_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ACTOR_DIR, '../..');
const FIXTURE_PATH = path.resolve(REPO_ROOT, 'fixtures/safety_gate_2026_45.xml');

describe('F07: Apify Actor Struktur & Konfiguration', () => {
  describe('Akzeptanzkriterium 1: Valide Apify-Actor Metadaten (.actor/actor.json mit Node 22)', () => {
    const actorJsonPath = path.join(ACTOR_DIR, '.actor/actor.json');

    it('existiert am Pfad apps/actor/.actor/actor.json', () => {
      expect(fs.existsSync(actorJsonPath)).toBe(true);
    });

    it('ist valides JSON und entspricht der Apify Actor Specification 1', () => {
      const content = fs.readFileSync(actorJsonPath, 'utf-8');
      const data = JSON.parse(content);

      expect(data).toBeTypeOf('object');
      expect(data.actorSpecification).toBe(1);
      expect(data.name).toBeTypeOf('string');
      expect(data.name.length).toBeGreaterThan(0);
      expect(data.title).toBeTypeOf('string');
      expect(data.description).toBeTypeOf('string');
      expect(data.version).toBeTypeOf('string');
    });

    it('konfiguriert Node 22 als Runtime-Umgebung', () => {
      const content = fs.readFileSync(actorJsonPath, 'utf-8');
      const data = JSON.parse(content);

      // Node 22 in environmentVariables oder nodeVersion definiert
      const envNodeVersion = data.environmentVariables?.NODE_VERSION;
      const directNodeVersion = data.nodeVersion;
      const isNode22 = envNodeVersion === '22' || envNodeVersion === 22 || directNodeVersion === '22';

      // Zusaetzlich Pruefung des referenzierten Dockerfile
      const dockerfilePath = path.join(ACTOR_DIR, '.actor/Dockerfile');
      const dockerfileContent = fs.existsSync(dockerfilePath)
        ? fs.readFileSync(dockerfilePath, 'utf-8')
        : '';
      const dockerfileHasNode22 = dockerfileContent.includes('22');

      expect(isNode22 || dockerfileHasNode22).toBe(true);
      expect(envNodeVersion === '22' || directNodeVersion === '22').toBe(true);
    });

    it('fuehrt npm run build im Dockerfile aus (F01_BUILD_ENTRYPOINTS)', () => {
      const dockerfilePath = path.join(ACTOR_DIR, '.actor/Dockerfile');
      const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');
      expect(dockerfileContent).toMatch(/npm run build/);
    });

    it('referenziert existierende Input- und Dataset-Schemas', () => {
      const content = fs.readFileSync(actorJsonPath, 'utf-8');
      const data = JSON.parse(content);

      expect(data.input).toBe('./input_schema.json');
      const resolvedInputPath = path.resolve(path.dirname(actorJsonPath), data.input);
      expect(fs.existsSync(resolvedInputPath)).toBe(true);

      expect(data.storages?.dataset).toBe('./dataset_schema.json');
      const resolvedDatasetPath = path.resolve(path.dirname(actorJsonPath), data.storages.dataset);
      expect(fs.existsSync(resolvedDatasetPath)).toBe(true);
    });
  });

  describe('Akzeptanzkriterium 2: Input-Schema mit Filtern (EAN, Kategorie, Suchbegriff, Woche)', () => {
    const inputSchemaPath = path.join(ACTOR_DIR, '.actor/input_schema.json');

    it('existiert und ist valides JSON-Schema gemaess Apify Specification', () => {
      expect(fs.existsSync(inputSchemaPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(inputSchemaPath, 'utf-8'));

      expect(data.schemaVersion).toBe(1);
      expect(data.type).toBe('object');
      expect(data.properties).toBeTypeOf('object');
    });

    it('enthaelt Filter fuer EAN, Kategorie, Suchbegriff und Woche', () => {
      const data = JSON.parse(fs.readFileSync(inputSchemaPath, 'utf-8'));
      const props = data.properties;

      // Filter 1: EAN / Barcode
      expect(props.ean).toBeDefined();
      expect(props.ean.type).toBe('string');
      expect(props.ean.title.toLowerCase()).toContain('ean');

      // Filter 2: Kategorie / Category
      expect(props.category).toBeDefined();
      expect(props.category.type).toBe('string');
      expect(props.category.title.toLowerCase()).toMatch(/kategorie|category/);

      // Filter 3: Suchbegriff / Query
      expect(props.query).toBeDefined();
      expect(props.query.type).toBe('string');
      expect(props.query.title.toLowerCase()).toMatch(/suchbegriff|search|query/);

      // Filter 4: Woche / Week
      expect(props.week).toBeDefined();
      expect(props.week.type).toBe('string');
      expect(props.week.title.toLowerCase()).toMatch(/woche|week/);

      // Optional/Konfigurierbar: maxItems
      expect(props.maxItems).toBeDefined();
      expect(props.maxItems.type).toBe('integer');
    });

    it('stellt dataset_schema.json in apps/actor/ bereit', () => {
      const datasetPath = path.join(ACTOR_DIR, 'dataset_schema.json');
      expect(fs.existsSync(datasetPath)).toBe(true);

      const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));
      const props = dataset.fields ? dataset.fields.properties : dataset.properties;
      const type = dataset.fields ? dataset.fields.type : dataset.type;
      expect(type).toBe('object');
      expect(props.alert_number).toBeDefined();
      expect(props.category).toBeDefined();
      expect(props.product).toBeDefined();
      expect(props.ean_barcodes).toBeDefined();
      expect(props.risk_type).toBeDefined();
    });

    it('validiert und normalisiert ActorInput via Zod-Schema inkl. Aliassen', () => {
      const parsed1 = ActorInputSchema.parse({
        ean: ' 5054298241091 ',
        category: ' Toys ',
        query: ' wooden puzzle ',
        week: ' 2026-W45 ',
        maxItems: 50,
      });

      expect(parsed1.ean).toBe('5054298241091');
      expect(parsed1.category).toBe('Toys');
      expect(parsed1.query).toBe('wooden puzzle');
      expect(parsed1.week).toBe('2026-W45');
      expect(parsed1.maxItems).toBe(50);

      // Aliase fuer Suchbegriff (suchbegriff / searchTerm) und Woche (woche)
      const parsedAliases = ActorInputSchema.parse({
        suchbegriff: 'Puppenwagen',
        woche: '45',
      });
      expect(parsedAliases.query).toBe('Puppenwagen');
      expect(parsedAliases.week).toBe('45');
      expect(parsedAliases.maxItems).toBe(20); // Default capped at 20

      // Anti-Scraping Cap: values > 50 are clamped to 50
      const parsedClamped = ActorInputSchema.parse({ maxItems: 1000 });
      expect(parsedClamped.maxItems).toBe(50);
    });
  });

  describe('Akzeptanzkriterium 3: PPE-Ereignisse im Code als exportierte Typen/Konstanten definiert', () => {
    it('definiert und exportiert die geforderten PPE-Konstanten ean-checked und alert-returned', () => {
      expect(PPE_EVENTS.EAN_CHECKED).toBe('ean-checked');
      expect(PPE_EVENTS.ALERT_RETURNED).toBe('alert-returned');
      expect(PPE_EVENTS.QUERY_EXECUTED).toBe('query-executed');
      expect(PPE_EVENTS.WEEKLY_MONITORED).toBe('weekly-monitored');

      expect(ALL_PPE_EVENTS).toContain('ean-checked');
      expect(ALL_PPE_EVENTS).toContain('alert-returned');
    });

    it('definiert faire Pay-Per-Event Standard-Preise in USD', () => {
      expect(PPE_EVENT_PRICES['ean-checked']).toBe(0.005);
      expect(PPE_EVENT_PRICES['alert-returned']).toBe(0.0019);
      expect(PPE_EVENT_PRICES['query-executed']).toBe(0.002);
      expect(PPE_EVENT_PRICES['weekly-monitored']).toBe(0.020);
    });

    describe('PpeEventEmitter', () => {
      let emitter: PpeEventEmitter;

      beforeEach(() => {
        emitter = new PpeEventEmitter();
      });

      it('loest typisierte Ereignisse aus und ruft registrierte Listener auf', () => {
        const eanListener = vi.fn();
        const alertListener = vi.fn();

        emitter.on(PPE_EVENTS.EAN_CHECKED, eanListener);
        emitter.on(PPE_EVENTS.ALERT_RETURNED, alertListener);

        emitter.emitEanChecked({
          ean: '5054298241091',
          validGtin: true,
          matchCount: 1,
        });

        emitter.emitAlertReturned({
          alertNumber: 'A12/00001/26',
          product: 'Toy Car',
          category: 'Toys',
        });

        expect(eanListener).toHaveBeenCalledTimes(1);
        expect(eanListener).toHaveBeenCalledWith(
          expect.objectContaining({
            ean: '5054298241091',
            validGtin: true,
            matchCount: 1,
          })
        );

        expect(alertListener).toHaveBeenCalledTimes(1);
        expect(alertListener).toHaveBeenCalledWith(
          expect.objectContaining({
            alertNumber: 'A12/00001/26',
            product: 'Toy Car',
          })
        );
      });

      it('zaehlt Events und berechnet geschaetzte PPE-Kosten korrekt', () => {
        emitter.emitEanChecked({ ean: '5054298241091', validGtin: true, matchCount: 1 });
        emitter.emitEanChecked({ ean: '4099979071513', validGtin: true, matchCount: 0 });
        emitter.emitAlertReturned({ alertNumber: 'A12/00001/26' });
        emitter.emitAlertReturned({ alertNumber: 'A12/00002/26' });
        emitter.emitAlertReturned({ alertNumber: 'A12/00003/26' });
        emitter.emitQueryExecuted({ query: 'doll', totalMatches: 3 });

        expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(2);
        expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(3);
        expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);
        expect(emitter.getTotalEvents()).toBe(6);

        // Kosten: (2 * $0.005) + (3 * $0.0019) + (1 * $0.002) = 0.01 + 0.0057 + 0.002 = 0.0177 USD
        expect(emitter.calculateEstimatedCost()).toBe(0.0177);

        const breakdown = emitter.getCostBreakdown();
        expect(breakdown['ean-checked'].count).toBe(2);
        expect(breakdown['ean-checked'].totalCostUsd).toBe(0.01);
        expect(breakdown['alert-returned'].count).toBe(3);
        expect(breakdown['alert-returned'].totalCostUsd).toBe(0.0057);
      });

      it('unterstuetzt Apify ChargeHandler Callback Integration', () => {
        const chargeMock = vi.fn();
        const chargedEmitter = new PpeEventEmitter({ chargeHandler: chargeMock });

        chargedEmitter.emitEanChecked({ ean: '5054298241091', validGtin: true, matchCount: 1 });
        expect(chargeMock).toHaveBeenCalledWith('ean-checked', { count: 1, priceUsd: 0.005 });

        chargedEmitter.emitAlertReturned({ alertNumber: 'A12/00001/26' });
        expect(chargeMock).toHaveBeenCalledWith('alert-returned', { count: 1, priceUsd: 0.0019 });
      });

      it('zeichnet die Event-Historie auf und unterstuetzt reset()', () => {
        emitter.emitEanChecked({ ean: '5054298241091', validGtin: true, matchCount: 1 });
        expect(emitter.getHistory().length).toBe(1);
        expect(emitter.getHistory()[0].event).toBe('ean-checked');

        emitter.reset();
        expect(emitter.getHistory().length).toBe(0);
        expect(emitter.getTotalEvents()).toBe(0);
        expect(emitter.calculateEstimatedCost()).toBe(0);
      });
    });
  });

  describe('Akzeptanzkriterium 4: Unit-Tests & Integration mit Storage & Fixtures', () => {
    let storage: MemoryAlertStorage;

    beforeEach(() => {
      storage = new MemoryAlertStorage();
      const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
      const normalized = normalizeAlerts(parsed.notifications);
      storage.insertAlerts(normalized);
    });

    it('fuehrt EAN-Pruefung aus und loest ean-checked sowie alert-returned aus', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { ean: '5054298241091' },
        { storage, emitter }
      );

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items.some((i) => i.ean_barcodes.includes('5054298241091'))).toBe(true);

      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
      expect(result.totalCostUsd).toBeGreaterThan(0);
    });

    it('wirft EmptyDatabaseError, wenn der Storage vollstaendig leer ist', async () => {
      const emptyStorage = new SqliteAlertStorage(':memory:', { autoSeed: false });
      await expect(runActor({ ean: '5054298241091' }, { storage: emptyStorage })).rejects.toThrow(
        EmptyDatabaseError
      );
      emptyStorage.close();
    });

    it('loest ean-checked auch bei unbekannter EAN mit 0 Treffern aus', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { ean: '4000000000006' },
        { storage, emitter }
      );

      expect(result.items.length).toBe(0);
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(0);
    });

    it('filtert nach Kategorie und loest alert-returned fuer alle Treffer aus', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { category: 'Toys' },
        { storage, emitter }
      );

      expect(result.items.length).toBeGreaterThan(0);
      for (const item of result.items) {
        expect(item.category.toLowerCase()).toContain('toy');
      }

      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);
    });

    it('filtert nach Freitext-Suchbegriff (query)', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { query: 'chemical' },
        { storage, emitter }
      );

      expect(result.items.length).toBeGreaterThan(0);
      expect(emitter.getEventCount(PPE_EVENTS.QUERY_EXECUTED)).toBe(1);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(result.items.length);
    });

    it('beachtet das maxItems Limit', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        { maxItems: 5 },
        { storage, emitter }
      );

      expect(result.items.length).toBe(5);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(5);
    });
  });

  describe('F02_BATCH_EAN_SCREENING: Batch / batch EAN-Screening für E-Commerce-Kataloge', () => {
    let storage: MemoryAlertStorage;

    beforeEach(() => {
      storage = new MemoryAlertStorage();
      const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
      const normalized = normalizeAlerts(parsed.notifications);
      storage.insertAlerts(normalized);
    });

    it('Kriterium 1: ActorInputSchema akzeptiert eans: z.array(z.string()).optional() (batch)', () => {
      // 1. Array von EAN-Strings
      const parsedArray = ActorInputSchema.parse({
        eans: ['5054298241091', '4099979071513'],
      });
      expect(parsedArray.eans).toEqual(['5054298241091', '4099979071513']);

      // 2. Optional: undefined / nicht uebergeben
      const parsedEmpty = ActorInputSchema.parse({});
      expect(parsedEmpty.eans).toBeUndefined();

      // 3. Mehrzeiliger Text (z.B. aus Apify UI Textarea)
      const parsedMultiline = ActorInputSchema.parse({
        eans: '5054298241091\n4099979071513',
      });
      expect(parsedMultiline.eans).toEqual(['5054298241091', '4099979071513']);

      // 4. input_schema.json enthaelt eans als Typ array
      const inputSchemaPath = path.join(ACTOR_DIR, '.actor/input_schema.json');
      const data = JSON.parse(fs.readFileSync(inputSchemaPath, 'utf-8'));
      expect(data.properties.eans).toBeDefined();
      expect(data.properties.eans.type).toBe('array');
      expect(data.properties.eans.items?.type).toBe('string');
    });

    it('Kriterium 2: runActor([{ ean: "..." }]) und runActor([{ eans: ["...", "..."] }]) funktionieren nahtlos (batch)', async () => {
      // Test 2a: runActor mit Array aus einem Objekt mit ean
      const emitterA = new PpeEventEmitter();
      const resultA = await runActor(
        [{ ean: '5054298241091' }],
        { storage, emitter: emitterA }
      );
      expect(resultA.items.length).toBeGreaterThanOrEqual(1);
      expect(resultA.items.some((i) => i.ean_barcodes.includes('5054298241091'))).toBe(true);
      expect(emitterA.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(1);

      // Test 2b: runActor mit Array aus einem Objekt mit eans-Array
      const emitterB = new PpeEventEmitter();
      const resultB = await runActor(
        [{ eans: ['5054298241091', '4099979071513'] }],
        { storage, emitter: emitterB }
      );
      expect(resultB.items.length).toBeGreaterThanOrEqual(2);
      expect(resultB.items.some((i) => i.ean_barcodes.includes('5054298241091'))).toBe(true);
      expect(resultB.items.some((i) => i.ean_barcodes.includes('4099979071513'))).toBe(true);
      expect(emitterB.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(2);

      // Test 2c: runActor mit direktem Objekt { eans: [...] }
      const emitterC = new PpeEventEmitter();
      const resultC = await runActor(
        { eans: ['5054298241091', '4099979071513'] },
        { storage, emitter: emitterC }
      );
      expect(resultC.items.length).toBeGreaterThanOrEqual(2);
      expect(emitterC.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(2);
    });

    it('Kriterium 3: Ungültige EANs werden im Ergebnis als invalid_eans ausgewiesen (batch)', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        {
          eans: [
            '5054298241091',       // Gueltig mit Treffer
            'invalid-barcode-xyz', // Ungueltiges Format
            '5054298241090',       // Falsche Pruefziffer (ungueltig)
            '4000000000006',       // Gueltig, aber 0 Treffer im Storage
          ],
        },
        { storage, emitter }
      );

      expect(result.invalid_eans).toBeDefined();
      expect(result.invalid_eans).toContain('invalid-barcode-xyz');
      expect(result.invalid_eans).toContain('5054298241090');
      expect(result.invalid_eans).not.toContain('5054298241091');
      expect(result.invalid_eans).not.toContain('4000000000006');
      expect(result.invalid_eans.length).toBe(2);

      // Gueltige EANs werden trotzdem regulär zurueckgegeben
      expect(result.items.some((i) => i.ean_barcodes.includes('5054298241091'))).toBe(true);
    });

    it('Kriterium 4: EAN-Checked Events werden pro geprüfter EAN korrekt gezählt (batch)', async () => {
      const emitter = new PpeEventEmitter();
      const result = await runActor(
        {
          eans: [
            '5054298241091',       // EAN 1: gueltig, Treffer
            '4099979071513',       // EAN 2: gueltig, Treffer
            '4000000000006',       // EAN 3: gueltig, kein Treffer
            'invalid-barcode-999', // EAN 4: ungueltig
          ],
        },
        { storage, emitter }
      );

      // Exakt 4 EAN-Checked Events muessen ausgeloest worden sein
      expect(emitter.getEventCount(PPE_EVENTS.EAN_CHECKED)).toBe(4);
      expect(result.eventSummary[PPE_EVENTS.EAN_CHECKED]).toBe(4);

      // Pay-Per-Event Kosten fuer 4 x ean-checked: 4 * 0.005 USD = 0.020 USD
      const eanCheckedCost = 4 * PPE_EVENT_PRICES[PPE_EVENTS.EAN_CHECKED];
      expect(result.totalCostUsd).toBeGreaterThanOrEqual(eanCheckedCost);
    });
  });

  describe('F03_APIFY_SDK_SMITHERY: Apify SDK Runtime-Wiring & smithery.yaml', () => {
    let storage: MemoryAlertStorage;

    beforeEach(() => {
      vi.restoreAllMocks();
      storage = new MemoryAlertStorage();
      const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
      const normalized = normalizeAlerts(parsed.notifications);
      storage.insertAlerts(normalized);
    });

    describe('Akzeptanzkriterium 1: smithery.yaml im Root mit korrekter Startkonfiguration (npx eu-product-safety-mcp oder node apps/mcp/dist/index.js)', () => {
      const smitheryYamlPath = path.resolve(REPO_ROOT, 'smithery.yaml');
      const mcpPkgPath = path.resolve(REPO_ROOT, 'apps/mcp/package.json');

      it('smithery.yaml existiert im Root-Verzeichnis', () => {
        expect(fs.existsSync(smitheryYamlPath)).toBe(true);
      });

      it('enthält valide Startkonfiguration mit startCommand, type: stdio und akzeptiert node oder npx', () => {
        const content = fs.readFileSync(smitheryYamlPath, 'utf-8');
        expect(content).toContain('startCommand');
        expect(content).toMatch(/type:\s*['"]?stdio['"]?/);

        const isNpxConfig =
          /command:\s*['"]?npx['"]?/.test(content) && content.includes('eu-product-safety-mcp');
        const isNodeConfig =
          /command:\s*['"]?node['"]?/.test(content) && content.includes('apps/mcp/dist/index.js');

        expect(isNpxConfig || isNodeConfig).toBe(true);

        // Prüfen, dass der referenzierte Bin-Eintrag in apps/mcp/package.json existiert
        expect(fs.existsSync(mcpPkgPath)).toBe(true);
        const mcpPkg = JSON.parse(fs.readFileSync(mcpPkgPath, 'utf-8'));
        expect(mcpPkg.bin).toBeDefined();
        expect(mcpPkg.bin['eu-product-safety-mcp']).toBeDefined();
      });
    });

    describe('Akzeptanzkriterium 2: Actor.charge() wird in Apify-Umgebung aufgerufen (abgesichert für Offline-Tests)', () => {
      it('außerhalb der Apify-Umgebung (Offline-Modus): Actor.charge() wird nicht aufgerufen (Mock/Noop-Fallback)', async () => {
        const origAtHome = process.env.APIFY_IS_AT_HOME;
        delete process.env.APIFY_IS_AT_HOME;
        vi.spyOn(Actor, 'isAtHome').mockReturnValue(false);
        const chargeSpy = vi.spyOn(Actor, 'charge');

        const emitter = new PpeEventEmitter();
        emitter.emitEanChecked({ ean: '5054298241091', validGtin: true, matchCount: 1 });
        await emitter.waitForPendingCharges();

        expect(isApifyEnvironment()).toBe(false);
        expect(chargeSpy).not.toHaveBeenCalled();

        if (origAtHome !== undefined) process.env.APIFY_IS_AT_HOME = origAtHome;
      });

      it('in Apify-Umgebung: Actor.charge() wird mit { eventName, count } aufgerufen', async () => {
        vi.spyOn(Actor, 'isAtHome').mockReturnValue(true);
        const chargeSpy = vi.spyOn(Actor, 'charge').mockResolvedValue({
          eventChargeLimitReached: false,
          chargedCount: 1,
          chargeableWithinLimit: {},
        } as any);

        const emitter = new PpeEventEmitter();
        emitter.emitEanChecked({ ean: '5054298241091', validGtin: true, matchCount: 1 });
        await emitter.waitForPendingCharges();

        expect(chargeSpy).toHaveBeenCalledWith({
          eventName: PPE_EVENTS.EAN_CHECKED,
          count: 1,
        });
      });

      it('runActor() in Apify-Umgebung ruft Actor.charge() für Events und Actor.pushData() für Datensätze auf', async () => {
        vi.spyOn(Actor, 'isAtHome').mockReturnValue(true);
        const chargeSpy = vi.spyOn(Actor, 'charge').mockResolvedValue({} as any);
        const pushSpy = vi.spyOn(Actor, 'pushData').mockResolvedValue({} as any);

        const emitter = new PpeEventEmitter();
        const result = await runActor(
          { ean: '5054298241091' },
          { storage, emitter }
        );

        // ean-checked und alert-returned wurden über Actor.charge() abgerechnet
        expect(chargeSpy).toHaveBeenCalledWith(
          expect.objectContaining({ eventName: PPE_EVENTS.EAN_CHECKED })
        );
        expect(chargeSpy).toHaveBeenCalledWith(
          expect.objectContaining({ eventName: PPE_EVENTS.ALERT_RETURNED })
        );

        // Gefundene Alerts wurden an Actor.pushData() übergeben
        expect(pushSpy).toHaveBeenCalled();
        expect(result.items.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('Akzeptanzkriterium 3: apps/actor/src/index.ts führt Actor.main() beim direkten Container-Start aus', () => {
      it('main() ruft Actor.main(), Actor.getInput() und runActor() auf', async () => {
        let callbackExecuted = false;
        const mainSpy = vi.spyOn(Actor, 'main').mockImplementation(async (fn: any) => {
          callbackExecuted = true;
          await fn();
        });
        const getInputSpy = vi.spyOn(Actor, 'getInput').mockResolvedValue({ query: 'test' });

        await main();

        expect(mainSpy).toHaveBeenCalledTimes(1);
        expect(getInputSpy).toHaveBeenCalled();
        expect(callbackExecuted).toBe(true);
      });

      it('isDirectExecution() erkennt den direkten Container-Start korrekt', () => {
        expect(isDirectExecution('/app/apps/actor/dist/index.js')).toBe(true);
        expect(isDirectExecution('apps/actor/dist/index.js')).toBe(true);
        expect(isDirectExecution(undefined)).toBe(false);
      });
    });
  });

  describe('F04_STORE_METADATA_PRICING: Marktplatz-SEO, GPSR-Keywords & Pricing-Glättung', () => {
    const actorJsonPath = path.join(ACTOR_DIR, '.actor/actor.json');
    const pricingMdPath = path.resolve(REPO_ROOT, 'PRICING.md');
    const storeDescPath = path.resolve(REPO_ROOT, 'STORE_DESCRIPTION.md');
    const compliancePath = path.resolve(REPO_ROOT, 'COMPLIANCE.md');
    const readmePath = path.resolve(REPO_ROOT, 'README.md');

    it('Kriterium 1: actor.json enthält GPSR, EAN Check und korrekte Kategorien', () => {
      expect(fs.existsSync(actorJsonPath)).toBe(true);
      const data = JSON.parse(fs.readFileSync(actorJsonPath, 'utf-8'));

      expect(data.title).toContain('GPSR');
      expect(data.title).toContain('RAPEX');
      expect(data.title).toContain('EAN Compliance');
      expect(data.title).toBe('EU Safety Gate & Recall API (GPSR, RAPEX & EAN Compliance)');

      expect(data.description).toContain('EAN Check');
      expect(data.description).toContain('GPSR');

      expect(data.categories).toBeDefined();
      expect(Array.isArray(data.categories)).toBe(true);
      expect(data.categories).toContain('ECOMMERCE');
      expect(data.categories).toContain('AI');
      expect(data.categories).toContain('LEAD_GENERATION');
    });

    it('Kriterium 2: PRICING.md und PPE-Dokumentation spiegeln $1.90/1.000 Results wider', () => {
      expect(fs.existsSync(pricingMdPath)).toBe(true);
      const pricingContent = fs.readFileSync(pricingMdPath, 'utf-8');
      expect(pricingContent).toContain('1.90');
      expect(pricingContent).toMatch(/1\.90\s*\/\s*1\.?000\s*Results/i);

      // PPE-Dokumentation in STORE_DESCRIPTION.md und README.md
      const storeContent = fs.readFileSync(storeDescPath, 'utf-8');
      expect(storeContent).toContain('1.90');

      const readmeContent = fs.readFileSync(readmePath, 'utf-8');
      expect(readmeContent).toContain('1.90');
    });

    it('Kriterium 3: STORE_DESCRIPTION.md und COMPLIANCE.md sind konsistent und rechtssicher formuliert', () => {
      const storeContent = fs.readFileSync(storeDescPath, 'utf-8');
      expect(storeContent).toContain('REACH Chemical Recall Screening');

      const readmeContent = fs.readFileSync(readmePath, 'utf-8');
      expect(readmeContent).toContain('REACH Chemical Recall Screening');

      const compContent = fs.readFileSync(compliancePath, 'utf-8');
      expect(compContent).toContain('REACH Chemical Recall Screening');
      expect(compContent).toContain('2011/833/EU');
    });

    it('Kriterium 4: Metadaten-Validierungs-Test läuft fehlerfrei durch', () => {
      const a = JSON.parse(fs.readFileSync(actorJsonPath, 'utf-8'));
      expect(a.title.includes('GPSR')).toBe(true);
      expect(a.categories && a.categories.length >= 2).toBe(true);
      const p = fs.readFileSync(pricingMdPath, 'utf-8');
      expect(p.includes('1.90')).toBe(true);
    });
  });

  describe('Child & Baby Safety Pack Actor Filtering', () => {
    it('filters strictly for child products when childProductsOnly is true', async () => {
      const storage = new SqliteAlertStorage(':memory:', { autoSeed: true });
      const emitter = new PpeEventEmitter();

      const result = await runActor(
        { childProductsOnly: true, maxItems: 100 },
        { storage, emitter, pushData: false }
      );

      expect(result.items.length).toBe(26);
      expect(emitter.getEventCount(PPE_EVENTS.ALERT_RETURNED)).toBe(26);
    });

    it('filters child products by hazard: choking and chemical', async () => {
      const storage = new SqliteAlertStorage(':memory:', { autoSeed: true });
      const emitter = new PpeEventEmitter();

      const chokingResult = await runActor(
        { childProductsOnly: true, hazard: 'choking' },
        { storage, emitter, pushData: false }
      );
      expect(chokingResult.items.length).toBeGreaterThan(0);

      const chemicalResult = await runActor(
        { childProductsOnly: true, hazard: 'chemical' },
        { storage, emitter, pushData: false }
      );
      expect(chemicalResult.items.length).toBeGreaterThan(0);
    });
  });

  describe('F07: Actor Input-Schema erweitern (Zod + input_schema.json)', () => {
    const inputSchemaPath = path.join(ACTOR_DIR, '.actor/input_schema.json');

    it('Akzeptanzkriterium 1: input_schema.json ist valides JSON, webhookSecret hat isSecret: true', () => {
      expect(fs.existsSync(inputSchemaPath)).toBe(true);
      const raw = fs.readFileSync(inputSchemaPath, 'utf-8');

      let schema: any;
      expect(() => {
        schema = JSON.parse(raw);
      }).not.toThrow();

      expect(schema.schemaVersion).toBe(1);
      expect(schema.type).toBe('object');
      expect(schema.properties).toBeTypeOf('object');

      // webhookSecret hat isSecret: true
      const secretProp = schema.properties.webhookSecret;
      expect(secretProp).toBeDefined();
      expect(secretProp.type).toBe('string');
      expect(secretProp.isSecret).toBe(true);
      expect(secretProp.editor).toBe('textfield');

      // Gruppierung über sectionCaption im Schema: 'Amazon', 'Bulk CSV', 'Webhook'
      expect(schema.properties.asins.sectionCaption).toBe('Amazon');
      expect(schema.properties.csvUrl.sectionCaption).toBe('Bulk CSV');
      expect(schema.properties.webhookUrl.sectionCaption).toBe('Webhook');

      // Weitere Feld-Spezifikationen
      expect(schema.properties.csvContent.editor).toBe('textarea');
      expect(schema.properties.webhookFormat.editor).toBe('select');
      expect(schema.properties.webhookFormat.default).toBe('generic');
      expect(schema.properties.webhookFormat.enum).toEqual(['generic', 'slack', 'discord']);
      expect(schema.properties.webhookOnlyOnMatch.editor).toBe('checkbox');
      expect(schema.properties.webhookOnlyOnMatch.default).toBe(true);
      expect(schema.properties.asins.maxItems).toBe(1000);
      expect(schema.properties.amazonUrls.maxItems).toBe(1000);

      // Englische Beschreibungen mit Beispielen (Store-SEO)
      expect(schema.properties.asins.description).toMatch(/B08N5WRWNW|e\.g\./i);
      expect(schema.properties.amazonUrls.description).toMatch(/amazon|e\.g\./i);
      expect(schema.properties.csvUrl.description).toMatch(/https|e\.g\./i);
      expect(schema.properties.csvContent.description).toMatch(/CSV|MB/i);
      expect(schema.properties.webhookUrl.description).toMatch(/https|e\.g\./i);
      expect(schema.properties.webhookSecret.description).toMatch(/HMAC|e\.g\./i);
    });

    it('Akzeptanzkriterium 2: Zod lehnt csvUrl und webhookUrl mit http:// ab', () => {
      // csvUrl mit http:// wird abgelehnt
      expect(() =>
        ActorInputSchema.parse({ csvUrl: 'http://example.com/products.csv' })
      ).toThrow();

      // csvUrl mit https:// wird akzeptiert
      const validCsv = ActorInputSchema.parse({
        csvUrl: 'https://example.com/products.csv',
      });
      expect(validCsv.csvUrl).toBe('https://example.com/products.csv');

      // webhookUrl mit http:// wird abgelehnt
      expect(() =>
        ActorInputSchema.parse({ webhookUrl: 'http://hooks.slack.com/services/T00/B00/XXXX' })
      ).toThrow();

      // webhookUrl mit https:// wird akzeptiert
      const validWebhook = ActorInputSchema.parse({
        webhookUrl: 'https://hooks.slack.com/services/T00/B00/XXXX',
      });
      expect(validWebhook.webhookUrl).toBe('https://hooks.slack.com/services/T00/B00/XXXX');

      // Ungültige Protokolle werden ebenfalls abgelehnt
      expect(() => ActorInputSchema.parse({ csvUrl: 'ftp://example.com/data.csv' })).toThrow();
      expect(() => ActorInputSchema.parse({ webhookUrl: 'javascript:alert(1)' })).toThrow();
    });

    it('Akzeptanzkriterium 3: Die Feldnamen in Zod und JSON-Schema sind identisch (Test)', () => {
      const schema = JSON.parse(fs.readFileSync(inputSchemaPath, 'utf-8'));
      const jsonFields = Object.keys(schema.properties).sort();

      // 1. Zod Shape-Keys aus ActorInputSchema
      const zodShapeKeys = Object.keys(ActorInputSchema.shape).sort();
      expect(zodShapeKeys).toEqual(jsonFields);

      // 2. Keys des geparsten Default-Ergebnisobjekts
      const defaultParsed = ActorInputSchema.parse({});
      const parsedKeys = Object.keys(defaultParsed).sort();
      expect(parsedKeys).toEqual(jsonFields);

      // Sicherstellen, dass genau 18 Felder definiert sind
      expect(jsonFields).toHaveLength(18);
      expect(zodShapeKeys).toHaveLength(18);
    });

    it('Akzeptanzkriterium 4: Alle bestehenden Actor-Tests bleiben grün und alte Inputs parsen unverändert', () => {
      const parsed = ActorInputSchema.parse({
        ean: '5054298241091',
        category: 'Toys',
        query: 'wooden puzzle',
        week: '2026-W45',
        maxItems: 30,
      });

      expect(parsed.ean).toBe('5054298241091');
      expect(parsed.category).toBe('Toys');
      expect(parsed.query).toBe('wooden puzzle');
      expect(parsed.week).toBe('2026-W45');
      expect(parsed.maxItems).toBe(30);
      expect(parsed.webhookFormat).toBe('generic');
      expect(parsed.webhookOnlyOnMatch).toBe(true);

      // Aliase parsen wie gewohnt
      const aliasParsed = ActorInputSchema.parse({
        suchbegriff: 'Puppenwagen',
        woche: '45',
      });
      expect(aliasParsed.query).toBe('Puppenwagen');
      expect(aliasParsed.week).toBe('45');
    });

    it('Validiert Limits für asins, amazonUrls und csvContent', () => {
      // asins Limit: max 1.000
      const overAsins = Array.from({ length: 1001 }, (_, i) => `B${String(i).padStart(9, '0')}`);
      expect(() => ActorInputSchema.parse({ asins: overAsins })).toThrow();

      const okAsins = Array.from({ length: 1000 }, (_, i) => `B${String(i).padStart(9, '0')}`);
      expect(() => ActorInputSchema.parse({ asins: okAsins })).not.toThrow();

      // amazonUrls Limit: max 1.000
      const overUrls = Array.from({ length: 1001 }, (_, i) => `https://amazon.de/dp/B${String(i).padStart(9, '0')}`);
      expect(() => ActorInputSchema.parse({ amazonUrls: overUrls })).toThrow();

      const okUrls = Array.from({ length: 1000 }, (_, i) => `https://amazon.de/dp/B${String(i).padStart(9, '0')}`);
      expect(() => ActorInputSchema.parse({ amazonUrls: okUrls })).not.toThrow();

      // csvContent Limit: max 5 MB (5 * 1024 * 1024)
      const overCsv = 'X'.repeat(5 * 1024 * 1024 + 1);
      expect(() => ActorInputSchema.parse({ csvContent: overCsv })).toThrow();

      const validCsv = 'ean,asin,sku\n5054298241091,B08N5WRWNW,SKU-1';
      const parsedCsv = ActorInputSchema.parse({ csvContent: validCsv });
      expect(parsedCsv.csvContent).toBe(validCsv);

      // webhookFormat Enum-Validierung
      expect(() => ActorInputSchema.parse({ webhookFormat: 'unsupported' as any })).toThrow();
      expect(ActorInputSchema.parse({ webhookFormat: 'slack' }).webhookFormat).toBe('slack');
      expect(ActorInputSchema.parse({ webhookFormat: 'discord' }).webhookFormat).toBe('discord');

      // webhookOnlyOnMatch boolean
      expect(ActorInputSchema.parse({ webhookOnlyOnMatch: false }).webhookOnlyOnMatch).toBe(false);
      expect(ActorInputSchema.parse({ webhookOnlyOnMatch: 'false' as any }).webhookOnlyOnMatch).toBe(false);
      expect(ActorInputSchema.parse({ webhookOnlyOnMatch: true }).webhookOnlyOnMatch).toBe(true);
    });
  });
});
