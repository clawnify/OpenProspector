// Provider registry + waterfall runner.
//
// The runner owns everything that is not a vendor HTTP call: ordering, key
// resolution, eligibility, the local cache, and the cost ledger. Adapters stay
// dumb request/response wrappers, so adding a vendor is one file plus one line
// in REGISTRY.
//
// House rule, matching what buyers actually want from a waterfall: the first
// *verified* result wins. An unverified value is held as a fallback but does
// not stop the search, so we never hand back an address we could not validate.

import { secret, type ConnectionsEnv } from "@clawnify/connections";
import type {
  EnrichAttempt,
  EnrichField,
  EnrichProvider,
  LeadInput,
  WaterfallResult,
} from "./types";
import { FindymailProvider } from "./findymail";

/**
 * Every known adapter. Registry order is only the *default* — users reorder
 * their waterfall per field in settings, because the cheapest-first ordering
 * that suits one ICP is the wrong one for another.
 */
export const REGISTRY: readonly EnrichProvider[] = [FindymailProvider];

export function providerById(id: string): EnrichProvider | undefined {
  return REGISTRY.find((p) => p.id === id);
}

/** Adapters that can resolve `field` at all, regardless of configuration. */
export function providersForField(field: EnrichField): EnrichProvider[] {
  return REGISTRY.filter((p) => p.fields.includes(field));
}

/**
 * Read-through cache for resolved values, keyed by the runner on the normalized
 * lead identity. Injected rather than imported so the runner has no D1 coupling
 * and stays unit-testable.
 */
export interface EnrichCache {
  /**
   * `maxAgeDays` is passed by the runner, not chosen by the implementation, so a
   * cache cannot silently forget to expire. Entries older than it must be
   * treated as a miss — see CACHE_MAX_AGE_DAYS for why this is not optional.
   */
  get(
    field: EnrichField,
    input: LeadInput,
    maxAgeDays: number,
  ): Promise<{ value: string; verified: boolean; providerId: string } | null>;
  put(
    field: EnrichField,
    input: LeadInput,
    hit: { value: string; verified: boolean; providerId: string },
  ): Promise<void>;
}

/**
 * Contact data decays: people change jobs, and a work email dies with the role.
 * An unbounded cache would therefore optimise the one metric this product is
 * judged on — bounce rate — straight into the ground, serving a confidently
 * "verified" address that stopped existing months ago. Capping the age also
 * keeps us from retaining personal data indefinitely for no stated purpose.
 *
 * 90 days is the default trade: long enough that a re-run of the same list
 * costs nothing, short enough that a job change surfaces within a quarter.
 */
export const CACHE_MAX_AGE_DAYS = 90;

export interface WaterfallOptions {
  /**
   * Provider ids in the order the user configured. Unknown ids are ignored;
   * known providers missing from the list are not called at all.
   */
  order: string[];
  cache?: EnrichCache;
  /** Skip the cache read (a deliberate "re-check this lead" from the UI). */
  refresh?: boolean;
  /** Override the staleness cap. Defaults to CACHE_MAX_AGE_DAYS. */
  maxCacheAgeDays?: number;
  /**
   * Adapter set to resolve `order` against. Defaults to the real registry;
   * overridden by tests so the ordering/eligibility/cache logic — the part that
   * decides whether a user's credits get spent — can be exercised without
   * touching a vendor.
   */
  registry?: readonly EnrichProvider[];
}

/**
 * Normalized cache identity for a lead. Domain and name are the only inputs that
 * meaningfully determine a work email or direct dial; including anything else
 * would fragment the cache and quietly cost the user real credits.
 */
export function cacheKey(field: EnrichField, input: LeadInput): string {
  const name = (input.fullName ?? `${input.firstName ?? ""} ${input.lastName ?? ""}`).trim().toLowerCase();
  const domain = (input.domain ?? "").trim().toLowerCase().replace(/^www\./, "");
  return `${field}|${name}|${domain}`;
}

function meetsRequirements(provider: EnrichProvider, field: EnrichField, input: LeadInput): boolean {
  return provider.requirements(field).every((key) => {
    if (key === "fullName") {
      return Boolean(input.fullName || (input.firstName && input.lastName));
    }
    return Boolean(input[key]);
  });
}

/** Fill in `fullName` from parts so adapters never have to reassemble it. */
function normalize(input: LeadInput): LeadInput {
  const fullName = input.fullName?.trim() || [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  const domain = input.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  return { ...input, fullName: fullName || undefined, domain: domain || undefined };
}

/**
 * Run one field's waterfall for one lead.
 *
 * Never throws: every failure mode becomes an attempt row, so a dead vendor
 * degrades the run instead of failing the batch.
 */
export async function runWaterfall(
  field: EnrichField,
  rawInput: LeadInput,
  env: ConnectionsEnv,
  opts: WaterfallOptions,
): Promise<WaterfallResult> {
  const input = normalize(rawInput);
  const attempts: EnrichAttempt[] = [];

  if (!opts.refresh && opts.cache) {
    const cached = await opts.cache.get(field, input, opts.maxCacheAgeDays ?? CACHE_MAX_AGE_DAYS);
    if (cached) {
      return {
        field,
        value: cached.value,
        verified: cached.verified,
        providerId: cached.providerId,
        cached: true,
        totalCredits: 0,
        attempts,
      };
    }
  }

  let fallback: { value: string; providerId: string } | null = null;
  let totalCredits = 0;
  const registry = opts.registry ?? REGISTRY;

  for (const id of opts.order) {
    const provider = registry.find((p) => p.id === id);
    if (!provider || !provider.fields.includes(field)) continue;

    // Skips are recorded, not hidden: "LeadMagic would have run here but has no
    // key" is exactly the diagnostic a user needs when coverage looks bad.
    const apiKey = secret(provider.secretName, env);
    if (!apiKey) {
      attempts.push({ providerId: id, field, outcome: "unconfigured", creditsUsed: 0, ms: 0, detail: `No ${provider.secretName} configured` });
      continue;
    }
    if (!meetsRequirements(provider, field, input)) {
      const needs = provider.requirements(field).join(", ");
      attempts.push({ providerId: id, field, outcome: "ineligible", creditsUsed: 0, ms: 0, detail: `Needs ${needs}` });
      continue;
    }

    const started = Date.now();
    let result;
    try {
      result = await provider.find(field, input, apiKey);
    } catch (err) {
      // Adapters are contracted not to throw; this is the backstop so one
      // misbehaving vendor cannot take down a 5k-row batch.
      result = {
        outcome: "error" as const,
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: err instanceof Error ? err.message : "Unknown provider error",
      };
    }
    const ms = Date.now() - started;

    totalCredits += result.creditsUsed;
    attempts.push({ providerId: id, field, outcome: result.outcome, creditsUsed: result.creditsUsed, ms, detail: result.detail });

    if (result.outcome === "hit" && result.value) {
      if (result.verified) {
        const hit = { value: result.value, verified: true, providerId: id };
        await opts.cache?.put(field, input, hit);
        return { field, ...hit, cached: false, totalCredits, attempts };
      }
      // Unverified: remember the first one, keep looking for something better.
      fallback ??= { value: result.value, providerId: id };
    }
  }

  if (fallback) {
    // Deliberately not cached — an unverified value should be re-attempted on a
    // later run, when a better-configured waterfall might verify it.
    return { field, value: fallback.value, verified: false, providerId: fallback.providerId, cached: false, totalCredits, attempts };
  }

  return { field, value: null, verified: false, providerId: null, cached: false, totalCredits, attempts };
}
