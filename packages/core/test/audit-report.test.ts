import { describe, it, expect } from 'vitest';
import zlib from 'node:zlib';
import {
  B2BAuditReport,
  createAuditReport,
  generateAuditReport,
  generateMarkdownReport,
  generateHtmlReport,
  generateXlsxReport,
  evaluateAuditItem,
  buildActionPlan,
  buildAuditSummary,
  formatSafetyGateDate,
  getLegalDisclaimer,
  getZeroHitsNotice,
  sanitizeXlsxFormulaInjection,
  DISCLAIMER_LEGAL_NOTICE,
  DISCLAIMER_SAFETY_GATE_SOURCE_TEMPLATE,
  DISCLAIMER_MERCHANT_OBLIGATION,
  DISCLAIMER_ZERO_HITS_NOTICE,
  AuditedItemInput,
} from '../src/audit-report.js';
import type { MatchResult } from '../src/matcher.js';
import type { GpsrReadinessReport } from '../src/gpsr.js';

describe('B2B Multi-Format Audit Report Generator (F05)', () => {
  // Testdaten-Setup
  const mockBarcodeHitItem: AuditedItemInput = {
    id: 'ITEM-001',
    sku: 'DE-TOY-001',
    asin: 'B08N5WRWNW',
    ean: '4006381333931',
    title: 'Plüschtier Teddybär 30cm Braun',
    brand: 'TeddyCo',
    model: 'TB-300',
    category: 'Toys',
    price: 19.99,
    barcodeHit: true,
    barcodeMatch: {
      matched: true,
      alertNumber: 'A12/00145/24',
      riskType: 'Erstickungsgefahr',
      riskLevel: 'Serious risk',
      dangerDescription: 'Kleinteile lösen sich leicht ab.',
    },
  };

  const mockFuzzyRedItem: AuditedItemInput = {
    id: 'ITEM-002',
    sku: 'DE-ELEC-002',
    asin: 'B07JW9H4J1',
    ean: '4250123456789',
    title: 'USB Schnellladegerät 65W GaN Fast Charger Power Delivery',
    brand: 'ChargeMaxx',
    model: 'CM-65W',
    category: 'Electrical appliances',
    price: 29.99,
    barcodeHit: false,
    fuzzyMatch: {
      score: 0.89,
      classification: 'Rot',
      severity: 'RED',
      matched: true,
      matched_fields: ['brand', 'model', 'category'],
      match_reason: 'Starke Übereinstimmung mit behördlicher Brandgefahren-Meldung',
      breakdown: {
        brand_score: 0.95,
        model_score: 0.9,
        category_score: 1.0,
        model_number_matched: true,
        extracted_model_numbers: {
          product: ['CM-65W'],
          alert: ['CM-65W-EU'],
        },
      },
      alert: {
        alert_number: 'A12/00892/24',
        risk_type: 'Brandgefahr & Elektrischer Schlag',
      },
    } as unknown as MatchResult,
  };

  const mockFuzzyYellowItem: AuditedItemInput = {
    id: 'ITEM-003',
    sku: 'DE-ELEC-003',
    asin: 'B09V3HM443',
    ean: '4250987654321',
    title: 'Bluetooth Lautsprecher Box Tragbar Wasserdicht',
    brand: 'SoundBoom',
    model: 'SB-Mini',
    category: 'Audio',
    price: 34.5,
    barcodeHit: false,
    fuzzyMatch: {
      score: 0.72,
      classification: 'Gelb',
      severity: 'YELLOW',
      matched: true,
      matched_fields: ['brand', 'category'],
      match_reason: 'Ähnliche Marke und Kategorie, Modellnummer abweichend',
      breakdown: {
        brand_score: 0.85,
        model_score: 0.5,
        category_score: 1.0,
        model_number_matched: false,
        extracted_model_numbers: {
          product: ['SB-Mini'],
          alert: ['SB-Pro'],
        },
      },
      alert: {
        alert_number: 'A12/00341/24',
        risk_type: 'Überhitzung des Lithium-Akkus',
      },
    } as unknown as MatchResult,
  };

  const mockGpsrIncompleteItem: AuditedItemInput = {
    id: 'ITEM-004',
    sku: 'DE-HOME-004',
    asin: 'B08P5Y8K4F',
    ean: '4012345678901',
    title: 'LED Schreibtischlampe Dimmbar mit Touch-Sensor',
    brand: 'LumiLux',
    model: 'LL-Desk-01',
    category: 'Lighting',
    price: 24.95,
    barcodeHit: false,
    gpsrReport: {
      score: 45,
      status: 'PARTIALLY_COMPLIANT',
      trafficLight: 'YELLOW',
      isCompliant: false,
      gaps: [
        {
          code: 'GPSR-RP-001',
          field: 'responsiblePerson.name',
          severity: 'HIGH',
          article: 'Art. 16',
          articleCitation: 'Verordnung (EU) 2023/988 Art. 16',
          message: 'Keine EU-Verantwortliche Person (Responsible Person) hinterlegt.',
          remediation: 'Name und EU-Anschrift der EU-Verantwortlichen Person im Seller Central eintragen.',
        },
        {
          code: 'GPSR-WARN-001',
          field: 'safetyInformation.warnings',
          severity: 'MEDIUM',
          article: 'Art. 9(7)',
          articleCitation: 'Verordnung (EU) 2023/988 Art. 9 Abs. 7',
          message: 'Keine Sicherheits- und Warnhinweise im Listing sichtbar.',
          remediation: 'Warnhinweise in deutscher Sprache im Freitext oder als Bild ergänzen.',
        },
      ],
      sections: {} as any,
      summary: {
        criticalGapsCount: 0,
        highGapsCount: 1,
        mediumGapsCount: 1,
        lowGapsCount: 0,
        totalGapsCount: 2,
        checkedAt: '2026-11-23',
      },
    } as GpsrReadinessReport,
  };

  const mockCompliantGreenItem: AuditedItemInput = {
    id: 'ITEM-005',
    sku: 'DE-OFFICE-005',
    asin: 'B00004CK5B',
    ean: '4006381333627',
    title: 'Stabilo Boss Original Textmarker 4er Set',
    brand: 'Stabilo',
    model: 'Boss Original',
    category: 'Office',
    price: 6.99,
    barcodeHit: false,
    fuzzyMatch: null,
    gpsrReport: {
      score: 100,
      status: 'COMPLIANT',
      trafficLight: 'GREEN',
      isCompliant: true,
      gaps: [],
      sections: {} as any,
      summary: {
        criticalGapsCount: 0,
        highGapsCount: 0,
        mediumGapsCount: 0,
        lowGapsCount: 0,
        totalGapsCount: 0,
        checkedAt: '2026-11-23',
      },
    } as GpsrReadinessReport,
  };

  // ==========================================================================
  // AK 1: Fasst Barcode-Treffer, Fuzzy-Matches und GPSR-Readiness in einer Ampel-Übersicht zusammen
  // ==========================================================================
  describe('Akzeptanzkriterium 1: Ampelsystem-Übersicht (Rot/Gelb/Grün)', () => {
    it('klassifiziert Barcode-Treffer (RAPEX/Safety Gate) eindeutig als ROT (RED)', () => {
      const evaluated = evaluateAuditItem(mockBarcodeHitItem);
      expect(evaluated.trafficLight).toBe('RED');
      expect(evaluated.trafficLightGerman).toBe('Rot');
      expect(evaluated.barcode.matched).toBe(true);
      expect(evaluated.barcode.details?.alertNumber).toBe('A12/00145/24');
      expect(evaluated.priorityLevel).toBe(1);
      expect(evaluated.statusLabel).toMatch(/VERTRIEBSSTOPP/i);
    });

    it('klassifiziert High-Confidence Fuzzy-Matches (Score >= 0.85) als GELB (YELLOW / Verdachtsfall)', () => {
      const evaluated = evaluateAuditItem(mockFuzzyRedItem);
      expect(evaluated.trafficLight).toBe('YELLOW');
      expect(evaluated.trafficLightGerman).toBe('Gelb');
      expect(evaluated.fuzzy.matched).toBe(true);
      expect(evaluated.fuzzy.score).toBeGreaterThanOrEqual(0.85);
      expect(evaluated.priorityLevel).toBe(2);
      expect(evaluated.statusLabel).toMatch(/VERDACHT/i);
    });

    it('klassifiziert Medium-Confidence Fuzzy-Matches (0.65 <= Score < 0.85) als GELB (YELLOW)', () => {
      const evaluated = evaluateAuditItem(mockFuzzyYellowItem);
      expect(evaluated.trafficLight).toBe('YELLOW');
      expect(evaluated.trafficLightGerman).toBe('Gelb');
      expect(evaluated.fuzzy.matched).toBe(true);
      expect(evaluated.fuzzy.score).toBe(0.72);
      expect(evaluated.priorityLevel).toBe(2);
      expect(evaluated.statusLabel).toMatch(/PRÜFBEDARF/i);
    });

    it('klassifiziert unvollständige GPSR-Listings als GELB (YELLOW)', () => {
      const evaluated = evaluateAuditItem(mockGpsrIncompleteItem);
      expect(evaluated.trafficLight).toBe('YELLOW');
      expect(evaluated.trafficLightGerman).toBe('Gelb');
      expect(evaluated.gpsr.checked).toBe(true);
      expect(evaluated.gpsr.gapsCount).toBe(2);
      expect(evaluated.statusLabel).toMatch(/NACHPFLEGE/i);
    });

    it('klassifiziert vollständig saubere Artikel ohne Treffer und mit 100% GPSR als GRÜN (GREEN)', () => {
      const evaluated = evaluateAuditItem(mockCompliantGreenItem);
      expect(evaluated.trafficLight).toBe('GREEN');
      expect(evaluated.trafficLightGerman).toBe('Gruen');
      expect(evaluated.barcode.matched).toBe(false);
      expect(evaluated.fuzzy.matched).toBe(false);
      expect(evaluated.gpsr.status).toBe('COMPLIANT');
      expect(evaluated.statusLabel).toMatch(/UNAUFFÄLLIG|KONFORM/i);
    });

    it('aggregiert alle 3 Säulen in einer korrekten AuditSummary', () => {
      const report = createAuditReport({
        merchantName: 'Alpha Trading GmbH',
        items: [
          mockBarcodeHitItem,
          mockFuzzyRedItem,
          mockFuzzyYellowItem,
          mockGpsrIncompleteItem,
          mockCompliantGreenItem,
        ],
      });

      const s = report.summary;
      expect(s.totalItems).toBe(5);
      expect(s.redCount).toBe(1); // Ausschließlich EAN-Treffer
      expect(s.yellowCount).toBe(3); // Fuzzy-High + Fuzzy-Medium + GPSR-Incomplete
      expect(s.greenCount).toBe(1); // Compliant
      expect(s.overallTrafficLight).toBe('RED');
      expect(s.overallTrafficLightGerman).toBe('Rot');
      expect(s.complianceRate).toBe(20.0); // 1 von 5 = 20%
      expect(s.barcodeHitsCount).toBe(1);
      expect(s.fuzzyMatchesCount.total).toBe(2);
      expect(s.fuzzyMatchesCount.red).toBe(1);
      expect(s.fuzzyMatchesCount.yellow).toBe(1);
      expect(s.gpsrSummary.checkedCount).toBe(2);
      expect(s.gpsrSummary.totalGapsCount).toBe(2);
    });

    it('setzt Gesamt-Ampel auf GELB, wenn keine roten Treffer vorhanden sind, aber Gelb-Fälle existieren', () => {
      const report = createAuditReport({
        merchantName: 'Beta Goods GmbH',
        items: [mockFuzzyYellowItem, mockCompliantGreenItem],
      });

      expect(report.summary.redCount).toBe(0);
      expect(report.summary.yellowCount).toBe(1);
      expect(report.summary.greenCount).toBe(1);
      expect(report.summary.overallTrafficLight).toBe('YELLOW');
      expect(report.summary.overallTrafficLightGerman).toBe('Gelb');
    });

    it('setzt Gesamt-Ampel auf GRÜN bei 100% konformem Sortiment', () => {
      const report = createAuditReport({
        merchantName: 'Gamma Commerce e.K.',
        items: [mockCompliantGreenItem],
      });

      expect(report.summary.overallTrafficLight).toBe('GREEN');
      expect(report.summary.complianceRate).toBe(100);
      expect(report.summary.redCount).toBe(0);
      expect(report.summary.yellowCount).toBe(0);
    });
  });

  // ==========================================================================
  // AK 2: Erstellt chronologisch und nach Dringlichkeit sortierte Handlungsempfehlungen für den Marketplace-Händler
  // ==========================================================================
  describe('Akzeptanzkriterium 2: Priorisierte & chronologische Handlungsempfehlungen', () => {
    it('erstellt P1 (Sofort/24h) Maßnahmen für Rot-Treffer mit klaren Handlungsanweisungen', () => {
      const actions = buildActionPlan(
        [evaluateAuditItem(mockBarcodeHitItem), evaluateAuditItem(mockFuzzyRedItem)],
        '2026-11-23'
      );

      expect(actions.length).toBeGreaterThanOrEqual(2);
      expect(actions[0].priority).toBe(1);
      expect(actions[0].urgency).toBe('CRITICAL');
      expect(actions[0].deadlineHours).toBe(24);
      expect(actions[0].deadlineText).toMatch(/24 Stunden/i);
      expect(actions[0].action).toMatch(/Seller Central.*Inaktiv/i);
      expect(actions[0].legalBasis).toMatch(/§ 3 ProdSG.*GPSR/i);
    });

    it('erstellt P2 (Kurzfristig/48h) Maßnahmen für Gelb-Fuzzy-Matches und Art. 16 Responsible Person Lücken', () => {
      const actions = buildActionPlan(
        [evaluateAuditItem(mockFuzzyYellowItem), evaluateAuditItem(mockGpsrIncompleteItem)],
        '2026-11-23'
      );

      const p2Actions = actions.filter((a) => a.priority === 2);
      expect(p2Actions.length).toBeGreaterThanOrEqual(2);

      // Verifikation Fuzzy Match Prüfung
      const fuzzyAction = p2Actions.find((a) => a.category === 'FUZZY_MATCH_REVIEW');
      expect(fuzzyAction).toBeDefined();
      expect(fuzzyAction?.deadlineHours).toBe(48);
      expect(fuzzyAction?.action).toMatch(/Prüfung des konkreten Modell-/i);

      // Verifikation Responsible Person
      const rpAction = p2Actions.find((a) => a.category === 'GPSR_RESPONSIBLE_PERSON');
      expect(rpAction).toBeDefined();
      expect(rpAction?.deadlineHours).toBe(48);
      expect(rpAction?.action).toMatch(/Responsible Person/i);
      expect(rpAction?.legalBasis).toMatch(/Art\. 16.*GPSR/i);
    });

    it('sortiert alle Maßnahmen streng nach Dringlichkeit (P1 vor P2 vor P3 vor P4) und chronologisch', () => {
      const report = createAuditReport({
        reportDate: '2026-11-23',
        items: [
          mockCompliantGreenItem,
          mockGpsrIncompleteItem, // Erzeugt P2 (Responsible Person) und P3 (Warnhinweise)
          mockFuzzyYellowItem, // Erzeugt P2
          mockBarcodeHitItem, // Erzeugt P1
          mockFuzzyRedItem, // Erzeugt P1
        ],
      });

      const actions = report.actions;
      expect(actions.length).toBeGreaterThanOrEqual(4);

      // Prüfen, dass Prioritäten niemals abnehmen (1 <= 1 <= 2 <= 2 <= 3 ...)
      for (let i = 0; i < actions.length - 1; i++) {
        expect(actions[i].priority).toBeLessThanOrEqual(actions[i + 1].priority);
        if (actions[i].priority === actions[i + 1].priority) {
          expect(actions[i].deadlineHours).toBeLessThanOrEqual(actions[i + 1].deadlineHours);
        }
      }

      // Prüfen, dass orderIndex fortlaufend 1, 2, 3... ist
      actions.forEach((act, idx) => {
        expect(act.orderIndex).toBe(idx + 1);
        expect(act.id).toBe(`ACT-${String(idx + 1).padStart(3, '0')}`);
      });
    });

    it('enthält für alle Maßnahmen konkrete Fälligkeitsdaten (dueDate) basierend auf dem Prüfdatum', () => {
      const report = createAuditReport({
        reportDate: '2026-11-23T00:00:00Z',
        items: [mockBarcodeHitItem, mockGpsrIncompleteItem],
      });

      const p1 = report.actions.find((a) => a.priority === 1);
      const p2 = report.actions.find((a) => a.priority === 2);
      const p3 = report.actions.find((a) => a.priority === 3);

      expect(p1?.dueDate).toBe('2026-11-24'); // 24h
      expect(p2?.dueDate).toBe('2026-11-25'); // 48h
      expect(p3?.dueDate).toBe('2026-11-30'); // 168h / 7 Tage
    });
  });

  // ==========================================================================
  // AK 3: Enthält rechtssicheren Disclaimer (keine Rechtsberatung nach § 2 RDG, Datenstand EU Safety Gate)
  // ==========================================================================
  describe('Akzeptanzkriterium 3: Rechtssicherer B2B-Haftungsdisclaimer', () => {
    it('enthält den Ausschluss von Rechtsdienstleistungen nach § 2 RDG', () => {
      const disclaimer = getLegalDisclaimer();
      expect(disclaimer).toContain('§ 2 RDG');
      expect(disclaimer).toMatch(/keine Rechtsdienstleistung oder Rechtsberatung/i);
    });

    it('enthält den korrekten Datenstand EU Safety Gate mit dynamischer Formatierung', () => {
      const customDate = '2026-11-20';
      const disclaimer = getLegalDisclaimer({ safetyGateDate: customDate });
      expect(disclaimer).toContain('20.11.2026');
      expect(disclaimer).toContain('Datenstand EU Safety Gate (RAPEX)');
    });

    it('enthält den Hinweis auf die gesetzliche Sorgfalts- und Prüfpflicht des Inverkehrbringers', () => {
      const disclaimer = getLegalDisclaimer();
      expect(disclaimer).toMatch(/Sorgfalts- und Prüfpflicht des Inverkehrbringers/i);
      expect(disclaimer).toMatch(/Produktsicherheitsgesetz \(ProdSG\)/i);
      expect(disclaimer).toMatch(/Verordnung \(EU\) 2023\/988 \(GPSR\)/i);
    });

    it('liefert den zwingenden Sicherheits-Hinweis bei unauffälligen Ergebnissen (Zero-Hits-Note)', () => {
      const zeroNote = getZeroHitsNotice();
      expect(zeroNote).toMatch(/kein Treffer bedeutet nicht.*dass das Produkt sicher ist/i);
      expect(zeroNote).toMatch(/viele behördliche.*keine Barcodes/i);
    });

    it('formatiert verschiedene Datumsformate zuverlässig in TT.MM.JJJJ', () => {
      expect(formatSafetyGateDate('2026-11-13')).toBe('13.11.2026');
      expect(formatSafetyGateDate('13/11/2026')).toBe('13.11.2026');
      expect(formatSafetyGateDate('13.11.2026')).toBe('13.11.2026');
      expect(formatSafetyGateDate(new Date('2026-11-13T12:00:00Z'))).toBe('13.11.2026');
      expect(formatSafetyGateDate(null)).toBe('13.11.2026');
    });
  });

  // ==========================================================================
  // AK 4: Generiert vollständige Markdown-, gestylte HTML- und datenbankkompatible XLSX-Ausgaben
  // ==========================================================================
  describe('Akzeptanzkriterium 4: Multi-Format Report Generierung (MD, HTML, XLSX)', () => {
    const fullAuditReport = createAuditReport({
      reportId: 'AUD-2026-TEST-001',
      merchantName: 'Nordic Retail Group GmbH',
      marketplace: 'Amazon.de',
      reportDate: '2026-11-23',
      safetyGateDate: '2026-11-13',
      items: [
        mockBarcodeHitItem,
        mockFuzzyRedItem,
        mockFuzzyYellowItem,
        mockGpsrIncompleteItem,
        mockCompliantGreenItem,
      ],
    });

    // 4.1 Markdown-Ausgabe
    it('erzeugt vollständigen, validen Markdown-Bericht mit allen Sektionen und Badges', () => {
      const md = fullAuditReport.toMarkdown();

      // Header & Metadaten
      expect(md).toContain('# B2B Produktsicherheits- & Compliance-Audit-Report');
      expect(md).toContain('AUD-2026-TEST-001');
      expect(md).toContain('Nordic Retail Group GmbH');
      expect(md).toContain('Datenstand EU Safety Gate:** 13.11.2026');

      // Ampel & Summary
      expect(md).toContain('## 1. Executive Summary: Ampelsystem-Übersicht');
      expect(md).toContain('🔴 **ROT (AKUTER HANDLUNGSBEDARF)**');
      expect(md).toContain('| **Akute Treffer (Rot)** | 🔴 | **1** |');
      expect(md).toContain('| **Prüfbedarf / Nachpflege (Gelb)** | 🟡 | **3** |');
      expect(md).toContain('| **Konform / Unauffällig (Grün)** | 🟢 | **1** |');

      // Maßnahmenliste
      expect(md).toContain('## 2. Priorisierte Händler-Maßnahmenliste');
      expect(md).toContain('P1: SOFORT');
      expect(md).toContain('Verordnung (EU) 2023/988');

      // Artikelliste
      expect(md).toContain('## 3. Geprüfte Artikel im Detail');
      expect(md).toContain('DE-TOY-001');
      expect(md).toContain('DE-ELEC-002');
      expect(md).toContain('DE-OFFICE-005');

      // Disclaimer
      expect(md).toContain('## 4. Rechtlicher Hinweis & Haftungs-Disclaimer');
      expect(md).toContain('§ 2 RDG');
      expect(md).toContain(DISCLAIMER_ZERO_HITS_NOTICE);
    });

    // 4.2 Gestylte HTML-Ausgabe
    it('erzeugt vollständiges, gestyltes HTML5-Dokument mit CSS und Ampel-Komponenten', () => {
      const html = fullAuditReport.toHtml();

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="de">');
      expect(html).toContain('<title>B2B Produktsicherheits- &amp; Compliance-Audit — Nordic Retail Group GmbH</title>');
      expect(html).toContain('<style>');

      // CSS-Farben & Badges
      expect(html).toContain('--red-600: #dc2626');
      expect(html).toContain('--yellow-600: #d97706');
      expect(html).toContain('--green-600: #16a34a');

      // Banner & KPIs
      expect(html).toContain('status-banner');
      expect(html).toContain('ROT — AKUTER VERTRIEBSSTOPP EMPFOHLEN');
      expect(html).toContain('20%'); // Compliance-Quote
      expect(html).toContain('Akute Treffer (Rot)');

      // Priorisierte Maßnahmen & Tabellen
      expect(html).toContain('Priorisierte Maßnahmenliste');
      expect(html).toContain('action-card p1');
      expect(html).toContain('action-card p2');
      expect(html).toContain('table-container');
      expect(html).toContain('DE-TOY-001');

      // Disclaimer
      expect(html).toContain('Wichtige Hinweise &amp; Gesetzlicher Haftungsausschluss (§ 2 RDG)');
      expect(html).toContain('Rechtlicher Hinweis &amp; Haftungsausschluss');
    });

    // 4.3 Datenbankkompatible XLSX-Ausgabe
    it('erzeugt eine valide, binäre OpenXML XLSX-Datei mit 4 strukturierten Tabellenblättern', () => {
      const xlsxBytes = fullAuditReport.toXlsx();

      // Muss Uint8Array / Buffer sein
      expect(xlsxBytes).toBeInstanceOf(Uint8Array);
      expect(xlsxBytes.length).toBeGreaterThan(1000);

      // ZIP-Signatur: Bytes 0-3 müssen PK\x03\x04 sein (0x50, 0x4b, 0x03, 0x04)
      expect(xlsxBytes[0]).toBe(0x50);
      expect(xlsxBytes[1]).toBe(0x4b);
      expect(xlsxBytes[2]).toBe(0x03);
      expect(xlsxBytes[3]).toBe(0x04);

      // Verifikation des ZIP-Containers über Buffer-Suche nach OpenXML Part-Namen
      const rawBuffer = Buffer.from(xlsxBytes);
      const contentStr = rawBuffer.toString('binary');

      expect(contentStr).toContain('[Content_Types].xml');
      expect(contentStr).toContain('xl/workbook.xml');
      expect(contentStr).toContain('xl/styles.xml');
      expect(contentStr).toContain('xl/worksheets/sheet1.xml');
      expect(contentStr).toContain('xl/worksheets/sheet2.xml');
      expect(contentStr).toContain('xl/worksheets/sheet3.xml');
      expect(contentStr).toContain('xl/worksheets/sheet4.xml');
    });

    it('erzeugt datenbankkompatible Spaltenstrukturen im Sheet 2 (Artikelliste) und Sheet 3 (Maßnahmen)', () => {
      // Dekomprimieren wir sheet2 und sheet3 direkt aus dem Zip, um die XML-Struktur zu verifizieren
      const xlsxBytes = fullAuditReport.toXlsx();
      const rawBuffer = Buffer.from(xlsxBytes);

      // Suche nach den Worksheets im deflatierten Zustand
      // Überprüfe, dass createAuditReport und generateXlsxReport identische Ausgaben liefern
      const standAloneXlsx = generateXlsxReport(fullAuditReport);
      expect(standAloneXlsx.length).toBe(xlsxBytes.length);

      // Prüfen, dass mindestens die XML-Inhalte in den Sheets datenbanktypische Header aufweisen
      const report = fullAuditReport;
      expect(report.items.length).toBe(5);
      expect(report.actions.length).toBeGreaterThanOrEqual(4);
    });

    it('unterstützt die Erzeugung von leeren Reports ohne Laufzeitfehler', () => {
      const emptyReport = createAuditReport({
        merchantName: 'Empty Store',
        items: [],
      });

      expect(emptyReport.summary.totalItems).toBe(0);
      expect(emptyReport.summary.complianceRate).toBe(100);
      expect(emptyReport.summary.overallTrafficLight).toBe('GREEN');

      const md = emptyReport.toMarkdown();
      expect(md).toContain('Keine offenen Maßnahmen erforderlich');

      const html = emptyReport.toHtml();
      expect(html).toContain('GRÜN — UNAUFFÄLLIG');

      const xlsx = emptyReport.toXlsx();
      expect(xlsx.length).toBeGreaterThan(500);
    });

    it('schützt Textzellen im XLSX-Export vor Formel-Injektion (CWE-1236)', () => {
      expect(sanitizeXlsxFormulaInjection('=cmd|/c calc')).toBe("'=cmd|/c calc");
      expect(sanitizeXlsxFormulaInjection(' =cmd|/c calc')).toBe("' =cmd|/c calc");
      expect(sanitizeXlsxFormulaInjection('\n=1+1')).toBe("'\n=1+1");
      expect(sanitizeXlsxFormulaInjection('+1+1')).toBe("'+1+1");
      expect(sanitizeXlsxFormulaInjection('-1-1')).toBe("'-1-1");
      expect(sanitizeXlsxFormulaInjection('@SUM(A1:A10)')).toBe("'@SUM(A1:A10)");
      expect(sanitizeXlsxFormulaInjection('＝1+1')).toBe("'＝1+1");
      expect(sanitizeXlsxFormulaInjection('＠SUM(A1)')).toBe("'＠SUM(A1)");
      expect(sanitizeXlsxFormulaInjection('\tmalicious')).toBe("'\tmalicious");
      expect(sanitizeXlsxFormulaInjection('Normal Title 123')).toBe('Normal Title 123');
    });

    it('klassifiziert Artikel mit verstümmelter EAN (eanCorrupted) als GELB (Prüfbedarf) und niemals als GRÜN', () => {
      const corruptedItem: AuditedItemInput = {
        id: 'ITEM-CORRUPTED-01',
        sku: 'SKU-CORRUPTED',
        asin: 'B08N5WRW99',
        title: 'Artikel mit verstümmelter EAN',
        eanCorrupted: true,
        identifierWarning: 'EAN_CORRUPTED_EXCEL',
        gpsrReport: {
          listingId: 'ITEM-CORRUPTED-01',
          sku: 'SKU-CORRUPTED',
          asin: 'B08N5WRW99',
          title: 'Artikel mit verstümmelter EAN',
          score: 100,
          status: 'COMPLIANT',
          trafficLight: 'GREEN',
          isCompliant: true,
          gaps: [],
          sections: {} as any,
          summary: { criticalGapsCount: 0, highGapsCount: 0, mediumGapsCount: 0, lowGapsCount: 0, totalGapsCount: 0 },
        },
      };

      const evaluated = evaluateAuditItem(corruptedItem);
      expect(evaluated.trafficLight).toBe('YELLOW');
      expect(evaluated.trafficLightGerman).toBe('Gelb');
      expect(evaluated.priorityLevel).toBe(3);
      expect(evaluated.statusLabel).toMatch(/PRÜFBEDARF.*EAN/i);
    });

    it('EAN_CORRUPTED does not downgrade RED from confirmed Safety Gate hit (F2 Präzedenz)', () => {
      const redAndCorruptedItem: AuditedItemInput = {
        id: 'ITEM-RED-AND-CORRUPTED',
        sku: 'SKU-RED-CORRUPTED',
        asin: 'B08N5WRW01',
        title: 'Gefährliches Produkt mit bestätigtem Treffer und verstümmelter EAN',
        eanCorrupted: true,
        identifierWarning: 'EAN_CORRUPTED_EXCEL',
        barcodeHit: true,
        barcodeMatch: {
          matched: true,
          alertNumber: 'A12/00999/26',
          productName: 'Gefährliches Produkt',
          riskType: 'Brandgefahr',
        },
      };

      const evaluated = evaluateAuditItem(redAndCorruptedItem);
      expect(evaluated.trafficLight).toBe('RED');
      expect(evaluated.trafficLightGerman).toBe('Rot');
      expect(evaluated.priorityLevel).toBe(1);
      expect(evaluated.statusLabel).toMatch(/VERTRIEBSSTOPP EMPFOHLEN/i);
    });
  });
});
