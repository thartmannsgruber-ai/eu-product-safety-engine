import fs from 'node:fs';
import { XMLParser } from 'fast-xml-parser';

export interface SafetyGateNotification {
  order: string;
  caseNumber: string;
  publicationDate: string;
  reference: string;
  category: string;
  product: string;
  brand: string;
  name: string;
  type_numberOfModel: string;
  batchNumber: string;
  barcode: string;
  riskType: string;
  danger: string;
  measures: string;
  URLrecall: string;
  description: string;
  notifyingCountry: string;
  countryOfOrigin: string;
  type: string;
  level: string;
  pictures: string[];
  onlineTrader: string;
  companyRecallCode: string;
  productionDates: string;
  [key: string]: unknown;
}

export interface SafetyGateReport {
  reportLanguage: string;
  reportDate: string;
  reportYear: string;
  reportWeek: string;
  reportAddendum: string;
  notifications: SafetyGateNotification[];
}

function cleanString(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'string') return val.trim();
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  if (typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (
      obj['@_xsi:nil'] === 'true' ||
      obj['@_xsi:nil'] === '1' ||
      obj['@_nil'] === 'true' ||
      obj['@_nil'] === '1'
    ) {
      return '';
    }
    if (typeof obj['#text'] === 'string') {
      return obj['#text'].trim();
    }
    if (typeof obj['__cdata'] === 'string') {
      return obj['__cdata'].trim();
    }
    return '';
  }
  return String(val).trim();
}

function extractPictures(picturesObj: unknown): string[] {
  if (!picturesObj) return [];
  if (typeof picturesObj === 'string') {
    const cleaned = cleanString(picturesObj);
    return cleaned ? [cleaned] : [];
  }
  if (Array.isArray(picturesObj)) {
    return picturesObj.map(cleanString).filter(Boolean);
  }
  if (typeof picturesObj === 'object') {
    const obj = picturesObj as Record<string, unknown>;
    const pic = obj.picture;
    if (!pic) return [];
    if (Array.isArray(pic)) {
      return pic.map(cleanString).filter(Boolean);
    }
    const single = cleanString(pic);
    return single ? [single] : [];
  }
  return [];
}

function mapNotification(raw: Record<string, unknown>): SafetyGateNotification {
  return {
    ...raw,
    order: cleanString(raw.order),
    caseNumber: cleanString(raw.caseNumber),
    publicationDate: cleanString(raw.publicationDate),
    reference: cleanString(raw.reference),
    category: cleanString(raw.category),
    product: cleanString(raw.product),
    brand: cleanString(raw.brand),
    name: cleanString(raw.name),
    type_numberOfModel: cleanString(raw.type_numberOfModel),
    batchNumber: cleanString(raw.batchNumber),
    barcode: cleanString(raw.barcode),
    riskType: cleanString(raw.riskType),
    danger: cleanString(raw.danger),
    measures: cleanString(raw.measures),
    URLrecall: cleanString(raw.URLrecall),
    description: cleanString(raw.description),
    notifyingCountry: cleanString(raw.notifyingCountry),
    countryOfOrigin: cleanString(raw.countryOfOrigin),
    type: cleanString(raw.type),
    level: cleanString(raw.level),
    pictures: extractPictures(raw.pictures),
    onlineTrader: cleanString(raw.onlineTrader),
    companyRecallCode: cleanString(raw.companyRecallCode),
    productionDates: cleanString(raw.productionDates),
  };
}

function findRoot(parsed: Record<string, any>): Record<string, any> {
  if (parsed['Safety-Gate']) return parsed['Safety-Gate'];
  if (parsed['safety-gate']) return parsed['safety-gate'];
  if (parsed['SafetyGate']) return parsed['SafetyGate'];
  if (parsed['safetyGate']) return parsed['safetyGate'];
  if (parsed['report']) return parsed['report'];
  if (parsed['Report']) return parsed['Report'];
  return parsed;
}

function findNotifications(root: Record<string, any>): any[] {
  if (Array.isArray(root.notifications)) return root.notifications;
  if (root.notifications && typeof root.notifications === 'object') {
    return [root.notifications];
  }
  if (Array.isArray(root.notification)) return root.notification;
  if (root.notification && typeof root.notification === 'object') {
    return [root.notification];
  }
  return [];
}

export function parseSafetyGateXml(xml: string): SafetyGateReport {
  if (!xml || typeof xml !== 'string' || xml.trim().length === 0) {
    throw new Error('XML content is empty or invalid');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: false,
    isArray: (name) => name === 'notifications' || name === 'picture',
  });

  let parsed: Record<string, any>;
  try {
    parsed = parser.parse(xml);
  } catch (err) {
    throw new Error(`Failed to parse Safety Gate XML: ${err instanceof Error ? err.message : String(err)}`);
  }

  const root = findRoot(parsed);
  const rawList = findNotifications(root);

  return {
    reportLanguage: cleanString(root.report_language),
    reportDate: cleanString(root.report_date),
    reportYear: cleanString(root.report_year),
    reportWeek: cleanString(root.report_week),
    reportAddendum: cleanString(root.report_addendum),
    notifications: rawList.map(mapNotification),
  };
}

export async function parseSafetyGateFile(filePath: string): Promise<SafetyGateReport> {
  const content = await fs.promises.readFile(filePath, 'utf-8');
  return parseSafetyGateXml(content);
}

export function parseSafetyGateFileSync(filePath: string): SafetyGateReport {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseSafetyGateXml(content);
}

export function extractNotifications(input: string | SafetyGateReport): SafetyGateNotification[] {
  if (typeof input === 'string') {
    return parseSafetyGateXml(input).notifications;
  }
  if (input && Array.isArray(input.notifications)) {
    return input.notifications;
  }
  return [];
}
