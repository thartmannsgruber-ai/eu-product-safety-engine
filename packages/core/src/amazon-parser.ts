import { cleanBarcode, isValidEan, isValidUpcA } from './gtin.js';
import { isValidAsin, isIsbn10Asin, isbn10ToEan13 } from './asin.js';

export type AmazonProductIdType = 'ASIN' | 'ISBN' | 'UPC' | 'EAN' | 'UNKNOWN';

export interface AmazonInventoryItem {
  row: number;
  sellerSku: string;
  sku?: string;
  asin1?: string;
  asin?: string;
  itemName?: string;
  title?: string;
  productId?: string;
  productIdType?: AmazonProductIdType;
  productIdTypeNumeric?: number;
  productIdTypeRaw?: string;
  price?: number;
  quantity?: number;
  ean?: string;
  upc?: string;
  eanCorrupted?: boolean;
  identifierWarning?: 'EAN_CORRUPTED_EXCEL' | 'EAN_SUSPECT_TRUNCATED' | 'INVALID_EAN_CHECKSUM' | string;
  raw?: Record<string, string>;
}

export interface AmazonParserError {
  row: number;
  sku?: string;
  reason: string;
  code?: string;
  rawRow?: string[];
}

export interface AmazonDuplicateItem {
  row: number;
  firstSeenRow: number;
  sellerSku: string;
  asin?: string;
}

export interface AmazonParserStats {
  totalRows: number;
  dataRows: number;
  validItems: number;
  errorRows: number;
  duplicateRows: number;
  emptyRows: number;
  delimiter: string;
  hasBom: boolean;
  columnMapping: Record<string, string>;
}

export interface AmazonParseResult {
  items: AmazonInventoryItem[];
  errors: AmazonParserError[];
  duplicates: AmazonDuplicateItem[];
  stats: AmazonParserStats;
  asinEanMap: Map<string, string>;
  bySku: Map<string, AmazonInventoryItem>;
  byAsin: Map<string, AmazonInventoryItem>;
}

export interface ParseAmazonReportOptions {
  delimiter?: string;
  deduplicate?: boolean;
  deduplicateBy?: 'sellerSku' | 'asin' | 'none';
  convertScientific?: boolean;
  maxBytes?: number;
  maxRows?: number;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024; // 25 MB
const DEFAULT_MAX_ROWS = 100_000;

export class AmazonParserLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AmazonParserLimitError';
    Object.setPrototypeOf(this, AmazonParserLimitError.prototype);
  }
}

/**
 * Strips UTF-8 (\uFEFF) and UTF-16 (\uFFFE) BOMs from input string.
 */
export function stripBom(text: string): { content: string; hasBom: boolean } {
  if (!text) return { content: '', hasBom: false };
  let hasBom = false;
  let content = text;

  if (content.charCodeAt(0) === 0xfeff || content.charCodeAt(0) === 0xfffe) {
    hasBom = true;
    content = content.slice(1);
  } else if (content.startsWith('\xef\xbb\xbf')) {
    hasBom = true;
    content = content.slice(3);
  }

  return { content, hasBom };
}

/**
 * Converts scientific notation numbers (e.g. 4.00638E+12 or 4,00638E+12)
 * cleanly into complete digit strings (e.g. 4006380000000).
 * Also cleans surrounding quotes and Excel float artifacts like .0.
 */
export function convertScientificToString(val: unknown): string {
  if (val === null || val === undefined) return '';
  let s = String(val).trim();
  if (!s) return '';

  // Remove surrounding single and double quotes
  s = s.replace(/^["']+|["']+$/g, '').trim();
  if (!s) return '';

  // Scientific notation regex: mantissa with optional dot/comma + exponent
  const sciMatch = s.match(/^([+-]?\d+)(?:[.,](\d+))?[eE]([+-]?\d+)$/i);
  if (sciMatch) {
    const isNegative = sciMatch[1].startsWith('-');
    const sign = isNegative ? '-' : '';
    const intPart = sciMatch[1].replace(/^[+-]/, '');
    const decPart = sciMatch[2] || '';
    const exp = parseInt(sciMatch[3], 10);

    if (exp >= 0) {
      if (exp >= decPart.length) {
        const zeros = '0'.repeat(exp - decPart.length);
        return `${sign}${intPart}${decPart}${zeros}`;
      } else {
        const beforeDot = intPart + decPart.slice(0, exp);
        const afterDot = decPart.slice(exp);
        if (/^0+$/.test(afterDot)) {
          return `${sign}${beforeDot}`;
        }
        return `${sign}${beforeDot}.${afterDot}`;
      }
    } else {
      // Negative exponent
      const absExp = Math.abs(exp);
      const zeros = '0'.repeat(absExp - 1);
      return `${sign}0.${zeros}${intPart}${decPart}`;
    }
  }

  // Handle Excel float export of integers: e.g. "4006381333931.0" or "4006381333931,00"
  if (/^[+-]?\d+[.,]0+$/.test(s)) {
    return s.replace(/[.,]0+$/, '');
  }

  return s;
}

/**
 * Detects whether a string in scientific notation represents a truncated number where
 * precision was lost (e.g. Excel exporting 4.00638E+12 instead of full 13 digits).
 * If the positive exponent is strictly greater than the number of decimal digits provided,
 * trailing zeros would have to be invented, which corrupts EAN/UPC barcodes.
 */
export function isScientificNotationTruncated(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  const s = String(val).trim().replace(/^["']+|["']+$/g, '');
  const sciMatch = s.match(/^([+-]?\d+)(?:[.,](\d+))?[eE]([+-]?\d+)$/i);
  if (!sciMatch) return false;
  const decPart = sciMatch[2] || '';
  const exp = parseInt(sciMatch[3], 10);
  return exp > 0 && exp > decPart.length;
}

/**
 * Detects numbers that were likely saved from Excel after exponential truncation,
 * resulting in trailing invented zeros (e.g. 4006380000000 or 123450000000).
 * Barcodes with 5 or more trailing zeros on 12-14 digit numbers indicate artificial zero-padding.
 */
export function isSuspectZeroPaddedEan(val: unknown): boolean {
  if (val === null || val === undefined) return false;
  const s = String(val).trim().replace(/^["']+|["']+$/g, '');
  return /^\d{12,14}$/.test(s) && /0{5,}$/.test(s);
}

/**
 * Normalizes a header string by converting to lowercase and stripping punctuation.
 */
export function normalizeHeaderKey(header: string): string {
  if (!header) return '';
  return header
    .toLowerCase()
    .trim()
    .replace(/[ä]/g, 'ae')
    .replace(/[ö]/g, 'oe')
    .replace(/[ü]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Normalizes Amazon product-id-type (1=ASIN, 2=ISBN, 3=UPC, 4=EAN).
 */
export function normalizeProductIdType(raw: unknown): AmazonProductIdType {
  if (raw === null || raw === undefined) return 'UNKNOWN';
  const s = String(raw).trim().toUpperCase();
  if (s === '1' || s === 'ASIN') return 'ASIN';
  if (s === '2' || s === 'ISBN') return 'ISBN';
  if (s === '3' || s === 'UPC') return 'UPC';
  if (s === '4' || s === 'EAN' || s === 'GTIN') return 'EAN';
  return 'UNKNOWN';
}

/**
 * Returns numeric representation of product ID type (1=ASIN, 2=ISBN, 3=UPC, 4=EAN).
 */
export function productIdTypeToNumeric(type: unknown): number | undefined {
  if (type === null || type === undefined) return undefined;
  if (typeof type === 'number') {
    if ([1, 2, 3, 4].includes(type)) return type;
    return undefined;
  }
  const s = String(type).trim().toUpperCase();
  if (s === '1' || s === 'ASIN') return 1;
  if (s === '2' || s === 'ISBN') return 2;
  if (s === '3' || s === 'UPC') return 3;
  if (s === '4' || s === 'EAN' || s === 'GTIN') return 4;
  return undefined;
}

/**
 * Auto-detects delimiter: \t, ;, or ,.
 * Amazon reports predominantly use \t.
 */
export function detectReportDelimiter(text: string): string {
  let inQuotes = false;
  const counts: Record<string, number> = { '\t': 0, ';': 0, ',': 0 };

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
        if (counts['\t'] > 0 || counts[';'] > 0 || counts[','] > 0) {
          break;
        }
      } else if (char in counts) {
        counts[char]++;
      }
    }
  }

  // If tabs are present, prioritize tab for Amazon reports
  if (counts['\t'] > 0 && counts['\t'] >= counts[';'] && counts['\t'] >= counts[',']) {
    return '\t';
  }
  if (counts[';'] > counts[',']) {
    return ';';
  }
  if (counts[','] > 0) {
    return ',';
  }
  // Default to tab for Amazon reports if unclear
  return '\t';
}

/**
 * Parses raw text into rows and columns respecting quoted cells.
 */
export function tokenizeReport(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = '';
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  const delimLen = delimiter.length;

  while (i < len) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < len && text[i + 1] === '"') {
          // Escaped quote
          currentField += '"';
          i += 2;
          continue;
        } else {
          // End of quote
          inQuotes = false;
          i++;
          // Skip trailing whitespace after closing quote until delimiter/newline
          while (
            i < len &&
            text[i] !== delimiter &&
            text[i] !== '\r' &&
            text[i] !== '\n' &&
            (text[i] === ' ' || text[i] === '\t')
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
      if (char === '"') {
        if (currentField.trim() === '') {
          inQuotes = true;
          currentField = '';
          i++;
          continue;
        } else {
          currentField += char;
          i++;
          continue;
        }
      }

      if (text.startsWith(delimiter, i)) {
        currentRow.push(currentField);
        currentField = '';
        i += delimLen;
        continue;
      }

      if (char === '\r') {
        if (i + 1 < len && text[i + 1] === '\n') {
          i++;
        }
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
        continue;
      }

      if (char === '\n') {
        currentRow.push(currentField);
        rows.push(currentRow);
        currentRow = [];
        currentField = '';
        i++;
        continue;
      }

      currentField += char;
      i++;
    }
  }

  // Push last field/row
  if (currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parses numeric price string into float. Handles both comma and period decimals.
 */
export function parsePrice(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d.,]/g, '').trim();
  if (!cleaned) return undefined;

  // Handle German vs English format
  let normalized = cleaned;
  if (normalized.includes(',') && !normalized.includes('.')) {
    normalized = normalized.replace(',', '.');
  } else if (normalized.includes('.') && normalized.includes(',')) {
    if (normalized.indexOf('.') < normalized.indexOf(',')) {
      // 1.234,56
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      // 1,234.56
      normalized = normalized.replace(/,/g, '');
    }
  }

  const val = parseFloat(normalized);
  return isNaN(val) ? undefined : val;
}

/**
 * Parses integer quantity string.
 */
export function parseQuantity(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^\d-]/g, '').trim();
  if (!cleaned) return undefined;
  const val = parseInt(cleaned, 10);
  return isNaN(val) ? undefined : val;
}

interface ColumnIndices {
  sellerSku: number;
  asin1: number;
  itemName: number;
  productId: number;
  productIdType: number;
  price: number;
  quantity: number;
}

/**
 * Maps header names to Amazon column indices.
 */
function identifyColumns(headerRow: string[]): { indices: ColumnIndices; mapping: Record<string, string> } {
  const indices: ColumnIndices = {
    sellerSku: -1,
    asin1: -1,
    itemName: -1,
    productId: -1,
    productIdType: -1,
    price: -1,
    quantity: -1,
  };
  const mapping: Record<string, string> = {};

  for (let c = 0; c < headerRow.length; c++) {
    const rawHeader = headerRow[c];
    const norm = normalizeHeaderKey(rawHeader);

    // seller-sku
    if (
      indices.sellerSku === -1 &&
      (norm === 'sellersku' ||
        norm === 'sku' ||
        norm === 'itemsku' ||
        norm === 'verkaeufersku' ||
        norm === 'haendlersku' ||
        norm === 'merchantsku')
    ) {
      indices.sellerSku = c;
      mapping['sellerSku'] = rawHeader;
      continue;
    }

    // asin1
    if (
      indices.asin1 === -1 &&
      (norm === 'asin1' ||
        norm === 'asin' ||
        norm === 'asinnummer' ||
        norm === 'amazonasin')
    ) {
      indices.asin1 = c;
      mapping['asin1'] = rawHeader;
      continue;
    }

    // item-name / title
    if (
      indices.itemName === -1 &&
      (norm === 'itemname' ||
        norm === 'productname' ||
        norm === 'title' ||
        norm === 'titel' ||
        norm === 'name' ||
        norm === 'artikelname' ||
        norm === 'artikelbezeichnung' ||
        norm === 'itemdescription')
    ) {
      indices.itemName = c;
      mapping['itemName'] = rawHeader;
      continue;
    }

    // product-id-type (check before product-id to avoid sub-matching)
    if (
      indices.productIdType === -1 &&
      (norm === 'productidtype' ||
        norm === 'externalproductidtype' ||
        norm === 'standardproductidtype' ||
        norm === 'produktidtyp' ||
        norm === 'idtype')
    ) {
      indices.productIdType = c;
      mapping['productIdType'] = rawHeader;
      continue;
    }

    // product-id
    if (
      indices.productId === -1 &&
      (norm === 'productid' ||
        norm === 'externalproductid' ||
        norm === 'standardproductid' ||
        norm === 'produktid' ||
        norm === 'ean' ||
        norm === 'gtin' ||
        norm === 'upc' ||
        norm === 'barcode')
    ) {
      indices.productId = c;
      mapping['productId'] = rawHeader;
      continue;
    }

    // price
    if (
      indices.price === -1 &&
      (norm === 'price' ||
        norm === 'itemprice' ||
        norm === 'standardprice' ||
        norm === 'preis')
    ) {
      indices.price = c;
      mapping['price'] = rawHeader;
      continue;
    }

    // quantity
    if (
      indices.quantity === -1 &&
      (norm === 'quantity' ||
        norm === 'qty' ||
        norm === 'inventoryquantity' ||
        norm === 'menge' ||
        norm === 'bestand' ||
        norm === 'anzahl')
    ) {
      indices.quantity = c;
      mapping['quantity'] = rawHeader;
      continue;
    }
  }

  return { indices, mapping };
}

/**
 * Main parser for native Amazon Seller Central Inventory Reports (TSV or CSV).
 * Handles tab, semicolon, comma delimiters, BOM, scientific notation, header normalization,
 * and duplicate detection.
 */
export function parseAmazonInventoryReport(
  text: string,
  options?: ParseAmazonReportOptions
): AmazonParseResult {
  if (typeof text !== 'string') {
    throw new TypeError('Amazon-Bericht muss als String übergeben werden');
  }

  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const byteLength = typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf-8') : text.length;
  if (byteLength > maxBytes) {
    throw new AmazonParserLimitError(
      `Amazon-Bericht überschreitet das Limit von ${(maxBytes / (1024 * 1024)).toFixed(0)} MB`
    );
  }

  const { content, hasBom } = stripBom(text);
  if (!content.trim()) {
    return {
      items: [],
      errors: [],
      duplicates: [],
      stats: {
        totalRows: 0,
        dataRows: 0,
        validItems: 0,
        errorRows: 0,
        duplicateRows: 0,
        emptyRows: 0,
        delimiter: options?.delimiter || '\t',
        hasBom,
        columnMapping: {},
      },
      asinEanMap: new Map(),
      bySku: new Map(),
      byAsin: new Map(),
    };
  }

  const delimiter = options?.delimiter || detectReportDelimiter(content);
  const rows = tokenizeReport(content, delimiter);

  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  if (rows.length > maxRows) {
    throw new AmazonParserLimitError(
      `Amazon-Bericht überschreitet das Zeilenlimit von ${maxRows} Zeilen (${rows.length} gefunden)`
    );
  }

  if (rows.length === 0) {
    return {
      items: [],
      errors: [],
      duplicates: [],
      stats: {
        totalRows: 0,
        dataRows: 0,
        validItems: 0,
        errorRows: 0,
        duplicateRows: 0,
        emptyRows: 0,
        delimiter,
        hasBom,
        columnMapping: {},
      },
      asinEanMap: new Map(),
      bySku: new Map(),
      byAsin: new Map(),
    };
  }

  // First non-empty row is header
  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((cell) => cell.trim() !== '')) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex === -1) {
    return {
      items: [],
      errors: [],
      duplicates: [],
      stats: {
        totalRows: rows.length,
        dataRows: 0,
        validItems: 0,
        errorRows: 0,
        duplicateRows: 0,
        emptyRows: rows.length,
        delimiter,
        hasBom,
        columnMapping: {},
      },
      asinEanMap: new Map(),
      bySku: new Map(),
      byAsin: new Map(),
    };
  }

  const headerRow = rows[headerIndex];
  const { indices, mapping } = identifyColumns(headerRow);

  const deduplicate = options?.deduplicate !== false;
  const deduplicateBy = options?.deduplicateBy ?? 'sellerSku';
  const shouldConvertScientific = options?.convertScientific !== false;

  const items: AmazonInventoryItem[] = [];
  const errors: AmazonParserError[] = [];
  const duplicates: AmazonDuplicateItem[] = [];
  const asinEanMap = new Map<string, string>();
  const bySku = new Map<string, AmazonInventoryItem>();
  const byAsin = new Map<string, AmazonInventoryItem>();

  const seenKeys = new Map<string, number>(); // key -> firstSeenRow

  let dataRowCount = 0;
  let emptyRowCount = headerIndex; // rows before header

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const rowNumber = i + 1; // 1-based line number

    // Check if row is entirely empty
    if (row.every((cell) => cell.trim() === '')) {
      emptyRowCount++;
      continue;
    }

    dataRowCount++;

    // Extract raw fields
    const rawSku = indices.sellerSku >= 0 && row[indices.sellerSku] !== undefined
      ? row[indices.sellerSku].trim()
      : '';
    const rawAsin = indices.asin1 >= 0 && row[indices.asin1] !== undefined
      ? row[indices.asin1].trim()
      : '';
    const rawName = indices.itemName >= 0 && row[indices.itemName] !== undefined
      ? row[indices.itemName].trim()
      : '';
    const rawProductId = indices.productId >= 0 && row[indices.productId] !== undefined
      ? row[indices.productId].trim()
      : '';
    const rawProductIdType = indices.productIdType >= 0 && row[indices.productIdType] !== undefined
      ? row[indices.productIdType].trim()
      : '';
    const rawPrice = indices.price >= 0 && row[indices.price] !== undefined
      ? row[indices.price].trim()
      : '';
    const rawQty = indices.quantity >= 0 && row[indices.quantity] !== undefined
      ? row[indices.quantity].trim()
      : '';

    // Validation: at least seller-sku or asin1 must be present
    if (!rawSku && !rawAsin) {
      errors.push({
        row: rowNumber,
        reason: 'Zeile enthält weder seller-sku noch asin1',
        code: 'MISSING_REQUIRED_IDENTIFIER',
        rawRow: row,
      });
      continue;
    }

    // Process Product ID & scientific notation conversion
    let productId = rawProductId;
    const isTruncated = isScientificNotationTruncated(productId);
    const isZeroPadded = isSuspectZeroPaddedEan(productId);
    if (shouldConvertScientific && productId) {
      productId = convertScientificToString(productId);
    }
    // Clean outer quotes if any remained
    productId = productId.replace(/^["']+|["']+$/g, '').trim();

    // Determine Product ID Type
    const productIdType = normalizeProductIdType(rawProductIdType);
    const productIdTypeNumeric = productIdTypeToNumeric(rawProductIdType);

    // Process SKU
    const sellerSku = rawSku || rawAsin;

    // Process ASIN
    let asin = rawAsin ? rawAsin.toUpperCase() : undefined;
    if (!asin && productIdType === 'ASIN' && isValidAsin(productId)) {
      asin = productId.toUpperCase();
    }

    // Process EAN / UPC with strict checksum verification
    let ean: string | undefined;
    let upc: string | undefined;
    let eanCorrupted = false;
    let identifierWarning: 'EAN_CORRUPTED_EXCEL' | 'EAN_SUSPECT_TRUNCATED' | 'INVALID_EAN_CHECKSUM' | undefined;

    if (isTruncated || isZeroPadded) {
      eanCorrupted = true;
      identifierWarning = isTruncated ? 'EAN_CORRUPTED_EXCEL' : 'EAN_SUSPECT_TRUNCATED';
      errors.push({
        row: rowNumber,
        sku: sellerSku,
        reason: `EAN durch Excel verstümmelt oder verdächtige Null-Auffüllung (${rawProductId}). Manuelle Prüfung erforderlich.`,
        code: identifierWarning,
        rawRow: row,
      });
      // Do NOT set ean! Prevent matching on truncated zero-padded fake barcodes.
    } else if (productId) {
      const cleaned = cleanBarcode(productId);
      if (isValidEan(cleaned)) {
        ean = cleaned;
      } else if (isValidUpcA(cleaned)) {
        upc = cleaned;
        ean = cleaned; // UPC-A is a valid GTIN-12 and EAN-compatible
      } else if (productIdType === 'ISBN') {
        if (isIsbn10Asin(productId)) {
          ean = isbn10ToEan13(productId);
        } else if (isValidEan(cleaned)) {
          ean = cleaned;
        }
      } else if (productIdType === 'EAN' || productIdType === 'UPC') {
        identifierWarning = 'INVALID_EAN_CHECKSUM';
        errors.push({
          row: rowNumber,
          sku: sellerSku,
          reason: `Produkt-ID ${productId} als ${productIdType} deklariert, besitzt jedoch eine ungültige Prüfziffer`,
          code: 'INVALID_EAN_CHECKSUM',
          rawRow: row,
        });
      }
    }

    // Also if ASIN is ISBN-10, we can derive EAN
    if (!ean && !eanCorrupted && asin && isIsbn10Asin(asin)) {
      ean = isbn10ToEan13(asin);
    }

    // Price & Quantity
    const price = parsePrice(rawPrice);
    const quantity = parseQuantity(rawQty);

    // Build raw mapping for row
    const rawMap: Record<string, string> = {};
    for (let c = 0; c < row.length && c < headerRow.length; c++) {
      rawMap[headerRow[c]] = row[c];
    }

    const item: AmazonInventoryItem = {
      row: rowNumber,
      sellerSku,
      sku: sellerSku,
      asin1: asin,
      asin,
      itemName: rawName || undefined,
      title: rawName || undefined,
      productId: productId || undefined,
      productIdType: productIdType !== 'UNKNOWN' ? productIdType : undefined,
      productIdTypeNumeric,
      productIdTypeRaw: rawProductIdType || undefined,
      price,
      quantity,
      ean,
      upc,
      eanCorrupted: eanCorrupted ? true : undefined,
      identifierWarning,
      raw: rawMap,
    };

    // Duplicate detection
    const dedupKey = deduplicateBy === 'asin'
      ? (asin || sellerSku).toUpperCase()
      : (deduplicateBy === 'sellerSku' ? sellerSku.toUpperCase() : null);

    if (dedupKey) {
      if (seenKeys.has(dedupKey)) {
        const firstSeenRow = seenKeys.get(dedupKey)!;
        duplicates.push({
          row: rowNumber,
          firstSeenRow,
          sellerSku,
          asin,
        });

        if (deduplicate) {
          // Skip adding duplicate to items list
          continue;
        }
      } else {
        seenKeys.set(dedupKey, rowNumber);
      }
    }

    items.push(item);

    // Index by SKU and ASIN
    if (sellerSku && !bySku.has(sellerSku)) {
      bySku.set(sellerSku, item);
    }
    if (asin && !byAsin.has(asin)) {
      byAsin.set(asin, item);
    }

    // Populate asinEanMap
    if (asin && ean) {
      asinEanMap.set(asin, ean);
    }
  }

  const stats: AmazonParserStats = {
    totalRows: rows.length,
    dataRows: dataRowCount,
    validItems: items.length,
    errorRows: errors.length,
    duplicateRows: duplicates.length,
    emptyRows: emptyRowCount,
    delimiter,
    hasBom,
    columnMapping: mapping,
  };

  return {
    items,
    errors,
    duplicates,
    stats,
    asinEanMap,
    bySku,
    byAsin,
  };
}
