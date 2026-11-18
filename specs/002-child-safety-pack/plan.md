# Technical Implementation Plan: Child & Baby Safety Pack

## Architecture Overview

```
                      +--------------------------------------+
                      |    Official EU Safety Gate XML       |
                      +--------------------------------------+
                                         |
                                         v
                      +--------------------------------------+
                      |       @productsafetyengine/core      |
                      |  - classifyChildProduct(alert)       |
                      |  - isChildRelated, ageGroup, hazards |
                      |  - AlertSearchQuery extension        |
                      |  - Memory & Sqlite Storage filters   |
                      +--------------------------------------+
                                         |
                       +-----------------+-----------------+
                       |                                   |
                       v                                   v
        +-----------------------------+     +-----------------------------+
        |   @productsafetyengine/actor|     |   @productsafetyengine/mcp  |
        | - input_schema: childOnly,  |     | - tool:                     |
        |   hazard, ageGroup          |     |   screen_children_products  |
        | - output: enriched items    |     | - structured sanitization   |
        +-----------------------------+     +-----------------------------+
```

## Implementation Steps

1. **Core Package:**
   - Create `packages/core/src/child-safety.ts`.
   - Re-export types and classification function in `packages/core/src/index.ts`.
   - Update `packages/core/src/storage.ts` to support `childProductsOnly`, `ageGroup`, and `hazard` across both `MemoryAlertStorage` and `SqliteAlertStorage`.
2. **Actor Package:**
   - Update `apps/actor/src/actor.ts` input schema and execution loop.
   - Update `apps/actor/.actor/input_schema.json` and `dataset_schema.json`.
3. **MCP Package:**
   - Implement `screen_children_products` in `apps/mcp/src/tools.ts`.
4. **Testing & QA:**
   - Unit tests in `packages/core/test/child-safety.test.ts`.
   - Actor input tests in `apps/actor/test/actor.test.ts`.
   - MCP tool tests in `apps/mcp/test/tools.test.ts`.
   - Full monorepo build and test (`npm test`, `npm run build`).
