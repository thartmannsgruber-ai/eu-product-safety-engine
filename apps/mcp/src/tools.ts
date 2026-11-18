/**
 * apps/mcp/src/tools.ts
 *
 * Die 4 spezialisierten MCP Tools fuer ProductSafetyEngine Agenten:
 * 1. check_ean_safety: Validiert EANs/Barcodes gegen die RAPEX-Datenbank mit zwingendem Disclaimer bei 0 Treffern.
 * 2. search_product_recalls: Semantische & filterbasierte Suche nach Produktrückrufen aus dem Storage.
 * 3. get_chemical_restrictions: Filtert gezielt nach REACH/SVHC-Gefahrenstoffen und Schadstoffen.
 * 4. monitor_weekly_alerts: Strukturierte Rueckgabe der juengsten Wochenmeldungen (Safety Gate).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  type IAlertStorage,
  type AlertRecord,
  isValidEan,
  MemoryAlertStorage,
  SqliteAlertStorage,
  parseYearWeekFromAlert,
} from '@productsafetyengine/core';
import { sanitizeInput } from './sanitizer.js';

/**
 * Zwingender Sicherheits-Disclaimer bei 0 Treffern fuer check_ean_safety.
 */
export const NO_HIT_SAFETY_DISCLAIMER =
  'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele Meldungen besitzen keine hinterlegte EAN).';

/**
 * Hilfsklasse zur Verwaltung der aktiven Storage-Instanz eines MCP-Servers.
 */
export class ServerStorageHolder {
  private currentStorage: IAlertStorage;

  constructor(initialStorage?: IAlertStorage) {
    this.currentStorage =
      initialStorage ??
      new SqliteAlertStorage(process.env.SQLITE_DB_PATH || ':memory:', { autoSeed: true });
  }

  get storage(): IAlertStorage {
    return this.currentStorage;
  }

  setStorage(newStorage: IAlertStorage): void {
    this.currentStorage = newStorage;
  }
}

const SERVER_STORAGE_MAP = new WeakMap<McpServer, ServerStorageHolder>();

/**
 * Ruft den StorageHolder fuer einen MCP Server ab oder initialisiert ihn.
 */
export function getOrCreateStorageHolder(server: McpServer, defaultStorage?: IAlertStorage): ServerStorageHolder {
  let holder = SERVER_STORAGE_MAP.get(server);
  if (!holder) {
    holder = new ServerStorageHolder(defaultStorage);
    SERVER_STORAGE_MAP.set(server, holder);
  } else if (defaultStorage && holder.storage !== defaultStorage) {
    holder.setStorage(defaultStorage);
  }
  return holder;
}

/**
 * Aktualisiert die Storage-Instanz fuer einen registrierten MCP Server.
 */
export function setServerStorage(server: McpServer, storage: IAlertStorage): void {
  const holder = getOrCreateStorageHolder(server);
  holder.setStorage(storage);
}

/**
 * Prueft, ob ein Alert eine chemische Gefahr bezueglich REACH, SVHC, POP oder Schadstoffen darstellt.
 */
export function isReachSvhcHazard(alert: AlertRecord): boolean {
  const combined = [
    alert.risk_type,
    alert.danger_description,
    alert.measures,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // 1. Explizite Erwaehnung von REACH oder SVHC
  if (/\b(reach|svhc|svhcs)\b/i.test(combined)) {
    return true;
  }

  // 2. Risiko-Kategorie "Chemical"
  if ((alert.risk_type ?? '').toLowerCase().includes('chemical')) {
    return true;
  }

  // 3. Typische durch REACH / POP regulierte Schadstoffe
  if (
    /\b(phthalat|dehp|dbp|bbp|dibp|cadmium|lead|blei|pfoa|pfca|pfas|chrom(?:ium)?\s*(?:vi|6)|nickel|azo|bpa|bisphenol|pop regulation)\b/i.test(
      combined
    )
  ) {
    return true;
  }

  return false;
}

// ============================================================================
// Parameter-Schemas fuer die 4 Tools
// ============================================================================

export const CheckEanSafetySchema = {
  ean: z
    .string()
    .optional()
    .describe('EAN, GTIN or Barcode to verify against the EU Safety Gate / RAPEX database (e.g. 8, 12, 13, 14 digits)'),
  barcode: z
    .string()
    .optional()
    .describe('Optional alternative barcode alias parameter'),
};

export const SearchProductRecallsSchema = {
  query: z
    .string()
    .optional()
    .describe('Free-text search query across product, brand, model, description, category, and barcodes'),
  searchTerm: z
    .string()
    .optional()
    .describe('Alias for query'),
  category: z
    .string()
    .optional()
    .describe('Product category filter (e.g. "Toys", "Clothing, textiles and fashion items", "Motor vehicles")'),
  brand: z
    .string()
    .optional()
    .describe('Brand name filter (e.g. "s.Oliver", "Honda")'),
  model: z
    .string()
    .optional()
    .describe('Model name or number filter'),
  risk_type: z
    .string()
    .optional()
    .describe('Risk type filter (e.g. "Chemical", "Injuries", "Fire", "Choking")'),
  risk_level: z
    .string()
    .optional()
    .describe('Risk level filter (e.g. "Serious risk")'),
  country: z
    .string()
    .optional()
    .describe('Filter by notifying country or country of origin'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of results to return (1-100, default: 20)'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset (default: 0)'),
};

export const GetChemicalRestrictionsSchema = {
  substance: z
    .string()
    .optional()
    .describe('Specific chemical substance, CAS number or hazard (e.g. "Cadmium", "Lead", "Phthalate", "DEHP", "PFAS", "REACH", "SVHC")'),
  category: z
    .string()
    .optional()
    .describe('Product category filter (e.g. "Toys", "Clothing, textiles and fashion items", "Jewellery")'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe('Maximum number of results to return (default: 20, max: 100)'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset (default: 0)'),
};

export const MonitorWeeklyAlertsSchema = {
  year: z
    .union([z.number(), z.string()])
    .optional()
    .describe('Year of the alerts (e.g. 2026). If omitted, defaults to the latest available week.'),
  week: z
    .union([z.number(), z.string()])
    .optional()
    .describe('Calendar week number (e.g. 45 or "2026-W45"). If omitted, defaults to the latest available week.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe('Maximum number of weekly alerts to return (default: 50, max: 200)'),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('Pagination offset (default: 0)'),
};

// ============================================================================
// Handler-Funktionen fuer die 4 Tools
// ============================================================================

export async function executeCheckEanSafety(
  args: { ean?: string; barcode?: string },
  storage: IAlertStorage
) {
  const rawCode = (args.ean ?? args.barcode ?? '').trim();
  const sanitized = rawCode ? sanitizeInput(rawCode, { maxLength: 100 }) : '';

  if (!sanitized) {
    return {
      isError: true,
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            error: 'EAN / Barcode must not be empty.',
          }),
        },
      ],
    };
  }

  const valid = isValidEan(sanitized);
  const matches = await storage.getByEan(sanitized);

  if (matches.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              found: false,
              count: 0,
              ean: sanitized,
              isValidFormat: valid,
              disclaimer: NO_HIT_SAFETY_DISCLAIMER,
              message: `Keine Treffer für EAN ${sanitized} in der EU Safety Gate (RAPEX) Datenbank. ${NO_HIT_SAFETY_DISCLAIMER}`,
              alerts: [],
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            found: true,
            count: matches.length,
            ean: sanitized,
            isValidFormat: valid,
            alerts: matches,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function executeSearchProductRecalls(
  args: {
    query?: string;
    searchTerm?: string;
    category?: string;
    brand?: string;
    model?: string;
    risk_type?: string;
    risk_level?: string;
    country?: string;
    limit?: number;
    offset?: number;
  },
  storage: IAlertStorage
) {
  const effectiveQuery = (args.query ?? args.searchTerm)?.trim();
  const sanitizedQuery = effectiveQuery ? sanitizeInput(effectiveQuery, { maxLength: 500 }) : undefined;
  const sanitizedCategory = args.category ? sanitizeInput(args.category, { maxLength: 200 }) : undefined;
  const sanitizedBrand = args.brand ? sanitizeInput(args.brand, { maxLength: 200 }) : undefined;
  const sanitizedModel = args.model ? sanitizeInput(args.model, { maxLength: 200 }) : undefined;
  const sanitizedRiskType = args.risk_type ? sanitizeInput(args.risk_type, { maxLength: 200 }) : undefined;
  const sanitizedRiskLevel = args.risk_level ? sanitizeInput(args.risk_level, { maxLength: 200 }) : undefined;
  const sanitizedCountry = args.country ? sanitizeInput(args.country, { maxLength: 200 }) : undefined;
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;

  const alerts = await storage.findAlerts({
    query: sanitizedQuery,
    category: sanitizedCategory,
    brand: sanitizedBrand,
    model: sanitizedModel,
    risk_type: sanitizedRiskType,
    risk_level: sanitizedRiskLevel,
    notifying_country: sanitizedCountry,
    limit,
    offset,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            count: alerts.length,
            limit,
            offset,
            query: sanitizedQuery ?? null,
            category: sanitizedCategory ?? null,
            brand: sanitizedBrand ?? null,
            alerts,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function executeGetChemicalRestrictions(
  args: {
    substance?: string;
    category?: string;
    limit?: number;
    offset?: number;
  },
  storage: IAlertStorage
) {
  const sanitizedSubstance = args.substance ? sanitizeInput(args.substance, { maxLength: 200 }) : undefined;
  const sanitizedCategory = args.category ? sanitizeInput(args.category, { maxLength: 200 }) : undefined;
  const limit = args.limit ?? 20;
  const offset = args.offset ?? 0;

  let candidates: AlertRecord[] = [];

  if (sanitizedSubstance) {
    const results = await storage.findAlerts({
      query: sanitizedSubstance,
      category: sanitizedCategory,
      limit: 500,
    });
    candidates = results.filter(isReachSvhcHazard);
  } else {
    const [chemAlerts, reachAlerts] = await Promise.all([
      storage.findAlerts({
        risk_type: 'Chemical',
        category: sanitizedCategory,
        limit: 500,
      }),
      storage.findAlerts({
        query: 'REACH',
        category: sanitizedCategory,
        limit: 500,
      }),
    ]);

    const map = new Map<string, AlertRecord>();
    for (const a of chemAlerts) map.set(a.alert_number, a);
    for (const a of reachAlerts) map.set(a.alert_number, a);

    candidates = Array.from(map.values()).filter(isReachSvhcHazard);
  }

  // Sortierung: publication_date DESC, alert_number ASC
  candidates.sort((a, b) => {
    const dateA = a.publication_date || '';
    const dateB = b.publication_date || '';
    if (dateA !== dateB) return dateB.localeCompare(dateA);
    return (a.alert_number || '').localeCompare(b.alert_number || '');
  });

  const paginated = candidates.slice(offset, offset + limit);

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            totalMatching: candidates.length,
            count: paginated.length,
            limit,
            offset,
            filter: {
              substance: sanitizedSubstance ?? null,
              category: sanitizedCategory ?? null,
              standard: 'REACH / SVHC / Chemical Restrictions',
            },
            alerts: paginated,
          },
          null,
          2
        ),
      },
    ],
  };
}

export async function executeMonitorWeeklyAlerts(
  args: {
    year?: number | string;
    week?: number | string;
    limit?: number;
    offset?: number;
  },
  storage: IAlertStorage
) {
  let targetYear: string | number | undefined = args.year;
  let targetWeek: string | number | undefined = args.week;
  let isLatestWeek = false;

  // Woche ggf. aus "2026-W45" oder "W45" extrahieren
  if (typeof targetWeek === 'string') {
    const match = targetWeek.match(/^(\d{4})[-/W_]+(\d{1,2})$/i);
    if (match) {
      if (targetYear === undefined) targetYear = match[1];
      targetWeek = match[2];
    } else {
      const wMatch = targetWeek.match(/^W?(\d{1,2})$/i);
      if (wMatch) targetWeek = wMatch[1];
    }
  }

  // Wenn weder Jahr noch Woche uebergeben wurden, die letzte/neueste Woche ermitteln
  if (targetYear === undefined && targetWeek === undefined) {
    isLatestWeek = true;
    const allAlerts = await storage.findAlerts();
    if (allAlerts.length > 0) {
      let bestYear = 0;
      let bestWeek = 0;
      for (const alert of allAlerts) {
        const meta = parseYearWeekFromAlert(alert);
        const y = parseInt(meta.year ?? '0', 10);
        const w = parseInt(meta.week ?? '0', 10);
        if (y > bestYear || (y === bestYear && w > bestWeek)) {
          bestYear = y;
          bestWeek = w;
        }
      }
      if (bestYear > 0 && bestWeek > 0) {
        targetYear = String(bestYear);
        targetWeek = String(bestWeek);
      }
    }
  }

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;

  const weeklyAlerts = await storage.getWeeklyAlerts({
    year: targetYear,
    week: targetWeek,
    limit,
    offset,
  });

  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            year: targetYear ?? null,
            week: targetWeek ?? null,
            isLatestWeek,
            count: weeklyAlerts.length,
            limit,
            offset,
            alerts: weeklyAlerts,
          },
          null,
          2
        ),
      },
    ],
  };
}

// ============================================================================
// MCP-Tool-Registrierung
// ============================================================================

export interface RegisterToolsOptions {
  storage?: IAlertStorage;
}

/**
 * Registriert die exakt 4 definierten ProductSafetyEngine Tools auf dem McpServer.
 */
export function registerTools(
  server: McpServer,
  storageOrOptions?: IAlertStorage | RegisterToolsOptions
): void {
  const initialStorage =
    storageOrOptions && 'getByEan' in storageOrOptions
      ? (storageOrOptions as IAlertStorage)
      : storageOrOptions?.storage;

  const holder = getOrCreateStorageHolder(server, initialStorage);

  // 1. Tool: check_ean_safety
  server.tool(
    'check_ean_safety',
    'Validates an EAN, GTIN, or barcode against the official EU Safety Gate / RAPEX database. Important: Contains mandatory disclaimer when no hits are found.',
    CheckEanSafetySchema,
    async (args) => {
      return executeCheckEanSafety(args, holder.storage);
    }
  );

  // 2. Tool: search_product_recalls
  server.tool(
    'search_product_recalls',
    'Searches product recalls and safety alerts from the EU Safety Gate database by query, category, brand, model, risk type, and risk level.',
    SearchProductRecallsSchema,
    async (args) => {
      return executeSearchProductRecalls(args, holder.storage);
    }
  );

  // 3. Tool: get_chemical_restrictions
  server.tool(
    'get_chemical_restrictions',
    'Filters product recalls and safety alerts specifically by chemical restrictions, including REACH Regulation, SVHC candidate substances, and hazardous chemicals (e.g. Cadmium, Lead, Phthalates, PFAS).',
    GetChemicalRestrictionsSchema,
    async (args) => {
      return executeGetChemicalRestrictions(args, holder.storage);
    }
  );

  // 4. Tool: monitor_weekly_alerts
  server.tool(
    'monitor_weekly_alerts',
    'Returns structured weekly product safety alerts for the latest published week (or a specific year and week) from EU Safety Gate.',
    MonitorWeeklyAlertsSchema,
    async (args) => {
      return executeMonitorWeeklyAlerts(args, holder.storage);
    }
  );
}

export const registerSafetyTools = registerTools;
