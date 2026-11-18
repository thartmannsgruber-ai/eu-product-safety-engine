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
});
