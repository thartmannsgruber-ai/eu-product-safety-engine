/**
 * apps/actor/src/actor.ts
 *
 * Apify Actor Kernlogik fuer EU Product Safety Gate (RAPEX).
 * Verarbeitet Input-Filter (EAN, Kategorie, Suchbegriff, Woche),
 * fuehrt Recherchen im Storage durch und triggert PPE-Events.
 */

import { z } from 'zod';
import { Actor } from 'apify';
import {
  type IAlertStorage,
  type AlertRecord,
  isValidEan,
  SqliteAlertStorage,
  EmptyDatabaseError,
  classifyChildProduct,
  resolveIdentifier,
  type AsinEanProvider,
} from '@productsafetyengine/core';
import { syncSafetyGate, type ComplianceFetcher } from '@productsafetyengine/fetcher';
import {
  PpeEventEmitter,
  PPE_EVENTS,
  type PPEEventType,
  isApifyEnvironment,
} from './ppe.js';
import {
  processBatchCsv,
  type BatchReport,
  failActor,
} from './batch.js';

/**
 * Helper to normalize strings for alias resolution (empty string -> undefined).
 */
function normalizeString(val: unknown): string | undefined {
  if (typeof val === 'string') {
    const trimmed = val.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Validates HTTPS outbound URLs, rejecting non-https schemes (e.g. http://).
 */
const httpsUrlSchema = z
  .string()
  .trim()
  .optional()
  .transform((val) => (val && val.length > 0 ? val : undefined))
  .pipe(
    z
      .string()
      .refine(
        (val) => {
          try {
            const parsed = new URL(val);
            return parsed.protocol === 'https:';
          } catch {
            return false;
          }
        },
        { message: 'URL must use HTTPS protocol' }
      )
      .optional()
  );

/**
 * Validates string array or multiline text up to 1,000 items.
 */
const arrayStringMax1000 = z
  .preprocess((val) => {
    if (typeof val === 'string') {
      const parts = val
        .split(/[\r\n,]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return parts.length > 0 ? parts : undefined;
    }
    if (Array.isArray(val)) {
      const parts = val
        .map((s) => (typeof s === 'string' ? s.trim() : s))
        .filter((s) => typeof s === 'string' && s.length > 0);
      return parts.length > 0 ? parts : undefined;
    }
    return val;
  }, z.array(z.string()).max(1000, 'Maximum 1,000 items allowed').optional());

/**
 * Underlying Zod Object schema representing the canonical ActorInput structure
 * matching .actor/input_schema.json properties.
 */
export const ActorInputObjectSchema = z.object({
  ean: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  eans: z
    .preprocess((val) => {
      if (typeof val === 'string') {
        const parts = val
          .split(/[\r\n,]+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return parts.length > 0 ? parts : undefined;
      }
      if (Array.isArray(val)) {
        const parts = val
          .map((s) => (typeof s === 'string' ? s.trim() : s))
          .filter((s) => typeof s === 'string' && s.length > 0);
        return parts.length > 0 ? parts : undefined;
      }
      return val;
    }, z.array(z.string()).optional()),
  category: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  query: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  week: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  childProductsOnly: z.coerce.boolean().optional(),
  ageGroup: z.enum(['baby', 'toddler', 'child', 'unknown']).optional(),
  hazard: z.enum(['choking', 'chemical', 'magnets']).optional(),
  refreshData: z.coerce.boolean().optional(),
  maxItems: z.coerce.number().int().positive().default(20).transform((val) => Math.min(val, 50)),
  asins: arrayStringMax1000,
  amazonUrls: arrayStringMax1000,
  csvUrl: httpsUrlSchema,
  csvContent: z
    .string()
    .max(5 * 1024 * 1024, 'csvContent must not exceed 5 MB')
    .optional()
    .transform((val) => (val && val.trim().length > 0 ? val : undefined)),
  webhookUrl: httpsUrlSchema,
  webhookFormat: z.enum(['generic', 'slack', 'discord']).default('generic'),
  webhookSecret: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
  webhookOnlyOnMatch: z.preprocess((val) => {
    if (val === undefined || val === null) return undefined;
    if (typeof val === 'string') {
      if (val === 'false' || val === '0') return false;
      if (val === 'true' || val === '1') return true;
    }
    return Boolean(val);
  }, z.boolean().default(true)),
});

/**
 * Zod-Schema fuer Actor-Inputs mit Filtern gemaess .actor/input_schema.json:
 * - ean: EAN-8, EAN-13, UPC oder GTIN Barcode
 * - eans: Array oder mehrzeiliger Text von Barcodes fuer Batch-Screening
 * - category: Produktkategorie
 * - query: Freitext-Suchbegriff (mit Aliassen searchTerm & suchbegriff)
 * - week: Publikationswoche (z.B. '2026-W45', '2026-45' oder '45')
 * - maxItems: Maximale Anzahl Datensaetze (Default 20, max. 50 gedrosselt gegen Scraping)
 * - asins: Array von Amazon ASINs (max. 1.000)
 * - amazonUrls: Array von Amazon Product URLs (max. 1.000)
 * - csvUrl: Remote CSV Download-URL (HTTPS-only)
 * - csvContent: Direkter CSV Textinhalt (max. 5 MB)
 * - webhookUrl: Webhook Ziel-URL (HTTPS-only)
 * - webhookFormat: generic | slack | discord (Default: generic)
 * - webhookSecret: HMAC SHA256 Secret
 * - webhookOnlyOnMatch: Boolean (Default: true)
 */
const baseActorInputSchema = z
  .preprocess((raw) => {
    if (Array.isArray(raw)) {
      if (raw.length === 0) return {};
      if (raw.length === 1) return raw[0];
      const allEans: string[] = [];
      const allAsins: string[] = [];
      const allAmazonUrls: string[] = [];
      let base: Record<string, unknown> = {};
      for (const item of raw) {
        if (item && typeof item === 'object') {
          base = { ...base, ...item };
          if ('ean' in item && typeof (item as any).ean === 'string' && (item as any).ean.trim()) {
            allEans.push((item as any).ean.trim());
          }
          if ('eans' in item) {
            const itemEans = (item as any).eans;
            if (Array.isArray(itemEans)) {
              for (const e of itemEans) {
                if (typeof e === 'string' && e.trim()) allEans.push(e.trim());
              }
            } else if (typeof itemEans === 'string' && itemEans.trim()) {
              allEans.push(
                ...itemEans
                  .split(/[\r\n,]+/)
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              );
            }
          }
          if ('asin' in item && typeof (item as any).asin === 'string' && (item as any).asin.trim()) {
            allAsins.push((item as any).asin.trim());
          }
          if ('asins' in item) {
            const itemAsins = (item as any).asins;
            if (Array.isArray(itemAsins)) {
              for (const a of itemAsins) {
                if (typeof a === 'string' && a.trim()) allAsins.push(a.trim());
              }
            } else if (typeof itemAsins === 'string' && itemAsins.trim()) {
              allAsins.push(
                ...itemAsins
                  .split(/[\r\n,]+/)
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              );
            }
          }
          if ('amazonUrls' in item) {
            const itemUrls = (item as any).amazonUrls;
            if (Array.isArray(itemUrls)) {
              for (const u of itemUrls) {
                if (typeof u === 'string' && u.trim()) allAmazonUrls.push(u.trim());
              }
            } else if (typeof itemUrls === 'string' && itemUrls.trim()) {
              allAmazonUrls.push(
                ...itemUrls
                  .split(/[\r\n,]+/)
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              );
            }
          }
        }
      }
      delete (base as Record<string, unknown>).ean;
      delete (base as Record<string, unknown>).asin;
      const query =
        normalizeString(base.query) ??
        normalizeString(base.searchTerm) ??
        normalizeString(base.suchbegriff);
      const week = normalizeString(base.week) ?? normalizeString(base.woche);
      return {
        ...base,
        ...(query !== undefined ? { query } : {}),
        ...(week !== undefined ? { week } : {}),
        eans: allEans.length > 0 ? allEans : undefined,
        asins: allAsins.length > 0 ? allAsins : undefined,
        amazonUrls: allAmazonUrls.length > 0 ? allAmazonUrls : undefined,
      };
    }
    if (raw && typeof raw === 'object') {
      const r = { ...(raw as Record<string, unknown>) };
      let asins = r.asins;
      if (!asins && 'asin' in r && typeof r.asin === 'string' && r.asin.trim()) {
        asins = [r.asin.trim()];
      }
      let amazonUrls = r.amazonUrls;
      if (!amazonUrls && 'amazonUrl' in r && typeof r.amazonUrl === 'string' && r.amazonUrl.trim()) {
        amazonUrls = [r.amazonUrl.trim()];
      }
      delete r.asin;
      delete r.amazonUrl;
      const query =
        normalizeString(r.query) ??
        normalizeString(r.searchTerm) ??
        normalizeString(r.suchbegriff);
      const week = normalizeString(r.week) ?? normalizeString(r.woche);
      return {
        ...r,
        ...(query !== undefined ? { query } : {}),
        ...(week !== undefined ? { week } : {}),
        ...(asins !== undefined ? { asins } : {}),
        ...(amazonUrls !== undefined ? { amazonUrls } : {}),
      };
    }
    return raw;
  }, ActorInputObjectSchema)
  .transform((data) => ({
    ean: data.ean,
    eans: data.eans,
    category: data.category,
    query: data.query,
    week: data.week,
    childProductsOnly: data.childProductsOnly,
    ageGroup: data.ageGroup,
    hazard: data.hazard,
    refreshData: data.refreshData,
    maxItems: data.maxItems,
    asins: data.asins,
    amazonUrls: data.amazonUrls,
    csvUrl: data.csvUrl,
    csvContent: data.csvContent,
    webhookUrl: data.webhookUrl,
    webhookFormat: data.webhookFormat,
    webhookSecret: data.webhookSecret,
    webhookOnlyOnMatch: data.webhookOnlyOnMatch,
  }));

export const ActorInputSchema = Object.assign(baseActorInputSchema, {
  shape: ActorInputObjectSchema.shape,
});

export type ActorInput = z.infer<typeof ActorInputSchema>;

export interface EnrichedAlertItem extends AlertRecord {
  input_identifier?: string;
  input_kind?: string;
  resolution_method?: string;
  match_confidence?: 'keyword' | string;
  sku?: string;
  csv_row?: number;
  is_child_related?: boolean;
  child_age_group?: string;
  child_hazards?: string[];
  [key: string]: unknown;
}

export interface ActorRunOptions {
  storage?: IAlertStorage;
  emitter?: PpeEventEmitter;
  pushData?: boolean;
  asinEanProvider?: AsinEanProvider;
  keyValueStore?: {
    setValue: (key: string, value: unknown) => Promise<void>;
  };
  fetcher?: ComplianceFetcher;
  customFetch?: typeof fetch;
  failActor?: (reason: string) => Promise<void> | void;
}

export interface ActorRunResult {
  items: EnrichedAlertItem[];
  totalCount: number;
  invalid_eans: string[];
  unresolved: string[];
  eventSummary: Record<PPEEventType, number>;
  totalCostUsd: number;
  ppeEventsTriggered: number;
  batchReport?: BatchReport;
  error?: string;
}

/**
 * Speichert einen Datensatz im Standard KeyValueStore von Apify via Actor.setValue().
 * Falls nicht in der Apify-Cloud ausgefuehrt (z.B. Offline-Tests), erfolgt ein sicherer No-op Fallback,
 * es sei denn, ein customStore wird in den Optionen uebergeben.
 */
export async function setApifyKeyValue(
  key: string,
  value: unknown,
  customStore?: { setValue: (key: string, value: unknown) => Promise<void> }
): Promise<void> {
  if (customStore && typeof customStore.setValue === 'function') {
    await customStore.setValue(key, value);
    return;
  }
  if (isApifyEnvironment()) {
    try {
      await Actor.setValue(key, value);
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn(`[Actor] Failed to setValue('${key}') in Apify KeyValueStore:`, err);
      }
    }
  }
}

/**
 * Exportiert Daten in das Standard-Dataset von Apify via Actor.pushData().
 * Falls nicht in der Apify-Cloud ausgefuehrt (z.B. Offline-Tests), erfolgt ein sicherer No-op Fallback.
 */
export async function pushApifyData(
  data: Record<string, unknown> | Record<string, unknown>[]
): Promise<void> {
  if (isApifyEnvironment()) {
    try {
      await Actor.pushData(data);
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Actor] Failed to pushData to Apify dataset:', err);
      }
    }
  }
}

/**
 * Fuehrt die Apify Actor Logik gemaess uebergebenem Input aus
 * und loest Pay-Per-Event (PPE) Ereignisse aus.
 */
export async function runActor(
  rawInput: unknown,
  options: ActorRunOptions = {}
): Promise<ActorRunResult> {
  const emitter = options.emitter ?? new PpeEventEmitter();

  let input: ActorInput;
  try {
    input = ActorInputSchema.parse(rawInput ?? {});
  } catch (err: any) {
    const reason = `Ungültiger Actor-Input: ${err?.message || String(err)}`;
    await failActor(reason, options.failActor);
    if (process.env.NODE_ENV !== 'test') {
      console.error(`[Actor] Input validation failed: ${reason}`);
    }
    return {
      items: [],
      totalCount: 0,
      invalid_eans: [],
      unresolved: [],
      eventSummary: emitter.getEventCounts(),
      totalCostUsd: emitter.calculateEstimatedCost(),
      ppeEventsTriggered: emitter.getTotalEvents(),
      error: reason,
    };
  }

  const storage =
    options.storage ??
    new SqliteAlertStorage(process.env.SQLITE_DB_PATH || ':memory:', { autoSeed: true });

  if (input.refreshData) {
    try {
      await syncSafetyGate(storage);
    } catch (err) {
      if (process.env.NODE_ENV !== 'test') {
        console.warn('[Actor] Live data refresh failed, proceeding with local database:', err);
      }
    }
  }

  const totalInDb = await storage.count();
  if (totalInDb === 0) {
    throw new EmptyDatabaseError(
      'Safety Gate database is uninitialized (0 records). Ensure autoSeed is active or data is populated.'
    );
  }

  const matchedAlerts: EnrichedAlertItem[] = [];
  const seenAlertNumbers = new Set<string>();
  const invalidEans: string[] = [];
  const unresolved: string[] = [];

  const addUniqueAlerts = (
    alerts: AlertRecord[],
    meta?: Partial<EnrichedAlertItem>
  ): void => {
    for (const alert of alerts) {
      if (!seenAlertNumbers.has(alert.alert_number)) {
        seenAlertNumbers.add(alert.alert_number);
        const enriched: EnrichedAlertItem = meta ? { ...alert, ...meta } : { ...alert };
        matchedAlerts.push(enriched);

        // Pay-Per-Event: 'alert-returned' fuer jeden zurueckgegebenen Alert
        emitter.emitAlertReturned({
          alertNumber: alert.alert_number,
          product: alert.product,
          brand: alert.brand,
          category: alert.category,
          riskType: alert.risk_type,
        });

        if (matchedAlerts.length >= input.maxItems) {
          break;
        }
      }
    }
  };

  // 0. Bulk-CSV-Import (F09)
  let batchReport: BatchReport | undefined;
  if (input.csvContent || input.csvUrl) {
    try {
      const batchResult = await processBatchCsv(input, {
        storage,
        emitter,
        asinEanProvider: options.asinEanProvider,
        keyValueStore: options.keyValueStore,
        fetcher: options.fetcher,
        customFetch: options.customFetch,
        maxItems: input.maxItems,
        failActor: options.failActor,
      });

      batchReport = batchResult.report;

      for (const item of batchResult.items) {
        if (matchedAlerts.length < input.maxItems) {
          matchedAlerts.push(item);
        }
      }

      for (const unres of batchResult.unresolved) {
        if (!unresolved.includes(unres)) {
          unresolved.push(unres);
        }
      }

      for (const inv of batchResult.invalidEans) {
        if (!invalidEans.includes(inv)) {
          invalidEans.push(inv);
        }
      }
    } catch (err: any) {
      const reason = err?.message || 'Fehlerhafte CSV-Datei';
      await failActor(reason, options.failActor);
      if (process.env.NODE_ENV !== 'test') {
        console.error(`[Actor] Batch CSV processing failed: ${reason}`);
      }
      return {
        items: [],
        totalCount: 0,
        invalid_eans: [],
        unresolved: [],
        eventSummary: emitter.getEventCounts(),
        totalCostUsd: emitter.calculateEstimatedCost(),
        ppeEventsTriggered: emitter.getTotalEvents(),
        error: reason,
      };
    }
  }

  // 1. Filter nach EAN / GTIN (Einzel- und Batch-Screening)
  const eansToProcess: string[] = [];
  if (input.eans && Array.isArray(input.eans)) {
    for (const e of input.eans) {
      if (typeof e === 'string' && e.trim().length > 0) {
        eansToProcess.push(e.trim());
      }
    }
  }
  if (input.ean && !eansToProcess.includes(input.ean)) {
    eansToProcess.unshift(input.ean);
  }

  for (const ean of eansToProcess) {
    const valid = isValidEan(ean);
    if (!valid) {
      if (!invalidEans.includes(ean)) {
        invalidEans.push(ean);
      }
    }

    const eanMatches = await storage.getByEan(ean);

    // Pay-Per-Event: 'ean-checked' ausloesen
    emitter.emitEanChecked({
      ean,
      validGtin: valid,
      matchCount: eanMatches.length,
    });

    addUniqueAlerts(eanMatches, {
      input_identifier: ean,
      input_kind: 'gtin',
      resolution_method: 'direct_gtin',
    });
  }

  // 2. Filter nach ASINs und Amazon-URLs (F08: resolveIdentifier)
  const identifiersToResolve: Array<{ raw: string; source: 'asin' | 'amazon_url' }> = [];
  if (input.asins && Array.isArray(input.asins)) {
    for (const a of input.asins) {
      if (typeof a === 'string' && a.trim().length > 0) {
        identifiersToResolve.push({ raw: a.trim(), source: 'asin' });
      }
    }
  }
  if (input.amazonUrls && Array.isArray(input.amazonUrls)) {
    for (const u of input.amazonUrls) {
      if (typeof u === 'string' && u.trim().length > 0) {
        identifiersToResolve.push({ raw: u.trim(), source: 'amazon_url' });
      }
    }
  }

  for (const { raw } of identifiersToResolve) {
    const resolved = await resolveIdentifier(raw, options.asinEanProvider);

    if (resolved.ean) {
      // Aufgelöste EANs laufen über den vorhandenen EAN-Pfad (PPE ean-checked pro EAN)
      const ean = resolved.ean;
      const valid = isValidEan(ean);
      if (!valid && !invalidEans.includes(ean)) {
        invalidEans.push(ean);
      }

      const eanMatches = await storage.getByEan(ean);

      emitter.emitEanChecked({
        ean,
        validGtin: valid,
        matchCount: eanMatches.length,
      });

      addUniqueAlerts(eanMatches, {
        input_identifier: raw,
        input_kind: resolved.kind,
        resolution_method: resolved.resolution_method,
      });
    } else if (resolved.keywords && resolved.keywords.length > 0) {
      // Suchbegriffe aus der URL laufen über den vorhandenen Query-Pfad (PPE query-executed)
      const queryString = resolved.keywords.join(' ');
      const searchMatches = await storage.findAlerts({
        query: queryString,
        category: input.category,
        childProductsOnly: input.childProductsOnly,
        ageGroup: input.ageGroup,
        hazard: input.hazard,
        limit: Math.max(0, input.maxItems - matchedAlerts.length),
      });

      emitter.emitQueryExecuted({
        query: queryString,
        category: input.category,
        totalMatches: searchMatches.length,
      });

      addUniqueAlerts(searchMatches, {
        input_identifier: raw,
        input_kind: resolved.kind,
        resolution_method: resolved.resolution_method,
        match_confidence: 'keyword',
      });
    } else {
      // Nicht auflösbare Kennungen werden ohne Kosten geloggt und in RUN_SUMMARY festgehalten
      console.log(`[Actor] Unresolved identifier '${raw}': ${resolved.error || 'Cannot be resolved'}`);
      unresolved.push(raw);
    }
  }

  // 3. Filter nach Woche (sofern maxItems noch nicht erreicht)
  if (input.week && matchedAlerts.length < input.maxItems) {
    let year: number | undefined;
    let weekNumber: number | string = input.week;
    const match = input.week.match(/^(\d{4})[-/W_]+(\d{1,2})$/i);
    if (match) {
      year = parseInt(match[1], 10);
      weekNumber = parseInt(match[2], 10);
    } else if (/^\d{1,2}$/.test(input.week)) {
      weekNumber = parseInt(input.week, 10);
    }

    const weeklyMatches = await storage.getWeeklyAlerts({
      year,
      week: weekNumber,
      limit: input.maxItems - matchedAlerts.length,
    });

    // Pay-Per-Event: 'weekly-monitored' ausloesen
    emitter.emitWeeklyMonitored({
      week: input.week,
      alertCount: weeklyMatches.length,
    });

    addUniqueAlerts(weeklyMatches);
  }

  // 4. Filter nach Freitext-Suchbegriff, Kategorie oder Kinder-Sicherheitskriterien
  if (
    (input.query || input.category || input.childProductsOnly || input.ageGroup || input.hazard) &&
    matchedAlerts.length < input.maxItems
  ) {
    const searchMatches = await storage.findAlerts({
      query: input.query,
      category: input.category,
      childProductsOnly: input.childProductsOnly,
      ageGroup: input.ageGroup,
      hazard: input.hazard,
      limit: input.maxItems - matchedAlerts.length,
    });

    // Pay-Per-Event: 'query-executed' ausloesen
    emitter.emitQueryExecuted({
      query: input.query,
      category: input.category,
      totalMatches: searchMatches.length,
    });

    addUniqueAlerts(searchMatches);
  }

  // 5. Wenn ueberhaupt kein Filter gesetzt wurde: Alle Alerts bis maxItems laden
  if (
    !input.csvContent &&
    !input.csvUrl &&
    !batchReport &&
    eansToProcess.length === 0 &&
    identifiersToResolve.length === 0 &&
    !input.week &&
    !input.query &&
    !input.category &&
    !input.childProductsOnly &&
    !input.ageGroup &&
    !input.hazard
  ) {
    const defaultMatches = await storage.findAlerts({
      limit: input.maxItems,
    });

    emitter.emitQueryExecuted({
      totalMatches: defaultMatches.length,
    });

    addUniqueAlerts(defaultMatches);
  }

  // 6. Asynchrone PPE-Charge-Operationen abwarten
  if (typeof (emitter as any).waitForPendingCharges === 'function') {
    await (emitter as any).waitForPendingCharges();
  }

  const datasetItems = matchedAlerts.map((alert) => {
    const classification = classifyChildProduct(alert);
    return {
      ...alert,
      is_child_related: classification.isChildRelated,
      child_age_group: classification.ageGroup,
      child_hazards: classification.hazards,
    };
  });

  // 7. Apify Dataset Integration: Gefundene Alert-Datensaetze via Actor.pushData() exportieren
  if (options.pushData !== false) {
    await pushApifyData(datasetItems);
  }

  // 8. RUN_SUMMARY im Key-Value-Store festhalten
  await setApifyKeyValue(
    'RUN_SUMMARY',
    {
      unresolved,
      totalItems: matchedAlerts.length,
      ppeEventsTriggered: emitter.getTotalEvents(),
      totalCostUsd: emitter.calculateEstimatedCost(),
    },
    options.keyValueStore
  );

  return {
    items: matchedAlerts,
    totalCount: matchedAlerts.length,
    invalid_eans: invalidEans,
    unresolved,
    eventSummary: emitter.getEventCounts(),
    totalCostUsd: emitter.calculateEstimatedCost(),
    ppeEventsTriggered: emitter.getTotalEvents(),
    batchReport,
  };
}
