import { describe, it, expect } from 'vitest';
import { classifyChildProduct } from '../src/child-safety.js';
import type { AlertRecord } from '../src/schema.js';

describe('Child Safety Classification', () => {
  it('correctly classifies a baby jacket with PFAS chemical risk', () => {
    const alert: AlertRecord = {
      alert_number: 'SR/03208/26',
      publication_date: '2026-11-10',
      category: 'Clothing, textiles and fashion items',
      product: "Children's jacket",
      brand: 'Jojo Maman Bébé',
      model: 'Baby Jacket Flower',
      danger_description: 'Outer fabric contains high concentrations of PFOA and PFCA related compounds.',
      risk_type: 'Chemical, Environment',
      risk_level: 'Serious risk',
    };

    const result = classifyChildProduct(alert);
    expect(result.isChildRelated).toBe(true);
    expect(result.ageGroup).toBe('baby');
    expect(result.hazards).toContain('chemical');
  });

  it('correctly classifies magnetic toy sets with choking and magnet hazards', () => {
    const alert: AlertRecord = {
      alert_number: 'SR/03158/26',
      publication_date: '2026-11-10',
      category: 'Toys',
      product: 'Magnetic toy set',
      brand: 'Science Explorer',
      model: 'Magnetic set 120pcs',
      danger_description: 'Small parts and magnetic balls can be easily swallowed leading to choking and intestinal perforation.',
      risk_type: 'Choking, Injuries',
      risk_level: 'Serious risk',
    };

    const result = classifyChildProduct(alert);
    expect(result.isChildRelated).toBe(true);
    expect(result.ageGroup).toBe('child');
    expect(result.hazards).toContain('choking');
    expect(result.hazards).toContain('magnets');
  });

  it('correctly rejects adult clothing and accessories (false-positive prevention)', () => {
    const adultAlert: AlertRecord = {
      alert_number: 'SR/03217/26',
      publication_date: '2026-11-10',
      category: 'Clothing, textiles and fashion items',
      product: 'Cap',
      brand: 's.Oliver',
      model: 'ONE SIZE Adult Cap',
      danger_description: 'Outer fabric contains high concentrations of PFOA.',
      risk_type: 'Chemical, Environment',
      risk_level: 'Serious risk',
    };

    const result = classifyChildProduct(adultAlert);
    expect(result.isChildRelated).toBe(false);
    expect(result.ageGroup).toBe('unknown');
  });

  it('correctly rejects automotive, industrial, and protective items', () => {
    const ppeAlert: AlertRecord = {
      alert_number: 'SR/03180/26',
      publication_date: '2026-11-10',
      category: 'Protective equipment',
      product: 'Safety shoes',
      brand: 'ProWork',
      model: 'Steel Toe S3',
      danger_description: 'Toe cap does not withstand required impact.',
      risk_type: 'Injuries',
      risk_level: 'Serious risk',
    };

    const result = classifyChildProduct(ppeAlert);
    expect(result.isChildRelated).toBe(false);
  });

  it('guarantees identical filtering results across MemoryAlertStorage and SqliteAlertStorage', async () => {
    const { MemoryAlertStorage, SqliteAlertStorage } = await import('../src/storage.js');
    const sqliteStorage = new SqliteAlertStorage(':memory:', { autoSeed: true });
    const allAlerts = await sqliteStorage.findAlerts();
    const memStorage = new MemoryAlertStorage(allAlerts);

    const memChildAlerts = await memStorage.findAlerts({ childProductsOnly: true });
    const sqliteChildAlerts = await sqliteStorage.findAlerts({ childProductsOnly: true });

    expect(memChildAlerts.length).toBe(26);
    expect(sqliteChildAlerts.length).toBe(26);
    expect(sqliteChildAlerts.map((a) => a.alert_number)).toEqual(memChildAlerts.map((a) => a.alert_number));

    const memChokingAlerts = await memStorage.findAlerts({ childProductsOnly: true, hazard: 'choking' });
    const sqliteChokingAlerts = await sqliteStorage.findAlerts({ childProductsOnly: true, hazard: 'choking' });

    expect(memChokingAlerts.length).toBeGreaterThan(0);
    expect(sqliteChokingAlerts.length).toBe(memChokingAlerts.length);
  });

  describe('Herznieren Audit Verification (S1-S8 Scenarios)', () => {
    it('S1: correctly identifies French baby product "Biberon pour bébé"', () => {
      const alert: AlertRecord = {
        alert_number: 'FR/TEST/001',
        publication_date: '2026-11-18',
        category: 'Childcare articles',
        product: 'Biberon pour bébé en verre',
        brand: 'BébéConfort',
        model: 'Classic 250ml',
      };
      const res = classifyChildProduct(alert);
      expect(res.isChildRelated).toBe(true);
      expect(res.ageGroup).toBe('baby');
    });

    it('S2: detects French choking hazard "risque d\'étouffement" without risk_type fallback', () => {
      const alert: AlertRecord = {
        alert_number: 'FR/TEST/002',
        publication_date: '2026-11-18',
        category: 'Toys',
        product: 'Jouet musical',
        danger_description: 'Présence de petites pièces présentant un risque d\'étouffement pour les jeunes enfants.',
      };
      const res = classifyChildProduct(alert);
      expect(res.isChildRelated).toBe(true);
      expect(res.hazards).toContain('choking');
    });

    it('S3: identifies French "poupée" even if category does not mention jouet', () => {
      const alert: AlertRecord = {
        alert_number: 'FR/TEST/003',
        publication_date: '2026-11-18',
        category: 'Decorative items',
        product: 'Poupée traditionnelle en tissu',
      };
      const res = classifyChildProduct(alert);
      expect(res.isChildRelated).toBe(true);
      expect(res.ageGroup).toBe('child');
    });

    it('S4: detects German compounds "Erstickungsgefahr" and "verschluckbare Kleinteile"', () => {
      const alert: AlertRecord = {
        alert_number: 'DE/TEST/004',
        publication_date: '2026-11-18',
        category: 'Sonstiges',
        product: 'Kinder-Holzspielzeug',
        danger_description: 'Es besteht akute Erstickungsgefahr durch leicht verschluckbare Kleinteile.',
      };
      const res = classifyChildProduct(alert);
      expect(res.isChildRelated).toBe(true);
      expect(res.hazards).toContain('choking');
    });

    it('S5 & S6: prevents false-positive chemical hazard on "could lead to" and "within reach of children"', () => {
      const alert: AlertRecord = {
        alert_number: 'EN/TEST/005',
        publication_date: '2026-11-18',
        category: 'Furniture',
        product: 'Folding chair',
        danger_description: 'The mechanism could lead to injuries if left within reach of children.',
        risk_type: 'Injuries',
      };
      const res = classifyChildProduct(alert);
      expect(res.hazards).not.toContain('chemical');
    });

    it('S7: detects plural "phthalates" and chemical compounds', () => {
      const alert: AlertRecord = {
        alert_number: 'EN/TEST/007',
        publication_date: '2026-11-18',
        category: 'Toys',
        product: 'Plastic bath duck',
        danger_description: 'Plastic material contains phthalates above the permissible limit.',
      };
      const res = classifyChildProduct(alert);
      expect(res.hazards).toContain('chemical');
    });

    it('S8: correctly flags genuine chemical markers (lead paint, Pb, REACH, bleihaltig) and avoids "bleibt"', () => {
      const genuineAlert: AlertRecord = {
        alert_number: 'EN/TEST/008A',
        publication_date: '2026-11-18',
        category: 'Toys',
        product: 'Toy car',
        danger_description: 'Coated with lead paint, excessive Pb content violating REACH regulation.',
      };
      expect(classifyChildProduct(genuineAlert).hazards).toContain('chemical');

      const bleiAlert: AlertRecord = {
        alert_number: 'DE/TEST/008B',
        publication_date: '2026-11-18',
        category: 'Toys',
        product: 'Lötbausatz für Kinder',
        danger_description: 'Enthält bleihaltiges Lötzinn.',
      };
      expect(classifyChildProduct(bleiAlert).hazards).toContain('chemical');

      const negativeBleiAlert: AlertRecord = {
        alert_number: 'DE/TEST/008C',
        publication_date: '2026-11-18',
        category: 'Toys',
        product: 'Holzklotz',
        danger_description: 'Das Produkt bleibt stabil unter Belastung.',
      };
      expect(classifyChildProduct(negativeBleiAlert).hazards).not.toContain('chemical');
    });

    it('S9: handles German umlauts in compounds like "Plüschspielzeug"', () => {
      const alert: AlertRecord = {
        alert_number: 'DE/TEST/009',
        publication_date: '2026-11-18',
        category: 'Sonstiges',
        product: 'Plüschspielzeug Bär',
      };
      const res = classifyChildProduct(alert);
      expect(res.isChildRelated).toBe(true);
      expect(res.ageGroup).toBe('child');
    });
  });
});
