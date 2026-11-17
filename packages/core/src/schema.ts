import { z } from 'zod';

/**
 * Clean string helper that handles null, undefined, numbers, and strings,
 * trimming leading/trailing whitespace.
 */
function cleanField(val: unknown): string | undefined {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val).trim();
  return undefined;
}

/**
 * Clean risk type field, supporting either a string or an array of risk types.
 */
function cleanRiskType(val: unknown): string | undefined {
  if (val === null || val === undefined) return '';
  if (Array.isArray(val)) {
    return val.map((v) => String(v).trim()).filter(Boolean).join(', ');
  }
  return cleanField(val);
}

/**
 * Normalizes input into an array of clean barcode strings.
 * - Trims whitespace around each barcode.
 * - Handles strings with multiple barcodes separated by commas, semicolons, or newlines.
 * - Filters out empty strings.
 * - Deduplicates entries while preserving order.
 */
export function normalizeBarcodes(input: unknown): string[] {
  if (input === null || input === undefined) return [];

  const rawList: string[] = [];

  if (Array.isArray(input)) {
    for (const item of input) {
      if (item === null || item === undefined) continue;
      const str = String(item).trim();
      if (!str) continue;
      if (/[,;\n\r]/.test(str)) {
        rawList.push(...str.split(/[,;\n\r]+/));
      } else {
        rawList.push(str);
      }
    }
  } else if (typeof input === 'string' || typeof input === 'number') {
    const str = String(input).trim();
    if (str) {
      if (/[,;\n\r]/.test(str)) {
        rawList.push(...str.split(/[,;\n\r]+/));
      } else {
        rawList.push(str);
      }
    }
  }

  const cleaned = rawList
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  return Array.from(new Set(cleaned));
}

/**
 * Helper to validate barcode inputs inside Zod preprocessors.
 * Preserves invalid elements so Zod type validation can reject them.
 */
function normalizeBarcodesInput(val: unknown): unknown {
  if (val === null || val === undefined) return [];
  if (Array.isArray(val)) {
    for (const item of val) {
      if (item !== null && item !== undefined && typeof item !== 'string' && typeof item !== 'number') {
        return val; // Return raw array containing non-string/number so z.array(z.string()) fails
      }
    }
    return normalizeBarcodes(val);
  }
  if (typeof val === 'string' || typeof val === 'number') {
    return normalizeBarcodes(val);
  }
  return val; // Return non-array/non-string so z.array(z.string()) fails
}

/**
 * Underlying Zod Object schema representing the normalized AlertRecord structure.
 */
export const AlertRecordObjectSchema = z.object({
  alert_number: z.string(),
  case_number: z.string(),
  publication_date: z.string(),
  category: z.string(),
  product: z.string(),
  brand: z.string(),
  model: z.string(),
  ean_barcodes: z.array(z.string()),
  risk_type: z.string(),
  danger_description: z.string(),
  measures: z.string(),
  notifying_country: z.string(),
  country_of_origin: z.string(),
  risk_level: z.string(),
  source_url: z.string(),
});

/**
 * Preprocessor function mapping both raw parser records (camelCase)
 * and already normalized objects (snake_case) into a canonical shape.
 */
function preprocessAlertRecord(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return input;
  }
  const raw = input as Record<string, unknown>;

  const alertNumberVal = raw.alert_number ?? raw.alertNumber ?? raw.order;
  const caseNumberVal = raw.case_number ?? raw.caseNumber;

  let barcodesVal: unknown = undefined;
  if (raw.ean_barcodes !== undefined) {
    barcodesVal = raw.ean_barcodes;
  } else if (raw.eanBarcodes !== undefined) {
    barcodesVal = raw.eanBarcodes;
  } else if (raw.barcodes !== undefined) {
    barcodesVal = raw.barcodes;
  } else if (raw.barcode !== undefined) {
    barcodesVal = raw.barcode;
  }

  return {
    alert_number: alertNumberVal !== undefined ? cleanField(alertNumberVal) : undefined,
    case_number: caseNumberVal !== undefined ? cleanField(caseNumberVal) : undefined,
    publication_date: cleanField(raw.publication_date ?? raw.publicationDate ?? ''),
    category: cleanField(raw.category ?? ''),
    product: cleanField(raw.product ?? ''),
    brand: cleanField(raw.brand ?? ''),
    model: cleanField(raw.model ?? raw.type_numberOfModel ?? raw.typeNumberOfModel ?? raw.name ?? ''),
    ean_barcodes: normalizeBarcodesInput(barcodesVal),
    risk_type: cleanRiskType(raw.risk_type ?? raw.riskType ?? ''),
    danger_description: cleanField(raw.danger_description ?? raw.danger ?? raw.description ?? ''),
    measures: cleanField(raw.measures ?? ''),
    notifying_country: cleanField(raw.notifying_country ?? raw.notifyingCountry ?? ''),
    country_of_origin: cleanField(raw.country_of_origin ?? raw.countryOfOrigin ?? ''),
    risk_level: cleanField(raw.risk_level ?? raw.level ?? ''),
    source_url: cleanField(raw.source_url ?? raw.sourceUrl ?? raw.reference ?? raw.URLrecall ?? ''),
  };
}

/**
 * Strictly typed Zod schema for normalized EU Safety Gate alert records.
 * Can parse and validate both raw parser output and normalized data objects.
 */
export const AlertRecordSchema: z.ZodType<AlertRecord, unknown> & {
  shape: typeof AlertRecordObjectSchema.shape;
} = Object.assign(
  z.preprocess(preprocessAlertRecord, AlertRecordObjectSchema) as unknown as z.ZodType<AlertRecord, unknown>,
  { shape: AlertRecordObjectSchema.shape }
);

/**
 * Inferred TypeScript type of a normalized AlertRecord.
 */
export type AlertRecord = z.infer<typeof AlertRecordObjectSchema>;

/**
 * Helper function to normalize a single alert record (from parser or raw input).
 */
export function normalizeAlert(raw: unknown): AlertRecord {
  return AlertRecordSchema.parse(raw);
}

/**
 * Helper function to normalize an array of alert records.
 */
export function normalizeAlerts(rawList: unknown[]): AlertRecord[] {
  if (!Array.isArray(rawList)) return [];
  return rawList.map((item) => normalizeAlert(item));
}
