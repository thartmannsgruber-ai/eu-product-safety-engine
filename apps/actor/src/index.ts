/**
 * apps/actor/src/index.ts
 *
 * Haupteinstiegspunkt fuer den Apify Actor und Pay-Per-Event (PPE) Module.
 */

import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { Actor } from 'apify';
import { runActor, type ActorRunResult } from './actor.js';

export * from './ppe.js';
export * from './actor.js';

/**
 * Hauptfunktion fuer die Apify-Actor-Ausfuehrung im Container.
 * Initialisiert den Actor-Kontext, liest den Input ein, fuehrt runActor() aus
 * und schliesst den Run sauber ab.
 */
export async function main(): Promise<ActorRunResult> {
  let result: ActorRunResult | undefined;
  await Actor.main(async () => {
    const input = await Actor.getInput();
    result = await runActor(input);
    console.log(
      `ProductSafetyEngine Actor completed: ${result.totalCount} items found, ${result.ppeEventsTriggered} PPE events triggered, estimated cost: $${result.totalCostUsd}.`
    );
  });
  return result!;
}

/**
 * Erkennt, ob die Datei direkt als Container-Entrypoint gestartet wurde
 * (z.B. node apps/actor/dist/index.js), um Actor.main() automatisch auszufuehren.
 */
export function isDirectExecution(customArgv1?: string): boolean {
  const target = customArgv1 ?? process.argv[1];
  if (!target) return false;
  if (!customArgv1 && (process.env.VITEST || process.env.NODE_ENV === 'test')) {
    return false;
  }
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const entryFile = fs.realpathSync(target);
    return (
      currentFile === entryFile ||
      target.endsWith('apps/actor/dist/index.js') ||
      target.endsWith('apps/actor/src/index.ts')
    );
  } catch {
    return (
      target.endsWith('apps/actor/dist/index.js') ||
      target.endsWith('apps/actor/src/index.ts') ||
      target.endsWith('dist/index.js') ||
      target.endsWith('index.js')
    );
  }
}

// Container-Start: Fuehrt Actor.main() beim direkten Container-Start aus
if (isDirectExecution()) {
  main().catch((err) => {
    console.error('Fatal error running Apify Actor:', err);
    process.exit(1);
  });
}
