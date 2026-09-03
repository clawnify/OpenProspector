// Company (firmographic) registry + waterfall runner.
//
// The sibling of index.ts, for the other subject this app resolves. It is a
// separate runner rather than more fields on the person waterfall because the
// two have genuinely different economics: a person waterfall buys ONE value per
// call, so a field is the right unit; a firmographic API returns the whole
// record — industry, HQ address, ticker, headcount — for one credit. Modelling
// those as six EnrichFields would make the abstraction itself cost five extra
// credits per company. See the note on CompanyProvider in types.ts.
//
// House rule, and the one place it differs from the person runner: there is no
// `verified` concept for firmographics — no vendor grades an industry the way
// an email finder grades deliverability — so the runner fills GAPS instead of
// racing to a first verified hit. Each vendor's answer is merged into one
// record, earliest-in-order winning per field, and the search stops as soon as
// COMPANY_ESSENTIAL is complete.
//
// This reverses an earlier "first hit wins outright", whose stated objection was
// that merging "would multiply the cost of every company by the number of
// vendors configured". That objection held while the registry was three vendors
// with near-identical coverage. It does not survive the full registry: coverage
// is uneven by an order of magnitude — Findymail returns no ticker and no
// postal code, Surfe returns a ticker but no city, Snov returns neither a
// LinkedIn page nor a country — so first-hit-wins hands the record to whichever
// vendor happens to sit highest in the user's order, and the store then trusts
// that half-empty row for six months.
//
// The cost objection is answered by bounding the search rather than by
// abandoning the merge, in two ways that both live in the loop below: the run
// stops the moment the four essential fields are filled (so one full-coverage
// key still costs exactly one call), and a vendor whose entire documented
// `covers` set is already filled is skipped without being called at all.

import { secret, type ConnectionsEnv } from "@clawnify/connections";
import type { CompanyProvider, CompanyRecord, EnrichAttempt } from "./types";
import { ApolloCompanyProvider } from "./apollo";
import { HunterCompanyProvider } from "./hunter";
import { PeopleDataLabsCompanyProvider } from "./peopledatalabs";

/**
 * Every known company adapter. As with REGISTRY, order here is only the
 * shipping default — see COMPANY_DEFAULT_ORDER for the waterfall.
 */
export const COMPANY_REGISTRY: readonly CompanyProvider[] = [
  ApolloCompanyProvider,
  HunterCompanyProvider,
  PeopleDataLabsCompanyProvider,
];

/**
 * Default company waterfall.
 *
 * Ordered so a user pays nothing new before they pay anything at all: every
 * vendor that already serves the person waterfall comes first, because its key
 * is already in the settings screen and its plan already bought. A dedicated
 * firmographic vendor is only worth reaching for when those miss.
 */
export const COMPANY_DEFAULT_ORDER: readonly string[] = [
  // Apollo first for one reason that outranks coverage: its key works on the
  // free plan, so it is the only vendor here a user can turn on without buying
  // anything. It also fills every column the LinkedIn upload asks for,
  // including the ticker.
  "apollo-company",
  // Hunter next. Its `category.industry` and `geo.*` are the cleanest
  // structured location of the three, and a user running the email waterfall
  // very likely already holds the key.
  "hunter-company",
  // People Data Labs last of the three. Not because it is worse — its coverage
  // is the deepest — but because it bills per match on a plan with a monthly
  // floor, while the two above are already paid for by anyone running the
  // person waterfall. Cheapest-already-owned first, same doctrine as email.
  "peopledatalabs-company",
];

/**
 * How long a stored company row is trusted before it is re-bought.
 *
 * Deliberately double the 90 days CACHE_MAX_AGE_DAYS gives a contact. The two
 * decay at different rates and for different reasons: a work email dies the day
 * its owner changes job, which is a matter of weeks across any real list, while
 * a company's HQ city, industry and ticker are stable for years. Re-buying them
 * quarterly would spend credits to write identical rows.
 *
 * Not unbounded, because the things that DO change a company record — an
 * acquisition, a rebrand, an HQ move — change it completely, and a stale row
 * would keep an audience pointed at a company that no longer exists under that
 * name. Six months is the trade.
 */
export const COMPANY_CACHE_MAX_AGE_DAYS = 180;

/**
 * The shipping default order, filtered to adapters that exist. Mirrors
 * defaultOrder() on the person side, including its safety net: an adapter the
 * order map forgot still runs, just last, so a new vendor is never silently
 * unreachable because someone missed a line.
 */
export function companyDefaultOrder(): string[] {
  const known = new Set(COMPANY_REGISTRY.map((p) => p.id));
  const ordered = COMPANY_DEFAULT_ORDER.filter((id) => known.has(id));
  return [...ordered, ...[...known].filter((id) => !ordered.includes(id))];
}

/** One company adapter by id. */
export function companyProviderById(id: string): CompanyProvider | undefined {
  return COMPANY_REGISTRY.find((p) => p.id === id);
}

/**
 * Read-through store for company rows. Injected rather than imported, exactly
 * as EnrichCache is, so the runner carries no D1 coupling and the ordering and
 * spend logic stay unit-testable without a database.
 */
export interface CompanyStore {
  /** `maxAgeDays` is passed by the runner so a store cannot forget to expire. */
  get(domain: string, maxAgeDays: number): Promise<CompanyRecord | null>;
  put(domain: string, record: CompanyRecord, providerId: string): Promise<void>;
}

export interface CompanyWaterfallOptions {
  /** Provider ids in the user's configured order. Unknown ids are ignored. */
  order: readonly string[];
  store?: CompanyStore;
  /** Skip the store read — a deliberate "re-check this company". */
  refresh?: boolean;
  maxCacheAgeDays?: number;
  /** Adapter set to resolve `order` against; overridden by tests. */
  registry?: readonly CompanyProvider[];
}

export interface CompanyWaterfallResult {
  domain: string;
  data: CompanyRecord | null;
  /**
   * Every vendor that filled at least one cell, joined with `+` in the order
   * they contributed (`"apollo-company+findymail-company"`). One vendor is the
   * common case and reads as a bare id; attributing a merged row to a single
   * vendor would be a lie, and the attempt ledger holds the per-call detail.
   * Null only when nothing was resolved, and absent for a store read.
   */
  providerId: string | null;
  cached: boolean;
  totalCredits: number;
  /**
   * Ledger rows, in the same shape the person waterfall writes. `field` is
   * "company" so one attempt log answers "what did this run cost me?" across
   * both subjects rather than splitting the ledger in two.
   */
  attempts: EnrichAttempt[];
}

/**
 * Bare, lowercased, no `www.`, no scheme, no path. The single normalization
 * used by the runner, the store key, and the export's join — they must agree,
 * or a company enriched under one spelling is invisible under the other.
 *
 * Returns null for anything that is not a resolvable hostname, so a lead
 * carrying a company name but no website is skipped rather than sent to a
 * vendor as a domain it cannot match.
 */
export function normalizeDomain(raw: string | undefined | null): string | null {
  const trimmed = String(raw ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  const host = trimmed
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("@")
    .pop() as string;
  // Must look like a hostname with a TLD. Guards against a company *name*
  // landing here ("Acme Studio") and being spent on as if it were a domain.
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** True when a record carries anything worth storing. */
function hasAnyField(r: CompanyRecord | null): r is CompanyRecord {
  return Boolean(r && Object.values(r).some((v) => v !== undefined && v !== null && v !== ""));
}

/**
 * The fields worth spending another call on.
 *
 * The person waterfall resolves ONE value, so "first verified hit wins" is the
 * whole rule. A firmographic vendor returns a whole record, and coverage across
 * the registry is uneven: Findymail has no ticker or postal code, Surfe has a
 * ticker but no city, Snov has neither a LinkedIn page nor a country. Stopping
 * at the first vendor that answered anything would therefore let a thin vendor
 * high in the order decide the record — and then the store trusts that
 * half-empty row for six months, which is the exact failure the companies table
 * was added to fix (an export with the firmographic columns permanently blank).
 *
 * So the runner fills gaps instead: it keeps going while one of these four is
 * missing, merging each answer into the record.
 *
 * These four and not the other six, because these are what the audience upload
 * and the UI actually read, and every full-coverage vendor supplies all four —
 * so a user with one good key still stops after a single call. The rest
 * (ticker, postal code, state, headcount, founding year, name) are taken
 * whenever a call happens anyway but never *cause* one: a ticker is absent for
 * the overwhelming majority of companies, so chasing it down the whole order
 * would spend a credit at every vendor on nearly every private company.
 */
export const COMPANY_ESSENTIAL: readonly (keyof CompanyRecord)[] = [
  "linkedinUrl",
  "industry",
  "city",
  "country",
];

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Essential fields still unfilled on `into`. */
function missingEssential(into: CompanyRecord): (keyof CompanyRecord)[] {
  return COMPANY_ESSENTIAL.filter((f) => isEmpty(into[f]));
}

/**
 * Copy every field `from` fills and `into` does not, and report whether
 * anything landed.
 *
 * Earlier-in-order wins, deliberately: the order is the user's own trust
 * ranking, so a later vendor may complete the record but never overwrite it.
 */
function mergeInto(into: CompanyRecord, from: CompanyRecord): boolean {
  let changed = false;
  for (const [k, v] of Object.entries(from) as [keyof CompanyRecord, unknown][]) {
    if (isEmpty(v) || !isEmpty(into[k])) continue;
    (into as Record<string, unknown>)[k] = v;
    changed = true;
  }
  return changed;
}

/**
 * Resolve one company from its domain.
 *
 * Never throws: like the person runner, every failure mode becomes an attempt
 * row so one dead vendor degrades a run rather than failing it.
 */
export async function runCompanyWaterfall(
  rawDomain: string | undefined | null,
  env: ConnectionsEnv,
  opts: CompanyWaterfallOptions,
): Promise<CompanyWaterfallResult> {
  const domain = normalizeDomain(rawDomain);
  const attempts: EnrichAttempt[] = [];
  if (!domain) {
    return { domain: "", data: null, providerId: null, cached: false, totalCredits: 0, attempts };
  }

  if (!opts.refresh && opts.store) {
    const cached = await opts.store.get(domain, opts.maxCacheAgeDays ?? COMPANY_CACHE_MAX_AGE_DAYS);
    if (cached) {
      return { domain, data: cached, providerId: null, cached: true, totalCredits: 0, attempts };
    }
  }

  let totalCredits = 0;
  const registry = opts.registry ?? COMPANY_REGISTRY;
  const merged: CompanyRecord = {};
  const contributors: string[] = [];

  for (const id of opts.order) {
    const provider = registry.find((p) => p.id === id);
    if (!provider) continue;

    // Nothing essential left to buy — stop before spending. This is the common
    // case for a user holding one full-coverage key: exactly one call.
    const missing = missingEssential(merged);
    if (missing.length === 0) break;

    // This vendor's whole documented coverage is already filled, so a call
    // could only return what we hold. Skipped as `ineligible` — the same
    // outcome the person runner uses for "would not have helped" — rather than
    // silently, so the ledger shows why coverage stopped where it did.
    if (!provider.covers.some((f) => missing.includes(f))) {
      attempts.push({
        providerId: id,
        field: "company",
        outcome: "ineligible",
        creditsUsed: 0,
        ms: 0,
        detail: `Nothing left for ${provider.label} to add (still missing: ${missing.join(", ")})`,
      });
      continue;
    }

    // Recorded, not hidden — "PDL would have run here but has no key" is the
    // diagnostic a user needs when company coverage looks empty.
    const apiKey = secret(provider.secretName, env);
    if (!apiKey) {
      attempts.push({ providerId: id, field: "company", outcome: "unconfigured", creditsUsed: 0, ms: 0, detail: `No ${provider.secretName} configured` });
      continue;
    }

    const started = Date.now();
    let result: Awaited<ReturnType<CompanyProvider["enrich"]>>;
    try {
      result = await provider.enrich(domain, apiKey);
    } catch (err) {
      // Adapters are contracted not to throw; backstop so one misbehaving
      // vendor cannot take down a batch.
      result = { outcome: "error", data: null, creditsUsed: 0, detail: err instanceof Error ? err.message : "Unknown provider error" };
    }
    const ms = Date.now() - started;

    totalCredits += result.creditsUsed;
    attempts.push({ providerId: id, field: "company", outcome: result.outcome, creditsUsed: result.creditsUsed, ms, detail: result.detail });

    // A vendor can answer 200 with a record that is entirely empty. That is a
    // miss dressed as a hit, and merging it would credit a vendor that supplied
    // nothing.
    if (result.outcome === "hit" && hasAnyField(result.data)) {
      if (mergeInto(merged, result.data)) contributors.push(id);
    }
  }

  if (!hasAnyField(merged)) {
    return { domain, data: null, providerId: null, cached: false, totalCredits, attempts };
  }

  // Every vendor that actually filled a cell, in the order they did. One TEXT
  // column, because attributing a merged row to a single vendor would be a lie
  // and the ledger already holds the per-attempt detail.
  const providerId = contributors.join("+");
  await opts.store?.put(domain, merged, providerId);
  return { domain, data: merged, providerId, cached: false, totalCredits, attempts };
}
