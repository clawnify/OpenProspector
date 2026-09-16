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
  EnrichResult,
  InputRequirement,
  LeadInput,
  PendingWaterfall,
  RequirementKey,
  WaterfallResult,
} from "./types";
import { AnymailFinderProvider } from "./anymailfinder";
import { ApolloProvider } from "./apollo";
import { ContactOutProvider } from "./contactout";
import { DatagmaProvider } from "./datagma";
import { DropcontactProvider } from "./dropcontact";
import { FindymailProvider } from "./findymail";
import { ForagerProvider } from "./forager";
import { HunterProvider } from "./hunter";
import { KasprProvider } from "./kaspr";
import { LeadMagicProvider } from "./leadmagic";
import { PeopleDataLabsProvider } from "./peopledatalabs";
import { ProspeoProvider } from "./prospeo";
import { RocketReachProvider } from "./rocketreach";
import { SkrappProvider } from "./skrapp";
import { SnovProvider } from "./snov";
import { SurfeProvider } from "./surfe";
import { TombaProvider } from "./tomba";
import { WizaProvider } from "./wiza";
import { ZeliqProvider } from "./zeliq";

/**
 * Every known adapter. Registry order is only the *default* — users reorder
 * their waterfall per field in settings, because the cheapest-first ordering
 * that suits one ICP is the wrong one for another.
 */
export const REGISTRY: readonly EnrichProvider[] = [
  FindymailProvider,
  LeadMagicProvider,
  AnymailFinderProvider,
  HunterProvider,
  SkrappProvider,
  TombaProvider,
  DatagmaProvider,
  ProspeoProvider,
  WizaProvider,
  ApolloProvider,
  PeopleDataLabsProvider,
  ContactOutProvider,
  ForagerProvider,
  SnovProvider,
  SurfeProvider,
  RocketReachProvider,
  KasprProvider,
  DropcontactProvider,
  ZeliqProvider,
];

/**
 * Default waterfall order per field, used until the user reorders it.
 *
 * Not the registry's array order, because the two fields want different
 * sequences: phone credits cost multiples of an email at every vendor, so the
 * phone waterfall runs deeper before giving up and leads with the vendors whose
 * phone coverage is their actual product. Ids absent from a field's list are
 * still selectable in the UI — this is only what a fresh install starts with.
 */
export const DEFAULT_ORDER: Record<EnrichField, readonly string[]> = {
  // Cheapest-and-most-verified first. Findymail and LeadMagic both return only
  // addresses they have already validated, so a hit there ends the waterfall at
  // one credit. Prospeo is next because it too can be told to return verified
  // addresses only. People Data Labs sits late: it never asserts deliverability,
  // so its answer is a fallback rather than a stop.
  // Forager and Bytemine trail: both can only resolve an email from a LinkedIn
  // URL, so for a lead sourced without one they are a guaranteed skip.
  // Anymail Finder, Hunter, Skrapp, Tomba and Datagma sit high for one shared
  // reason: each of them bills only when it actually returns an address, so an
  // attempt that misses is free. A vendor that costs nothing to try belongs
  // ahead of one that charges whether or not it resolves.
  // Apollo sits behind them because it charges on a match even when the address
  // it hands back is a "guessed" one, and ahead of People Data Labs because it
  // at least grades deliverability, which PDL never asserts at all.
  // Snov, Surfe and Dropcontact join the free-to-miss group: each bills only on
  // an address returned. Dropcontact is last of them because it answers by
  // callback, so a lead reaching it waits instead of moving on — a pause worth
  // taking only after the in-band vendors have had their turn. RocketReach
  // grades by SMTP but charges a premium-priced credit, so it trails the
  // one-credit finders. Kaspr and Zeliq close: Kaspr never grades an address
  // and keys on a profile URL alone; Zeliq is callback-only for both fields.
  email: [
    "findymail",
    "leadmagic",
    "anymailfinder",
    "hunter",
    "skrapp",
    "tomba",
    "datagma",
    "snov",
    "surfe",
    "prospeo",
    "wiza",
    "rocketreach",
    "apollo",
    "peopledatalabs",
    "contactout",
    "forager",
    "dropcontact",
    "kaspr",
    "zeliq",
  ],
  // Phone runs deeper, and leads with the vendors whose mobile coverage is the
  // product rather than a side line. Prospeo is last of the finders because a
  // mobile there is 10 credits against 1–5 elsewhere.
  // Datagma goes in behind the single-credit finders and ahead of the ones that
  // price a mobile at five or more, because mobile coverage is its product
  // rather than a side line — and because it reports its own `creditBurn` per
  // call, so its real cost lands in the ledger instead of an assumption.
  // Surfe, RocketReach and Kaspr take one credit for a mobile and go in with the
  // single-credit finders. Apollo and Zeliq are last: both deliver a phone by
  // webhook only, so each is a pause, and Apollo's mobile is eight credits.
  phone: [
    "forager",
    "peopledatalabs",
    "datagma",
    "surfe",
    "rocketreach",
    "kaspr",
    "leadmagic",
    "wiza",
    "contactout",
    "prospeo",
    "apollo",
    "zeliq",
  ],
};

/** The shipping default for one field, filtered to adapters that can serve it. */
export function defaultOrder(field: EnrichField): string[] {
  const known = new Set(providersForField(field).map((p) => p.id));
  const ordered = DEFAULT_ORDER[field].filter((id) => known.has(id));
  // Anything in the registry the map forgot still runs, just last — a new
  // adapter is never silently unreachable because someone missed a line here.
  return [...ordered, ...[...known].filter((id) => !ordered.includes(id))];
}

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
  /**
   * Public URL for this lookup's callback, handed to deferred vendors. One per
   * call: the token in it is what maps the vendor's POST back to this lead and
   * field. Without it a deferred vendor cannot be called, and is skipped as an
   * `error` that says so rather than as a silent miss.
   */
  callbackUrl?: string;
  /**
   * Continue a paused waterfall. The cache is not re-read (it was checked
   * before the pause), `startAt` is the index in `order` to continue from, and
   * the carried credits and fallback are folded into the result. Attempts
   * before the pause were already written to the ledger by the caller, so the
   * result's `attempts` holds only what happened since.
   */
  resume?: {
    startAt: number;
    totalCredits: number;
    fallback: { value: string; providerId: string } | null;
  };
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

/** One requirement key satisfied? `fullName` also accepts first + last parts. */
function hasKey(input: LeadInput, key: RequirementKey): boolean {
  if (key === "fullName") return Boolean(input.fullName || (input.firstName && input.lastName));
  return Boolean(input[key]);
}

function meetsRequirements(provider: EnrichProvider, field: EnrichField, input: LeadInput): boolean {
  return provider.requirements(field).every((req) =>
    Array.isArray(req) ? req.some((k) => hasKey(input, k)) : hasKey(input, req as RequirementKey),
  );
}

/** "linkedinUrl or email, fullName" — the attempt-log reason for an `ineligible`. */
export function describeRequirements(req: InputRequirement): string {
  return req.map((r) => (Array.isArray(r) ? r.join(" or ") : String(r))).join(", ");
}

/** Fill in `fullName` from parts so adapters never have to reassemble it. */
function normalize(input: LeadInput): LeadInput {
  const fullName = input.fullName?.trim() || [input.firstName, input.lastName].filter(Boolean).join(" ").trim();
  const domain = input.domain?.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0];
  const email = input.email?.trim().toLowerCase();
  return { ...input, fullName: fullName || undefined, domain: domain || undefined, email: email || undefined };
}

/**
 * Run one field's waterfall for one lead.
 *
 * Never throws: every failure mode becomes an attempt row, so a dead vendor
 * degrades the run instead of failing the batch.
 *
 * Returns early with `pending` when it reaches a deferred vendor: the caller
 * persists that state, and calls again with `resume` once the vendor's answer
 * arrives — `applyDeferredResult` folds that answer in before the next step.
 */
export async function runWaterfall(
  field: EnrichField,
  rawInput: LeadInput,
  env: ConnectionsEnv,
  opts: WaterfallOptions,
): Promise<WaterfallResult> {
  const input = normalize(rawInput);
  const attempts: EnrichAttempt[] = [];

  if (!opts.resume && !opts.refresh && opts.cache) {
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

  let fallback: { value: string; providerId: string } | null = opts.resume?.fallback ?? null;
  let totalCredits = opts.resume?.totalCredits ?? 0;
  const registry = opts.registry ?? REGISTRY;

  for (let position = opts.resume?.startAt ?? 0; position < opts.order.length; position++) {
    const id = opts.order[position];
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
      const needs = describeRequirements(provider.requirements(field));
      attempts.push({ providerId: id, field, outcome: "ineligible", creditsUsed: 0, ms: 0, detail: `Needs ${needs}` });
      continue;
    }
    const deferred = provider.deferred?.includes(field) ?? false;
    if (deferred && !opts.callbackUrl) {
      attempts.push({ providerId: id, field, outcome: "error", creditsUsed: 0, ms: 0, detail: `${provider.label} answers by callback, and this deployment has no public callback URL` });
      continue;
    }

    const started = Date.now();
    let result: EnrichResult;
    try {
      result = await provider.find(field, input, apiKey, { callbackUrl: opts.callbackUrl });
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

    // A vendor can answer `hit` and carry nothing — settle() below refuses to
    // use it, but the row above already called it a hit, so the user sees a
    // charge against a success that produced no value. Name it instead.
    if (result.outcome === "hit" && !result.value) {
      attempts[attempts.length - 1] = {
        ...attempts[attempts.length - 1],
        outcome: "unmapped",
        detail: `${provider.label} returned a ${field} hit with no value — the adapter's response mapping is probably out of date`,
      };
      continue;
    }

    if (result.outcome === "pending") {
      // Only a vendor declared deferred may pause the search — anything else
      // answering `pending` is a bug in the adapter, and treating it as a pause
      // would park the lead waiting for a callback that never comes.
      if (!deferred) {
        attempts[attempts.length - 1] = { ...attempts[attempts.length - 1], outcome: "error", detail: `${provider.label} returned pending but is not a deferred provider` };
        continue;
      }
      const pending: PendingWaterfall = { providerId: id, requestId: result.requestId ?? "", position, totalCredits, fallback };
      return { field, value: null, verified: false, providerId: null, cached: false, totalCredits, attempts, pending };
    }

    const settled = settle(result, id, fallback);
    if (settled.done) {
      await opts.cache?.put(field, input, settled.hit);
      return { field, ...settled.hit, cached: false, totalCredits, attempts };
    }
    fallback = settled.fallback;
  }

  if (fallback) {
    // Deliberately not cached — an unverified value should be re-attempted on a
    // later run, when a better-configured waterfall might verify it.
    return { field, value: fallback.value, verified: false, providerId: fallback.providerId, cached: false, totalCredits, attempts };
  }

  return { field, value: null, verified: false, providerId: null, cached: false, totalCredits, attempts };
}

/**
 * The house rule, in one place: a verified hit ends the search; an unverified
 * one is remembered as the first fallback; anything else changes nothing.
 */
function settle(
  result: EnrichResult,
  providerId: string,
  fallback: { value: string; providerId: string } | null,
):
  | { done: true; hit: { value: string; verified: true; providerId: string } }
  | { done: false; fallback: { value: string; providerId: string } | null } {
  if (result.outcome === "hit" && result.value) {
    if (result.verified) return { done: true, hit: { value: result.value, verified: true, providerId } };
    return { done: false, fallback: fallback ?? { value: result.value, providerId } };
  }
  return { done: false, fallback };
}

/**
 * Fold a deferred vendor's delivered answer into a paused waterfall, then
 * continue it from the next provider.
 *
 * The answer is treated exactly as if the vendor had returned it in-band: a
 * verified hit ends the search and is cached, an unverified one becomes the
 * fallback, and a miss or error moves on. The attempt for the answer itself is
 * the first entry of the returned `attempts`, so the caller records it with
 * the rest.
 */
export async function applyDeferredResult(
  field: EnrichField,
  rawInput: LeadInput,
  env: ConnectionsEnv,
  paused: PendingWaterfall,
  answer: EnrichResult,
  opts: Omit<WaterfallOptions, "resume" | "refresh">,
): Promise<WaterfallResult> {
  const input = normalize(rawInput);
  const totalCredits = paused.totalCredits + answer.creditsUsed;
  const attempt: EnrichAttempt = {
    providerId: paused.providerId,
    field,
    outcome: answer.outcome === "pending" ? "error" : answer.outcome,
    creditsUsed: answer.creditsUsed,
    ms: 0,
    detail: answer.detail,
  };

  const settled = settle(answer, paused.providerId, paused.fallback);
  if (settled.done) {
    await opts.cache?.put(field, input, settled.hit);
    return { field, ...settled.hit, cached: false, totalCredits, attempts: [attempt] };
  }

  const rest = await runWaterfall(field, input, env, {
    ...opts,
    resume: { startAt: paused.position + 1, totalCredits, fallback: settled.fallback },
  });
  return { ...rest, attempts: [attempt, ...rest.attempts] };
}
