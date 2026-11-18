import type { AlertRecord } from './schema.js';

export type ChildAgeGroup = 'baby' | 'toddler' | 'child' | 'unknown';
export type ChildHazard = 'choking' | 'chemical' | 'magnets';

export interface ChildSafetyClassification {
  isChildRelated: boolean;
  ageGroup: ChildAgeGroup;
  hazards: ChildHazard[];
  matchReasons: string[];
}

// Multilingual keywords for children, babies, and toys using Unicode letter lookarounds
const kw = (body: string, flags = 'iu') =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, flags);

const BABY_KEYWORDS = kw('bab(?:y|ies)|bébés?|bebes?|biberons?|säugling\\p{L}*|infants?|strampler|schnuller|pacifiers?|teether|teething|cribs?|prams?|strollers?|kinderwagen|nappy|nappies|diapers?|windel\\p{L}*|0-12\\s*m|6-12\\s*m');
const TODDLER_KEYWORDS = kw('toddlers?|kleinkind(?:er)?|1-3\\s*[yj]');
const GENERAL_CHILD_KEYWORDS = kw("child|children|children['’´]s|enfants?|kind|kinder|kindern|kids?|dolls?|poupées?|puppen?|plush|plüsch\\p{L}*|kuscheltier\\p{L}*|peluches?|\\p{L}*spielzeug\\p{L}*|jouets?|costumes?|verkleidung|playground");

const CHOKING_KEYWORDS = kw('choking|suffocation|asphyxiation|erstick\\p{L}*|verschluck\\p{L}*|étouffement|small parts?|kleinteil\\p{L}*|petits? éléments|cords?|drawstrings?|strangulation');
const CHEMICAL_KEYWORDS = kw('chemicals?|chemisch\\p{L}*|pfca|pfoa|pfas|phthalat\\p{L}*|dehp|lead (?:paint|content|levels?|exposure|poisoning)|blei|bleihaltig\\p{L}*|bleigehalt|cadmium|nickel|boron|toxic|carcinogenic|toxic to reproduction|reach (?:regulation|compliance|annex|candidate)|svhc|substances? of very high concern');
const CHEMICAL_CASE_SENSITIVE = kw('REACH|Pb', 'u');
const MAGNET_KEYWORDS = kw('magnets?|magnetisch\\p{L}*|aimants?|flux index|magnetic');

/**
 * Classify whether an alert represents a child- or baby-related product,
 * determining the target age group and identifying relevant hazards.
 */
export function classifyChildProduct(alert: AlertRecord): ChildSafetyClassification {
  const category = (alert.category ?? '').toLowerCase();
  const product = (alert.product ?? '').toLowerCase();
  const brand = (alert.brand ?? '').toLowerCase();
  const model = (alert.model ?? '').toLowerCase();
  const danger = (alert.danger_description ?? '').toLowerCase();
  const riskType = (alert.risk_type ?? '').toLowerCase();

  const primaryText = `${category} ${product} ${brand} ${model}`;
  const fullText = `${primaryText} ${danger} ${riskType}`;
  const rawFull = [alert.category, alert.product, alert.brand, alert.model, alert.danger_description, alert.risk_type]
    .filter(Boolean)
    .join(' ');

  const matchReasons: string[] = [];
  let isChildRelated = false;
  let ageGroup: ChildAgeGroup = 'unknown';

  // 1. Check category
  if (category.includes('toy') || category.includes('spielzeug') || category.includes('jouet')) {
    isChildRelated = true;
    matchReasons.push('category:toys');
  }

  // 2. Check baby indicators
  if (BABY_KEYWORDS.test(primaryText) || BABY_KEYWORDS.test(danger)) {
    isChildRelated = true;
    ageGroup = 'baby';
    matchReasons.push('keyword:baby');
  } else if (TODDLER_KEYWORDS.test(primaryText) || TODDLER_KEYWORDS.test(danger)) {
    isChildRelated = true;
    ageGroup = 'toddler';
    matchReasons.push('keyword:toddler');
  } else if (GENERAL_CHILD_KEYWORDS.test(primaryText)) {
    isChildRelated = true;
    if (ageGroup === 'unknown') {
      ageGroup = 'child';
    }
    matchReasons.push('keyword:child');
  } else if (isChildRelated && ageGroup === 'unknown') {
    ageGroup = 'child';
  }

  // 3. Hazard identification
  const hazards: ChildHazard[] = [];

  if (CHOKING_KEYWORDS.test(fullText) || riskType.includes('choking') || riskType.includes('strangulation')) {
    hazards.push('choking');
  }
  if (
    CHEMICAL_KEYWORDS.test(fullText) ||
    CHEMICAL_CASE_SENSITIVE.test(rawFull) ||
    riskType.includes('chemical')
  ) {
    hazards.push('chemical');
  }
  if (MAGNET_KEYWORDS.test(fullText)) {
    hazards.push('magnets');
  }

  return {
    isChildRelated,
    ageGroup,
    hazards,
    matchReasons,
  };
}
