import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type AlertRecord, normalizeAlerts } from './schema.js';
import { cleanBarcode, normalizeToGtin14 } from './gtin.js';
import { parseSafetyGateFileSync } from './parser.js';

/**
 * Error raised when an alert query is attempted against an uninitialized or empty database.
 * Protects against false-negative "0 results" outputs due to missing fixtures or failed cold-start.
 */
export class EmptyDatabaseError extends Error {
  constructor(message = 'Safety Gate database is empty (0 records). Ensure autoSeed is enabled or run syncSafetyGate().') {
    super(message);
    this.name = 'EmptyDatabaseError';
  }
}

/**
 * Filter and search criteria for alert queries.
 */
export interface AlertSearchQuery {
  category?: string;
  query?: string;
  text?: string;
  q?: string;
  brand?: string;
  product?: string;
  model?: string;
  risk_type?: string;
  risk_level?: string;
  notifying_country?: string;
  country_of_origin?: string;
  limit?: number;
  offset?: number;
}

/**
 * Options for querying weekly alerts.
 */
export interface WeeklyAlertsOptions {
  year?: string | number;
  week?: string | number;
  limit?: number;
  offset?: number;
}

/**
 * Generic storage interface for ProductSafetyEngine alerts.
 */
export interface IAlertStorage {
  /**
   * Inserts or updates an array of alert records.
   * Returns the count of processed alerts.
   */
  insertAlerts(alerts: AlertRecord[]): Promise<number>;

  /**
   * Retrieves alerts matching any barcode in the given EAN list or single EAN.
   */
  getByEan(ean: string | string[]): Promise<AlertRecord[]>;

  /**
   * Searches alerts by category, freitext, or specific field filters.
   */
  findAlerts(query?: AlertSearchQuery | string): Promise<AlertRecord[]>;

  /**
   * Retrieves weekly alerts, optionally filtered by year and week.
   */
  getWeeklyAlerts(options?: WeeklyAlertsOptions | number): Promise<AlertRecord[]>;

  /**
   * Retrieves a single alert by its primary alert number.
   */
  getAlertByNumber(alertNumber: string): Promise<AlertRecord | null>;

  /**
   * Returns the total count of alerts currently stored.
   */
  count(): Promise<number>;

  /**
   * Clears all alerts and barcode indices.
   */
  clear(): Promise<void>;

  /**
   * Closes database handles or releases underlying resources.
   */
  close(): Promise<void> | void;
}

/**
 * Helper to parse or derive ISO week and year from an alert record.
 */
export function parseYearWeekFromAlert(alert: AlertRecord): {
  year?: string;
  year2Digit?: string;
  week?: string;
} {
  const record = alert as Record<string, unknown>;
  let year = record.year !== undefined ? String(record.year) : undefined;
  let week = record.week !== undefined ? String(record.week) : undefined;

  let year2Digit: string | undefined = undefined;
  if (alert.case_number) {
    const match = alert.case_number.match(/\/(\d{2})$/);
    if (match) {
      year2Digit = match[1];
      if (!year) {
        year = `20${year2Digit}`;
      }
    }
  }

  if (alert.publication_date) {
    const dateStr = alert.publication_date.trim();
    let d: Date | null = null;

    const dmy = dateStr.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (dmy) {
      const day = parseInt(dmy[1], 10);
      const month = parseInt(dmy[2], 10) - 1;
      const yr = parseInt(dmy[3], 10);
      d = new Date(Date.UTC(yr, month, day));
      if (!year) year = String(yr);
      if (!year2Digit) year2Digit = String(yr).slice(-2);
    } else {
      const ymd = dateStr.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (ymd) {
        const yr = parseInt(ymd[1], 10);
        const month = parseInt(ymd[2], 10) - 1;
        const day = parseInt(ymd[3], 10);
        d = new Date(Date.UTC(yr, month, day));
        if (!year) year = String(yr);
        if (!year2Digit) year2Digit = String(yr).slice(-2);
      }
    }

    if (d && !isNaN(d.getTime()) && !week) {
      const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const dayNr = (target.getUTCDay() + 6) % 7;
      target.setUTCDate(target.getUTCDate() - dayNr + 3);
      const firstThursday = target.getTime();
      target.setUTCMonth(0, 1);
      if (target.getUTCDay() !== 4) {
        target.setUTCMonth(0, 1 + ((4 - target.getUTCDay()) + 7) % 7);
      }
      const isoWeek = 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
      week = String(isoWeek);
    }
  }

  return { year, year2Digit, week };
}

/**
 * High-performance In-Memory implementation of IAlertStorage using Map.
 */
export class MemoryAlertStorage implements IAlertStorage {
  private alerts = new Map<string, AlertRecord>();
  private eanIndex = new Map<string, Set<string>>(); // EAN -> Set of alert keys

  constructor(initialAlerts?: AlertRecord[]) {
    if (initialAlerts && initialAlerts.length > 0) {
      this.insertAlertsSync(initialAlerts);
    }
  }

  private indexEan(ean: string, alertKey: string): void {
    let set = this.eanIndex.get(ean);
    if (!set) {
      set = new Set<string>();
      this.eanIndex.set(ean, set);
    }
    set.add(alertKey);
  }

  private insertAlertsSync(alerts: AlertRecord[]): number {
    let count = 0;
    for (const alert of alerts) {
      if (!alert) continue;
      const key = alert.alert_number || alert.case_number || `alert-${this.alerts.size + 1}`;

      // Clean up previous indexing if updating an existing alert
      const existing = this.alerts.get(key);
      if (existing && Array.isArray(existing.ean_barcodes)) {
        for (const oldCode of existing.ean_barcodes) {
          const raw = String(oldCode).trim();
          const cleaned = cleanBarcode(raw);
          const gtin14 = normalizeToGtin14(cleaned);
          this.eanIndex.get(raw)?.delete(key);
          if (cleaned) this.eanIndex.get(cleaned)?.delete(key);
          if (gtin14) this.eanIndex.get(gtin14)?.delete(key);
        }
      }

      this.alerts.set(key, alert);

      if (Array.isArray(alert.ean_barcodes)) {
        for (const rawCode of alert.ean_barcodes) {
          const raw = String(rawCode).trim();
          if (!raw) continue;
          this.indexEan(raw, key);

          const cleaned = cleanBarcode(raw);
          if (cleaned && cleaned !== raw) {
            this.indexEan(cleaned, key);
          }

          const gtin14 = normalizeToGtin14(cleaned);
          if (gtin14 && gtin14 !== cleaned && gtin14 !== raw) {
            this.indexEan(gtin14, key);
          }
        }
      }
      count++;
    }
    return count;
  }

  async insertAlerts(alerts: AlertRecord[]): Promise<number> {
    return this.insertAlertsSync(alerts);
  }

  async getByEan(ean: string | string[]): Promise<AlertRecord[]> {
    const eanList = Array.isArray(ean) ? ean : [ean];
    const candidateKeys = new Set<string>();

    for (const code of eanList) {
      if (!code) continue;
      const raw = String(code).trim();
      const cleaned = cleanBarcode(raw);
      const gtin14 = normalizeToGtin14(cleaned);

      const keysForRaw = this.eanIndex.get(raw);
      if (keysForRaw) {
        for (const k of keysForRaw) candidateKeys.add(k);
      }

      if (cleaned && cleaned !== raw) {
        const keysForClean = this.eanIndex.get(cleaned);
        if (keysForClean) {
          for (const k of keysForClean) candidateKeys.add(k);
        }
      }

      if (gtin14 && gtin14 !== cleaned && gtin14 !== raw) {
        const keysForGtin14 = this.eanIndex.get(gtin14);
        if (keysForGtin14) {
          for (const k of keysForGtin14) candidateKeys.add(k);
        }
      }
    }

    const matched: AlertRecord[] = [];
    for (const key of candidateKeys) {
      const alert = this.alerts.get(key);
      if (alert) {
        matched.push(alert);
      }
    }

    matched.sort((a, b) => {
      const dateA = a.publication_date || '';
      const dateB = b.publication_date || '';
      if (dateA !== dateB) return dateB.localeCompare(dateA);
      return (a.alert_number || '').localeCompare(b.alert_number || '');
    });

    return matched;
  }

  async findAlerts(query?: AlertSearchQuery | string): Promise<AlertRecord[]> {
    const options: AlertSearchQuery =
      typeof query === 'string'
        ? { query }
        : query ?? {};

    const categoryFilter = options.category?.trim().toLowerCase();
    const textQuery = (options.query ?? options.text ?? options.q)?.trim().toLowerCase();
    const brandFilter = options.brand?.trim().toLowerCase();
    const productFilter = options.product?.trim().toLowerCase();
    const modelFilter = options.model?.trim().toLowerCase();
    const riskTypeFilter = options.risk_type?.trim().toLowerCase();
    const riskLevelFilter = options.risk_level?.trim().toLowerCase();
    const notifyingCountryFilter = options.notifying_country?.trim().toLowerCase();
    const countryOfOriginFilter = options.country_of_origin?.trim().toLowerCase();

    const results: AlertRecord[] = [];

    for (const alert of this.alerts.values()) {
      if (categoryFilter) {
        const alertCat = (alert.category ?? '').toLowerCase();
        if (!alertCat.includes(categoryFilter)) {
          continue;
        }
      }

      if (textQuery) {
        const searchable = [
          alert.product,
          alert.brand,
          alert.model,
          alert.danger_description,
          alert.measures,
          alert.risk_type,
          alert.category,
          alert.alert_number,
          alert.case_number,
          alert.country_of_origin,
          alert.notifying_country,
          ...(alert.ean_barcodes ?? []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        const words = textQuery.split(/\s+/).filter(Boolean);
        const matchesAllWords = words.every((word) => searchable.includes(word));
        if (!matchesAllWords) {
          continue;
        }
      }

      if (brandFilter && !(alert.brand ?? '').toLowerCase().includes(brandFilter)) {
        continue;
      }
      if (productFilter && !(alert.product ?? '').toLowerCase().includes(productFilter)) {
        continue;
      }
      if (modelFilter && !(alert.model ?? '').toLowerCase().includes(modelFilter)) {
        continue;
      }
      if (riskTypeFilter && !(alert.risk_type ?? '').toLowerCase().includes(riskTypeFilter)) {
        continue;
      }
      if (riskLevelFilter && !(alert.risk_level ?? '').toLowerCase().includes(riskLevelFilter)) {
        continue;
      }
      if (notifyingCountryFilter && !(alert.notifying_country ?? '').toLowerCase().includes(notifyingCountryFilter)) {
        continue;
      }
      if (countryOfOriginFilter && !(alert.country_of_origin ?? '').toLowerCase().includes(countryOfOriginFilter)) {
        continue;
      }

      results.push(alert);
    }

    results.sort((a, b) => {
      const dateA = a.publication_date || '';
      const dateB = b.publication_date || '';
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      return (a.alert_number || '').localeCompare(b.alert_number || '');
    });

    const offset = options.offset ?? 0;
    const limit = options.limit !== undefined ? options.limit : results.length;
    return results.slice(offset, offset + limit);
  }

  async getWeeklyAlerts(options?: WeeklyAlertsOptions | number): Promise<AlertRecord[]> {
    const opts: WeeklyAlertsOptions =
      typeof options === 'number'
        ? { limit: options }
        : options ?? {};

    const allAlerts = Array.from(this.alerts.values());
    let filtered = allAlerts;

    if (opts.year !== undefined || opts.week !== undefined) {
      filtered = filtered.filter((alert) => {
        const record = alert as Record<string, unknown>;
        const recYear = record.year !== undefined ? String(record.year) : undefined;
        const recWeek = record.week !== undefined ? String(record.week) : undefined;
        const parsedMeta = parseYearWeekFromAlert(alert);

        const targetYear = opts.year !== undefined ? String(opts.year) : undefined;
        const targetWeek = opts.week !== undefined ? String(opts.week) : undefined;

        if (targetYear !== undefined) {
          const matchesYear =
            recYear === targetYear ||
            parsedMeta.year === targetYear ||
            (parsedMeta.year2Digit && targetYear.endsWith(parsedMeta.year2Digit));
          if (!matchesYear) return false;
        }

        if (targetWeek !== undefined) {
          const matchesWeek =
            recWeek === targetWeek ||
            parsedMeta.week === targetWeek ||
            (parsedMeta.week && parseInt(parsedMeta.week, 10) === parseInt(targetWeek, 10));
          if (!matchesWeek) return false;
        }

        return true;
      });
    }

    filtered.sort((a, b) => {
      const dateA = a.publication_date || '';
      const dateB = b.publication_date || '';
      if (dateA !== dateB) {
        return dateB.localeCompare(dateA);
      }
      return (a.alert_number || '').localeCompare(b.alert_number || '');
    });

    const offset = opts.offset ?? 0;
    const limit = opts.limit !== undefined ? opts.limit : filtered.length;
    return filtered.slice(offset, offset + limit);
  }

  async getAlertByNumber(alertNumber: string): Promise<AlertRecord | null> {
    return this.alerts.get(alertNumber) ?? null;
  }

  async count(): Promise<number> {
    return this.alerts.size;
  }

  async clear(): Promise<void> {
    this.alerts.clear();
    this.eanIndex.clear();
  }

  close(): void {
    // No-op for in-memory storage
  }
}

/**
 * Configuration options for SqliteAlertStorage, including coldstart auto-seeding.
 */
export interface SqliteAlertStorageOptions {
  autoSeed?: boolean;
  fixturePath?: string;
}

/**
 * Resolves the location of fixtures/safety_gate_2026_45.xml in any workspace or runtime context.
 */
export function resolveFixturePath(customPath?: string): string | null {
  if (customPath && fs.existsSync(customPath)) {
    return path.resolve(customPath);
  }
  if (process.env.SAFETY_GATE_FIXTURE_PATH && fs.existsSync(process.env.SAFETY_GATE_FIXTURE_PATH)) {
    return path.resolve(process.env.SAFETY_GATE_FIXTURE_PATH);
  }

  // Check process.cwd()
  const cwdCandidate = path.resolve(process.cwd(), 'fixtures/safety_gate_2026_45.xml');
  if (fs.existsSync(cwdCandidate)) return cwdCandidate;

  // Search upwards from __dirname
  try {
    let currDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();
    for (let i = 0; i < 6; i++) {
      const candidate = path.resolve(currDir, 'fixtures/safety_gate_2026_45.xml');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(currDir);
      if (parent === currDir) break;
      currDir = parent;
    }
  } catch {
    // Ignore and proceed
  }

  // Search upwards from process.cwd()
  let currDir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.resolve(currDir, 'fixtures/safety_gate_2026_45.xml');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(currDir);
    if (parent === currDir) break;
    currDir = parent;
  }

  return null;
}

/**
 * Persistent or in-memory SQLite implementation of IAlertStorage using Node 22 native node:sqlite.
 */
export class SqliteAlertStorage implements IAlertStorage {
  private db: DatabaseSync;

  constructor(
    locationOrDb: string | DatabaseSync = ':memory:',
    options?: SqliteAlertStorageOptions,
  ) {
    if (typeof locationOrDb === 'string') {
      if (locationOrDb !== ':memory:' && !locationOrDb.startsWith('file:')) {
        const dir = path.dirname(locationOrDb);
        if (dir && !fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
      }
      this.db = new DatabaseSync(locationOrDb);
    } else {
      this.db = locationOrDb;
    }

    this.initTables();

    if (options?.autoSeed) {
      this.seedFromFixtureIfEmpty(options.fixturePath);
    }
  }

  public getRawDatabase(): DatabaseSync {
    return this.db;
  }

  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS alerts (
        alert_number TEXT PRIMARY KEY,
        case_number TEXT,
        publication_date TEXT,
        category TEXT,
        product TEXT,
        brand TEXT,
        model TEXT,
        ean_barcodes TEXT,
        risk_type TEXT,
        danger_description TEXT,
        measures TEXT,
        notifying_country TEXT,
        country_of_origin TEXT,
        risk_level TEXT,
        source_url TEXT,
        year TEXT,
        week TEXT,
        created_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS alert_eans (
        alert_number TEXT,
        ean TEXT,
        PRIMARY KEY (alert_number, ean)
      );

      CREATE INDEX IF NOT EXISTS idx_alert_eans_ean ON alert_eans(ean);
      CREATE INDEX IF NOT EXISTS idx_alerts_category ON alerts(category);
      CREATE INDEX IF NOT EXISTS idx_alerts_publication_date ON alerts(publication_date);
      CREATE INDEX IF NOT EXISTS idx_alerts_year_week ON alerts(year, week);
    `);
  }

  private mapRowToAlertRecord(row: Record<string, unknown>): AlertRecord {
    let eanBarcodes: string[] = [];
    if (typeof row.ean_barcodes === 'string') {
      try {
        eanBarcodes = JSON.parse(row.ean_barcodes);
      } catch {
        eanBarcodes = [];
      }
    } else if (Array.isArray(row.ean_barcodes)) {
      eanBarcodes = row.ean_barcodes as string[];
    }

    return {
      alert_number: String(row.alert_number ?? ''),
      case_number: String(row.case_number ?? ''),
      publication_date: String(row.publication_date ?? ''),
      category: String(row.category ?? ''),
      product: String(row.product ?? ''),
      brand: String(row.brand ?? ''),
      model: String(row.model ?? ''),
      ean_barcodes: eanBarcodes,
      risk_type: String(row.risk_type ?? ''),
      danger_description: String(row.danger_description ?? ''),
      measures: String(row.measures ?? ''),
      notifying_country: String(row.notifying_country ?? ''),
      country_of_origin: String(row.country_of_origin ?? ''),
      risk_level: String(row.risk_level ?? ''),
      source_url: String(row.source_url ?? ''),
    };
  }

  insertAlertsSync(alerts: AlertRecord[]): number {
    if (!alerts || alerts.length === 0) return 0;

    const insertAlertStmt = this.db.prepare(`
      INSERT INTO alerts (
        alert_number, case_number, publication_date, category, product,
        brand, model, ean_barcodes, risk_type, danger_description,
        measures, notifying_country, country_of_origin, risk_level,
        source_url, year, week, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(alert_number) DO UPDATE SET
        case_number = excluded.case_number,
        publication_date = excluded.publication_date,
        category = excluded.category,
        product = excluded.product,
        brand = excluded.brand,
        model = excluded.model,
        ean_barcodes = excluded.ean_barcodes,
        risk_type = excluded.risk_type,
        danger_description = excluded.danger_description,
        measures = excluded.measures,
        notifying_country = excluded.notifying_country,
        country_of_origin = excluded.country_of_origin,
        risk_level = excluded.risk_level,
        source_url = excluded.source_url,
        year = excluded.year,
        week = excluded.week
    `);

    const deleteEansStmt = this.db.prepare(`
      DELETE FROM alert_eans WHERE alert_number = ?
    `);

    const insertEanStmt = this.db.prepare(`
      INSERT OR IGNORE INTO alert_eans (alert_number, ean) VALUES (?, ?)
    `);

    const now = Date.now();
    let count = 0;

    this.db.exec('BEGIN TRANSACTION');
    try {
      for (const alert of alerts) {
        if (!alert) continue;
        const alertNumber = alert.alert_number || alert.case_number || `alert-${now}-${count + 1}`;
        const meta = parseYearWeekFromAlert(alert);
        const record = alert as Record<string, unknown>;
        const year = record.year !== undefined ? String(record.year) : (meta.year ?? '');
        const week = record.week !== undefined ? String(record.week) : (meta.week ?? '');
        const eanList = Array.isArray(alert.ean_barcodes) ? alert.ean_barcodes : [];

        insertAlertStmt.run(
          alertNumber,
          alert.case_number ?? '',
          alert.publication_date ?? '',
          alert.category ?? '',
          alert.product ?? '',
          alert.brand ?? '',
          alert.model ?? '',
          JSON.stringify(eanList),
          alert.risk_type ?? '',
          alert.danger_description ?? '',
          alert.measures ?? '',
          alert.notifying_country ?? '',
          alert.country_of_origin ?? '',
          alert.risk_level ?? '',
          alert.source_url ?? '',
          year,
          week,
          now
        );

        deleteEansStmt.run(alertNumber);

        for (const rawCode of eanList) {
          const raw = String(rawCode).trim();
          if (!raw) continue;
          insertEanStmt.run(alertNumber, raw);

          const cleaned = cleanBarcode(raw);
          if (cleaned && cleaned !== raw) {
            insertEanStmt.run(alertNumber, cleaned);
          }

          const gtin14 = normalizeToGtin14(cleaned);
          if (gtin14 && gtin14 !== cleaned && gtin14 !== raw) {
            insertEanStmt.run(alertNumber, gtin14);
          }
        }

        count++;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return count;
  }

  async insertAlerts(alerts: AlertRecord[]): Promise<number> {
    return this.insertAlertsSync(alerts);
  }

  async getByEan(ean: string | string[]): Promise<AlertRecord[]> {
    const eanList = Array.isArray(ean) ? ean : [ean];
    const queryValues: string[] = [];

    for (const item of eanList) {
      if (!item) continue;
      const raw = String(item).trim();
      if (raw) queryValues.push(raw);
      const cleaned = cleanBarcode(raw);
      if (cleaned && cleaned !== raw) queryValues.push(cleaned);
      const gtin14 = normalizeToGtin14(cleaned);
      if (gtin14 && gtin14 !== cleaned && gtin14 !== raw) queryValues.push(gtin14);
    }

    if (queryValues.length === 0) {
      return [];
    }

    const uniqueValues = Array.from(new Set(queryValues));
    const placeholders = uniqueValues.map(() => '?').join(', ');

    const sql = `
      SELECT DISTINCT a.*
      FROM alerts a
      JOIN alert_eans e ON a.alert_number = e.alert_number
      WHERE e.ean IN (${placeholders})
      ORDER BY a.publication_date DESC, a.alert_number ASC
    `;

    const rows = this.db.prepare(sql).all(...uniqueValues) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToAlertRecord(row));
  }

  async findAlerts(query?: AlertSearchQuery | string): Promise<AlertRecord[]> {
    const options: AlertSearchQuery =
      typeof query === 'string'
        ? { query }
        : query ?? {};

    const clauses: string[] = ['1=1'];
    const params: (string | number)[] = [];

    const categoryFilter = options.category?.trim();
    if (categoryFilter) {
      clauses.push('LOWER(a.category) LIKE ?');
      params.push(`%${categoryFilter.toLowerCase()}%`);
    }

    const textQuery = (options.query ?? options.text ?? options.q)?.trim();
    if (textQuery) {
      const words = textQuery.split(/\s+/).filter(Boolean);
      for (const word of words) {
        clauses.push(`(
          LOWER(
            COALESCE(a.product, '') || ' ' ||
            COALESCE(a.brand, '') || ' ' ||
            COALESCE(a.model, '') || ' ' ||
            COALESCE(a.danger_description, '') || ' ' ||
            COALESCE(a.measures, '') || ' ' ||
            COALESCE(a.risk_type, '') || ' ' ||
            COALESCE(a.category, '') || ' ' ||
            COALESCE(a.alert_number, '') || ' ' ||
            COALESCE(a.case_number, '') || ' ' ||
            COALESCE(a.notifying_country, '') || ' ' ||
            COALESCE(a.country_of_origin, '') || ' ' ||
            COALESCE(a.ean_barcodes, '')
          ) LIKE ?
        )`);
        params.push(`%${word.toLowerCase()}%`);
      }
    }

    if (options.brand?.trim()) {
      clauses.push('LOWER(a.brand) LIKE ?');
      params.push(`%${options.brand.trim().toLowerCase()}%`);
    }
    if (options.product?.trim()) {
      clauses.push('LOWER(a.product) LIKE ?');
      params.push(`%${options.product.trim().toLowerCase()}%`);
    }
    if (options.model?.trim()) {
      clauses.push('LOWER(a.model) LIKE ?');
      params.push(`%${options.model.trim().toLowerCase()}%`);
    }
    if (options.risk_type?.trim()) {
      clauses.push('LOWER(a.risk_type) LIKE ?');
      params.push(`%${options.risk_type.trim().toLowerCase()}%`);
    }
    if (options.risk_level?.trim()) {
      clauses.push('LOWER(a.risk_level) LIKE ?');
      params.push(`%${options.risk_level.trim().toLowerCase()}%`);
    }
    if (options.notifying_country?.trim()) {
      clauses.push('LOWER(a.notifying_country) LIKE ?');
      params.push(`%${options.notifying_country.trim().toLowerCase()}%`);
    }
    if (options.country_of_origin?.trim()) {
      clauses.push('LOWER(a.country_of_origin) LIKE ?');
      params.push(`%${options.country_of_origin.trim().toLowerCase()}%`);
    }

    let sql = `
      SELECT a.*
      FROM alerts a
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.publication_date DESC, a.alert_number ASC
    `;

    if (options.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(options.limit);
      if (options.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(options.offset);
      }
    } else if (options.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(options.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToAlertRecord(row));
  }

  async getWeeklyAlerts(options?: WeeklyAlertsOptions | number): Promise<AlertRecord[]> {
    const opts: WeeklyAlertsOptions =
      typeof options === 'number'
        ? { limit: options }
        : options ?? {};

    const clauses: string[] = ['1=1'];
    const params: (string | number)[] = [];

    if (opts.year !== undefined) {
      const yrStr = String(opts.year);
      clauses.push('(a.year = ? OR a.year = ? OR a.case_number LIKE ?)');
      params.push(yrStr);
      params.push(yrStr.length === 4 ? yrStr.slice(2) : `20${yrStr}`);
      params.push(`%/${yrStr.slice(-2)}`);
    }

    if (opts.week !== undefined) {
      const wkStr = String(opts.week);
      const wkInt = parseInt(wkStr, 10);
      const wkPadded = !isNaN(wkInt) && wkInt < 10 ? `0${wkInt}` : String(wkInt);
      clauses.push('(a.week = ? OR a.week = ?)');
      params.push(wkStr);
      params.push(wkPadded);
    }

    let sql = `
      SELECT a.*
      FROM alerts a
      WHERE ${clauses.join(' AND ')}
      ORDER BY a.publication_date DESC, a.alert_number ASC
    `;

    if (opts.limit !== undefined) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
      if (opts.offset !== undefined) {
        sql += ' OFFSET ?';
        params.push(opts.offset);
      }
    } else if (opts.offset !== undefined) {
      sql += ' LIMIT -1 OFFSET ?';
      params.push(opts.offset);
    }

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((row) => this.mapRowToAlertRecord(row));
  }

  async getAlertByNumber(alertNumber: string): Promise<AlertRecord | null> {
    const row = this.db.prepare('SELECT * FROM alerts WHERE alert_number = ?').get(alertNumber) as Record<string, unknown> | undefined;
    return row ? this.mapRowToAlertRecord(row) : null;
  }

  countSync(): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM alerts').get() as { cnt: number } | undefined;
    return row ? Number(row.cnt) : 0;
  }

  async count(): Promise<number> {
    return this.countSync();
  }

  /**
   * Seeds the database from fixtures/safety_gate_2026_45.xml if storage is currently empty.
   * Returns the number of seeded alerts (0 if already populated or fixture not found).
   */
  seedFromFixtureIfEmpty(fixturePath?: string): number {
    const currentCount = this.countSync();
    if (currentCount > 0) {
      return 0;
    }

    const resolved = resolveFixturePath(fixturePath);
    if (!resolved || !fs.existsSync(resolved)) {
      return 0;
    }

    const report = parseSafetyGateFileSync(resolved);
    const normalized = normalizeAlerts(report.notifications).map((alert) => {
      const rec = alert as Record<string, unknown>;
      return {
        ...alert,
        year: rec.year ? String(rec.year) : (report.reportYear || ''),
        week: rec.week ? String(rec.week) : (report.reportWeek || ''),
      } as AlertRecord;
    });

    return this.insertAlertsSync(normalized);
  }

  async clear(): Promise<void> {
    this.db.exec('DELETE FROM alert_eans; DELETE FROM alerts;');
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Factory helper for coldstart SQLite storage with automatic seeding if empty.
 */
export function initColdstartStorage(
  locationOrDb: string | DatabaseSync = process.env.SQLITE_DB_PATH || ':memory:',
  options: SqliteAlertStorageOptions = { autoSeed: true },
): SqliteAlertStorage {
  return new SqliteAlertStorage(locationOrDb, {
    autoSeed: options.autoSeed !== false,
    fixturePath: options.fixturePath,
  });
}
