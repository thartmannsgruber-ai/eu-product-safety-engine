import { cleanBarcode, isValidEan } from './gtin.js';
import { isIsbn10Asin } from './asin.js';

export const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_CSV_DATA_ROWS = 10_000;

export class CsvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CsvLimitError';
    Object.setPrototypeOf(this, CsvLimitError.prototype);
  }
}

export interface ParseCsvOptions {
  delimiter?: string;
}

export interface CsvItem {
  row: number;
  identifier: string;
  ean?: string;
  asin?: string;
  url?: string;
  sku?: string;
  name?: string;
}

export interface CsvError {
  row: number;
  reason: string;
}

export class AsinEanMap extends Map<string, string> {
  override set(asin: string, ean: string): this {
    if (asin && ean) {
      const normalizedKey = asin.trim().toUpperCase();
      const cleanedEan = cleanBarcode(ean);
      super.set(normalizedKey, cleanedEan);
      (this as any)[normalizedKey] = cleanedEan;
    }
    return this;
  }

  override get(asin: string): string | undefined {
    if (!asin) return undefined;
    return super.get(asin.trim().toUpperCase());
  }

  override has(asin: string): boolean {
    if (!asin) return false;
    return super.has(asin.trim().toUpperCase());
  }

  lookup(asin: string): string | null {
    if (!asin) return null;
    return this.get(asin) ?? null;
  }
}

export interface MapCsvResult {
  rows: CsvItem[];
  errors: CsvError[];
  asinEanMap: AsinEanMap;
}

const SCIENTIFIC_NOTATION_REGEX = /^[+-]?\d+(?:[.,]\d+)?[eE][+-]?\d+$/i;

export function isScientificNotation(val: string): boolean {
  if (!val) return false;
  return SCIENTIFIC_NOTATION_REGEX.test(val.trim());
}

/**
 * Detects delimiter (',', ';', '\t') from the first non-empty line of text.
 */
export function detectDelimiter(text: string): string {
  let inQuotes = false;
  const counts: Record<string, number> = { ';': 0, ',': 0, '\t': 0 };

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && i + 1 < text.length && text[i + 1] === '"') {
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (!inQuotes) {
      if (char === '\n' || char === '\r') {
        if (counts[';'] > 0 || counts[','] > 0 || counts['\t'] > 0) {
          break;
        }
      } else if (char in counts) {
        counts[char]++;
      }
    }
  }

  let best = ',';
  let max = 0;
  for (const delim of [';', '\t', ',']) {
    if (counts[delim] > max) {
      max = counts[delim];
      best = delim;
    }
  }
  return best;
}

function isEmptyRow(row: string[]): boolean {
  if (row.length === 0) return true;
  return row.every((cell) => cell.trim() === '');
}

/**
 * Parses RFC-4180 CSV text into 2D string array.
 * Strips UTF-8 BOM, auto-detects delimiter, handles quoted fields, double quotes,
 * line breaks inside fields, CRLF/LF, and empty lines.
 */
export function parseCsv(text: string, options?: ParseCsvOptions): string[][] {
  if (typeof text !== 'string') {
    throw new TypeError('CSV-Text muss ein String sein');
  }

  const byteLength = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf-8') : text.length;
  if (byteLength > MAX_CSV_BYTES) {
    throw new CsvLimitError(
      `CSV überschreitet das Limit von 5 MB (${(byteLength / (1024 * 1024)).toFixed(2)} MB)`
    );
  }

  let content = text;
  // Remove UTF-8 BOM if present
  if (content.charCodeAt(0) === 0xfeff) {
    content = content.slice(1);
  }

  if (!content.trim()) {
    return [];
  }

  const delimiter = options?.delimiter || detectDelimiter(content);
  const delimLen = delimiter.length;

  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = content.length;

  while (i < len) {
    const char = content[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && content[i + 1] === '"') {
          // Escaped quote ("")
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          // Skip whitespace until delimiter or newline
          while (
            i < len &&
            content[i] !== delimiter &&
            content[i] !== '\r' &&
            content[i] !== '\n' &&
            (content[i] === ' ' || content[i] === '\t')
          ) {
            i++;
          }
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      // Outside quotes
      if (char === '"' && currentField.trim() === '') {
        // Start of quoted field
        currentField = '';
        inQuotes = true;
        i++;
        continue;
      } else if (content.startsWith(delimiter, i)) {
        currentRow.push(currentField);
        currentField = '';
        i += delimLen;
        continue;
      } else if (char === '\r') {
        if (i + 1 < len && content[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        currentField = '';
        if (!isEmptyRow(currentRow)) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      } else if (char === '\n') {
        currentRow.push(currentField);
        currentField = '';
        if (!isEmptyRow(currentRow)) {
          rows.push(currentRow);
        }
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  // Flush remaining field and row
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    if (!isEmptyRow(currentRow)) {
      rows.push(currentRow);
    }
  }

  // Row limit check
  const hasHeader = rows.length > 0 && isHeaderRow(rows[0]);
  const dataRowCount = hasHeader ? rows.length - 1 : rows.length;
  if (dataRowCount > MAX_CSV_DATA_ROWS) {
    throw new CsvLimitError(
      `CSV überschreitet das Limit von 10.000 Datenzeilen (${dataRowCount} gefunden)`
    );
  }

  return rows;
}

const EAN_HEADER_REGEX = /^(ean|gtin|barcode|upc|ean13|ean_13|ean_code|ean-code|gtin_code|gtin-code)$/i;
const ASIN_HEADER_REGEX = /^asin$/i;
const URL_HEADER_REGEX = /^(url|amazon_url|amazon-url|link|product_url|product-url)$/i;
const SKU_HEADER_REGEX = /^(sku|artikelnummer|item_id|item-id|itemid|artikelnr|artikel_nummer)$/i;
const NAME_HEADER_REGEX = /^(name|title|titel|produkt|product_name|product-name|produktname|produkt_name)$/i;
const IDENTIFIER_HEADER_REGEX = /^(identifier|kennung|id)$/i;

function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function isHeaderRow(row: string[]): boolean {
  if (!row || row.length === 0) return false;
  return row.some((cell) => {
    const norm = normalizeHeader(cell);
    return (
      EAN_HEADER_REGEX.test(norm) ||
      ASIN_HEADER_REGEX.test(norm) ||
      URL_HEADER_REGEX.test(norm) ||
      SKU_HEADER_REGEX.test(norm) ||
      NAME_HEADER_REGEX.test(norm) ||
      IDENTIFIER_HEADER_REGEX.test(norm)
    );
  });
}

/**
 * Maps parsed CSV rows to structured CsvItems, collects errors, and populates asinEanMap.
 */
export function mapCsvRows(parsed: string[][] | string): MapCsvResult {
  const table = typeof parsed === 'string' ? parseCsv(parsed) : parsed;

  const rows: CsvItem[] = [];
  const errors: CsvError[] = [];
  const asinEanMap = new AsinEanMap();

  if (!table || table.length === 0) {
    return { rows, errors, asinEanMap };
  }

  const hasHeader = isHeaderRow(table[0]);
  const dataRowCount = hasHeader ? table.length - 1 : table.length;
  if (dataRowCount > MAX_CSV_DATA_ROWS) {
    throw new CsvLimitError(
      `CSV überschreitet das Limit von 10.000 Datenzeilen (${dataRowCount} gefunden)`
    );
  }

  if (hasHeader) {
    const headerRow = table[0];
    let eanIdx = -1;
    let asinIdx = -1;
    let urlIdx = -1;
    let skuIdx = -1;
    let nameIdx = -1;
    let identifierIdx = -1;

    for (let c = 0; c < headerRow.length; c++) {
      const norm = normalizeHeader(headerRow[c]);
      if (eanIdx === -1 && EAN_HEADER_REGEX.test(norm)) {
        eanIdx = c;
      } else if (asinIdx === -1 && ASIN_HEADER_REGEX.test(norm)) {
        asinIdx = c;
      } else if (urlIdx === -1 && URL_HEADER_REGEX.test(norm)) {
        urlIdx = c;
      } else if (skuIdx === -1 && SKU_HEADER_REGEX.test(norm)) {
        skuIdx = c;
      } else if (nameIdx === -1 && NAME_HEADER_REGEX.test(norm)) {
        nameIdx = c;
      } else if (identifierIdx === -1 && IDENTIFIER_HEADER_REGEX.test(norm)) {
        identifierIdx = c;
      }
    }

    for (let i = 1; i < table.length; i++) {
      const row = table[i];
      const rowNumber = i + 1; // 1-based row in CSV file

      if (isEmptyRow(row)) {
        continue;
      }

      const rawEan = eanIdx >= 0 && row[eanIdx] !== undefined ? row[eanIdx].trim() : undefined;
      const rawAsin = asinIdx >= 0 && row[asinIdx] !== undefined ? row[asinIdx].trim() : undefined;
      const rawUrl = urlIdx >= 0 && row[urlIdx] !== undefined ? row[urlIdx].trim() : undefined;
      const rawSku = skuIdx >= 0 && row[skuIdx] !== undefined ? row[skuIdx].trim() : undefined;
      const rawName = nameIdx >= 0 && row[nameIdx] !== undefined ? row[nameIdx].trim() : undefined;
      const rawIdentifier =
        identifierIdx >= 0 && row[identifierIdx] !== undefined ? row[identifierIdx].trim() : undefined;

      // Check for scientific notation in EAN
      if (rawEan && isScientificNotation(rawEan)) {
        errors.push({
          row: rowNumber,
          reason: `EAN '${rawEan}' liegt in wissenschaftlicher Excel-Notation vor und kann nicht wiederhergestellt werden`,
        });
        continue;
      }

      if (rawIdentifier && isScientificNotation(rawIdentifier)) {
        errors.push({
          row: rowNumber,
          reason: `Kennung '${rawIdentifier}' liegt in wissenschaftlicher Excel-Notation vor und kann nicht wiederhergestellt werden`,
        });
        continue;
      }

      const ean = rawEan ? cleanBarcode(rawEan) : undefined;
      const asin = rawAsin ? rawAsin.toUpperCase() : undefined;
      const url = rawUrl || undefined;
      const sku = rawSku || undefined;
      const name = rawName || undefined;

      const identifier = rawIdentifier || ean || asin || url || sku || name;

      if (!identifier) {
        errors.push({
          row: rowNumber,
          reason: 'Keine Kennung (EAN, ASIN, URL oder SKU) in der Zeile vorhanden',
        });
        continue;
      }

      const item: CsvItem = {
        row: rowNumber,
        identifier,
      };

      if (ean) item.ean = ean;
      if (asin) item.asin = asin;
      if (url) item.url = url;
      if (sku) item.sku = sku;
      if (name) item.name = name;

      rows.push(item);

      // Populate asinEanMap if both ASIN and EAN are present
      if (asin && ean) {
        asinEanMap.set(asin, ean);
      }
    }
  } else {
    // No header: every row is treated as identifier in the first column
    for (let i = 0; i < table.length; i++) {
      const row = table[i];
      const rowNumber = i + 1;

      if (isEmptyRow(row)) {
        continue;
      }

      const col0 = row[0] ? row[0].trim() : '';
      if (!col0) {
        errors.push({
          row: rowNumber,
          reason: 'Kennung in Spalte 1 fehlt oder ist leer',
        });
        continue;
      }

      if (isScientificNotation(col0)) {
        errors.push({
          row: rowNumber,
          reason: `Kennung '${col0}' liegt in wissenschaftlicher Excel-Notation vor und kann nicht wiederhergestellt werden`,
        });
        continue;
      }

      const item: CsvItem = {
        row: rowNumber,
        identifier: col0,
      };

      // Check for ASIN and EAN across all columns to populate asinEanMap
      let foundEan: string | undefined;
      let foundAsin: string | undefined;

      for (let c = 0; c < row.length; c++) {
        const val = row[c] ? row[c].trim() : '';
        if (!val || isScientificNotation(val)) continue;
        if (!foundEan && isValidEan(val)) {
          foundEan = cleanBarcode(val);
        } else if (!foundAsin && (/^B0[A-Z0-9]{8}$/i.test(val) || isIsbn10Asin(val))) {
          foundAsin = val.toUpperCase();
        }
      }

      if (foundAsin && foundEan) {
        asinEanMap.set(foundAsin, foundEan);
      }

      rows.push(item);
    }
  }

  return { rows, errors, asinEanMap };
}
