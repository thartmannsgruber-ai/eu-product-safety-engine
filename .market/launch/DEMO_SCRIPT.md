# 90-Sekunden Demo-Script: EU Product Safety Engine

**Ziel:** Schnelles, visuelles Video für LinkedIn, Loom, YouTube & Apify Store Listing.  
**Sprecher:** Thomas Hartmannsgruber (Gründer & Architekt)  
**Dauer:** ~90 Sekunden  

---

### [00:00 - 00:15] Hook: Der Schmerzpunkt (GPSR & Marktplatz-Sperren)
- **Visual:** Split-Screen: Amazon-Warnmeldung "Product removed due to EU Safety Gate notice" + offizielle EU Safety Gate RAPEX Website mit hunderten wöchentlichen Rückrufen.
- **Voiceover:**  
  *"Seit dem 13. Dezember 2024 ist die EU-Produktsicherheitsverordnung GPSR in voller Kraft. Wer auf Amazon, eBay oder Bol.com verkauft oder als Großhändler importiert, riskiert sofortige Kontensperren und Zollbeschlagnahme, sobald ein Produkt im EU Safety Gate auftaucht. Doch wie prüfen Sie hunderte EANs, ohne tagelang PDFs zu wälzen?"*

---

### [00:15 - 00:45] Die Lösung: Live Batch EAN-Screening
- **Visual:** Wechsel auf Apify Console (`thfc_labs/eu-product-safety-actor`). Einfügen einer Liste von 50 Barcodes / EANs in das Input-Feld. Klick auf "Start".
- **Voiceover:**  
  *"Das ist die EU Product Safety & Recall Engine. Wir kopieren einfach unsere Barcode-Liste hinein und starten den Run.  
  Das System prüft im Hintergrund automatisch die Modulo-10 Prüfziffer und gleicht jeden Artikel in Millisekunden mit den aktuellen EU Safety Gate Meldungen ab."*

---

### [00:45 - 01:10] Das Ergebnis: Strukturierter Compliance Proof
- **Visual:** Der Run ist nach 3 Sekunden fertig. Zeige das Output-Dataset: Grün = Unbedenklich, Rot/Gelb = Rückruf gefunden (z. B. Weichmacher in Spielzeug oder Überhitzungsgefahr bei Ladegerät mit genauer Meldungs-ID und Maßnahmen).
- **Voiceover:**  
  *"In weniger als 3 Sekunden haben wir das vollständige Ergebnis: Sie sehen sofort, welche Produkte freigegeben sind und bei welchen Artikeln ein Rückruf vorliegt – inklusive Behördenmaßnahme, Risikolevel und Fundstelle. Sie können den Bericht direkt als Excel oder JSON für Ihr Compliance-Archiv exportieren."*

---

### [01:10 - 01:30] Call to Action & MCP Integration
- **Visual:** Kurzer Zusammenschnitt: Terminal mit `npx eu-product-safety-mcp` (Claude Desktop Tool-Call) + Einblendung Apify Store URL.
- **Voiceover:**  
  *"Funktioniert als Pay-Per-Event Actor auf Apify oder als nativer MCP-Server direkt in Ihren KI-Agenten.  
  Testen Sie jetzt Ihren Katalog auf Apify oder fordern Sie unseren kostenlosen 100-EAN-Audit an. Link in der Beschreibung!"*
