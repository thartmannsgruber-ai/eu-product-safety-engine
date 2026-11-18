/**
 * apps/actor/src/actor.ts
 *
 * Apify Actor Kernlogik fuer EU Product Safety Gate (RAPEX).
 * Verarbeitet Input-Filter (EAN, Kategorie, Suchbegriff, Woche),
 * fuehrt Recherchen im Storage durch und triggert PPE-Events.
 */

import { z } from 'zod';
import {
  type IAlertStorage,
  type AlertRecord,
  isValidEan,
  SqliteAlertStorage,
} from '@productsafetyengine/core';
import {
  PpeEventEmitter,
  PPE_EVENTS,
  type PPEEventType,
} from './ppe.js';

/**
 * Zod-Schema fuer Actor-Inputs mit Filtern gemaess .actor/input_schema.json:
 * - ean: EAN-8, EAN-13, UPC oder GTIN Barcode
 * - category: Produktkategorie
 * - query: Freitext-Suchbegriff (mit Aliassen searchTerm & suchbegriff)
 * - week: Publikationswoche (z.B. '2026-W45', '2026-45' oder '45')
 * - maxItems: Maximale Anzahl Datensaetze (Default 100)
 */
export const ActorInputSchema = z.object({
  ean: z
    .string()
    .trim()
    .optional()
    .transform((val) => (val && val.length > 0 ? val : undefined)),
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
  maxItems: z.coerce.number().int().positive().default(100),
}).transform((data) => {
  // Alias-Handling
  const query = data.query ?? data.searchTerm ?? data.suchbegriff;
  const week = data.week ?? data.woche;
  return {
    ean: data.ean,
    category: data.category,
    query,
    week,
    maxItems: data.maxItems,
  };
});

export type ActorInput = z.infer<typeof ActorInputSchema>;

export interface ActorRunOptions {
  storage?: IAlertStorage;
  emitter?: PpeEventEmitter;
}

export interface ActorRunResult {
  items: AlertRecord[];
  totalCount: number;
  eventSummary: Record<PPEEventType, number>;
  totalCostUsd: number;
  ppeEventsTriggered: number;
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

  // 1. Filter nach EAN / GTIN
  if (input.ean) {
    const valid = isValidEan(input.ean);
    const eanMatches = await storage.getByEan(input.ean);

    // Pay-Per-Event: 'ean-checked' ausloesen
    emitter.emitEanChecked({
      ean: input.ean,
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
    !input.ean &&
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

  return {
    items: matchedAlerts,
    totalCount: matchedAlerts.length,
    eventSummary: emitter.getEventCounts(),
    totalCostUsd: emitter.calculateEstimatedCost(),
    ppeEventsTriggered: emitter.getTotalEvents(),
  };
}
