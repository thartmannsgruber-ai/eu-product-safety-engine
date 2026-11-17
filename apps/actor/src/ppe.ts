/**
 * apps/actor/src/ppe.ts
 *
 * Pay-Per-Event (PPE) Konstanten, Typen und Event-Emitter fuer den Apify Actor.
 * Ermoeglicht die praezise Abrechnung pro Ereignis (z.B. ean-checked, alert-returned)
 * gemaess Apify Store Monetization Richtlinien.
 */

import { EventEmitter } from 'node:events';

/**
 * Offizielle Pay-Per-Event (PPE) Ereignisnamen.
 */
export const PPE_EVENTS = {
  EAN_CHECKED: 'ean-checked',
  ALERT_RETURNED: 'alert-returned',
  QUERY_EXECUTED: 'query-executed',
  WEEKLY_MONITORED: 'weekly-monitored',
} as const;

export type PPEEventName = (typeof PPE_EVENTS)[keyof typeof PPE_EVENTS];
export type PPEEventType = PPEEventName;

/**
 * Liste aller gueltigen PPE-Event-Namen.
 */
export const ALL_PPE_EVENTS: readonly PPEEventType[] = Object.values(PPE_EVENTS);

/**
 * Standard-Preise pro PPE-Event in USD (Pay-Per-Event Preismodell).
 */
export const PPE_EVENT_PRICES: Record<PPEEventType, number> = {
  [PPE_EVENTS.EAN_CHECKED]: 0.005,       // $0.005 pro gepruefter EAN/GTIN
  [PPE_EVENTS.ALERT_RETURNED]: 0.010,    // $0.010 pro zurueckgegebenem Alert-Datensatz
  [PPE_EVENTS.QUERY_EXECUTED]: 0.002,    // $0.002 pro Freitext-Suchabfrage
  [PPE_EVENTS.WEEKLY_MONITORED]: 0.020,  // $0.020 pro Wochenuebersichts-Abruf
} as const;

/**
 * Payload fuer das Ereignis 'ean-checked'.
 */
export interface EanCheckedPayload {
  ean: string;
  validGtin: boolean;
  matchCount: number;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Payload fuer das Ereignis 'alert-returned'.
 */
export interface AlertReturnedPayload {
  alertNumber: string;
  product?: string;
  brand?: string;
  category?: string;
  riskType?: string | string[];
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Payload fuer das Ereignis 'query-executed'.
 */
export interface QueryExecutedPayload {
  query?: string;
  category?: string;
  totalMatches: number;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Payload fuer das Ereignis 'weekly-monitored'.
 */
export interface WeeklyMonitoredPayload {
  week: string;
  alertCount: number;
  timestamp?: number;
  [key: string]: unknown;
}

/**
 * Zuordnung von Event-Name zu typisierter Payload.
 */
export interface PPEEventMap {
  [PPE_EVENTS.EAN_CHECKED]: EanCheckedPayload;
  [PPE_EVENTS.ALERT_RETURNED]: AlertReturnedPayload;
  [PPE_EVENTS.QUERY_EXECUTED]: QueryExecutedPayload;
  [PPE_EVENTS.WEEKLY_MONITORED]: WeeklyMonitoredPayload;
}

/**
 * Repraesentation eines aufgezeichneten Events in der Historie.
 */
export interface RecordedPPEEvent<T extends PPEEventType = PPEEventType> {
  event: T;
  payload: PPEEventMap[T];
  priceUsd: number;
  timestamp: number;
}

/**
 * Callback fuer Apify Actor.charge() Integration.
 */
export type ChargeHandler = (
  eventName: PPEEventType,
  options?: { count?: number; priceUsd?: number }
) => void | Promise<void>;

export interface PpeEventEmitterOptions {
  chargeHandler?: ChargeHandler;
  customPrices?: Partial<Record<PPEEventType, number>>;
}

/**
 * Stark typisierter Pay-Per-Event (PPE) Event-Emitter.
 * Verwaltet Event-Ausloesung, Zaehler, Kostenkalkulation und Apify-Charge-Hooks.
 */
export class PpeEventEmitter extends EventEmitter {
  private counts: Record<PPEEventType, number>;
  private history: RecordedPPEEvent[] = [];
  private prices: Record<PPEEventType, number>;
  private chargeHandler?: ChargeHandler;

  constructor(options?: PpeEventEmitterOptions) {
    super();
    this.chargeHandler = options?.chargeHandler;
    this.prices = { ...PPE_EVENT_PRICES, ...options?.customPrices };
    this.counts = {
      [PPE_EVENTS.EAN_CHECKED]: 0,
      [PPE_EVENTS.ALERT_RETURNED]: 0,
      [PPE_EVENTS.QUERY_EXECUTED]: 0,
      [PPE_EVENTS.WEEKLY_MONITORED]: 0,
    };
  }

  /**
   * Setzt oder aktualisiert den Apify-Charge-Handler.
   */
  setChargeHandler(handler: ChargeHandler | undefined): void {
    this.chargeHandler = handler;
  }

  /**
   * Loest ein generisches PPE-Ereignis aus.
   */
  emitPpe<T extends PPEEventType>(event: T, payload: PPEEventMap[T]): boolean {
    const timestamp = payload.timestamp ?? Date.now();
    const priceUsd = this.prices[event] ?? 0;

    this.counts[event] = (this.counts[event] ?? 0) + 1;

    const recorded: RecordedPPEEvent<T> = {
      event,
      payload: { ...payload, timestamp },
      priceUsd,
      timestamp,
    };
    this.history.push(recorded as RecordedPPEEvent);

    // Apify-Charge Callback synchron oder asynchron informieren
    if (this.chargeHandler) {
      try {
        void this.chargeHandler(event, { count: 1, priceUsd });
      } catch (err) {
        this.emit('error', err);
      }
    }

    // Standard EventEmitter emit mit Event-Name und Payload
    return super.emit(event, recorded.payload);
  }

  /**
   * Loest das spezifische PPE-Ereignis 'ean-checked' aus.
   */
  emitEanChecked(payload: EanCheckedPayload): boolean {
    return this.emitPpe(PPE_EVENTS.EAN_CHECKED, payload);
  }

  /**
   * Loest das spezifische PPE-Ereignis 'alert-returned' aus.
   */
  emitAlertReturned(payload: AlertReturnedPayload): boolean {
    return this.emitPpe(PPE_EVENTS.ALERT_RETURNED, payload);
  }

  /**
   * Loest das spezifische PPE-Ereignis 'query-executed' aus.
   */
  emitQueryExecuted(payload: QueryExecutedPayload): boolean {
    return this.emitPpe(PPE_EVENTS.QUERY_EXECUTED, payload);
  }

  /**
   * Loest das spezifische PPE-Ereignis 'weekly-monitored' aus.
   */
  emitWeeklyMonitored(payload: WeeklyMonitoredPayload): boolean {
    return this.emitPpe(PPE_EVENTS.WEEKLY_MONITORED, payload);
  }

  /**
   * Liefert den Zaehlerstand fuer ein bestimmtes Event.
   */
  getEventCount(event: PPEEventType): number {
    return this.counts[event] ?? 0;
  }

  /**
   * Liefert alle Event-Zaehler als Kopie.
   */
  getEventCounts(): Record<PPEEventType, number> {
    return { ...this.counts };
  }

  /**
   * Liefert die Gesamtsumme aller ausgeloesten Events.
   */
  getTotalEvents(): number {
    return Object.values(this.counts).reduce((sum, c) => sum + c, 0);
  }

  /**
   * Berechnet die geschaetzten Gesamtkosten aller ausgeloesten Events in USD.
   */
  calculateEstimatedCost(): number {
    let total = 0;
    for (const event of ALL_PPE_EVENTS) {
      const count = this.counts[event] ?? 0;
      const price = this.prices[event] ?? 0;
      total += count * price;
    }
    // Auf 4 Nachkommastellen runden
    return Math.round(total * 10000) / 10000;
  }

  /**
   * Liefert die detaillierte Kostenaufstellung pro Event-Typ.
   */
  getCostBreakdown(): Record<PPEEventType, { count: number; pricePerUnit: number; totalCostUsd: number }> {
    const breakdown = {} as Record<PPEEventType, { count: number; pricePerUnit: number; totalCostUsd: number }>;
    for (const event of ALL_PPE_EVENTS) {
      const count = this.counts[event] ?? 0;
      const pricePerUnit = this.prices[event] ?? 0;
      const totalCostUsd = Math.round(count * pricePerUnit * 10000) / 10000;
      breakdown[event] = { count, pricePerUnit, totalCostUsd };
    }
    return breakdown;
  }

  /**
   * Gibt alle aufgezeichneten Events zurueck.
   */
  getHistory(): readonly RecordedPPEEvent[] {
    return [...this.history];
  }

  /**
   * Setzt Zaehler und Historie zurueck.
   */
  reset(): void {
    for (const event of ALL_PPE_EVENTS) {
      this.counts[event] = 0;
    }
    this.history = [];
  }
}
