import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { ZodError } from 'zod';
import { parseSafetyGateFileSync } from '../src/parser.js';
import {
  AlertRecordSchema,
  AlertRecordObjectSchema,
  normalizeBarcodes,
  normalizeAlert,
  normalizeAlerts,
  type AlertRecord,
} from '../src/schema.js';

describe('schema - AlertRecordSchema & Normalization', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/safety_gate_2026_45.xml');

  const validRecord: AlertRecord = {
    alert_number: '1',
    case_number: 'SR/03208/26',
    publication_date: '10-11-2026',
    category: 'Clothing, textiles and fashion items',
    product: "Children's jacket",
    brand: 'Jojo Maman Bébé',
    model: 'C52-683-145-000161',
    ean_barcodes: ['5054298241091'],
    risk_type: 'Chemical, Environment',
    danger_description: 'Toxic compounds present in fabric.',
    measures: 'Withdrawal of the product from the market',
    notifying_country: 'Luxembourg',
    country_of_origin: "People's Republic of China",
    risk_level: 'Serious risk',
    source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118633',
  };

  it('validates a strictly typed normalized AlertRecord object', () => {
    const result = AlertRecordSchema.parse(validRecord);
    expect(result).toEqual(validRecord);
    expect(result.alert_number).toBe('1');
    expect(result.case_number).toBe('SR/03208/26');
    expect(Array.isArray(result.ean_barcodes)).toBe(true);
  });

  it('exposes underlying schema shape for tool/API schema integration', () => {
    expect(AlertRecordSchema.shape).toBeDefined();
    expect(AlertRecordSchema.shape.alert_number).toBeDefined();
    expect(AlertRecordSchema.shape.ean_barcodes).toBeDefined();
    expect(AlertRecordObjectSchema.shape.alert_number).toBeDefined();
  });

  it('normalizes raw parser notifications from the real Safety Gate fixture', () => {
    const report = parseSafetyGateFileSync(fixturePath);
    expect(report.notifications).toHaveLength(75);

    const normalizedList = normalizeAlerts(report.notifications);
    expect(normalizedList).toHaveLength(75);

    // Verify first notification mapping
    const first = normalizedList[0];
    expect(first.alert_number).toBe('1');
    expect(first.case_number).toBe('SR/03208/26');
    expect(first.publication_date).toBe('10-11-2026');
    expect(first.category).toBe('Clothing, textiles and fashion items');
    expect(first.product).toBe("Children's jacket");
    expect(first.brand).toBe('Jojo Maman Bébé');
    expect(first.model).toBe('C52-683-145-000161');
    expect(first.ean_barcodes).toEqual(['5054298241091']);
    expect(first.risk_type).toBe('Chemical, Environment');
    expect(first.danger_description).toContain('C9–C14');
    expect(first.measures).toContain('Withdrawal of the product');
    expect(first.notifying_country).toBe('Luxembourg');
    expect(first.country_of_origin).toBe("People's Republic of China");
    expect(first.risk_level).toBe('Serious risk');
    expect(first.source_url).toBe(
      'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118633'
    );

    // Verify notification without barcode in fixture
    const last = normalizedList[74];
    expect(last.alert_number).toBe('75');
    expect(last.case_number).toBe('SR/03200/26');
    expect(last.brand).toBe('Honda');
    expect(last.product).toBe('Motorcycle');
    expect(last.ean_barcodes).toEqual([]);
    expect(last.risk_type).toBe('Injuries');
  });

  it('cleans whitespace from ean_barcodes arrays and strings', () => {
    // Array with whitespace
    const result1 = AlertRecordSchema.parse({
      ...validRecord,
      ean_barcodes: ['  5054298241091  ', '   ', '\t4099979071513\n', ''],
    });
    expect(result1.ean_barcodes).toEqual(['5054298241091', '4099979071513']);

    // Single string with whitespace via barcode field
    const { ean_barcodes: _b1, ...recordWithoutBarcodes1 } = validRecord;
    const result2 = AlertRecordSchema.parse({
      ...recordWithoutBarcodes1,
      barcode: '   5054298241091   ',
    });
    expect(result2.ean_barcodes).toEqual(['5054298241091']);

    // Comma-separated barcode string with surrounding whitespace
    const { ean_barcodes: _b2, ...recordWithoutBarcodes2 } = validRecord;
    const result3 = AlertRecordSchema.parse({
      ...recordWithoutBarcodes2,
      barcode: ' 5054298241091 , 4099979071513 ; 3760407016796 ',
    });
    expect(result3.ean_barcodes).toEqual([
      '5054298241091',
      '4099979071513',
      '3760407016796',
    ]);
  });

  it('normalizeBarcodes helper works on various inputs', () => {
    expect(normalizeBarcodes(null)).toEqual([]);
    expect(normalizeBarcodes(undefined)).toEqual([]);
    expect(normalizeBarcodes('')).toEqual([]);
    expect(normalizeBarcodes('   ')).toEqual([]);
    expect(normalizeBarcodes(' 4099979071513 ')).toEqual(['4099979071513']);
    expect(
      normalizeBarcodes([' 5054298241091 ', '  4099979071513  ', '5054298241091'])
    ).toEqual(['5054298241091', '4099979071513']);
    expect(normalizeBarcodes(4099979071513)).toEqual(['4099979071513']);
  });

  it('normalizeAlert and normalizeAlerts helper functions', () => {
    const single = normalizeAlert({
      order: '42',
      caseNumber: 'SR/99999/26',
      product: 'Safety Toy',
      barcode: ' 1234567890123 ',
    });
    expect(single.alert_number).toBe('42');
    expect(single.case_number).toBe('SR/99999/26');
    expect(single.product).toBe('Safety Toy');
    expect(single.ean_barcodes).toEqual(['1234567890123']);
    expect(single.category).toBe('');

    const emptyList = normalizeAlerts(null as any);
    expect(emptyList).toEqual([]);
  });

  it('throws ZodError on invalid inputs or missing required fields', () => {
    expect(() => AlertRecordSchema.parse(null)).toThrow(ZodError);
    expect(() => AlertRecordSchema.parse(undefined)).toThrow(ZodError);
    expect(() => AlertRecordSchema.parse('not an object')).toThrow(ZodError);
    expect(() => AlertRecordSchema.parse(12345)).toThrow(ZodError);

    // Empty object missing required alert_number and case_number
    expect(() => AlertRecordSchema.parse({})).toThrow(ZodError);

    // Invalid barcode entry type
    expect(() =>
      AlertRecordSchema.parse({
        ...validRecord,
        ean_barcodes: [{ invalid: 'object' }],
      })
    ).toThrow(ZodError);
  });
});
