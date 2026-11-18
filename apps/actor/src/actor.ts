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
} from '@productsafetyengine/core';
import { syncSafetyGate } from '@productsafetyengine/fetcher';
import {
  PpeEventEmitter,
  PPE_EVENTS,
  type PPEEventType,
  isApifyEnvironment,
} from './ppe.js';

/**
 * Zod-Schema fuer Actor-Inputs mit Filtern gemaess .actor/input_schema.json:
 * - ean: EAN-8, EAN-13, UPC oder GTIN Barcode
 * - eans: Array oder mehrzeiliger Text von Barcodes fuer Batch-Screening
 * - category: Produktkategorie
 * - query: Freitext-Suchbegriff (mit Aliassen searchTerm & suchbegriff)
 * - week: Publikationswoche (z.B. '2026-W45', '2026-45' oder '45')
 * - maxItems: Maximale Anzahl Datensaetze (Default 100)
 */
export const ActorInputSchema = z
  .preprocess((raw) => {
    if (Array.isArray(raw)) {
      if (raw.length === 0) return {};
      if (raw.length === 1) return raw[0];
      const allEans: string[] = [];
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
        }
      }
      delete (base as Record<string, unknown>).ean;
      return {
        ...base,
        eans: allEans.length > 0 ? allEans : undefined,
      };
    }
    return raw;
  }, z.object({
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
    searchTerm: z.string().trim().optional(),
    suchbegriff: z.string().trim().optional(),
    week: z
      .string()
      .trim()
      .optional()
      .transform((val) => (val && val.length > 0 ? val : undefined)),
    woche: z.string().trim().optional(),
    refreshData: z.coerce.boolean().optional(),
    maxItems: z.coerce.number().int().positive().default(100),
  }))
  .transform((data) => {
    // Alias-Handling
    const query = data.query ?? data.searchTerm ?? data.suchbegriff;
    const week = data.week ?? data.woche;
    return {
      ean: data.ean,
      eans: data.eans,
      category: data.category,
      query,
      week,
      refreshData: data.refreshData,
      maxItems: data.maxItems,
    };
  });

export type ActorInput = z.infer<typeof ActorInputSchema>;

export interface ActorRunOptions {
  storage?: IAlertStorage;
  emitter?: PpeEventEmitter;
  pushData?: boolean;
}

export interface ActorRunResult {
  items: AlertRecord[];
  totalCount: number;
  invalid_eans: string[];
  eventSummary: Record<PPEEventType, number>;
  totalCostUsd: number;
  ppeEventsTriggered: number;
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
  const input = ActorInputSchema.parse(rawInput ?? {});
  const emitter = options.emitter ?? new PpeEventEmitter();
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

  const matchedAlerts: AlertRecord[] = [];
  const seenAlertNumbers = new Set<string>();

  const addUniqueAlerts = (alerts: AlertRecord[]): void => {
    for (const alert of alerts) {
      if (!seenAlertNumbers.has(alert.alert_number)) {
        seenAlertNumbers.add(alert.alert_number);
        matchedAlerts.push(alert);

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

  const invalidEans: string[] = [];

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

    addUniqueAlerts(eanMatches);
  }

  // 2. Filter nach Woche (sofern maxItems noch nicht erreicht)
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

  // 3. Filter nach Freitext-Suchbegriff oder Kategorie
  if ((input.query || input.category) && matchedAlerts.length < input.maxItems) {
    const searchMatches = await storage.findAlerts({
      query: input.query,
      category: input.category,
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

  // 4. Wenn ueberhaupt kein Filter gesetzt wurde: Alle Alerts bis maxItems laden
  if (
    eansToProcess.length === 0 &&
    !input.week &&
    !input.query &&
    !input.category
  ) {
    const defaultMatches = await storage.findAlerts({
      limit: input.maxItems,
    });

    emitter.emitQueryExecuted({
      totalMatches: defaultMatches.length,
    });

    addUniqueAlerts(defaultMatches);
  }

  // 5. Asynchrone PPE-Charge-Operationen abwarten
  if (typeof (emitter as any).waitForPendingCharges === 'function') {
    await (emitter as any).waitForPendingCharges();
  }

  // 6. Apify Dataset Integration: Gefundene Alert-Datensaetze via Actor.pushData() exportieren
  if (options.pushData !== false) {
    await pushApifyData(matchedAlerts);
  }

  return {
    items: matchedAlerts,
    totalCount: matchedAlerts.length,
    invalid_eans: invalidEans,
    eventSummary: emitter.getEventCounts(),
    totalCostUsd: emitter.calculateEstimatedCost(),
    ppeEventsTriggered: emitter.getTotalEvents(),
  };
}
