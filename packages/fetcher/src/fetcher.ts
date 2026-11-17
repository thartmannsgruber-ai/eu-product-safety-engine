/**
 * packages/fetcher/src/fetcher.ts
 *
 * Ressourcenschonender HTTP-Client (nur fetch, kein Browser) mit:
 * - Konfigurierbarem Rate-Limiter (Default: max 1 req/s)
 * - ETag-Caching (If-None-Match / 304 Handling)
 * - User-Agent-Management
 * - robots.txt-Compliance & TDM-Vorbehaltspruefung nach § 44b UrhG (W3C TDMRep / DSM-RL Art. 4)
 * - Timeout via AbortSignal
 * - Exponential Backoff Retries bei transienten Fehlern & 429/5xx
 */

export class FetcherError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FetcherError';
  }
}

export class FetcherTimeoutError extends FetcherError {
  constructor(message = 'Request timed out') {
    super(message);
    this.name = 'FetcherTimeoutError';
  }
}

export class FetcherRetryError extends FetcherError {
  public readonly attempts: number;
  public readonly lastError?: Error;

  constructor(message: string, attempts: number, lastError?: Error) {
    super(message, { cause: lastError });
    this.name = 'FetcherRetryError';
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

export class ComplianceError extends FetcherError {
  public readonly url: string;
  public readonly tdmReserved: boolean;

  constructor(message: string, options: { url: string; tdmReserved: boolean }) {
    super(message);
    this.name = 'ComplianceError';
    this.url = options.url;
    this.tdmReserved = options.tdmReserved;
  }
}

export type FetchFunction = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

export interface FetcherOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  backoffFactor?: number;
  requestsPerSecond?: number;
  enableEtagCache?: boolean;
  checkRobotsTxt?: boolean;
  customFetch?: FetchFunction;
}

export interface FetcherRequestInit extends RequestInit {
  skipRobotsCheck?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export interface FetcherResponse {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Headers;
  url: string;
  fromCache: boolean;
  etag?: string;
  text(): Promise<string>;
  json<T = unknown>(): Promise<T>;
  arrayBuffer(): Promise<ArrayBuffer>;
  rawResponse?: Response;
}

export interface CachedEntry {
  etag: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  timestamp: number;
}

export interface RobotsTxtRule {
  userAgent: string;
  disallow: string[];
  allow: string[];
  crawlDelay?: number;
}

export interface RobotsTxtPolicy {
  tdmReserved: boolean;
  tdmPolicyUri?: string;
  rules: RobotsTxtRule[];
  isPathAllowed(path: string, userAgent?: string): boolean;
}

export interface RobotsComplianceResult {
  allowed: boolean;
  reason?: string;
  tdmReserved: boolean;
  crawlDelay?: number;
}

/**
 * Konfigurierbarer Rate-Limiter (Serialisierte Queue mit Mindestabstand).
 */
export class RateLimiter {
  private minIntervalMs: number;
  private lastRequestTime = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(requestsPerSecond = 1) {
    this.minIntervalMs = requestsPerSecond > 0 ? 1000 / requestsPerSecond : 0;
  }

  get intervalMs(): number {
    return this.minIntervalMs;
  }

  setRequestsPerSecond(rps: number): void {
    this.minIntervalMs = rps > 0 ? 1000 / rps : 0;
  }

  async acquire(): Promise<void> {
    if (this.minIntervalMs <= 0) return;

    const currentWait = this.queue.then(async () => {
      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      if (elapsed < this.minIntervalMs) {
        const waitMs = this.minIntervalMs - elapsed;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      this.lastRequestTime = Date.now();
    });

    this.queue = currentWait.catch(() => {});
    return currentWait;
  }

  reset(): void {
    this.lastRequestTime = 0;
    this.queue = Promise.resolve();
  }
}

/**
 * Parsed robots.txt und prueft Richtlinien inkl. TDM-Vorbehalte nach § 44b UrhG.
 */
export function parseRobotsTxt(content: string): RobotsTxtPolicy {
  const lines = content.split(/\r?\n/);
  const rules: RobotsTxtRule[] = [];
  let currentRule: RobotsTxtRule | null = null;
  let tdmReserved = false;
  let tdmPolicyUri: string | undefined;

  for (let rawLine of lines) {
    const commentIdx = rawLine.indexOf('#');
    if (commentIdx !== -1) {
      rawLine = rawLine.slice(0, commentIdx);
    }
    const line = rawLine.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const directive = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    // W3C TDM Reservation Protocol & maschinenlesbare TDM-Vorbehalte (§ 44b UrhG)
    if (directive === 'tdm-reservation') {
      const v = value.toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes') {
        tdmReserved = true;
      }
    } else if (directive === 'tdm-policy') {
      tdmReserved = true;
      tdmPolicyUri = value;
    } else if (directive === 'tdm' && (value.toLowerCase() === '1' || value.toLowerCase() === 'disallow')) {
      tdmReserved = true;
    } else if (directive === 'content-mining' && value.toLowerCase() === 'none') {
      tdmReserved = true;
    } else if (directive === 'user-agent') {
      const ua = value.toLowerCase();
      // Spezifische TDM-Bots pruefen
      if (ua === 'tdm-bot' || ua === 'tdm' || ua === 'ccbot' || ua === 'gptbot') {
        tdmReserved = true;
      }
      currentRule = {
        userAgent: ua,
        disallow: [],
        allow: [],
      };
      rules.push(currentRule);
    } else if (directive === 'disallow' && currentRule) {
      if (value) {
        currentRule.disallow.push(value);
      }
    } else if (directive === 'allow' && currentRule) {
      if (value) {
        currentRule.allow.push(value);
      }
    } else if (directive === 'crawl-delay' && currentRule) {
      const delay = parseFloat(value);
      if (!isNaN(delay)) {
        currentRule.crawlDelay = delay;
      }
    }
  }

  return {
    tdmReserved,
    tdmPolicyUri,
    rules,
    isPathAllowed(path: string, userAgent = '*'): boolean {
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const uaLower = userAgent.toLowerCase();

      // Finde passende Regeln (spezifischer User-Agent vor Wildcard '*')
      const specificRule = rules.find((r) => r.userAgent === uaLower);
      const wildcardRule = rules.find((r) => r.userAgent === '*');
      const rule = specificRule || wildcardRule;

      if (!rule) {
        return true;
      }

      // Pruefe Allow vor Disallow
      for (const allowPattern of rule.allow) {
        if (normalizedPath.startsWith(allowPattern)) {
          return true;
        }
      }

      for (const disallowPattern of rule.disallow) {
        if (disallowPattern === '/') return false;
        if (normalizedPath.startsWith(disallowPattern)) {
          return false;
        }
      }

      return true;
    },
  };
}

/**
 * ComplianceFetcher: Robuster HTTP-Client fuer Datensammlungen
 */
export class ComplianceFetcher {
  private userAgent: string;
  private timeoutMs: number;
  private maxRetries: number;
  private retryDelayMs: number;
  private backoffFactor: number;
  private checkRobotsTxt: boolean;
  private enableEtagCache: boolean;
  private customFetch: typeof fetch;

  private rateLimiter: RateLimiter;
  private etagCache = new Map<string, CachedEntry>();
  private robotsCache = new Map<string, { policy: RobotsTxtPolicy; expiresAt: number }>();

  constructor(options: FetcherOptions = {}) {
    this.userAgent = options.userAgent ?? 'ProductSafetyEngine/1.0 (+https://github.com/productsafetyengine; compliance-bot)';
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 500;
    this.backoffFactor = options.backoffFactor ?? 2;
    this.checkRobotsTxt = options.checkRobotsTxt ?? true;
    this.enableEtagCache = options.enableEtagCache ?? true;
    this.customFetch = options.customFetch ?? globalThis.fetch;

    this.rateLimiter = new RateLimiter(options.requestsPerSecond ?? 1);
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  getCacheSize(): number {
    return this.etagCache.size;
  }

  clearCache(): void {
    this.etagCache.clear();
    this.robotsCache.clear();
  }

  /**
   * Prueft robots.txt einer URL auf Pfad-Restriktionen und TDM-Vorbehalte (§ 44b UrhG).
   */
  async checkRobotsCompliance(targetUrl: string | URL): Promise<RobotsComplianceResult> {
    const parsed = new URL(targetUrl.toString());
    const origin = parsed.origin;
    const path = parsed.pathname || '/';

    let policy: RobotsTxtPolicy;
    const now = Date.now();
    const cached = this.robotsCache.get(origin);

    if (cached && cached.expiresAt > now) {
      policy = cached.policy;
    } else {
      const robotsUrl = `${origin}/robots.txt`;
      try {
        const response = await this.executeRawFetch(robotsUrl, {
          method: 'GET',
          headers: { 'User-Agent': this.userAgent },
        }, 5000);

        if (response.status === 200) {
          const body = await response.text();
          policy = parseRobotsTxt(body);

          // Pruefe zusaetzlich HTTP Response Header auf TDM-Vorbehalte
          const tdmHeader = response.headers.get('tdm-reservation') || response.headers.get('x-tdm-reservation');
          if (tdmHeader && (tdmHeader === '1' || tdmHeader.toLowerCase() === 'true')) {
            policy.tdmReserved = true;
          }
        } else if (response.status === 401 || response.status === 403) {
          return {
            allowed: false,
            reason: `robots.txt access forbidden (HTTP ${response.status})`,
            tdmReserved: false,
          };
        } else {
          // Bei 404 oder anderen Statuscodes gilt Standarderlaubnis
          policy = {
            tdmReserved: false,
            rules: [],
            isPathAllowed: () => true,
          };
        }
      } catch {
        // Bei Netzwerkfehlern waehrend robots.txt Fetch: defensiv erlauben
        policy = {
          tdmReserved: false,
          rules: [],
          isPathAllowed: () => true,
        };
      }

      // 1 Stunde im Cache halten
      this.robotsCache.set(origin, {
        policy,
        expiresAt: now + 3600_000,
      });
    }

    if (policy.tdmReserved) {
      return {
        allowed: false,
        reason: 'TDM reservation (§ 44b UrhG / DSM-RL Art. 4) active in robots.txt or headers',
        tdmReserved: true,
      };
    }

    if (!policy.isPathAllowed(path, this.userAgent)) {
      return {
        allowed: false,
        reason: `Access to path ${path} disallowed by robots.txt`,
        tdmReserved: false,
      };
    }

    return {
      allowed: true,
      tdmReserved: false,
    };
  }

  /**
   * Fuehrt einen HTTP-Request mit Rate-Limiting, Timeout, Retry, ETag-Caching und robots.txt-Check aus.
   */
  async fetch(url: string | URL, init: FetcherRequestInit = {}): Promise<FetcherResponse> {
    const urlStr = url.toString();
    const method = (init.method || 'GET').toUpperCase();

    // 1. robots.txt Vorbehaltspruefung (falls nicht explizit uebersprungen)
    if (this.checkRobotsTxt && !init.skipRobotsCheck) {
      const compliance = await this.checkRobotsCompliance(urlStr);
      if (!compliance.allowed) {
        throw new ComplianceError(compliance.reason || 'Blocked by compliance policy', {
          url: urlStr,
          tdmReserved: compliance.tdmReserved,
        });
      }
    }

    // 2. ETag Cache Check (nur bei GET / HEAD)
    let cachedEntry: CachedEntry | undefined;
    const headers = new Headers(init.headers || {});
    if (!headers.has('User-Agent')) {
      headers.set('User-Agent', this.userAgent);
    }

    if (this.enableEtagCache && (method === 'GET' || method === 'HEAD')) {
      cachedEntry = this.etagCache.get(urlStr);
      if (cachedEntry?.etag && !headers.has('If-None-Match')) {
        headers.set('If-None-Match', cachedEntry.etag);
      }
    }

    // 3. Retry-Schleife mit Rate-Limiter & Exponential Backoff
    const maxRetries = init.maxRetries ?? this.maxRetries;
    const timeoutMs = init.timeoutMs ?? this.timeoutMs;
    const baseDelayMs = init.retryDelayMs ?? this.retryDelayMs;

    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt <= maxRetries) {
      try {
        // Rate Limiter vor jedem Request-Versuch passieren
        await this.rateLimiter.acquire();

        const response = await this.executeRawFetch(urlStr, {
          ...init,
          method,
          headers,
        }, timeoutMs);

        // 304 Not Modified: Gecachte Antwort zurueckgeben
        if (response.status === 304 && cachedEntry) {
          return this.createResponseFromCache(urlStr, cachedEntry);
        }

        // Bei 429 oder 5xx transienten Serverfehlern: Retry
        if ((response.status === 429 || (response.status >= 500 && response.status <= 504)) && attempt < maxRetries) {
          const retryAfterSec = this.parseRetryAfter(response.headers);
          const delayMs = retryAfterSec ? retryAfterSec * 1000 : baseDelayMs * Math.pow(this.backoffFactor, attempt);
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        // Erfolgreiche Antwort (oder 4xx nicht retriable)
        const responseBodyText = await response.text();

        // ETag caching bei 200 OK
        const etag = response.headers.get('etag');
        if (this.enableEtagCache && etag && response.status === 200 && method === 'GET') {
          const headerRecord: Record<string, string> = {};
          response.headers.forEach((val, key) => {
            headerRecord[key] = val;
          });

          this.etagCache.set(urlStr, {
            etag,
            status: response.status,
            statusText: response.statusText,
            headers: headerRecord,
            body: responseBodyText,
            timestamp: Date.now(),
          });
        }

        return {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
          url: urlStr,
          fromCache: false,
          etag: etag ?? undefined,
          text: async () => responseBodyText,
          json: async <T>() => JSON.parse(responseBodyText) as T,
          arrayBuffer: async () => new TextEncoder().encode(responseBodyText).buffer as ArrayBuffer,
          rawResponse: response,
        };
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        if (attempt < maxRetries) {
          const delayMs = baseDelayMs * Math.pow(this.backoffFactor, attempt);
          attempt++;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        } else {
          break;
        }
      }
    }

    throw new FetcherRetryError(
      `Request to ${urlStr} failed after ${attempt} attempts: ${lastError?.message}`,
      attempt,
      lastError
    );
  }

  async get(url: string | URL, init: FetcherRequestInit = {}): Promise<FetcherResponse> {
    return this.fetch(url, { ...init, method: 'GET' });
  }

  private async executeRawFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      let signal = controller.signal;
      if (init.signal) {
        // Falls custom signal bereits gegeben ist
        if (typeof AbortSignal.any === 'function') {
          signal = AbortSignal.any([init.signal, controller.signal]);
        } else {
          init.signal.addEventListener('abort', () => controller.abort());
        }
      }

      const response = await this.customFetch(url, {
        ...init,
        signal,
      });

      return response;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FetcherTimeoutError(`Request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private createResponseFromCache(url: string, cached: CachedEntry): FetcherResponse {
    const headers = new Headers(cached.headers);
    return {
      ok: true,
      status: 304,
      statusText: 'Not Modified (Cached)',
      headers,
      url,
      fromCache: true,
      etag: cached.etag,
      text: async () => cached.body,
      json: async <T>() => JSON.parse(cached.body) as T,
      arrayBuffer: async () => new TextEncoder().encode(cached.body).buffer as ArrayBuffer,
    };
  }

  private parseRetryAfter(headers: Headers): number | null {
    const val = headers.get('Retry-After');
    if (!val) return null;
    const sec = parseInt(val, 10);
    if (!isNaN(sec) && sec >= 0 && sec <= 60) {
      return sec;
    }
    return null;
  }
}

// Alias fuer einfache Verwendbarkeit
export const Fetcher = ComplianceFetcher;
