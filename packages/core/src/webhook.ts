import { createHmac } from 'node:crypto';

export type WebhookFormat = 'generic' | 'slack' | 'discord';

export interface WebhookMatchItem {
  input_identifier?: string | null;
  sku?: string | null;
  alert_number?: string;
  product?: string;
  brand?: string;
  risk_level?: string;
  risk_type?: string;
  source_url?: string;
  [key: string]: unknown;
}

export interface WebhookSummary {
  run_id?: string;
  runId?: string;
  generated_at?: string;
  generatedAt?: string;
  totals?: Record<string, unknown>;
  matches?: WebhookMatchItem[];
  [key: string]: unknown;
}

export interface GenericWebhookMatch {
  input_identifier: string | null;
  sku: string | null;
  alert_number: string;
  product: string;
  brand: string;
  risk_level: string;
  risk_type: string;
  source_url: string;
}

export interface GenericWebhookPayload {
  schema: 'pse.alert.v1';
  run_id: string;
  generated_at: string;
  totals: Record<string, unknown>;
  matches: GenericWebhookMatch[];
}

export interface SlackBlockText {
  type: 'mrkdwn' | 'plain_text';
  text: string;
}

export interface SlackBlock {
  type: string;
  text?: SlackBlockText;
  [key: string]: unknown;
}

export interface SlackWebhookPayload {
  blocks: SlackBlock[];
}

export interface DiscordEmbed {
  title?: string;
  description: string;
  url?: string;
  [key: string]: unknown;
}

export interface DiscordWebhookPayload {
  embeds: DiscordEmbed[];
}

export type WebhookPayload = GenericWebhookPayload | SlackWebhookPayload | DiscordWebhookPayload;

export interface UrlValidationResult {
  ok: boolean;
  reason?: string;
}

export const MAX_SLACK_BLOCKS = 50;
export const MAX_SLACK_TEXT = 3000;
export const MAX_DISCORD_EMBEDS = 10;
export const MAX_DISCORD_DESC = 4096;

/**
 * Signs a payload body using HMAC-SHA256 and returns 'sha256=<hex>'.
 */
export function signPayload(body: string | Buffer | Record<string, unknown>, secret: string): string {
  if (typeof secret !== 'string') {
    throw new Error('HMAC secret must be a string');
  }
  const payloadStr =
    typeof body === 'string'
      ? body
      : Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body);

  const hmac = createHmac('sha256', secret);
  hmac.update(payloadStr);
  return `sha256=${hmac.digest('hex')}`;
}

/**
 * Helper to parse and expand an IPv6 address into 8 16-bit words.
 */
function parseIpv6Words(ip: string): number[] | null {
  let address = ip;
  // Handle IPv4-mapped IPv6 like ::ffff:192.168.1.1
  const lastColon = address.lastIndexOf(':');
  if (lastColon !== -1 && address.slice(lastColon + 1).includes('.')) {
    const ipv4Part = address.slice(lastColon + 1);
    const parts = ipv4Part.split('.').map(Number);
    if (parts.length === 4 && parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
      const high = (parts[0] << 8) | parts[1];
      const low = (parts[2] << 8) | parts[3];
      const prefix = address.slice(0, lastColon);
      address = `${prefix}:${high.toString(16)}:${low.toString(16)}`;
    }
  }

  const parts = address.split('::');
  if (parts.length > 2) return null;

  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;

  const middle = new Array(missing).fill('0');
  const full = [...head, ...middle, ...tail];
  if (full.length !== 8) return null;

  const words = full.map((w) => parseInt(w || '0', 16));
  if (words.some((w) => isNaN(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

/**
 * Checks whether an IPv4 address is in a private, loopback, link-local, or CGNAT range.
 * 10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, 0/8.
 */
function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return false;
  }
  const [b0, b1] = parts;
  if (b0 === 10) return true; // 10/8 Private
  if (b0 === 172 && b1 >= 16 && b1 <= 31) return true; // 172.16/12 Private
  if (b0 === 192 && b1 === 168) return true; // 192.168/16 Private
  if (b0 === 127) return true; // 127/8 Loopback
  if (b0 === 169 && b1 === 254) return true; // 169.254/16 Link-Local
  if (b0 === 100 && b1 >= 64 && b1 <= 127) return true; // 100.64/10 CGNAT
  if (b0 === 0) return true; // 0/8 Current network
  return false;
}

/**
 * Checks whether an IPv6 address is in a private, loopback, link-local, or ULA range.
 * ::1, fc00::/7, fe80::/10, :: (unspecified), or IPv4-mapped private.
 */
function isPrivateIpv6(ip: string): boolean {
  const words = parseIpv6Words(ip);
  if (!words) return false;

  // ::1 Loopback
  if (words.slice(0, 7).every((w) => w === 0) && words[7] === 1) return true;
  // :: Unspecified
  if (words.every((w) => w === 0)) return true;
  // fc00::/7 Unique Local Address (ULA)
  if ((words[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 Link-Local Unicast
  if ((words[0] & 0xffc0) === 0xfe80) return true;

  // IPv4-mapped IPv6 ::ffff:x.x.x.x
  if (words.slice(0, 5).every((w) => w === 0) && words[5] === 0xffff) {
    const b0 = words[6] >> 8;
    const b1 = words[6] & 0xff;
    if (b0 === 10) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    if (b0 === 0) return true;
  }

  return false;
}

/**
 * Checks if a hostname is a prohibited local/metadata domain.
 */
function isForbiddenHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;
  if (lower === 'metadata.google.internal' || lower.endsWith('.metadata.google.internal')) return true;
  if (lower === 'metadata' || lower === 'instance-data') return true;
  return false;
}

/**
 * Validates an outbound URL to prevent SSRF vulnerabilities.
 * - Allows only https protocol.
 * - Rejects IP literals from private, loopback, link-local, and CGNAT ranges
 *   (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10, ::1, fc00::/7, fe80::/10).
 * - Rejects localhost and metadata.google.internal hosts.
 * - Returns { ok: true } or { ok: false, reason?: string }.
 */
export function validateOutboundUrl(url: string): UrlValidationResult {
  if (typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: 'URL must be a non-empty string' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      reason: `Protocol '${parsed.protocol}' is not allowed, only https is permitted`,
    };
  }

  const rawHostname = parsed.hostname;
  if (!rawHostname) {
    return { ok: false, reason: 'Missing hostname in URL' };
  }

  const hostname = rawHostname.toLowerCase();
  const cleanHost = hostname.replace(/^\[|\]$/g, '');

  if (isForbiddenHost(hostname) || isForbiddenHost(cleanHost)) {
    return { ok: false, reason: `Host '${hostname}' is forbidden (SSRF protection)` };
  }

  if (isPrivateIpv4(cleanHost)) {
    return { ok: false, reason: `IPv4 address '${cleanHost}' is in a private, loopback, or reserved range` };
  }

  if (isPrivateIpv6(cleanHost)) {
    return { ok: false, reason: `IPv6 address '${cleanHost}' is in a private, loopback, or reserved range` };
  }

  return { ok: true };
}

function formatSlackMatch(m: WebhookMatchItem): string {
  const parts: string[] = [];
  const title = m.alert_number ? `*${m.alert_number}*` : '*Alert*';
  const prod = m.product ? ` - ${m.product}` : '';
  parts.push(`${title}${prod}`);

  const details: string[] = [];
  if (m.brand) details.push(`*Brand:* ${m.brand}`);
  if (m.risk_level || m.risk_type) {
    const risk = [m.risk_level, m.risk_type].filter(Boolean).join(' - ');
    details.push(`*Risk:* ${risk}`);
  }
  if (m.sku) details.push(`*SKU:* ${m.sku}`);
  if (m.input_identifier) details.push(`*Identifier:* ${m.input_identifier}`);
  if (details.length > 0) {
    parts.push(details.join(' | '));
  }
  if (m.source_url) {
    parts.push(`<${m.source_url}|Safety Gate Details>`);
  }
  let text = parts.join('\n');
  if (text.length > MAX_SLACK_TEXT) {
    text = text.slice(0, MAX_SLACK_TEXT - 3) + '...';
  }
  return text;
}

function formatDiscordDescription(m: WebhookMatchItem): string {
  const parts: string[] = [];
  if (m.product) parts.push(`**Product:** ${m.product}`);
  if (m.brand) parts.push(`**Brand:** ${m.brand}`);
  if (m.risk_level || m.risk_type) {
    const risk = [m.risk_level, m.risk_type].filter(Boolean).join(' - ');
    parts.push(`**Risk:** ${risk}`);
  }
  if (m.sku) parts.push(`**SKU:** ${m.sku}`);
  if (m.input_identifier) parts.push(`**Identifier:** ${m.input_identifier}`);
  if (m.source_url) parts.push(`[Safety Gate Alert](${m.source_url})`);
  let text = parts.join('\n');
  if (!text) {
    text = m.alert_number || 'Alert';
  }
  if (text.length > MAX_DISCORD_DESC) {
    text = text.slice(0, MAX_DISCORD_DESC - 3) + '...';
  }
  return text;
}

/**
 * Builds a webhook payload from a summary in one of three formats:
 * - 'generic': pse.alert.v1 JSON schema
 * - 'slack': Slack Block Kit (blocks <= 50, text <= 3000 chars)
 * - 'discord': Discord Webhook (embeds <= 10, description <= 4096 chars)
 *
 * For excess items, the list is truncated and a '+N weitere' note is appended.
 */
export function buildWebhookPayload(
  summary: WebhookSummary,
  format: WebhookFormat = 'generic'
): WebhookPayload {
  const matches = Array.isArray(summary.matches) ? summary.matches : [];
  const fmt = (format || 'generic').toLowerCase() as WebhookFormat;

  if (fmt === 'generic') {
    const totalsObj = { ...(summary.totals || { matches: matches.length }) };
    // Strict protection: Secrets never leak into webhook payloads
    delete (totalsObj as Record<string, unknown>).secret;
    delete (totalsObj as Record<string, unknown>).webhookSecret;
    delete (totalsObj as Record<string, unknown>).webhook_secret;

    const mappedMatches: GenericWebhookMatch[] = matches.map((m) => {
      const inputId =
        m.input_identifier !== undefined
          ? m.input_identifier
          : (m as Record<string, unknown>).identifier !== undefined
          ? ((m as Record<string, unknown>).identifier as string)
          : (m as Record<string, unknown>).inputIdentifier !== undefined
          ? ((m as Record<string, unknown>).inputIdentifier as string)
          : null;

      const sku = m.sku !== undefined ? m.sku : null;

      return {
        input_identifier: inputId,
        sku,
        alert_number: String(m.alert_number ?? (m as Record<string, unknown>).alertNumber ?? ''),
        product: String(m.product ?? ''),
        brand: String(m.brand ?? ''),
        risk_level: String(m.risk_level ?? (m as Record<string, unknown>).riskLevel ?? ''),
        risk_type: String(m.risk_type ?? (m as Record<string, unknown>).riskType ?? ''),
        source_url: String(m.source_url ?? (m as Record<string, unknown>).sourceUrl ?? ''),
      };
    });

    const payload: GenericWebhookPayload = {
      schema: 'pse.alert.v1',
      run_id: String(summary.run_id ?? summary.runId ?? ''),
      generated_at: String(summary.generated_at ?? summary.generatedAt ?? new Date().toISOString()),
      totals: totalsObj,
      matches: mappedMatches,
    };
    return payload;
  }

  if (fmt === 'slack') {
    const blocks: SlackBlock[] = [];
    if (matches.length <= MAX_SLACK_BLOCKS) {
      for (const m of matches) {
        const textStr = formatSlackMatch(m);
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: textStr,
          },
        });
      }
    } else {
      const allowedCount = MAX_SLACK_BLOCKS - 1; // 49
      const visibleMatches = matches.slice(0, allowedCount);
      for (const m of visibleMatches) {
        const textStr = formatSlackMatch(m);
        blocks.push({
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: textStr,
          },
        });
      }
      const remaining = matches.length - allowedCount;
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `+${remaining} weitere`,
        },
      });
    }

    const payload: SlackWebhookPayload = {
      blocks,
    };
    return payload;
  }

  if (fmt === 'discord') {
    const embeds: DiscordEmbed[] = [];
    if (matches.length <= MAX_DISCORD_EMBEDS) {
      for (const m of matches) {
        const desc = formatDiscordDescription(m);
        const titleStr = m.alert_number
          ? `${m.alert_number}${m.product ? `: ${m.product}` : ''}`.slice(0, 256)
          : (m.product || 'Alert').slice(0, 256);

        const embed: DiscordEmbed = {
          title: titleStr,
          description: desc,
        };
        if (m.source_url) {
          embed.url = String(m.source_url);
        }
        embeds.push(embed);
      }
    } else {
      const allowedCount = MAX_DISCORD_EMBEDS - 1; // 9
      const visibleMatches = matches.slice(0, allowedCount);
      for (const m of visibleMatches) {
        const desc = formatDiscordDescription(m);
        const titleStr = m.alert_number
          ? `${m.alert_number}${m.product ? `: ${m.product}` : ''}`.slice(0, 256)
          : (m.product || 'Alert').slice(0, 256);

        const embed: DiscordEmbed = {
          title: titleStr,
          description: desc,
        };
        if (m.source_url) {
          embed.url = String(m.source_url);
        }
        embeds.push(embed);
      }
      const remaining = matches.length - allowedCount;
      embeds.push({
        title: `+${remaining} weitere`,
        description: `+${remaining} weitere`,
      });
    }

    const payload: DiscordWebhookPayload = {
      embeds,
    };
    return payload;
  }

  throw new Error(`Unsupported webhook format: ${format}`);
}
