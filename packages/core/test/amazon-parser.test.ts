import { describe, it, expect } from 'vitest';
import {
  parseAmazonInventoryReport,
  convertScientificToString,
  stripBom,
  detectReportDelimiter,
  normalizeHeaderKey,
  normalizeProductIdType,
  productIdTypeToNumeric,
  isScientificNotationTruncated,
  isSuspectZeroPaddedEan,
} from '../src/amazon-parser.js';

describe('Amazon Seller Central Inventory Report Parser (F03)', () => {
  describe('Akzeptanzkriterium 1: Parst TSV, CSV (Komma/Semikolon) mit und ohne BOM', () => {
    it('parst tab-getrennten Amazon-Bericht (TSV) ohne BOM', () => {
      const tsv = [
        'seller-sku\tasin1\titem-name\tprice\tquantity',
        'SKU-100\tB00004CK5B\tStabilo Boss Textmarker\t4.99\t150',
        'SKU-101\tB00004CK5C\tStabilo Fineliner Point 88\t8.50\t75',
      ].join('\n');

      const result = parseAmazonInventoryReport(tsv);

      expect(result.stats.delimiter).toBe('\t');
      expect(result.stats.hasBom).toBe(false);
      expect(result.stats.validItems).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(result.items).toHaveLength(2);

      expect(result.items[0]).toMatchObject({
        sellerSku: 'SKU-100',
        asin1: 'B00004CK5B',
        asin: 'B00004CK5B',
        itemName: 'Stabilo Boss Textmarker',
        price: 4.99,
        quantity: 150,
      });
    });

    it('parst tab-getrennten Bericht mit UTF-8 BOM (\uFEFF) und CRLF', () => {
      const tsv =
        '\uFEFFseller-sku\tasin1\titem-name\tprice\tquantity\r\n' +
        'SKU-200\tB08N5WRWNW\tSony WH-1000XM4\t249.00\t20\r\n';

      const result = parseAmazonInventoryReport(tsv);

      expect(result.stats.hasBom).toBe(true);
      expect(result.stats.delimiter).toBe('\t');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].sellerSku).toBe('SKU-200');
      expect(result.items[0].asin1).toBe('B08N5WRWNW');
      expect(result.items[0].price).toBe(249);
    });

    it('parst semikolongetrennten Bericht (DE-Excel) mit BOM', () => {
      const csv =
        '\uFEFFseller-sku;asin1;item-name;price;quantity\n' +
        'DE-SKU-1;B07JW9H4J1;Baby-Rassel Holz;12,99;50\n' +
        'DE-SKU-2;B09V3HM443;Kinder-Trinkflasche;19,95;30\n';

      const result = parseAmazonInventoryReport(csv);

      expect(result.stats.delimiter).toBe(';');
      expect(result.stats.hasBom).toBe(true);
      expect(result.items).toHaveLength(2);
      expect(result.items[0].price).toBe(12.99);
      expect(result.items[0].quantity).toBe(50);
      expect(result.items[1].price).toBe(19.95);
      expect(result.items[1].quantity).toBe(30);
    });

    it('parst kommagetrennten Bericht (CSV) mit Anführungszeichen und Zeilenumbrüchen', () => {
      const csv =
        'seller-sku,asin1,item-name,price,quantity\n' +
        'SKU-COMMA,B00004CK5B,"Textmarker, neon-gelb mit\nZusatzkappe",4.99,10\n';

      const result = parseAmazonInventoryReport(csv);

      expect(result.stats.delimiter).toBe(',');
      expect(result.items).toHaveLength(1);
      expect(result.items[0].sellerSku).toBe('SKU-COMMA');
      expect(result.items[0].itemName).toBe('Textmarker, neon-gelb mit\nZusatzkappe');
      expect(result.items[0].price).toBe(4.99);
    });

    it('gibt leere Ergebnisstruktur bei leerem Text zurück', () => {
      const result = parseAmazonInventoryReport('');
      expect(result.items).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.stats.totalRows).toBe(0);
    });
  });

  describe('Akzeptanzkriterium 2: Spalten-Mapping von seller-sku, asin1, item-name, product-id, product-id-type, price, quantity', () => {
    it('mapped Standard Amazon Seller Central Header zuverlässig', () => {
      const report = [
        'seller-sku\tasin1\titem-name\tproduct-id\tproduct-id-type\tprice\tquantity',
        'SKU-FULL-1\tB00004CK5B\tStabilo Boss\t4006381333931\t4\t3.99\t100',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.sellerSku).toBe('SKU-FULL-1');
      expect(item.asin1).toBe('B00004CK5B');
      expect(item.asin).toBe('B00004CK5B');
      expect(item.itemName).toBe('Stabilo Boss');
      expect(item.productId).toBe('4006381333931');
      expect(item.productIdType).toBe('EAN');
      expect(item.productIdTypeNumeric).toBe(4);
      expect(item.ean).toBe('4006381333931');
      expect(item.price).toBe(3.99);
      expect(item.quantity).toBe(100);
    });

    it('mapped alternative Header-Namen und deutsche Spaltenbezeichnungen', () => {
      const report = [
        'Verkäufer-SKU;ASIN;Artikelname;Produkt-ID;Produkt-ID-Typ;Preis;Menge',
        'DE-100;B08N5WRWNW;Kopfhörer;4006381333931;EAN;199,00;5',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.sellerSku).toBe('DE-100');
      expect(item.asin1).toBe('B08N5WRWNW');
      expect(item.itemName).toBe('Kopfhörer');
      expect(item.productId).toBe('4006381333931');
      expect(item.productIdType).toBe('EAN');
      expect(item.price).toBe(199.0);
      expect(item.quantity).toBe(5);
    });

    it('unterstützt numerische und string-basierte product-id-type Werte (1=ASIN, 2=ISBN, 3=UPC, 4=EAN)', () => {
      expect(normalizeProductIdType(1)).toBe('ASIN');
      expect(normalizeProductIdType('1')).toBe('ASIN');
      expect(normalizeProductIdType('ASIN')).toBe('ASIN');

      expect(normalizeProductIdType(2)).toBe('ISBN');
      expect(normalizeProductIdType('2')).toBe('ISBN');
      expect(normalizeProductIdType('ISBN')).toBe('ISBN');

      expect(normalizeProductIdType(3)).toBe('UPC');
      expect(normalizeProductIdType('3')).toBe('UPC');
      expect(normalizeProductIdType('UPC')).toBe('UPC');

      expect(normalizeProductIdType(4)).toBe('EAN');
      expect(normalizeProductIdType('4')).toBe('EAN');
      expect(normalizeProductIdType('EAN')).toBe('EAN');
      expect(normalizeProductIdType('GTIN')).toBe('EAN');

      expect(productIdTypeToNumeric('ASIN')).toBe(1);
      expect(productIdTypeToNumeric('ISBN')).toBe(2);
      expect(productIdTypeToNumeric('UPC')).toBe(3);
      expect(productIdTypeToNumeric('EAN')).toBe(4);
    });
  });

  describe('Akzeptanzkriterium 3: Bereinigung wissenschaftlicher Notation & Fließkomma-Formate', () => {
    it('konvertiert 4.00638E+12 sauber in die vollständige 13-stellige EAN-Ziffernkette 4006380000000', () => {
      const converted = convertScientificToString('4.00638E+12');
      expect(converted).toBe('4006380000000');
      expect(converted.length).toBe(13);
    });

    it('konvertiert deutsche Komma-Notation 4,00638E+12 sauber', () => {
      const converted = convertScientificToString('4,00638E+12');
      expect(converted).toBe('4006380000000');
    });

    it('konvertiert exakte 13-stellige wissenschaftliche Notation wie 4.006381333931E+12', () => {
      const converted = convertScientificToString('4.006381333931E+12');
      expect(converted).toBe('4006381333931');
    });

    it('bereinigt Anführungszeichen um wissenschaftliche Notation wie "4.00638E+12"', () => {
      const converted = convertScientificToString('"4.00638E+12"');
      expect(converted).toBe('4006380000000');
    });

    it('bereinigt Excel-Float-Artefakte mit .0 wie 4006381333931.0', () => {
      const converted = convertScientificToString('4006381333931.0');
      expect(converted).toBe('4006381333931');
    });

    it('konvertiert 12-stelliges UPC-Format 1.23456789012E+11', () => {
      const converted = convertScientificToString('1.23456789012E+11');
      expect(converted).toBe('123456789012');
    });

    it('fängt verstümmelte wissenschaftliche Notation als EAN_CORRUPTED_EXCEL ab und erfindet keine Fake-EAN', () => {
      const report = [
        'seller-sku\tasin1\titem-name\tproduct-id\tproduct-id-type',
        'SKU-SCI\tB00004CK5B\tStabilo Boss\t4.00638E+12\t4',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].eanCorrupted).toBe(true);
      expect(result.items[0].identifierWarning).toBe('EAN_CORRUPTED_EXCEL');
      expect(result.items[0].ean).toBeUndefined(); // Verhindert Fake-Barcode-Matching
      expect(result.errors.some((e) => e.code === 'EAN_CORRUPTED_EXCEL')).toBe(true);
    });

    it('erkennt unbeschädigte wissenschaftliche Notation mit vollständiger Prüfziffer', () => {
      const report = [
        'seller-sku\tasin1\titem-name\tproduct-id\tproduct-id-type',
        'SKU-SCI-EXACT\tB00004CK5B\tStabilo Boss\t4.006381333931E+12\t4',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].eanCorrupted).toBeFalsy();
      expect(result.items[0].ean).toBe('4006381333931');
    });

    it('erkennt numerisch gespeicherte Zero-Padded EANs als EAN_SUSPECT_TRUNCATED (F1)', () => {
      expect(isSuspectZeroPaddedEan('4006380000000')).toBe(true);
      expect(isSuspectZeroPaddedEan('1234560000000')).toBe(true);
      expect(isSuspectZeroPaddedEan('4006381333931')).toBe(false);

      const report = [
        'seller-sku\tasin1\titem-name\tproduct-id\tproduct-id-type',
        'SKU-SUSPECT-ZERO\tB00004CK5B\tStabilo Boss\t4006380000000\t4',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].eanCorrupted).toBe(true);
      expect(result.items[0].identifierWarning).toBe('EAN_SUSPECT_TRUNCATED');
      expect(result.items[0].ean).toBeUndefined(); // Verhindert Fake-Barcode-Matching
      expect(result.errors.some((e) => e.code === 'EAN_SUSPECT_TRUNCATED')).toBe(true);
    });
  });

  describe('Akzeptanzkriterium 4: Strukturierte AmazonInventoryItem-Listen, Duplikate & Fehlerstatistik', () => {
    it('erfasst fehlerhafte Zeilen (ohne SKU und ASIN) in errors und fuehrt Fehlerstatistik', () => {
      const report = [
        'seller-sku\tasin1\titem-name\tprice\tquantity',
        'SKU-OK-1\tB00004CK5B\tGueltiges Produkt 1\t10.00\t5',
        '\t\tUngueltige Zeile ohne Kennungen\t15.00\t0',
        'SKU-OK-2\tB00004CK5C\tGueltiges Produkt 2\t20.00\t10',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.items).toHaveLength(2);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].row).toBe(3);
      expect(result.errors[0].code).toBe('MISSING_REQUIRED_IDENTIFIER');

      expect(result.stats.totalRows).toBe(4);
      expect(result.stats.dataRows).toBe(3);
      expect(result.stats.validItems).toBe(2);
      expect(result.stats.errorRows).toBe(1);
      expect(result.stats.duplicateRows).toBe(0);
    });

    it('erkennt Duplikate bei mehrfachem Auftreten derselben seller-sku', () => {
      const report = [
        'seller-sku\tasin1\titem-name\tprice',
        'SKU-DUP\tB00004CK5B\tErste Version\t10.00',
        'SKU-OTHER\tB00004CK5C\tAnderes Produkt\t15.00',
        'SKU-DUP\tB00004CK5B\tZweite Version (Duplikat)\t12.00',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.stats.duplicateRows).toBe(1);
      expect(result.duplicates).toHaveLength(1);
      expect(result.duplicates[0]).toMatchObject({
        row: 4,
        firstSeenRow: 2,
        sellerSku: 'SKU-DUP',
      });
      // Standardmaessig dedupliziert result.items
      expect(result.items).toHaveLength(2);
      expect(result.items[0].itemName).toBe('Erste Version');
    });

    it('behaelt alle Zeilen wenn deduplicate=false konfiguriert ist', () => {
      const report = [
        'seller-sku\tasin1\titem-name',
        'SKU-DUP\tB00004CK5B\tVersion 1',
        'SKU-DUP\tB00004CK5B\tVersion 2',
      ].join('\n');

      const result = parseAmazonInventoryReport(report, { deduplicate: false });

      expect(result.stats.duplicateRows).toBe(1);
      expect(result.items).toHaveLength(2);
    });

    it('befuellt AsinEanMap sowie bySku und byAsin Lookup-Maps', () => {
      const report = [
        'seller-sku\tasin1\tproduct-id\tproduct-id-type',
        'SKU-A\tB00004CK5B\t4006381333931\t4',
        'SKU-B\tB00004CK5C\t4006381333948\t4',
      ].join('\n');

      const result = parseAmazonInventoryReport(report);

      expect(result.asinEanMap.get('B00004CK5B')).toBe('4006381333931');
      expect(result.asinEanMap.get('B00004CK5C')).toBe('4006381333948');

      expect(result.bySku.get('SKU-A')?.asin1).toBe('B00004CK5B');
      expect(result.byAsin.get('B00004CK5C')?.sellerSku).toBe('SKU-B');
    });
  });
});
