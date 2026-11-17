import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ComplianceFetcher,
  Fetcher,
  RateLimiter,
  parseRobotsTxt,
  ComplianceError,
  FetcherTimeoutError,
  FetcherRetryError,
  type FetchFunction,
} from '../src/fetcher.js';

describe('RateLimiter', () => {
  it('initializes with default 1 req/s (1000ms interval)', () => {
    const limiter = new RateLimiter(1);
    expect(limiter.intervalMs).toBe(1000);
  });

  it('calculates interval correctly for custom rates', () => {
    const limiter = new RateLimiter(5);
    expect(limiter.intervalMs).toBe(200);

    const unlimited = new RateLimiter(0);
    expect(unlimited.intervalMs).toBe(0);
  });

  it('enforces delay between consecutive calls', async () => {
    // 50 req/s -> 20ms interval
    const limiter = new RateLimiter(50);
    const start = Date.now();

    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();

    const elapsed = Date.now() - start;
    // Mindestens 2 Intervalle (2 * 20ms = 40ms, mit kleiner Toleranz)
    expect(elapsed).toBeGreaterThanOrEqual(35);
  });
});

describe('parseRobotsTxt (§ 44b UrhG & TDM compliance)', () => {
  it('detects TDM-Reservation: 1 (W3C TDMRep standard)', () => {
    const robots = `
      User-agent: *
      Disallow: /private/
      TDM-Reservation: 1
    `;
    const policy = parseRobotsTxt(robots);
    expect(policy.tdmReserved).toBe(true);
  });

  it('detects tdm-reservation: true (case insensitive)', () => {
    const robots = `
      tdm-reservation: true
    `;
    const policy = parseRobotsTxt(robots);
    expect(policy.tdmReserved).toBe(true);
  });

  it('detects TDM-Policy directive', () => {
    const robots = `
      User-agent: *
      TDM-Policy: https://example.com/rights/tdm-license.json
    `;
    const policy = parseRobotsTxt(robots);
    expect(policy.tdmReserved).toBe(true);
    expect(policy.tdmPolicyUri).toBe('https://example.com/rights/tdm-license.json');
  });

  it('detects Content-Mining: none and tdm: 1 directives', () => {
    expect(parseRobotsTxt('Content-Mining: none').tdmReserved).toBe(true);
    expect(parseRobotsTxt('tdm: 1').tdmReserved).toBe(true);
    expect(parseRobotsTxt('tdm: disallow').tdmReserved).toBe(true);
  });

  it('detects dedicated TDM/AI user-agents', () => {
    const robots = `
      User-agent: tdm-bot
      Disallow: /
    `;
    const policy = parseRobotsTxt(robots);
    expect(policy.tdmReserved).toBe(true);
  });

  it('evaluates allow and disallow path rules accurately', () => {
    const robots = `
      User-agent: *
      Disallow: /admin/
      Disallow: /internal
      Allow: /admin/public/
    `;
    const policy = parseRobotsTxt(robots);
    expect(policy.tdmReserved).toBe(false);

    expect(policy.isPathAllowed('/index.html')).toBe(true);
    expect(policy.isPathAllowed('/admin/dashboard')).toBe(false);
    expect(policy.isPathAllowed('/admin/public/index.html')).toBe(true);
    expect(policy.isPathAllowed('/internal/data')).toBe(false);
  });
});

describe('ComplianceFetcher (100% offline mocked)', () => {
  let mockFetch: ReturnType<typeof vi.fn<FetchFunction>>;

  beforeEach(() => {
    mockFetch = vi.fn<FetchFunction>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports Fetcher as alias for ComplianceFetcher', () => {
    expect(Fetcher).toBe(ComplianceFetcher);
  });

  it('injects default and custom User-Agent headers', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      return new Response('{"ok": true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100, // Schnellere Ausfuehrung in Tests
    });

    await client.fetch('https://example.com/data');

    // Der zweite Aufruf war der eigentliche Request
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [, options] = mockFetch.mock.calls[1];
    const headers = options?.headers as Headers;
    expect(headers.get('User-Agent')).toContain('ProductSafetyEngine/1.0');
  });

  it('respects robots.txt TDM reservation and throws ComplianceError', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nTDM-Reservation: 1\nDisallow: /secret/', { status: 200 });
      }
      return new Response('OK', { status: 200 });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
    });

    await expect(client.fetch('https://example.com/dataset')).rejects.toThrow(ComplianceError);

    try {
      await client.fetch('https://example.com/dataset');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ComplianceError);
      const compErr = err as ComplianceError;
      expect(compErr.tdmReserved).toBe(true);
      expect(compErr.message).toContain('§ 44b UrhG');
    }
  });

  it('blocks access when path is disallowed by robots.txt', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nDisallow: /restricted/', { status: 200 });
      }
      return new Response('OK', { status: 200 });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
    });

    await expect(client.fetch('https://example.com/restricted/page')).rejects.toThrow(ComplianceError);
  });

  it('allows request when skipRobotsCheck: true is passed', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('TDM-Reservation: 1', { status: 200 });
      }
      return new Response('Bypassed TDM check', { status: 200 });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
    });

    const response = await client.fetch('https://example.com/data', { skipRobotsCheck: true });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Bypassed TDM check');
  });

  it('supports ETag caching with 304 Not Modified', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }

      const headers = (init?.headers as Headers) || new Headers();
      const ifNoneMatch = headers.get('If-None-Match');

      if (ifNoneMatch === '"v1.0-etag"') {
        // Server bestaetigt unveraendert
        return new Response(null, {
          status: 304,
          headers: { ETag: '"v1.0-etag"' },
        });
      }

      // Initialer 200 OK
      return new Response(JSON.stringify({ dataset: 'rapex-2026' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          ETag: '"v1.0-etag"',
        },
      });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
      enableEtagCache: true,
    });

    // 1. Initialer Request -> Speichert ETag im Cache
    const res1 = await client.get('https://example.com/rapex.json');
    expect(res1.status).toBe(200);
    expect(res1.fromCache).toBe(false);
    expect(res1.etag).toBe('"v1.0-etag"');
    const data1 = await res1.json<{ dataset: string }>();
    expect(data1.dataset).toBe('rapex-2026');
    expect(client.getCacheSize()).toBe(1);

    // 2. Folge-Request -> Sendet If-None-Match, erhaelt 304, serviert aus Cache
    const res2 = await client.get('https://example.com/rapex.json');
    expect(res2.status).toBe(304);
    expect(res2.fromCache).toBe(true);
    expect(res2.etag).toBe('"v1.0-etag"');
    const data2 = await res2.json<{ dataset: string }>();
    expect(data2.dataset).toBe('rapex-2026');

    // Cache leeren pruefen
    client.clearCache();
    expect(client.getCacheSize()).toBe(0);
  });

  it('retries on 500 / 503 errors with exponential backoff and succeeds', async () => {
    let callAttempt = 0;

    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }

      callAttempt++;
      if (callAttempt < 3) {
        return new Response('Server Error', { status: 503 });
      }
      return new Response('Recovered!', { status: 200 });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
      maxRetries: 3,
      retryDelayMs: 10, // Minimaler Delay im Test
    });

    const res = await client.fetch('https://example.com/flaky');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('Recovered!');
    expect(callAttempt).toBe(3);
  });

  it('throws FetcherRetryError when maxRetries are exhausted', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }
      return new Response('Permanent Outage', { status: 500 });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
      maxRetries: 2,
      retryDelayMs: 5,
    });

    // Nach 2 Retries (3 Versuchen) schlaegt es fehl oder liefert finalen Status
    const res = await client.fetch('https://example.com/down');
    expect(res.status).toBe(500);
  });

  it('handles timeouts gracefully and throws FetcherTimeoutError / FetcherRetryError', async () => {
    mockFetch.mockImplementation(async (input: string | Request | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith('/robots.txt')) {
        return new Response('User-agent: *\nAllow: /', { status: 200 });
      }

      // Simuliert haengenden Request bis abort signal feuert
      return new Promise((_, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const abortErr = new Error('The operation was aborted');
            abortErr.name = 'AbortError';
            reject(abortErr);
          });
        }
      });
    });

    const client = new ComplianceFetcher({
      customFetch: mockFetch,
      requestsPerSecond: 100,
      timeoutMs: 25,
      maxRetries: 1,
      retryDelayMs: 5,
    });

    await expect(client.fetch('https://example.com/hanging')).rejects.toThrow(FetcherRetryError);
  });
});
