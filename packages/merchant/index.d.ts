/// <reference types="node" />

/** Money in paise. Accepts whatever you hold it as; always signed as a decimal string. */
export type Paise = bigint | string | number;

export interface KeyPair {
    publicKey: Buffer;
    privateKey: Buffer;
}

export interface Intent {
    intent_id: string;
    type: string;
    mandate_id: string;
    quote_id: string;
    merchant_id: string;
    amount_paise: Paise;
    basket_hash: string;
    rationale: string;
    nonce: string;
    expires_at: string;
}

export interface Quote {
    quote_id: string;
    mandate_id: string;
    merchant_id: string;
    amount_paise: Paise;
    basket_hash: string;
    categories?: readonly string[];
    issued_at?: string;
    expires_at?: string;
    nonce?: string;
}

export interface SignedQuote {
    quote: Quote;
    signature: string;
    kid?: string;
}

/** What the kernel answers a checkout with. Verified against the running kernel. */
export interface Decision {
    verdict: "ALLOW" | "DENY" | "STEP_UP";
    reason_code: string;
    intent_id: string;
    /** Present on STEP_UP: the challenge the shopper must clear. */
    challenge_id: string | null;
    /** Present on STEP_UP: where to send the shopper to approve. */
    approval_url: string | null;
    /** The public record of this decision, readable without a credential. */
    audit_url: string;
    /** Where the shopper completes payment when no instrument is attached. */
    pay_url: string;
}

/** A quote as the kernel returns it: the quote, the key that signed it, the signature. */
export interface SignedQuoteResponse {
    quote: Quote;
    kid: string;
    signature: string;
}

export interface AgentKitOptions {
    /** Base URL of the merchant's kernel, without a trailing slash. */
    baseUrl: string;
    /** Agent-door credential. Sent as x-agentkit-key. Safe to give an agent. */
    apiKey?: string | null;
    /** Merchant-door secret. Sent as x-agentkit-token and used to sign authorization tokens. Never give this to an agent. */
    fulfilToken?: string | null;
    timeoutMs?: number;
    fetch?: typeof globalThis.fetch;
}

export interface MerchantSession {
    id: string;
    name?: string;
}

export interface MerchantAddress {
    id: string;
    /** One line, shown to the shopper on the consent screen so they can catch a wrong binding. */
    line: string;
    label?: string;
}

/** All four are required by the kernel. Amounts are decimal strings of integer paise. */
export interface ConsentLimits {
    per_transaction_paise: string;
    cumulative_paise: string;
    /** Above this, a purchase needs the shopper to approve it rather than passing silently. */
    silent_threshold_paise: string;
    velocity_per_hour: number;
}

/** All three are required by the kernel. */
export interface ConsentScope {
    merchants: readonly string[];
    categories: readonly string[];
    currency: "INR";
}

/** Raised when the transport failed. Not a decision. */
export class AgentKitError extends Error {
    status: number | null;
    reasonCode: string | null;
    body: unknown;
}

/** Raised when the kernel refused. `reasonCode` is the value to branch on. */
export class AgentKitRefusal extends AgentKitError {
    reasonCode: string;
}

export class Agent {
    readonly agentId: string;
    signIntent(intent: Intent): string;
    checkout(options: {
        mandateId: string;
        signedQuote: SignedQuote;
        rationale?: string;
        intentTtlMs?: number;
    }): Promise<Decision>;
}

export class AgentKit {
    constructor(options: AgentKitOptions);
    static generateKeyPair(): KeyPair;

    request(method: string, path: string, options?: {
        body?: unknown;
        door?: "agent" | "merchant";
        headers?: Record<string, string>;
    }): Promise<unknown>;

    registerAgent(options: { name: string; publicKey: Buffer | string }): Promise<{ agentId: string }>;
    agent(options: { agentId: string; privateKey: Buffer | string }): Agent;

    quote(options: { mandateId: string; items: unknown }): Promise<SignedQuoteResponse>;
    verifyQuote(signedQuote: SignedQuote, publicKey: Buffer | string): boolean;

    searchCatalog(options: { mandateId: string; query: string }): Promise<{ items: { sku: string; name: string; price_paise: string; in_scope: boolean }[] }>;
    catalogItem(sku: string): Promise<unknown>;
    mandate(mandateId: string): Promise<unknown>;
    orderStatus(body: unknown): Promise<unknown>;
    orderHistory(body: unknown): Promise<unknown>;
    cancelOrder(body: unknown): Promise<unknown>;
    reorder(body: unknown): Promise<unknown>;
    audit(intentId: string): Promise<AuditRecord>;
    tools(): Promise<unknown>;

    requestConsent(options: {
        agentId: string;
        contact: string;
        requestedScope: ConsentScope;
        limits: ConsentLimits;
        customerRef?: string;
        fulfilmentRef?: string;
    }): Promise<{ request_ref: string; consent_url?: string; [key: string]: unknown }>;
    consentStatus(requestRef: string): Promise<unknown>;
    bindConsent(requestRef: string, refs: { customerRef: string; fulfilmentRef: string }): Promise<{ bound: boolean }>;
    authorizationToken(options: {
        requestRef: string;
        customerRef: string;
        fulfilmentRef: string;
        displayName?: string;
        displayAddress?: string;
        ttlMs?: number;
    }): string;

    routes(options: {
        /** Returns the signed-in shopper, or null. Never reads the request body. */
        session: (req: unknown) => MerchantSession | null | Promise<MerchantSession | null>;
        /** Returns the addresses that shopper may ship to. */
        addresses: (userId: string) => MerchantAddress[] | Promise<MerchantAddress[]>;
        /** Public URL of the kernel, used to build the consent redirect. Defaults to baseUrl. */
        kernelUrl?: string;
        /** Path this middleware answers on. Defaults to "/authorize". */
        path?: string;
    }): (req: any, res: any, next?: () => void) => Promise<void>;

    verify(options?: {
        /** Returns a prior order for this intent, or null. Without it, retries are let through. */
        lookup?: (intentId: string) => unknown | Promise<unknown>;
        /** Shapes the answer when lookup found one. Defaults to { order_id, deduplicated }. */
        present?: (existing: any) => unknown | Promise<unknown>;
    }): (req: any, res: any, next: () => void) => Promise<void>;

    consentUrl(requestRef: string, token: string): string;

    manifest(): Promise<unknown>;
    health(): Promise<unknown>;
}

/** A fulfilment call, parsed. Placed on req.agentOrder by verify(). */
export interface AgentOrder {
    intentId: string;
    customerRef: string | null;
    fulfilmentRef: string | null;
    items: { sku: string; quantity: number }[];
    /** A decimal string of integer paise. Never a number: paise are BIGINT. */
    amountPaise: string | null;
    paymentId: string | null;
    auditUrl: string | null;
}

/** One entry in an intent's ledger chain. */
export interface AuditEntry {
    kind: string;
    seq: number;
    /** Hex. Each entry commits to the one before it. */
    hash: string;
    prev_hash: string;
    at: string;
    detail: unknown;
}

export interface AuditRecord {
    intent_id: string;
    entries: AuditEntry[];
    /** False if any entry does not commit to its predecessor. */
    chain_intact: boolean;
}

export function generateKeyPair(): KeyPair;
export function signPayload(privateKey: Buffer | string, payload: unknown): Buffer;
export function verifyPayload(publicKey: Buffer | string, payload: unknown, signature: Buffer | string): boolean;
export function canonicalise(value: unknown): string;
export function canonicalBytes(value: unknown): Buffer;
export function intentSigningPayload(intent: Intent): Record<string, unknown>;
export function quoteSigningPayload(quote: Quote): Record<string, unknown>;
export function paiseToCanonical(value: Paise): string;
