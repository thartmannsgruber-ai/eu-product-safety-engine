/**
 * apps/actor/src/batch.ts
 *
 * Bulk-CSV-Import fuer den Apify Actor.
 * Verarbeitet Produktkataloge via csvContent oder csvUrl (Download via Fetcher mit SSRF-Schutz),
 * schreibt Google-Sheets-Links in CSV-Export-URLs um, loest Kennungen mit resolveIdentifier auf,
 * dedubliziert EANs fuer Pay-Per-Event-Abrechnung und erstellt BATCH_REPORT im Key-Value-Store.
 */

import { Actor } from 'apify';
import {
  parseCsv,
  mapCsvRows,
  type MapCsvResult,
  type CsvError,
  CsvLimitError,
  MAX_CSV_BYTES,
  cleanBarcode,
  isValidEan,
  resolveIdentifier,
  MapAsinEanProvider,
  type AsinEanProvider,
  validateOutboundUrl,
  type IAlertStorage,
  type AlertRecord,
} from '@productsafetyengine/core';
import { ComplianceFetcher, Fetcher } from '@productsafetyengine/fetcher';
import { PpeEventEmitter, PPE_EVENTS } from './ppe.js';
import {
  type EnrichedAlertItem,
  type ActorInput,
  setApifyKeyValue,
} from './actor.js';

export interface BatchReport {
  totalRows: number;
  validRows: number;
  invalidRows: CsvError[];
  resolved: number;
  unresolved: string[];
  duplicates: number;
  matchedRows: number;
  durationMs: number;
}

export interface BatchCsvOptions {
  storage?: IAlertStorage;
  emitter?: PpeEventEmitter;
  asinEanProvider?: AsinEanProvider;
  fetcher?: ComplianceFetcher;
  customFetch?: typeof fetch;
  timeoutMs?: number;
  keyValueStore?: {
    setValue: (key: string, value: unknown) => Promise<void>;
  };
  maxItems?: number;
  failActor?: (reason: string) => Promise<void> | void;
}

export interface BatchProcessResult {
  report: BatchReport;
  items: EnrichedAlertItem[];
  invalidEans: string[];
  unresolved: string[];
}

/**
 * Ruft Actor.fail() auf oder delegiert an einen uebergebenen customFail-Handler.
 */
export async function failActor(
  reason: string,
  customFail?: (reason: string) => Promise<void> | void
): Promise<void> {
  if (customFail) {
    await customFail(reason);
    return;
  }
  if (typeof Actor !== 'undefined' && typeof Actor.fail === 'function') {
    try {
      await Actor.fail(reason);
    } catch {
      // In Offline-/Testumgebungen sicher abfangen
    }
  }
}

/**
 * Schreibt Google-Sheets-Freigabelinks in direkte CSV-Export-URLs um.
 *
 * Beispiele:
 * - https://docs.google.com/spreadsheets/d/{id}/edit?usp=sharing
 *   -> https://docs.google.com/spreadsheets/d/{id}/export?format=csv
 * - https://docs.google.com/spreadsheets/d/{id}/edit#gid=123
 *   -> https://docs.google.com/spreadsheets/d/{id}/export?format=csv&gid=123
 */
export function rewriteGoogleSheetsUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string') return rawUrl;
  const trimmed = rawUrl.trim();
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    if (
      (hostname === 'docs.google.com' || hostname.endsWith('.docs.google.com')) &&
      url.pathname.includes('/spreadsheets/d/')
    ) {
      const match = url.pathname.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        const sheetId = match[1];
        let gid = url.searchParams.get('gid');
        if (!gid && url.hash) {
          const hashMatch = url.hash.match(/gid=(\d+)/);
          if (hashMatch) {
            gid = hashMatch[1];
          }
        }
        let exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;
        if (gid) {
          exportUrl += `&gid=${gid}`;
        }
        return exportUrl;
      }
    }
  } catch {
    // Bei Parsing-Fehlern unveraendert zurueckgeben
  }
  return trimmed;
}

export interface LoadCsvOptions {
  fetcher?: ComplianceFetcher;
  customFetch?: typeof fetch;
  timeoutMs?: number;
  failActor?: (reason: string) => Promise<void> | void;
}

/**
 * Laedt den CSV-Inhalt aus direktem Text (csvContent) oder laedt ihn ueber den Fetcher
 * von einer Remote-URL (csvUrl) unter Beachtung von validateOutboundUrl, 5 MB Limit und Timeout.
 */
export async function loadCsvContent(
  input: { csvContent?: string; csvUrl?: string },
  options: LoadCsvOptions = {}
): Promise<string> {
  if (input.csvContent && input.csvContent.trim().length > 0) {
    const content = input.csvContent;
    const byteLength = Buffer.byteLength(content, 'utf-8');
    if (byteLength > MAX_CSV_BYTES) {
      const reason = `CSV überschreitet das Limit von 5 MB (${(byteLength / (1024 * 1024)).toFixed(2)} MB)`;
      await failActor(reason, options.failActor);
      throw new CsvLimitError(reason);
    }
    return content;
  }

  if (input.csvUrl && input.csvUrl.trim().length > 0) {
    const rawUrl = input.csvUrl.trim();

    // 1. SSRF-Schutz & Protokoll-Pruefung VOR jedem Netzwerkzugriff
    const preValidation = validateOutboundUrl(rawUrl);
    if (!preValidation.ok) {
      const reason = `csvUrl wird vor Netzwerkzugriff abgelehnt: ${preValidation.reason}`;
      await failActor(reason, options.failActor);
      throw new Error(reason);
    }

    // 2. Google-Sheets-Freigabelinks in CSV-Export-URLs umschreiben
    const targetUrl = rewriteGoogleSheetsUrl(rawUrl);

    // 3. Umgeschriebene Ziel-URL erneut validieren
    const postValidation = validateOutboundUrl(targetUrl);
    if (!postValidation.ok) {
      const reason = `csvUrl wird vor Netzwerkzugriff abgelehnt: ${postValidation.reason}`;
      await failActor(reason, options.failActor);
      throw new Error(reason);
    }

    // 4. Download ueber Fetcher mit konfigurierbarem Timeout
    const timeoutMs = options.timeoutMs ?? 10_000;
    const fetcher =
      options.fetcher ??
      new Fetcher({
        timeoutMs,
        customFetch: options.customFetch,
      });

    let response;
    try {
      response = await fetcher.fetch(targetUrl, {
        skipRobotsCheck: true,
        timeoutMs,
      });
    } catch (err: any) {
      const reason = `Download von csvUrl fehlgeschlagen: ${err?.message || String(err)}`;
      await failActor(reason, options.failActor);
      throw new Error(reason);
    }

    if (!response.ok) {
      const reason = `Download von csvUrl fehlgeschlagen: HTTP ${response.status} ${response.statusText}`;
      await failActor(reason, options.failActor);
      throw new Error(reason);
    }

    // 5. Content-Length Header pruefen (sofern vorhanden)
    const contentLengthHeader = response.headers?.get('content-length');
    if (contentLengthHeader) {
      const bytes = parseInt(contentLengthHeader, 10);
      if (!isNaN(bytes) && bytes > MAX_CSV_BYTES) {
        const reason = `CSV überschreitet das Limit von 5 MB (${(bytes / (1024 * 1024)).toFixed(2)} MB)`;
        await failActor(reason, options.failActor);
        throw new CsvLimitError(reason);
      }
    }

    // 6. Body-Text laden und Groesse validieren
    let text = '';
    try {
      text = await response.text();
    } catch (err: any) {
      const reason = `Lesen der CSV-Antwort fehlgeschlagen: ${err?.message || String(err)}`;
      await failActor(reason, options.failActor);
      throw new Error(reason);
    }

    const byteLength = Buffer.byteLength(text, 'utf-8');
    if (byteLength > MAX_CSV_BYTES) {
      const reason = `CSV überschreitet das Limit von 5 MB (${(byteLength / (1024 * 1024)).toFixed(2)} MB)`;
      await failActor(reason, options.failActor);
      throw new CsvLimitError(reason);
    }

    return text;
  }

  throw new Error('Weder csvContent noch csvUrl angegeben');
}

/**
 * Fuehrt den vollstaendigen Bulk-CSV-Import durch:
 * - CSV-Download / Einlesen
 * - RFC-4180 Parsing & Zeilen-Mapping
 * - resolveIdentifier Auflösung mit asinEanMap
 * - EAN-Deduplizierung & PPE-Abrechnung (nur einmal pro gueltiger EAN)
 * - Anreicherung der Treffer mit sku, csv_row und input_identifier
 * - Speicherung von BATCH_REPORT im Key-Value-Store
 */
export async function processBatchCsv(
  input: { csvContent?: string; csvUrl?: string; maxItems?: number },
  options: BatchCsvOptions = {}
): Promise<BatchProcessResult> {
  const startTime = Date.now();
  const emitter = options.emitter ?? new PpeEventEmitter();
  const storage = options.storage;
  if (!storage) {
    throw new Error('Storage is required for batch CSV processing');
  }

  // 1. CSV laden
  const csvText = await loadCsvContent(input, options);

  // 2. CSV Zeilen einlesen & Spalten mappen
  let mapped: MapCsvResult;
  try {
    mapped = mapCsvRows(csvText);
  } catch (err: any) {
    const reason = `Fehler beim CSV-Parsing: ${err?.message || String(err)}`;
    await failActor(reason, options.failActor);
    throw new Error(reason);
  }

  // 3. asinEanMap dient als MapAsinEanProvider
  const localProvider = new MapAsinEanProvider(mapped.asinEanMap);
  const effectiveProvider: AsinEanProvider = {
    lookup: async (asin: string) => {
      const local = localProvider.lookup(asin);
      if (local) return local;
      if (options.asinEanProvider) {
        return await options.asinEanProvider.lookup(asin);
      }
      return null;
    },
  };

  const rows = mapped.rows;
  const invalidRows = mapped.errors;
  const totalRows = rows.length + invalidRows.length;
  const validRows = rows.length;

  let resolved = 0;
  const unresolved: string[] = [];
  const invalidEans: string[] = [];
  let duplicates = 0;
  let matchedRows = 0;

  const matchedAlerts: EnrichedAlertItem[] = [];
  const eanStorageCache = new Map<string, AlertRecord[]>();
  const seenEans = new Set<string>();

  const maxItems = options.maxItems ?? input.maxItems ?? 50;

  // 4. Zeilen verarbeiten
  for (const row of rows) {
    const resolution = await resolveIdentifier(row.identifier, effectiveProvider);

    if (resolution.ean) {
      resolved++;
      const cleanedEan = cleanBarcode(resolution.ean);
      const isDuplicate = seenEans.has(cleanedEan);

      if (isDuplicate) {
        duplicates++;
      } else {
        seenEans.add(cleanedEan);
      }

      // Storage-Cache abfragen oder neu laden
      let eanMatches = eanStorageCache.get(cleanedEan);
      if (!eanMatches) {
        const valid = isValidEan(cleanedEan);
        if (!valid && !invalidEans.includes(cleanedEan)) {
          invalidEans.push(cleanedEan);
        }

        eanMatches = await storage.getByEan(cleanedEan);
        eanStorageCache.set(cleanedEan, eanMatches);

        // Pay-Per-Event: Nur einmal pro gueltiger, eindeutiger EAN abrechnen!
        if (valid) {
          emitter.emitEanChecked({
            ean: cleanedEan,
            validGtin: true,
            matchCount: eanMatches.length,
          });
        }
      }

      if (eanMatches.length > 0) {
        matchedRows++;
        for (const match of eanMatches) {
          if (matchedAlerts.length < maxItems) {
            const enriched: EnrichedAlertItem = {
              ...match,
              sku: row.sku,
              csv_row: row.row,
              input_identifier: row.identifier,
              input_kind: resolution.kind,
              resolution_method: resolution.resolution_method,
            };
            matchedAlerts.push(enriched);

            emitter.emitAlertReturned({
              alertNumber: match.alert_number,
              product: match.product,
              brand: match.brand,
              category: match.category,
              riskType: match.risk_type,
            });
          }
        }
      }
    } else if (resolution.keywords && resolution.keywords.length > 0) {
      resolved++;
      const queryString = resolution.keywords.join(' ');
      const searchMatches = await storage.findAlerts({ query: queryString });

      emitter.emitQueryExecuted({
        query: queryString,
        totalMatches: searchMatches.length,
      });

      if (searchMatches.length > 0) {
        matchedRows++;
        for (const match of searchMatches) {
          if (matchedAlerts.length < maxItems) {
            const enriched: EnrichedAlertItem = {
              ...match,
              sku: row.sku,
              csv_row: row.row,
              input_identifier: row.identifier,
              input_kind: resolution.kind,
              resolution_method: resolution.resolution_method,
              match_confidence: 'keyword',
            };
            matchedAlerts.push(enriched);

            emitter.emitAlertReturned({
              alertNumber: match.alert_number,
              product: match.product,
              brand: match.brand,
              category: match.category,
              riskType: match.risk_type,
            });
          }
        }
      }
    } else {
      unresolved.push(row.identifier);
    }
  }

  const durationMs = Date.now() - startTime;

  const report: BatchReport = {
    totalRows,
    validRows,
    invalidRows,
    resolved,
    unresolved,
    duplicates,
    matchedRows,
    durationMs,
  };

  // 5. BATCH_REPORT in den Key-Value-Store schreiben
  await setApifyKeyValue('BATCH_REPORT', report, options.keyValueStore);

  return {
    report,
    items: matchedAlerts,
    invalidEans,
    unresolved,
  };
}
