/**
 * B2B Multi-Format Audit Report Generator (MD, HTML, XLSX)
 *
 * Erzeugt kundenfertige B2B-Auditberichte für Marketplace-Händler (Amazon, eBay, etc.)
 * mit:
 * 1. 3-Säulen-Ampelsystem (Rot/Gelb/Grün): Barcode-Treffer, Fuzzy-Matches, GPSR-Readiness.
 * 2. Priorisierter, chronologisch sortierter Maßnahmenliste für Händler.
 * 3. Rechtssicherem Disclaimer (§ 2 RDG, Datenstand EU Safety Gate, Inverkehrbringer-Pflicht, Zero-Hits-Hinweis).
 * 4. Multi-Format-Export: Markdown, gestyltes HTML und datenbankkompatibles XLSX.
 */

import zlib from 'node:zlib';
import type { AlertRecord } from './schema.js';
import type { MatchResult, MatchClassification, MatchSeverity } from './matcher.js';
import type {
  GpsrReadinessReport,
  GpsrComplianceStatus,
  GpsrTrafficLight,
  GpsrGap,
  GpsrSeverity,
} from './gpsr.js';

// ============================================================================
// 1. TYPEN & SCHNITTSTELLEN
// ============================================================================

export type AuditTrafficLight = 'RED' | 'YELLOW' | 'GREEN';
export type AuditTrafficLightGerman = 'Rot' | 'Gelb' | 'Gruen';

export type ActionUrgency = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
export type ActionPriority = 1 | 2 | 3 | 4;

export type ActionCategory =
  | 'SAFETY_GATE_RECALL'
  | 'FUZZY_MATCH_REVIEW'
  | 'GPSR_RESPONSIBLE_PERSON'
  | 'GPSR_MANUFACTURER'
  | 'GPSR_WARNINGS_CE'
  | 'GPSR_IDENTIFICATION';

export interface BarcodeMatchInfo {
  matched: boolean;
  gtin?: string;
  ean?: string;
  alertNumber?: string;
  caseNumber?: string;
  productName?: string;
  riskType?: string;
  riskLevel?: string;
  category?: string;
  countryOfOrigin?: string;
  notifyingCountry?: string;
  measures?: string;
  dangerDescription?: string;
  sourceUrl?: string;
  alert?: Partial<AlertRecord> | Record<string, unknown>;
}

export interface AuditedItemInput {
  id?: string;
  sku?: string;
  asin?: string;
  ean?: string;
  gtin?: string;
  title?: string;
  name?: string;
  brand?: string;
  model?: string;
  category?: string;
  price?: number;
  quantity?: number;

  // Direkter Safety Gate Barcode-Treffer
  barcodeHit?: boolean;
  barcodeMatch?: BarcodeMatchInfo | Partial<AlertRecord> | null;

  // Fuzzy-Matching Ergebnis aus matcher.ts
  fuzzyMatch?: MatchResult | null;

  // GPSR-Readiness Ergebnis aus gpsr.ts
  gpsrReport?: GpsrReadinessReport | null;

  // EAN-Datenqualität & Exponential-Verstümmelung
  eanCorrupted?: boolean;
  identifierWarning?: string;

  [key: string]: unknown;
}

export interface EvaluatedAuditItem {
  id: string;
  sku: string;
  asin?: string;
  ean?: string;
  title: string;
  brand?: string;
  model?: string;
  category?: string;
  price?: number;
  quantity?: number;
  eanCorrupted?: boolean;
  identifierWarning?: string;

  // Ampel-Status
  trafficLight: AuditTrafficLight;
  trafficLightGerman: AuditTrafficLightGerman;
  statusLabel: string;
  statusReason: string;

  // Die 3 Prüfsäulen
  barcode: {
    matched: boolean;
    details?: BarcodeMatchInfo;
  };
  fuzzy: {
    matched: boolean;
    score: number;
    classification?: MatchClassification;
    matchedFields: string[];
    matchReason?: string;
    alertNumber?: string;
    riskType?: string;
  };
  gpsr: {
    checked: boolean;
    score: number;
    status: GpsrComplianceStatus;
    trafficLight: GpsrTrafficLight;
    gapsCount: number;
    gaps: GpsrGap[];
    criticalGapsCount: number;
    highGapsCount: number;
  };

  // Maßnahme für das einzelne Item
  recommendedAction: string;
  priorityLevel: ActionPriority;
}

export interface AuditActionItem {
  id: string;
  priority: ActionPriority;
  urgency: ActionUrgency;
  deadlineHours: number;
  deadlineText: string;
  dueDate: string;
  category: ActionCategory;
  sku: string;
  asin?: string;
  ean?: string;
  productTitle: string;
  title: string;
  action: string;
  reason: string;
  legalBasis: string;
  orderIndex: number;
}

export interface AuditSummary {
  totalItems: number;
  overallTrafficLight: AuditTrafficLight;
  overallTrafficLightGerman: AuditTrafficLightGerman;
  complianceRate: number; // 0 bis 100 %

  // Ampel-Verteilung
  redCount: number;
  yellowCount: number;
  greenCount: number;

  // Aufschlüsselung nach Säulen
  barcodeHitsCount: number;
  fuzzyMatchesCount: {
    total: number;
    red: number;
    yellow: number;
  };
  gpsrSummary: {
    checkedCount: number;
    compliantCount: number;
    partiallyCompliantCount: number;
    nonCompliantCount: number;
    averageScore: number;
    totalGapsCount: number;
    criticalGapsCount: number;
  };

  // Fristen & Maßnahmen
  criticalActionsCount: number;
  highActionsCount: number;
  mediumActionsCount: number;
  lowActionsCount: number;
  totalActionsCount: number;
}

export interface AuditReportOptions {
  reportId?: string;
  merchantName?: string;
  merchantId?: string;
  marketplace?: string;
  reportDate?: string | Date;
  safetyGateDate?: string | Date;
  items: AuditedItemInput[];
  customDisclaimer?: string;
  customZeroHitsNote?: string;
}

export interface HtmlReportOptions {
  title?: string;
  companyLogoUrl?: string;
  accentColor?: string;
  includeStyles?: boolean;
}

// ============================================================================
// 2. RECHTSSICHERE DISCLAIMER & INVARIANTEN
// ============================================================================

export const DISCLAIMER_LEGAL_NOTICE =
  'Rechtlicher Hinweis & Haftungsausschluss: Dieser Prüfbericht stellt eine rein technische und automatisierte Rechercheauswertung dar und begründet ausdrücklich keine Rechtsdienstleistung oder Rechtsberatung im Sinne des Rechtsdienstleistungsgesetzes (§ 2 RDG). Die Prüfung erfolgt auf Basis öffentlich zugänglicher Registerdaten des europäischen Schnellwarnsystems EU Safety Gate (ehemals RAPEX) sowie der bereitgestellten Produktdaten des Händlers.';

export const DISCLAIMER_SAFETY_GATE_SOURCE_TEMPLATE =
  'Datenstand EU Safety Gate (RAPEX): {DATE}. Aktualisierungszyklus: Wöchentlich gemäß EU-Kommissionsveröffentlichungen.';

export const DISCLAIMER_MERCHANT_OBLIGATION =
  'Gesetzliche Sorgfalts- und Prüfpflicht des Inverkehrbringers: Dieser Bericht entbindet den Marketplace-Händler bzw. Inverkehrbringer nicht von seiner eigenständigen gesetzlichen Prüf- und Überwachungspflicht gemäß dem Produktsicherheitsgesetz (ProdSG) und der Verordnung (EU) 2023/988 (GPSR). Für die Richtigkeit der vom Hersteller oder Lieferanten bereitgestellten technischen Daten und Konformitätserklärungen haftet der jeweilige Inverkehrbringer.';

export const DISCLAIMER_ZERO_HITS_NOTICE =
  'Kein Treffer bedeutet nicht, dass das Produkt sicher ist (viele behördliche RAPEX-Meldungen besitzen keine hinterlegte EAN). Ein Ergebnis ohne Treffer bedeutet nicht zwangsläufig, dass ein Produkt vollumfänglich sicher oder konform ist. Viele behördliche Safety-Gate-Meldungen enthalten keine Barcodes (EAN/GTIN) oder unvollständige Produktbezeichnungen. Händler sind verpflichtet, die technische Dokumentation und Konformitätserklärungen ihrer Lieferanten unabhängig zu verifizieren.';

/**
 * Formatiert ein Datum in das deutsche Standardformat TT.MM.JJJJ.
 */
export function formatSafetyGateDate(dateVal?: string | Date | null): string {
  if (!dateVal) {
    return '13.11.2026';
  }

  if (dateVal instanceof Date) {
    const day = String(dateVal.getDate()).padStart(2, '0');
    const month = String(dateVal.getMonth() + 1).padStart(2, '0');
    const year = dateVal.getFullYear();
    return `${day}.${month}.${year}`;
  }

  const s = String(dateVal).trim();
  // Format: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const parts = s.substring(0, 10).split('-');
    return `${parts[2]}.${parts[1]}.${parts[0]}`;
  }

  // Format: DD/MM/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}/.test(s)) {
    const parts = s.split('/');
    return `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[2]}`;
  }

  // Bereits TT.MM.JJJJ
  if (/^\d{1,2}\.\d{1,2}\.\d{4}/.test(s)) {
    const parts = s.split('.');
    return `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}.${parts[2]}`;
  }

  return s;
}

/**
 * Erzeugt den vollständigen, rechtssicheren B2B-Haftungsdisclaimer.
 */
export function getLegalDisclaimer(options?: {
  safetyGateDate?: string | Date | null;
  merchantName?: string;
  customText?: string;
}): string {
  if (options?.customText) {
    return options.customText;
  }
  const dateStr = formatSafetyGateDate(options?.safetyGateDate);
  const sourceText = DISCLAIMER_SAFETY_GATE_SOURCE_TEMPLATE.replace('{DATE}', dateStr);

  return [
    DISCLAIMER_LEGAL_NOTICE,
    sourceText,
    DISCLAIMER_MERCHANT_OBLIGATION,
  ].join('\n\n');
}

/**
 * Liefert den zwingenden Hinweis zu Non-Hit-Szenarien.
 */
export function getZeroHitsNotice(customNotice?: string): string {
  return customNotice || DISCLAIMER_ZERO_HITS_NOTICE;
}

// ============================================================================
// 3. AMPEL-LOGIK & ITEM-BEWERTUNG (AK1)
// ============================================================================

/**
 * Bewertet ein einzelnes Produkt-Item über alle 3 Säulen:
 * - Barcode-Treffer (EAN / Safety Gate)
 * - Fuzzy Match (matcher.ts)
 * - GPSR-Readiness (gpsr.ts)
 */
export function evaluateAuditItem(input: AuditedItemInput, index: number = 0): EvaluatedAuditItem {
  const id = input.id || input.sku || `ITEM-${String(index + 1).padStart(4, '0')}`;
  const sku = input.sku || input.id || id;
  const asin = input.asin;
  const ean = input.ean || input.gtin;
  const title = input.title || input.name || `Artikel ${sku}`;
  const brand = input.brand;
  const model = input.model;
  const category = input.category;
  const price = input.price;
  const quantity = input.quantity;

  // 1. Säule: Barcode Match
  let barcodeMatched = Boolean(input.barcodeHit);
  let barcodeDetails: BarcodeMatchInfo | undefined;

  if (input.barcodeMatch) {
    const bm = input.barcodeMatch as any;
    barcodeMatched = true;
    barcodeDetails = {
      matched: true,
      gtin: bm.gtin || ean,
      ean: bm.ean || ean,
      alertNumber: bm.alertNumber || bm.alert_number,
      caseNumber: bm.caseNumber || bm.case_number,
      productName: bm.productName || bm.product_name || title,
      riskType: bm.riskType || bm.risk_type,
      riskLevel: bm.riskLevel || bm.risk_level,
      category: bm.category || category,
      countryOfOrigin: bm.countryOfOrigin || bm.country_of_origin,
      notifyingCountry: bm.notifyingCountry || bm.notifying_country,
      measures: bm.measures,
      dangerDescription: bm.dangerDescription || bm.danger_description,
      sourceUrl: bm.sourceUrl || bm.source_url,
      alert: bm.alert || bm,
    };
  } else if (barcodeMatched) {
    barcodeDetails = {
      matched: true,
      ean: ean,
      gtin: ean,
      riskLevel: 'Serious risk',
    };
  }

  // 2. Säule: Fuzzy Match
  const fm = input.fuzzyMatch;
  const fuzzyMatched = Boolean(fm && fm.matched);
  const fuzzyScore = fm ? fm.score : 0;
  const fuzzyClassification = fm ? fm.classification : undefined;
  const fuzzyMatchedFields = fm ? fm.matched_fields || [] : [];
  const fuzzyMatchReason = fm ? fm.match_reason : undefined;

  let fuzzyAlertNumber: string | undefined;
  let fuzzyRiskType: string | undefined;
  if (fm && fm.alert) {
    const a = fm.alert as any;
    fuzzyAlertNumber = a.alert_number || a.alertNumber || a.case_number || a.caseNumber;
    fuzzyRiskType = a.risk_type || a.riskType;
  }

  // 3. Säule: GPSR-Readiness
  const gr = input.gpsrReport;
  const gpsrChecked = Boolean(gr);
  const gpsrScore = gr ? gr.score : 0;
  const gpsrStatus: GpsrComplianceStatus = gr ? gr.status : 'NON_COMPLIANT';
  const gpsrTrafficLight: GpsrTrafficLight = gr ? gr.trafficLight : 'RED';
  const gpsrGaps: GpsrGap[] = gr ? gr.gaps || [] : [];
  const gpsrCriticalGaps = gr ? gr.summary?.criticalGapsCount || 0 : 0;
  const gpsrHighGaps = gr ? gr.summary?.highGapsCount || 0 : 0;

  // --------------------------------------------------------------------------
  // Ampel-Entscheidungsbaum:
  // ROT (RED):
  //   - Akuter Barcode-Treffer im Safety Gate (ausschließlich verifizierte GTIN/EAN)
  //
  // GELB (YELLOW):
  //   - High-Confidence Fuzzy Match (Score >= 0.85): Verdachtsfall / manuelle Prüfung
  //   - Medium-Confidence Fuzzy Match (0.65 <= Score < 0.85): Prüfbedarf Modellähnlichkeit
  //   - ODER unvollständige GPSR-Daten (Status !== 'COMPLIANT' oder Gaps vorhanden)
  //
  // GRÜN (GREEN):
  //   - Kein Barcode-Hit
  //   - Kein Fuzzy Match (Score < 0.65)
  //   - GPSR geprüft und in den Pflichtfeldern unauffällig (Status 'COMPLIANT')
  // --------------------------------------------------------------------------
  let trafficLight: AuditTrafficLight = 'GREEN';
  let trafficLightGerman: AuditTrafficLightGerman = 'Gruen';
  let statusLabel = 'UNAUFFÄLLIG / KEINE BEHÖRDLICHEN BEFUNDE (CHECKLISTE UNBEAUFSICHTIGT)';
  let statusReason = 'Keine behördlichen Warnungen identifiziert; in den geprüften Pflichtfeldern keine Lücken erkannt (automatisierte Checkliste, keine Rechtsberatung gem. § 2 RDG).';
  let recommendedAction = 'Regulären Verkauf fortsetzen. Routinemäßiges Monitoring aufrechterhalten.';
  let priorityLevel: ActionPriority = 4;

  const isFuzzyRed = fuzzyMatched && (fuzzyScore >= 0.85 || fuzzyClassification === 'Rot');
  const isFuzzyYellow = fuzzyMatched && (fuzzyScore >= 0.65 && fuzzyScore < 0.85 || fuzzyClassification === 'Gelb');
  const isEanCorrupted = Boolean(input.eanCorrupted || input.identifierWarning === 'EAN_CORRUPTED_EXCEL' || input.identifierWarning === 'INVALID_EAN_CHECKSUM');
  const isGpsrIncomplete = gpsrChecked && (gpsrStatus !== 'COMPLIANT' || gpsrGaps.length > 0 || gpsrTrafficLight !== 'GREEN');

  if (barcodeMatched) {
    trafficLight = 'RED';
    trafficLightGerman = 'Rot';
    statusLabel = 'VERTRIEBSSTOPP EMPFOHLEN (AKUTER EAN-TREFFER)';
    statusReason = `Direkter EAN-Treffer in behördlicher EU Safety Gate Warnung (${barcodeDetails?.alertNumber || 'RAPEX'}).`;
    recommendedAction = 'Sofortiger Verkaufsstopp im Seller Central, physische Lagersperre und Quarantäne veranlassen.';
    priorityLevel = 1;
  } else if (isFuzzyRed) {
    trafficLight = 'YELLOW';
    trafficLightGerman = 'Gelb';
    statusLabel = 'VERDACHT – MANUELLE PRÜFUNG ERFORDERLICH (HOHE MODELL-ÄHNLICHKEIT)';
    statusReason = `Hohe Ähnlichkeit (${Math.round(fuzzyScore * 100)}%) mit Behördenmeldung (${fuzzyAlertNumber || 'Safety Gate'}), jedoch kein EAN-Nachweis. Keine automatische Auslistung.`;
    recommendedAction = 'Manuelle Prüfung: Handelt es sich um das Originalgerät oder um kompatibles Zubehör/Ersatzteil? Typenschild vor Auslistung abgleichen.';
    priorityLevel = 2;
  } else if (isFuzzyYellow) {
    trafficLight = 'YELLOW';
    trafficLightGerman = 'Gelb';
    statusLabel = 'PRÜFBEDARF (POTENZIELLER MODELL-MATCH)';
    statusReason = `Potenzielle Modellähnlichkeit (${Math.round(fuzzyScore * 100)}%) mit RAPEX-Meldung (${fuzzyAlertNumber || 'Safety Gate'}).`;
    recommendedAction = 'Manuelle Produktprüfung anhand Typenschild durchführen und Unbedenklichkeit dokumentieren.';
    priorityLevel = 2;
  } else if (isEanCorrupted) {
    trafficLight = 'YELLOW';
    trafficLightGerman = 'Gelb';
    statusLabel = 'PRÜFBEDARF (EAN-DATENQUALITÄT / VERSTÜMMELUNG)';
    statusReason = 'EAN/GTIN im Händlerkatalog durch Excel-Exponentialdarstellung verstümmelt oder Prüfziffer ungültig. Automatisierter Registerabgleich blockiert (False-Negative-Schutz).';
    recommendedAction = 'EAN/GTIN im Seller Central bzw. Warenwirtschaftssystem im Textformat ohne Exponentialschreibweise nachpflegen.';
    priorityLevel = 3;
  } else if (isGpsrIncomplete) {
    trafficLight = 'YELLOW';
    trafficLightGerman = 'Gelb';
    statusLabel = 'NACHPFLEGE ERFORDERLICH (GPSR-LÜCKEN)';
    statusReason = `GPSR Listing-Readiness unvollständig (${gpsrScore}%), ${gpsrGaps.length} Pflichtfeld-Lücken identifiziert.`;
    recommendedAction = 'Fehlende GPSR-Pflichtangaben (Responsible Person, Hersteller, Warnhinweise) im Seller Central nachpflegen.';
    priorityLevel = gpsrCriticalGaps > 0 ? 2 : 3;
  } else if (!gpsrChecked) {
    // Wenn GPSR nicht geprüft wurde, aber keine Warnungen vorliegen
    trafficLight = 'GREEN';
    trafficLightGerman = 'Gruen';
    statusLabel = 'UNAUFFÄLLIG (KEINE RAPEX-TREFFER)';
    statusReason = 'Keine behördlichen Treffer für Barcode oder Modellbezeichnung vorliegend.';
    recommendedAction = 'GPSR-Datenprüfung im nächsten Zyklus vorsehen.';
    priorityLevel = 4;
  }

  return {
    id,
    sku,
    asin,
    ean,
    title,
    brand,
    model,
    category,
    price,
    quantity,
    eanCorrupted: isEanCorrupted ? true : undefined,
    identifierWarning: (input.identifierWarning as string) || undefined,
    trafficLight,
    trafficLightGerman,
    statusLabel,
    statusReason,
    barcode: {
      matched: barcodeMatched,
      details: barcodeDetails,
    },
    fuzzy: {
      matched: fuzzyMatched,
      score: fuzzyScore,
      classification: fuzzyClassification,
      matchedFields: fuzzyMatchedFields,
      matchReason: fuzzyMatchReason,
      alertNumber: fuzzyAlertNumber,
      riskType: fuzzyRiskType,
    },
    gpsr: {
      checked: gpsrChecked,
      score: gpsrScore,
      status: gpsrStatus,
      trafficLight: gpsrTrafficLight,
      gapsCount: gpsrGaps.length,
      gaps: gpsrGaps,
      criticalGapsCount: gpsrCriticalGaps,
      highGapsCount: gpsrHighGaps,
    },
    recommendedAction,
    priorityLevel,
  };
}

// ============================================================================
// 4. MASSNAHMENLISTE: SORTIERT NACH DRINGLICHKEIT & CHRONOLOGISCH (AK2)
// ============================================================================

/**
 * Erzeugt eine priorisierte und chronologisch sortierte Maßnahmenliste.
 */
export function buildActionPlan(
  evaluatedItems: EvaluatedAuditItem[],
  reportDateStr?: string | Date
): AuditActionItem[] {
  const actions: AuditActionItem[] = [];
  const baseDate = reportDateStr ? new Date(reportDateStr) : new Date('2026-11-23T00:00:00Z');
  const validBaseDate = isNaN(baseDate.getTime()) ? new Date('2026-11-23T00:00:00Z') : baseDate;

  let counter = 1;

  function calcDueDate(hours: number): string {
    const due = new Date(validBaseDate.getTime() + hours * 3600 * 1000);
    return due.toISOString().split('T')[0];
  }

  for (const item of evaluatedItems) {
    // ------------------------------------------------------------------------
    // P1: CRITICAL / SOFORT (24h)
    // ------------------------------------------------------------------------
    if (item.barcode.matched) {
      const alertNo = item.barcode.details?.alertNumber || 'Safety Gate';
      const riskType = item.barcode.details?.riskType || 'Schweres Produktrisiko';
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 1,
        urgency: 'CRITICAL',
        deadlineHours: 24,
        deadlineText: 'Sofort (innerhalb 24 Stunden)',
        dueDate: calcDueDate(24),
        category: 'SAFETY_GATE_RECALL',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Sofortiger Vertriebsstopp & Lagersperre (EAN-Treffer Safety Gate)',
        action:
          'Listing im Amazon Seller Central umgehend auf "Inaktiv" setzen. Physischen Lagerbestand sperren (Quarantäne) und Kundenrückruf nach Art. 19 Abs. 2 GPSR vorbereiten.',
        reason: `Exakte EAN-Übereinstimmung mit behördlicher Safety Gate Meldung ${alertNo} (${riskType}).`,
        legalBasis: '§ 3 ProdSG, Art. 19/20 Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    } else if (item.fuzzy.matched && item.fuzzy.score >= 0.85) {
      const alertNo = item.fuzzy.alertNumber || 'RAPEX-Meldung';
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 2,
        urgency: 'HIGH',
        deadlineHours: 48,
        deadlineText: 'Kurzfristig (innerhalb 48 Stunden)',
        dueDate: calcDueDate(48),
        category: 'FUZZY_MATCH_REVIEW',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Manuelle Verifikation & Modell-Clearing (Hohe Ähnlichkeit >= 85%, Verdacht)',
        action:
          'Prüfen, ob es sich um das betroffene Hauptprodukt oder kompatibles Zubehör/Ersatzteil handelt. Typenschild mit Behördenmeldung abgleichen. Unbedenklichkeit dokumentieren.',
        reason: `Sehr hohe Text- und Modellübereinstimmung (${Math.round(item.fuzzy.score * 100)}%) mit Warnung ${alertNo}, jedoch kein EAN-Nachweis vorliegend.`,
        legalBasis: 'Art. 9 Abs. 8 & Art. 14 Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }

    // ------------------------------------------------------------------------
    // P2: HIGH / KURZFRISTIG (48h)
    // ------------------------------------------------------------------------
    if (item.fuzzy.matched && item.fuzzy.score >= 0.65 && item.fuzzy.score < 0.85) {
      const alertNo = item.fuzzy.alertNumber || 'RAPEX-Meldung';
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 2,
        urgency: 'HIGH',
        deadlineHours: 48,
        deadlineText: 'Kurzfristig (innerhalb 48 Stunden)',
        dueDate: calcDueDate(48),
        category: 'FUZZY_MATCH_REVIEW',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Manuelle Verifikation & Konformitäts-Clearing (Potenzieller Match 65-84%)',
        action:
          'Prüfung des konkreten Modell- und Chargenstands gegen die RAPEX-Warnung vornehmen. Unbedenklichkeitsnachweis im Compliance-Dossier archivieren.',
        reason: `Mögliche Verwechslung oder Modellabwandlung (${Math.round(item.fuzzy.score * 100)}% Ähnlichkeit) mit Meldung ${alertNo}.`,
        legalBasis: 'Art. 9 Abs. 8 & Art. 14 Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }

    // GPSR Responsible Person Lücken (Art. 16)
    const rpGaps = item.gpsr.gaps.filter(
      (g) => g.article === 'Art. 16' || g.article === 'Art. 16(1)' || g.article === 'Art. 19(1)(b)'
    );
    if (rpGaps.length > 0) {
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 2,
        urgency: 'HIGH',
        deadlineHours: 48,
        deadlineText: 'Kurzfristig (innerhalb 48 Stunden)',
        dueDate: calcDueDate(48),
        category: 'GPSR_RESPONSIBLE_PERSON',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'EU-Verantwortliche Person (Responsible Person) im Seller Central hinterlegen',
        action:
          'Name, postalische EU-Adresse und E-Mail der EU-Verantwortlichen Person (Responsible Person) im Marktplatz-Compliance-Portal eintragen, um drohende Listing-Sperren abzuwenden.',
        reason: rpGaps.map((g) => g.message).join('; '),
        legalBasis: 'Art. 16, Art. 19 Abs. 1 lit. b Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }

    // ------------------------------------------------------------------------
    // P3: MEDIUM / MITTELFRISTIG (7 Tage = 168h)
    // ------------------------------------------------------------------------
    const mfgGaps = item.gpsr.gaps.filter(
      (g) => g.article === 'Art. 9' || g.article === 'Art. 9(1)' || g.article === 'Art. 9(2)' || g.article === 'Art. 19(1)(a)'
    );
    if (mfgGaps.length > 0) {
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 3,
        urgency: 'MEDIUM',
        deadlineHours: 168,
        deadlineText: 'Mittelfristig (innerhalb 7 Tagen)',
        dueDate: calcDueDate(168),
        category: 'GPSR_MANUFACTURER',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Herstellerangaben & postalische Anschrift nachpflegen',
        action:
          'Herstellername/Handelsmarke, Postanschrift und elektronische Kontaktadresse (E-Mail/Website) in den Produktdaten hinterlegen.',
        reason: mfgGaps.map((g) => g.message).join('; '),
        legalBasis: 'Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }

    const warnGaps = item.gpsr.gaps.filter(
      (g) => g.article === 'Art. 9(7)' || g.article === 'Art. 19(1)(d)'
    );
    if (warnGaps.length > 0) {
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 3,
        urgency: 'MEDIUM',
        deadlineHours: 168,
        deadlineText: 'Mittelfristig (innerhalb 7 Tagen)',
        dueDate: calcDueDate(168),
        category: 'GPSR_WARNINGS_CE',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Sicherheitswarnungen & Kennzeichnung im Online-Listing ergänzen',
        action:
          'Erforderliche Warnhinweise (z.B. Erstickungsgefahr, Altersbeschränkung) und CE-Kennzeichnung im Listing-Text sowie als Bildnachweis einpflegen.',
        reason: warnGaps.map((g) => g.message).join('; '),
        legalBasis: 'Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }

    // ------------------------------------------------------------------------
    // P4: LOW / ROUTINE (30 Tage = 720h)
    // ------------------------------------------------------------------------
    const idGaps = item.gpsr.gaps.filter(
      (g) => g.article === 'Art. 9(5)' || g.article === 'Art. 19(1)(c)'
    );
    if (idGaps.length > 0) {
      actions.push({
        id: `ACT-${String(counter++).padStart(3, '0')}`,
        priority: 4,
        urgency: 'LOW',
        deadlineHours: 720,
        deadlineText: 'Vor nächstem Import/Restock (innerhalb 30 Tagen)',
        dueDate: calcDueDate(720),
        category: 'GPSR_IDENTIFICATION',
        sku: item.sku,
        asin: item.asin,
        ean: item.ean,
        productTitle: item.title,
        title: 'Typ-, Chargen- oder Modellnummer im Produktkatalog vervollständigen',
        action:
          'Typen-, Serien- oder Modellnummern zur lückenlosen Rückverfolgbarkeit im Warenwirtschaftssystem und Marktplatz-Katalog hinterlegen.',
        reason: idGaps.map((g) => g.message).join('; '),
        legalBasis: 'Art. 9 Abs. 5, Art. 19 Abs. 1 lit. c Verordnung (EU) 2023/988 (GPSR)',
        orderIndex: 0,
      });
    }
  }

  // Chronologisch & nach Dringlichkeit sortieren:
  // 1. Priority (1 vor 2 vor 3 vor 4)
  // 2. deadlineHours aufsteigend (24 vor 48 vor 168 vor 720)
  // 3. dueDate aufsteigend
  actions.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    if (a.deadlineHours !== b.deadlineHours) {
      return a.deadlineHours - b.deadlineHours;
    }
    return a.dueDate.localeCompare(b.dueDate);
  });

  // Re-indexieren
  actions.forEach((act, idx) => {
    act.orderIndex = idx + 1;
    act.id = `ACT-${String(idx + 1).padStart(3, '0')}`;
  });

  return actions;
}

// ============================================================================
// 5. GESAMTZUSAMMENFASSUNG & KENNZAHLEN
// ============================================================================

export function buildAuditSummary(
  evaluatedItems: EvaluatedAuditItem[],
  actions: AuditActionItem[]
): AuditSummary {
  const total = evaluatedItems.length;
  let red = 0;
  let yellow = 0;
  let green = 0;

  let barcodeHits = 0;
  let fuzzyRed = 0;
  let fuzzyYellow = 0;

  let gpsrChecked = 0;
  let gpsrCompliant = 0;
  let gpsrPartially = 0;
  let gpsrNonCompliant = 0;
  let gpsrScoreSum = 0;
  let gpsrTotalGaps = 0;
  let gpsrCriticalGaps = 0;

  for (const item of evaluatedItems) {
    if (item.trafficLight === 'RED') red++;
    else if (item.trafficLight === 'YELLOW') yellow++;
    else green++;

    if (item.barcode.matched) barcodeHits++;
    if (item.fuzzy.matched) {
      if (item.fuzzy.score >= 0.85) fuzzyRed++;
      else if (item.fuzzy.score >= 0.65) fuzzyYellow++;
    }

    if (item.gpsr.checked) {
      gpsrChecked++;
      gpsrScoreSum += item.gpsr.score;
      gpsrTotalGaps += item.gpsr.gapsCount;
      gpsrCriticalGaps += item.gpsr.criticalGapsCount;

      if (item.gpsr.status === 'COMPLIANT') gpsrCompliant++;
      else if (item.gpsr.status === 'PARTIALLY_COMPLIANT') gpsrPartially++;
      else gpsrNonCompliant++;
    }
  }

  let overallTrafficLight: AuditTrafficLight = 'GREEN';
  let overallTrafficLightGerman: AuditTrafficLightGerman = 'Gruen';

  if (red > 0) {
    overallTrafficLight = 'RED';
    overallTrafficLightGerman = 'Rot';
  } else if (yellow > 0) {
    overallTrafficLight = 'YELLOW';
    overallTrafficLightGerman = 'Gelb';
  }

  const complianceRate = total > 0 ? Math.round((green / total) * 1000) / 10 : 100;
  const avgGpsrScore = gpsrChecked > 0 ? Math.round(gpsrScoreSum / gpsrChecked) : 0;

  const p1Count = actions.filter((a) => a.priority === 1).length;
  const p2Count = actions.filter((a) => a.priority === 2).length;
  const p3Count = actions.filter((a) => a.priority === 3).length;
  const p4Count = actions.filter((a) => a.priority === 4).length;

  return {
    totalItems: total,
    overallTrafficLight,
    overallTrafficLightGerman,
    complianceRate,
    redCount: red,
    yellowCount: yellow,
    greenCount: green,
    barcodeHitsCount: barcodeHits,
    fuzzyMatchesCount: {
      total: fuzzyRed + fuzzyYellow,
      red: fuzzyRed,
      yellow: fuzzyYellow,
    },
    gpsrSummary: {
      checkedCount: gpsrChecked,
      compliantCount: gpsrCompliant,
      partiallyCompliantCount: gpsrPartially,
      nonCompliantCount: gpsrNonCompliant,
      averageScore: avgGpsrScore,
      totalGapsCount: gpsrTotalGaps,
      criticalGapsCount: gpsrCriticalGaps,
    },
    criticalActionsCount: p1Count,
    highActionsCount: p2Count,
    mediumActionsCount: p3Count,
    lowActionsCount: p4Count,
    totalActionsCount: actions.length,
  };
}

// ============================================================================
// 6. REPORT-KLASSE & HAUPTEINSTIEG
// ============================================================================

export class B2BAuditReport {
  public readonly id: string;
  public readonly merchantName: string;
  public readonly merchantId?: string;
  public readonly marketplace?: string;
  public readonly reportDate: string;
  public readonly safetyGateDate: string;
  public readonly summary: AuditSummary;
  public readonly items: EvaluatedAuditItem[];
  public readonly actions: AuditActionItem[];
  public readonly disclaimer: string;
  public readonly zeroHitsNote: string;

  constructor(options: AuditReportOptions) {
    this.id = options.reportId || `AUD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${Math.floor(1000 + Math.random() * 9000)}`;
    this.merchantName = options.merchantName || 'Marketplace-Händler';
    this.merchantId = options.merchantId;
    this.marketplace = options.marketplace || 'Amazon.de';
    this.reportDate = formatSafetyGateDate(options.reportDate || new Date());
    this.safetyGateDate = formatSafetyGateDate(options.safetyGateDate || '13.11.2026');

    // 1. Items bewerten
    this.items = (options.items || []).map((item, idx) => evaluateAuditItem(item, idx));

    // 2. Maßnahmenplan erstellen
    this.actions = buildActionPlan(this.items, options.reportDate);

    // 3. Zusammenfassung bilden
    this.summary = buildAuditSummary(this.items, this.actions);

    // 4. Disclaimer
    this.disclaimer = getLegalDisclaimer({
      safetyGateDate: this.safetyGateDate,
      merchantName: this.merchantName,
      customText: options.customDisclaimer,
    });
    this.zeroHitsNote = getZeroHitsNotice(options.customZeroHitsNote);
  }

  public toMarkdown(): string {
    return generateMarkdownReport(this);
  }

  public toHtml(options?: HtmlReportOptions): string {
    return generateHtmlReport(this, options);
  }

  public toXlsx(): Uint8Array {
    return generateXlsxReport(this);
  }
}

/**
 * Erzeugt einen B2B Audit Report.
 */
export function createAuditReport(options: AuditReportOptions): B2BAuditReport {
  return new B2BAuditReport(options);
}

export function generateAuditReport(options: AuditReportOptions): B2BAuditReport {
  return new B2BAuditReport(options);
}

// ============================================================================
// 7. FORMAT-GENERATOR: MARKDOWN (AK4)
// ============================================================================

export function generateMarkdownReport(report: B2BAuditReport): string {
  const md: string[] = [];
  const s = report.summary;

  const trafficBadge =
    s.overallTrafficLight === 'RED'
      ? '🔴 **ROT (AKUTER HANDLUNGSBEDARF)**'
      : s.overallTrafficLight === 'YELLOW'
      ? '🟡 **GELB (PRÜFBEDARF & NACHPFLEGE)**'
      : '🟢 **GRÜN (UNAUFFÄLLIG / CHECKLISTE OHNE LÜCKEN)**';

  md.push(`# B2B Produktsicherheits- & Compliance-Audit-Report`);
  md.push(``);
  md.push(`**Report-ID:** \`${report.id}\` | **Mandant / Händler:** ${report.merchantName} | **Marktplatz:** ${report.marketplace || 'Amazon'}`);
  md.push(`**Prüfdatum:** ${report.reportDate} | **Datenstand EU Safety Gate:** ${report.safetyGateDate}`);
  md.push(``);
  md.push(`---`);
  md.push(``);

  // Executive Summary / Ampelsystem
  md.push(`## 1. Executive Summary: Ampelsystem-Übersicht`);
  md.push(``);
  md.push(`**Gesamt-Status:** ${trafficBadge}`);
  md.push(`**Compliance-Quote:** **${s.complianceRate}%** unauffällige Artikel ohne Lücken`);
  md.push(``);
  md.push(`| Status-Kategorie | Ampel | Anzahl Artikel | Anteil | Empfohlene Hauptreaktion |`);
  md.push(`| :--- | :---: | :---: | :---: | :--- |`);
  md.push(`| **Akute Treffer (Rot)** | 🔴 | **${s.redCount}** | ${s.totalItems ? Math.round((s.redCount / s.totalItems) * 100) : 0}% | Sofortiger Vertriebsstopp & Lagersperre |`);
  md.push(`| **Prüfbedarf / Nachpflege (Gelb)** | 🟡 | **${s.yellowCount}** | ${s.totalItems ? Math.round((s.yellowCount / s.totalItems) * 100) : 0}% | Modell-Clearing & GPSR-Stammdatenpflege |`);
  md.push(`| **Konform / Unauffällig (Grün)** | 🟢 | **${s.greenCount}** | ${s.totalItems ? Math.round((s.greenCount / s.totalItems) * 100) : 0}% | Regulärer Verkauf, Routine-Monitoring |`);
  md.push(`| **Gesamt geprüft** | 📊 | **${s.totalItems}** | 100% | Vollabgleich EAN, Fuzzy & GPSR |`);
  md.push(``);

  // Aufschlüsselung nach Prüfsäulen
  md.push(`### Prüfergebnisse nach Säulen`);
  md.push(`- **Barcode-Treffer (Safety Gate / RAPEX):** ${s.barcodeHitsCount} Treffer`);
  md.push(`- **Fuzzy-Matching Treffer:** ${s.fuzzyMatchesCount.total} (${s.fuzzyMatchesCount.red} mit Konfidenz $\\ge 85\\%$, ${s.fuzzyMatchesCount.yellow} im Prüfbereich $65\\text{--}84\\%$)`);
  md.push(`- **GPSR-Readiness (EU 2023/988):** Ø ${s.gpsrSummary.averageScore}% Score (${s.gpsrSummary.compliantCount} ohne Lücken, ${s.gpsrSummary.partiallyCompliantCount} mit Teilnachweisen, ${s.gpsrSummary.nonCompliantCount} mit Nachpflegebedarf; ${s.gpsrSummary.totalGapsCount} Lücken)`);
  md.push(``);

  // Priorisierte Maßnahmenliste
  md.push(`## 2. Priorisierte Händler-Maßnahmenliste (Chronologisch nach Dringlichkeit)`);
  md.push(``);
  if (report.actions.length === 0) {
    md.push(`*Keine offenen Maßnahmen erforderlich. Alle geprüften Artikel befinden sich im grünen Status.*`);
    md.push(``);
  } else {
    md.push(`| Pos. | Priorität | Frist / Fälligkeit | SKU / ASIN | Maßnahme & Handlungsanweisung | Rechtsgrundlage |`);
    md.push(`| :---: | :--- | :--- | :--- | :--- | :--- |`);
    for (const act of report.actions) {
      const prioLabel =
        act.priority === 1
          ? '🔴 **P1: SOFORT**'
          : act.priority === 2
          ? '🟠 **P2: KURZFRISTIG**'
          : act.priority === 3
          ? '🟡 **P3: MITTELFRISTIG**'
          : '⚪ **P4: ROUTINE**';

      const skuAsin = act.asin ? `\`${act.sku}\` / \`${act.asin}\`` : `\`${act.sku}\``;
      const cleanAction = act.action.replace(/\|/g, '\\|');
      const cleanLegal = act.legalBasis.replace(/\|/g, '\\|');

      md.push(`| #${act.orderIndex} | ${prioLabel} | **${act.deadlineText}**<br>*(bis ${act.dueDate})* | ${skuAsin}<br>*${act.productTitle.slice(0, 45)}* | **${act.title}**<br>${cleanAction} | ${cleanLegal} |`);
    }
    md.push(``);
  }

  // Artikel-Detailübersicht
  md.push(`## 3. Geprüfte Artikel im Detail`);
  md.push(``);
  if (report.items.length === 0) {
    md.push(`*Keine Artikel zur Prüfung übergeben.*`);
    md.push(``);
  } else {
    md.push(`| Ampel | SKU / ASIN | Produktbezeichnung | Barcode-Hit | Fuzzy-Match | GPSR-Score | Befund & Status |`);
    md.push(`| :---: | :--- | :--- | :---: | :---: | :---: | :--- |`);
    for (const item of report.items) {
      const icon = item.trafficLight === 'RED' ? '🔴' : item.trafficLight === 'YELLOW' ? '🟡' : '🟢';
      const skuText = item.asin ? `\`${item.sku}\`<br>\`${item.asin}\`` : `\`${item.sku}\``;
      const bcHit = item.barcode.matched ? '⚠️ **JA**' : '—';
      const fzHit = item.fuzzy.matched ? `${Math.round(item.fuzzy.score * 100)}%` : '—';
      const gpsrText = item.gpsr.checked ? `${item.gpsr.score}%` : 'N/A';
      const safeReason = item.statusReason.replace(/\|/g, '\\|');

      md.push(`| ${icon} | ${skuText} | ${item.title.slice(0, 50)} | ${bcHit} | ${fzHit} | ${gpsrText} | ${safeReason} |`);
    }
    md.push(``);
  }

  // Disclaimer & Sicherheits-Hinweise
  md.push(`---`);
  md.push(``);
  md.push(`## 4. Rechtlicher Hinweis & Haftungs-Disclaimer`);
  md.push(``);
  md.push(`> [!NOTE]`);
  md.push(`> **Sicherheitsrelevanter Hinweis zu unauffälligen Ergebnissen:**`);
  md.push(`> ${report.zeroHitsNote}`);
  md.push(`>`);
  md.push(`> **Standard-Disclaimer & Haftungsausschluss (§ 2 RDG):**`);
  for (const line of report.disclaimer.split('\n')) {
    if (line.trim()) {
      md.push(`> ${line}`);
    } else {
      md.push(`>`);
    }
  }
  md.push(``);

  return md.join('\n');
}

// ============================================================================
// 8. FORMAT-GENERATOR: GESTYLTES HTML (AK4)
// ============================================================================

function escapeHtml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function generateHtmlReport(report: B2BAuditReport, options?: HtmlReportOptions): string {
  const s = report.summary;
  const pageTitle = options?.title || `B2B Produktsicherheits- & Compliance-Audit — ${report.merchantName}`;

  const overallColor =
    s.overallTrafficLight === 'RED'
      ? '#dc2626'
      : s.overallTrafficLight === 'YELLOW'
      ? '#d97706'
      : '#16a34a';

  const overallBg =
    s.overallTrafficLight === 'RED'
      ? '#fee2e2'
      : s.overallTrafficLight === 'YELLOW'
      ? '#fef3c7'
      : '#dcfce7';

  const overallText =
    s.overallTrafficLight === 'RED'
      ? 'ROT — AKUTER VERTRIEBSSTOPP EMPFOHLEN'
      : s.overallTrafficLight === 'YELLOW'
      ? 'GELB — PRÜFBEDARF & GPSR-NACHPFLEGE'
      : 'GRÜN — UNAUFFÄLLIG (CHECKLISTE OHNE ERKENNBARE LÜCKEN)';

  const html: string[] = [];

  html.push(`<!DOCTYPE html>`);
  html.push(`<html lang="de">`);
  html.push(`<head>`);
  html.push(`  <meta charset="UTF-8">`);
  html.push(`  <meta name="viewport" content="width=device-width, initial-scale=1.0">`);
  html.push(`  <title>${escapeHtml(pageTitle)}</title>`);
  html.push(`  <style>`);
  html.push(`    :root {`);
  html.push(`      --primary: #0f172a;`);
  html.push(`      --slate-50: #f8fafc;`);
  html.push(`      --slate-100: #f1f5f9;`);
  html.push(`      --slate-200: #e2e8f0;`);
  html.push(`      --slate-700: #334155;`);
  html.push(`      --slate-900: #0f172a;`);
  html.push(`      --red-600: #dc2626;`);
  html.push(`      --red-50: #fef2f2;`);
  html.push(`      --yellow-600: #d97706;`);
  html.push(`      --yellow-50: #fffbeb;`);
  html.push(`      --green-600: #16a34a;`);
  html.push(`      --green-50: #f0fdf4;`);
  html.push(`    }`);
  html.push(`    * { box-sizing: border-box; margin: 0; padding: 0; }`);
  html.push(`    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; line-height: 1.5; padding: 2rem 1rem; }`);
  html.push(`    .container { max-width: 1200px; margin: 0 auto; background: #ffffff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -2px rgba(0,0,0,0.1); overflow: hidden; }`);
  html.push(`    .header { background: #0f172a; color: #ffffff; padding: 2.5rem; }`);
  html.push(`    .header-top { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem; }`);
  html.push(`    .badge-report { background: #1e293b; color: #94a3b8; font-family: monospace; font-size: 0.875rem; padding: 0.35rem 0.75rem; border-radius: 6px; border: 1px solid #334155; }`);
  html.push(`    .title { font-size: 1.875rem; font-weight: 700; letter-spacing: -0.025em; margin-bottom: 0.5rem; }`);
  html.push(`    .subtitle { color: #94a3b8; font-size: 1rem; }`);
  html.push(`    .meta-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1.25rem; margin-top: 1.5rem; padding-top: 1.5rem; border-top: 1px solid #334155; }`);
  html.push(`    .meta-item .meta-label { font-size: 0.75rem; text-transform: uppercase; color: #94a3b8; font-weight: 600; margin-bottom: 0.25rem; }`);
  html.push(`    .meta-item .meta-val { font-size: 1rem; font-weight: 600; color: #f8fafc; }`);
  html.push(`    .content { padding: 2.5rem; }`);
  html.push(`    .status-banner { padding: 1.5rem; border-radius: 8px; border-left: 6px solid ${overallColor}; background: ${overallBg}; margin-bottom: 2.5rem; display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 1rem; }`);
  html.push(`    .status-banner-title { font-size: 1.25rem; font-weight: 700; color: ${overallColor}; }`);
  html.push(`    .status-banner-desc { font-size: 0.95rem; color: #334155; margin-top: 0.25rem; }`);
  html.push(`    .compliance-score { text-align: right; }`);
  html.push(`    .compliance-score-val { font-size: 2.25rem; font-weight: 800; color: ${overallColor}; line-height: 1; }`);
  html.push(`    .compliance-score-label { font-size: 0.75rem; text-transform: uppercase; color: #64748b; font-weight: 600; }`);
  html.push(`    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1rem; margin-bottom: 2.5rem; }`);
  html.push(`    .kpi-card { padding: 1.25rem; border-radius: 8px; border: 1px solid #e2e8f0; background: #ffffff; }`);
  html.push(`    .kpi-card.red { border-left: 4px solid var(--red-600); background: #fef2f2; }`);
  html.push(`    .kpi-card.yellow { border-left: 4px solid var(--yellow-600); background: #fffbeb; }`);
  html.push(`    .kpi-card.green { border-left: 4px solid var(--green-600); background: #f0fdf4; }`);
  html.push(`    .kpi-num { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.25rem; }`);
  html.push(`    .kpi-title { font-size: 0.875rem; font-weight: 600; color: #475569; }`);
  html.push(`    .kpi-desc { font-size: 0.75rem; color: #64748b; margin-top: 0.25rem; }`);
  html.push(`    h2 { font-size: 1.375rem; font-weight: 700; color: #0f172a; margin-bottom: 1.25rem; padding-bottom: 0.5rem; border-bottom: 2px solid #f1f5f9; display: flex; align-items: center; justify-content: space-between; }`);
  html.push(`    .table-container { overflow-x: auto; margin-bottom: 2.5rem; border: 1px solid #e2e8f0; border-radius: 8px; }`);
  html.push(`    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.875rem; }`);
  html.push(`    th { background: #f8fafc; padding: 0.75rem 1rem; font-weight: 600; color: #475569; border-bottom: 1px solid #e2e8f0; }`);
  html.push(`    td { padding: 0.875rem 1rem; border-bottom: 1px solid #f1f5f9; vertical-align: top; }`);
  html.push(`    tr:last-child td { border-bottom: none; }`);
  html.push(`    tr:hover td { background-color: #f8fafc; }`);
  html.push(`    .badge { display: inline-flex; align-items: center; padding: 0.25rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; }`);
  html.push(`    .badge-red { background: #fee2e2; color: #991b1b; }`);
  html.push(`    .badge-yellow { background: #fef3c7; color: #92400e; }`);
  html.push(`    .badge-green { background: #dcfce7; color: #166534; }`);
  html.push(`    .badge-p1 { background: #dc2626; color: #ffffff; }`);
  html.push(`    .badge-p2 { background: #d97706; color: #ffffff; }`);
  html.push(`    .badge-p3 { background: #2563eb; color: #ffffff; }`);
  html.push(`    .badge-p4 { background: #64748b; color: #ffffff; }`);
  html.push(`    .action-card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.25rem; margin-bottom: 1rem; }`);
  html.push(`    .action-card.p1 { border-left: 4px solid #dc2626; }`);
  html.push(`    .action-card.p2 { border-left: 4px solid #d97706; }`);
  html.push(`    .action-card.p3 { border-left: 4px solid #2563eb; }`);
  html.push(`    .action-card.p4 { border-left: 4px solid #64748b; }`);
  html.push(`    .action-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; flex-wrap: wrap; gap: 0.5rem; }`);
  html.push(`    .action-title { font-weight: 700; font-size: 1rem; color: #0f172a; }`);
  html.push(`    .action-deadline { font-size: 0.8rem; font-weight: 600; color: #dc2626; background: #fee2e2; padding: 0.2rem 0.5rem; border-radius: 4px; }`);
  html.push(`    .action-body { font-size: 0.875rem; color: #334155; margin-bottom: 0.5rem; }`);
  html.push(`    .action-meta { font-size: 0.75rem; color: #64748b; display: flex; gap: 1rem; flex-wrap: wrap; }`);
  html.push(`    .disclaimer-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1.5rem; margin-top: 2.5rem; font-size: 0.8rem; color: #475569; }`);
  html.push(`    .disclaimer-box h3 { font-size: 0.875rem; font-weight: 700; color: #0f172a; margin-bottom: 0.75rem; }`);
  html.push(`    .disclaimer-box p { margin-bottom: 0.75rem; }`);
  html.push(`    .disclaimer-box p:last-child { margin-bottom: 0; }`);
  html.push(`    @media print { body { padding: 0; background: #fff; } .container { box-shadow: none; border-radius: 0; } .header { padding: 1.5rem; } .content { padding: 1.5rem; } }`);
  html.push(`  </style>`);
  html.push(`</head>`);
  html.push(`<body>`);
  html.push(`  <div class="container">`);

  // Header
  html.push(`    <div class="header">`);
  html.push(`      <div class="header-top">`);
  html.push(`        <div>`);
  html.push(`          <h1 class="title">B2B Produktsicherheits- & Compliance-Audit</h1>`);
  html.push(`          <p class="subtitle">RAPEX / EU Safety Gate & GPSR Listing-Readiness Auswertung</p>`);
  html.push(`        </div>`);
  html.push(`        <span class="badge-report">ID: ${escapeHtml(report.id)}</span>`);
  html.push(`      </div>`);
  html.push(`      <div class="meta-grid">`);
  html.push(`        <div class="meta-item"><div class="meta-label">Mandant / Händler</div><div class="meta-val">${escapeHtml(report.merchantName)}</div></div>`);
  html.push(`        <div class="meta-item"><div class="meta-label">Marktplatz</div><div class="meta-val">${escapeHtml(report.marketplace || 'Amazon.de')}</div></div>`);
  html.push(`        <div class="meta-item"><div class="meta-label">Prüfdatum</div><div class="meta-val">${escapeHtml(report.reportDate)}</div></div>`);
  html.push(`        <div class="meta-item"><div class="meta-label">Datenstand EU Safety Gate</div><div class="meta-val">${escapeHtml(report.safetyGateDate)}</div></div>`);
  html.push(`      </div>`);
  html.push(`    </div>`);

  // Content
  html.push(`    <div class="content">`);

  // Status Banner
  html.push(`      <div class="status-banner">`);
  html.push(`        <div>`);
  html.push(`          <div class="status-banner-title">${escapeHtml(overallText)}</div>`);
  html.push(`          <div class="status-banner-desc">${s.redCount > 0 ? `${s.redCount} Artikel mit akuten Behördenwarnungen erfordern sofortige Deaktivierung.` : s.yellowCount > 0 ? `${s.yellowCount} Artikel erfordern manuelle Verifikation oder GPSR-Nachpflege.` : 'In den geprüften Pflichtfeldern keine behördlichen Treffer oder Lücken erkannt (automatisierte Checkliste, keine Rechtsberatung gem. § 2 RDG).'}</div>`);
  html.push(`        </div>`);
  html.push(`        <div class="compliance-score">`);
  html.push(`          <div class="compliance-score-val">${s.complianceRate}%</div>`);
  html.push(`          <div class="compliance-score-label">Compliance-Quote</div>`);
  html.push(`        </div>`);
  html.push(`      </div>`);

  // KPI Cards
  html.push(`      <div class="kpi-grid">`);
  html.push(`        <div class="kpi-card red"><div class="kpi-num" style="color:var(--red-600)">${s.redCount}</div><div class="kpi-title">Akute Treffer (Rot)</div><div class="kpi-desc">Sofortiger Verkaufsstopp empfohlen</div></div>`);
  html.push(`        <div class="kpi-card yellow"><div class="kpi-num" style="color:var(--yellow-600)">${s.yellowCount}</div><div class="kpi-title">Prüffälle / Lücken (Gelb)</div><div class="kpi-desc">Fuzzy-Match oder GPSR-Nachpflege</div></div>`);
  html.push(`        <div class="kpi-card green"><div class="kpi-num" style="color:var(--green-600)">${s.greenCount}</div><div class="kpi-title">Unauffällig (Grün)</div><div class="kpi-desc">Checkliste ohne erkannte Lücken</div></div>`);
  html.push(`        <div class="kpi-card"><div class="kpi-num">${s.totalItems}</div><div class="kpi-title">Geprüfte Artikel</div><div class="kpi-desc">${s.barcodeHitsCount} Barcode- & ${s.fuzzyMatchesCount.total} Fuzzy-Treffer</div></div>`);
  html.push(`      </div>`);

  // Handlungsempfehlungen
  html.push(`      <h2>Priorisierte Maßnahmenliste (${report.actions.length} Aufgaben)</h2>`);
  if (report.actions.length === 0) {
    html.push(`      <p style="color:#64748b; font-size:0.95rem; margin-bottom:2rem;">Keine offenen Maßnahmen. Alle geprüften Artikel befinden sich im grünen Status.</p>`);
  } else {
    for (const act of report.actions) {
      const prioClass = `p${act.priority}`;
      const prioBadge = act.priority === 1 ? 'badge-p1' : act.priority === 2 ? 'badge-p2' : act.priority === 3 ? 'badge-p3' : 'badge-p4';
      const prioText = act.priority === 1 ? 'P1: SOFORT' : act.priority === 2 ? 'P2: KURZFRISTIG' : act.priority === 3 ? 'P3: MITTELFRISTIG' : 'P4: ROUTINE';

      html.push(`      <div class="action-card ${prioClass}">`);
      html.push(`        <div class="action-header">`);
      html.push(`          <div><span class="badge ${prioBadge}" style="margin-right:0.5rem">${prioText}</span><span class="action-title">${escapeHtml(act.title)}</span></div>`);
      html.push(`          <span class="action-deadline">Frist: ${escapeHtml(act.deadlineText)} (bis ${escapeHtml(act.dueDate)})</span>`);
      html.push(`        </div>`);
      html.push(`        <div class="action-body"><strong>Handlungsanweisung:</strong> ${escapeHtml(act.action)}</div>`);
      html.push(`        <div class="action-body" style="color:#64748b; font-size:0.8rem"><strong>Begründung:</strong> ${escapeHtml(act.reason)}</div>`);
      html.push(`        <div class="action-meta">`);
      html.push(`          <span><strong>SKU:</strong> <code>${escapeHtml(act.sku)}</code></span>`);
      if (act.asin) html.push(`          <span><strong>ASIN:</strong> <code>${escapeHtml(act.asin)}</code></span>`);
      html.push(`          <span><strong>Artikel:</strong> ${escapeHtml(act.productTitle)}</span>`);
      html.push(`          <span><strong>Rechtsgrundlage:</strong> ${escapeHtml(act.legalBasis)}</span>`);
      html.push(`        </div>`);
      html.push(`      </div>`);
    }
  }

  // Artikelliste
  html.push(`      <h2 style="margin-top:2.5rem">Geprüfte Artikel (${report.items.length})</h2>`);
  html.push(`      <div class="table-container">`);
  html.push(`        <table>`);
  html.push(`          <thead>`);
  html.push(`            <tr>`);
  html.push(`              <th>Status</th>`);
  html.push(`              <th>SKU / ASIN</th>`);
  html.push(`              <th>Produktbezeichnung</th>`);
  html.push(`              <th>Barcode</th>`);
  html.push(`              <th>Fuzzy</th>`);
  html.push(`              <th>GPSR</th>`);
  html.push(`              <th>Befund & Handlungsempfehlung</th>`);
  html.push(`            </tr>`);
  html.push(`          </thead>`);
  html.push(`          <tbody>`);
  for (const item of report.items) {
    const badgeClass = item.trafficLight === 'RED' ? 'badge-red' : item.trafficLight === 'YELLOW' ? 'badge-yellow' : 'badge-green';
    const badgeText = item.trafficLightGerman.toUpperCase();
    const bcText = item.barcode.matched ? '<span style="color:var(--red-600); font-weight:700">TREFFER</span>' : '<span style="color:#94a3b8">—</span>';
    const fzText = item.fuzzy.matched ? `<strong>${Math.round(item.fuzzy.score * 100)}%</strong>` : '<span style="color:#94a3b8">—</span>';
    const gpsrText = item.gpsr.checked ? `<strong>${item.gpsr.score}%</strong> (${item.gpsr.gapsCount} Lücken)` : '<span style="color:#94a3b8">—</span>';

    html.push(`            <tr>`);
    html.push(`              <td><span class="badge ${badgeClass}">${badgeText}</span></td>`);
    html.push(`              <td><code>${escapeHtml(item.sku)}</code>${item.asin ? `<br><small style="color:#64748b">${escapeHtml(item.asin)}</small>` : ''}</td>`);
    html.push(`              <td><strong>${escapeHtml(item.title)}</strong>${item.brand ? `<br><small style="color:#64748b">Marke: ${escapeHtml(item.brand)}</small>` : ''}</td>`);
    html.push(`              <td>${bcText}</td>`);
    html.push(`              <td>${fzText}</td>`);
    html.push(`              <td>${gpsrText}</td>`);
    html.push(`              <td><div>${escapeHtml(item.statusReason)}</div><div style="font-size:0.75rem; color:#64748b; margin-top:0.25rem"><em>${escapeHtml(item.recommendedAction)}</em></div></td>`);
    html.push(`            </tr>`);
  }
  html.push(`          </tbody>`);
  html.push(`        </table>`);
  html.push(`      </div>`);

  // Disclaimer Box
  html.push(`      <div class="disclaimer-box">`);
  html.push(`        <h3>Wichtige Hinweise &amp; Gesetzlicher Haftungsausschluss (§ 2 RDG)</h3>`);
  html.push(`        <p><strong>Sicherheits-Hinweis:</strong> ${escapeHtml(report.zeroHitsNote)}</p>`);
  for (const p of report.disclaimer.split('\n\n')) {
    html.push(`        <p>${escapeHtml(p)}</p>`);
  }
  html.push(`      </div>`);

  html.push(`    </div>`);
  html.push(`  </div>`);
  html.push(`</body>`);
  html.push(`</html>`);

  return html.join('\n');
}

// ============================================================================
// 9. FORMAT-GENERATOR: DATENBANKKOMPATIBLE XLSX-AUSGABE (AK4)
// ============================================================================

function colToLetter(colIndex: number): string {
  let temp = colIndex;
  let letter = '';
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
}

function escapeXml(str: unknown): string {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function crc32(buf: Buffer): number {
  let crc = ~0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (~crc) >>> 0;
}

interface ZipFileEntry {
  name: string;
  content: string | Buffer;
}

function createZipArchive(files: ZipFileEntry[]): Uint8Array {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const contentBuf = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const crc = crc32(contentBuf);
    const compressed = zlib.deflateRawSync(contentBuf);

    // Local Header
    const lh = Buffer.alloc(30 + nameBuf.length);
    lh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // utf8 flag
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(contentBuf.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    nameBuf.copy(lh, 30);
    localHeaders.push(lh, compressed);

    // Central Directory Header
    const ch = Buffer.alloc(46 + nameBuf.length);
    ch.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0x0800, 8); // utf8 flag
    ch.writeUInt16LE(8, 10); // deflate
    ch.writeUInt16LE(0, 12); // time
    ch.writeUInt16LE(0, 14); // date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(contentBuf.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk start
    ch.writeUInt16LE(0, 36); // int attr
    ch.writeUInt32LE(0, 38); // ext attr
    ch.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(ch, 46);
    centralHeaders.push(ch);

    offset += lh.length + compressed.length;
  }

  const centralDirOffset = offset;
  let centralDirSize = 0;
  for (const ch of centralHeaders) {
    centralDirSize += ch.length;
  }

  // End of Central Directory Record (EOCD)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk start
  eocd.writeUInt16LE(files.length, 8); // total entries disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralDirSize, 12);
  eocd.writeUInt32LE(centralDirOffset, 16);
  eocd.writeUInt16LE(0, 20);

  const totalBuffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd]);
  return new Uint8Array(totalBuffer);
}

/**
 * Sanitizes a string value against CSV/Excel Formula Injection (CWE-1236).
 * If a cell string starts with '=', '+', '-', '@', '\t', or '\r', Excel executes it as a formula.
 * Prepending an apostrophe (') forces Excel to treat the cell strictly as plain text.
 */
export function sanitizeXlsxFormulaInjection(val: string): string {
  if (!val) return '';
  if (/^[=+\-@\t\r\n＝＋－＠]/.test(val) || /^[=+\-@＝＋－＠]/.test(val.trimStart())) {
    return `'${val}`;
  }
  return val;
}

function buildWorksheetXml(rows: (string | number | boolean | null | undefined)[][]): string {
  const xml: string[] = [];
  xml.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`);
  xml.push(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`);
  xml.push(`  <sheetData>`);

  for (let rIdx = 0; rIdx < rows.length; rIdx++) {
    const row = rows[rIdx];
    const rowNum = rIdx + 1;
    xml.push(`    <row r="${rowNum}">`);

    for (let cIdx = 0; cIdx < row.length; cIdx++) {
      const val = row[cIdx];
      const cellRef = `${colToLetter(cIdx)}${rowNum}`;

      if (val === null || val === undefined || val === '') {
        continue;
      }

      if (typeof val === 'number') {
        xml.push(`      <c r="${cellRef}"><v>${val}</v></c>`);
      } else if (typeof val === 'boolean') {
        xml.push(`      <c r="${cellRef}" t="b"><v>${val ? 1 : 0}</v></c>`);
      } else {
        const safeVal = sanitizeXlsxFormulaInjection(String(val));
        xml.push(`      <c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(safeVal)}</t></is></c>`);
      }
    }

    xml.push(`    </row>`);
  }

  xml.push(`  </sheetData>`);
  xml.push(`</worksheet>`);
  return xml.join('\n');
}

/**
 * Erzeugt einen standardkonformen, datenbankkompatiblen OpenXML Excel-Bericht (.xlsx).
 */
export function generateXlsxReport(report: B2BAuditReport): Uint8Array {
  const s = report.summary;

  // Sheet 1: Übersicht (Summary / Key Metrics)
  const sheet1Rows: (string | number | boolean | null | undefined)[][] = [
    ['METRIC_KEY', 'METRIC_LABEL', 'VALUE', 'UNIT_NOTE'],
    ['report_id', 'Audit Report ID', report.id, 'String'],
    ['merchant_name', 'Mandant / Händler', report.merchantName, 'String'],
    ['marketplace', 'Marktplatz', report.marketplace || 'Amazon.de', 'String'],
    ['report_date', 'Prüfdatum', report.reportDate, 'DD.MM.YYYY'],
    ['safety_gate_date', 'Datenstand EU Safety Gate', report.safetyGateDate, 'DD.MM.YYYY'],
    ['overall_traffic_light', 'Gesamt-Ampel', s.overallTrafficLight, 'RED | YELLOW | GREEN'],
    ['compliance_rate', 'Compliance-Quote', s.complianceRate, '%'],
    ['total_items', 'Geprüfte Artikel gesamt', s.totalItems, 'Count'],
    ['red_items_count', 'Akute Treffer (Rot)', s.redCount, 'Count'],
    ['yellow_items_count', 'Prüffälle / Nachpflege (Gelb)', s.yellowCount, 'Count'],
    ['green_items_count', 'Konform (Grün)', s.greenCount, 'Count'],
    ['barcode_hits_count', 'Barcode-Treffer (RAPEX)', s.barcodeHitsCount, 'Count'],
    ['fuzzy_matches_count', 'Fuzzy-Matches gesamt', s.fuzzyMatchesCount.total, 'Count'],
    ['fuzzy_red_count', 'Fuzzy-Matches >= 85%', s.fuzzyMatchesCount.red, 'Count'],
    ['fuzzy_yellow_count', 'Fuzzy-Matches 65-84%', s.fuzzyMatchesCount.yellow, 'Count'],
    ['gpsr_avg_score', 'GPSR Durchschnitts-Score', s.gpsrSummary.averageScore, '%'],
    ['gpsr_compliant_count', 'GPSR konforme Artikel', s.gpsrSummary.compliantCount, 'Count'],
    ['gpsr_gaps_count', 'GPSR Lücken gesamt', s.gpsrSummary.totalGapsCount, 'Count'],
    ['total_actions_count', 'Maßnahmen gesamt', s.totalActionsCount, 'Count'],
    ['critical_actions_count', 'Sofort-Maßnahmen (P1)', s.criticalActionsCount, 'Count'],
    ['legal_disclaimer', 'Disclaimer (§ 2 RDG)', DISCLAIMER_LEGAL_NOTICE, 'Legal Text'],
    ['zero_hits_note', 'Sicherheitshinweis', report.zeroHitsNote, 'Legal Text'],
  ];

  // Sheet 2: Artikelliste (Audit Items, 100% datenbankkompatible Spalten für SQL/ETL)
  const sheet2Rows: (string | number | boolean | null | undefined)[][] = [
    [
      'item_id',
      'sku',
      'asin',
      'ean',
      'title',
      'brand',
      'model',
      'category',
      'traffic_light',
      'traffic_light_de',
      'status_label',
      'barcode_matched',
      'barcode_alert_number',
      'fuzzy_matched',
      'fuzzy_score',
      'fuzzy_classification',
      'gpsr_checked',
      'gpsr_score',
      'gpsr_status',
      'gpsr_gaps_count',
      'priority_level',
      'recommended_action',
      'status_reason',
      'checked_at',
    ],
  ];

  for (const it of report.items) {
    sheet2Rows.push([
      it.id,
      it.sku,
      it.asin || null,
      it.ean || null,
      it.title,
      it.brand || null,
      it.model || null,
      it.category || null,
      it.trafficLight,
      it.trafficLightGerman,
      it.statusLabel,
      it.barcode.matched,
      it.barcode.details?.alertNumber || null,
      it.fuzzy.matched,
      it.fuzzy.score,
      it.fuzzy.classification || null,
      it.gpsr.checked,
      it.gpsr.score,
      it.gpsr.status,
      it.gpsr.gapsCount,
      it.priorityLevel,
      it.recommendedAction,
      it.statusReason,
      report.reportDate,
    ]);
  }

  // Sheet 3: Maßnahmenliste (Action Items, Foreign Key sku / asin)
  const sheet3Rows: (string | number | boolean | null | undefined)[][] = [
    [
      'action_id',
      'order_index',
      'priority',
      'urgency',
      'deadline_hours',
      'deadline_text',
      'due_date',
      'category',
      'sku',
      'asin',
      'ean',
      'product_title',
      'action_title',
      'action_instructions',
      'reason',
      'legal_basis',
    ],
  ];

  for (const act of report.actions) {
    sheet3Rows.push([
      act.id,
      act.orderIndex,
      act.priority,
      act.urgency,
      act.deadlineHours,
      act.deadlineText,
      act.dueDate,
      act.category,
      act.sku,
      act.asin || null,
      act.ean || null,
      act.productTitle,
      act.title,
      act.action,
      act.reason,
      act.legalBasis,
    ]);
  }

  // Sheet 4: GPSR-Lücken (Gaps Detailtabelle)
  const sheet4Rows: (string | number | boolean | null | undefined)[][] = [
    [
      'gap_id',
      'sku',
      'asin',
      'article',
      'severity',
      'field',
      'article_citation',
      'message',
      'remediation',
    ],
  ];

  let gapCounter = 1;
  for (const it of report.items) {
    for (const g of it.gpsr.gaps) {
      sheet4Rows.push([
        `GAP-${String(gapCounter++).padStart(4, '0')}`,
        it.sku,
        it.asin || null,
        g.article,
        g.severity,
        g.field,
        g.articleCitation,
        g.message,
        g.remediation,
      ]);
    }
  }

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
  <Relationship Id="rIdStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Uebersicht" sheetId="1" r:id="rId1"/>
    <sheet name="Artikelliste" sheetId="2" r:id="rId2"/>
    <sheet name="Massnahmen" sheetId="3" r:id="rId3"/>
    <sheet name="GPSR_Luecken" sheetId="4" r:id="rId4"/>
  </sheets>
</workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1">
    <border><left/><right/><top/><bottom/><diagonal/></border>
  </borders>
  <cellStyleXfs count="1">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>
  </cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
</styleSheet>`;

  const files: ZipFileEntry[] = [
    { name: '[Content_Types].xml', content: contentTypes },
    { name: '_rels/.rels', content: rels },
    { name: 'xl/_rels/workbook.xml.rels', content: workbookRels },
    { name: 'xl/workbook.xml', content: workbook },
    { name: 'xl/styles.xml', content: styles },
    { name: 'xl/worksheets/sheet1.xml', content: buildWorksheetXml(sheet1Rows) },
    { name: 'xl/worksheets/sheet2.xml', content: buildWorksheetXml(sheet2Rows) },
    { name: 'xl/worksheets/sheet3.xml', content: buildWorksheetXml(sheet3Rows) },
    { name: 'xl/worksheets/sheet4.xml', content: buildWorksheetXml(sheet4Rows) },
  ];

  return createZipArchive(files);
}
