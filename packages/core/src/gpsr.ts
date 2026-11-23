/**
 * GPSR Listing-Readiness & Compliance Checker
 * Gemäß Verordnung (EU) 2023/988 über die allgemeine Produktsicherheit (General Product Safety Regulation - GPSR)
 *
 * Prüft Marketplace-Listings (z.B. Amazon, eBay, Kaufland) auf:
 * - EU-Responsible Person (Art. 16, Art. 19 Abs. 1 lit. b)
 * - Herstellerkontakt & Handelsmarke (Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a)
 * - Produkt- und Typidentifikation (Art. 9 Abs. 5, Art. 19 Abs. 1 lit. c)
 * - Sicherheits- und Warnhinweise sowie CE-Kennzeichnung (Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d)
 */

export type GpsrArticle =
  | 'Art. 9'
  | 'Art. 9(1)'
  | 'Art. 9(2)'
  | 'Art. 9(5)'
  | 'Art. 9(7)'
  | 'Art. 16'
  | 'Art. 16(1)'
  | 'Art. 19'
  | 'Art. 19(1)(a)'
  | 'Art. 19(1)(b)'
  | 'Art. 19(1)(c)'
  | 'Art. 19(1)(d)';

export type GpsrSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type GpsrComplianceStatus = 'COMPLIANT' | 'PARTIALLY_COMPLIANT' | 'NON_COMPLIANT';

export type GpsrTrafficLight = 'GREEN' | 'YELLOW' | 'RED';

/**
 * 27 EU-Mitgliedstaaten (ISO 3166-1 Alpha-2 und Alpha-3 sowie deutsche/englische Bezeichnungen)
 */
export const EU_COUNTRY_CODES = new Set<string>([
  'AT', 'AUT',
  'BE', 'BEL',
  'BG', 'BGR',
  'CY', 'CYP',
  'CZ', 'CZE',
  'DE', 'DEU',
  'DK', 'DNK',
  'EE', 'EST',
  'ES', 'ESP',
  'FI', 'FIN',
  'FR', 'FRA',
  'GR', 'GRC', 'EL',
  'HR', 'HRV',
  'HU', 'HUN',
  'IE', 'IRL',
  'IT', 'ITA',
  'LT', 'LTU',
  'LU', 'LUX',
  'LV', 'LVA',
  'MT', 'MLT',
  'NL', 'NLD',
  'PL', 'POL',
  'PT', 'PRT',
  'RO', 'ROU',
  'SE', 'SWE',
  'SI', 'SVN',
  'SK', 'SVK',
]);

export const EU_COUNTRY_NAMES = [
  'deutschland', 'germany', 'allemagne',
  'österreich', 'oesterreich', 'austria', 'autriche',
  'frankreich', 'france',
  'italien', 'italy', 'italia',
  'spanien', 'spain', 'españa', 'espana',
  'niederlande', 'netherlands', 'pays-bas', 'holland',
  'polen', 'poland', 'polska',
  'belgien', 'belgium', 'belgique',
  'schweden', 'sweden', 'suede',
  'dänemark', 'daenemark', 'denmark',
  'finnland', 'finland',
  'irland', 'ireland',
  'portugal',
  'griechenland', 'greece',
  'tschechien', 'tschechische republik', 'czech republic', 'czechia',
  'ungarn', 'hungary',
  'rumänien', 'rumaenien', 'romania',
  'bulgarien', 'bulgaria',
  'slowakei', 'slovakia',
  'kroatien', 'croatia',
  'litauen', 'lithuania',
  'slowenien', 'slovenia',
  'lettland', 'latvia',
  'estland', 'estonia',
  'zypern', 'cyprus',
  'luxemburg', 'luxembourg',
  'malta',
];

const NON_EU_INDICATORS = [
  'united states', 'usa', 'u.s.a.', 'china', 'prc', 'united kingdom', 'great britain',
  'uk', 'england', 'scotland', 'wales', 'schweiz', 'switzerland', 'turkey', 'türkei',
  'hong kong', 'taiwan', 'japan', 'canada', 'australia', 'singapore', 'india',
];

/**
 * Strukturierte Eingabedaten für die EU-Verantwortliche Person (Art. 16, Art. 19 Abs. 1 lit. b)
 */
export interface GpsrResponsiblePerson {
  name?: string;
  address?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  email?: string;
  contactUrl?: string;
  phone?: string;
}

/**
 * Strukturierte Angaben des Herstellers (Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a)
 */
export interface GpsrManufacturer {
  name?: string;
  brand?: string;
  address?: string;
  street?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  email?: string;
  website?: string;
  contactUrl?: string;
  phone?: string;
}

/**
 * Produkt- und Typidentifikation (Art. 9 Abs. 5, Art. 19 Abs. 1 lit. c)
 */
export interface GpsrProductIdentifier {
  type?: string;
  modelNumber?: string;
  serialNumber?: string;
  batchNumber?: string;
  partNumber?: string;
  sku?: string;
  asin?: string;
  ean?: string;
  gtin?: string;
  pictureUrl?: string;
}

/**
 * Sicherheits- und Warnhinweise (Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d)
 */
export interface GpsrSafetyInformation {
  warnings?: string | string[];
  safetyInstructions?: string | string[];
  ceMarking?: boolean | string;
  hasCeMarking?: boolean;
  pictograms?: string | string[];
  language?: string;
}

/**
 * Eingabe-Interface für den GPSR Listing-Checker
 */
export interface GpsrListingInput {
  id?: string;
  sku?: string;
  asin?: string;
  title?: string;
  category?: string;

  // Strukturierte Objekte
  responsiblePerson?: GpsrResponsiblePerson | null;
  manufacturer?: GpsrManufacturer | null;
  productIdentifier?: GpsrProductIdentifier | null;
  safetyInformation?: GpsrSafetyInformation | null;

  // Flache Alias-Felder für Marketplace-Exports (Amazon / CSV / TSV)
  responsiblePersonName?: string;
  responsiblePersonAddress?: string;
  responsiblePersonCountry?: string;
  responsiblePersonEmail?: string;
  responsiblePersonContactUrl?: string;

  manufacturerName?: string;
  manufacturerBrand?: string;
  manufacturerAddress?: string;
  manufacturerCountry?: string;
  manufacturerEmail?: string;
  manufacturerWebsite?: string;

  productType?: string;
  modelNumber?: string;
  batchNumber?: string;
  ean?: string;
  gtin?: string;

  warnings?: string | string[];
  safetyInstructions?: string | string[];
  ceMarking?: boolean | string;
  hasCeMarking?: boolean;
  pictograms?: string | string[];

  // Rohe Marketplace-Felder
  raw?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Identifizierte Compliance-Lücke mit präziser Gesetzesreferenz
 */
export interface GpsrGap {
  code: string;
  field: string;
  severity: GpsrSeverity;
  article: GpsrArticle;
  articleCitation: string;
  message: string;
  remediation: string;
}

/**
 * Prüfdetails für die 4 GPSR-Hauptbereiche
 */
export interface GpsrSectionResults {
  responsiblePerson: {
    passed: boolean;
    score: number;
    maxScore: number;
    details: {
      hasName: boolean;
      hasEuPostalAddress: boolean;
      hasElectronicContact: boolean;
    };
  };
  manufacturer: {
    passed: boolean;
    score: number;
    maxScore: number;
    details: {
      hasNameOrBrand: boolean;
      hasPostalAddress: boolean;
      hasElectronicContact: boolean;
    };
  };
  productIdentification: {
    passed: boolean;
    score: number;
    maxScore: number;
    details: {
      hasTypeOrCategory: boolean;
      hasModelOrIdentifier: boolean;
    };
  };
  safetyAndWarnings: {
    passed: boolean;
    score: number;
    maxScore: number;
    details: {
      hasSafetyWarnings: boolean;
      hasCeMarking: boolean;
    };
  };
}

/**
 * Vollständiger GPSR-Compliance-Bericht für ein Listing
 */
export interface GpsrReadinessReport {
  listingId?: string;
  sku?: string;
  asin?: string;
  title?: string;
  score: number; // 0 bis 100
  status: GpsrComplianceStatus;
  trafficLight: GpsrTrafficLight;
  isCompliant: boolean;
  gaps: GpsrGap[];
  sections: GpsrSectionResults;
  summary: {
    criticalGapsCount: number;
    highGapsCount: number;
    mediumGapsCount: number;
    lowGapsCount: number;
    totalGapsCount: number;
    checkedAt: string;
  };
}

/**
 * Aggregierter Batch-Report für mehrere Listings
 */
export interface GpsrBatchReport {
  totalListings: number;
  compliantCount: number;
  partiallyCompliantCount: number;
  nonCompliantCount: number;
  averageScore: number;
  trafficLights: {
    green: number;
    yellow: number;
    red: number;
  };
  gapFrequency: Record<string, { count: number; article: string; message: string }>;
  results: GpsrReadinessReport[];
}

/**
 * Konfigurationsoptionen für die GPSR-Prüfung
 */
export interface GpsrCheckOptions {
  requireCeMarking?: boolean;
  strictEuAddress?: boolean;
  weights?: {
    responsiblePerson?: number;
    manufacturer?: number;
    productIdentification?: number;
    safetyAndWarnings?: number;
  };
}

/**
 * Prüft, ob ein übergebener String eine gültige E-Mail-Adresse darstellt.
 */
export function isValidEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const trimmed = email.trim();
  if (trimmed.length < 5 || trimmed.length > 254) return false;
  return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/.test(
    trimmed
  );
}

/**
 * Prüft, ob ein übergebener String eine gültige URL oder Kontakt-Webseite darstellt.
 */
export function isValidContactUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length < 4) return false;

  // Erlaubt http://, https:// oder typische Webadressen wie www.example.com/contact
  if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(trimmed)) {
    return true;
  }
  if (/^www\.[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+([/?#]\S*)?$/i.test(trimmed)) {
    return true;
  }
  // Domain + Path (z.B. example.com/kontakt)
  if (/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/\S*)?$/i.test(trimmed) && trimmed.includes('.')) {
    return true;
  }

  return false;
}

/**
 * Validiert einen elektronischen Kontakt (E-Mail oder Kontaktformular/Webadresse).
 */
export function validateElectronicContact(val: unknown): {
  isValid: boolean;
  isEmail: boolean;
  isUrl: boolean;
  cleanValue: string;
} {
  if (typeof val !== 'string') {
    return { isValid: false, isEmail: false, isUrl: false, cleanValue: '' };
  }
  const clean = val.trim();
  if (!clean) {
    return { isValid: false, isEmail: false, isUrl: false, cleanValue: '' };
  }

  const emailOk = isValidEmail(clean);
  if (emailOk) {
    return { isValid: true, isEmail: true, isUrl: false, cleanValue: clean };
  }

  const urlOk = isValidContactUrl(clean);
  if (urlOk) {
    return { isValid: true, isEmail: false, isUrl: true, cleanValue: clean };
  }

  // Erkennung in Freitext mit mailto: oder https://
  const mailtoMatch = clean.match(/mailto:([^\s?]+)/i);
  if (mailtoMatch && isValidEmail(mailtoMatch[1])) {
    return { isValid: true, isEmail: true, isUrl: false, cleanValue: mailtoMatch[1] };
  }

  return { isValid: false, isEmail: false, isUrl: false, cleanValue: clean };
}

/**
 * Prüft, ob ein Land oder eine Adressangabe auf die Europäische Union hinweist.
 */
export function isEuLocation(countryOrAddress: string | undefined | null): boolean {
  if (!countryOrAddress || typeof countryOrAddress !== 'string') return false;
  const text = countryOrAddress.trim().toLowerCase();
  if (!text) return false;

  // Direkter ISO-Code Abgleich
  const upper = text.toUpperCase();
  if (EU_COUNTRY_CODES.has(upper)) {
    return true;
  }

  // Wortgrenzen-Suche nach Ländernamen
  for (const name of EU_COUNTRY_NAMES) {
    const regex = new RegExp(`\\b${name}\\b`, 'i');
    if (regex.test(text)) {
      return true;
    }
  }

  // Abgleich mit 2-Letter ISO Codes im Adresstext (z.B. "D-10115", "DE-10115", ", DE", "DE ")
  const isoMatch = text.match(/\b([a-z]{2})\b/gi);
  if (isoMatch) {
    for (const code of isoMatch) {
      if (EU_COUNTRY_CODES.has(code.toUpperCase())) {
        // Prüfen, ob nicht ein Non-EU Land explizit genannt wird
        let isNonEu = false;
        for (const nonEu of NON_EU_INDICATORS) {
          if (new RegExp(`\\b${nonEu}\\b`, 'i').test(text)) {
            isNonEu = true;
            break;
          }
        }
        if (!isNonEu) return true;
      }
    }
  }

  return false;
}

/**
 * Prüft, ob eine Postanschrift substanziell befüllt ist (keine Platzhalter wie N/A).
 */
export function isSubstantialPostalAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  const clean = address.trim();
  if (clean.length < 8) return false;

  const lower = clean.toLowerCase();
  const placeholders = ['n/a', 'na', 'none', 'keine', 'tbd', 'unknown', 'unbekannt', '-', '--'];
  if (placeholders.includes(lower)) return false;

  return true;
}

/**
 * Prüft auf Vorhandensein einer CE-Kennzeichnung oder Konformitätsangabe.
 */
export function hasCeMarkingIndicator(val: unknown): boolean {
  if (val === true) return true;
  if (val === false || val === null || val === undefined) return false;

  if (typeof val === 'number') return false;

  const str = String(val).trim();
  if (/^(true|yes|ja|1)$/i.test(str)) return true;
  if (/^(false|no|nein|0)$/i.test(str)) return false;

  // Suche nach CE-Markierungsmustern
  if (/\b(ce[- ]?(kennzeichnung|conform|konform|marking|certified|zertifiziert|zertifikat|zeichen))\b/i.test(str)) {
    return true;
  }
  if (/\bce\b/i.test(str) && /(richtlinie|directive|en \d|verordnung|norm)/i.test(str)) {
    return true;
  }
  if (str.toUpperCase() === 'CE') {
    return true;
  }

  return false;
}

/**
 * Extrahiert und normalisiert Text-Arrays für Warn- und Sicherheitshinweise.
 */
export function extractSafetyWarnings(input: unknown): string[] {
  if (!input) return [];

  const rawList: string[] = [];
  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === 'string' && item.trim()) {
        rawList.push(item.trim());
      }
    }
  } else if (typeof input === 'string' && input.trim()) {
    const trimmed = input.trim();
    // Unterteilung bei Semikolon oder Zeilenumbruch
    if (/[\n\r;]/.test(trimmed)) {
      rawList.push(...trimmed.split(/[\n\r;]+/).map((s) => s.trim()).filter(Boolean));
    } else {
      rawList.push(trimmed);
    }
  }

  return rawList.filter((s) => {
    const l = s.toLowerCase();
    return !['none', 'n/a', 'keine', 'nicht erforderlich'].includes(l);
  });
}

/**
 * Normalisiert ein beliebiges Eingabeobjekt in das einheitliche GpsrListingInput-Format.
 */
export function normalizeGpsrInput(rawInput: unknown): GpsrListingInput {
  if (!rawInput || typeof rawInput !== 'object') {
    return {};
  }

  const obj = rawInput as Record<string, unknown>;
  const raw = (obj.raw && typeof obj.raw === 'object' ? obj.raw : obj) as Record<string, unknown>;

  // Hilfsfunktion zur Suche nach String- oder Number-Werten (ignoriert verschachtelte Objekte)
  const findString = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      for (const source of [obj, raw]) {
        if (typeof source[k] === 'string' && source[k].trim() !== '') {
          return (source[k] as string).trim();
        }
        if (typeof source[k] === 'number') {
          return String(source[k]).trim();
        }
      }

      // Case-insensitive & Hyphen-insensitive Suche
      const normalizedK = k.toLowerCase().replace(/[-_]/g, '');
      for (const source of [obj, raw]) {
        for (const [srcKey, srcVal] of Object.entries(source)) {
          if (srcKey.toLowerCase().replace(/[-_]/g, '') === normalizedK) {
            if (typeof srcVal === 'string' && srcVal.trim() !== '') return srcVal.trim();
            if (typeof srcVal === 'number') return String(srcVal).trim();
          }
        }
      }
    }
    return undefined;
  };

  const findValue = (...keys: string[]): unknown => {
    for (const k of keys) {
      if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
      if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') return raw[k];

      const normalizedK = k.toLowerCase().replace(/[-_]/g, '');
      for (const source of [obj, raw]) {
        for (const [srcKey, srcVal] of Object.entries(source)) {
          if (srcKey.toLowerCase().replace(/[-_]/g, '') === normalizedK) {
            if (srcVal !== undefined && srcVal !== null && srcVal !== '') return srcVal;
          }
        }
      }
    }
    return undefined;
  };

  const id = findString('id', 'listingId', 'listing_id') ?? '';
  const sku = findString('sku', 'sellerSku', 'seller_sku', 'seller-sku') ?? '';
  const asin = findString('asin', 'asin1') ?? '';
  const title = findString('title', 'itemName', 'item_name', 'item-name', 'product_name') ?? '';
  const category = findString('category', 'category_name', 'item_type_keyword', 'item-type-keyword') ?? '';

  // 1. EU Responsible Person
  const rpObj = (obj.responsiblePerson && typeof obj.responsiblePerson === 'object' ? obj.responsiblePerson : {}) as Record<string, unknown>;
  const rpName = (typeof rpObj.name === 'string' ? rpObj.name.trim() : '') ||
    findString('responsiblePersonName', 'responsible_person_name', 'rp_name', 'eu_responsible_person') || '';

  const rpAddress = (typeof rpObj.address === 'string' ? rpObj.address.trim() : '') ||
    findString('responsiblePersonAddress', 'responsible_person_address', 'rp_address', 'eu_address') || '';

  const rpCountry = (typeof rpObj.country === 'string' ? rpObj.country.trim() : '') ||
    findString('responsiblePersonCountry', 'responsible_person_country', 'rp_country') || '';

  const rpEmail = (typeof rpObj.email === 'string' ? rpObj.email.trim() : '') ||
    findString('responsiblePersonEmail', 'responsible_person_email', 'rp_email') || '';

  const rpContactUrl = (typeof rpObj.contactUrl === 'string' ? rpObj.contactUrl.trim() : '') ||
    findString('responsiblePersonContactUrl', 'responsible_person_contact_url', 'rp_contact_url', 'rp_url') || '';

  // 2. Manufacturer
  const mfrObj = (obj.manufacturer && typeof obj.manufacturer === 'object' ? obj.manufacturer : {}) as Record<string, unknown>;
  const mfrName = (typeof mfrObj.name === 'string' ? mfrObj.name.trim() : '') ||
    findString('manufacturerName', 'manufacturer_name', 'mfr_name', 'hersteller') || '';

  const mfrBrand = (typeof mfrObj.brand === 'string' ? mfrObj.brand.trim() : '') ||
    findString('manufacturerBrand', 'manufacturer_brand', 'brand', 'marke', 'trade_name') || '';

  const mfrAddress = (typeof mfrObj.address === 'string' ? mfrObj.address.trim() : '') ||
    findString('manufacturerAddress', 'manufacturer_address', 'mfr_address', 'hersteller_adresse') || '';

  const mfrCountry = (typeof mfrObj.country === 'string' ? mfrObj.country.trim() : '') ||
    findString('manufacturerCountry', 'manufacturer_country', 'mfr_country') || '';

  const mfrEmail = (typeof mfrObj.email === 'string' ? mfrObj.email.trim() : '') ||
    findString('manufacturerEmail', 'manufacturer_email', 'mfr_email', 'hersteller_email') || '';

  const mfrWebsite = (typeof mfrObj.website === 'string' ? mfrObj.website.trim() : '') ||
    (typeof mfrObj.contactUrl === 'string' ? mfrObj.contactUrl.trim() : '') ||
    findString('manufacturerWebsite', 'manufacturer_website', 'mfr_website', 'mfr_url', 'hersteller_web') || '';

  // 3. Product Identifier
  const piObj = (obj.productIdentifier && typeof obj.productIdentifier === 'object' ? obj.productIdentifier : {}) as Record<string, unknown>;
  const productType = (typeof piObj.type === 'string' ? piObj.type.trim() : '') ||
    findString('productType', 'product_type', 'type', 'item_type_keyword') || category || '';

  const modelNumber = (typeof piObj.modelNumber === 'string' ? piObj.modelNumber.trim() : '') ||
    findString('modelNumber', 'model_number', 'model', 'modell', 'partNumber', 'part_number') || '';

  const batchNumber = (typeof piObj.batchNumber === 'string' ? piObj.batchNumber.trim() : '') ||
    findString('batchNumber', 'batch_number', 'charge', 'chargennummer', 'serialNumber', 'serial_number') || '';

  const ean = (typeof piObj.ean === 'string' ? piObj.ean.trim() : '') ||
    findString('ean', 'gtin', 'productId', 'product_id', 'product-id') || '';

  // 4. Safety & Warnings & CE Marking
  const siObj = (obj.safetyInformation && typeof obj.safetyInformation === 'object' ? obj.safetyInformation : {}) as Record<string, unknown>;
  const rawWarnings = findValue('warnings', 'safetyWarnings', 'safety_warnings', 'cpsia_cautionary_statement', 'cpsia-cautionary-statement', 'warnhinweise') ?? siObj.warnings;
  const rawSafetyInstructions = findValue('safetyInstructions', 'safety_instructions', 'sicherheitshinweise') ?? siObj.safetyInstructions;

  const rawCe = findValue('ceMarking', 'ce_marking', 'hasCeMarking', 'has_ce_marking', 'ce_certified') ?? siObj.ceMarking ?? siObj.hasCeMarking;
  const ceMarking = hasCeMarkingIndicator(rawCe) || (typeof title === 'string' && hasCeMarkingIndicator(title));

  return {
    id: id || undefined,
    sku: sku || undefined,
    asin: asin || undefined,
    title: title || undefined,
    category: category || undefined,

    responsiblePerson: {
      name: rpName || undefined,
      address: rpAddress || undefined,
      country: rpCountry || undefined,
      email: rpEmail || undefined,
      contactUrl: rpContactUrl || undefined,
    },

    manufacturer: {
      name: mfrName || undefined,
      brand: mfrBrand || undefined,
      address: mfrAddress || undefined,
      country: mfrCountry || undefined,
      email: mfrEmail || undefined,
      website: mfrWebsite || undefined,
    },

    productIdentifier: {
      type: productType || undefined,
      modelNumber: modelNumber || undefined,
      batchNumber: batchNumber || undefined,
      ean: ean || undefined,
      asin: asin || undefined,
      sku: sku || undefined,
    },

    safetyInformation: {
      warnings: extractSafetyWarnings(rawWarnings),
      safetyInstructions: extractSafetyWarnings(rawSafetyInstructions),
      ceMarking,
      hasCeMarking: ceMarking,
    },

    raw,
  };
}

/**
 * Führt den GPSR Listing-Readiness & Compliance Check für ein einzelnes Marketplace-Listing durch.
 *
 * Prüfmatrix:
 * 1. EU-Responsible Person (Art. 16, Art. 19 Abs. 1 lit. b): Name, postalische EU-Adresse, E-Mail/Kontaktformular.
 * 2. Herstellerkontakt (Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a): Name/Handelsmarke, Anschrift, E-Mail/Website.
 * 3. Produktkennzeichnung (Art. 9 Abs. 5, Art. 19 Abs. 1 lit. c): Typ/Kategorie, Modell-/Chargen-/Seriennummer/EAN.
 * 4. Sicherheitshinweise & Warnhinweise (Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d): Warnhinweise, CE-Kennzeichnung.
 */
export function checkGpsrListing(
  listing: GpsrListingInput | Record<string, unknown>,
  options: GpsrCheckOptions = {}
): GpsrReadinessReport {
  const norm = normalizeGpsrInput(listing);
  const gaps: GpsrGap[] = [];

  const weightRp = options.weights?.responsiblePerson ?? 30;
  const weightMfr = options.weights?.manufacturer ?? 30;
  const weightId = options.weights?.productIdentification ?? 20;
  const weightSafe = options.weights?.safetyAndWarnings ?? 20;

  // =========================================================================
  // 1. EU-RESPONSIBLE PERSON (Art. 16, Art. 19 Abs. 1 lit. b)
  // Max Punkte: weightRp (Standard 30 Punkte: je 10 für Name, EU-Adresse, E-Mail/Kontakt)
  // =========================================================================
  const rp = norm.responsiblePerson ?? {};
  let rpPoints = 0;
  const rpSubPoint = weightRp / 3;

  // 1a. Name der verantwortlichen Person
  const hasRpName = Boolean(rp.name && rp.name.trim().length >= 2);
  if (hasRpName) {
    rpPoints += rpSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_RESPONSIBLE_PERSON_NAME',
      field: 'responsiblePerson.name',
      severity: 'CRITICAL',
      article: 'Art. 16',
      articleCitation: 'GPSR Art. 16 Abs. 1 & Art. 19 Abs. 1 lit. b',
      message: 'Fehlender Name der EU-Verantwortlichen Person im Marketplace-Listing.',
      remediation: 'Namen oder eingetragene Firma des in der EU niedergelassenen Wirtschaftsakteurs hinterlegen.',
    });
  }

  // 1b. Postalische EU-Adresse
  const hasRpAddress = Boolean(rp.address && isSubstantialPostalAddress(rp.address));
  const fullRpAddressStr = `${rp.address ?? ''} ${rp.city ?? ''} ${rp.country ?? ''}`.trim();
  const isAddressInEu = isEuLocation(rp.country) || isEuLocation(fullRpAddressStr);

  if (hasRpAddress && isAddressInEu) {
    rpPoints += rpSubPoint;
  } else if (!hasRpAddress) {
    gaps.push({
      code: 'MISSING_RESPONSIBLE_PERSON_ADDRESS',
      field: 'responsiblePerson.address',
      severity: 'CRITICAL',
      article: 'Art. 16',
      articleCitation: 'GPSR Art. 16 Abs. 1 & Art. 19 Abs. 1 lit. b',
      message: 'Fehlende postalische Anschrift der EU-Verantwortlichen Person.',
      remediation: 'Vollständige Straßenadresse inkl. PLZ, Ort und EU-Mitgliedsstaat angeben.',
    });
  } else {
    // Adresse vorhanden, aber nicht innerhalb der Europäischen Union
    gaps.push({
      code: 'RESPONSIBLE_PERSON_NOT_IN_EU',
      field: 'responsiblePerson.address',
      severity: 'CRITICAL',
      article: 'Art. 16(1)',
      articleCitation: 'GPSR Art. 16 Abs. 1 & Art. 19 Abs. 1 lit. b',
      message: 'Die angegebene Anschrift der verantwortlichen Person befindet sich nicht in der EU.',
      remediation: 'Es muss zwingend ein in einem EU-Mitgliedsstaat ansässiger Wirtschaftsakteur benannt werden.',
    });
  }

  // 1c. Elektronische Kontaktadresse (E-Mail oder Webformular)
  const rpEmailValidation = validateElectronicContact(rp.email);
  const rpUrlValidation = validateElectronicContact(rp.contactUrl);
  const hasRpElectronicContact = rpEmailValidation.isValid || rpUrlValidation.isValid;

  if (hasRpElectronicContact) {
    rpPoints += rpSubPoint;
  } else if (!rp.email && !rp.contactUrl) {
    gaps.push({
      code: 'MISSING_RESPONSIBLE_PERSON_ELECTRONIC_CONTACT',
      field: 'responsiblePerson.email',
      severity: 'HIGH',
      article: 'Art. 16',
      articleCitation: 'GPSR Art. 16 Abs. 1 & Art. 19 Abs. 1 lit. b',
      message: 'Fehlende elektronische Kontaktadresse (E-Mail oder Kontaktformular) der EU-Verantwortlichen Person.',
      remediation: 'Gültige E-Mail-Adresse oder URL eines Online-Kontaktformulars der verantwortlichen Person bereitstellen.',
    });
  } else {
    gaps.push({
      code: 'INVALID_RESPONSIBLE_PERSON_ELECTRONIC_CONTACT',
      field: 'responsiblePerson.email',
      severity: 'HIGH',
      article: 'Art. 16',
      articleCitation: 'GPSR Art. 16 Abs. 1 & Art. 19 Abs. 1 lit. b',
      message: 'Ungültiges Format der elektronischen Kontaktadresse der EU-Verantwortlichen Person.',
      remediation: 'E-Mail-Adresse (z.B. compliance@example.eu) oder Web-URL im korrekten Format angeben.',
    });
  }

  // =========================================================================
  // 2. HERSTELLERKONTAKT (Art. 9 Abs. 1/2, Art. 19 Abs. 1 lit. a)
  // Max Punkte: weightMfr (Standard 30 Punkte: je 10 für Name/Marke, Postanschrift, Kontakt)
  // =========================================================================
  const mfr = norm.manufacturer ?? {};
  let mfrPoints = 0;
  const mfrSubPoint = weightMfr / 3;

  // 2a. Name oder eingetragene Handelsmarke
  const hasMfrNameOrBrand = Boolean(
    (mfr.name && mfr.name.trim().length >= 2) || (mfr.brand && mfr.brand.trim().length >= 2)
  );
  if (hasMfrNameOrBrand) {
    mfrPoints += mfrSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_MANUFACTURER_NAME',
      field: 'manufacturer.name',
      severity: 'CRITICAL',
      article: 'Art. 9(1)',
      articleCitation: 'GPSR Art. 9 Abs. 1 & Art. 19 Abs. 1 lit. a',
      message: 'Fehlender Herstellername bzw. fehlende eingetragene Handelsmarke.',
      remediation: 'Namen, Handelsnamen oder eingetragene Marke des Herstellers angeben.',
    });
  }

  // 2b. Postalische Anschrift des Herstellers
  const hasMfrAddress = Boolean(mfr.address && isSubstantialPostalAddress(mfr.address));
  if (hasMfrAddress) {
    mfrPoints += mfrSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_MANUFACTURER_ADDRESS',
      field: 'manufacturer.address',
      severity: 'HIGH',
      article: 'Art. 9(1)',
      articleCitation: 'GPSR Art. 9 Abs. 1 & Art. 19 Abs. 1 lit. a',
      message: 'Fehlende oder unvollständige postalische Anschrift des Herstellers.',
      remediation: 'Vollständige Postanschrift des Herstellers (Straße, Hausnummer, PLZ, Ort, Land) angeben.',
    });
  }

  // 2c. Elektronische Kontaktadresse (E-Mail oder Website)
  const mfrEmailValidation = validateElectronicContact(mfr.email);
  const mfrWebValidation = validateElectronicContact(mfr.website ?? mfr.contactUrl);
  const hasMfrElectronicContact = mfrEmailValidation.isValid || mfrWebValidation.isValid;

  if (hasMfrElectronicContact) {
    mfrPoints += mfrSubPoint;
  } else if (!mfr.email && !mfr.website && !mfr.contactUrl) {
    gaps.push({
      code: 'MISSING_MANUFACTURER_ELECTRONIC_CONTACT',
      field: 'manufacturer.email',
      severity: 'HIGH',
      article: 'Art. 9(1)',
      articleCitation: 'GPSR Art. 9 Abs. 1 & Art. 19 Abs. 1 lit. a',
      message: 'Fehlende elektronische Kontaktadresse (E-Mail oder Website) des Herstellers.',
      remediation: 'Elektronische Adresse (E-Mail-Adresse oder Website) des Herstellers hinterlegen.',
    });
  } else {
    gaps.push({
      code: 'INVALID_MANUFACTURER_ELECTRONIC_CONTACT',
      field: 'manufacturer.email',
      severity: 'HIGH',
      article: 'Art. 9(1)',
      articleCitation: 'GPSR Art. 9 Abs. 1 & Art. 19 Abs. 1 lit. a',
      message: 'Ungültige elektronische Kontaktadresse des Herstellers.',
      remediation: 'Syntaktisch valide E-Mail-Adresse oder Web-URL des Herstellers angeben.',
    });
  }

  // =========================================================================
  // 3. PRODUKT- UND TYPIDENTIFIKATION (Art. 9 Abs. 5, Art. 19 Abs. 1 lit. c)
  // Max Punkte: weightId (Standard 20 Punkte: je 10 für Typ/Kategorie und Identifikationsmerkmal)
  // =========================================================================
  const pi = norm.productIdentifier ?? {};
  let idPoints = 0;
  const idSubPoint = weightId / 2;

  // 3a. Produktart / Typ / Kategorie
  const hasProductType = Boolean(
    (pi.type && pi.type.trim().length >= 2) || (norm.title && norm.title.trim().length >= 3)
  );
  if (hasProductType) {
    idPoints += idSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_PRODUCT_TYPE',
      field: 'productIdentifier.type',
      severity: 'MEDIUM',
      article: 'Art. 9(5)',
      articleCitation: 'GPSR Art. 9 Abs. 5 & Art. 19 Abs. 1 lit. c',
      message: 'Fehlende Typenbezeichnung oder Produktbeschreibung zur Identifikation.',
      remediation: 'Eindeutigen Produkttyp oder detaillierten Artikeltitel im Listing bereitstellen.',
    });
  }

  // 3b. Modell-, Chargen-, Seriennummer, EAN oder ASIN
  const hasModelOrIdentifier = Boolean(
    pi.modelNumber || pi.batchNumber || pi.serialNumber || pi.partNumber || pi.ean || pi.asin || norm.sku
  );
  if (hasModelOrIdentifier) {
    idPoints += idSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_PRODUCT_IDENTIFIER',
      field: 'productIdentifier.modelNumber',
      severity: 'HIGH',
      article: 'Art. 9(5)',
      articleCitation: 'GPSR Art. 9 Abs. 5 & Art. 19 Abs. 1 lit. c',
      message: 'Fehlendes Identifikationsmerkmal (Modell-, Chargen-, Seriennummer, GTIN/EAN oder ASIN).',
      remediation: 'Modellnummer, Chargennummer, EAN oder ASIN zur eindeutigen Identifizierbarkeit angeben.',
    });
  }

  // =========================================================================
  // 4. SICHERHEITSHINWEISE, WARNHINWEISE & CE-KENNZEICHNUNG (Art. 9 Abs. 7, Art. 19 Abs. 1 lit. d)
  // Max Punkte: weightSafe (Standard 20 Punkte: je 10 für Warnungen und CE-Markierung)
  // =========================================================================
  const si = norm.safetyInformation ?? {};
  let safePoints = 0;
  const safeSubPoint = weightSafe / 2;

  // 4a. Sicherheitswarnungen und Gefahrenhinweise
  const warningsList = extractSafetyWarnings(si.warnings);
  const instructionsList = extractSafetyWarnings(si.safetyInstructions);
  const hasSafetyWarnings = warningsList.length > 0 || instructionsList.length > 0;

  if (hasSafetyWarnings) {
    safePoints += safeSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_SAFETY_WARNINGS',
      field: 'safetyInformation.warnings',
      severity: 'HIGH',
      article: 'Art. 9(7)',
      articleCitation: 'GPSR Art. 9 Abs. 7 & Art. 19 Abs. 1 lit. d',
      message: 'Keine Sicherheitswarnungen oder Warnhinweise im Marketplace-Angebot hinterlegt.',
      remediation: 'Produktspezifische Warnhinweise (z.B. Erstickungsgefahr, Altersbeschränkungen) im Listing veröffentlichen.',
    });
  }

  // 4b. CE-Konformitätskennzeichnung
  const hasCeMarking = Boolean(si.hasCeMarking ?? si.ceMarking);
  const requireCe = options.requireCeMarking !== false;

  if (hasCeMarking || !requireCe) {
    safePoints += safeSubPoint;
  } else {
    gaps.push({
      code: 'MISSING_CE_MARKING',
      field: 'safetyInformation.ceMarking',
      severity: 'MEDIUM',
      article: 'Art. 9(7)',
      articleCitation: 'GPSR Art. 9 Abs. 7 & Art. 19 Abs. 1 lit. d',
      message: 'Keine CE-Konformitätskennzeichnung oder Konformitätsbestätigung angegeben.',
      remediation: 'Angabe der CE-Kennzeichnung oder Konformitätserklärung für harmonisierte EU-Produktbereiche ergänzen.',
    });
  }

  // =========================================================================
  // READINESS-SCORE & AMPELSTATUS BERECHNUNG (0 - 100 %)
  // =========================================================================
  const totalScoreRaw = rpPoints + mfrPoints + idPoints + safePoints;
  const score = Math.max(0, Math.min(100, Math.round(totalScoreRaw)));

  const criticalGapsCount = gaps.filter((g) => g.severity === 'CRITICAL').length;
  const highGapsCount = gaps.filter((g) => g.severity === 'HIGH').length;
  const mediumGapsCount = gaps.filter((g) => g.severity === 'MEDIUM').length;
  const lowGapsCount = gaps.filter((g) => g.severity === 'LOW').length;

  let status: GpsrComplianceStatus;
  let trafficLight: GpsrTrafficLight;

  if (score === 100 && gaps.length === 0) {
    status = 'COMPLIANT';
    trafficLight = 'GREEN';
  } else if (score >= 50 && criticalGapsCount === 0) {
    status = 'PARTIALLY_COMPLIANT';
    trafficLight = 'YELLOW';
  } else {
    status = 'NON_COMPLIANT';
    trafficLight = 'RED';
  }

  const isCompliant = status === 'COMPLIANT';

  return {
    listingId: norm.id,
    sku: norm.sku,
    asin: norm.asin,
    title: norm.title,
    score,
    status,
    trafficLight,
    isCompliant,
    gaps,
    sections: {
      responsiblePerson: {
        passed: hasRpName && hasRpAddress && isAddressInEu && hasRpElectronicContact,
        score: Math.round(rpPoints),
        maxScore: weightRp,
        details: {
          hasName: hasRpName,
          hasEuPostalAddress: hasRpAddress && isAddressInEu,
          hasElectronicContact: hasRpElectronicContact,
        },
      },
      manufacturer: {
        passed: hasMfrNameOrBrand && hasMfrAddress && hasMfrElectronicContact,
        score: Math.round(mfrPoints),
        maxScore: weightMfr,
        details: {
          hasNameOrBrand: hasMfrNameOrBrand,
          hasPostalAddress: hasMfrAddress,
          hasElectronicContact: hasMfrElectronicContact,
        },
      },
      productIdentification: {
        passed: hasProductType && hasModelOrIdentifier,
        score: Math.round(idPoints),
        maxScore: weightId,
        details: {
          hasTypeOrCategory: hasProductType,
          hasModelOrIdentifier,
        },
      },
      safetyAndWarnings: {
        passed: hasSafetyWarnings && (hasCeMarking || !requireCe),
        score: Math.round(safePoints),
        maxScore: weightSafe,
        details: {
          hasSafetyWarnings,
          hasCeMarking,
        },
      },
    },
    summary: {
      criticalGapsCount,
      highGapsCount,
      mediumGapsCount,
      lowGapsCount,
      totalGapsCount: gaps.length,
      checkedAt: new Date().toISOString(),
    },
  };
}

/**
 * Führt den GPSR-Check für eine Liste von Marketplace-Listings aus und aggregiert die Ergebnisse.
 */
export function checkGpsrListings(
  listings: Array<GpsrListingInput | Record<string, unknown>>,
  options: GpsrCheckOptions = {}
): GpsrBatchReport {
  const reports = listings.map((l) => checkGpsrListing(l, options));

  const totalListings = reports.length;
  let compliantCount = 0;
  let partiallyCompliantCount = 0;
  let nonCompliantCount = 0;
  let greenCount = 0;
  let yellowCount = 0;
  let redCount = 0;
  let scoreSum = 0;

  const gapFreq: Record<string, { count: number; article: string; message: string }> = {};

  for (const rep of reports) {
    scoreSum += rep.score;

    if (rep.status === 'COMPLIANT') compliantCount++;
    else if (rep.status === 'PARTIALLY_COMPLIANT') partiallyCompliantCount++;
    else nonCompliantCount++;

    if (rep.trafficLight === 'GREEN') greenCount++;
    else if (rep.trafficLight === 'YELLOW') yellowCount++;
    else redCount++;

    for (const g of rep.gaps) {
      if (!gapFreq[g.code]) {
        gapFreq[g.code] = { count: 0, article: g.articleCitation, message: g.message };
      }
      gapFreq[g.code].count++;
    }
  }

  const averageScore = totalListings > 0 ? Math.round((scoreSum / totalListings) * 10) / 10 : 0;

  return {
    totalListings,
    compliantCount,
    partiallyCompliantCount,
    nonCompliantCount,
    averageScore,
    trafficLights: {
      green: greenCount,
      yellow: yellowCount,
      red: redCount,
    },
    gapFrequency: gapFreq,
    results: reports,
  };
}
