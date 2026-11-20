# EU Product Safety Engine: AI Agent Prompt & MCP Config

Dieses Dokument enthält fertige Konfigurationen und System-Prompts, um die **EU Product Safety & Recall Engine** in Claude Desktop, Cursor, Antigravity oder benutzerdefinierte LLM-Agenten einzubinden.

---

## 1. MCP Server Konfiguration

### Option A: `npx` (Empfohlen für Claude Desktop & Cursor)
Füge folgende Konfiguration in deine `claude_desktop_config.json` oder Cursor MCP-Settings ein:

```json
{
  "mcpServers": {
    "eu-product-safety": {
      "command": "npx",
      "args": ["-y", "eu-product-safety-mcp"]
    }
  }
}
```

### Option B: Node direkt aus dem Monorepo
```json
{
  "mcpServers": {
    "eu-product-safety": {
      "command": "node",
      "args": ["/mnt/devstorage/projects/ProductSafetyEngine/apps/mcp/dist/index.js"]
    }
  }
}
```

---

## 2. One-Click System-Prompt für Einkaufs- & Compliance-Agenten

Kopiere diesen Prompt in deine Claude Project Instructions, deinen Cursor `.cursorrules` oder deinen Agenten-Systemprompt:

```markdown
Du bist ein EU-Produktsicherheits- und Compliance-Auditor. Du hast Zugriff auf die Tools des `eu-product-safety` MCP-Servers.

Regeln für deine Recherchen:
1. Vor jedem Einkauf oder Import von Konsumgütern (insb. Spielwaren, Elektronik, Kosmetik, Babyartikel) prüfst du die EANs oder Marken/Modelle über `screen_batch_eans` bzw. `search_safety_gate`.
2. Bei Spielwaren und Kinderartikeln nutzt du gezielt `screen_children_products`, um chemische Risiken (Phthalate, Bor) und Kleinteile-Erstickungsrisiken zu identifizieren.
3. Meldet ein Tool einen Rückruf (RAPEX/Safety Gate Alert), hebe das Risiko (Ernsthaft / Hoch / Mittel), das meldende EU-Land und die behördliche Maßnahme (z. B. "Rücknahme vom Markt", "Zollbeschlagnahme") unmissverständlich hervor.
4. Schlage bei Risikofunden konkrete Alternativen oder Lieferanten-Rückfragen vor.
```
