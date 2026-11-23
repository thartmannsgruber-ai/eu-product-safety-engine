import { describe, it, expect } from 'vitest';
import {
  checkGpsrListing,
  checkGpsrListings,
  normalizeGpsrInput,
  isEuLocation,
  isValidEmail,
  isValidContactUrl,
  validateElectronicContact,
  hasCeMarkingIndicator,
  GpsrListingInput,
} from '../src/gpsr.js';

describe('GPSR Listing-Readiness & Compliance Checker (F04)', () => {
  // Vollständig konformes Muster-Listing
  const compliantListing: GpsrListingInput = {
    id: 'LIST-001',
    sku: 'DE-SKU-9901',
    asin: 'B08N5WRWNW',
    title: 'Sony Kabelloser Kopfhörer WH-1000XM4 mit Geräuschunterdrückung',
    category: 'Electronics',
    responsiblePerson: {
      name: 'Sony Europe B.V.',
      address: 'Taurusavenue 16, 2132 LS Hoofddorp',
      country: 'NL',
      email: 'compliance-eu@sony.com',
      contactUrl: 'https://services.sony.de/support/de/contact-eu',
    },
    manufacturer: {
      name: 'Sony Corporation',
      brand: 'Sony',
      address: '1-7-1 Konan Minato-ku, Tokyo 108-0075, Japan',
      country: 'JP',
      email: 'product-safety@sony.co.jp',
      website: 'https://www.sony.net/safety',
    },
    productIdentifier: {
      type: 'Wireless Noise Canceling Headphones',
      modelNumber: 'WH-1000XM4',
      batchNumber: 'LOT-2024-Q3',
      ean: '5013493400301',
    },
    safetyInformation: {
      warnings: ['Achtung: Erstickungsgefahr durch Kleinteile. Nicht geeignet für Kinder unter 36 Monaten.'],
      safetyInstructions: ['Nur mit dem mitgelieferten USB-C-Ladekabel laden. Vor Feuchtigkeit schützen.'],
      ceMarking: true,
      hasCeMarking: true,
    },
  };

  describe('Akzeptanzkriterium 1: Pflichtfelder der EU-Responsible-Person (Art. 16, Art. 19 Abs. 1 lit. b)', () => {
    it('erkennt vollständige und korrekte EU-Responsible-Person Angaben', () => {
      const result = checkGpsrListing(compliantListing);

      expect(result.sections.responsiblePerson.passed).toBe(true);
      expect(result.sections.responsiblePerson.details.hasName).toBe(true);
      expect(result.sections.responsiblePerson.details.hasEuPostalAddress).toBe(true);
      expect(result.sections.responsiblePerson.details.hasElectronicContact).toBe(true);
      expect(result.sections.responsiblePerson.score).toBe(30);

      const rpGaps = result.gaps.filter((g) => g.article === 'Art. 16' || g.article === 'Art. 16(1)');
      expect(rpGaps).toHaveLength(0);
    });

    it('erkennt fehlenden Namen der EU-Verantwortlichen Person', () => {
      const input = {
        ...compliantListing,
        responsiblePerson: {
          ...compliantListing.responsiblePerson,
          name: '',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.responsiblePerson.passed).toBe(false);
      expect(result.sections.responsiblePerson.details.hasName).toBe(false);

      const gap = result.gaps.find((g) => g.code === 'MISSING_RESPONSIBLE_PERSON_NAME');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('CRITICAL');
      expect(gap?.article).toBe('Art. 16');
      expect(gap?.articleCitation).toContain('Art. 16');
      expect(gap?.articleCitation).toContain('Art. 19');
    });

    it('erkennt fehlende postalische Adresse der EU-Verantwortlichen Person', () => {
      const input = {
        ...compliantListing,
        responsiblePerson: {
          ...compliantListing.responsiblePerson,
          address: '',
          country: '',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.responsiblePerson.passed).toBe(false);
      expect(result.sections.responsiblePerson.details.hasEuPostalAddress).toBe(false);

      const gap = result.gaps.find((g) => g.code === 'MISSING_RESPONSIBLE_PERSON_ADDRESS');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('CRITICAL');
      expect(gap?.articleCitation).toContain('Art. 16');
      expect(gap?.articleCitation).toContain('Art. 19');
    });

    it('erkennt, wenn die Verantwortliche Person nicht in der EU ansässig ist (z.B. US/China/UK)', () => {
      const input = {
        ...compliantListing,
        responsiblePerson: {
          name: 'Shenzhen Trading Ltd.',
          address: 'Baoan District, Shenzhen, China',
          country: 'CN',
          email: 'eu-rep@example.com',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.responsiblePerson.passed).toBe(false);
      expect(result.sections.responsiblePerson.details.hasEuPostalAddress).toBe(false);

      const gap = result.gaps.find((g) => g.code === 'RESPONSIBLE_PERSON_NOT_IN_EU');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('CRITICAL');
      expect(gap?.article).toBe('Art. 16(1)');
    });

    it('erkennt fehlende oder ungültige elektronische Kontaktadresse (E-Mail/Kontakt-URL)', () => {
      const input = {
        ...compliantListing,
        responsiblePerson: {
          ...compliantListing.responsiblePerson,
          email: '',
          contactUrl: '',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.responsiblePerson.passed).toBe(false);
      expect(result.sections.responsiblePerson.details.hasElectronicContact).toBe(false);

      const missingGap = result.gaps.find((g) => g.code === 'MISSING_RESPONSIBLE_PERSON_ELECTRONIC_CONTACT');
      expect(missingGap).toBeDefined();
      expect(missingGap?.severity).toBe('HIGH');
      expect(missingGap?.articleCitation).toContain('Art. 16');
      expect(missingGap?.articleCitation).toContain('Art. 19');

      // Ungültige E-Mail
      const invalidInput = {
        ...compliantListing,
        responsiblePerson: {
          ...compliantListing.responsiblePerson,
          email: 'invalid-email-without-at',
          contactUrl: '',
        },
      };
      const invalidResult = checkGpsrListing(invalidInput);
      expect(invalidResult.gaps.some((g) => g.code === 'INVALID_RESPONSIBLE_PERSON_ELECTRONIC_CONTACT')).toBe(true);
    });

    it('akzeptiert valides Web-Kontaktformular als elektronische Kontaktadresse', () => {
      const input = {
        ...compliantListing,
        responsiblePerson: {
          ...compliantListing.responsiblePerson,
          email: '',
          contactUrl: 'https://company.eu/gpsr-contact',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.responsiblePerson.details.hasElectronicContact).toBe(true);
      expect(result.gaps.filter((g) => g.field.startsWith('responsiblePerson.email'))).toHaveLength(0);
    });
  });

  describe('Akzeptanzkriterium 2: Pflichtangaben des Herstellers (Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a)', () => {
    it('erkennt vollständige Herstellerangaben', () => {
      const result = checkGpsrListing(compliantListing);

      expect(result.sections.manufacturer.passed).toBe(true);
      expect(result.sections.manufacturer.details.hasNameOrBrand).toBe(true);
      expect(result.sections.manufacturer.details.hasPostalAddress).toBe(true);
      expect(result.sections.manufacturer.details.hasElectronicContact).toBe(true);
      expect(result.sections.manufacturer.score).toBe(30);

      const mfrGaps = result.gaps.filter((g) => g.article === 'Art. 9(1)');
      expect(mfrGaps).toHaveLength(0);
    });

    it('akzeptiert Handelsmarke / Brand, wenn Herstellername als Brand hinterlegt ist', () => {
      const input = {
        ...compliantListing,
        manufacturer: {
          name: '',
          brand: 'Anker Innovations',
          address: 'Tower A, Hi-Tech Industrial Park, Shenzhen, China',
          email: 'support@anker.com',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.manufacturer.details.hasNameOrBrand).toBe(true);
      expect(result.gaps.some((g) => g.code === 'MISSING_MANUFACTURER_NAME')).toBe(false);
    });

    it('erkennt fehlenden Herstellernamen und fehlende Marke', () => {
      const input = {
        ...compliantListing,
        manufacturer: {
          name: '',
          brand: '',
          address: 'Some Street 1, 10115 Berlin',
          email: 'info@example.com',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.manufacturer.details.hasNameOrBrand).toBe(false);
      const gap = result.gaps.find((g) => g.code === 'MISSING_MANUFACTURER_NAME');
      expect(gap).toBeDefined();
      expect(gap?.article).toBe('Art. 9(1)');
      expect(gap?.articleCitation).toContain('Art. 9');
      expect(gap?.articleCitation).toContain('Art. 19');
    });

    it('erkennt fehlende postalische Anschrift des Herstellers', () => {
      const input = {
        ...compliantListing,
        manufacturer: {
          ...compliantListing.manufacturer,
          address: '',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.manufacturer.details.hasPostalAddress).toBe(false);
      const gap = result.gaps.find((g) => g.code === 'MISSING_MANUFACTURER_ADDRESS');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('HIGH');
      expect(gap?.articleCitation).toContain('Art. 9');
      expect(gap?.articleCitation).toContain('Art. 19');
    });

    it('erkennt fehlenden elektronischen Kontakt des Herstellers (weder E-Mail noch Website)', () => {
      const input = {
        ...compliantListing,
        manufacturer: {
          ...compliantListing.manufacturer,
          email: '',
          website: '',
          contactUrl: '',
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.manufacturer.details.hasElectronicContact).toBe(false);
      const gap = result.gaps.find((g) => g.code === 'MISSING_MANUFACTURER_ELECTRONIC_CONTACT');
      expect(gap).toBeDefined();
      expect(gap?.articleCitation).toContain('Art. 9');
      expect(gap?.articleCitation).toContain('Art. 19');
    });
  });

  describe('Akzeptanzkriterium 3: Sicherheitswarnungen, Warnhinweise & CE-Konformitätskennzeichnung (Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d)', () => {
    it('validiert Vorhandensein von Sicherheitswarnungen und CE-Kennzeichnung', () => {
      const result = checkGpsrListing(compliantListing);

      expect(result.sections.safetyAndWarnings.passed).toBe(true);
      expect(result.sections.safetyAndWarnings.details.hasSafetyWarnings).toBe(true);
      expect(result.sections.safetyAndWarnings.details.hasCeMarking).toBe(true);
      expect(result.sections.safetyAndWarnings.score).toBe(20);

      const safeGaps = result.gaps.filter((g) => g.article === 'Art. 9(7)');
      expect(safeGaps).toHaveLength(0);
    });

    it('meldet fehlende Sicherheitswarnungen', () => {
      const input = {
        ...compliantListing,
        safetyInformation: {
          warnings: [],
          safetyInstructions: [],
          ceMarking: true,
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.safetyAndWarnings.passed).toBe(false);
      expect(result.sections.safetyAndWarnings.details.hasSafetyWarnings).toBe(false);

      const gap = result.gaps.find((g) => g.code === 'MISSING_SAFETY_WARNINGS');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('HIGH');
      expect(gap?.article).toBe('Art. 9(7)');
      expect(gap?.articleCitation).toContain('Art. 9 Abs. 7');
      expect(gap?.articleCitation).toContain('Art. 19 Abs. 1 lit. d');
    });

    it('meldet fehlende CE-Kennzeichnung', () => {
      const input = {
        ...compliantListing,
        safetyInformation: {
          warnings: ['Achtung vor heißen Oberflächen.'],
          ceMarking: false,
          hasCeMarking: false,
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.safetyAndWarnings.passed).toBe(false);
      expect(result.sections.safetyAndWarnings.details.hasCeMarking).toBe(false);

      const gap = result.gaps.find((g) => g.code === 'MISSING_CE_MARKING');
      expect(gap).toBeDefined();
      expect(gap?.severity).toBe('MEDIUM');
      expect(gap?.article).toBe('Art. 9(7)');
      expect(gap?.articleCitation).toContain('Art. 9 Abs. 7');
      expect(gap?.articleCitation).toContain('Art. 19 Abs. 1 lit. d');
    });

    it('erkennt CE-Kennzeichnung in Textform oder im Titel', () => {
      const input = {
        ...compliantListing,
        title: 'Kinder-Spielzeug Holzbausteine (CE-zertifiziert)',
        safetyInformation: {
          warnings: ['Nicht geeignet für Kinder unter 3 Jahren.'],
          ceMarking: undefined,
        },
      };

      const result = checkGpsrListing(input);
      expect(result.sections.safetyAndWarnings.details.hasCeMarking).toBe(true);
      expect(result.gaps.some((g) => g.code === 'MISSING_CE_MARKING')).toBe(false);
    });
  });

  describe('Akzeptanzkriterium 4: Readiness-Score (0-100%) und präzise Lücken mit Art. 9, 16, 19', () => {
    it('erzeugt Score 100% und Status COMPLIANT bei vollständigen Angaben', () => {
      const result = checkGpsrListing(compliantListing);

      expect(result.score).toBe(100);
      expect(result.status).toBe('COMPLIANT');
      expect(result.trafficLight).toBe('GREEN');
      expect(result.isCompliant).toBe(true);
      expect(result.gaps).toHaveLength(0);
      expect(result.summary.totalGapsCount).toBe(0);
    });

    it('erzeugt Score 0% und Status NON_COMPLIANT bei völlig leerem Listing', () => {
      const emptyListing: GpsrListingInput = {};

      const result = checkGpsrListing(emptyListing);

      expect(result.score).toBe(0);
      expect(result.status).toBe('NON_COMPLIANT');
      expect(result.trafficLight).toBe('RED');
      expect(result.isCompliant).toBe(false);
      expect(result.gaps.length).toBeGreaterThanOrEqual(7);

      // Verifikation: Alle erforderlichen Artikel (9, 16, 19) werden referenziert
      const articles = result.gaps.map((g) => g.articleCitation).join(' ');
      expect(articles).toContain('Art. 9');
      expect(articles).toContain('Art. 16');
      expect(articles).toContain('Art. 19');
    });

    it('berechnet differenzierte Scores und Ampel-Farben (z.B. gelb bei unvollständigen Daten)', () => {
      // Listing mit Hersteller und Identifikation, aber ohne EU-RP und ohne Warnhinweise
      const partialListing: GpsrListingInput = {
        title: 'Bluetooth Lautsprecher Box',
        manufacturer: {
          name: 'Anker Soundcore',
          address: 'Shenzhen, China',
          email: 'service@soundcore.com',
        },
        productIdentifier: {
          type: 'Portable Speaker',
          modelNumber: 'A3102',
          ean: '0848061039832',
        },
      };

      const result = checkGpsrListing(partialListing);

      // Hersteller = 30 Pkt, Identifikation = 20 Pkt -> Gesamt ca. 50 Pkt
      expect(result.score).toBe(50);
      // Wegen kritischer Lücke (fehlende EU-RP) muss die Ampel rot sein
      expect(result.summary.criticalGapsCount).toBeGreaterThan(0);
      expect(result.trafficLight).toBe('RED');
      expect(result.status).toBe('NON_COMPLIANT');
    });

    it('erzeugt präzise Lücken mit Gesetzesartikeln, Fehlerbeschreibungen und Handlungsanweisungen', () => {
      const result = checkGpsrListing({});

      for (const gap of result.gaps) {
        expect(gap.code).toBeDefined();
        expect(gap.field).toBeDefined();
        expect(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).toContain(gap.severity);
        expect(gap.articleCitation).toMatch(/GPSR Art\. (9|16|19)/);
        expect(gap.message.length).toBeGreaterThan(10);
        expect(gap.remediation.length).toBeGreaterThan(10);
      }
    });
  });

  describe('Interoperabilität mit Marketplace-Exports & Amazon-Parser (Flat Fields)', () => {
    it('unterstützt flache Amazon Seller Central / CSV-Spaltennamen', () => {
      const flatAmazonRow = {
        'seller-sku': 'SKU-AMZ-001',
        asin1: 'B07JW9H4J1',
        'item-name': 'Kinder Holz-Rassel Greifling Spielzeug',
        brand: 'Hape',
        hersteller: 'Hape International AG',
        hersteller_adresse: 'Hallwylstrasse 71, 8004 Zürich, Schweiz',
        hersteller_email: 'compliance@hape.com',
        responsible_person_name: 'Hape Deutschland GmbH',
        responsible_person_address: 'Pfadäcker 5, 35398 Gießen, Deutschland',
        responsible_person_country: 'DE',
        responsible_person_email: 'gpsr@hape-toys.de',
        item_type_keyword: 'toy-figures',
        model_number: 'E0015',
        cpsia_cautionary_statement: 'Achtung: Erstickungsgefahr. Enthält verschluckbare Kleinteile.',
        ce_marking: 'true',
      };

      const result = checkGpsrListing(flatAmazonRow);

      expect(result.sku).toBe('SKU-AMZ-001');
      expect(result.asin).toBe('B07JW9H4J1');
      expect(result.score).toBe(100);
      expect(result.status).toBe('COMPLIANT');
      expect(result.trafficLight).toBe('GREEN');
      expect(result.sections.responsiblePerson.passed).toBe(true);
      expect(result.sections.manufacturer.passed).toBe(true);
      expect(result.sections.safetyAndWarnings.passed).toBe(true);
    });

    it('führt Batch-Prüfungen mit Aggregation durch (checkGpsrListings)', () => {
      const batchListings = [
        compliantListing,
        {
          id: 'BAD-1',
          title: 'Unbekanntes Gadget ohne Angaben',
        },
        {
          id: 'PARTIAL-1',
          title: 'Markenartikel ohne EU-RP',
          manufacturer: compliantListing.manufacturer,
          productIdentifier: compliantListing.productIdentifier,
        },
      ];

      const batch = checkGpsrListings(batchListings);

      expect(batch.totalListings).toBe(3);
      expect(batch.compliantCount).toBe(1);
      expect(batch.nonCompliantCount).toBe(2);
      expect(batch.trafficLights.green).toBe(1);
      expect(batch.averageScore).toBeGreaterThan(0);
      expect(batch.results).toHaveLength(3);
      expect(Object.keys(batch.gapFrequency).length).toBeGreaterThan(0);
      expect(batch.gapFrequency['MISSING_RESPONSIBLE_PERSON_NAME']).toBeDefined();
    });
  });

  describe('Hilfsfunktionen (EU Location, E-Mail, URLs, CE-Erkennung)', () => {
    it('erkennt EU-Länder über ISO-Codes und Ländernamen', () => {
      expect(isEuLocation('DE')).toBe(true);
      expect(isEuLocation('FR')).toBe(true);
      expect(isEuLocation('Niederlande')).toBe(true);
      expect(isEuLocation('Austria')).toBe(true);
      expect(isEuLocation('Musterstraße 12, 10115 Berlin, Deutschland')).toBe(true);
      expect(isEuLocation('Taurusavenue 16, 2132 LS Hoofddorp, NL')).toBe(true);

      expect(isEuLocation('US')).toBe(false);
      expect(isEuLocation('United States')).toBe(false);
      expect(isEuLocation('China')).toBe(false);
      expect(isEuLocation('United Kingdom')).toBe(false);
      expect(isEuLocation('')).toBe(false);
      expect(isEuLocation(null)).toBe(false);
    });

    it('validiert E-Mails und Kontakt-URLs zuverlässig', () => {
      expect(isValidEmail('compliance@example.eu')).toBe(true);
      expect(isValidEmail('test.support+gpsr@company.co.uk')).toBe(true);
      expect(isValidEmail('invalid-email')).toBe(false);
      expect(isValidEmail('')).toBe(false);

      expect(isValidContactUrl('https://example.com/contact')).toBe(true);
      expect(isValidContactUrl('http://support.brand.de')).toBe(true);
      expect(isValidContactUrl('www.company.eu/form')).toBe(true);
      expect(isValidContactUrl('not-a-url')).toBe(false);

      const contactResult = validateElectronicContact('mailto:safety@domain.de');
      expect(contactResult.isValid).toBe(true);
      expect(contactResult.isEmail).toBe(true);
    });

    it('erkennt CE-Kennzeichnungen und Indikatoren', () => {
      expect(hasCeMarkingIndicator(true)).toBe(true);
      expect(hasCeMarkingIndicator('true')).toBe(true);
      expect(hasCeMarkingIndicator('CE')).toBe(true);
      expect(hasCeMarkingIndicator('CE-Kennzeichnung')).toBe(true);
      expect(hasCeMarkingIndicator('CE certified')).toBe(true);
      expect(hasCeMarkingIndicator(false)).toBe(false);
      expect(hasCeMarkingIndicator('false')).toBe(false);
      expect(hasCeMarkingIndicator('none')).toBe(false);
    });
  });
});
