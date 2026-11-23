import { describe, it, expect } from 'vitest';
import {
  matchProductToAlert,
  findMatchesForProduct,
  calculateBrandSimilarity,
  calculateModelSimilarity,
  calculateCategorySimilarity,
  calculateConfidenceScore,
  classifyScore,
  normalizeBrand,
  extractModelNumbers,
  AdvancedFuzzyMatcher,
  DEFAULT_MATCH_WEIGHTS,
} from '../src/index.js';

describe('F02: Advanced Fuzzy Matching Engine mit Konfidenz-Scoring', () => {
  describe('Akzeptanzkriterium 1: Gewichteter Konfidenz-Score (Marke, Modell, Kategorie)', () => {
    it('berechnet den Score exakt basierend auf den Standardgewichten 0.35, 0.45, 0.20', () => {
      expect(DEFAULT_MATCH_WEIGHTS.brand).toBe(0.35);
      expect(DEFAULT_MATCH_WEIGHTS.model).toBe(0.45);
      expect(DEFAULT_MATCH_WEIGHTS.category).toBe(0.20);

      const score = calculateConfidenceScore(1.0, 1.0, 1.0);
      expect(score).toBe(1.0);

      // 0.35 * 1.0 + 0.45 * 0.0 + 0.20 * 0.0 = 0.35
      const brandOnly = calculateConfidenceScore(1.0, 0.0, 0.0);
      expect(brandOnly).toBe(0.35);

      // 0.35 * 0.0 + 0.45 * 1.0 + 0.20 * 0.0 = 0.45
      const modelOnly = calculateConfidenceScore(0.0, 1.0, 0.0);
      expect(modelOnly).toBe(0.45);

      // 0.35 * 0.0 + 0.45 * 0.0 + 0.20 * 1.0 = 0.20
      const categoryOnly = calculateConfidenceScore(0.0, 0.0, 1.0);
      expect(categoryOnly).toBe(0.20);
    });

    it('unterstützt benutzerdefinierte Gewichtungen', () => {
      const customWeights = { brand: 0.5, model: 0.3, category: 0.2 };
      const score = calculateConfidenceScore(1.0, 0.5, 0.5, customWeights);
      // 0.5 * 1.0 + 0.3 * 0.5 + 0.2 * 0.5 = 0.5 + 0.15 + 0.10 = 0.75
      expect(score).toBe(0.75);
    });

    it('begrenzt den Score zuverlässig im Intervall [0.00, 1.00]', () => {
      expect(calculateConfidenceScore(-1, -1, -1)).toBe(0.0);
      expect(calculateConfidenceScore(2, 2, 2)).toBe(1.0);
    });
  });

  describe('Akzeptanzkriterium 2: Brand Recognition (Gross-/Kleinschreibung & Schreibvarianten)', () => {
    it('erkennt exakte Markennamen unabhängig von Gross-/Kleinschreibung', () => {
      expect(calculateBrandSimilarity('Apple', 'apple')).toBe(1.0);
      expect(calculateBrandSimilarity('SONY', 'sony')).toBe(1.0);
      expect(calculateBrandSimilarity('SAMSUNG', 'Samsung')).toBe(1.0);
    });

    it('bereinigt Rechtsformen und Unternehmensanhänge zuverlässig', () => {
      expect(normalizeBrand('Samsung Electronics GmbH')).toBe('samsung electronics');
      expect(normalizeBrand('Apple Inc.')).toBe('apple');
      expect(normalizeBrand('Dyson Ltd.')).toBe('dyson');
      expect(normalizeBrand('Siemens AG')).toBe('siemens');
      expect(normalizeBrand('Philips Deutschland GmbH & Co. KG')).toBe('philips deutschland');

      expect(calculateBrandSimilarity('Apple Inc.', 'Apple')).toBeGreaterThanOrEqual(0.95);
      expect(calculateBrandSimilarity('Dyson Ltd', 'Dyson')).toBeGreaterThanOrEqual(0.95);
      expect(calculateBrandSimilarity('Siemens AG', 'Siemens')).toBeGreaterThanOrEqual(0.95);
    });

    it('gleicht Akzente und Sonderzeichen fehlerresistent ab', () => {
      // L'Oréal vs Loreal
      expect(calculateBrandSimilarity("L'Oréal", 'Loreal')).toBe(1.0);
      // Nestlé vs Nestle
      expect(calculateBrandSimilarity('Nestlé', 'Nestle')).toBe(1.0);
      // Müller vs Muller
      expect(calculateBrandSimilarity('Müller', 'Muller')).toBe(1.0);
    });

    it('erkennt Tippfehler via Levenshtein-Fuzzy-Matching', () => {
      // 1 Buchstabe Unterschied bei 7 Buchstaben -> Similarity >= 0.85
      const typoSim = calculateBrandSimilarity('Philps', 'Philips');
      expect(typoSim).toBeGreaterThanOrEqual(0.85);

      const sonnySim = calculateBrandSimilarity('Sonny', 'Sony');
      expect(sonnySim).toBeGreaterThanOrEqual(0.80);
    });

    it('erkennt Substring- und Teilmarken-Übereinstimmungen', () => {
      const sim = calculateBrandSimilarity('Samsung Electronics', 'Samsung');
      expect(sim).toBeGreaterThanOrEqual(0.90);
    });

    it('gibt 0.0 zurück wenn eine Marke fehlt', () => {
      expect(calculateBrandSimilarity('', 'Apple')).toBe(0.0);
      expect(calculateBrandSimilarity(undefined, 'Apple')).toBe(0.0);
      expect(calculateBrandSimilarity(undefined, undefined)).toBe(0.0);
    });
  });

  describe('Modell-Erkennung & Token-Matching', () => {
    it('extrahiert Modellnummern und Codes zuverlässig', () => {
      const numbers = extractModelNumbers('Dyson V8 Absolute Cordless Vacuum Model XY-500');
      expect(numbers).toContain('V8');
      expect(numbers).toContain('XY-500');

      const sonyCodes = extractModelNumbers('Sony WH-1000XM4 Noise Cancelling');
      expect(sonyCodes).toContain('WH-1000XM4');
    });

    it('vergibt Höchstbewertung (>= 0.95) bei übereinstimmendem Modellcode', () => {
      const res = calculateModelSimilarity('XY-500', 'XY500', 'Vacuum', 'Cordless Vacuum XY-500');
      expect(res.modelNumberMatched).toBe(true);
      expect(res.score).toBeGreaterThanOrEqual(0.95);
    });

    it('gleicht Modellnamen anhand von Token-Overlap ab', () => {
      const res = calculateModelSimilarity(
        'Airfryer Essential Compact',
        'Airfryer Essential XL',
        undefined,
        undefined
      );
      expect(res.score).toBeGreaterThanOrEqual(0.5);
    });
  });

  describe('Kategorie-Filter & Kompatibilität', () => {
    it('bewertet identische oder synonyme Kategorien mit 1.0', () => {
      expect(calculateCategorySimilarity('Toys', 'Toys')).toBe(1.0);
      // Translation German <-> English
      expect(calculateCategorySimilarity('Spielzeug', 'Toys')).toBe(1.0);
      expect(calculateCategorySimilarity('Elektronik', 'Electrical appliances and equipment')).toBe(1.0);
      expect(calculateCategorySimilarity('Kosmetik', 'Cosmetics')).toBe(1.0);
    });

    it('bewertet unpassende / inkompatible Kategorien mit 0.0', () => {
      expect(calculateCategorySimilarity('Toys', 'Motor vehicles')).toBe(0.0);
      expect(calculateCategorySimilarity('Cosmetics', 'Machinery')).toBe(0.0);
    });

    it('liefert neutralen Score 0.5 bei fehlenden Kategorien', () => {
      expect(calculateCategorySimilarity(undefined, 'Toys')).toBe(0.5);
      expect(calculateCategorySimilarity('Toys', undefined)).toBe(0.5);
      expect(calculateCategorySimilarity(undefined, undefined)).toBe(0.5);
    });
  });

  describe('Akzeptanzkriterium 3: Ampel-Klassifikation (Rot, Gelb, Gruen)', () => {
    it('klassifiziert Scores >= 0.85 als Rot', () => {
      expect(classifyScore(0.85)).toBe('Rot');
      expect(classifyScore(0.92)).toBe('Rot');
      expect(classifyScore(1.0)).toBe('Rot');
    });

    it('klassifiziert Scores von 0.65 bis < 0.85 als Gelb', () => {
      expect(classifyScore(0.65)).toBe('Gelb');
      expect(classifyScore(0.75)).toBe('Gelb');
      expect(classifyScore(0.8499)).toBe('Gelb');
    });

    it('klassifiziert Scores < 0.65 als Gruen', () => {
      expect(classifyScore(0.6499)).toBe('Gruen');
      expect(classifyScore(0.50)).toBe('Gruen');
      expect(classifyScore(0.0)).toBe('Gruen');
    });
  });

  describe('Akzeptanzkriterium 4: Detaillierte Treffer-Gründe (matched_fields, match_reason)', () => {
    it('liefert vollständige Match-Informationen für B2B-Reports bei Volltreffer (Rot)', () => {
      const product = {
        brand: 'Philips GmbH',
        model: 'HD9252/90 Airfryer',
        category: 'Electrical appliances and equipment',
      };

      const alert = {
        alert_number: 'A12/00123/24',
        brand: 'Philips',
        model: 'HD9252 Airfryer',
        product: 'Air fryer',
        category: 'Electrical appliances',
      };

      const result = matchProductToAlert(product, alert);

      expect(result.score).toBeGreaterThanOrEqual(0.85);
      expect(result.classification).toBe('Rot');
      expect(result.severity).toBe('RED');
      expect(result.matched).toBe(true);
      expect(result.matched_fields).toContain('brand');
      expect(result.matched_fields).toContain('model');
      expect(result.matched_fields).toContain('category');

      expect(result.match_reason).toContain('Akuter Safety-Gate-Verdacht');
      expect(result.match_reason).toContain('Marke');
      expect(result.match_reason).toContain('Modell');

      expect(result.breakdown.brand_score).toBe(1.0);
      expect(result.breakdown.model_number_matched).toBe(true);
      expect(result.breakdown.category_score).toBe(1.0);
    });

    it('liefert strukturierte Treffer-Gründe bei potenziellem Prüffall (Gelb)', () => {
      const product = {
        brand: 'Philps', // Typo
        model: 'Airfryer Compact',
        category: 'Electrical appliances',
      };

      const alert = {
        alert_number: 'A12/00456/24',
        brand: 'Philips',
        model: 'Airfryer Essential',
        category: 'Electrical appliances',
      };

      const result = matchProductToAlert(product, alert);

      expect(result.score).toBeGreaterThanOrEqual(0.65);
      expect(result.score).toBeLessThan(0.85);
      expect(result.classification).toBe('Gelb');
      expect(result.severity).toBe('YELLOW');
      expect(result.matched).toBe(true);
      expect(result.match_reason).toContain('Potenzieller Übereinstimmungs-Prüffall');
    });

    it('klassifiziert Nicht-Treffer als Gruen mit detaillierter Begründung', () => {
      const product = {
        brand: 'Samsung',
        model: 'Galaxy S24',
        category: 'Electrical appliances',
      };

      const alert = {
        alert_number: 'A12/00789/24',
        brand: 'Mattel',
        model: 'Barbie Dreamhouse',
        category: 'Toys',
      };

      const result = matchProductToAlert(product, alert);

      expect(result.score).toBeLessThan(0.65);
      expect(result.classification).toBe('Gruen');
      expect(result.severity).toBe('GREEN');
      expect(result.matched).toBe(false);
      expect(result.match_reason).toContain('Keine signifikante Übereinstimmung');
    });
  });

  describe('findMatchesForProduct & AdvancedFuzzyMatcher', () => {
    const alerts = [
      {
        alert_number: 'A12/001/24',
        brand: 'Dyson Ltd',
        model: 'V8 Absolute',
        category: 'Electrical appliances and equipment',
      },
      {
        alert_number: 'A12/002/24',
        brand: 'Apple Inc',
        model: 'A2338 MacBook Pro',
        category: 'Electrical appliances and equipment',
      },
      {
        alert_number: 'A12/003/24',
        brand: 'Lego',
        model: 'Star Wars Set 75192',
        category: 'Toys',
      },
    ];

    it('findet und sortiert passende Treffer absteigend nach Konfidenz-Score', () => {
      const product = {
        brand: 'Dyson',
        model: 'V8',
        name: 'Dyson Cordless Vacuum Cleaner V8',
        category: 'Elektronik',
      };

      const matches = findMatchesForProduct(product, alerts);
      expect(matches.length).toBeGreaterThan(0);
      expect(matches[0].alert?.brand).toBe('Dyson Ltd');
      expect(matches[0].score).toBeGreaterThanOrEqual(0.85);
      expect(matches[0].classification).toBe('Rot');
    });

    it('filtert mit minScore Parameter', () => {
      const product = {
        brand: 'Dyson',
        model: 'V8',
        category: 'Elektronik',
      };

      const highMatches = findMatchesForProduct(product, alerts, { minScore: 0.85 });
      expect(highMatches.every((m) => m.score >= 0.85)).toBe(true);
    });

    it('AdvancedFuzzyMatcher Batch-Matching ordnet Produkte korrekt zu', () => {
      const matcher = new AdvancedFuzzyMatcher();
      const products = [
        { brand: 'Apple', model: 'A2338', category: 'Elektronik' },
        { brand: 'Lego', model: '75192', category: 'Spielzeug' },
      ];

      const batchResult = matcher.matchBatch(products, alerts);
      expect(batchResult.size).toBe(2);

      const appleMatches = batchResult.get(products[0]);
      expect(appleMatches).toBeDefined();
      expect(appleMatches![0].classification).toBe('Rot');
      expect(appleMatches![0].alert?.brand).toBe('Apple Inc');
    });
  });
});
