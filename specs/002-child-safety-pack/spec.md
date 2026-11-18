# Specification: Child & Baby Safety Pack (002-child-safety-pack)

## 1. Background & Business Value
Kinder- und Babyprodukte stellen das sensibelste und regulatorisch am strengsten überwachte Segment im EU Safety Gate (RAPEX) und unter der EU-Produktsicherheitsverordnung (GPSR 2023/988) dar:
- Über **35 % aller EU-Rückrufe** entfallen auf Spielzeuge, Kinderbekleidung und Babyartikel.
- **96 % davon sind als "Serious Risk"** eingestuft (Erstickungsgefahr, gefährliche Magnete, hormonell wirksame Phthalate und persistente Chemikalien wie PFAS/PFOA).
- E-Commerce-Händler, Marktplätze, Einkäufer (z. B. Kitas, Spielwarenhandel) sowie Eltern fordern spezifische Filter zur gezielten Erkennung kinderspezifischer Risiken.

## 2. Requirements & Functional Scope

### R1: Multilingual Classification (`classifyChildProduct`)
- Erkennung kinderspezifischer Produkte in DE, EN, FR über Produktname, Kategorie, Marke und Modell.
- Alterseinstufung (`ageGroup`): `baby` (0–12M, Säugling, Bébé, Schnuller), `toddler` (Kleinkind, 1–3J), `child` (Kinder, Spielzeug, Toys, Puppen) oder `unknown`.
- Ableitung von 3 gezielten Primärgefahren (`hazards`):
  - `choking`: Verschluckbare Kleinteile, Erstickungsgefahr, Schnüre.
  - `chemical`: PFAS/PFOA, Phthalate (DEHP), Cadmium, Blei, toxische Farbstoffe.
  - `magnets`: Starke Magnete mit hohem Flussindex (Darmperforationsrisiko).
- Kennzeichnung: `isChildRelated: boolean`.

### R2: Storage Integration (`AlertSearchQuery`)
- Erweiterung von `AlertSearchQuery` um:
  - `childProductsOnly?: boolean`
  - `ageGroup?: ChildAgeGroup`
  - `hazard?: ChildHazard`
- Paritätische Filterung in `MemoryAlertStorage` und `SqliteAlertStorage`.

### R3: Actor Input & Output Integration
- Erweiterung von `apps/actor/src/actor.ts`:
  - `ActorInputSchema` akzeptiert `childProductsOnly?: boolean`, `ageGroup?: string`, `hazard?: string`.
  - JSON Schema Updates in `apps/actor/.actor/input_schema.json` und `dataset_schema.json`.
  - Bereicherung der Output-Alerts um Klassifikationsmetadaten (`child_safety: { isChildRelated, ageGroup, hazards }`).

### R4: Model Context Protocol (MCP) Tool
- Neues Tool `screen_children_products` in `apps/mcp/src/tools.ts`:
  - Parameter: `query?: string`, `ageGroup?: 'baby'|'toddler'|'child'`, `hazard?: 'choking'|'chemical'|'magnets'`, `limit?: number`.
  - Pflicht-Disclaimer und EmptyDatabaseError-Guard.

### R5: Verification & Zero Regression
- Alle bestehenden 203 Tests bleiben grün.
- Neue Test-Suite für `classifyChildProduct` mit Positiv-, Negativ- und Grenzfällen (z. B. Kinderkleidung vs. Damenjacke).
- Tests für Actor-Filterung und MCP-Tool.
