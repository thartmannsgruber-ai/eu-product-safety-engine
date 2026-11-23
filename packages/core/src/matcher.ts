import type { AlertRecord } from './schema.js';

/**
 * Weights for the multi-factor confidence scoring.
 * Brand (0.35) + Model (0.45) + Category (0.20) = 1.00
 */
export interface MatchWeights {
  brand: number;
  model: number;
  category: number;
}

export const DEFAULT_MATCH_WEIGHTS: MatchWeights = {
  brand: 0.35,
  model: 0.45,
  category: 0.20,
};

/**
 * Classification traffic light colors.
 * Rot (High confidence match / Alert): Score >= 0.85
 * Gelb (Potential match / Manual review): 0.65 <= Score < 0.85
 * Gruen (No match / Compliant): Score < 0.65
 */
export type MatchClassification = 'Rot' | 'Gelb' | 'Gruen';
export type MatchSeverity = 'RED' | 'YELLOW' | 'GREEN';

export interface ProductInput {
  brand?: string;
  model?: string;
  name?: string;
  category?: string;
  ean?: string;
  asin?: string;
  sku?: string;
  [key: string]: unknown;
}

export interface MatchOptions {
  weights?: Partial<MatchWeights>;
  redThreshold?: number; // default 0.85
  yellowThreshold?: number; // default 0.65
}

export interface MatchBreakdown {
  brand_score: number;
  model_score: number;
  category_score: number;
  model_number_matched: boolean;
  extracted_model_numbers: {
    product: string[];
    alert: string[];
  };
}

export interface MatchResult {
  score: number; // 0.00 to 1.00
  classification: MatchClassification;
  severity: MatchSeverity;
  matched: boolean; // true if score >= yellowThreshold (0.65)
  matched_fields: string[]; // e.g. ['brand', 'model', 'category']
  match_reason: string; // Detailed reason for B2B compliance audits
  breakdown: MatchBreakdown;
  product?: ProductInput;
  alert?: Partial<AlertRecord> | Record<string, unknown>;
}

// Common corporate legal suffixes to strip for clean brand comparison
const LEGAL_SUFFIXES_REGEX =
  /\b(gmbh\s*(&|und)?\s*co\.?\s*kg|gmbh|ag|ltd|limited|inc|incorporated|corp|corporation|llc|co\.?|sa|srl|bv)\b/gi;

// Category synonyms and mappings
const CATEGORY_GROUPS: Record<string, string[]> = {
  toys: [
    'toys',
    'spielzeug',
    'jouet',
    'juguete',
    'giocattolo',
    'doll',
    'game',
    'puzzle',
    'plush',
    'action figure',
    'board game',
  ],
  electrical: [
    'electrical appliances and equipment',
    'electrical appliances',
    'electrical equipment',
    'elektronik',
    'elektrische geräte',
    'electronics',
    'charger',
    'adapter',
    'appliance',
    'battery',
    'power supply',
    'audio',
    'video',
    'computer',
  ],
  childcare: [
    'childcare articles and children\'s equipment',
    'childcare',
    'baby',
    'kinder',
    'kinderartikel',
    'stroller',
    'crib',
    'pacifier',
    'car seat',
    'baby carrier',
  ],
  lighting: ['lighting equipment', 'beleuchtung', 'lamp', 'leuchte', 'led', 'light', 'flashlight'],
  cosmetics: ['cosmetics', 'kosmetik', 'makeup', 'cream', 'perfume', 'parfüm', 'shampoo', 'lotion', 'soap'],
  clothing: [
    'clothing, textiles and fashion items',
    'clothing',
    'textiles',
    'kleidung',
    'bekleidung',
    'fashion',
    'shoes',
    'schuhe',
    'apparel',
  ],
  vehicles: ['motor vehicles', 'kraftfahrzeuge', 'kfz', 'auto', 'car', 'motorcycle', 'vehicle', 'automotive'],
  hobby: ['hobby / sports equipment', 'hobby', 'sports', 'sport', 'fitness', 'bicycle', 'fahrrad', 'e-bike', 'scooter'],
  chemical: ['chemical products', 'chemische produkte', 'chemical', 'glue', 'cleaner', 'reiniger', 'paint', 'oil'],
  jewelry: ['jewellery', 'jewelry', 'schmuck', 'ring', 'necklace', 'bracelet', 'earrings'],
  kitchen: [
    'kitchen / cooking accessories',
    'kitchen',
    'cooking',
    'küche',
    'geschirr',
    'cookware',
    'airfryer',
    'blender',
    'toaster',
  ],
  machinery: ['machinery', 'maschinen', 'tools', 'werkzeug', 'chainsaw', 'drill', 'saw'],
  ppe: [
    'personal protective equipment (ppe)',
    'personal protective equipment',
    'ppe',
    'psa',
    'mask',
    'maske',
    'helmet',
    'helm',
    'gloves',
    'respirator',
  ],
  laser: ['laser pointers', 'laser pointer', 'laser'],
  decor: ['decorative articles', 'dekoration', 'candle', 'kerze'],
};

/**
 * Normalizes text: trims, lowercases, removes diacritics, and strips unnecessary punctuation.
 */
export function normalizeText(text?: string | null): string {
  if (!text) return '';
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove diacritics (é -> e, ä -> a)
    .replace(/[''`´’]/g, '') // remove apostrophes without adding spaces (L'Oréal -> LOreal)
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ') // replace punctuation except hyphen with space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalizes brand string by removing corporate suffixes and punctuation.
 */
export function normalizeBrand(brand?: string | null): string {
  if (!brand) return '';
  let normalized = normalizeText(brand);
  normalized = normalized.replace(LEGAL_SUFFIXES_REGEX, '').replace(/\s+/g, ' ').trim();
  return normalized;
}

/**
 * Calculates Levenshtein edit distance between two strings.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const v0 = new Array<number>(b.length + 1);
  const v1 = new Array<number>(b.length + 1);

  for (let i = 0; i <= b.length; i++) {
    v0[i] = i;
  }

  for (let i = 0; i < a.length; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const cost = a[i] === b[j] ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    for (let j = 0; j <= b.length; j++) {
      v0[j] = v1[j];
    }
  }

  return v1[b.length];
}

/**
 * Computes Levenshtein similarity score between 0.00 and 1.00.
 */
export function stringSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;
  const dist = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Extracts alphanumeric model codes from a string (e.g. "XY-500", "HD9252", "V8", "WH-1000XM4").
 */
export function extractModelNumbers(text?: string | null): string[] {
  if (!text) return [];
  const normalized = text.trim();
  // Match patterns like XY-500, WH-1000XM4, HD9252, A2338, SM-G998B, V8, etc.
  const regex = /\b[A-Za-z0-9]+(?:[-_/][A-Za-z0-9]+)+\b|\b[A-Za-z]{1,4}[0-9]{2,6}[A-Za-z0-9]*\b|\b[0-9]{2,6}[A-Za-z]{1,4}[A-Za-z0-9]*\b|\b[A-Za-z][0-9]{1,3}\b/g;
  const matches = normalized.match(regex) || [];
  return Array.from(new Set(matches.map((m) => m.toUpperCase())));
}

/**
 * Tokenizes text into unique words of length >= 2.
 */
export function tokenize(text?: string | null): string[] {
  if (!text) return [];
  const normalized = normalizeText(text);
  return Array.from(
    new Set(
      normalized
        .split(/[\s-]+/)
        .map((t) => t.trim())
        .filter((t) => t.length >= 2)
    )
  );
}

/**
 * Calculates Token Jaccard overlap similarity between two texts.
 */
export function tokenJaccardSimilarity(text1: string, text2: string): number {
  const tokens1 = new Set(tokenize(text1));
  const tokens2 = new Set(tokenize(text2));

  if (tokens1.size === 0 && tokens2.size === 0) return 1.0;
  if (tokens1.size === 0 || tokens2.size === 0) return 0.0;

  let intersection = 0;
  for (const t of tokens1) {
    if (tokens2.has(t)) {
      intersection++;
    }
  }

  const union = new Set([...tokens1, ...tokens2]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Calculates Token Set Ratio / containment similarity.
 */
export function tokenSetRatio(text1: string, text2: string): number {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);

  if (tokens1.length === 0 && tokens2.length === 0) return 1.0;
  if (tokens1.length === 0 || tokens2.length === 0) return 0.0;

  const set1 = new Set(tokens1);
  const set2 = new Set(tokens2);

  let matchCount = 0;
  const smaller = set1.size <= set2.size ? set1 : set2;
  const larger = set1.size <= set2.size ? set2 : set1;

  for (const t of smaller) {
    if (larger.has(t)) {
      matchCount++;
    }
  }

  return matchCount / smaller.size;
}

/**
 * Computes Brand Similarity (0.00 to 1.00) considering:
 * - Exact match
 * - Normalization (case, diacritics, corporate suffixes)
 * - Containment & Token Set Ratio
 * - Levenshtein edit distance
 */
export function calculateBrandSimilarity(brand1?: string | null, brand2?: string | null): number {
  if (!brand1 || !brand2) return 0.0;

  const raw1 = brand1.trim();
  const raw2 = brand2.trim();
  if (raw1.toLowerCase() === raw2.toLowerCase()) {
    return 1.0;
  }

  const norm1 = normalizeBrand(brand1);
  const norm2 = normalizeBrand(brand2);

  if (!norm1 || !norm2) return 0.0;
  if (norm1 === norm2 || norm1.replace(/\s+/g, '') === norm2.replace(/\s+/g, '')) {
    return 1.0;
  }

  // Check if one is a substring of the other (e.g. "Apple" vs "Apple Computer")
  if (norm1.length >= 3 && norm2.length >= 3) {
    if (norm1.includes(norm2) || norm2.includes(norm1)) {
      const minLen = Math.min(norm1.length, norm2.length);
      const maxLen = Math.max(norm1.length, norm2.length);
      return Math.max(0.90, 0.90 + 0.08 * (minLen / maxLen));
    }
  }

  // Token set comparison
  const setRatio = tokenSetRatio(norm1, norm2);
  if (setRatio >= 0.8) {
    return Math.max(0.90, setRatio * 0.95);
  }

  // Levenshtein similarity on normalized brand
  const levSim = stringSimilarity(norm1, norm2);

  return Math.max(levSim, setRatio);
}

/**
 * Computes Model / Product Name similarity (0.00 to 1.00) considering:
 * - Model number / code matching (boosts to 0.95 - 1.00)
 * - Token Jaccard overlap
 * - Token containment
 * - String similarity
 */
export function calculateModelSimilarity(
  productModel?: string | null,
  alertModel?: string | null,
  productName?: string | null,
  alertProduct?: string | null
): {
  score: number;
  modelNumberMatched: boolean;
  extractedNumbers: { product: string[]; alert: string[] };
} {
  const prodText = `${productModel || ''} ${productName || ''}`.trim();
  const alertText = `${alertModel || ''} ${alertProduct || ''}`.trim();

  if (!prodText || !alertText) {
    return {
      score: 0.0,
      modelNumberMatched: false,
      extractedNumbers: { product: [], alert: [] },
    };
  }

  // Extract model numbers
  const prodNums = extractModelNumbers(prodText);
  const alertNums = extractModelNumbers(alertText);

  // Check for model number match (ignoring separators)
  let modelNumberMatched = false;
  const cleanProdNums = prodNums.map((n) => n.replace(/[-_/]/g, ''));
  const cleanAlertNums = alertNums.map((n) => n.replace(/[-_/]/g, ''));

  for (const pn of cleanProdNums) {
    for (const an of cleanAlertNums) {
      if (pn === an || (pn.length >= 4 && an.length >= 4 && (pn.includes(an) || an.includes(pn)))) {
        modelNumberMatched = true;
        break;
      }
    }
    if (modelNumberMatched) break;
  }

  if (modelNumberMatched) {
    return {
      score: 0.95,
      modelNumberMatched: true,
      extractedNumbers: { product: prodNums, alert: alertNums },
    };
  }

  // Compare model fields directly if provided
  const normProdModel = normalizeText(productModel);
  const normAlertModel = normalizeText(alertModel);

  let directModelSim = 0;
  if (normProdModel && normAlertModel) {
    if (normProdModel === normAlertModel) {
      directModelSim = 1.0;
    } else {
      directModelSim = Math.max(
        stringSimilarity(normProdModel, normAlertModel),
        tokenJaccardSimilarity(normProdModel, normAlertModel),
        tokenSetRatio(normProdModel, normAlertModel)
      );
    }
  }

  // Compare overall product & model text
  const overallJaccard = tokenJaccardSimilarity(prodText, alertText);
  const overallTokenSet = tokenSetRatio(prodText, alertText);
  const textSim = stringSimilarity(normalizeText(prodText), normalizeText(alertText));

  const textScore = Math.max(directModelSim, overallJaccard, overallTokenSet * 0.85, textSim);

  return {
    score: Math.min(1.0, textScore),
    modelNumberMatched: false,
    extractedNumbers: { product: prodNums, alert: alertNums },
  };
}

/**
 * Identifies the category key for a category string.
 */
function findCategoryKey(catStr?: string | null): string | null {
  if (!catStr) return null;
  const norm = normalizeText(catStr);
  for (const [key, aliases] of Object.entries(CATEGORY_GROUPS)) {
    for (const alias of aliases) {
      if (norm === alias || norm.includes(alias) || alias.includes(norm)) {
        return key;
      }
    }
  }
  return null;
}

/**
 * Computes Category Similarity (0.00 to 1.00):
 * - 1.00 if exact match or identical category group
 * - 0.90 if one category contains the other
 * - 0.50 if category is missing/neutral
 * - 0.00 if categories belong to incompatible groups
 */
export function calculateCategorySimilarity(cat1?: string | null, cat2?: string | null): number {
  if (!cat1 && !cat2) return 0.5; // neutral when neither has category
  if (!cat1 || !cat2) return 0.5; // neutral when one is missing

  const norm1 = normalizeText(cat1);
  const norm2 = normalizeText(cat2);

  if (norm1 === norm2) return 1.0;

  const key1 = findCategoryKey(cat1);
  const key2 = findCategoryKey(cat2);

  if (key1 && key2) {
    return key1 === key2 ? 1.0 : 0.0;
  }

  if (norm1.includes(norm2) || norm2.includes(norm1)) {
    return 0.9;
  }

  // Fallback to token similarity
  const jaccard = tokenJaccardSimilarity(norm1, norm2);
  return jaccard >= 0.5 ? 0.8 : 0.0;
}

/**
 * Calculates weighted confidence score between 0.00 and 1.00.
 */
export function calculateConfidenceScore(
  brandScore: number,
  modelScore: number,
  categoryScore: number,
  weights?: Partial<MatchWeights>
): number {
  const w: MatchWeights = {
    brand: weights?.brand ?? DEFAULT_MATCH_WEIGHTS.brand,
    model: weights?.model ?? DEFAULT_MATCH_WEIGHTS.model,
    category: weights?.category ?? DEFAULT_MATCH_WEIGHTS.category,
  };

  const rawScore = w.brand * brandScore + w.model * modelScore + w.category * categoryScore;
  const clamped = Math.max(0.0, Math.min(1.0, rawScore));
  return Math.round(clamped * 10000) / 10000;
}

/**
 * Classifies score into traffic light status:
 * Rot (>= 0.85), Gelb (0.65 <= Score < 0.85), Gruen (< 0.65).
 */
export function classifyScore(
  score: number,
  redThreshold: number = 0.85,
  yellowThreshold: number = 0.65
): MatchClassification {
  if (score >= redThreshold) {
    return 'Rot';
  }
  if (score >= yellowThreshold) {
    return 'Gelb';
  }
  return 'Gruen';
}

/**
 * Helper to get English severity: RED | YELLOW | GREEN.
 */
export function getSeverity(classification: MatchClassification): MatchSeverity {
  switch (classification) {
    case 'Rot':
      return 'RED';
    case 'Gelb':
      return 'YELLOW';
    case 'Gruen':
      return 'GREEN';
  }
}

/**
 * Builds human-readable and B2B audit-ready match reason and matched fields list.
 */
function buildMatchDetails(
  score: number,
  classification: MatchClassification,
  brandScore: number,
  modelScore: number,
  categoryScore: number,
  modelNumberMatched: boolean,
  product: ProductInput,
  alert: Partial<AlertRecord> | Record<string, unknown>
): { matched_fields: string[]; match_reason: string } {
  const matched_fields: string[] = [];

  if (brandScore >= 0.70) matched_fields.push('brand');
  if (modelScore >= 0.60) matched_fields.push('model');
  if (categoryScore >= 0.70) matched_fields.push('category');

  const prodBrand = product.brand || 'Unbekannt';
  const alertBrand = (alert.brand as string) || 'Unbekannt';
  const prodModel = product.model || product.name || 'Unbekannt';
  const alertModel = (alert.model as string) || (alert.product as string) || 'Unbekannt';

  let reasonPrefix = '';
  if (classification === 'Rot') {
    reasonPrefix = `Akuter Safety-Gate-Verdacht (Score: ${score.toFixed(2)})`;
  } else if (classification === 'Gelb') {
    reasonPrefix = `Potenzieller Übereinstimmungs-Prüffall (Score: ${score.toFixed(2)})`;
  } else {
    reasonPrefix = `Keine signifikante Übereinstimmung (Score: ${score.toFixed(2)})`;
  }

  const details: string[] = [];

  if (brandScore >= 0.95) {
    details.push(`Marke identisch ('${prodBrand}') [${brandScore.toFixed(2)}]`);
  } else if (brandScore >= 0.70) {
    details.push(`Marke ähnlich ('${prodBrand}' ~ '${alertBrand}') [${brandScore.toFixed(2)}]`);
  } else {
    details.push(`Marke weicht ab ('${prodBrand}' vs. '${alertBrand}') [${brandScore.toFixed(2)}]`);
  }

  if (modelNumberMatched) {
    details.push(`Modellnummer/Code exakt erkannt [${modelScore.toFixed(2)}]`);
  } else if (modelScore >= 0.70) {
    details.push(`Modellbezeichnung hohe Übereinstimmung ('${prodModel}' ~ '${alertModel}') [${modelScore.toFixed(2)}]`);
  } else if (modelScore >= 0.40) {
    details.push(`Modellbezeichnung Teilübereinstimmung [${modelScore.toFixed(2)}]`);
  } else {
    details.push(`Modellbezeichnung unterschiedlich [${modelScore.toFixed(2)}]`);
  }

  if (categoryScore >= 0.90) {
    details.push(`Kategorie kompatibel [${categoryScore.toFixed(2)}]`);
  } else if (categoryScore <= 0.20) {
    details.push(`Kategorie inkompatibel [${categoryScore.toFixed(2)}]`);
  }

  const match_reason = `${reasonPrefix}: ${details.join(', ')}.`;

  return { matched_fields, match_reason };
}

/**
 * Matches a single product against a single Safety Gate alert record.
 */
export function matchProductToAlert(
  product: ProductInput,
  alert: Partial<AlertRecord> | Record<string, unknown>,
  options?: MatchOptions
): MatchResult {
  const redThresh = options?.redThreshold ?? 0.85;
  const yellowThresh = options?.yellowThreshold ?? 0.65;

  const brandScore = calculateBrandSimilarity(product.brand, alert.brand as string | undefined);

  const modelResult = calculateModelSimilarity(
    product.model,
    alert.model as string | undefined,
    product.name,
    alert.product as string | undefined
  );

  const categoryScore = calculateCategorySimilarity(
    product.category,
    alert.category as string | undefined
  );

  const score = calculateConfidenceScore(
    brandScore,
    modelResult.score,
    categoryScore,
    options?.weights
  );

  const classification = classifyScore(score, redThresh, yellowThresh);
  const severity = getSeverity(classification);
  const matched = score >= yellowThresh;

  const { matched_fields, match_reason } = buildMatchDetails(
    score,
    classification,
    brandScore,
    modelResult.score,
    categoryScore,
    modelResult.modelNumberMatched,
    product,
    alert
  );

  return {
    score,
    classification,
    severity,
    matched,
    matched_fields,
    match_reason,
    breakdown: {
      brand_score: brandScore,
      model_score: modelResult.score,
      category_score: categoryScore,
      model_number_matched: modelResult.modelNumberMatched,
      extracted_model_numbers: {
        product: modelResult.extractedNumbers.product,
        alert: modelResult.extractedNumbers.alert,
      },
    },
    product,
    alert,
  };
}

/**
 * Searches and scores a product against a list of Safety Gate alert records,
 * returning matching results sorted by confidence score descending.
 */
export function findMatchesForProduct(
  product: ProductInput,
  alerts: Array<Partial<AlertRecord> | Record<string, unknown>>,
  options?: MatchOptions & { minScore?: number; limit?: number }
): MatchResult[] {
  const minScore = options?.minScore ?? 0.0;
  const limit = options?.limit ?? Infinity;

  const results: MatchResult[] = [];

  for (const alert of alerts) {
    const res = matchProductToAlert(product, alert, options);
    if (res.score >= minScore) {
      results.push(res);
    }
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

/**
 * Advanced Fuzzy Matcher Class with configurable options and reusable state.
 */
export class AdvancedFuzzyMatcher {
  private readonly options: MatchOptions;

  constructor(options?: MatchOptions) {
    this.options = {
      weights: { ...DEFAULT_MATCH_WEIGHTS, ...options?.weights },
      redThreshold: options?.redThreshold ?? 0.85,
      yellowThreshold: options?.yellowThreshold ?? 0.65,
    };
  }

  match(product: ProductInput, alert: Partial<AlertRecord> | Record<string, unknown>): MatchResult {
    return matchProductToAlert(product, alert, this.options);
  }

  matchBatch(
    products: ProductInput[],
    alerts: Array<Partial<AlertRecord> | Record<string, unknown>>,
    options?: { minScore?: number; limitPerProduct?: number }
  ): Map<ProductInput, MatchResult[]> {
    const resultMap = new Map<ProductInput, MatchResult[]>();
    for (const prod of products) {
      const matches = findMatchesForProduct(prod, alerts, {
        ...this.options,
        minScore: options?.minScore ?? this.options.yellowThreshold,
        limit: options?.limitPerProduct,
      });
      resultMap.set(prod, matches);
    }
    return resultMap;
  }
}
