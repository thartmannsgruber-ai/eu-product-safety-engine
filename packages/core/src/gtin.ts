/**
 * GTIN / EAN Barcode Validation and Utility Functions
 * Supports EAN-8, EAN-13, UPC-A, UPC-E, and GTIN-14
 * using GS1 Modulo-10 check digit algorithms.
 */

export type BarcodeType = 'EAN-8' | 'EAN-13' | 'UPC-A' | 'UPC-E' | 'GTIN-14';

/**
 * Normalizes barcode input by trimming whitespace and removing hyphens/spaces.
 */
export function cleanBarcode(code: string | null | undefined): string {
  if (!code) return '';
  return code.trim().replace(/[-\s]/g, '');
}

/**
 * Calculates GS1 Modulo-10 check digit for a string of payload digits
 * (excluding the check digit itself).
 *
 * Traverses right-to-left: the last payload digit has weight 3, then 1, 3, 1, etc.
 */
export function calculateCheckDigit(payload: string): number {
  if (!payload || !/^\d+$/.test(payload)) {
    throw new Error('Payload must be a non-empty string of digits');
  }

  let sum = 0;
  const len = payload.length;
  for (let i = 0; i < len; i++) {
    const digit = parseInt(payload[len - 1 - i], 10);
    const weight = i % 2 === 0 ? 3 : 1;
    sum += digit * weight;
  }

  return (10 - (sum % 10)) % 10;
}

/**
 * Verifies standard GS1 Modulo-10 check digit for a full barcode string
 * (including the check digit as the last character).
 */
export function verifyModulo10(barcode: string): boolean {
  if (!barcode || !/^\d{2,}$/.test(barcode)) {
    return false;
  }

  let sum = 0;
  const len = barcode.length;
  for (let i = 0; i < len; i++) {
    const digit = parseInt(barcode[len - 1 - i], 10);
    const weight = i % 2 === 0 ? 1 : 3;
    sum += digit * weight;
  }

  return sum % 10 === 0;
}

/**
 * Validates strictly EAN-8 (8 digits).
 */
export function isValidEan8(code: string): boolean {
  const cleaned = cleanBarcode(code);
  return cleaned.length === 8 && /^\d{8}$/.test(cleaned) && verifyModulo10(cleaned);
}

/**
 * Validates strictly UPC-A / GTIN-12 (12 digits).
 */
export function isValidUpcA(code: string): boolean {
  const cleaned = cleanBarcode(code);
  return cleaned.length === 12 && /^\d{12}$/.test(cleaned) && verifyModulo10(cleaned);
}

/**
 * Validates strictly EAN-13 / GTIN-13 (13 digits).
 */
export function isValidEan13(code: string): boolean {
  const cleaned = cleanBarcode(code);
  return cleaned.length === 13 && /^\d{13}$/.test(cleaned) && verifyModulo10(cleaned);
}

/**
 * Validates strictly GTIN-14 / ITF-14 (14 digits).
 */
export function isValidGtin14(code: string): boolean {
  const cleaned = cleanBarcode(code);
  return cleaned.length === 14 && /^\d{14}$/.test(cleaned) && verifyModulo10(cleaned);
}

/**
 * Expands a UPC-E barcode (6, 7, or 8 digits) to its 12-digit UPC-A equivalent.
 * Returns the 12-digit UPC-A string, or null if expansion fails or check digit mismatch.
 */
export function expandUpcE(code: string): string | null {
  const cleaned = cleanBarcode(code);
  if (!/^\d{6,8}$/.test(cleaned)) {
    return null;
  }

  let numberSystem = '0';
  let middle = '';
  let checkDigit: string | null = null;

  if (cleaned.length === 6) {
    middle = cleaned;
  } else if (cleaned.length === 7) {
    if (cleaned[0] === '0' || cleaned[0] === '1') {
      numberSystem = cleaned[0];
      middle = cleaned.slice(1);
    } else {
      middle = cleaned.slice(0, 6);
      checkDigit = cleaned[6];
    }
  } else if (cleaned.length === 8) {
    if (cleaned[0] !== '0' && cleaned[0] !== '1') {
      return null;
    }
    numberSystem = cleaned[0];
    middle = cleaned.slice(1, 7);
    checkDigit = cleaned[7];
  }

  const d1 = middle[0];
  const d2 = middle[1];
  const d3 = middle[2];
  const d4 = middle[3];
  const d5 = middle[4];
  const d6 = middle[5];

  let mfg = '';
  let prod = '';

  if (d6 === '0' || d6 === '1' || d6 === '2') {
    mfg = `${d1}${d2}${d6}00`;
    prod = `00${d3}${d4}${d5}`;
  } else if (d6 === '3') {
    mfg = `${d1}${d2}${d3}00`;
    prod = `000${d4}${d5}`;
  } else if (d6 === '4') {
    mfg = `${d1}${d2}${d3}${d4}0`;
    prod = `0000${d5}`;
  } else {
    // '5', '6', '7', '8', '9'
    mfg = `${d1}${d2}${d3}${d4}${d5}`;
    prod = `0000${d6}`;
  }

  const payload = `${numberSystem}${mfg}${prod}`;
  const computedCheckDigit = calculateCheckDigit(payload);

  if (checkDigit !== null && parseInt(checkDigit, 10) !== computedCheckDigit) {
    return null;
  }

  return `${payload}${computedCheckDigit}`;
}

/**
 * Validates a UPC-E barcode (6, 7, or 8 digits).
 */
export function isValidUpcE(code: string): boolean {
  return expandUpcE(code) !== null;
}

/**
 * Validates whether a barcode string is a valid EAN/GTIN code (EAN-8, EAN-13, UPC-A, UPC-E, GTIN-14).
 * Strips formatting whitespace/hyphens and checks the GS1 Modulo-10 check digit.
 */
export function isValidEan(code: string): boolean {
  if (typeof code !== 'string') {
    return false;
  }

  const cleaned = cleanBarcode(code);
  if (!cleaned || !/^\d+$/.test(cleaned)) {
    return false;
  }

  switch (cleaned.length) {
    case 13:
      return isValidEan13(cleaned);
    case 12:
      return isValidUpcA(cleaned);
    case 8:
      return isValidEan8(cleaned) || isValidUpcE(cleaned);
    case 14:
      return isValidGtin14(cleaned);
    case 6:
    case 7:
      return isValidUpcE(cleaned);
    default:
      return false;
  }
}

/**
 * Alias for isValidEan (GTIN standard check).
 */
export const isValidGtin = isValidEan;

/**
 * Identifies the specific barcode type for a valid barcode.
 * Returns null if the barcode is invalid.
 */
export function getBarcodeType(code: string): BarcodeType | null {
  if (typeof code !== 'string') return null;
  const cleaned = cleanBarcode(code);
  if (!/^\d+$/.test(cleaned)) return null;

  if (cleaned.length === 13 && isValidEan13(cleaned)) {
    return 'EAN-13';
  }
  if (cleaned.length === 12 && isValidUpcA(cleaned)) {
    return 'UPC-A';
  }
  if (cleaned.length === 8) {
    if (isValidEan8(cleaned)) return 'EAN-8';
    if (isValidUpcE(cleaned)) return 'UPC-E';
  }
  if (cleaned.length === 14 && isValidGtin14(cleaned)) {
    return 'GTIN-14';
  }
  if ((cleaned.length === 6 || cleaned.length === 7) && isValidUpcE(cleaned)) {
    return 'UPC-E';
  }

  return null;
}

/**
 * Normalizes any valid GTIN (EAN-8, UPC-A, EAN-13, GTIN-14, or UPC-E)
 * into a canonical 14-digit GTIN string by left-padding with zeros.
 * Returns null if the code is invalid.
 */
export function normalizeToGtin14(code: string): string | null {
  if (!isValidEan(code)) return null;
  const cleaned = cleanBarcode(code);

  if (cleaned.length === 14) {
    return cleaned;
  }
  if (cleaned.length === 13) {
    return `0${cleaned}`;
  }
  if (cleaned.length === 12) {
    return `00${cleaned}`;
  }
  if (cleaned.length === 8) {
    if (isValidEan8(cleaned)) {
      return `000000${cleaned}`;
    }
    const upcA = expandUpcE(cleaned);
    if (upcA) return `00${upcA}`;
  }
  if (cleaned.length === 6 || cleaned.length === 7) {
    const upcA = expandUpcE(cleaned);
    if (upcA) return `00${upcA}`;
  }

  return null;
}
