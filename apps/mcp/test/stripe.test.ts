/**
 * apps/mcp/test/stripe.test.ts
 *
 * Unit tests fuer apps/mcp/src/stripe.ts (B2B High-Ticket Stripe Checkout).
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  getB2BAuditPackage,
  buildB2BCheckoutMetadata,
  createCheckoutSession,
  generateCheckoutLink,
  generatePitchSnippet,
  verifyStripeWebhookSignature,
  unlockAuditOrderFromWebhook,
  PORTFOLIO_AUDIT_PACKAGE,
  AUDIT_PLUS_PACKAGE,
  type StripeWebhookEvent,
} from '../src/stripe.js';

describe('B2B Audit Packages & Metadata', () => {
  it('resolves portfolio_audit (490 EUR) and audit_plus (1490 EUR)', () => {
    const pa = getB2BAuditPackage('portfolio_audit');
    expect(pa.key).toBe('portfolio_audit');
    expect(pa.amountEur).toBe(490);
    expect(pa.amountCents).toBe(49000);
    expect(pa.skuLimit).toBe(1000);

    const ap = getB2BAuditPackage('audit_plus');
    expect(ap.key).toBe('audit_plus');
    expect(ap.amountEur).toBe(1490);
    expect(ap.amountCents).toBe(149000);
    expect(ap.skuLimit).toBeNull();

    // Aliases
    expect(getB2BAuditPackage('490').key).toBe('portfolio_audit');
    expect(getB2BAuditPackage('1490').key).toBe('audit_plus');
    expect(getB2BAuditPackage('audit').key).toBe('portfolio_audit');
    expect(getB2BAuditPackage('plus').key).toBe('audit_plus');
  });

  it('throws on unknown package identifier', () => {
    expect(() => getB2BAuditPackage('unknown_pkg')).toThrow(/Ungueltiges Paket/);
  });

  it('builds normalized B2B checkout metadata', () => {
    const meta = buildB2BCheckoutMetadata({
      lead_id: 'lead_abc',
      company: 'Test Spielzeug GmbH',
      email: 'CONTACT@TEST-SPIELZEUG.DE',
      paketauswahl: 'portfolio_audit',
      steuer_id: 'DE123456789',
    });

    expect(meta.lead_id).toBe('lead_abc');
    expect(meta.company).toBe('Test Spielzeug GmbH');
    expect(meta.email).toBe('contact@test-spielzeug.de');
    expect(meta.paketauswahl).toBe('portfolio_audit');
    expect(meta.steuer_id).toBe('DE123456789');
    expect(meta['steuer-id']).toBe('DE123456789');
  });
});

describe('Checkout Sessions & Link Generation', () => {
  it('creates dry-run checkout session for Portfolio Audit (490 EUR)', async () => {
    const res = await createCheckoutSession({
      packageType: 'portfolio_audit',
      email: 'buyer@toys.de',
      company: 'Toys DE',
      steuerId: 'DE999888777',
      dryRun: true,
    });

    expect(res.amountEur).toBe(490);
    expect(res.amountCents).toBe(49000);
    expect(res.currency).toBe('eur');
    expect(res.packageKey).toBe('portfolio_audit');
    expect(res.url).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
    expect(res.metadata.steuer_id).toBe('DE999888777');
    expect(res.isDryRun).toBe(true);
  });

  it('creates dry-run checkout session for Audit Plus (1490 EUR)', async () => {
    const res = await createCheckoutSession({
      packageType: 'audit_plus',
      email: 'enterprise@toys.com',
      company: 'Toys Enterprise Inc',
      dryRun: true,
    });

    expect(res.amountEur).toBe(1490);
    expect(res.amountCents).toBe(149000);
    expect(res.packageKey).toBe('audit_plus');
    expect(res.isDryRun).toBe(true);
  });

  it('generates direct checkout link', async () => {
    const link = await generateCheckoutLink({
      packageType: 'portfolio_audit',
      email: 'direct@lead.com',
      company: 'Direct Lead',
      dryRun: true,
    });

    expect(link).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);
  });

  it('generates pitch snippets in different languages', () => {
    const dummyUrl = 'https://checkout.stripe.com/c/pay/cs_test_123';

    const de = generatePitchSnippet('portfolio_audit', dummyUrl, 'de');
    expect(de).toContain('490 €');
    expect(de).toContain(dummyUrl);

    const dePlus = generatePitchSnippet('audit_plus', dummyUrl, 'de');
    expect(dePlus).toContain('1.490 €');
    expect(dePlus).toContain('Audit Plus');

    const fr = generatePitchSnippet('portfolio_audit', dummyUrl, 'fr');
    expect(fr).toContain('490 € HT');

    const nl = generatePitchSnippet('audit_plus', dummyUrl, 'nl');
    expect(nl).toContain('1490 € excl. btw');

    const en = generatePitchSnippet('portfolio_audit', dummyUrl, 'en');
    expect(en).toContain('490 EUR excl. VAT');
  });
});

describe('Stripe Webhook Signature & Order Unlocking', () => {
  const secret = 'whsec_test_secret_mcp_123';

  function signPayload(payload: string, timestamp: number): string {
    const signedPayload = `${timestamp}.${payload}`;
    const hash = createHmac('sha256', secret).update(signedPayload, 'utf-8').digest('hex');
    return `t=${timestamp},v1=${hash}`;
  }

  it('verifies valid webhook signature', () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const now = Math.floor(Date.now() / 1000);
    const header = signPayload(payload, now);

    expect(verifyStripeWebhookSignature(payload, header, secret)).toBe(true);
  });

  it('throws on invalid webhook signature', () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},v1=invalid_hash_signature`;

    expect(() => verifyStripeWebhookSignature(payload, header, secret)).toThrow(/Signatur-Abgleich fehlgeschlagen/);
  });

  it('throws on expired timestamp outside tolerance', () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed' });
    const expiredTimestamp = 1700000000;
    const header = `t=${expiredTimestamp},v1=some_signature`;

    expect(() => verifyStripeWebhookSignature(payload, header, secret, 300)).toThrow(/Timestamp ausserhalb der Toleranz/);
  });

  it('unlocks audit order from completed checkout session event', () => {
    const event: StripeWebhookEvent = {
      id: 'evt_123',
      type: 'checkout.session.completed',
      created: 1700000000,
      data: {
        object: {
          id: 'cs_test_completed_session',
          customer_email: 'buyer@company.de',
          amount_total: 49000,
          currency: 'eur',
          metadata: {
            lead_id: 'lead_777',
            company: 'Company DE',
            email: 'buyer@company.de',
            paketauswahl: 'portfolio_audit',
            steuer_id: 'DE555666777',
          },
        },
      },
    };

    const order = unlockAuditOrderFromWebhook(event);
    expect(order.status).toBe('UNLOCKED');
    expect(order.sessionId).toBe('cs_test_completed_session');
    expect(order.leadId).toBe('lead_777');
    expect(order.amountEur).toBe(490);
    expect(order.amountCents).toBe(49000);
    expect(order.steuerId).toBe('DE555666777');
    expect(order.metadata.paketauswahl).toBe('portfolio_audit');
  });
});
