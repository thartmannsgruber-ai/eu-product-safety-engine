import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import {
  runActor,
  notifyRunEnd,
  buildRunSummary,
  redactSecret,
  type WebhookLog,
  type ActorRunResult,
} from '../src/index.js';
import {
  MemoryAlertStorage,
  parseSafetyGateFileSync,
  normalizeAlerts,
  signPayload,
  type AlertRecord,
} from '@productsafetyengine/core';

const ACTOR_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(ACTOR_DIR, '../..');
const FIXTURE_PATH = path.resolve(REPO_ROOT, 'fixtures/safety_gate_2026_45.xml');

describe('F10: Actor - Webhook-Benachrichtigung am Ende des Runs', () => {
  let storage: MemoryAlertStorage;
  let parsedAlerts: AlertRecord[];

  beforeEach(async () => {
    storage = new MemoryAlertStorage();
    const parsed = parseSafetyGateFileSync(FIXTURE_PATH);
    parsedAlerts = normalizeAlerts(parsed.notifications);
    await storage.insertAlerts(parsedAlerts);
  });

  describe('Akzeptanzkriterium 1: Bei Treffern wird genau ein POST mit gültigem Payload und gültiger Signatur gesendet', () => {
    it('sendet genau einen POST mit gültigem generic Payload und HMAC-Signatur bei EAN-Treffer', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/safety-alerts';
      const webhookSecret = 'test_webhook_secret_key_123';
      let capturedUrl: string | undefined;
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url;
        capturedInit = init;
        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          statusText: 'OK',
          headers: { 'Content-Type': 'application/json' },
        });
      });

      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result: ActorRunResult = await runActor(
        {
          ean: '5054298241091', // Match in fixture (Alert 1)
          webhookUrl,
          webhookSecret,
          webhookFormat: 'generic',
          webhookOnlyOnMatch: true,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      // Treffer verifizieren
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].alert_number).toBe('1');

      // Genau ein POST gesendet
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(capturedUrl).toBe(webhookUrl);
      expect(capturedInit?.method).toBe('POST');

      // Header-Validierung
      const headers = capturedInit?.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toMatch(/^eu-product-safety-engine\/\d+\.\d+\.\d+$/);

      // Signatur-Validierung
      const bodyStr = capturedInit?.body as string;
      expect(typeof bodyStr).toBe('string');
      const expectedSignature = signPayload(bodyStr, webhookSecret);
      expect(headers['X-PSE-Signature']).toBe(expectedSignature);
      expect(headers['X-PSE-Timestamp']).toBeDefined();

      // Payload-Validierung (pse.alert.v1 Schema)
      const payload = JSON.parse(bodyStr);
      expect(payload.schema).toBe('pse.alert.v1');
      expect(payload.run_id).toBeDefined();
      expect(payload.generated_at).toBeDefined();
      expect(payload.totals.matches).toBe(result.items.length);
      expect(Array.isArray(payload.matches)).toBe(true);
      expect(payload.matches.length).toBe(result.items.length);
      expect(payload.matches[0].alert_number).toBe('1');
      expect(payload.matches[0].product).toBeDefined();

      // WEBHOOK_LOG im Key-Value-Store verifizieren
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: true,
          status: 200,
          attempts: 1,
          format: 'generic',
          matchCount: result.items.length,
        })
      );
      expect(result.webhookLog).toEqual(
        expect.objectContaining({
          sent: true,
          status: 200,
          attempts: 1,
          format: 'generic',
          matchCount: result.items.length,
        })
      );
    });

    it('unterstützt webhookFormat slack mit Blocks und Signatur', async () => {
      const webhookUrl = 'https://hooks.slack.com/services/T000/B000/XXXX';
      const webhookSecret = 'slack_secret_token_abc';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response('ok', { status: 200, statusText: 'OK' });
      });

      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
          webhookSecret,
          webhookFormat: 'slack',
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const headers = capturedInit?.headers as Record<string, string>;
      const bodyStr = capturedInit?.body as string;
      expect(headers['X-PSE-Signature']).toBe(signPayload(bodyStr, webhookSecret));

      const payload = JSON.parse(bodyStr);
      expect(Array.isArray(payload.blocks)).toBe(true);
      expect(payload.blocks.length).toBeGreaterThanOrEqual(1);
      expect(payload.blocks[0].type).toBe('section');

      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: true,
          status: 200,
          format: 'slack',
        })
      );
    });

    it('unterstützt webhookFormat discord mit Embeds und Signatur', async () => {
      const webhookUrl = 'https://discord.com/api/webhooks/12345/abcdef';
      const webhookSecret = 'discord_secret_key_xyz';
      let capturedInit: RequestInit | undefined;

      const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        capturedInit = init;
        return new Response(null, { status: 204, statusText: 'No Content' });
      });

      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
          webhookSecret,
          webhookFormat: 'discord',
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const headers = capturedInit?.headers as Record<string, string>;
      const bodyStr = capturedInit?.body as string;
      expect(headers['X-PSE-Signature']).toBe(signPayload(bodyStr, webhookSecret));

      const payload = JSON.parse(bodyStr);
      expect(Array.isArray(payload.embeds)).toBe(true);
      expect(payload.embeds.length).toBeGreaterThanOrEqual(1);
      expect(payload.embeds[0].title).toBeDefined();

      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: true,
          status: 204,
          format: 'discord',
        })
      );
    });
  });

  describe('Akzeptanzkriterium 2: Ohne Treffer und mit webhookOnlyOnMatch=true wird kein POST gesendet', () => {
    it('sendet keinen POST bei 0 Treffern, wenn webhookOnlyOnMatch=true (Standard)', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/safety-alerts';
      const mockFetch = vi.fn();
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '4000000000000', // Unbekannte EAN ohne Treffer im Fixture
          webhookUrl,
          webhookSecret: 'secret_abc',
          webhookOnlyOnMatch: true,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(result.items.length).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
      // Bei uebersprungenem Webhook wird kein WEBHOOK_LOG geschrieben
      expect(mockKvStore.setValue).not.toHaveBeenCalledWith('WEBHOOK_LOG', expect.anything());
      expect(result.webhookLog).toBeUndefined();
    });

    it('nutzt webhookOnlyOnMatch=true als Standard, wenn nicht explizit angegeben', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/safety-alerts';
      const mockFetch = vi.fn();
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '4000000000000',
          webhookUrl,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(result.items.length).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sendet POST bei 0 Treffern, wenn webhookOnlyOnMatch=false gesetzt ist', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/safety-alerts';
      const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '4000000000000',
          webhookUrl,
          webhookOnlyOnMatch: false,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(result.items.length).toBe(0);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: true,
          status: 200,
          matchCount: 0,
        })
      );
    });
  });

  describe('Akzeptanzkriterium 3: Ein Webhook-Fehler (z. B. dauerhaft 500) lässt den Run nicht fehlschlagen, WEBHOOK_LOG.sent ist false', () => {
    it('lässt den Run bei dauerhaftem HTTP 500 erfolgreich durchlaufen und setzt WEBHOOK_LOG.sent=false', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/failing-endpoint';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      );

      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '5054298241091', // Match in fixture
          webhookUrl,
          webhookSecret: 'secret_123',
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      // Run ist nicht fehlgeschlagen
      expect(result.error).toBeUndefined();
      expect(result.items.length).toBeGreaterThanOrEqual(1);

      // Warnung wurde protokolliert
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/\[Actor\] Webhook dispatch failed.*500/)
      );

      // WEBHOOK_LOG wurde geschrieben mit sent: false
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: false,
          status: 500,
          attempts: 3,
          format: 'generic',
          matchCount: result.items.length,
          error: expect.stringContaining('500'),
        })
      );
      expect(result.webhookLog?.sent).toBe(false);
      expect(result.webhookLog?.status).toBe(500);

      warnSpy.mockRestore();
    });

    it('lässt den Run bei Client-Fehler HTTP 400 nicht fehlschlagen und setzt WEBHOOK_LOG.sent=false', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/bad-request';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn().mockResolvedValue(
        new Response('Bad Request', {
          status: 400,
          statusText: 'Bad Request',
        })
      );

      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(result.error).toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1); // Kein Retry bei 400

      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: false,
          status: 400,
          attempts: 1,
        })
      );
      expect(result.webhookLog?.sent).toBe(false);

      warnSpy.mockRestore();
    });

    it('lässt den Run bei Netzwerk-/Timeout-Fehlern nicht fehlschlagen', async () => {
      const webhookUrl = 'https://api.example.com/webhooks/timeout';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn().mockRejectedValue(new Error('Connection timed out'));
      const mockKvStore = {
        setValue: vi.fn().mockResolvedValue(undefined),
      };

      const result = await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(result.error).toBeUndefined();
      expect(mockKvStore.setValue).toHaveBeenCalledWith(
        'WEBHOOK_LOG',
        expect.objectContaining({
          sent: false,
          attempts: 3,
          error: expect.stringContaining('Connection timed out'),
        })
      );
      expect(result.webhookLog?.sent).toBe(false);

      warnSpy.mockRestore();
    });
  });

  describe('Akzeptanzkriterium 4: Das Secret erscheint weder im Log noch in WEBHOOK_LOG', () => {
    it('enthält das Secret weder in WEBHOOK_LOG noch in Console-Warnungen bei erfolgreichem Versand', async () => {
      const secret = 'super_secret_token_never_leak_this_12345';
      const webhookUrl = 'https://api.example.com/webhooks/endpoint';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
      let savedWebhookLog: WebhookLog | undefined;
      const mockKvStore = {
        setValue: vi.fn().mockImplementation(async (key: string, val: unknown) => {
          if (key === 'WEBHOOK_LOG') {
            savedWebhookLog = val as WebhookLog;
          }
        }),
      };

      await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
          webhookSecret: secret,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(savedWebhookLog).toBeDefined();
      expect(savedWebhookLog?.sent).toBe(true);

      // Secret darf keinesfalls in WEBHOOK_LOG enthalten sein
      const logStr = JSON.stringify(savedWebhookLog);
      expect(logStr).not.toContain(secret);
      expect((savedWebhookLog as any).secret).toBeUndefined();
      expect((savedWebhookLog as any).webhookSecret).toBeUndefined();

      // Console-Logs prüfen
      for (const call of [...warnSpy.mock.calls, ...logSpy.mock.calls]) {
        const text = call.map(String).join(' ');
        expect(text).not.toContain(secret);
      }

      warnSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('enthält das Secret weder in WEBHOOK_LOG noch in Console-Warnungen bei fehlgeschlagenem Versand', async () => {
      const secret = 'ultra_secret_failure_key_abcdef987654';
      const webhookUrl = 'https://api.example.com/webhooks/endpoint';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Simuliere einen Fehler, der fälschlicherweise das Secret im Fehlertext enthalten könnte
      const mockFetch = vi.fn().mockRejectedValue(new Error(`Endpoint rejected secret ${secret}`));
      let savedWebhookLog: WebhookLog | undefined;
      const mockKvStore = {
        setValue: vi.fn().mockImplementation(async (key: string, val: unknown) => {
          if (key === 'WEBHOOK_LOG') {
            savedWebhookLog = val as WebhookLog;
          }
        }),
      };

      await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
          webhookSecret: secret,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      expect(savedWebhookLog).toBeDefined();
      expect(savedWebhookLog?.sent).toBe(false);

      // Weder im JSON-String noch in Error-Eigenschaft
      const logStr = JSON.stringify(savedWebhookLog);
      expect(logStr).not.toContain(secret);
      expect(savedWebhookLog?.error).toContain('[REDACTED]');

      // In console.warn darf das Secret keinesfalls erscheinen
      for (const call of warnSpy.mock.calls) {
        const text = call.map(String).join(' ');
        expect(text).not.toContain(secret);
        expect(text).toContain('[REDACTED]');
      }

      warnSpy.mockRestore();
    });

    it('lehnt SSRF zu privaten IP-Adressen ab, ohne das Secret zu leaken', async () => {
      const secret = 'private_ip_secret_999';
      const webhookUrl = 'https://192.168.1.100/webhook';
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const mockFetch = vi.fn();
      let savedWebhookLog: WebhookLog | undefined;
      const mockKvStore = {
        setValue: vi.fn().mockImplementation(async (key: string, val: unknown) => {
          if (key === 'WEBHOOK_LOG') {
            savedWebhookLog = val as WebhookLog;
          }
        }),
      };

      const result = await runActor(
        {
          ean: '5054298241091',
          webhookUrl,
          webhookSecret: secret,
        },
        {
          storage,
          webhookFetch: mockFetch,
          webhookSleep: async () => {},
          keyValueStore: mockKvStore,
          pushData: false,
        }
      );

      // Kein fetch aufgerufen (SSRF-Schutz greift vorher)
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.error).toBeUndefined(); // Run bleibt 0
      expect(savedWebhookLog?.sent).toBe(false);
      expect(savedWebhookLog?.attempts).toBe(0);
      expect(savedWebhookLog?.error).toContain('private');

      const logStr = JSON.stringify(savedWebhookLog);
      expect(logStr).not.toContain(secret);

      warnSpy.mockRestore();
    });
  });

  describe('Unit-Tests für Hilfsfunktionen & Batch-Integration in notify.ts', () => {
    it('buildRunSummary integriert Treffer und BATCH_REPORT korrekt', () => {
      const mockItems = [
        {
          alert_number: 'A12/0001/26',
          product: 'Sample Toy',
          brand: 'ToyCo',
          risk_level: 'Serious',
          risk_type: 'Choking',
          source_url: 'https://example.com/alert/1',
          input_identifier: '4006381333931',
          sku: 'SKU-001',
        },
      ] as any;

      const mockBatchReport = {
        totalRows: 100,
        validRows: 95,
        invalidRows: [{ row: 2, reason: 'Invalid EAN' }],
        resolved: 90,
        unresolved: ['B000000000'],
        duplicates: 5,
        matchedRows: 1,
        durationMs: 120,
      };

      const summary = buildRunSummary(mockItems, mockBatchReport, { runId: 'run_batch_test' });

      expect(summary.run_id).toBe('run_batch_test');
      expect(summary.totals?.matches).toBe(1);
      expect(summary.totals?.totalRows).toBe(100);
      expect(summary.totals?.validRows).toBe(95);
      expect(summary.totals?.invalidRows).toBe(1);
      expect(summary.totals?.unresolved).toBe(1);
      expect(summary.matches?.[0].alert_number).toBe('A12/0001/26');
      expect(summary.matches?.[0].sku).toBe('SKU-001');
    });

    it('redactSecret ersetzt alle Vorkommen eines Secrets', () => {
      expect(redactSecret('Error with key=secret123 in url', 'secret123')).toBe(
        'Error with key=[REDACTED] in url'
      );
      expect(redactSecret('No secret here', undefined)).toBe('No secret here');
      expect(redactSecret('No secret here', '')).toBe('No secret here');
    });

    it('notifyRunEnd bricht sauber ab, wenn keine webhookUrl konfiguriert ist', async () => {
      const result = await notifyRunEnd({} as any, []);
      expect(result.sent).toBe(false);
      expect(result.skipped).toBe(true);
      expect(result.reason).toContain('No webhookUrl');
    });
  });
});
