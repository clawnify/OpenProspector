// Normalized, vendor-agnostic enrichment shapes. Every provider (Findymail,
// LeadMagic, Prospeo, …) maps its raw API response into these so the waterfall
// runner, the table, and the JSON API never have to care which vendor a value
// came from — and so adding a vendor is one file, not a refactor.

/** What a waterfall resolves. One waterfall per field, each independently ordered. */
export type EnrichField = "email" | "phone";

/** Everything we might know about a lead before enrichment. */
export interface LeadInput {
  fullName?: string;
  firstName?: string;
  lastName?: string;
  /** Company website domain, bare (`acme.com`) — the highest-signal input. */
  domain?: string;
  company?: string;
  linkedinUrl?: string;
  /**
   * Work email, when we already have one. Not just an output: most phone
   * vendors key off an email or a profile URL rather than name + domain, so the
   * email waterfall's result is fed into the phone waterfall as an input. See
   * FIELDS in the server for the ordering that guarantees it.
   */
  email?: string;
}

/**
 * Which LeadInput keys a provider needs before it's worth calling.
 *
 * A bare key is required. A nested array is an *alternative* group — at least
 * one of its keys must be present. `[["linkedinUrl", "email"], "fullName"]`
 * therefore reads "a profile URL or an email, plus a name". Vendors genuinely
 * accept alternative identifiers, and an AND-only list would force every such
 * adapter to either understate its needs (and burn a call it cannot serve) or
 * overstate them (and never run).
 */
export type RequirementKey = keyof LeadInput;
export type InputRequirement = readonly (RequirementKey | readonly RequirementKey[])[];

export type AttemptOutcome =
  /** Provider returned a usable value. */
  | "hit"
  /** Provider ran but has no record for this lead. Normal; move to the next. */
  | "miss"
  /** Caller lacks the inputs this provider needs. Skipped without spending. */
  | "ineligible"
  /** No API key configured for this provider. Skipped without spending. */
  | "unconfigured"
  /** Out of credits at the vendor. Surfaced to the user, not silently swallowed. */
  | "no_credits"
  /** Transport/HTTP/parse failure. Waterfall continues to the next provider. */
  | "error";

/** One provider's answer for one lead and one field. */
export interface EnrichResult {
  outcome: AttemptOutcome;
  value: string | null;
  /**
   * Whether the vendor asserts this value is deliverable/connected. The runner
   * only stops the waterfall on a verified hit — an unverified value is kept as
   * a fallback but does not end the search.
   */
  verified: boolean;
  /** Vendor credits consumed. 0 for skips and most misses; used for the cost ledger. */
  creditsUsed: number;
  /** Human-readable reason, shown in the attempt log when outcome is not "hit". */
  detail?: string;
}

export interface CreditBalance {
  /** Finder credits remaining, or null when the vendor does not report it. */
  remaining: number | null;
  /** Separate verification credit pool, where the vendor keeps one. */
  verifierRemaining?: number | null;
}

/**
 * A vendor adapter. Implementations must be pure request/response wrappers with
 * no app coupling: no D1, no caching, no ordering logic. The runner owns all of
 * that, which is what keeps the registry cheap to extend.
 */
export interface EnrichProvider {
  /** Stable slug, also the attribution value stored on every enriched cell. */
  readonly id: string;
  readonly label: string;
  /** Fields this provider can resolve. */
  readonly fields: readonly EnrichField[];
  /** Secret name resolved via `secret()` — never a literal key in app code. */
  readonly secretName: string;
  /** Vendor pricing page, surfaced in the settings UI next to the key input. */
  readonly signupUrl: string;
  /**
   * Shape of the secret, when it is not just an opaque key — Forager needs an
   * account id alongside its key, so it is stored as `accountId:key`. Surfaced
   * in settings; without it a user has no way to know the value is compound.
   */
  readonly keyFormat?: string;
  /** Minimum inputs needed. The runner skips the provider as "ineligible" otherwise. */
  requirements(field: EnrichField): InputRequirement;
  /** Resolve one field for one lead. Must never throw — map failures to an EnrichResult. */
  find(field: EnrichField, input: LeadInput, apiKey: string): Promise<EnrichResult>;
  /** Standalone verification, used when enriching an imported list that already has values. */
  verify?(value: string, apiKey: string): Promise<EnrichResult>;
  /** Remaining balance for the settings screen. Optional — not every vendor exposes it. */
  credits?(apiKey: string): Promise<CreditBalance>;
}

/** One row of the attempt log — why a lead resolved the way it did, and what it cost. */
export interface EnrichAttempt {
  providerId: string;
  field: EnrichField;
  outcome: AttemptOutcome;
  creditsUsed: number;
  detail?: string;
  /** Milliseconds spent in the vendor call; 0 for skips. */
  ms: number;
}

/** What the runner hands back for one lead and one field. */
export interface WaterfallResult {
  field: EnrichField;
  value: string | null;
  verified: boolean;
  /** Provider that produced `value`, or null when nothing resolved. */
  providerId: string | null;
  /** True when the value came from the local cache and cost nothing. */
  cached: boolean;
  totalCredits: number;
  attempts: EnrichAttempt[];
}
