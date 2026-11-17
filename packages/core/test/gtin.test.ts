import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import {
  cleanBarcode,
  calculateCheckDigit,
  verifyModulo10,
  isValidEan,
  isValidGtin,
  isValidEan8,
  isValidEan13,
  isValidUpcA,
  isValidUpcE,
  isValidGtin14,
  expandUpcE,
  getBarcodeType,
  normalizeToGtin14,
} from '../src/gtin.js';
import { parseSafetyGateFileSync } from '../src/parser.js';

describe('gtin - Barcode and Check Digit Validation', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/safety_gate_2026_45.xml');

  describe('cleanBarcode', () => {
    it('removes spaces and hyphens', () => {
      expect(cleanBarcode(' 5054-298-241091 ')).toBe('5054298241091');
      expect(cleanBarcode(' 4099 979 071513 ')).toBe('4099979071513');
    });

    it('handles empty or nullish inputs gracefully', () => {
      expect(cleanBarcode('')).toBe('');
      expect(cleanBarcode(null)).toBe('');
      expect(cleanBarcode(undefined)).toBe('');
    });
  });

  describe('calculateCheckDigit', () => {
    it('calculates exact Modulo-10 check digit for various payload lengths', () => {
      // EAN-13 payloads (12 digits)
      expect(calculateCheckDigit('505429824109')).toBe(1);
      expect(calculateCheckDigit('409997907151')).toBe(3);
      expect(calculateCheckDigit('400638133393')).toBe(1);

      // EAN-8 payload (7 digits)
      expect(calculateCheckDigit('9638507')).toBe(4);

      // UPC-A payload (11 digits)
      expect(calculateCheckDigit('03600029145')).toBe(2);

      // GTIN-14 payload (13 digits)
      expect(calculateCheckDigit('1505429824109')).toBe(8);
    });

    it('throws error for non-digit or empty payloads', () => {
      expect(() => calculateCheckDigit('')).toThrow();
      expect(() => calculateCheckDigit('ABC123')).toThrow();
    });
  });

  describe('verifyModulo10', () => {
    it('returns true for barcodes with valid check digits', () => {
      expect(verifyModulo10('5054298241091')).toBe(true);
      expect(verifyModulo10('4099979071513')).toBe(true);
      expect(verifyModulo10('96385074')).toBe(true);
      expect(verifyModulo10('036000291452')).toBe(true);
    });

    it('returns false for barcodes with incorrect check digits', () => {
      expect(verifyModulo10('5054298241090')).toBe(false);
      expect(verifyModulo10('4099979071512')).toBe(false);
      expect(verifyModulo10('96385075')).toBe(false);
      expect(verifyModulo10('036000291459')).toBe(false);
    });
  });

  describe('isValidEan & isValidGtin', () => {
    it('recognizes valid EANs from the fixture', () => {
      expect(isValidEan('5054298241091')).toBe(true);
      expect(isValidEan('4099979071513')).toBe(true);
      expect(isValidGtin('5054298241091')).toBe(true);
      expect(isValidGtin('4099979071513')).toBe(true);
    });

    it('tolerates formatting spaces and hyphens in valid barcodes', () => {
      expect(isValidEan(' 5054-298-241091 ')).toBe(true);
      expect(isValidEan('4099 979 071513')).toBe(true);
    });

    it('rejects barcodes with wrong check digits', () => {
      expect(isValidEan('5054298241090')).toBe(false);
      expect(isValidEan('5054298241092')).toBe(false);
      expect(isValidEan('4099979071510')).toBe(false);
      expect(isValidEan('4099979071512')).toBe(false);
    });

    it('rejects invalid barcodes and non-digit strings from fixture or input', () => {
      expect(isValidEan('Unknown')).toBe(false);
      expect(isValidEan('4026889346704027')).toBe(false); // 16 digits
      expect(isValidEan('505530041305550553004130625055300413406')).toBe(false); // concatenated
      expect(isValidEan('12345')).toBe(false);
      expect(isValidEan('')).toBe(false);
      expect(isValidEan('ABCDEFGHIJKLM')).toBe(false);
      expect(isValidEan(null as unknown as string)).toBe(false);
      expect(isValidEan(undefined as unknown as string)).toBe(false);
    });

    it('validates alerts directly from the XML fixture', () => {
      const report = parseSafetyGateFileSync(fixturePath);
      const fixtureBarcodes = report.notifications
        .map((n) => n.barcode)
        .filter((b): b is string => Boolean(b && b.trim()));

      expect(fixtureBarcodes).toContain('5054298241091');
      expect(fixtureBarcodes).toContain('4099979071513');

      expect(isValidEan('5054298241091')).toBe(true);
      expect(isValidEan('4099979071513')).toBe(true);

      // Verify known invalid barcode in fixture is rejected
      expect(isValidEan('4026889346704027')).toBe(false);
      expect(isValidEan('Unknown')).toBe(false);
    });
  });

  describe('Specific barcode format validators', () => {
    it('validates EAN-8 correctly', () => {
      expect(isValidEan8('96385074')).toBe(true);
      expect(isValidEan8('96385075')).toBe(false);
      expect(isValidEan8('5054298241091')).toBe(false); // length 13
    });

    it('validates EAN-13 correctly', () => {
      expect(isValidEan13('5054298241091')).toBe(true);
      expect(isValidEan13('4099979071513')).toBe(true);
      expect(isValidEan13('5054298241090')).toBe(false);
      expect(isValidEan13('96385074')).toBe(false); // length 8
    });

    it('validates UPC-A correctly', () => {
      expect(isValidUpcA('036000291452')).toBe(true);
      expect(isValidUpcA('036000291451')).toBe(false);
      expect(isValidUpcA('5054298241091')).toBe(false);
    });

    it('validates GTIN-14 correctly', () => {
      expect(isValidGtin14('15054298241098')).toBe(true);
      expect(isValidGtin14('15054298241090')).toBe(false);
    });
  });

  describe('UPC-E handling and expansion', () => {
    it('expands UPC-E to 12-digit UPC-A with verified check digit', () => {
      expect(expandUpcE('01234558')).toBe('012345000058');
      expect(expandUpcE('04252614')).toBe('042100005264');
      expect(expandUpcE('06543217')).toBe('065100004327');
    });

    it('rejects invalid UPC-E check digits during expansion', () => {
      expect(expandUpcE('01234559')).toBeNull();
      expect(isValidUpcE('01234559')).toBe(false);
    });

    it('validates UPC-E codes via isValidUpcE', () => {
      expect(isValidUpcE('01234558')).toBe(true);
      expect(isValidUpcE('04252614')).toBe(true);
    });
  });

  describe('getBarcodeType & normalizeToGtin14', () => {
    it('correctly detects barcode types', () => {
      expect(getBarcodeType('5054298241091')).toBe('EAN-13');
      expect(getBarcodeType('036000291452')).toBe('UPC-A');
      expect(getBarcodeType('96385074')).toBe('EAN-8');
      expect(getBarcodeType('15054298241098')).toBe('GTIN-14');
      expect(getBarcodeType('invalid')).toBeNull();
      expect(getBarcodeType('5054298241090')).toBeNull();
    });

    it('normalizes valid barcodes to canonical 14-digit GTIN', () => {
      expect(normalizeToGtin14('5054298241091')).toBe('05054298241091');
      expect(normalizeToGtin14('036000291452')).toBe('00036000291452');
      expect(normalizeToGtin14('96385074')).toBe('00000096385074');
      expect(normalizeToGtin14('15054298241098')).toBe('15054298241098');
      expect(normalizeToGtin14('invalid')).toBeNull();
    });
  });
});
