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
 * Berechnet das ISO-Kalenderjahr und die ISO-Kalenderwoche (1-53) nach ISO 8601.
 */
export function getCurrentIsoWeek(d: Date = new Date()): { year: number; week: number } {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = target.getTime();
  target.setUTCMonth(0, 1);
  if (target.getUTCDay() !== 4) {
    target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
  }
  const weekNumber = 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
  return { year: new Date(firstThursday).getUTCFullYear(), week: weekNumber };
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

  const iso = getCurrentIsoWeek();
  const currentYear = options.year ? String(options.year) : String(iso.year);
  const currentWeek = options.week ? String(options.week).replace(/^W/i, '') : String(iso.week);

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
