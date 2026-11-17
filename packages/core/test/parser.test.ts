import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseSafetyGateXml,
  parseSafetyGateFile,
  parseSafetyGateFileSync,
  extractNotifications,
} from '../src/parser.js';

describe('parser - Safety Gate XML Parser', () => {
  const fixturePath = path.resolve(__dirname, '../../../fixtures/safety_gate_2026_45.xml');

  it('reads fixtures/safety_gate_2026_45.xml without error (sync & async)', async () => {
    const reportSync = parseSafetyGateFileSync(fixturePath);
    expect(reportSync).toBeDefined();
    expect(reportSync.reportLanguage).toBe('en');
    expect(reportSync.reportYear).toBe('2026');
    expect(reportSync.reportWeek).toBe('45');

    const reportAsync = await parseSafetyGateFile(fixturePath);
    expect(reportAsync).toBeDefined();
    expect(reportAsync.notifications.length).toBe(reportSync.notifications.length);
  });

  it('extracts all 75 alerts from the fixture', () => {
    const report = parseSafetyGateFileSync(fixturePath);
    expect(report.notifications).toHaveLength(75);

    const extracted = extractNotifications(report);
    expect(extracted).toHaveLength(75);
  });

  it('correctly parses details of the first notification (order 1)', () => {
    const report = parseSafetyGateFileSync(fixturePath);
    const first = report.notifications[0];

    expect(first.order).toBe('1');
    expect(first.caseNumber).toBe('SR/03208/26');
    expect(first.publicationDate).toBe('10-11-2026');
    expect(first.reference).toBe(
      'https://ec.europa.eu/safety-gate-alerts/screen/webReport/alertDetail/10118633'
    );
    expect(first.category).toBe('Clothing, textiles and fashion items');
    expect(first.product).toBe("Children's jacket");
    expect(first.brand).toBe('Jojo Maman Bébé');
    expect(first.name).toBe('Baby Jacket Flower');
    expect(first.type_numberOfModel).toBe('C52-683-145-000161');
    expect(first.batchNumber).toBe('');
    expect(first.barcode).toBe('5054298241091');
    expect(first.riskType).toBe('Chemical, Environment');
    expect(first.level).toBe('Serious risk');
    expect(first.notifyingCountry).toBe('Luxembourg');
    expect(first.countryOfOrigin).toBe("People's Republic of China");
    expect(first.pictures).toHaveLength(4);
    expect(first.pictures[0]).toBe(
      'https://ec.europa.eu/safety-gate-alerts/public/api/notification/image/11241880'
    );
  });

  it('correctly parses details of the last notification (order 75)', () => {
    const report = parseSafetyGateFileSync(fixturePath);
    const last = report.notifications[74];

    expect(last.order).toBe('75');
    expect(last.caseNumber).toBe('SR/03200/26');
    expect(last.product).toBe('Motorcycle');
    expect(last.brand).toBe('Honda');
    expect(last.riskType).toBe('Injuries');
    expect(last.companyRecallCode).toBe('3SJ');
    expect(last.productionDates).toBe('22.10.2025 - 22.10.2026');
    expect(last.pictures).toHaveLength(2);
  });

  it('handles empty or missing optional XML fields (CDATA, xsi:nil, omitted tags)', () => {
    const xmlWithEmptyAndNil = `
      <Safety-Gate xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
        <report_language>en</report_language>
        <report_date>15/11/2026</report_date>
        <report_year>2026</report_year>
        <report_week>46</report_week>
        <report_addendum><![CDATA[]]></report_addendum>
        <notifications>
          <order>1</order>
          <caseNumber>SR/99999/26</caseNumber>
          <brand><![CDATA[]]></brand>
          <product><![CDATA[Test Gadget]]></product>
          <batchNumber></batchNumber>
          <barcode xsi:nil="true"/>
          <riskType xsi:nil="1"/>
          <URLrecall/>
          <description><![CDATA[Test <with> & special characters]]></description>
          <!-- measures and type_numberOfModel omitted entirely -->
          <pictures>
            <picture><![CDATA[https://example.com/img1.jpg]]></picture>
            <picture xsi:nil="true"/>
            <picture></picture>
            <picture>https://example.com/img2.jpg</picture>
          </pictures>
          <companyRecallCode xsi:nil="true"/>
        </notifications>
      </Safety-Gate>
    `;

    const report = parseSafetyGateXml(xmlWithEmptyAndNil);
    expect(report.notifications).toHaveLength(1);

    const alert = report.notifications[0];
    expect(alert.order).toBe('1');
    expect(alert.caseNumber).toBe('SR/99999/26');
    expect(alert.brand).toBe(''); // empty CDATA
    expect(alert.product).toBe('Test Gadget');
    expect(alert.batchNumber).toBe(''); // empty tag
    expect(alert.barcode).toBe(''); // xsi:nil="true"
    expect(alert.riskType).toBe(''); // xsi:nil="1"
    expect(alert.URLrecall).toBe(''); // self-closing tag
    expect(alert.measures).toBe(''); // omitted tag
    expect(alert.type_numberOfModel).toBe(''); // omitted tag
    expect(alert.description).toBe('Test <with> & special characters');
    expect(alert.companyRecallCode).toBe(''); // xsi:nil="true"
    expect(alert.pictures).toEqual([
      'https://example.com/img1.jpg',
      'https://example.com/img2.jpg',
    ]);
  });

  it('handles XML with no notifications gracefully', () => {
    const xml = `
      <Safety-Gate>
        <report_language>en</report_language>
        <report_year>2026</report_year>
        <report_week>45</report_week>
      </Safety-Gate>
    `;
    const report = parseSafetyGateXml(xml);
    expect(report.notifications).toEqual([]);
    expect(extractNotifications(xml)).toEqual([]);
  });

  it('throws descriptive error on invalid or empty XML content', () => {
    expect(() => parseSafetyGateXml('')).toThrow('XML content is empty or invalid');
    expect(() => parseSafetyGateXml('   ')).toThrow('XML content is empty or invalid');
  });
});
