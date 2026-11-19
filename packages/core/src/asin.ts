import { calculateCheckDigit } from './gtin.js';

export interface ExtractedAsin {
  asin: string | null;
  marketplace: string | null;
  needsRedirect: boolean;
}

export const AMAZON_TLDS = [
  'com.be',
  'com.tr',
  'com.mx',
  'com.au',
  'co.uk',
  'co.jp',
  'de',
  'com',
  'fr',
  'it',
  'es',
  'nl',
  'pl',
  'se',
  'ca',
  'in',
] as const;

export type AmazonTld = (typeof AMAZON_TLDS)[number];

const SHORTLINK_HOSTS = new Set(['amzn.to', 'www.amzn.to', 'a.co', 'www.a.co']);

const PATH_PATTERNS = [
  /(?:^|\/)dp\/([a-z0-9]{10})(?:[/?#]|$)/i,
  /(?:^|\/)gp\/product\/([a-z0-9]{10})(?:[/?#]|$)/i,
  /(?:^|\/)gp\/aw\/d\/([a-z0-9]{10})(?:[/?#]|$)/i,
  /(?:^|\/)exec\/obidos\/asin\/([a-z0-9]{10})(?:[/?#]|$)/i,
];

const STOPWORDS = new Set([
  // German
  'der', 'die', 'das', 'des', 'dem', 'den', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
  'und', 'oder', 'aber', 'fuer', 'für', 'mit', 'von', 'vom', 'aus', 'bei', 'nach', 'zu', 'zum', 'zur',
  'im', 'in', 'am', 'an', 'auf', 'ist', 'sind', 'war', 'als', 'nicht', 'um', 'wie', 'so', 'da', 'es', 'sich',
  // English
  'a', 'an', 'the', 'and', 'or', 'but', 'for', 'with', 'from', 'of', 'on', 'in', 'at', 'to', 'by',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'as', 'into', 'that', 'this', 'these', 'those',
  'it', 'its', 'not', 'no', 'all', 'any', 'your', 'my',
  // French / Spanish / Italian common fillers
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'pour', 'avec', 'dans', 'sur',
  'el', 'los', 'las', 'unos', 'unas', 'para', 'con', 'en',
  'il', 'lo', 'gli', 'ed', 'per'
]);

/**
 * Checks whether a given string is a valid ISBN-10 (including Modulo-11 check digit with X).
 */
export function isIsbn10Asin(asin: string): boolean {
  if (typeof asin !== 'string') {
    return false;
  }
  const cleaned = asin.trim().replace(/[-\s]/g, '').toUpperCase();
  if (cleaned.length !== 10 || !/^\d{9}[\dX]$/.test(cleaned)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += parseInt(cleaned[i], 10) * (10 - i);
  }
  const lastChar = cleaned[9];
  const checkDigit = lastChar === 'X' ? 10 : parseInt(lastChar, 10);
  sum += checkDigit;

  return sum % 11 === 0;
}

/**
 * Validates an Amazon ASIN: exactly 10 alphanumeric characters [A-Z0-9].
 * Must either have a 'B0' prefix or be a valid ISBN-10 with check digit (including 'X').
 */
export function isValidAsin(asin: string): boolean {
  if (typeof asin !== 'string') {
    return false;
  }
  const cleaned = asin.trim().toUpperCase();
  if (cleaned.length !== 10) {
    return false;
  }

  // B0 prefix format: B0 followed by 8 alphanumeric characters
  if (/^B0[A-Z0-9]{8}$/.test(cleaned)) {
    return true;
  }

  // Valid ISBN-10
  return isIsbn10Asin(cleaned);
}

/**
 * Converts a 10-digit ISBN-10 into a canonical 13-digit EAN-13 barcode
 * by prepending prefix 978 and calculating the GS1 Modulo-10 check digit.
 */
export function isbn10ToEan13(isbn10: string): string {
  if (typeof isbn10 !== 'string') {
    throw new Error('ISBN-10 must be a string');
  }
  const cleaned = isbn10.trim().replace(/[-\s]/g, '').toUpperCase();
  if (cleaned.length !== 10 || !/^\d{9}[\dX]$/.test(cleaned)) {
    throw new Error('Invalid ISBN-10 format');
  }

  const payload = `978${cleaned.slice(0, 9)}`;
  const checkDigit = calculateCheckDigit(payload);
  return `${payload}${checkDigit}`;
}

/**
 * Extracts an ASIN and marketplace from an Amazon product URL or checks for shortlinks.
 * Supports /dp/, /gp/product/, /gp/aw/d/, /exec/obidos/ASIN/ and ?asin= on all Amazon TLDs.
 * Returns { asin, marketplace, needsRedirect } or null if invalid or foreign domain.
 */
export function extractAsinFromUrl(url: string): ExtractedAsin | null {
  if (typeof url !== 'string' || !url.trim()) {
    return null;
  }

  let parsed: URL;
  try {
    const trimmed = url.trim();
    const normalizedUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(normalizedUrl);
  } catch {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  // Shortlinks: amzn.to and a.co require redirect resolution
  if (SHORTLINK_HOSTS.has(hostname)) {
    return {
      asin: null,
      marketplace: null,
      needsRedirect: true,
    };
  }

  // Match Amazon marketplace TLD and guard against host spoofing
  let marketplace: string | null = null;
  for (const tld of AMAZON_TLDS) {
    const base = `amazon.${tld}`;
    if (hostname === base || hostname.endsWith(`.${base}`)) {
      marketplace = tld;
      break;
    }
  }

  if (!marketplace) {
    return null;
  }

  // 1. Try path patterns
  let candidate: string | null = null;
  for (const pat of PATH_PATTERNS) {
    const match = parsed.pathname.match(pat);
    if (match) {
      const asinMatch = match[1].toUpperCase();
      if (isValidAsin(asinMatch)) {
        candidate = asinMatch;
        break;
      }
    }
  }

  // 2. Try ?asin= query parameter if not found in path
  if (!candidate) {
    const queryAsin = parsed.searchParams.get('asin');
    if (queryAsin) {
      const asinQuery = queryAsin.trim().toUpperCase();
      if (isValidAsin(asinQuery)) {
        candidate = asinQuery;
      }
    }
  }

  if (!candidate) {
    return null;
  }

  return {
    asin: candidate,
    marketplace,
    needsRedirect: false,
  };
}

/**
 * Extracts up to 6 normalized search keywords from the URL slug path before /dp/.
 * Replaces hyphens with spaces, URL-decodes, strips stopwords and pure numeric tokens.
 */
export function extractSlugKeywords(url: string): string[] {
  if (typeof url !== 'string' || !url.trim()) {
    return [];
  }

  let parsed: URL;
  try {
    const trimmed = url.trim();
    const normalizedUrl = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
    parsed = new URL(normalizedUrl);
  } catch {
    return [];
  }

  const pathname = parsed.pathname;
  const dpIndex = pathname.toLowerCase().indexOf('/dp/');
  if (dpIndex <= 0) {
    return [];
  }

  const beforeDp = pathname.slice(0, dpIndex).replace(/^\/+/, '');
  if (!beforeDp) {
    return [];
  }

  let decoded = beforeDp;
  try {
    decoded = decodeURIComponent(beforeDp);
  } catch {
    // Keep raw path segment if decodeURIComponent throws
  }

  // Convert hyphens and slashes to spaces
  const withSpaces = decoded.replace(/[-_/]/g, ' ');
  const tokens = withSpaces.split(/\s+/).filter(Boolean);
  const keywords: string[] = [];

  for (const token of tokens) {
    const cleaned = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').toLowerCase();
    if (!cleaned) {
      continue;
    }

    // Reine Zahlen entfernen
    if (/^\d+$/.test(cleaned)) {
      continue;
    }

    // Stoppwörter entfernen
    if (STOPWORDS.has(cleaned)) {
      continue;
    }

    if (!keywords.includes(cleaned)) {
      keywords.push(cleaned);
    }

    if (keywords.length >= 6) {
      break;
    }
  }

  return keywords;
}
