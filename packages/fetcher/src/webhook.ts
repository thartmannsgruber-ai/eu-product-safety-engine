/**
 * packages/fetcher/src/webhook.ts
 *
 * Webhook-Versand mit SSRF-Schutz, HMAC-Signatur und resilientem Retry:
 * - SSRF-Schutz ueber validateOutboundUrl
 * - Automatische HMAC-SHA256 Signatur (X-PSE-Signature und X-PSE-Timestamp) bei gesetztem Secret
 * - User-Agent: 'eu-product-safety-engine/<version>'
 * - Content-Type: 'application/json'
 * - Retry mit exponentiellem Backoff bei 5xx, 429, Timeout und Netzwerkfehlern
 * - Retry-After Header Auswertung bei 429 bis max. 30 Sekunden
 * - Kein Retry bei 4xx (ausser 429)
 * - Exception-sicher: wirft nie eine Exception, sondern liefert { ok, status, attempts, error? }
 */

import { validateOutboundUrl, signPayload } from '@productsafetyengine/core';

export const PACKAGE_VERSION = '1.0.0';
export const DEFAULT_USER_AGENT = `eu-product-safety-engine/${PACKAGE_VERSION}`;
export const MAX_RETRY_AFTER_MS = 30_000;

export type WebhookFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type WebhookSleep = (ms: number) => Promise<void>;

export interface DispatchWebhookOptions {
  secret?: string;
  fetch?: WebhookFetch;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: WebhookSleep;
  timestamp?: string | number;
}

export interface DispatchWebhookResult {
  ok: boolean;
  status?: number;
  attempts: number;
  error?: string;
}

/**
 * Parst den Retry-After Header (in Sekunden oder als HTTP-Date) in Millisekunden.
 * Gibt null zurueck, falls der Header nicht vorhanden oder ungueltig ist.
 */
export function parseRetryAfter(header: string | null | undefined): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (!trimmed) return null;

  // 1. Numerischer Wert in Sekunden
  const seconds = Number(trimmed);
  if (!Number.isNaN(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  // 2. HTTP-Date (z. B. "Wed, 21 Oct 2026 07:28:00 GMT")
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    return Math.max(0, diff);
  }

  return null;
}

/**
 * Extrahiert einen Header-Wert unabhaengig von Headers-Instanz oder Plain-Object.
 */
function getHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name);
  }
  if (typeof headers === 'object') {
    const record = headers as Record<string, string>;
    const lower = name.toLowerCase();
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === lower) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Sendet einen Webhook mit SSRF-Schutz, HMAC-Signatur und exponentiellem Retry.
 * Wirft niemals eine Exception.
 */
export async function dispatchWebhook(
  url: string,
  payload: unknown,
  options: DispatchWebhookOptions = {}
): Promise<DispatchWebhookResult> {
  try {
    // 1. SSRF-Validierung der Ziel-URL VOR jedem Netzwerkaufruf
    const validation = validateOutboundUrl(url);
    if (!validation.ok) {
      return {
        ok: false,
        attempts: 0,
        error: validation.reason ?? 'Invalid outbound URL',
      };
    }

    const {
      secret,
      fetch: customFetch,
      timeoutMs = 10_000,
      maxAttempts: rawMaxAttempts = 3,
      baseDelayMs = 500,
      sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
      timestamp: customTimestamp,
    } = options;

    const maxAttempts = Math.max(1, rawMaxAttempts);
    const fetchFn = customFetch ?? globalThis.fetch;
    if (typeof fetchFn !== 'function') {
      return {
        ok: false,
        attempts: 0,
        error: 'No fetch implementation available',
      };
    }

    // 2. Payload serialisieren & Signatur-Header erstellen
    let body: string;
    try {
      body = typeof payload === 'string' ? payload : JSON.stringify(payload ?? null);
    } catch (serializeErr) {
      return {
        ok: false,
        attempts: 0,
        error: serializeErr instanceof Error ? serializeErr.message : 'Failed to serialize payload',
      };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': DEFAULT_USER_AGENT,
    };

    if (secret) {
      const timestamp = customTimestamp !== undefined ? String(customTimestamp) : Date.now().toString();
      const signature = signPayload(body, secret);
      headers['X-PSE-Signature'] = signature;
      headers['X-Hub-Signature-256'] = signature;
      headers['X-PSE-Timestamp'] = timestamp;
    }

    let attempts = 0;
    let lastError: string | undefined;
    let lastStatus: number | undefined;

    while (attempts < maxAttempts) {
      attempts++;

      const controller = new AbortController();
      let timeoutTriggered = false;
      const timeoutId = setTimeout(() => {
        timeoutTriggered = true;
        controller.abort();
      }, timeoutMs);

      try {
        const response = await fetchFn(url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        lastStatus = response.status;

        // 2xx Erfolg
        if (response.ok) {
          return {
            ok: true,
            status: response.status,
            attempts,
          };
        }

        // 429 Too Many Requests -> Retry mit Retry-After oder exponentiellem Backoff
        if (response.status === 429) {
          lastError = `HTTP 429 Too Many Requests`;
          if (attempts < maxAttempts) {
            const retryAfterHeader = getHeader(response.headers, 'retry-after');
            const retryAfterMs = parseRetryAfter(retryAfterHeader);
            let delay: number;
            if (retryAfterMs !== null) {
              delay = Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS);
            } else {
              delay = baseDelayMs * Math.pow(2, attempts - 1);
            }
            await sleep(delay);
            continue;
          }
          break;
        }

        // 4xx Client-Fehler (ausser 429) -> Kein Retry
        if (response.status >= 400 && response.status < 500) {
          return {
            ok: false,
            status: response.status,
            attempts,
            error: `HTTP ${response.status} ${response.statusText || 'Client Error'}`,
          };
        }

        // 5xx Server-Fehler -> Retry mit Backoff (bzw. Retry-After falls vorhanden)
        if (response.status >= 500) {
          lastError = `HTTP ${response.status} ${response.statusText || 'Server Error'}`;
          if (attempts < maxAttempts) {
            const retryAfterHeader = getHeader(response.headers, 'retry-after');
            const retryAfterMs = parseRetryAfter(retryAfterHeader);
            let delay: number;
            if (retryAfterMs !== null) {
              delay = Math.min(Math.max(0, retryAfterMs), MAX_RETRY_AFTER_MS);
            } else {
              delay = baseDelayMs * Math.pow(2, attempts - 1);
            }
            await sleep(delay);
            continue;
          }
          break;
        }

        // Sonstige unhandelte Statuscodes
        lastError = `HTTP ${response.status} ${response.statusText || 'Request failed'}`;
        break;
      } catch (err: unknown) {
        clearTimeout(timeoutId);

        if (timeoutTriggered) {
          lastError = `Request to ${url} timed out after ${timeoutMs}ms`;
        } else if (err instanceof Error) {
          lastError = err.message;
        } else {
          lastError = String(err);
        }

        // Bei Timeout & Netzwerkfehlern: Retry mit Backoff, falls noch Versuche uebrig
        if (attempts < maxAttempts) {
          const delay = baseDelayMs * Math.pow(2, attempts - 1);
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    const failureResult: DispatchWebhookResult = {
      ok: false,
      attempts,
      error: lastError ?? 'Webhook dispatch failed',
    };
    if (lastStatus !== undefined) {
      failureResult.status = lastStatus;
    }
    return failureResult;
  } catch (unexpectedErr: unknown) {
    return {
      ok: false,
      attempts: 0,
      error: unexpectedErr instanceof Error ? unexpectedErr.message : String(unexpectedErr),
    };
  }
}
