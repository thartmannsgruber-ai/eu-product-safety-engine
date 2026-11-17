/**
 * apps/mcp/src/server.ts
 *
 * Grundgeruest des ProductSafetyEngine MCP-Servers mit dem offiziellen
 * @modelcontextprotocol/sdk, stdio-Transport, Capabilities-Registrierung
 * und Zod-Schema-Validierung inklusive Injection Guard.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import type { IAlertStorage } from '@productsafetyengine/core';
import { sanitizeInput, detectPromptInjection, NEUTRALIZED_TAG } from './sanitizer.js';
import { registerTools } from './tools.js';

export const SERVER_NAME = 'productsafetyengine-mcp';
export const SERVER_VERSION = '1.0.0';

export interface ServerConfig {
  name?: string;
  version?: string;
  instructions?: string;
  capabilities?: {
    tools?: Record<string, unknown>;
    resources?: Record<string, unknown>;
    prompts?: Record<string, unknown>;
    logging?: Record<string, unknown>;
    [key: string]: unknown;
  };
  storage?: IAlertStorage;
}

/**
 * Standard-Capabilities fuer den MCP Server
 */
export const DEFAULT_SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: { listChanged: true },
  prompts: { listChanged: true },
  logging: {},
};

/**
 * Erstellt eine neue McpServer-Instanz und registriert Capabilities sowie Basistools.
 */
export function createMcpServer(config: ServerConfig = {}): McpServer {
  const name = config.name ?? SERVER_NAME;
  const version = config.version ?? SERVER_VERSION;
  const capabilities = config.capabilities ?? DEFAULT_SERVER_CAPABILITIES;

  const server = new McpServer(
    {
      name,
      version,
    },
    {
      capabilities,
      instructions: config.instructions ?? 'ProductSafetyEngine MCP Server for EU Safety Gate and RAPEX data.',
    },
  );

  // Registriere ein Basis-Echo- & Sanitize-Tool zur Demonstration der Zod-Validierung und des Injection Guards
  server.tool(
    'sanitize_preview',
    'Sanitizes any input text, removes control characters and neutralizes prompt injections using Zod schema validation.',
    {
      text: z.string().min(1, 'Text must not be empty').max(2048, 'Text must not exceed 2048 characters').describe('Input text to sanitize'),
      strict: z.boolean().optional().describe('If true, flags prompt injections with details'),
    },
    async ({ text, strict }) => {
      const sanitized = sanitizeInput(text, {
        maxLength: 2048,
        neutralizeInjection: true,
      });

      const detection = detectPromptInjection(text);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sanitized,
              hasInjection: detection.isInjected,
              patterns: strict ? detection.patterns : undefined,
            }),
          },
        ],
      };
    },
  );

  // Registriere die exakt 4 Safety Gate Agenten-Tools
  registerTools(server, config.storage);

  return server;
}

/**
 * Initialisiert den stdio-Transport und verbindet den Server.
 */
export async function connectStdioTransport(
  server: McpServer,
  customTransport?: StdioServerTransport,
): Promise<{ server: McpServer; transport: StdioServerTransport }> {
  const transport = customTransport ?? new StdioServerTransport();
  await server.connect(transport);
  return { server, transport };
}

/**
 * Universeller Verbindungshelfer fuer jeden beliebigen MCP-Transport (z.B. Stdio, InMemory).
 */
export async function connectServer<T extends Transport>(
  server: McpServer,
  transport: T,
): Promise<{ server: McpServer; transport: T }> {
  await server.connect(transport);
  return { server, transport };
}

/**
 * Startet den MCP-Server ueber stdio-Transport.
 */
export async function startServer(config: ServerConfig = {}): Promise<{ server: McpServer; transport: StdioServerTransport }> {
  const server = createMcpServer(config);
  return connectStdioTransport(server);
}

export * from './sanitizer.js';
export * from './tools.js';
