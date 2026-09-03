// D1-backed EnrichCache + the append-only cost ledger.
//
// The cache is what makes a BYO-key waterfall cheaper than per-lead SaaS: the
// same person is never bought twice. The expiry is what stops that saving from
// quietly becoming a bounce-rate problem — see CACHE_MAX_AGE_DAYS.

import { get, query, run } from "./db.js";
import { cacheKey, type EnrichCache } from "./providers/index.js";
import type { CompanyStore } from "./providers/company.js";
import type { CompanyRecord, EnrichAttempt, EnrichField, LeadInput } from "./providers/types.js";

/**
 * Staleness is evaluated by SQLite, not JS, on purpose: `found_at` is written by
 * `datetime('now')` ("YYYY-MM-DD HH:MM:SS"), which does NOT string-compare
 * correctly against a JS ISO timestamp ("…THH:MM:SS.sssZ" — note the `T`).
 * Comparing against `datetime('now', ?)` keeps both sides in one format.
 */
const AGE_CUTOFF_SQL = "datetime('now', ?)";

export function ageModifier(maxAgeDays: number): string {
  // A negative/NaN override would push the cutoff into the future and match
  // every row forever. Clamping to 0 instead makes bad input fail *closed* —
  // everything reads as expired and gets re-fetched. Verified against SQLite:
  // `datetime('now', '-0 days')` matches nothing, which is the safe direction.
  const days = Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? Math.floor(maxAgeDays) : 0;
  return `-${days} days`;
}

export const d1Cache: EnrichCache = {
  async get(field: EnrichField, input: LeadInput, maxAgeDays: number) {
    const row = await get<{ value: string; verified: number; provider_id: string }>(
      `SELECT value, verified, provider_id FROM enrichment_cache
        WHERE cache_key = ? AND found_at >= ${AGE_CUTOFF_SQL}`,
      [cacheKey(field, input), ageModifier(maxAgeDays)],
    );
    if (!row) return null;
    return { value: row.value, verified: row.verified === 1, providerId: row.provider_id };
  },

  async put(field: EnrichField, input: LeadInput, hit) {
    // Re-resolving the same lead refreshes found_at, so an address we keep
    // confirming stays cached rather than expiring on a fixed birthday.
    await run(
      `INSERT INTO enrichment_cache (cache_key, field, value, verified, provider_id, found_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(cache_key) DO UPDATE SET
         value = excluded.value,
         verified = excluded.verified,
         provider_id = excluded.provider_id,
         found_at = excluded.found_at`,
      [cacheKey(field, input), field, hit.value, hit.verified ? 1 : 0, hit.providerId],
    );
  },
};

/**
 * D1-backed CompanyStore. Shares the read/write shape of d1Cache above, but
 * against `companies` and on its own, longer staleness window — see
 * COMPANY_CACHE_MAX_AGE_DAYS for why firmographics are not on the 90-day
 * contact clock.
 *
 * Unlike the enrichment cache there is no purge: this table is the app's record
 * of the accounts in its pipeline, not a copy of one, and its columns are
 * business identity rather than an individual's contact details.
 */
export const d1CompanyStore: CompanyStore = {
  async get(domain: string, maxAgeDays: number) {
    const row = await get<Record<string, unknown>>(
      `SELECT name, linkedin_url, industry, city, state, country, postal_code,
              stock_symbol, employee_count, founded_year
         FROM companies
        WHERE domain = ? AND found_at >= ${AGE_CUTOFF_SQL}`,
      [domain, ageModifier(maxAgeDays)],
    );
    if (!row) return null;
    // Empty strings become `undefined` so a caller can tell "we never learned
    // this" from "the vendor told us it is blank" — the export relies on the
    // difference to decide whether to fall back to the lead's own location.
    const text = (v: unknown) => (String(v ?? "").trim() || undefined);
    const num = (v: unknown) => (typeof v === "number" && v > 0 ? v : undefined);
    return {
      name: text(row.name),
      linkedinUrl: text(row.linkedin_url),
      industry: text(row.industry),
      city: text(row.city),
      state: text(row.state),
      country: text(row.country),
      postalCode: text(row.postal_code),
      stockSymbol: text(row.stock_symbol),
      employeeCount: num(row.employee_count),
      foundedYear: num(row.founded_year),
    } satisfies CompanyRecord;
  },

  async put(domain: string, record: CompanyRecord, providerId: string) {
    // Re-resolving refreshes found_at, so a company we keep confirming stays
    // fresh rather than expiring on a fixed birthday — same rule as the cache.
    await run(
      `INSERT INTO companies (domain, name, linkedin_url, industry, city, state, country,
                              postal_code, stock_symbol, employee_count, founded_year,
                              provider_id, found_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(domain) DO UPDATE SET
         name = excluded.name,
         linkedin_url = excluded.linkedin_url,
         industry = excluded.industry,
         city = excluded.city,
         state = excluded.state,
         country = excluded.country,
         postal_code = excluded.postal_code,
         stock_symbol = excluded.stock_symbol,
         employee_count = excluded.employee_count,
         founded_year = excluded.founded_year,
         provider_id = excluded.provider_id,
         found_at = excluded.found_at`,
      [
        domain,
        record.name ?? "",
        record.linkedinUrl ?? "",
        record.industry ?? "",
        record.city ?? "",
        record.state ?? "",
        record.country ?? "",
        record.postalCode ?? "",
        record.stockSymbol ?? "",
        record.employeeCount ?? null,
        record.foundedYear ?? null,
        providerId,
      ],
    );
  },
};

/**
 * Delete expired entries outright rather than just hiding them behind the read
 * filter — expired personal data we no longer use has no reason to sit in the
 * table. Safe to call on any schedule; returns how many rows went.
 */
export async function purgeExpiredCache(maxAgeDays: number): Promise<number> {
  const res = await run(`DELETE FROM enrichment_cache WHERE found_at < ${AGE_CUTOFF_SQL}`, [
    ageModifier(maxAgeDays),
  ]);
  return res.changes;
}

/**
 * Append the waterfall's attempt log for one lead. Best-effort: a ledger write
 * must never fail the enrichment that produced it, or a transient D1 error
 * would cost the user credits *and* the result.
 */
export async function recordAttempts(
  leadId: string,
  runId: string | null,
  attempts: EnrichAttempt[],
): Promise<void> {
  if (attempts.length === 0) return;
  try {
    // Chunked to stay inside D1's 100-bound-parameter cap (9 params per row).
    for (let i = 0; i < attempts.length; i += 10) {
      const slice = attempts.slice(i, i + 10);
      const values = slice.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
      const params = slice.flatMap((a) => [
        crypto.randomUUID(),
        leadId,
        runId,
        a.providerId,
        a.field,
        a.outcome,
        a.creditsUsed,
        a.ms,
        // Without this the ledger records *that* a provider was skipped but not
        // *why* — which is the whole diagnostic value of an attempt log.
        a.detail ?? "",
      ]);
      await run(
        `INSERT INTO enrichment_attempts (id, lead_id, run_id, provider_id, field, outcome, credits_used, ms, detail)
         VALUES ${values}`,
        params,
      );
    }
  } catch {
    /* ledger is observability, never the critical path */
  }
}

/** Credits spent on one run, read back from the ledger rather than tracked in memory. */
export async function runCredits(runId: string): Promise<number> {
  const row = await get<{ total: number | null }>(
    "SELECT SUM(credits_used) AS total FROM enrichment_attempts WHERE run_id = ?",
    [runId],
  );
  return row?.total ?? 0;
}

/** Per-provider outcome breakdown — the data behind "is this vendor earning its slot?". */
export async function providerStats(
  field: EnrichField,
): Promise<{ provider_id: string; outcome: string; n: number; credits: number }[]> {
  return await query<{ provider_id: string; outcome: string; n: number; credits: number }>(
    `SELECT provider_id, outcome, COUNT(*) AS n, SUM(credits_used) AS credits
       FROM enrichment_attempts WHERE field = ?
      GROUP BY provider_id, outcome`,
    [field],
  );
}
