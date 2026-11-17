import { describe, it, expect, beforeEach } from 'vitest';
import {
  HTTP_402_HEADERS,
  createHttp402Headers,
  createHttp402Metadata,
  NoopPaymentGate,
  type IPaymentGate,
  type ToolCallContext,
  type PaymentProof,
} from '../src/payment.js';

describe('PaymentGate & HTTP 402 / MPP (F10)', () => {
  describe('HTTP 402 Metadaten-Header-Struktur', () => {
    it('sollte alle noetigen HTTP 402 Header-Konstanten definieren', () => {
      expect(HTTP_402_HEADERS.PAYMENT_REQUIRED).toBe('X-Payment-Required');
      expect(HTTP_402_HEADERS.PROTOCOL).toBe('X-Payment-Protocol');
      expect(HTTP_402_HEADERS.COST_CREDITS).toBe('X-Cost-Credits');
      expect(HTTP_402_HEADERS.AMOUNT).toBe('X-Payment-Amount');
      expect(HTTP_402_HEADERS.CURRENCY).toBe('X-Payment-Currency');
      expect(HTTP_402_HEADERS.TOKEN).toBe('X-Payment-Token');
      expect(HTTP_402_HEADERS.CHALLENGE).toBe('X-Payment-Challenge');
      expect(HTTP_402_HEADERS.PAYMENT_URL).toBe('X-Payment-Url');
      expect(HTTP_402_HEADERS.TOOL_NAME).toBe('X-Payment-Tool');
      expect(HTTP_402_HEADERS.RECIPIENT).toBe('X-Payment-Recipient');
    });

    it('erzeugt Standard-Header mit createHttp402Headers()', () => {
      const headers = createHttp402Headers();
      expect(headers['X-Payment-Required']).toBe('true');
      expect(headers['X-Payment-Protocol']).toBe('stripe-mpp/1.0');
      expect(headers['X-Cost-Credits']).toBe('1');
    });

    it('erzeugt vollstaendige Header bei individuellen Parametern', () => {
      const headers = createHttp402Headers({
        toolName: 'check_ean_safety',
        costCredits: 3,
        amount: 0.05,
        currency: 'EUR',
        paymentUrl: 'https://api.stripe.com/v1/mpp/charge',
        challenge: 'mpp_challenge_xyz123',
        recipient: 'acct_safetygate_001',
        protocol: 'x402/stripe',
      });

      expect(headers['X-Payment-Required']).toBe('true');
      expect(headers['X-Payment-Protocol']).toBe('x402/stripe');
      expect(headers['X-Cost-Credits']).toBe('3');
      expect(headers['X-Payment-Tool']).toBe('check_ean_safety');
      expect(headers['X-Payment-Amount']).toBe('0.05');
      expect(headers['X-Payment-Currency']).toBe('EUR');
      expect(headers['X-Payment-Url']).toBe('https://api.stripe.com/v1/mpp/charge');
      expect(headers['X-Payment-Challenge']).toBe('mpp_challenge_xyz123');
      expect(headers['X-Payment-Recipient']).toBe('acct_safetygate_001');
    });

    it('erzeugt das vollstaendige Http402Metadata-Objekt mit Status 402', () => {
      const metadata = createHttp402Metadata({
        toolName: 'search_product_recalls',
        costCredits: 2,
        amount: 0.02,
        currency: 'EUR',
        paymentUrl: 'https://api.stripe.com/mpp',
      });

      expect(metadata.status).toBe(402);
      expect(metadata.costCredits).toBe(2);
      expect(metadata.toolName).toBe('search_product_recalls');
      expect(metadata.protocol).toBe('stripe-mpp/1.0');
      expect(metadata.amount).toBe(0.02);
      expect(metadata.currency).toBe('EUR');
      expect(metadata.paymentUrl).toBe('https://api.stripe.com/mpp');
      expect(metadata.headers['X-Payment-Required']).toBe('true');
      expect(metadata.headers['X-Cost-Credits']).toBe('2');
      expect(metadata.headers['X-Payment-Tool']).toBe('search_product_recalls');
    });
  });

  describe('IPaymentGate & NoopPaymentGate Implementierung', () => {
    let gate: NoopPaymentGate;

    beforeEach(() => {
      gate = new NoopPaymentGate();
    });

    it('erfuellt das IPaymentGate Interface polymorph', async () => {
      const paymentGate: IPaymentGate = gate;
      expect(typeof paymentGate.verifyPayment).toBe('function');
      expect(typeof paymentGate.authorizeToolCall).toBe('function');
    });

    it('laesst Offline-/Dev-Aufrufe unblockiert durch (authorized: true)', async () => {
      const result = await gate.authorizeToolCall('check_ean_safety');

      expect(result.authorized).toBe(true);
      expect(result.toolName).toBe('check_ean_safety');
      expect(result.costCredits).toBe(1);
      expect(result.consumedCredits).toBe(1);
      expect(gate.callCount).toBe(1);
    });

    it('zaehlt verbrauchte Credits korrekt auf (Standardkosten)', async () => {
      expect(gate.totalConsumedCredits).toBe(0);
      expect(gate.getConsumedCredits()).toBe(0);

      await gate.authorizeToolCall('check_ean_safety');
      await gate.authorizeToolCall('search_product_recalls');
      await gate.authorizeToolCall('get_chemical_restrictions');

      expect(gate.totalConsumedCredits).toBe(3);
      expect(gate.callCount).toBe(3);
    });

    it('beruecksichtigt individuelle costCredits aus dem ToolCallContext', async () => {
      const ctx1: ToolCallContext = { costCredits: 5 };
      const ctx2: ToolCallContext = { costCredits: 10 };

      const res1 = await gate.authorizeToolCall('heavy_search', ctx1);
      expect(res1.costCredits).toBe(5);
      expect(res1.consumedCredits).toBe(5);

      const res2 = await gate.authorizeToolCall('heavy_search', ctx2);
      expect(res2.costCredits).toBe(10);
      expect(res2.consumedCredits).toBe(15);
      expect(gate.totalConsumedCredits).toBe(15);
    });

    it('zaehlt verbrauchte Credits granular pro Client-ID', async () => {
      await gate.authorizeToolCall('check_ean_safety', { clientId: 'agent-alpha', costCredits: 2 });
      await gate.authorizeToolCall('check_ean_safety', { clientId: 'agent-beta', costCredits: 3 });
      await gate.authorizeToolCall('search_product_recalls', { clientId: 'agent-alpha', costCredits: 4 });

      expect(gate.getConsumedCredits('agent-alpha')).toBe(6);
      expect(gate.getConsumedCredits('agent-beta')).toBe(3);
      expect(gate.getConsumedCredits('unknown-agent')).toBe(0);
      expect(gate.totalConsumedCredits).toBe(9);
    });

    it('zaehlt verbrauchte Credits granular pro Tool-Name', async () => {
      await gate.authorizeToolCall('check_ean_safety', { costCredits: 2 });
      await gate.authorizeToolCall('check_ean_safety', { costCredits: 1 });
      await gate.authorizeToolCall('monitor_weekly_alerts', { costCredits: 5 });

      expect(gate.getToolConsumedCredits('check_ean_safety')).toBe(3);
      expect(gate.getToolConsumedCredits('monitor_weekly_alerts')).toBe(5);
      expect(gate.getToolConsumedCredits('uncalled_tool')).toBe(0);
    });

    it('resettet alle Zaehler bei resetCredits()', async () => {
      await gate.authorizeToolCall('check_ean_safety', { clientId: 'agent-1', costCredits: 5 });
      expect(gate.totalConsumedCredits).toBe(5);
      expect(gate.callCount).toBe(1);

      gate.resetCredits();

      expect(gate.totalConsumedCredits).toBe(0);
      expect(gate.callCount).toBe(0);
      expect(gate.getConsumedCredits('agent-1')).toBe(0);
      expect(gate.getToolConsumedCredits('check_ean_safety')).toBe(0);
    });

    it('unterstuetzt benutzerdefinierte defaultCreditCost im Konstruktor', async () => {
      const customGate = new NoopPaymentGate({ defaultCreditCost: 3 });
      const res = await customGate.authorizeToolCall('tool_x');

      expect(res.costCredits).toBe(3);
      expect(customGate.totalConsumedCredits).toBe(3);
    });

    it('behandelt negative costCredits robust (keine negativen Abzuege)', async () => {
      await gate.authorizeToolCall('tool_neg', { costCredits: -5 });
      expect(gate.totalConsumedCredits).toBe(0);
    });

    it('verifiziert Zahlungsnachweise via verifyPayment() im Noop/Dev-Modus', async () => {
      // String-Token Test
      const strRes = await gate.verifyPayment('tok_stripe_mpp_test123');
      expect(strRes.valid).toBe(true);
      expect(strRes.payerId).toBe('dev-noop-payer');
      expect(strRes.transactionId).toBe('tok_stripe_mpp_test123');

      // PaymentProof-Objekt Test
      const proof: PaymentProof = {
        token: 'tok_mpp_456',
        payerId: 'client_agent_deepmind',
        transactionId: 'tx_789',
        amount: 1.5,
        currency: 'EUR',
      };
      const objRes = await gate.verifyPayment(proof);
      expect(objRes.valid).toBe(true);
      expect(objRes.payerId).toBe('client_agent_deepmind');
      expect(objRes.transactionId).toBe('tx_789');
      expect(objRes.amount).toBe(1.5);
    });
  });
});
