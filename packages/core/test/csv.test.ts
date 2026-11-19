import { describe, it, expect } from 'vitest';
import {
  parseCsv,
  mapCsvRows,
  detectDelimiter,
  isScientificNotation,
  CsvLimitError,
  MAX_CSV_BYTES,
  MAX_CSV_DATA_ROWS,
} from '../src/csv.js';

describe('csv - RFC-4180 CSV-Parser und Spalten-Zuordnung (F04)', () => {
  it('Kriterium 1: Excel-typisches DE-Format (Semikolon, BOM, CRLF) wird korrekt gelesen', () => {
    const csvContent =
      '\uFEFFBarcode;ASIN;Titel\r\n' +
      '4006381333931;B00004CK5B;Stabilo Boss\r\n' +
      '4006381333932;B00004CK5C;Stabilo Point 88\r\n';

    const parsed = parseCsv(csvContent);
    expect(parsed).toEqual([
      ['Barcode', 'ASIN', 'Titel'],
      ['4006381333931', 'B00004CK5B', 'Stabilo Boss'],
      ['4006381333932', 'B00004CK5C', 'Stabilo Point 88'],
    ]);

    const result = mapCsvRows(parsed);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(2);

    expect(result.rows[0]).toEqual({
      row: 2,
      identifier: '4006381333931',
      ean: '4006381333931',
      asin: 'B00004CK5B',
      name: 'Stabilo Boss',
    });

    expect(result.rows[1]).toEqual({
      row: 3,
      identifier: '4006381333932',
      ean: '4006381333932',
      asin: 'B00004CK5C',
      name: 'Stabilo Point 88',
    });
  });

  it('Kriterium 2: Felder in Anführungszeichen mit Komma und Zeilenumbruch werden korrekt geparst', () => {
    const csvContent =
      'ean,name,sku\n' +
      '4006381333931,"Produkt mit, Komma und\nZeilenumbruch im Namen","SKU""123"""\n';

    const parsed = parseCsv(csvContent);
    expect(parsed).toHaveLength(2);
    expect(parsed[1][0]).toBe('4006381333931');
    expect(parsed[1][1]).toBe('Produkt mit, Komma und\nZeilenumbruch im Namen');
    expect(parsed[1][2]).toBe('SKU"123"');

    const result = mapCsvRows(parsed);
    expect(result.errors).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].name).toBe('Produkt mit, Komma und\nZeilenumbruch im Namen');
    expect(result.rows[0].sku).toBe('SKU"123"');
  });

  it('Kriterium 3: EANs, die Excel in wissenschaftliche Notation umgewandelt hat (z. B. 4.00638E+12), erscheinen als Fehler mit klarer Begründung', () => {
    expect(isScientificNotation('4.00638E+12')).toBe(true);
    expect(isScientificNotation('4,00638E+12')).toBe(true);
    expect(isScientificNotation('4.00638e+12')).toBe(true);
    expect(isScientificNotation('4006381333931')).toBe(false);

    const csvContent =
      'ean;name\r\n' +
      '4.00638E+12;Fehlerhafte Zeile 1\r\n' +
      '4,00638E+12;Fehlerhafte Zeile 2\r\n' +
      '4006381333931;Gültige Zeile 3\r\n';

    const parsed = parseCsv(csvContent);
    const result = mapCsvRows(parsed);

    expect(result.errors).toHaveLength(2);
    expect(result.errors[0].row).toBe(2);
    expect(result.errors[0].reason).toMatch(/wissenschaftlich.*excel.*notation/i);
    expect(result.errors[1].row).toBe(3);
    expect(result.errors[1].reason).toMatch(/wissenschaftlich.*excel.*notation/i);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].row).toBe(4);
    expect(result.rows[0].ean).toBe('4006381333931');
  });

  it('Kriterium 4: asinEanMap wird aus Zeilen mit ASIN und EAN befüllt', () => {
    const csvContent =
      'sku,asin,ean,title\n' +
      'SKU-1,B00004CK5B,4006381333931,Stabilo Boss\n' +
      'SKU-2,B00004CK5C,4006381333932,Stabilo Point 88\n' +
      'SKU-3,B012345678,,Nur ASIN Produkt\n' +
      'SKU-4,,4006381333933,Nur EAN Produkt\n';

    const result = mapCsvRows(parseCsv(csvContent));
    expect(result.rows).toHaveLength(4);
    expect(result.asinEanMap.size).toBe(2);

    expect(result.asinEanMap.get('B00004CK5B')).toBe('4006381333931');
    expect(result.asinEanMap.get('b00004ck5b')).toBe('4006381333931'); // case-insensitive
    expect(result.asinEanMap.lookup('B00004CK5C')).toBe('4006381333932');
    expect(result.asinEanMap.has('B00004CK5B')).toBe(true);
    expect(result.asinEanMap.get('B012345678')).toBeUndefined();
  });

  it('Kriterium 5: 10.001 Datenzeilen führen zu CsvLimitError, 10.000 Datenzeilen werden in unter 1 s verarbeitet', () => {
    // 10.000 Datenzeilen (+1 Kopfzeile)
    const header = 'ean,sku,name\n';
    const rowTemplate = '4006381333931,SKU-1,Test-Produkt\n';
    const validCsv = header + rowTemplate.repeat(10_000);

    const start = performance.now();
    const parsed = parseCsv(validCsv);
    const result = mapCsvRows(parsed);
    const duration = performance.now() - start;

    expect(parsed).toHaveLength(10_001); // 1 Header + 10.000 Daten
    expect(result.rows).toHaveLength(10_000);
    expect(duration).toBeLessThan(1000); // Unter 1 Sekunde

    // 10.001 Datenzeilen (+ 1 Header) -> CsvLimitError
    const invalidCsvWithHeader = header + rowTemplate.repeat(10_001);
    expect(() => parseCsv(invalidCsvWithHeader)).toThrow(CsvLimitError);

    // 10.001 Datenzeilen ohne Header -> CsvLimitError
    const invalidCsvNoHeader = rowTemplate.repeat(10_001);
    expect(() => parseCsv(invalidCsvNoHeader)).toThrow(CsvLimitError);
  });

  it('wirft CsvLimitError wenn Textgröße 5 MB überschreitet', () => {
    const hugeCsv = 'a,b,c\n' + 'x'.repeat(MAX_CSV_BYTES + 10);
    expect(() => parseCsv(hugeCsv)).toThrow(CsvLimitError);
  });

  it('erkennt Tab (TSV) automatisch', () => {
    const tsv = 'ean\tasin\ttitle\n4006381333931\tB00004CK5B\tStift\n';
    expect(detectDelimiter(tsv)).toBe('\t');
    const parsed = parseCsv(tsv);
    expect(parsed).toEqual([
      ['ean', 'asin', 'title'],
      ['4006381333931', 'B00004CK5B', 'Stift'],
    ]);
  });

  it('behandelt CSV ohne Kopfzeile als Kennung in der ersten Spalte', () => {
    const csvNoHeader = '4006381333931\n4006381333932\n';
    const parsed = parseCsv(csvNoHeader);
    const result = mapCsvRows(parsed);

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({
      row: 1,
      identifier: '4006381333931',
    });
    expect(result.rows[1]).toEqual({
      row: 2,
      identifier: '4006381333932',
    });
  });

  it('ignoriert leere Zeilen und Leerzeilen am Dateiende', () => {
    const csv = '\n\nean,asin\n\n4006381333931,B00004CK5B\n\n\n';
    const parsed = parseCsv(csv);
    expect(parsed).toHaveLength(2);
    const result = mapCsvRows(parsed);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].identifier).toBe('4006381333931');
  });

  it('erkennt alternative Spaltenbezeichnungen (Groß-/Kleinschreibung, Aliase)', () => {
    const csv =
      'GTIN_CODE;AMAZON_URL;ARTIKELNUMMER;PRODUKTNAME\r\n' +
      '4006381333931;https://amazon.de/dp/B00004CK5B;ART-99;Kinderspielzeug\r\n';

    const result = mapCsvRows(parseCsv(csv));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toEqual({
      row: 2,
      identifier: '4006381333931',
      ean: '4006381333931',
      url: 'https://amazon.de/dp/B00004CK5B',
      sku: 'ART-99',
      name: 'Kinderspielzeug',
    });
  });
});
