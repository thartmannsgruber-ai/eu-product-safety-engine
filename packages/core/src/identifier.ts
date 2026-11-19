import { cleanBarcode, isValidEan, normalizeToGtin14 } from './gtin.js';
import {
  isIsbn10Asin,
  isbn10ToEan13,
  extractAsinFromUrl,
  extractSlugKeywords,
  AMAZON_TLDS,
  SHORTLINK_HOSTS,
} from './asin.js';

export type IdentifierKind = 'gtin' | 'isbn10' | 'asin' | 'amazon_url' | 'unknown';

export type ResolutionMethod = 'direct_gtin' | 'isbn10_conversion' | 'csv_mapping' | 'url_slug_keywords';

export interface ClassifiedIdentifier {
  kind: IdentifierKind;
  raw: string;
  normalized: string;
  ean?: string;
  asin?: string;
  keywords?: string[];
  needsRedirect?: boolean;
}

export interface AsinEanProvider {
  lookup(asin: string): string | null | Promise<string | null>;
}

export class MapAsinEanProvider implements AsinEanProvider {
  private readonly map = new Map<string, string>();

  constructor(entries?: Map<string, string> | Record<string, string> | Iterable<[string, string]>) {
    if (entries) {
      if (entries instanceof Map) {
        for (const [k, v] of entries) {
          this.set(k, v);
        }
      } else if (typeof (entries as any)[Symbol.iterator] === 'function') {
        for (const [k, v] of entries as Iterable<[string, string]>) {
          this.set(k, v);
        }
      } else if (typeof entries === 'object') {
        for (const [k, v] of Object.entries(entries)) {
          this.set(k, v);
        }
      }
    }
  }

  set(asin: string, ean: string): this {
    if (asin && ean) {
      this.map.set(asin.trim().toUpperCase(), cleanBarcode(ean));
    }
    return this;
  }

  get(asin: string): string | null {
    return this.lookup(asin);
  }

  has(asin: string): boolean {
    if (!asin) return false;
    return this.map.has(asin.trim().toUpperCase());
  }

  get size(): number {
    return this.map.size;
  }

  lookup(asin: string): string | null {
    if (!asin) return null;
    const key = asin.trim().toUpperCase();
    return this.map.get(key) ?? null;
  }
}

export interface ResolvedIdentifier {
  input: string;
  kind: IdentifierKind;
  ean?: string;
  keywords?: string[];
  resolution_method?: ResolutionMethod;
  needsRedirect?: boolean;
  error?: string;
}

function isAmazonUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed.includes('.') && !trimmed.includes('/')) {
    return false;
  }
  try {
    const normalizedUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    const parsed = new URL(normalizedUrl);
    const hostname = parsed.hostname.toLowerCase();
    if (SHORTLINK_HOSTS.has(hostname)) {
      return true;
    }
    for (const tld of AMAZON_TLDS) {
      const base = `amazon.${tld}`;
      if (hostname === base || hostname.endsWith(`.${base}`)) {
        return true;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function isPromise<T>(val: unknown): val is Promise<T> {
  return (
    val !== null &&
    (typeof val === 'object' || typeof val === 'function') &&
    typeof (val as any).then === 'function'
  );
}

/**
 * Classifies an identifier string (EAN/GTIN, ISBN-10, ASIN, Amazon URL, or unknown/free text)
 * and returns normalized metadata.
 */
export function classifyIdentifier(raw: string): ClassifiedIdentifier {
  if (typeof raw !== 'string') {
    return {
      kind: 'unknown',
      raw: String(raw ?? ''),
      normalized: '',
    };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {
      kind: 'unknown',
      raw,
      normalized: '',
    };
  }

  // 1. Amazon URLs (standard product pages or shortlinks)
  if (isAmazonUrl(trimmed)) {
    const extracted = extractAsinFromUrl(trimmed);
    const keywords = extractSlugKeywords(trimmed);

    if (extracted?.needsRedirect) {
      return {
        kind: 'amazon_url',
        raw,
        normalized: trimmed,
        needsRedirect: true,
      };
    }

    if (extracted?.asin) {
      const isIsbn = isIsbn10Asin(extracted.asin);
      return {
        kind: 'amazon_url',
        raw,
        normalized: extracted.asin,
        asin: extracted.asin,
        ean: isIsbn ? isbn10ToEan13(extracted.asin) : undefined,
        keywords: keywords.length > 0 ? keywords : undefined,
        needsRedirect: false,
      };
    }

    return {
      kind: 'amazon_url',
      raw,
      normalized: trimmed,
      keywords: keywords.length > 0 ? keywords : undefined,
      needsRedirect: false,
    };
  }

  // 2. GTIN / EAN barcodes (EAN-8, UPC-A, EAN-13, GTIN-14)
  if (isValidEan(trimmed)) {
    const gtin14 = normalizeToGtin14(trimmed)!;
    const cleaned = cleanBarcode(trimmed);
    return {
      kind: 'gtin',
      raw,
      normalized: gtin14,
      ean: cleaned,
    };
  }

  // 3. ISBN-10 (10 characters, Modulo 11 check digit)
  if (isIsbn10Asin(trimmed)) {
    const cleaned = trimmed.replace(/[-\s]/g, '').toUpperCase();
    const ean13 = isbn10ToEan13(cleaned);
    return {
      kind: 'isbn10',
      raw,
      normalized: cleaned,
      ean: ean13,
    };
  }

  // 4. B0-ASIN (10 alphanumeric characters starting with B0)
  const cleanedAsin = trimmed.replace(/[-\s]/g, '').toUpperCase();
  if (/^B0[A-Z0-9]{8}$/.test(cleanedAsin)) {
    return {
      kind: 'asin',
      raw,
      normalized: cleanedAsin,
      asin: cleanedAsin,
    };
  }

  // 5. Unknown / Free text
  return {
    kind: 'unknown',
    raw,
    normalized: trimmed,
  };
}

function finishResolution(raw: string, classified: ClassifiedIdentifier): ResolvedIdentifier {
  // 4. URL slug keywords
  if (classified.kind === 'amazon_url' && classified.keywords && classified.keywords.length > 0) {
    return {
      input: raw,
      kind: 'amazon_url',
      keywords: classified.keywords,
      resolution_method: 'url_slug_keywords',
    };
  }

  // 5. Unresolvable cases
  if (classified.needsRedirect) {
    return {
      input: raw,
      kind: 'amazon_url',
      needsRedirect: true,
      error: 'Kurzlink erfordert Weiterleitung (Redirect)',
    };
  }

  if (classified.kind === 'asin') {
    return {
      input: raw,
      kind: 'asin',
      error: `B0-ASIN '${classified.normalized || raw}' ohne Provider-Zuordnung und ohne Titel in der URL nicht auflösbar`,
    };
  }

  if (classified.kind === 'amazon_url') {
    return {
      input: raw,
      kind: 'amazon_url',
      error: 'Amazon-URL enthält weder auflösbare Kennung noch Produkttitel im Pfad',
    };
  }

  return {
    input: raw,
    kind: classified.kind,
    error: `Kennung '${raw}' konnte nicht aufgelöst werden`,
  };
}

/**
 * Resolves an identifier using the priority chain:
 * direct GTIN > ISBN-10 conversion > Provider mapping > URL slug keywords > unresolvable error.
 * Strictly local / zero network access.
 */
export function resolveIdentifier(
  raw: string,
  provider?: MapAsinEanProvider
): ResolvedIdentifier;
export function resolveIdentifier(
  raw: string,
  provider?: AsinEanProvider
): ResolvedIdentifier | Promise<ResolvedIdentifier>;
export function resolveIdentifier(
  raw: string,
  provider?: AsinEanProvider
): ResolvedIdentifier | Promise<ResolvedIdentifier> {
  if (typeof raw !== 'string' || !raw.trim()) {
    return {
      input: String(raw ?? ''),
      kind: 'unknown',
      error: 'Leere oder ungültige Kennung',
    };
  }

  const classified = classifyIdentifier(raw);

  // 1. Direct GTIN
  if (classified.kind === 'gtin') {
    return {
      input: raw,
      kind: 'gtin',
      ean: classified.ean || cleanBarcode(raw),
      resolution_method: 'direct_gtin',
    };
  }

  // 2. ISBN-10 conversion (standalone ISBN-10 or Amazon URL with ISBN-10 ASIN)
  if (classified.kind === 'isbn10') {
    const ean13 = classified.ean || isbn10ToEan13(classified.normalized);
    return {
      input: raw,
      kind: 'isbn10',
      ean: ean13,
      resolution_method: 'isbn10_conversion',
    };
  }

  if (classified.kind === 'amazon_url' && classified.asin && isIsbn10Asin(classified.asin)) {
    const ean13 = isbn10ToEan13(classified.asin);
    return {
      input: raw,
      kind: 'amazon_url',
      ean: ean13,
      resolution_method: 'isbn10_conversion',
      keywords: classified.keywords,
    };
  }

  // 3. Provider mapping (csv_mapping) for ASINs
  const asinToLookup =
    classified.kind === 'asin'
      ? classified.normalized
      : classified.kind === 'amazon_url'
        ? classified.asin
        : null;

  if (asinToLookup && provider) {
    const lookupResult = provider.lookup(asinToLookup);

    if (isPromise(lookupResult)) {
      return lookupResult.then((mappedEan) => {
        if (mappedEan) {
          return {
            input: raw,
            kind: classified.kind,
            ean: cleanBarcode(mappedEan),
            resolution_method: 'csv_mapping',
            keywords: classified.keywords,
          };
        }
        return finishResolution(raw, classified);
      });
    }

    if (lookupResult) {
      return {
        input: raw,
        kind: classified.kind,
        ean: cleanBarcode(lookupResult),
        resolution_method: 'csv_mapping',
        keywords: classified.keywords,
      };
    }
  }

  return finishResolution(raw, classified);
}
