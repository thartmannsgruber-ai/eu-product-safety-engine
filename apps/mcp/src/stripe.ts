/**
 * apps/mcp/src/stripe.ts
 *
 * Stripe Checkout & B2B High-Ticket Audit Vorbereitung fuer ProductSafetyEngine MCP.
 *
 * Unterstuetzt:
 * 1. B2B High-Ticket Pakete:
 *    - Portfolio Audit: 490 EUR (49.000 Cents, bis zu 1.000 SKUs)
 *    - Audit Plus: 1.490 EUR (149.000 Cents, unbegrenzte SKUs + REACH/SVHC + 12 Wochen Monitoring)
 * 2. B2B-Metadaten-Handling:
 *    - lead_id, company, email, paketauswahl, steuer_id
 * 3. Checkout-Link- & Pitch-Snippet-Generator fuer CRM-Pitches (DE, EN, FR, NL)
 * 4. Webhook-Signatur-Verifikation & Freischaltung von Audit-Auftraegen
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ==============================================================================
// 1. PAKET-DEFINITIONEN (Portfolio Audit 490 EUR & Audit Plus 1490 EUR)
// ==============================================================================

export type B2BAuditPackageKey = 'portfolio_audit' | 'audit_plus';

export interface B2BPackageInfo {
  key: B2BAuditPackageKey;
  name: string;
  amountEur: number;
  amountCents: number;
  currency: 'eur';
  skuLimit: number | null;
  description: string;
}

export const PORTFOLIO_AUDIT_PACKAGE: B2BPackageInfo = {
  key: 'portfolio_audit',
  name: 'Portfolio Audit',
  amountEur: 490,
  amountCents: 49000,
  currency: 'eur',
  skuLimit: 1000,
  description:
    'Umfassender EU Safety Gate (RAPEX) Compliance-Check fuer bis zu 1.000 SKUs inkl. Pruefzertifikat & Risikoanalyse.',
};

export const AUDIT_PLUS_PACKAGE: B2BPackageInfo = {
  key: 'audit_plus',
  name: 'Audit Plus',
  amountEur: 1490,
  amountCents: 149000,
  currency: 'eur',
  skuLimit: null,
  description:
    'Enterprise Portfolio Audit (unbegrenzte SKUs) inkl. REACH/SVHC-Tiefenanalyse, woechentlichem 12-Wochen-Monitoring & Vorstands-Pruefbericht.',
};

export const B2B_AUDIT_PACKAGES: Record<B2BAuditPackageKey, B2BPackageInfo> = {
  portfolio_audit: PORTFOLIO_AUDIT_PACKAGE,
  audit_plus: AUDIT_PLUS_PACKAGE,
};

const PACKAGE_ALIAS_MAP: Record<string, B2BAuditPackageKey> = {
  portfolio_audit: 'portfolio_audit',
  'portfolio-audit': 'portfolio_audit',
  portfolioaudit: 'portfolio_audit',
  audit: 'portfolio_audit',
  '490': 'portfolio_audit',
  '490eur': 'portfolio_audit',
  basic: 'portfolio_audit',
  audit_plus: 'audit_plus',
  'audit-plus': 'audit_plus',
  auditplus: 'audit_plus',
  plus: 'audit_plus',
  '1490': 'audit_plus',
  '1490eur': 'audit_plus',
  enterprise: 'audit_plus',
};

/**
 * Loest einen Paketnamen, Alias oder Preis auf und gibt B2BPackageInfo zurueck.
 */
export function getB2BAuditPackage(identifier: string): B2BPackageInfo {
  const clean = identifier.trim().toLowerCase();
  const canonicalKey = PACKAGE_ALIAS_MAP[clean];
  if (!canonicalKey || !B2B_AUDIT_PACKAGES[canonicalKey]) {
    throw new Error(
      `Ungueltiges Paket '${identifier}'. Erlaubt sind: ${Object.keys(B2B_AUDIT_PACKAGES).join(', ')}, 490, 1490`
    );
  }
  return B2B_AUDIT_PACKAGES[canonicalKey];
}

// ==============================================================================
// 2. METADATEN-HANDLING
// ==============================================================================

export interface B2BCheckoutMetadata {
  lead_id: string;
  company: string;
  email: string;
  paketauswahl: B2BAuditPackageKey;
  steuer_id: string;
  'steuer-id'?: string;
  [key: string]: string | undefined;
}

/**
 * Validiert und normalisiert die erforderlichen B2B-Metadaten.
 */
export function buildB2BCheckoutMetadata(params: {
  lead_id: string;
  company: string;
  email: string;
  paketauswahl: string;
  steuer_id?: string;
  'steuer-id'?: string;
  extra?: Record<string, string>;
}): B2BCheckoutMetadata {
  const pkg = getB2BAuditPackage(params.paketauswahl);
  const normEmail = params.email.trim().toLowerCase();
  const taxId = (params.steuer_id || params['steuer-id'] || '').trim();

  const metadata: B2BCheckoutMetadata = {
    lead_id: (params.lead_id || normEmail).trim(),
    company: params.company.trim(),
    email: normEmail,
    paketauswahl: pkg.key,
    steuer_id: taxId,
    'steuer-id': taxId,
  };

  if (params.extra) {
    for (const [k, v] of Object.entries(params.extra)) {
      if (v !== undefined && metadata[k] === undefined) {
        metadata[k] = String(v).slice(0, 500);
      }
    }
  }

  return metadata;
}

// ==============================================================================
// 3. CHECKOUT-SESSION & LINK-GENERATOR
// ==============================================================================

export interface CreateCheckoutSessionOptions {
  packageType: string;
  email: string;
  company: string;
  leadId?: string;
  steuerId?: string;
  successUrl?: string;
  cancelUrl?: string;
  apiKey?: string;
  dryRun?: boolean;
  extraMetadata?: Record<string, string>;
}

export interface CheckoutSessionResult {
  id: string;
  url: string;
  paymentLink: string;
  packageKey: B2BAuditPackageKey;
  packageName: string;
  amountCents: number;
  amountEur: number;
  currency: string;
  customerEmail: string;
  metadata: B2BCheckoutMetadata;
  status: string;
  isDryRun: boolean;
}

export const DEFAULT_STRIPE_SUCCESS_URL =
  'https://productsafetyengine.com/checkout/success?session_id={CHECKOUT_SESSION_ID}';
export const DEFAULT_STRIPE_CANCEL_URL =
  'https://productsafetyengine.com/checkout/cancel?session_id={CHECKOUT_SESSION_ID}';

/**
 * Erstellt eine B2B Stripe Checkout-Session (Mock/Dry-Run oder API).
 */
export async function createCheckoutSession(
  options: CreateCheckoutSessionOptions
): Promise<CheckoutSessionResult> {
  const pkg = getB2BAuditPackage(options.packageType);
  const metadata = buildB2BCheckoutMetadata({
    lead_id: options.leadId || options.email,
    company: options.company,
    email: options.email,
    paketauswahl: pkg.key,
    steuer_id: options.steuerId,
    extra: options.extraMetadata,
  });

  const apiKey = options.apiKey || process.env.STRIPE_SECRET_KEY;
  const isDryRun =
    options.dryRun ||
    !apiKey ||
    apiKey.startsWith('mock_') ||
    apiKey.startsWith('dummy_');

  if (isDryRun) {
    const randomSuffix = Math.random().toString(36).substring(2, 15);
    const sessionId = `cs_test_${randomSuffix}`;
    const mockUrl = `https://checkout.stripe.com/c/pay/${sessionId}`;

    return {
      id: sessionId,
      url: mockUrl,
      paymentLink: mockUrl,
      packageKey: pkg.key,
      packageName: pkg.name,
      amountCents: pkg.amountCents,
      amountEur: pkg.amountEur,
      currency: pkg.currency,
      customerEmail: metadata.email,
      metadata,
      status: 'open',
      isDryRun: true,
    };
  }

  // Echter REST-Call an die Stripe API via fetch (ohne externe SDK-Abhaengigkeit)
  const bodyParams = new URLSearchParams();
  bodyParams.append('mode', 'payment');
  bodyParams.append('customer_email', metadata.email);
  bodyParams.append(
    'success_url',
    options.successUrl || process.env.STRIPE_SUCCESS_URL || DEFAULT_STRIPE_SUCCESS_URL
  );
  bodyParams.append(
    'cancel_url',
    options.cancelUrl || process.env.STRIPE_CANCEL_URL || DEFAULT_STRIPE_CANCEL_URL
  );
  bodyParams.append('billing_address_collection', 'required');
  bodyParams.append('tax_id_collection[enabled]', 'true');

  bodyParams.append('line_items[0][price_data][currency]', pkg.currency);
  bodyParams.append('line_items[0][price_data][unit_amount]', String(pkg.amountCents));
  bodyParams.append(
    'line_items[0][price_data][product_data][name]',
    `ProductSafetyEngine — ${pkg.name}`
  );
  bodyParams.append(
    'line_items[0][price_data][product_data][description]',
    pkg.description
  );
  bodyParams.append('line_items[0][quantity]', '1');

  for (const [key, val] of Object.entries(metadata)) {
    if (val !== undefined) {
      bodyParams.append(`metadata[${key}]`, val);
    }
  }

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: bodyParams.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Stripe API Error (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as {
    id: string;
    url: string;
    status: string;
    amount_total: number;
    currency: string;
  };

  return {
    id: data.id,
    url: data.url,
    paymentLink: data.url,
    packageKey: pkg.key,
    packageName: pkg.name,
    amountCents: data.amount_total || pkg.amountCents,
    amountEur: pkg.amountEur,
    currency: data.currency || pkg.currency,
    customerEmail: metadata.email,
    metadata,
    status: data.status || 'open',
    isDryRun: false,
  };
}

/**
 * Erzeugt direkt den Zahlungslink fuer das angegebene Paket.
 */
export async function generateCheckoutLink(
  options: CreateCheckoutSessionOptions
): Promise<string> {
  const session = await createCheckoutSession(options);
  return session.url;
}

/**
 * Erzeugt einen vorgefertigten Pitch-Snippet zur direkten Einbindung in E-Mails.
 */
export function generatePitchSnippet(
  packageType: string,
  checkoutUrl: string,
  language: 'de' | 'en' | 'fr' | 'nl' = 'de'
): string {
  const pkg = getB2BAuditPackage(packageType);

  switch (language) {
    case 'de':
      return pkg.key === 'portfolio_audit'
        ? `Zur direkten Freischaltung Ihres Portfolio-Audits (490 € zzgl. USt. für bis zu 1.000 SKUs inkl. Vollprüfung gegen das EU Safety Gate & Prüfbericht) können Sie den gesicherten B2B-Auftrag hier abschließen:\n👉 ${checkoutUrl}`
        : `Zur direkten Freischaltung des Enterprise Audit Plus (1.490 € zzgl. USt. für Ihr gesamtes Sortiment inkl. REACH/SVHC-Tiefenanalyse & 12 Wochen Monitoring) können Sie den gesicherten B2B-Auftrag hier abschließen:\n👉 ${checkoutUrl}`;
    case 'fr':
      return `Pour activer immédiatement votre audit (${pkg.name} — ${pkg.amountEur} € HT) via notre paiement sécurisé Stripe B2B, veuillez utiliser ce lien direct :\n👉 ${checkoutUrl}`;
    case 'nl':
      return `Om uw audit (${pkg.name} — ${pkg.amountEur} € excl. btw) direct te activeren via onze beveiligde Stripe B2B-checkout, kunt u de volgende link gebruiken:\n👉 ${checkoutUrl}`;
    default:
      return `To immediately initiate your ${pkg.name} (${pkg.amountEur} EUR excl. VAT) via our secure Stripe B2B checkout, please use the following link:\n👉 ${checkoutUrl}`;
  }
}

// ==============================================================================
// 4. WEBHOOK-HANDLER & SIGNATUR-VERIFIKATION
// ==============================================================================

export interface StripeWebhookEvent {
  id: string;
  type: string;
  data: {
    object: Record<string, unknown>;
  };
  created: number;
}

export interface AuditOrder {
  orderId: string;
  sessionId: string;
  leadId: string;
  company: string;
  email: string;
  paketauswahl: B2BAuditPackageKey;
  packageName: string;
  amountEur: number;
  amountCents: number;
  currency: string;
  steuerId?: string;
  status: 'UNLOCKED' | 'PENDING' | 'CANCELLED';
  unlockedAt: string;
  metadata: B2BCheckoutMetadata;
}

/**
 * Verifiziert die Stripe Webhook-Signatur mit HMAC-SHA256.
 */
export function verifyStripeWebhookSignature(
  payload: string | Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds: number = 300
): boolean {
  if (!secret) {
    throw new Error('Kein Stripe Webhook Secret uebergeben.');
  }
  if (!signatureHeader) {
    throw new Error('Fehlender Stripe-Signature Header.');
  }

  const items = signatureHeader.split(',');
  let timestamp = -1;
  const v1Signatures: string[] = [];

  for (const item of items) {
    const [key, val] = item.trim().split('=');
    if (key === 't') {
      timestamp = parseInt(val, 10);
    } else if (key === 'v1') {
      v1Signatures.push(val);
    }
  }

  if (timestamp <= 0 || isNaN(timestamp)) {
    throw new Error("Ungueltiger Timestamp 't' im Signature Header.");
  }
  if (v1Signatures.length === 0) {
    throw new Error("Keine 'v1'-Signatur im Signature Header gefunden.");
  }

  if (toleranceSeconds > 0) {
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - timestamp) > toleranceSeconds) {
      throw new Error(`Timestamp ausserhalb der Toleranz (${Math.abs(now - timestamp)}s > ${toleranceSeconds}s).`);
    }
  }

  const payloadString = typeof payload === 'string' ? payload : payload.toString('utf-8');
  const signedPayload = `${timestamp}.${payloadString}`;

  const expectedSignature = createHmac('sha256', secret)
    .update(signedPayload, 'utf-8')
    .digest('hex');

  const expectedBuffer = Buffer.from(expectedSignature, 'utf-8');

  for (const sig of v1Signatures) {
    const sigBuffer = Buffer.from(sig, 'utf-8');
    if (sigBuffer.length === expectedBuffer.length && timingSafeEqual(sigBuffer, expectedBuffer)) {
      return true;
    }
  }

  throw new Error('Signatur-Abgleich fehlgeschlagen.');
}

/**
 * Schaltet nach Eingang des Webhook-Events 'checkout.session.completed' den Audit-Auftrag frei.
 */
export function unlockAuditOrderFromWebhook(event: StripeWebhookEvent): AuditOrder {
  if (event.type !== 'checkout.session.completed') {
    throw new Error(`Event-Typ '${event.type}' ist keine abgeschlossene Checkout-Session.`);
  }

  const sessionObj = event.data.object;
  const rawMeta = (sessionObj.metadata || {}) as Record<string, string>;
  const pkg = getB2BAuditPackage(rawMeta.paketauswahl || 'portfolio_audit');

  const randomSuffix = Math.random().toString(36).substring(2, 10);
  const orderId = `ord_${randomSuffix}`;
  const nowIso = new Date().toISOString();

  const metadata = buildB2BCheckoutMetadata({
    lead_id: rawMeta.lead_id || String(sessionObj.customer_email || ''),
    company: rawMeta.company || 'B2B Kunde',
    email: rawMeta.email || String(sessionObj.customer_email || ''),
    paketauswahl: pkg.key,
    steuer_id: rawMeta.steuer_id,
  });

  return {
    orderId,
    sessionId: String(sessionObj.id || ''),
    leadId: metadata.lead_id,
    company: metadata.company,
    email: metadata.email,
    paketauswahl: pkg.key,
    packageName: pkg.name,
    amountEur: pkg.amountEur,
    amountCents: Number(sessionObj.amount_total) || pkg.amountCents,
    currency: String(sessionObj.currency || 'eur').toLowerCase(),
    steuerId: metadata.steuer_id,
    status: 'UNLOCKED',
    unlockedAt: nowIso,
    metadata,
  };
}
