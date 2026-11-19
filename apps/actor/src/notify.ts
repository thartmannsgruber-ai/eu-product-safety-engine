/**
 * apps/actor/src/notify.ts
 *
 * Webhook-Benachrichtigung am Ende des Actor-Runs:
 * - Zusammenfassung aus Treffern und BATCH_REPORT via buildRunSummary
 * - Erzeugt Webhook-Payloads im gewaehlten Format (generic, slack, discord) via buildWebhookPayload
 * - Versendet den Payload mit SSRF-Schutz, HMAC-Signatur und Retry via dispatchWebhook
 * - Beruecksichtigt webhookOnlyOnMatch (Standard: true; ohne Treffer kein POST)
 * - Protokolliert Warnung bei Fehlschlag und schreibt WEBHOOK_LOG in den Key-Value-Store
 * - Exit-Code bleibt immer 0 (wirft niemals ungefangene Exceptions)
 * - Injizierbares fetch (ActorRunOptions.webhookFetch) fuer Tests
 * - Strikt geschuetzt: Secrets tauchen weder im Log noch in WEBHOOK_LOG auf
 */

import { Actor } from 'apify';
import {
  buildWebhookPayload,
  type WebhookSummary,
  type WebhookMatchItem,
  type WebhookFormat,
  type WebhookPayload,
} from '@productsafetyengine/core';
import {
  dispatchWebhook,
  type DispatchWebhookResult,
  type WebhookFetch,
  type WebhookSleep,
} from '@productsafetyengine/fetcher';
import {
  type EnrichedAlertItem,
  type ActorInput,
  setApifyKeyValue,
} from './actor.js';
import { type BatchReport } from './batch.js';

export interface WebhookLog {
  sent: boolean;
  status?: number;
  attempts: number;
  error?: string;
  format: WebhookFormat | string;
  matchCount: number;
}

export interface NotifyOptions {
  webhookFetch?: WebhookFetch | typeof fetch;
  customFetch?: WebhookFetch | typeof fetch;
  keyValueStore?: {
    setValue: (key: string, value: unknown) => Promise<void>;
  };
  runId?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  sleep?: WebhookSleep;
}

export interface NotifyResult {
  sent: boolean;
  skipped: boolean;
  log?: WebhookLog;
  payload?: WebhookPayload;
  reason?: string;
}

/**
 * Entfernt Secrets aus Texten oder Fehlermeldungen, um versehentliches Logging zu verhindern.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!secret || !text) return text;
  return text.split(secret).join('[REDACTED]');
}

/**
 * Ermittelt die Run-ID des Actors (aus Optionen, Umgebungsvariablen oder Fallback).
 */
export function getActorRunId(options?: { runId?: string }): string {
  if (options?.runId) return options.runId;
  if (process.env.APIFY_ACTOR_RUN_ID) return process.env.APIFY_ACTOR_RUN_ID;
  if (typeof Actor !== 'undefined' && typeof Actor.getEnv === 'function') {
    try {
      const env = Actor.getEnv();
      if (env?.actorRunId) return env.actorRunId;
    } catch {
      // ignore
    }
  }
  return `run_${Date.now()}`;
}

/**
 * Erstellt eine Webhook-Zusammenfassung (WebhookSummary) aus Treffern und optionalem BATCH_REPORT.
 */
export function buildRunSummary(
  items: EnrichedAlertItem[],
  batchReport?: BatchReport,
  options?: {
    runId?: string;
    generatedAt?: string;
    totals?: Record<string, unknown>;
  }
): WebhookSummary {
  const runId = getActorRunId(options);
  const generatedAt = options?.generatedAt ?? new Date().toISOString();

  const totals: Record<string, unknown> = {
    matches: items.length,
    ...(batchReport
      ? {
          totalRows: batchReport.totalRows,
          validRows: batchReport.validRows,
          invalidRows: batchReport.invalidRows.length,
          resolved: batchReport.resolved,
          unresolved: batchReport.unresolved.length,
          duplicates: batchReport.duplicates,
          matchedRows: batchReport.matchedRows,
          durationMs: batchReport.durationMs,
        }
      : {}),
    ...(options?.totals ?? {}),
  };

  const matches: WebhookMatchItem[] = items.map((item) => ({
    input_identifier: item.input_identifier ?? null,
    sku: item.sku ?? null,
    alert_number: item.alert_number,
    product: item.product,
    brand: item.brand,
    risk_level: item.risk_level,
    risk_type: item.risk_type,
    source_url: item.source_url ?? (item as any).url,
  }));

  return {
    run_id: runId,
    runId,
    generated_at: generatedAt,
    generatedAt,
    totals,
    matches,
  };
}

/**
 * Fuehrt die Webhook-Benachrichtigung am Ende des Runs durch:
 * - Prueft webhookUrl und webhookOnlyOnMatch
 * - Baut Payload via buildWebhookPayload im angegebenen Format
 * - Versendet Webhook via dispatchWebhook mit HMAC-Signatur
 * - Schreibt WEBHOOK_LOG in den Key-Value-Store
 * - Gibt niemals einen Fehler nach aussen weiter (Exit-Code bleibt 0)
 */
export async function notifyRunEnd(
  input: ActorInput,
  items: EnrichedAlertItem[],
  batchReport?: BatchReport,
  options: NotifyOptions = {}
): Promise<NotifyResult> {
  const webhookUrl = input.webhookUrl;
  if (!webhookUrl) {
    return {
      sent: false,
      skipped: true,
      reason: 'No webhookUrl provided',
    };
  }

  const matchCount = items.length;
  const webhookOnlyOnMatch = input.webhookOnlyOnMatch !== false;

  // Bei webhookOnlyOnMatch=true (Standard) wird ohne Treffer nichts gesendet
  if (webhookOnlyOnMatch && matchCount === 0) {
    return {
      sent: false,
      skipped: true,
      reason: 'No matches found and webhookOnlyOnMatch is true',
    };
  }

  const format = (input.webhookFormat ?? 'generic') as WebhookFormat;
  const summary = buildRunSummary(items, batchReport, { runId: options.runId });
  const payload = buildWebhookPayload(summary, format);

  const secret = input.webhookSecret;
  const fetchFn = options.webhookFetch ?? options.customFetch;

  let dispatchResult: DispatchWebhookResult;
  try {
    dispatchResult = await dispatchWebhook(webhookUrl, payload, {
      secret,
      fetch: fetchFn as any,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxAttempts: options.maxAttempts ?? 3,
      baseDelayMs: options.baseDelayMs ?? 500,
      sleep: options.sleep,
    });
  } catch (err: any) {
    dispatchResult = {
      ok: false,
      attempts: 0,
      error: err?.message || String(err),
    };
  }

  if (dispatchResult.ok) {
    const log: WebhookLog = {
      sent: true,
      ...(dispatchResult.status !== undefined ? { status: dispatchResult.status } : {}),
      attempts: dispatchResult.attempts,
      format,
      matchCount,
    };

    await setApifyKeyValue('WEBHOOK_LOG', log, options.keyValueStore);

    return {
      sent: true,
      skipped: false,
      log,
      payload,
    };
  }

  // Fehlgeschlagener Versand: Warnung protokollieren und WEBHOOK_LOG schreiben
  const rawError = dispatchResult.error ?? 'Webhook dispatch failed';
  const sanitizedError = redactSecret(rawError, secret);

  const log: WebhookLog = {
    sent: false,
    ...(dispatchResult.status !== undefined ? { status: dispatchResult.status } : {}),
    attempts: dispatchResult.attempts,
    error: sanitizedError,
    format,
    matchCount,
  };

  await setApifyKeyValue('WEBHOOK_LOG', log, options.keyValueStore);

  console.warn(
    `[Actor] Webhook dispatch failed (status: ${dispatchResult.status ?? 'none'}, attempts: ${dispatchResult.attempts}): ${sanitizedError}`
  );

  return {
    sent: false,
    skipped: false,
    log,
    payload,
    reason: sanitizedError,
  };
}
