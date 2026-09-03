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
  | "error"
  /**
   * Provider accepted the lookup but answers out of band, by POSTing to the
   * callback URL it was given. The waterfall pauses at this position and
   * resumes when the callback lands (or its timeout sweep fires); the ledger
   * then gets a second row with the real outcome and cost.
   */
  | "pending";

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
  /** Vendor-side id of a `pending` lookup, so a callback can be matched to it. */
  requestId?: string;
}

/** Per-call context the runner hands an adapter alongside the lead. */
export interface FindContext {
  /**
   * Public URL a deferred vendor must POST its answer to. Unique per paused
   * lookup — the token in it is what the callback route resolves back to the
   * lead and field. Absent when the runner has no reachable origin (local dev),
   * in which case a deferred adapter must return an `error`, never `pending`.
   */
  callbackUrl?: string;
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
  /**
   * Fields this vendor answers only by callback. For those, `find()` returns
   * `pending` and `parseCallback()` maps the delivered payload; any other field
   * resolves in-band as usual (Apollo: email in-band, phone by webhook).
   * Surfaced in the UI because a paused lead looks, to a user, like a slow one.
   */
  readonly deferred?: readonly EnrichField[];
  /** Resolve one field for one lead. Must never throw — map failures to an EnrichResult. */
  find(field: EnrichField, input: LeadInput, apiKey: string, ctx?: FindContext): Promise<EnrichResult>;
  /**
   * Map the body a deferred vendor POSTed to the callback URL onto a result.
   * Never `pending`. Must never throw: an unrecognisable payload is an `error`.
   */
  parseCallback?(field: EnrichField, body: unknown): EnrichResult;
  /** Standalone verification, used when enriching an imported list that already has values. */
  verify?(value: string, apiKey: string): Promise<EnrichResult>;
  /** Remaining balance for the settings screen. Optional — not every vendor exposes it. */
  credits?(apiKey: string): Promise<CreditBalance>;
}

/**
 * What an attempt-log row can be about. Wider than EnrichField because the
 * ledger spans both subjects this app buys: the two person fields, and the
 * company record. One ledger, so "what did this run cost me?" has a single
 * answer rather than one per subject.
 */
export type LedgerField = EnrichField | "company";

/** One row of the attempt log — why a lead resolved the way it did, and what it cost. */
export interface EnrichAttempt {
  providerId: string;
  field: LedgerField;
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
  /**
   * Set when the waterfall paused at a deferred vendor. `value` is null in that
   * case; the fallback found so far travels here so the resume can carry it.
   */
  pending?: PendingWaterfall;
}

/** Where a paused waterfall stopped, and what it had in hand. */
export interface PendingWaterfall {
  providerId: string;
  requestId: string;
  /** Index into `order` of the provider that paused the search. */
  position: number;
  /** Credits spent by this field's waterfall before the pause. */
  totalCredits: number;
  /** Best unverified value seen so far, kept as the eventual fallback. */
  fallback: { value: string; providerId: string } | null;
}

// ── Company enrichment ──────────────────────────────────────────────
//
// A separate provider shape from EnrichProvider, deliberately.
//
// Person enrichment resolves ONE value per call, which is why EnrichProvider is
// keyed on a field and returns a single `value`. A firmographic API resolves a
// whole record in one call: industry, HQ address, ticker and headcount all
// arrive together. Modelling company data as six EnrichFields would therefore
// make the runner spend six credits to fetch what one call already returned —
// the abstraction would cost real money.
//
// What IS shared: the vendor plumbing (vendorFetch, statusOutcome), the outcome
// vocabulary below, the `secret()` key resolution, and the attempt ledger. A
// vendor that serves both classes (People Data Labs, Apollo, Hunter) appears in
// both registries under ONE secretName, so a user enters its key once.

/** Firmographics for one company. Every field optional — vendors differ in coverage. */
export interface CompanyRecord {
  name?: string;
  /** The company *page* URL, never a person's profile. */
  linkedinUrl?: string;
  industry?: string;
  city?: string;
  /** State, province or region, as the vendor reports it. */
  state?: string;
  country?: string;
  postalCode?: string;
  /** Ticker, for listed companies only. Absent is the norm, not a gap. */
  stockSymbol?: string;
  employeeCount?: number;
  foundedYear?: number;
}

/** One company provider's answer for one domain. Never `pending` — no firmographic API is callback-only. */
export interface CompanyResult {
  outcome: Exclude<AttemptOutcome, "pending">;
  data: CompanyRecord | null;
  creditsUsed: number;
  detail?: string;
}

/**
 * A firmographic vendor adapter. Same contract as EnrichProvider: a pure
 * request/response wrapper that must never throw, with no caching, ordering or
 * database coupling — the runner owns all of it.
 */
export interface CompanyProvider {
  readonly id: string;
  readonly label: string;
  /**
   * Reuses the person-side secret name where the vendor is the same company, so
   * one key unlocks both classes and the settings screen lists the vendor once.
   */
  readonly secretName: string;
  readonly signupUrl: string;
  /** Shape of a compound secret, as on EnrichProvider (Tomba's `key:secret`). */
  readonly keyFormat?: string;
  /**
   * Which CompanyRecord fields this vendor's schema can return *at all*,
   * transcribed from its published response — not what it happens to fill for
   * one company.
   *
   * Required rather than optional, because the runner uses it to decide whether
   * calling this vendor can add anything the record is still missing. A vendor
   * that overstates its coverage costs the user a credit for nothing; one that
   * understates it is never called. Both are worse than the small cost of
   * writing the list out, and an optional field would silently default a new
   * adapter into one of the two.
   *
   * Firmographic coverage is genuinely uneven — Findymail returns six fields and
   * no ticker, Surfe returns a ticker but no city — which is exactly why the
   * runner cannot treat one vendor's answer as the whole record.
   */
  readonly covers: readonly (keyof CompanyRecord)[];
  /**
   * Resolve one company from its bare domain. The runner normalizes the domain
   * before calling, so adapters receive `acme.com`, never `https://www.acme.com/`.
   */
  enrich(domain: string, apiKey: string): Promise<CompanyResult>;
}
