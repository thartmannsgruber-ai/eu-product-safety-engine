/**
 * apps/mcp/src/payment.ts
 *
 * PaymentGate Interface und Noop-Implementierung zur Vorbereitung fuer
 * Stripe Machine Payments Protocol (MPP) / x402 Mikrozahlungen pro Event.
 */

/**
 * Standardisierte Header fuer HTTP 402 (Payment Required) und x402 / Stripe MPP.
 */
export const HTTP_402_HEADERS = {
  PAYMENT_REQUIRED: 'X-Payment-Required',
  PROTOCOL: 'X-Payment-Protocol',
  COST_CREDITS: 'X-Cost-Credits',
  AMOUNT: 'X-Payment-Amount',
  CURRENCY: 'X-Payment-Currency',
  TOKEN: 'X-Payment-Token',
  CHALLENGE: 'X-Payment-Challenge',
  PAYMENT_URL: 'X-Payment-Url',
  TOOL_NAME: 'X-Payment-Tool',
  RECIPIENT: 'X-Payment-Recipient',
} as const;

/**
 * Typisierte HTTP-Header-Struktur fuer 402 Metadaten.
 */
export interface Http402Headers {
  'X-Payment-Required'?: string;
  'X-Payment-Protocol'?: string;
  'X-Cost-Credits'?: string;
  'X-Payment-Amount'?: string;
  'X-Payment-Currency'?: string;
  'X-Payment-Token'?: string;
  'X-Payment-Challenge'?: string;
  'X-Payment-Url'?: string;
  'X-Payment-Tool'?: string;
  'X-Payment-Recipient'?: string;
  [header: string]: string | undefined;
}

/**
 * Vollstaendige Metadaten-Struktur einer HTTP 402 Payment Required Antwort.
 */
export interface Http402Metadata {
  status: 402;
  protocol: string;
  costCredits: number;
  amount?: number;
  currency?: string;
  toolName?: string;
  paymentUrl?: string;
  challenge?: string;
  recipient?: string;
  headers: Http402Headers;
}

/**
 * Parameter zur Erstellung von HTTP 402 Metadaten und Headern.
 */
export interface CreateHttp402Params {
  toolName?: string;
  costCredits?: number;
  amount?: number;
  currency?: string;
  paymentUrl?: string;
  challenge?: string;
  recipient?: string;
  protocol?: string;
}

/**
 * Erzeugt standardisierte HTTP 402 Metadaten-Header fuer x402 / Stripe MPP.
 */
export function createHttp402Headers(params: CreateHttp402Params = {}): Http402Headers {
  const protocol = params.protocol ?? 'stripe-mpp/1.0';
  const costCredits = params.costCredits ?? 1;

  const headers: Http402Headers = {
    [HTTP_402_HEADERS.PAYMENT_REQUIRED]: 'true',
    [HTTP_402_HEADERS.PROTOCOL]: protocol,
    [HTTP_402_HEADERS.COST_CREDITS]: String(costCredits),
  };

  if (params.toolName !== undefined) {
    headers[HTTP_402_HEADERS.TOOL_NAME] = params.toolName;
  }
  if (params.amount !== undefined) {
    headers[HTTP_402_HEADERS.AMOUNT] = String(params.amount);
  }
  if (params.currency !== undefined) {
    headers[HTTP_402_HEADERS.CURRENCY] = params.currency;
  }
  if (params.paymentUrl !== undefined) {
    headers[HTTP_402_HEADERS.PAYMENT_URL] = params.paymentUrl;
  }
  if (params.challenge !== undefined) {
    headers[HTTP_402_HEADERS.CHALLENGE] = params.challenge;
  }
  if (params.recipient !== undefined) {
    headers[HTTP_402_HEADERS.RECIPIENT] = params.recipient;
  }

  return headers;
}

/**
 * Erzeugt das vollstaendige HTTP 402 Metadaten-Objekt inklusive Header-Map.
 */
export function createHttp402Metadata(params: CreateHttp402Params = {}): Http402Metadata {
  const protocol = params.protocol ?? 'stripe-mpp/1.0';
  const costCredits = params.costCredits ?? 1;
  const headers = createHttp402Headers(params);

  return {
    status: 402,
    protocol,
    costCredits,
    amount: params.amount,
    currency: params.currency,
    toolName: params.toolName,
    paymentUrl: params.paymentUrl,
    challenge: params.challenge,
    recipient: params.recipient,
    headers,
  };
}

/**
 * Zahlungsnachweis fuer MPP / x402.
 */
export interface PaymentProof {
  token?: string;
  signature?: string;
  payerId?: string;
  transactionId?: string;
  amount?: number;
  currency?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Ergebnis der Zahlungspruefung via verifyPayment().
 */
export interface PaymentVerificationResult {
  valid: boolean;
  payerId?: string;
  transactionId?: string;
  amount?: number;
  remainingBalance?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Kontext eines MCP Tool-Aufrufs zur Autorisierung.
 */
export interface ToolCallContext {
  clientId?: string;
  payerId?: string;
  costCredits?: number;
  paymentProof?: PaymentProof | string;
  headers?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Ergebnis der Autorisierung via authorizeToolCall().
 */
export interface ToolAuthorizationResult {
  authorized: boolean;
  toolName: string;
  costCredits: number;
  consumedCredits: number;
  reason?: string;
  http402Metadata?: Http402Metadata;
}

/**
 * IPaymentGate Interface
 *
 * Schnittstelle fuer Zahlungspruefung und Autorisierung von MCP Tool-Aufrufen
 * im Rahmen des Machine Payments Protocols (MPP / x402 / Stripe).
 */
export interface IPaymentGate {
  /**
   * Verifiziert einen uebergebenen Zahlungsnachweis (Token, Signatur oder Receipt).
   */
  verifyPayment(proof: PaymentProof | string): Promise<PaymentVerificationResult>;

  /**
   * Prueft und autorisiert einen Tool-Aufruf. Verbucht bei Erfolg die Credits
   * oder liefert bei fehlender Autorisierung HTTP 402 Metadaten zurueck.
   */
  authorizeToolCall(toolName: string, context?: ToolCallContext): Promise<ToolAuthorizationResult>;
}

/**
 * Optionen zur Initialisierung des NoopPaymentGate.
 */
export interface NoopPaymentGateOptions {
  /**
   * Standard-Kreditkosten pro Tool-Aufruf, falls im Kontext nicht anders spezifiziert (Default: 1).
   */
  defaultCreditCost?: number;
  /**
   * Dev/Offline-Modus aktiv (Default: true).
   */
  devMode?: boolean;
}

/**
 * NoopPaymentGate Implementierung
 *
 * Laesst Offline- und Dev-Aufrufe unblockiert durch und zaehlt die
 * verbrauchten Credits (sowohl global als auch pro Client und Tool).
 */
export class NoopPaymentGate implements IPaymentGate {
  private _totalConsumedCredits = 0;
  private _callCount = 0;
  private _creditsByClient = new Map<string, number>();
  private _creditsByTool = new Map<string, number>();
  public readonly defaultCreditCost: number;
  public readonly devMode: boolean;

  constructor(options: NoopPaymentGateOptions = {}) {
    this.defaultCreditCost = options.defaultCreditCost ?? 1;
    this.devMode = options.devMode ?? true;
  }

  /**
   * Gibt die Gesamtzahl aller bisher verbrauchten Credits zurueck.
   */
  get totalConsumedCredits(): number {
    return this._totalConsumedCredits;
  }

  /**
   * Gibt die Gesamtzahl aller registrierten Aufrufe zurueck.
   */
  get callCount(): number {
    return this._callCount;
  }

  /**
   * Ruft die verbrauchten Credits ab – optional gefiltert nach Client-ID.
   */
  getConsumedCredits(clientId?: string): number {
    if (clientId) {
      return this._creditsByClient.get(clientId) ?? 0;
    }
    return this._totalConsumedCredits;
  }

  /**
   * Ruft die verbrauchten Credits fuer ein bestimmtes Tool ab.
   */
  getToolConsumedCredits(toolName: string): number {
    return this._creditsByTool.get(toolName) ?? 0;
  }

  /**
   * Setzt alle internen Credit- und Aufruf-Zaehler zurueck.
   */
  resetCredits(): void {
    this._totalConsumedCredits = 0;
    this._callCount = 0;
    this._creditsByClient.clear();
    this._creditsByTool.clear();
  }

  /**
   * Im Noop/Dev-Modus werden Zahlungsnachweise stets als gueltig akzeptiert.
   */
  async verifyPayment(proof: PaymentProof | string): Promise<PaymentVerificationResult> {
    const isString = typeof proof === 'string';
    const payerId = isString ? 'dev-noop-payer' : (proof.payerId ?? 'dev-noop-payer');
    const transactionId = isString
      ? (proof.length > 0 ? proof : `noop-tx-${Date.now()}`)
      : (proof.transactionId ?? `noop-tx-${Date.now()}`);
    const amount = !isString ? proof.amount : undefined;

    return {
      valid: true,
      payerId,
      transactionId,
      amount,
      metadata: {
        devMode: this.devMode,
        offline: true,
      },
    };
  }

  /**
   * Autorisierung fuer Offline-/Dev-Modus:
   * Laesst den Aufruf passieren und verbucht die entsprechenden Credits.
   */
  async authorizeToolCall(toolName: string, context: ToolCallContext = {}): Promise<ToolAuthorizationResult> {
    const cost = Math.max(0, context.costCredits ?? this.defaultCreditCost);
    const clientId = context.clientId ?? 'default-dev-client';

    this._callCount++;
    this._totalConsumedCredits += cost;
    this._creditsByClient.set(clientId, (this._creditsByClient.get(clientId) ?? 0) + cost);
    this._creditsByTool.set(toolName, (this._creditsByTool.get(toolName) ?? 0) + cost);

    return {
      authorized: true,
      toolName,
      costCredits: cost,
      consumedCredits: this._totalConsumedCredits,
      reason: 'NoopPaymentGate: Offline/Dev mode pass-through',
    };
  }
}
