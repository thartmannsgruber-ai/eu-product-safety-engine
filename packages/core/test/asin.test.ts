import { describe, it, expect } from 'vitest';
import {
  isValidAsin,
  isIsbn10Asin,
  isbn10ToEan13,
  extractAsinFromUrl,
  extractSlugKeywords,
  isValidEan,
  AMAZON_TLDS,
} from '../src/index.js';

describe('asin - ASIN Parser and ISBN-10 to EAN-13 Converter', () => {
  describe('isbn10ToEan13 and isValidEan', () => {
    it("isbn10ToEan13('3161484100') ergibt '9783161484100' und ist laut isValidEan gültig", () => {
      const ean = isbn10ToEan13('3161484100');
      expect(ean).toBe('9783161484100');
      expect(isValidEan(ean)).toBe(true);
    });

    it('Eine ISBN-10 mit Prüfziffer X wird korrekt konvertiert', () => {
      // 3-16-148410-X
      const ean1 = isbn10ToEan13('316148410X');
      expect(ean1).toBe('9783161484100');
      expect(isValidEan(ean1)).toBe(true);

      // With hyphens
      const eanHyphens = isbn10ToEan13('3-16-148410-X');
      expect(eanHyphens).toBe('9783161484100');
      expect(isValidEan(eanHyphens)).toBe(true);

      // Another known ISBN-10 ending in X (0-8044-2957-X)
      const ean2 = isbn10ToEan13('080442957X');
      expect(ean2).toBe('9780804429573');
      expect(isValidEan(ean2)).toBe(true);

      // Lowercase x
      const eanLower = isbn10ToEan13('080442957x');
      expect(eanLower).toBe('9780804429573');
      expect(isValidEan(eanLower)).toBe(true);
    });

    it('konvertiert Standard-ISBN-10 mit Ziffern-Prüfziffer korrekt', () => {
      // 0-306-40615-2
      const ean = isbn10ToEan13('0306406152');
      expect(ean).toBe('9780306406157');
      expect(isValidEan(ean)).toBe(true);
    });

    it('wirft einen Fehler bei ungültigem Format', () => {
      expect(() => isbn10ToEan13('123')).toThrow('Invalid ISBN-10 format');
      expect(() => isbn10ToEan13('B08N5WRWNW')).toThrow('Invalid ISBN-10 format');
      expect(() => isbn10ToEan13('')).toThrow('Invalid ISBN-10 format');
      // @ts-expect-error test non-string input
      expect(() => isbn10ToEan13(null)).toThrow('ISBN-10 must be a string');
    });
  });

  describe('isIsbn10Asin', () => {
    it('erkennt gültige ISBN-10 mit Ziffer oder X', () => {
      expect(isIsbn10Asin('316148410X')).toBe(true);
      expect(isIsbn10Asin('3-16-148410-X')).toBe(true);
      expect(isIsbn10Asin('0306406152')).toBe(true);
      expect(isIsbn10Asin('080442957X')).toBe(true);
      expect(isIsbn10Asin('080442957x')).toBe(true);
    });

    it('lehnt ungültige ISBN-10 Prüfziffern oder falsche Formate ab', () => {
      // Falsche Prüfziffer (0 statt X)
      expect(isIsbn10Asin('3161484100')).toBe(false);
      // Falsche Länge
      expect(isIsbn10Asin('030640615')).toBe(false);
      expect(isIsbn10Asin('03064061522')).toBe(false);
      // Keine ISBN (B0 ASIN)
      expect(isIsbn10Asin('B08N5WRWNW')).toBe(false);
      // Ungültige Zeichen
      expect(isIsbn10Asin('ABCDEFGHIJ')).toBe(false);
      // @ts-expect-error test non-string
      expect(isIsbn10Asin(null)).toBe(false);
    });
  });

  describe('isValidAsin', () => {
    it('akzeptiert ASINs mit B0-Präfix (10 Zeichen, alphanumerisch)', () => {
      expect(isValidAsin('B08N5WRWNW')).toBe(true);
      expect(isValidAsin('b08n5wrwnw')).toBe(true);
      expect(isValidAsin('B012345678')).toBe(true);
      expect(isValidAsin('B0ABCDEF12')).toBe(true);
    });

    it('akzeptiert gültige ISBN-10 als ASIN', () => {
      expect(isValidAsin('316148410X')).toBe(true);
      expect(isValidAsin('0306406152')).toBe(true);
      expect(isValidAsin('080442957X')).toBe(true);
    });

    it('lehnt ungültige ASINs ab', () => {
      expect(isValidAsin('B08N5W')).toBe(false); // zu kurz
      expect(isValidAsin('B08N5WRWNW123')).toBe(false); // zu lang
      expect(isValidAsin('A08N5WRWNW')).toBe(false); // Nicht B0 und keine ISBN
      expect(isValidAsin('3161484100')).toBe(false); // Ungültige ISBN-10 Prüfziffer
      expect(isValidAsin('B08N5W-WNW')).toBe(false); // Ungültiges Zeichen
      expect(isValidAsin('')).toBe(false);
      // @ts-expect-error test non-string
      expect(isValidAsin(undefined)).toBe(false);
    });
  });

  describe('extractAsinFromUrl - URL Formate', () => {
    it('extrahiert ASIN aus /dp/ Pfad ohne Titel-Slug', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/dp/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /dp/ Pfad mit Produkt-Titel-Slug', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/Apple-iPhone-13-128-GB/dp/B09G96TFF7');
      expect(res).toEqual({ asin: 'B09G96TFF7', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /dp/ mit abschließendem Slash', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/dp/B08N5WRWNW/');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /dp/ mit ref-Parametern im Pfad', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/dp/B08N5WRWNW/ref=sr_1_1');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /dp/ mit Query-Parametern', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/dp/B08N5WRWNW?th=1&psc=1');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /gp/product/ Pfad', () => {
      const res = extractAsinFromUrl('https://www.amazon.com/gp/product/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'com', needsRedirect: false });
    });

    it('extrahiert ASIN aus /gp/product/ mit ref-Pfad', () => {
      const res = extractAsinFromUrl('https://www.amazon.com/gp/product/B08N5WRWNW/ref=ox_sc_act_title_1');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'com', needsRedirect: false });
    });

    it('extrahiert ASIN aus mobilem /gp/aw/d/ Pfad', () => {
      const res = extractAsinFromUrl('https://www.amazon.co.uk/gp/aw/d/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'co.uk', needsRedirect: false });
    });

    it('extrahiert ASIN aus /gp/aw/d/ mit ref-Pfad auf mobiler Subdomain', () => {
      const res = extractAsinFromUrl('https://m.amazon.de/gp/aw/d/B08N5WRWNW/ref=mp_s_a_1_1');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus /exec/obidos/ASIN/ Pfad', () => {
      const res = extractAsinFromUrl('https://www.amazon.com/exec/obidos/ASIN/B08N5WRWNW/ref=nosim');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'com', needsRedirect: false });
    });

    it('extrahiert ISBN-10 ASIN aus /exec/obidos/ASIN/', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/exec/obidos/ASIN/316148410X');
      expect(res).toEqual({ asin: '316148410X', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus dem ?asin= Query-Parameter', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/gp/product/handle-buy-box.html?asin=B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('extrahiert ASIN aus ?asin= bei Suchseiten', () => {
      const res = extractAsinFromUrl('https://www.amazon.com/search?asin=B08N5WRWNW&page=1');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'com', needsRedirect: false });
    });

    it('akzeptiert URLs ohne Protokoll-Präfix', () => {
      const res = extractAsinFromUrl('www.amazon.de/dp/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('normalisiert kleingeschriebene ASINs auf Großschreibung', () => {
      const res = extractAsinFromUrl('https://www.amazon.de/dp/b08n5wrwnw');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });
  });

  describe('extractAsinFromUrl - Alle 16 Amazon TLDs und Subdomains', () => {
    const tldTestCases: Array<{ url: string; expectedTld: string }> = [
      { url: 'https://www.amazon.de/dp/B08N5WRWNW', expectedTld: 'de' },
      { url: 'https://www.amazon.com/dp/B08N5WRWNW', expectedTld: 'com' },
      { url: 'https://www.amazon.co.uk/dp/B08N5WRWNW', expectedTld: 'co.uk' },
      { url: 'https://www.amazon.fr/dp/B08N5WRWNW', expectedTld: 'fr' },
      { url: 'https://www.amazon.it/dp/B08N5WRWNW', expectedTld: 'it' },
      { url: 'https://www.amazon.es/dp/B08N5WRWNW', expectedTld: 'es' },
      { url: 'https://www.amazon.nl/dp/B08N5WRWNW', expectedTld: 'nl' },
      { url: 'https://www.amazon.pl/dp/B08N5WRWNW', expectedTld: 'pl' },
      { url: 'https://www.amazon.se/dp/B08N5WRWNW', expectedTld: 'se' },
      { url: 'https://www.amazon.com.be/dp/B08N5WRWNW', expectedTld: 'com.be' },
      { url: 'https://www.amazon.com.tr/dp/B08N5WRWNW', expectedTld: 'com.tr' },
      { url: 'https://www.amazon.ca/dp/B08N5WRWNW', expectedTld: 'ca' },
      { url: 'https://www.amazon.com.mx/dp/B08N5WRWNW', expectedTld: 'com.mx' },
      { url: 'https://www.amazon.co.jp/dp/B08N5WRWNW', expectedTld: 'co.jp' },
      { url: 'https://www.amazon.in/dp/B08N5WRWNW', expectedTld: 'in' },
      { url: 'https://www.amazon.com.au/dp/B08N5WRWNW', expectedTld: 'com.au' },
    ];

    for (const { url, expectedTld } of tldTestCases) {
      it(`erkennt Marketplace '${expectedTld}' für ${url}`, () => {
        const res = extractAsinFromUrl(url);
        expect(res).not.toBeNull();
        expect(res?.marketplace).toBe(expectedTld);
        expect(res?.asin).toBe('B08N5WRWNW');
        expect(res?.needsRedirect).toBe(false);
      });
    }

    it('unterstützt smile.-Subdomains', () => {
      const res = extractAsinFromUrl('https://smile.amazon.com/dp/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'com', needsRedirect: false });
    });

    it('unterstützt m.-Subdomains', () => {
      const res = extractAsinFromUrl('https://m.amazon.co.uk/dp/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'co.uk', needsRedirect: false });
    });

    it('unterstützt Amazon-Domains ohne Subdomain', () => {
      const res = extractAsinFromUrl('https://amazon.de/dp/B08N5WRWNW');
      expect(res).toEqual({ asin: 'B08N5WRWNW', marketplace: 'de', needsRedirect: false });
    });

    it('stellt sicher, dass alle 16 TLDs in AMAZON_TLDS enthalten sind', () => {
      expect(AMAZON_TLDS.length).toBe(16);
    });
  });

  describe('extractAsinFromUrl - Host-Spoofing und fremde Domains', () => {
    it('Host-Spoofing wie amazon.de.evil.com wird abgelehnt', () => {
      expect(extractAsinFromUrl('https://amazon.de.evil.com/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt Host-Spoofing amazon.evil.com ab', () => {
      expect(extractAsinFromUrl('https://amazon.evil.com/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt notamazon.de ab', () => {
      expect(extractAsinFromUrl('https://notamazon.de/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt evil-amazon.com ab', () => {
      expect(extractAsinFromUrl('https://evil-amazon.com/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt fakeamazon.co.uk ab', () => {
      expect(extractAsinFromUrl('https://fakeamazon.co.uk/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt amazon.com.evil.org ab', () => {
      expect(extractAsinFromUrl('https://amazon.com.evil.org/dp/B08N5WRWNW')).toBeNull();
    });

    it('lehnt amzn.to.evil.com ab', () => {
      expect(extractAsinFromUrl('https://amzn.to.evil.com/3xyz')).toBeNull();
    });

    it('lehnt a.co.attacker.io ab', () => {
      expect(extractAsinFromUrl('https://a.co.attacker.io/d/123')).toBeNull();
    });

    it('gibt null zurück bei ungültigen Eingaben oder URLs ohne ASIN', () => {
      expect(extractAsinFromUrl('')).toBeNull();
      expect(extractAsinFromUrl('keine-url')).toBeNull();
      expect(extractAsinFromUrl('https://www.amazon.de/s?k=staubsauger')).toBeNull();
      expect(extractAsinFromUrl('https://www.amazon.de/dp/TOOLONGASIN123')).toBeNull();
      expect(extractAsinFromUrl('https://www.amazon.de/dp/123')).toBeNull();
      // @ts-expect-error test non-string
      expect(extractAsinFromUrl(null)).toBeNull();
    });
  });

  describe('extractAsinFromUrl - Kurzlinks', () => {
    it('amzn.to liefert needsRedirect=true und asin=null', () => {
      const res = extractAsinFromUrl('https://amzn.to/3xyz123');
      expect(res).toEqual({ asin: null, marketplace: null, needsRedirect: true });
    });

    it('a.co liefert needsRedirect=true und asin=null', () => {
      const res = extractAsinFromUrl('https://a.co/d/9abcdef');
      expect(res).toEqual({ asin: null, marketplace: null, needsRedirect: true });
    });

    it('unterstützt www.amzn.to und www.a.co Kurzlinks', () => {
      expect(extractAsinFromUrl('https://www.amzn.to/abc')).toEqual({
        asin: null,
        marketplace: null,
        needsRedirect: true,
      });
      expect(extractAsinFromUrl('https://www.a.co/d/xyz')).toEqual({
        asin: null,
        marketplace: null,
        needsRedirect: true,
      });
    });

    it('unterstützt Kurzlinks ohne http-Schema', () => {
      expect(extractAsinFromUrl('amzn.to/3xyz')).toEqual({
        asin: null,
        marketplace: null,
        needsRedirect: true,
      });
    });
  });

  describe('extractSlugKeywords', () => {
    it('extrahiert Suchbegriffe aus Produkt-URL und entfernt Zahlen', () => {
      const keywords = extractSlugKeywords('https://www.amazon.de/Apple-iPhone-13-128-GB/dp/B09G96TFF7');
      expect(keywords).toEqual(['apple', 'iphone', 'gb']);
    });

    it('decodiert URL-Zeichen und entfernt deutsche Stoppwörter', () => {
      const keywords = extractSlugKeywords(
        'https://www.amazon.de/Der-perfekte-Kaffee-f%C3%BCr-Einsteiger/dp/B08N5WRWNW'
      );
      expect(keywords).toEqual(['perfekte', 'kaffee', 'einsteiger']);
    });

    it('behält alphanumerische Modellnummern und begrenzt auf höchstens 6 Suchbegriffe', () => {
      const keywords = extractSlugKeywords(
        'https://www.amazon.com/Sony-WH-1000XM4-Wireless-Industry-Canceling-Headphones-Black/dp/B0863TXGM3'
      );
      expect(keywords.length).toBeLessThanOrEqual(6);
      expect(keywords).toContain('sony');
      expect(keywords).toContain('wh');
      expect(keywords).toContain('1000xm4');
    });

    it('gibt ein leeres Array zurück, wenn kein Pfad vor /dp/ vorhanden ist', () => {
      expect(extractSlugKeywords('https://www.amazon.de/dp/B08N5WRWNW')).toEqual([]);
    });

    it('gibt ein leeres Array zurück, wenn die URL kein /dp/ enthält', () => {
      expect(extractSlugKeywords('https://www.amazon.de/gp/product/B08N5WRWNW')).toEqual([]);
    });

    it('behandelt ungültige oder leere URLs sicher', () => {
      expect(extractSlugKeywords('')).toEqual([]);
      // @ts-expect-error test non-string
      expect(extractSlugKeywords(null)).toEqual([]);
    });
  });
});
