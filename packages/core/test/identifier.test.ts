import { describe, it, expect } from 'vitest';
import {
  classifyIdentifier,
  resolveIdentifier,
  MapAsinEanProvider,
  type AsinEanProvider,
} from '../src/index.js';

describe('identifier - Classification and Resolution of Identifiers', () => {
  describe('classifyIdentifier', () => {
    it('klassifiziert EAN-13 korrekt als gtin', () => {
      const res = classifyIdentifier('4006381333931');
      expect(res.kind).toBe('gtin');
      expect(res.normalized).toBe('04006381333931');
      expect(res.ean).toBe('4006381333931');
    });

    it('klassifiziert UPC-A korrekt als gtin', () => {
      // 012345678905 (12 digits)
      const res = classifyIdentifier('012345678905');
      expect(res.kind).toBe('gtin');
      expect(res.normalized).toBe('00012345678905');
      expect(res.ean).toBe('012345678905');
    });

    it('klassifiziert GTIN-14 korrekt als gtin', () => {
      const res = classifyIdentifier('04006381333931');
      expect(res.kind).toBe('gtin');
      expect(res.normalized).toBe('04006381333931');
      expect(res.ean).toBe('04006381333931');
    });

    it('klassifiziert EAN-8 korrekt als gtin', () => {
      const res = classifyIdentifier('96385074');
      expect(res.kind).toBe('gtin');
      expect(res.normalized).toBe('00000096385074');
      expect(res.ean).toBe('96385074');
    });

    it('klassifiziert ISBN-10 mit Prüfziffer korrekt als isbn10', () => {
      const res1 = classifyIdentifier('0306406152');
      expect(res1.kind).toBe('isbn10');
      expect(res1.normalized).toBe('0306406152');
      expect(res1.ean).toBe('9780306406157');

      // ISBN-10 mit X
      const res2 = classifyIdentifier('3-16-148410-X');
      expect(res2.kind).toBe('isbn10');
      expect(res2.normalized).toBe('316148410X');
      expect(res2.ean).toBe('9783161484100');
    });

    it('klassifiziert B0-ASIN korrekt als asin', () => {
      const res = classifyIdentifier('B08H93ZRK9');
      expect(res.kind).toBe('asin');
      expect(res.normalized).toBe('B08H93ZRK9');
      expect(res.asin).toBe('B08H93ZRK9');
    });

    it('klassifiziert Standard-Amazon-URL korrekt als amazon_url', () => {
      const res = classifyIdentifier('https://www.amazon.de/dp/B08H93ZRK9');
      expect(res.kind).toBe('amazon_url');
      expect(res.asin).toBe('B08H93ZRK9');
      expect(res.normalized).toBe('B08H93ZRK9');
      expect(res.needsRedirect).toBe(false);
    });

    it('klassifiziert Amazon-URL mit Titel korrekt und extrahiert Keywords', () => {
      const res = classifyIdentifier('https://www.amazon.de/Sony-PlayStation-5-Digital-Edition/dp/B08H93ZRK9');
      expect(res.kind).toBe('amazon_url');
      expect(res.asin).toBe('B08H93ZRK9');
      expect(res.keywords).toBeDefined();
      expect(res.keywords).toContain('sony');
      expect(res.keywords).toContain('playstation');
    });

    it('klassifiziert Amazon-Kurzlinks mit needsRedirect=true', () => {
      const resAmzn = classifyIdentifier('https://amzn.to/3example');
      expect(resAmzn.kind).toBe('amazon_url');
      expect(resAmzn.needsRedirect).toBe(true);

      const resAco = classifyIdentifier('https://a.co/d/456abc');
      expect(resAco.kind).toBe('amazon_url');
      expect(resAco.needsRedirect).toBe(true);
    });

    it('klassifiziert Freitext und ungültige Kennungen als unknown', () => {
      const resText = classifyIdentifier('Kinderwagen Buggy Reise');
      expect(resText.kind).toBe('unknown');

      // 13-stellige Ziffernfolge mit ungültiger Modulo-10 Prüfziffer
      const resInvalidEan = classifyIdentifier('4006381333930');
      expect(resInvalidEan.kind).toBe('unknown');

      // Leerer String
      const resEmpty = classifyIdentifier('');
      expect(resEmpty.kind).toBe('unknown');

      // Fremde URL
      const resForeign = classifyIdentifier('https://notamazon.de/dp/B08H93ZRK9');
      expect(resForeign.kind).toBe('unknown');
    });
  });

  describe('MapAsinEanProvider', () => {
    it('erstellt Provider aus Record, Map oder Einträgen und schlägt Werte case-insensitiv nach', () => {
      const provider = new MapAsinEanProvider({
        'B08H93ZRK9': '4006381333931',
        'B001234567': '9783161484100',
      });

      expect(provider.lookup('B08H93ZRK9')).toBe('4006381333931');
      expect(provider.lookup('b08h93zrk9')).toBe('4006381333931');
      expect(provider.lookup('B000000000')).toBeNull();

      provider.set('B099999999', '012345678905');
      expect(provider.lookup('B099999999')).toBe('012345678905');
      expect(provider.has('b099999999')).toBe(true);
      expect(provider.size).toBe(3);
    });
  });

  describe('resolveIdentifier - Auflösungsmethoden und Prioritäten', () => {
    it("Weg 1: direkte GTIN liefert resolution_method='direct_gtin'", () => {
      const resEan13 = resolveIdentifier('4006381333931');
      expect(resEan13.kind).toBe('gtin');
      expect(resEan13.ean).toBe('4006381333931');
      expect(resEan13.resolution_method).toBe('direct_gtin');
      expect(resEan13.error).toBeUndefined();

      const resUpcA = resolveIdentifier('012345678905');
      expect(resUpcA.kind).toBe('gtin');
      expect(resUpcA.ean).toBe('012345678905');
      expect(resUpcA.resolution_method).toBe('direct_gtin');
    });

    it("Weg 2: ISBN-10-Konvertierung liefert resolution_method='isbn10_conversion'", () => {
      const res = resolveIdentifier('0306406152');
      expect(res.kind).toBe('isbn10');
      expect(res.ean).toBe('9780306406157');
      expect(res.resolution_method).toBe('isbn10_conversion');
      expect(res.error).toBeUndefined();

      // Amazon-URL mit ISBN-10 als ASIN
      const resUrl = resolveIdentifier('https://www.amazon.de/dp/0306406152');
      expect(resUrl.kind).toBe('amazon_url');
      expect(resUrl.ean).toBe('9780306406157');
      expect(resUrl.resolution_method).toBe('isbn10_conversion');
    });

    it("Weg 3: Provider-Zuordnung liefert resolution_method='csv_mapping'", () => {
      const provider = new MapAsinEanProvider({
        'B08H93ZRK9': '4006381333931',
      });

      // Direkte ASIN
      const resAsin = resolveIdentifier('B08H93ZRK9', provider);
      expect(resAsin.kind).toBe('asin');
      expect(resAsin.ean).toBe('4006381333931');
      expect(resAsin.resolution_method).toBe('csv_mapping');

      // Amazon-URL mit ASIN
      const resUrl = resolveIdentifier(
        'https://www.amazon.de/Sony-PlayStation-5-Digital-Edition/dp/B08H93ZRK9',
        provider
      );
      expect(resUrl.kind).toBe('amazon_url');
      expect(resUrl.ean).toBe('4006381333931');
      expect(resUrl.resolution_method).toBe('csv_mapping');
    });

    it("Weg 3 (async): Asynchroner Provider funktioniert mit await", async () => {
      const asyncProvider: AsinEanProvider = {
        async lookup(asin: string) {
          if (asin === 'B08H93ZRK9') {
            return '4006381333931';
          }
          return null;
        },
      };

      const res = await resolveIdentifier('B08H93ZRK9', asyncProvider);
      expect(res.kind).toBe('asin');
      expect(res.ean).toBe('4006381333931');
      expect(res.resolution_method).toBe('csv_mapping');
    });

    it("Weg 4: Suchbegriffe aus der URL liefert resolution_method='url_slug_keywords'", () => {
      // Ohne Provider
      const res = resolveIdentifier('https://www.amazon.de/Sony-PlayStation-5-Konsole/dp/B08H93ZRK9');
      expect(res.kind).toBe('amazon_url');
      expect(res.resolution_method).toBe('url_slug_keywords');
      expect(res.ean).toBeUndefined();
      expect(res.keywords).toBeDefined();
      expect(res.keywords).toContain('sony');
      expect(res.keywords).toContain('playstation');
      expect(res.keywords).toContain('konsole');
    });

    it('Priorität: Provider-Zuordnung hat Vorrang vor URL-Suchbegriffen', () => {
      const provider = new MapAsinEanProvider({
        'B08H93ZRK9': '4006381333931',
      });
      const res = resolveIdentifier(
        'https://www.amazon.de/Sony-PlayStation-5-Konsole/dp/B08H93ZRK9',
        provider
      );
      expect(res.resolution_method).toBe('csv_mapping');
      expect(res.ean).toBe('4006381333931');
    });

    it('Akzeptanzkriterium 3: Eine B0-ASIN ohne Provider-Zuordnung und ohne Titel in der URL liefert ein nicht auflösbares Ergebnis mit Fehlertext, ohne Exception', () => {
      // Reine B0-ASIN
      expect(() => {
        const res1 = resolveIdentifier('B08H93ZRK9');
        expect(res1.kind).toBe('asin');
        expect(res1.ean).toBeUndefined();
        expect(res1.resolution_method).toBeUndefined();
        expect(typeof res1.error).toBe('string');
        expect(res1.error!.length).toBeGreaterThan(0);
      }).not.toThrow();

      // Amazon-URL mit B0-ASIN aber ohne Produkttitel im Pfad
      expect(() => {
        const res2 = resolveIdentifier('https://www.amazon.de/dp/B08H93ZRK9');
        expect(res2.kind).toBe('amazon_url');
        expect(res2.ean).toBeUndefined();
        expect(res2.resolution_method).toBeUndefined();
        expect(typeof res2.error).toBe('string');
        expect(res2.error!.length).toBeGreaterThan(0);
      }).not.toThrow();
    });

    it('Akzeptanzkriterium 4: Ein Kurzlink liefert needsRedirect=true', () => {
      const resAmzn = resolveIdentifier('https://amzn.to/3example');
      expect(resAmzn.kind).toBe('amazon_url');
      expect(resAmzn.needsRedirect).toBe(true);
      expect(resAmzn.ean).toBeUndefined();
      expect(typeof resAmzn.error).toBe('string');

      const resAco = resolveIdentifier('https://a.co/d/987xyz');
      expect(resAco.kind).toBe('amazon_url');
      expect(resAco.needsRedirect).toBe(true);
      expect(resAco.ean).toBeUndefined();
    });

    it('Freitext liefert ein nicht auflösbares Ergebnis mit Fehlertext, ohne Exception', () => {
      const res = resolveIdentifier('Unbekanntes Spielzeug');
      expect(res.kind).toBe('unknown');
      expect(res.ean).toBeUndefined();
      expect(res.resolution_method).toBeUndefined();
      expect(typeof res.error).toBe('string');
    });
  });
});
