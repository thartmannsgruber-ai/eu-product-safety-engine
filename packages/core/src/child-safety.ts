import type { AlertRecord } from './schema.js';

export type ChildAgeGroup = 'baby' | 'toddler' | 'child' | 'unknown';
export type ChildHazard = 'choking' | 'chemical' | 'magnets';

export interface ChildSafetyClassification {
  isChildRelated: boolean;
  ageGroup: ChildAgeGroup;
  hazards: ChildHazard[];
  matchReasons: string[];
}

// Multilingual keywords for children, babies, and toys
const BABY_KEYWORDS = /\b(baby|babies|bébé|bebe|säugling|infant|infants|strampler|schnuller|pacifier|teether|teething|crib|pram|stroller|kinderwagen|nappy|diaper|windel|0-12\s*m|6-12\s*m)\b/i;
const TODDLER_KEYWORDS = /\b(toddler|toddlers|kleinkind|kleinkinder|1-3\s*y|1-3\s*j)\b/i;
const GENERAL_CHILD_KEYWORDS = /\b(child|children|children['’´]s|enfant|enfants|kind|kinder|kindern|kid|kids|doll|dolls|poupée|puppe|puppen|plush|plüsch|kuscheltier|peluche|spielzeug|jouet|costume|verkleidung|playground)\b/i;

const CHOKING_KEYWORDS = /\b(choking|suffocation|asphyxiation|erstickung|verschluck|étouffement|small parts|kleinteile|petits éléments|cord|drawstring|strangulation)\b/i;
const CHEMICAL_KEYWORDS = /\b(chemical|pfca|pfoa|pfas|phthalat|phthalate|dehp|lead|blei|cadmium|nickel|boron|toxic|reach|chemisch|substance|carcinogenic|toxic to reproduction)\b/i;
const MAGNET_KEYWORDS = /\b(magnet|magnets|magnetisch|aimant|aimants|flux index|magnetic)\b/i;

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
  if (CHEMICAL_KEYWORDS.test(fullText) || riskType.includes('chemical')) {
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
