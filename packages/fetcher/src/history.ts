/**
 * packages/fetcher/src/history.ts
 *
 * Multi-Week Historical Batch Sync fuer EU Safety Gate (RAPEX).
 * Sukzessives, fehlertolerantes Einlesen beliebiger Kalenderwochen-Bereiche
 * mit persistenter Ablage in SQLite (storage/safety_gate.db).
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  type IAlertStorage,
  type AlertRecord,
  SqliteAlertStorage,
  parseSafetyGateXml,
  normalizeAlerts,
} from '@productsafetyengine/core';
import { ComplianceFetcher } from './fetcher.js';
import { buildSafetyGateWeeklyUrl } from './sync.js';

export type WeekSyncStatus = 'synced' | 'empty' | 'not_found' | 'error';

export interface WeekTarget {
  year: number;
  week: number;
}

export interface WeekSyncResult {
  year: number;
  week: number;
  success: boolean;
  alertsCount: number;
  insertedCount: number;
  status: WeekSyncStatus;
  statusCode?: number;
  error?: string;
  sourceUrl?: string;
  durationMs: number;
}

export interface SyncProgress {
  currentYear: number;
  currentWeek: number;
  completedWeeks: number;
  totalWeeks: number;
  percent: number;
  totalAlerts: number;
  lastStatus: WeekSyncStatus;
}

export interface HistoricalSyncLogger {
  info?: (msg: string, ...args: unknown[]) => void;
  warn?: (msg: string, ...args: unknown[]) => void;
  error?: (msg: string, ...args: unknown[]) => void;
}

export interface HistoricalSyncOptions {
  startYear?: number;
  endYear?: number;
  startWeek?: number;
  endWeek?: number;
  years?: number[];
  weeks?: number[];
  weekRange?: WeekTarget[];
  concurrency?: number;
  fetcher?: ComplianceFetcher;
  storagePath?: string;
  onProgress?: (progress: SyncProgress) => void;
  logger?: HistoricalSyncLogger;
  customXmlProvider?: (year: number, week: number) => Promise<string | null> | string | null;
}

export interface HistoricalSyncResult {
  success: boolean;
  totalWeeks: number;
  syncedWeeks: number;
  emptyWeeks: number;
  notFoundWeeks: number;
  failedWeeks: number;
  totalAlerts: number;
  totalInserted: number;
  durationMs: number;
  details: WeekSyncResult[];
  errors: Array<{ year: number; week: number; error: string; statusCode?: number }>;
  storagePath?: string;
}

/**
 * Berechnet die Anzahl der ISO-Kalenderwochen (52 oder 53) in einem Jahr.
 */
export function getIsoWeeksInYear(year: number): number {
  const d = new Date(Date.UTC(year, 11, 28));
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  return 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
}

/**
 * Ermittelt den kanonischen Speicherpfad fuer storage/safety_gate.db
 * unbeeinflusst vom aktuellen Aufrufpfad (Root vs. Unterpaket).
 */
export function resolveSafetyGateDbPath(customPath?: string): string {
  if (customPath) {
    return path.resolve(customPath);
  }

  const cwd = process.cwd();
  if (fs.existsSync(path.resolve(cwd, 'storage'))) {
    return path.resolve(cwd, 'storage/safety_gate.db');
  }

  const parent = path.dirname(cwd);
  if (fs.existsSync(path.resolve(parent, 'storage'))) {
    return path.resolve(parent, 'storage/safety_gate.db');
  }

  return path.resolve(cwd, 'storage/safety_gate.db');
}

/**
 * Erzeugt die Liste der abzuarbeitenden Kalenderwochen-Ziele.
 */
export function generateWeekList(options: HistoricalSyncOptions = {}): WeekTarget[] {
  if (options.weekRange && options.weekRange.length > 0) {
    return [...options.weekRange];
  }

  let years: number[];
  if (options.years && options.years.length > 0) {
    years = options.years;
  } else {
    const startYear = options.startYear ?? 2024;
    const endYear = options.endYear ?? 2026;
    years = [];
    for (let y = startYear; y <= endYear; y++) {
      years.push(y);
    }
  }

  const list: WeekTarget[] = [];
  for (const year of years) {
    let weeks: number[];
    if (options.weeks && options.weeks.length > 0) {
      weeks = options.weeks;
    } else {
      const startWk = options.startWeek ?? 1;
      const endWk = options.endWeek ?? getIsoWeeksInYear(year);
      weeks = [];
      for (let w = startWk; w <= endWk; w++) {
        weeks.push(w);
      }
    }

    for (const week of weeks) {
      list.push({ year, week });
    }
  }

  return list;
}

/**
 * Fuehrt den mehrwoechigen bzw. historischen Batch-Sync in den persistenten
 * SqliteAlertStorage (storage/safety_gate.db) durch.
 *
 * @param storageOrOptions Entweder ein IAlertStorage, ein Pfad-String oder die HistoricalSyncOptions.
 * @param maybeOptions Optionale HistoricalSyncOptions, falls als 1. Parameter storage uebergeben wurde.
 */
export async function syncSafetyGateHistory(
  storageOrOptions?: IAlertStorage | string | HistoricalSyncOptions,
  maybeOptions?: HistoricalSyncOptions
): Promise<HistoricalSyncResult> {
  const startTs = Date.now();

  let storage: IAlertStorage;
  let options: HistoricalSyncOptions;
  let resolvedStoragePath: string | undefined;

  if (storageOrOptions && typeof storageOrOptions === 'object' && 'insertAlerts' in storageOrOptions) {
    storage = storageOrOptions as IAlertStorage;
    options = maybeOptions ?? {};
  } else if (typeof storageOrOptions === 'string') {
    resolvedStoragePath = resolveSafetyGateDbPath(storageOrOptions);
    storage = new SqliteAlertStorage(resolvedStoragePath);
    options = maybeOptions ?? {};
  } else {
    options = (storageOrOptions as HistoricalSyncOptions) ?? {};
    resolvedStoragePath = resolveSafetyGateDbPath(options.storagePath);
    storage = new SqliteAlertStorage(resolvedStoragePath);
  }

  const fetcher = options.fetcher ?? new ComplianceFetcher();
  const logger = options.logger ?? console;
  const targets = generateWeekList(options);

  const concurrency = Math.max(1, options.concurrency ?? 1);
  const results: WeekSyncResult[] = new Array(targets.length);
  let totalAlerts = 0;
  let totalInserted = 0;
  let completedCount = 0;

  async function syncSingleWeek(target: WeekTarget): Promise<WeekSyncResult> {
    const { year, week } = target;
    const weekStart = Date.now();
    const sourceUrl = buildSafetyGateWeeklyUrl(year, week);

    try {
      let xml: string | null | undefined;

      if (options.customXmlProvider) {
        xml = await options.customXmlProvider(year, week);
        if (xml === null) {
          logger.warn?.(`[HistorySync] Year ${year} Week ${week}: Custom provider returned null (not found).`);
          return {
            year,
            week,
            success: true,
            alertsCount: 0,
            insertedCount: 0,
            status: 'not_found',
            statusCode: 404,
            sourceUrl,
            durationMs: Date.now() - weekStart,
          };
        }
      } else {
        const response = await fetcher.fetch(sourceUrl, { skipRobotsCheck: true });

        if (response.status === 404) {
          logger.warn?.(`[HistorySync] Year ${year} Week ${week}: HTTP 404 Not Found (no alerts published for this week).`);
          return {
            year,
            week,
            success: true,
            alertsCount: 0,
            insertedCount: 0,
            status: 'not_found',
            statusCode: 404,
            sourceUrl,
            durationMs: Date.now() - weekStart,
          };
        }

        if (!response.ok) {
          const errMsg = `HTTP ${response.status} ${response.statusText}`;
          logger.warn?.(`[HistorySync] Year ${year} Week ${week}: Failed to fetch: ${errMsg}`);
          return {
            year,
            week,
            success: false,
            alertsCount: 0,
            insertedCount: 0,
            status: 'error',
            statusCode: response.status,
            error: errMsg,
            sourceUrl,
            durationMs: Date.now() - weekStart,
          };
        }

        xml = await response.text();
      }

      if (!xml || !xml.trim()) {
        logger.info?.(`[HistorySync] Year ${year} Week ${week}: Empty report body (0 alerts).`);
        return {
          year,
          week,
          success: true,
          alertsCount: 0,
          insertedCount: 0,
          status: 'empty',
          sourceUrl,
          durationMs: Date.now() - weekStart,
        };
      }

      const report = parseSafetyGateXml(xml);
      const notifications = report.notifications || [];

      if (notifications.length === 0) {
        logger.info?.(`[HistorySync] Year ${year} Week ${week}: No notifications in report (empty week).`);
        return {
          year,
          week,
          success: true,
          alertsCount: 0,
          insertedCount: 0,
          status: 'empty',
          sourceUrl,
          durationMs: Date.now() - weekStart,
        };
      }

      const reportYear = report.reportYear || String(year);
      const reportWeek = report.reportWeek || String(week);

      const normalized = normalizeAlerts(notifications).map((alert) => {
        const rec = alert as Record<string, unknown>;
        const alertNumber = alert.case_number || `${reportYear}-W${reportWeek}-${alert.alert_number}`;
        return {
          ...alert,
          alert_number: alertNumber,
          year: rec.year ? String(rec.year) : reportYear,
          week: rec.week ? String(rec.week) : reportWeek,
        } as AlertRecord;
      });

      const inserted = await storage.insertAlerts(normalized);

      logger.info?.(`[HistorySync] Year ${year} Week ${week}: Synced ${normalized.length} alerts (${inserted} upserted).`);

      return {
        year,
        week,
        success: true,
        alertsCount: normalized.length,
        insertedCount: inserted,
        status: 'synced',
        sourceUrl,
        durationMs: Date.now() - weekStart,
      };
    } catch (err: unknown) {
      const errObj = err instanceof Error ? err : new Error(String(err));
      logger.error?.(`[HistorySync] Year ${year} Week ${week}: Unexpected error: ${errObj.message}`);
      return {
        year,
        week,
        success: false,
        alertsCount: 0,
        insertedCount: 0,
        status: 'error',
        error: errObj.message,
        sourceUrl,
        durationMs: Date.now() - weekStart,
      };
    }
  }

  let targetIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, async () => {
    while (targetIndex < targets.length) {
      const currentIndex = targetIndex++;
      const target = targets[currentIndex];
      const res = await syncSingleWeek(target);
      results[currentIndex] = res;

      completedCount++;
      totalAlerts += res.alertsCount;
      totalInserted += res.insertedCount;

      if (options.onProgress) {
        options.onProgress({
          currentYear: target.year,
          currentWeek: target.week,
          completedWeeks: completedCount,
          totalWeeks: targets.length,
          percent: Math.round((completedCount / targets.length) * 100),
          totalAlerts,
          lastStatus: res.status,
        });
      }
    }
  });

  await Promise.all(workers);

  const syncedWeeks = results.filter((r) => r && r.status === 'synced').length;
  const emptyWeeks = results.filter((r) => r && r.status === 'empty').length;
  const notFoundWeeks = results.filter((r) => r && r.status === 'not_found').length;
  const failedWeeks = results.filter((r) => r && r.status === 'error').length;

  const errors = results
    .filter((r) => r && r.status === 'error')
    .map((r) => ({
      year: r.year,
      week: r.week,
      error: r.error || 'Unknown error',
      statusCode: r.statusCode,
    }));

  return {
    success: failedWeeks === 0,
    totalWeeks: targets.length,
    syncedWeeks,
    emptyWeeks,
    notFoundWeeks,
    failedWeeks,
    totalAlerts,
    totalInserted,
    durationMs: Date.now() - startTs,
    details: results,
    errors,
    storagePath: resolvedStoragePath,
  };
}
