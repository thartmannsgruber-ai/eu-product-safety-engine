#!/usr/bin/env node
/**
 * apps/mcp/src/index.ts
 *
 * Haupteinstiegspunkt und ausfuehrbares CLI-Binary fuer den ProductSafetyEngine MCP Server.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { startServer } from './server.js';

export * from './sanitizer.js';
export * from './server.js';
export * from './tools.js';
export * from './payment.js';

// Automatische Server-Initialisierung bei direktem Start als CLI/Binary
function isDirectExecution(): boolean {
  if (!process.argv[1]) return false;
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const entryFile = fs.realpathSync(process.argv[1]);
    return (
      currentFile === entryFile ||
      process.argv[1].endsWith('eu-product-safety-mcp') ||
      process.argv[1].endsWith('eu-product-safety-mcp.js')
    );
  } catch {
    return (
      process.argv[1].includes('eu-product-safety-mcp') ||
      process.argv[1].endsWith('index.js')
    );
  }
}

if (isDirectExecution()) {
  startServer().catch((error) => {
    console.error('Fatal error starting ProductSafetyEngine MCP Server:', error);
    process.exit(1);
  });
}
