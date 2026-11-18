/**
 * packages/fetcher/src/sync.ts
 *
 * Live-Data-Refresh und Storage-Synchronisation fuer EU Safety Gate (RAPEX).
 * Ruft die offiziellen XML-Wochenberichte ueber ComplianceFetcher ab,
 * parst und normalisiert die Daten und synchronisiert sie idempotent in den IAlertStorage.
 */

import {
  type IAlertStorage,
  type AlertRecord,
  parseSafetyGateXml,
  normalizeAlerts,
} from '@productsafetyengine/core';
import { ComplianceFetcher } from './fetcher.js';

export interface SyncOptions {
  url?: string;
  year?: string | number;
  week?: string | number;
  xmlData?: string;
  fetcher?: ComplianceFetcher;
}

export interface SyncResult {
  success: boolean;
  year: string;
  week: string;
  alertsCount: number;
  insertedCount: number;
  durationMs: number;
  sourceUrl?: string;
  fromCache?: boolean;
}

/**
 * Erzeugt die offizielle Safety Gate XML-Download-URL fuer ein bestimmtes Jahr und eine Woche.
 */
export function buildSafetyGateWeeklyUrl(year: string | number, week: string | number): string {
  const cleanYear = String(year).trim();
  const cleanWeek = String(week).trim().replace(/^W/i, '');
  return `https://ec.europa.eu/safety-gate-alerts/screen/webreport/download/xml?year=${cleanYear}&week=${cleanWeek}`;
}

/**
 * Synchronisiert Safety Gate Alerts dynamisch in den uebergebenen Storage.
 */
export async function syncSafetyGate(
  storage: IAlertStorage,
  options: SyncOptions = {}
): Promise<SyncResult> {
  const startTs = Date.now();
  const fetcher = options.fetcher ?? new ComplianceFetcher();

  let xml = options.xmlData;
  let sourceUrl = options.url;
  let fromCache = false;

  const currentYear = options.year ? String(options.year) : String(new Date().getFullYear());
  const currentWeek = options.week ? String(options.week).replace(/^W/i, '') : '45';

  if (!xml) {
    if (!sourceUrl) {
      sourceUrl = buildSafetyGateWeeklyUrl(currentYear, currentWeek);
    }

    const response = await fetcher.fetch(sourceUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch Safety Gate XML from ${sourceUrl}: HTTP ${response.status} ${response.statusText}`);
    }

    xml = await response.text();
    fromCache = response.fromCache;
  }

  const report = parseSafetyGateXml(xml);
  const reportYear = report.reportYear || currentYear;
  const reportWeek = report.reportWeek || currentWeek;

  const normalized = normalizeAlerts(report.notifications).map((alert) => {
    const rec = alert as Record<string, unknown>;
    return {
      ...alert,
      year: rec.year ? String(rec.year) : reportYear,
      week: rec.week ? String(rec.week) : reportWeek,
    } as AlertRecord;
  });

  const insertedCount = await storage.insertAlerts(normalized);

  return {
    success: true,
    year: reportYear,
    week: reportWeek,
    alertsCount: normalized.length,
    insertedCount,
    durationMs: Date.now() - startTs,
    sourceUrl,
    fromCache,
  };
}
