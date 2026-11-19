import { describe, it, expect, vi } from 'vitest';
import {
  dispatchWebhook,
  parseRetryAfter,
  DEFAULT_USER_AGENT,
  type DispatchWebhookOptions,
} from '../src/webhook.js';
import { signPayload } from '@productsafetyengine/core';

describe('dispatchWebhook', () => {
  const validUrl = 'https://api.example.com/webhook/endpoint';
  const samplePayload = {
    schema: 'pse.alert.v1',
    event: 'test.alert',
    data: { id: 123, title: 'Sample Alert' },
  };

  describe('Akzeptanzkriterium 1: Der Ablauf 500 → 500 → 200 ergibt ok=true und attempts=3', () => {
    it('wiederholt bei 500 mit exponentiellem Backoff und ist bei 200 erfolgreich', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }))
        .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ received: true }), { status: 200, statusText: 'OK' }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        baseDelayMs: 500,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.attempts).toBe(3);
      expect(fetch).toHaveBeenCalledTimes(3);

      // Exponentieller Backoff:
      // Versuch 1 fehlgeschlagen -> sleep(500 * 2^0) = 500 ms
      // Versuch 2 fehlgeschlagen -> sleep(500 * 2^1) = 1000 ms
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenNthCalledWith(1, 500);
      expect(sleep).toHaveBeenNthCalledWith(2, 1000);
    });

    it('bricht nach maxAttempts ab, wenn alle Versuche 500 liefern', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValue(new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        baseDelayMs: 200,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(500);
      expect(result.attempts).toBe(3);
      expect(result.error).toContain('500');
      expect(fetch).toHaveBeenCalledTimes(3);
      // Zwischen den 3 Versuchen wird 2-mal gewartet, nicht nach dem letzten
      expect(sleep).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenNthCalledWith(1, 200);
      expect(sleep).toHaveBeenNthCalledWith(2, 400);
    });
  });

  describe('Akzeptanzkriterium 2: 400 ergibt ok=false und attempts=1', () => {
    it('bricht bei 400 sofort ohne Retry ab', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('Bad Request', { status: 400, statusText: 'Bad Request' }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(false);
      expect(result.status).toBe(400);
      expect(result.attempts).toBe(1);
      expect(result.error).toContain('400');
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('führt auch bei anderen 4xx-Statuscodes (z. B. 401, 403, 404) keinen Retry aus', async () => {
      for (const status of [401, 403, 404, 422]) {
        const sleep = vi.fn().mockResolvedValue(undefined);
        const fetch = vi
          .fn()
          .mockResolvedValueOnce(new Response('Client Error', { status, statusText: 'Client Error' }));

        const result = await dispatchWebhook(validUrl, samplePayload, {
          fetch,
          sleep,
          maxAttempts: 3,
        });

        expect(result.ok).toBe(false);
        expect(result.status).toBe(status);
        expect(result.attempts).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      }
    });
  });

  describe('Akzeptanzkriterium 3: Retry-After bei 429 wird beachtet (geprüft über das injizierte sleep)', () => {
    it('beachtet Retry-After in Sekunden bei HTTP 429', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': '5' },
          })
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.status).toBe(200);
      expect(result.attempts).toBe(2);
      expect(fetch).toHaveBeenCalledTimes(2);

      // 5 Sekunden -> 5000 ms
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(5000);
    });

    it('deckelt Retry-After auf maximal 30 Sekunden (30.000 ms)', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response('Too Many Requests', {
            status: 429,
            headers: { 'Retry-After': '120' }, // 120s uebersteigt 30s Cap
          })
        )
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(30_000);
    });

    it('fällt bei 429 ohne Retry-After auf exponentiellen Backoff zurück', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(new Response('Too Many Requests', { status: 429 }))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        baseDelayMs: 300,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(sleep).toHaveBeenCalledWith(300);
    });
  });

  describe('Akzeptanzkriterium 4: Eine ungültige oder private URL führt zu ok=false ohne fetch-Aufruf', () => {
    it('lehnt nicht-https URLs ab ohne fetch aufzurufen', async () => {
      const fetch = vi.fn();
      const result = await dispatchWebhook('http://example.com/webhook', samplePayload, { fetch });

      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toContain('https');
      expect(fetch).not.toHaveBeenCalled();
    });

    it('lehnt localhost und Metadata-Hosts ab ohne fetch aufzurufen', async () => {
      const blockedHosts = [
        'https://localhost/hook',
        'https://localhost:8080/hook',
        'https://sub.localhost/hook',
        'https://metadata.google.internal/computeMetadata/v1/',
        'https://metadata/hook',
        'https://instance-data/hook',
      ];

      for (const url of blockedHosts) {
        const fetch = vi.fn();
        const result = await dispatchWebhook(url, samplePayload, { fetch });
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
      }
    });

    it('lehnt private IPv4- und IPv6-Adressen ab ohne fetch aufzurufen', async () => {
      const privateUrls = [
        'https://127.0.0.1:3000/hook',
        'https://10.0.0.1/hook',
        'https://192.168.1.1/hook',
        'https://172.16.0.1/hook',
        'https://169.254.169.254/latest/meta-data',
        'https://[::1]/hook',
        'https://[fc00::1]/hook',
        'https://[fe80::1]/hook',
        'https://[::ffff:127.0.0.1]/hook',
      ];

      for (const url of privateUrls) {
        const fetch = vi.fn();
        const result = await dispatchWebhook(url, samplePayload, { fetch });
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
      }
    });

    it('lehnt ungültige oder leere URLs ab ohne fetch aufzurufen', async () => {
      for (const url of ['', '   ', 'not-a-valid-url', 'ftp://example.com']) {
        const fetch = vi.fn();
        const result = await dispatchWebhook(url, samplePayload, { fetch });
        expect(result.ok).toBe(false);
        expect(result.attempts).toBe(0);
        expect(fetch).not.toHaveBeenCalled();
      }
    });
  });

  describe('Akzeptanzkriterium 5: Die Signatur-Header werden korrekt gesetzt', () => {
    it('setzt X-PSE-Signature und X-PSE-Timestamp bei gesetztem Secret', async () => {
      const secret = 'super_secret_webhook_key_123';
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn().mockImplementation(async (_url, init) => {
        capturedInit = init;
        return new Response('OK', { status: 200 });
      });

      const result = await dispatchWebhook(validUrl, samplePayload, {
        secret,
        fetch,
      });

      expect(result.ok).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(capturedInit).toBeDefined();

      const headers = capturedInit!.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
      expect(headers['User-Agent']).toMatch(/^eu-product-safety-engine\/\d+\.\d+\.\d+$/);

      // Signatur pruefen
      const expectedSignature = signPayload(JSON.stringify(samplePayload), secret);
      expect(headers['X-PSE-Signature']).toBe(expectedSignature);
      expect(headers['X-PSE-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);

      // Timestamp pruefen
      expect(headers['X-PSE-Timestamp']).toBeDefined();
      const tsNum = Number(headers['X-PSE-Timestamp']);
      expect(Number.isNaN(tsNum)).toBe(false);
      expect(tsNum).toBeGreaterThan(0);
    });

    it('setzt keine X-PSE-Header, wenn kein Secret uebergeben wird', async () => {
      let capturedInit: RequestInit | undefined;
      const fetch = vi.fn().mockImplementation(async (_url, init) => {
        capturedInit = init;
        return new Response('OK', { status: 200 });
      });

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
      });

      expect(result.ok).toBe(true);
      const headers = capturedInit!.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBe(DEFAULT_USER_AGENT);
      expect(headers['X-PSE-Signature']).toBeUndefined();
      expect(headers['X-PSE-Timestamp']).toBeUndefined();
    });
  });

  describe('Zusätzliche Robustheit & Fehlerbehandlung', () => {
    it('wiederholt bei Netzwerkfehlern bis maxAttempts', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(new Response('OK', { status: 200 }));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        maxAttempts: 3,
      });

      expect(result.ok).toBe(true);
      expect(result.attempts).toBe(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('bricht mit Fehlermeldung ab, wenn alle Netzwerkversuche fehlschlagen', async () => {
      const sleep = vi.fn().mockResolvedValue(undefined);
      const fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

      const result = await dispatchWebhook(validUrl, samplePayload, {
        fetch,
        sleep,
        maxAttempts: 2,
      });

      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(2);
      expect(result.error).toContain('Network offline');
      expect(result.status).toBeUndefined();
    });

    it('wirft niemals eine Exception bei zirkulaeren Payloads', async () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;

      const result = await dispatchWebhook(validUrl, circular);
      expect(result.ok).toBe(false);
      expect(result.attempts).toBe(0);
      expect(result.error).toBeDefined();
    });
  });

  describe('parseRetryAfter Hilfsfunktion', () => {
    it('parst gueltige Sekunden', () => {
      expect(parseRetryAfter('10')).toBe(10_000);
      expect(parseRetryAfter('0')).toBe(0);
      expect(parseRetryAfter('2.5')).toBe(2500);
    });

    it('parst HTTP-Date in der Zukunft', () => {
      const futureDate = new Date(Date.now() + 15_000).toUTCString();
      const parsed = parseRetryAfter(futureDate);
      expect(parsed).not.toBeNull();
      expect(parsed).toBeGreaterThan(13_000);
      expect(parsed).toBeLessThanOrEqual(15_500);
    });

    it('gibt null fuer ungueltige oder leere Werte zurueck', () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter(undefined)).toBeNull();
      expect(parseRetryAfter('')).toBeNull();
      expect(parseRetryAfter('-5')).toBeNull();
      expect(parseRetryAfter('invalid-header')).toBeNull();
    });
  });
});
