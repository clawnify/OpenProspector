// Findymail adapter — the reference implementation of EnrichProvider.
//
// Contract verified against https://app.findymail.com/docs/ :
//   POST /api/search/name  { name, domain }  -> { contact: { name, domain, email } }
//   POST /api/verify       { email }         -> { email, verified, provider }
//   GET  /api/credits                        -> { credits, verifier_credits }
//   Auth: Authorization: Bearer <key>
//
// Findymail's finder only returns addresses it has already validated, so a hit
// here is `verified: true` without a second /api/verify round-trip (which would
// spend a verifier credit for no new information). `verify()` exists for the
// CSV-import path, where the user brings addresses we did not source.

import type {
  CompanyProvider,
  CompanyResult,
  CreditBalance,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
} from "./types";
import { absoluteLinkedIn, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://app.findymail.com";

function call(path: string, apiKey: string, init?: { method?: string; body?: unknown }) {
  return vendorFetch(`${BASE}${path}`, {
    method: init?.method,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: init?.body,
  });
}

/**
 * Map a non-2xx status onto an outcome the runner knows how to act on.
 *
 * Returns statusOutcome's narrowed type rather than `EnrichResult["outcome"]`,
 * because a CompanyResult can never be `pending` — no firmographic API answers
 * by callback — and the company adapter below shares this mapping.
 */
function outcomeForStatus(status: number): ReturnType<typeof statusOutcome> {
  return statusOutcome(status, "Findymail");
}

export const FindymailProvider: EnrichProvider = {
  id: "findymail",
  label: "Findymail",
  fields: ["email"],
  secretName: "FINDYMAIL_API_KEY",
  signupUrl: "https://app.findymail.com/user/api-tokens",

  requirements(_field: EnrichField): InputRequirement {
    // The name endpoint needs both; `domain` also accepts a company name, but we
    // require a real domain because company-name lookups are markedly less exact.
    return ["fullName", "domain"];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Findymail resolves email only");
    if (!input.fullName || !input.domain) return ineligible("Needs full name and domain");

    const { status, body } = await call("/api/search/name", apiKey, {
      method: "POST",
      body: { name: input.fullName, domain: input.domain },
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const email = (body as { contact?: { email?: string } } | null)?.contact?.email ?? null;
    // 200 with no contact is Findymail's "searched, found nothing" — no credit spent.
    if (!email) return miss();
    // Documented: a successful find consumes exactly one credit.
    return { outcome: "hit", value: email, verified: true, creditsUsed: 1 };
  },

  async verify(value, apiKey): Promise<EnrichResult> {
    const { status, body } = await call("/api/verify", apiKey, { method: "POST", body: { email: value } });
    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const verified = (body as { verified?: boolean } | null)?.verified === true;
    return {
      outcome: verified ? "hit" : "miss",
      value: verified ? value : null,
      verified,
      creditsUsed: 1,
      detail: verified ? undefined : "Address did not pass verification",
    };
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/api/credits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null, verifierRemaining: null };
    const b = body as { credits?: number; verifier_credits?: number } | null;
    return {
      remaining: typeof b?.credits === "number" ? b.credits : null,
      verifierRemaining: typeof b?.verifier_credits === "number" ? b.verifier_credits : null,
    };
  },
};

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract captured from a LIVE response on 2026-09-03 (a real key, against
// `stripe.com`), and the live response is why this adapter is worth more than
// the docs suggest:
//   POST /api/search/company  { domain }
//        -> { name, domain, industry, company_size, linkedin_url, description,
//             city, region, country }
//   404 -> no match. Billed on success only, so that costs nothing.
//   Auth: Authorization: Bearer <key>   (same key as the person adapter)
//
// **Findymail's published response schema under-reports what it returns.** The
// documented fields stop at name / domain / company_size / industry /
// linkedin_url / description — no location at all. The live response also
// carries `city`, `region` and `country`, which is three of the LinkedIn upload
// columns, and an adapter written from the docs alone would have thrown them
// away. Mapped from the observed response, not the reference.
//
// Two shapes worth noting:
//   * `company_size` is a bucketed string ("5001-10000"), never an integer, so
//     employeeCount is deliberately left unset rather than parsed out of a
//     range — the column is an INTEGER, and half a range is not a headcount.
//   * `country` comes back as a lowercase alpha-2 ("us"). Upper-cased here
//     because it lands in the LinkedIn `companycountry` column, where the
//     two-letter code is the expected form.

interface CompanyBody {
  name?: string | null;
  industry?: string | null;
  linkedin_url?: string | null;
  city?: string | null;
  region?: string | null;
  country?: string | null;
}

export const FindymailCompanyProvider: CompanyProvider = {
  id: "findymail-company",
  label: "Findymail",
  secretName: "FINDYMAIL_API_KEY",
  signupUrl: "https://app.findymail.com/user/api-tokens",
  // No founded year, no ticker, no postal code, and no usable headcount.
  covers: ["name", "linkedinUrl", "industry", "city", "state", "country"],

  async enrich(domain, apiKey): Promise<CompanyResult> {
    const { status, body } = await call("/api/search/company", apiKey, { method: "POST", body: { domain } });

    if (status === 404) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };
    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const c = (body ?? {}) as CompanyBody;
    if (!c.name && !c.industry && !c.linkedin_url) {
      return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };
    }

    const country = String(c.country ?? "").trim();
    return {
      outcome: "hit",
      // Documented: one Finder credit, charged only when data comes back.
      creditsUsed: 1,
      data: {
        name: c.name || undefined,
        industry: c.industry || undefined,
        linkedinUrl: absoluteLinkedIn(c.linkedin_url),
        city: c.city || undefined,
        state: c.region || undefined,
        // See the header: "us" upper-cased for the LinkedIn country column.
        country: country ? (country.length === 2 ? country.toUpperCase() : country) : undefined,
      },
    };
  },
};
