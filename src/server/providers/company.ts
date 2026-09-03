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
// House rule, and the one place it differs from the person runner: the first
// hit wins outright. There is no `verified` concept for firmographics — no
// vendor grades an industry the way an email finder grades deliverability — so
// there is nothing to keep looking past a hit for. Merging partial records
// across vendors was deliberately not built: it would multiply the cost of
// every company by the number of vendors configured, to fill columns that are
// matching *hints* on the LinkedIn upload rather than the match key itself.

import { secret, type ConnectionsEnv } from "@clawnify/connections";
import type { CompanyProvider, CompanyRecord, EnrichAttempt } from "./types";

/**
 * Every known company adapter. As with REGISTRY, order here is only the
 * shipping default — see COMPANY_DEFAULT_ORDER for the waterfall.
 */
export const COMPANY_REGISTRY: readonly CompanyProvider[] = [];

/**
 * Default company waterfall.
 *
 * Ordered so a user pays nothing new before they pay anything at all: every
 * vendor that already serves the person waterfall comes first, because its key
 * is already in the settings screen and its plan already bought. A dedicated
 * firmographic vendor is only worth reaching for when those miss.
 */
export const COMPANY_DEFAULT_ORDER: readonly string[] = [];

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

  for (const id of opts.order) {
    const provider = registry.find((p) => p.id === id);
    if (!provider) continue;

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
    // miss dressed as a hit, and storing it would poison the cache for six
    // months with a row that fills no column.
    if (result.outcome === "hit" && hasAnyField(result.data)) {
      await opts.store?.put(domain, result.data, id);
      return { domain, data: result.data, providerId: id, cached: false, totalCredits, attempts };
    }
  }

  return { domain, data: null, providerId: null, cached: false, totalCredits, attempts };
}
