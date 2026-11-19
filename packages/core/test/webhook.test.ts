import { describe, it, expect } from 'vitest';
import {
  buildWebhookPayload,
  signPayload,
  validateOutboundUrl,
  MAX_SLACK_BLOCKS,
  MAX_SLACK_TEXT,
  MAX_DISCORD_EMBEDS,
  MAX_DISCORD_DESC,
  type WebhookSummary,
  type WebhookMatchItem,
  type GenericWebhookPayload,
  type SlackWebhookPayload,
  type DiscordWebhookPayload,
} from '../src/webhook.js';

describe('webhook - Webhook-Payloads, HMAC-Signatur und SSRF-Schutz (F05)', () => {
  const sampleMatch: WebhookMatchItem = {
    input_identifier: '4006381333931',
    sku: 'SKU-001',
    alert_number: 'A12/00001/24',
    product: 'Laser Pointer',
    brand: 'DangerCo',
    risk_level: 'Serious',
    risk_type: 'Damage to sight',
    source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/1',
  };

  const sampleSummary: WebhookSummary = {
    run_id: 'run_test_12345',
    generated_at: '2026-11-19T01:00:00.000Z',
    totals: { total_checked: 10, matches: 1 },
    matches: [sampleMatch],
  };

  describe('Akzeptanzkriterium 1: Alle drei Formate sind valides JSON und halten die Plattform-Limits auch bei 500 Treffern ein', () => {
    it('generiert valides generic-Payload mit schema pse.alert.v1', () => {
      const payload = buildWebhookPayload(sampleSummary, 'generic') as GenericWebhookPayload;

      expect(payload.schema).toBe('pse.alert.v1');
      expect(payload.run_id).toBe('run_test_12345');
      expect(payload.generated_at).toBe('2026-11-19T01:00:00.000Z');
      expect(payload.totals).toEqual({ total_checked: 10, matches: 1 });
      expect(payload.matches).toHaveLength(1);
      expect(payload.matches[0]).toEqual({
        input_identifier: '4006381333931',
        sku: 'SKU-001',
        alert_number: 'A12/00001/24',
        product: 'Laser Pointer',
        brand: 'DangerCo',
        risk_level: 'Serious',
        risk_type: 'Damage to sight',
        source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/1',
      });

      // Valides JSON
      const json = JSON.stringify(payload);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('generiert valides slack-Payload mit blocks', () => {
      const payload = buildWebhookPayload(sampleSummary, 'slack') as SlackWebhookPayload;

      expect(payload.blocks).toBeDefined();
      expect(payload.blocks).toHaveLength(1);
      expect(payload.blocks[0].type).toBe('section');
      expect(payload.blocks[0].text?.type).toBe('mrkdwn');
      expect(payload.blocks[0].text?.text).toContain('*A12/00001/24*');
      expect(payload.blocks[0].text?.text).toContain('Laser Pointer');
      expect(payload.blocks[0].text?.text).toContain('SKU-001');

      const json = JSON.stringify(payload);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('generiert valides discord-Payload mit embeds', () => {
      const payload = buildWebhookPayload(sampleSummary, 'discord') as DiscordWebhookPayload;

      expect(payload.embeds).toBeDefined();
      expect(payload.embeds).toHaveLength(1);
      expect(payload.embeds[0].title).toContain('A12/00001/24');
      expect(payload.embeds[0].description).toContain('Laser Pointer');
      expect(payload.embeds[0].description).toContain('SKU-001');
      expect(payload.embeds[0].url).toBe('https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/1');

      const json = JSON.stringify(payload);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('hält Plattform-Limits bei 500 Treffern in allen drei Formaten strikt ein', () => {
      const manyMatches: WebhookMatchItem[] = [];
      for (let i = 1; i <= 500; i++) {
        manyMatches.push({
          input_identifier: `ID-${i}`,
          sku: `SKU-${i}`,
          alert_number: `A12/${String(i).padStart(5, '0')}/24`,
          product: `Dangerous Product ${i}`,
          brand: `Brand ${i}`,
          risk_level: 'Serious',
          risk_type: 'Injuries',
          source_url: `https://ec.europa.eu/alert/${i}`,
        });
      }

      const summary500: WebhookSummary = {
        run_id: 'run_500_matches',
        generated_at: new Date().toISOString(),
        totals: { total_checked: 1000, matches: 500 },
        matches: manyMatches,
      };

      // 1. Generic
      const genericPayload = buildWebhookPayload(summary500, 'generic') as GenericWebhookPayload;
      const genericJson = JSON.stringify(genericPayload);
      expect(() => JSON.parse(genericJson)).not.toThrow();
      expect(genericPayload.matches).toHaveLength(500);

      // 2. Slack (höchstens 50 Blocks, Text höchstens 3.000 Zeichen, Überlänge gekürzt mit +N weitere)
      const slackPayload = buildWebhookPayload(summary500, 'slack') as SlackWebhookPayload;
      const slackJson = JSON.stringify(slackPayload);
      expect(() => JSON.parse(slackJson)).not.toThrow();
      expect(slackPayload.blocks.length).toBeLessThanOrEqual(MAX_SLACK_BLOCKS);
      expect(slackPayload.blocks).toHaveLength(50);

      // Jeder Block hält das 3.000 Zeichen Limit ein
      for (const block of slackPayload.blocks) {
        expect(block.text?.text.length).toBeLessThanOrEqual(MAX_SLACK_TEXT);
      }

      // Der letzte Block enthält den Hinweis '+451 weitere' (500 - 49 = 451)
      const lastSlackBlock = slackPayload.blocks[slackPayload.blocks.length - 1];
      expect(lastSlackBlock.text?.text).toBe('+451 weitere');

      // 3. Discord (höchstens 10 Embeds, Beschreibung höchstens 4.096 Zeichen, Überlänge gekürzt mit +N weitere)
      const discordPayload = buildWebhookPayload(summary500, 'discord') as DiscordWebhookPayload;
      const discordJson = JSON.stringify(discordPayload);
      expect(() => JSON.parse(discordJson)).not.toThrow();
      expect(discordPayload.embeds.length).toBeLessThanOrEqual(MAX_DISCORD_EMBEDS);
      expect(discordPayload.embeds).toHaveLength(10);

      // Jede Beschreibung hält das 4.096 Zeichen Limit ein
      for (const embed of discordPayload.embeds) {
        expect(embed.description.length).toBeLessThanOrEqual(MAX_DISCORD_DESC);
      }

      // Das letzte Embed enthält den Hinweis '+491 weitere' (500 - 9 = 491)
      const lastDiscordEmbed = discordPayload.embeds[discordPayload.embeds.length - 1];
      expect(lastDiscordEmbed.description).toBe('+491 weitere');
      expect(lastDiscordEmbed.title).toBe('+491 weitere');
    });

    it('kürzt überlange Texte einzelner Treffer auf 3.000 (Slack) bzw. 4.096 (Discord) Zeichen', () => {
      const hugeDescription = 'A'.repeat(6000);
      const hugeMatch: WebhookMatchItem = {
        alert_number: 'A12/HUGE/24',
        product: hugeDescription,
      };

      const summary: WebhookSummary = {
        matches: [hugeMatch],
      };

      const slack = buildWebhookPayload(summary, 'slack') as SlackWebhookPayload;
      expect(slack.blocks[0].text?.text.length).toBeLessThanOrEqual(MAX_SLACK_TEXT);
      expect(slack.blocks[0].text?.text.endsWith('...')).toBe(true);

      const discord = buildWebhookPayload(summary, 'discord') as DiscordWebhookPayload;
      expect(discord.embeds[0].description.length).toBeLessThanOrEqual(MAX_DISCORD_DESC);
      expect(discord.embeds[0].description.endsWith('...')).toBe(true);
    });
  });

  describe('Akzeptanzkriterium 2: signPayload stimmt mit einem bekannten HMAC-Testvektor überein', () => {
    it('stimmt exakt mit RFC 4231 Test Case 2 überein', () => {
      // RFC 4231 Test Case 2:
      // Key  = "Jefe"
      // Data = "what do ya want for nothing?"
      // HMAC-SHA256 = 5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843
      const signature = signPayload('what do ya want for nothing?', 'Jefe');
      expect(signature).toBe('sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
    });

    it('stimmt exakt mit RFC 4231 Test Case 1 überein', () => {
      // RFC 4231 Test Case 1:
      // Key  = 20 bytes of 0x0b
      // Data = "Hi There"
      // HMAC-SHA256 = b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7
      const key = Buffer.alloc(20, 0x0b).toString('binary');
      const signature = signPayload('Hi There', key);
      expect(signature).toBe('sha256=b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    });

    it('akzeptiert Objekte und Buffer als Body', () => {
      const obj = { alert: 'test' };
      const sig1 = signPayload(obj, 'secret');
      const sig2 = signPayload(JSON.stringify(obj), 'secret');
      const sig3 = signPayload(Buffer.from(JSON.stringify(obj)), 'secret');

      expect(sig1).toBe(sig2);
      expect(sig2).toBe(sig3);
      expect(sig1.startsWith('sha256=')).toBe(true);
    });
  });

  describe('Akzeptanzkriterium 3: http://, private IPs, localhost und Metadata-Hosts werden abgelehnt; https://hooks.slack.com/... wird akzeptiert', () => {
    it('akzeptiert legitime öffentliche HTTPS-Webhooks', () => {
      expect(validateOutboundUrl('https://hooks.slack.com/services/T00/B00/XXXX')).toEqual({ ok: true });
      expect(validateOutboundUrl('https://discord.com/api/webhooks/12345/abcdef')).toEqual({ ok: true });
      expect(validateOutboundUrl('https://api.example.com/webhook/endpoint')).toEqual({ ok: true });
      expect(validateOutboundUrl('https://8.8.8.8/webhook')).toEqual({ ok: true });
    });

    it('lehnt unverschlüsseltes http:// und ungültige Protokolle ab', () => {
      const httpSlack = validateOutboundUrl('http://hooks.slack.com/services/T00/B00/XXXX');
      expect(httpSlack.ok).toBe(false);
      expect(httpSlack.reason).toContain('https');

      const ftpUrl = validateOutboundUrl('ftp://example.com/test');
      expect(ftpUrl.ok).toBe(false);

      const fileUrl = validateOutboundUrl('file:///etc/passwd');
      expect(fileUrl.ok).toBe(false);

      const invalidUrl = validateOutboundUrl('not-a-valid-url');
      expect(invalidUrl.ok).toBe(false);

      const emptyUrl = validateOutboundUrl('');
      expect(emptyUrl.ok).toBe(false);
    });

    it('lehnt localhost und Subdomains ab', () => {
      expect(validateOutboundUrl('https://localhost/webhook').ok).toBe(false);
      expect(validateOutboundUrl('https://localhost:8080/webhook').ok).toBe(false);
      expect(validateOutboundUrl('https://sub.localhost/webhook').ok).toBe(false);
    });

    it('lehnt Metadata-Hosts ab (metadata.google.internal, instance-data)', () => {
      expect(validateOutboundUrl('https://metadata.google.internal/computeMetadata/v1/').ok).toBe(false);
      expect(validateOutboundUrl('https://foo.metadata.google.internal/').ok).toBe(false);
      expect(validateOutboundUrl('https://metadata/').ok).toBe(false);
      expect(validateOutboundUrl('https://instance-data/').ok).toBe(false);
    });

    it('lehnt private IPv4-Bereiche ab (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8)', () => {
      // 10/8 Private
      expect(validateOutboundUrl('https://10.0.0.1/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://10.255.255.255/hook').ok).toBe(false);

      // 172.16/12 Private
      expect(validateOutboundUrl('https://172.16.0.1/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://172.31.255.255/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://172.32.0.1/hook').ok).toBe(true); // Public

      // 192.168/16 Private
      expect(validateOutboundUrl('https://192.168.1.1/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://192.168.0.254/hook').ok).toBe(false);

      // 127/8 Loopback
      expect(validateOutboundUrl('https://127.0.0.1:3000/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://127.255.0.1/hook').ok).toBe(false);

      // 169.254/16 Link-Local (Cloud Metadata IP)
      expect(validateOutboundUrl('https://169.254.169.254/latest/meta-data').ok).toBe(false);
      expect(validateOutboundUrl('https://169.254.1.1/hook').ok).toBe(false);

      // 100.64/10 CGNAT
      expect(validateOutboundUrl('https://100.64.0.1/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://100.127.255.255/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://100.128.0.1/hook').ok).toBe(true); // Public

      // 0/8
      expect(validateOutboundUrl('https://0.0.0.0/hook').ok).toBe(false);
    });

    it('lehnt private und lokale IPv6-Bereiche ab (::1, fc00::/7, fe80::/10, IPv4-mapped)', () => {
      // ::1 Loopback
      expect(validateOutboundUrl('https://[::1]/hook').ok).toBe(false);

      // :: Unspecified
      expect(validateOutboundUrl('https://[::]/hook').ok).toBe(false);

      // fc00::/7 ULA
      expect(validateOutboundUrl('https://[fc00::1]/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://[fd12:3456:789a::1]/hook').ok).toBe(false);

      // fe80::/10 Link-Local
      expect(validateOutboundUrl('https://[fe80::1]/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://[febf::1]/hook').ok).toBe(false);

      // IPv4-mapped private IPv6
      expect(validateOutboundUrl('https://[::ffff:127.0.0.1]/hook').ok).toBe(false);
      expect(validateOutboundUrl('https://[::ffff:192.168.1.1]/hook').ok).toBe(false);
    });
  });

  describe('Akzeptanzkriterium 4: Das Secret taucht nie im Payload auf', () => {
    it('enthält das Secret in keinem der drei Payload-Formate', () => {
      const topSecret = 'super_secret_webhook_token_xyz_98765';

      const summaryWithSecret = {
        ...sampleSummary,
        secret: topSecret,
        webhookSecret: topSecret,
        webhook_secret: topSecret,
        totals: {
          ...sampleSummary.totals,
          secret: topSecret,
          webhookSecret: topSecret,
        },
        matches: [
          {
            ...sampleMatch,
            secret: topSecret,
            api_key: topSecret,
          },
        ],
      };

      for (const format of ['generic', 'slack', 'discord'] as const) {
        const payload = buildWebhookPayload(summaryWithSecret as unknown as WebhookSummary, format);
        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain(topSecret);
      }
    });
  });
});
