// Prospeo adapter — email and mobile, via Enrich Person.
//
// Contract verified against https://prospeo.io/api-docs/enrich-person :
//   POST /enrich-person  { data: { first_name, last_name, full_name, linkedin_url,
//                                  email, company_name, company_website },
//                          only_verified_email, enrich_mobile, only_verified_mobile }
//        -> { error, free_enrichment, person: { email: { status, revealed, email },
//                                               mobile: { status, revealed, mobile } } }
//   GET  /account-information -> { response: { remaining_credits } }
//   Auth: X-KEY: <key>
//
// Two Prospeo-specific traps this adapter exists to handle:
//
//  1. **Errors come back as HTTP 400, not a status family.** NO_MATCH, an
//     invalid key, and being out of credits are all 400s distinguished only by
//     `error_code`. Mapping on status alone would report every one of them as a
//     generic failure, and the user would never learn their key was wrong.
//  2. **A value can be present but masked.** The response carries the address as
//     `eoghan.*****@intercom.com` with `revealed: false` when it was not
//     purchased. Reading `.email` without checking `.revealed` would store a
//     redacted string as a real contact.
//
// Pricing, per their docs: 1 credit per email found, 10 per mobile (email
// included free with the mobile), nothing when there is no result, and nothing
// for re-enriching the same record inside 90 days — the last of which the
// response reports as `free_enrichment`, so the ledger records the true cost.

import type {
  CompanyProvider,
  CompanyResult,
  CreditBalance,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { IDENTIFIED_PERSON, absoluteLinkedIn, ineligible, miss, vendorFetch } from "./vendor";

const BASE = "https://api.prospeo.io";

interface Revealable {
  status?: string | null;
  revealed?: boolean;
  email?: string | null;
  mobile?: string | null;
}

export const ProspeoProvider: EnrichProvider = {
  id: "prospeo",
  label: "Prospeo",
  fields: ["email", "phone"],
  secretName: "PROSPEO_API_KEY",
  signupUrl: "https://prospeo.io/pricing",

  requirements(_field: EnrichField): InputRequirement {
    // Their documented matching minimums: a name plus a company handle, or a
    // LinkedIn URL, or an email.
    return IDENTIFIED_PERSON;
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const data = matchData(input);
    if (!data) return ineligible("Needs a profile URL, an email, or a name with a company or domain");

    const { status, body } = await vendorFetch(`${BASE}/enrich-person`, {
      method: "POST",
      headers: { "X-KEY": apiKey },
      body: {
        data,
        ...(field === "email"
          ? // Only pay for an address Prospeo has verified. The waterfall stops
            // only on a verified hit anyway, so an unverified one would be a
            // credit spent on a value that cannot end the search.
            { only_verified_email: true }
          : // `only_verified_mobile` implies enrich_mobile, and makes a record
            // without a mobile a NO_MATCH — which is not charged for. Without
            // it we pay 10 credits to learn there is no number.
            { enrich_mobile: true, only_verified_mobile: true }),
      },
    });

    const b = body as { error?: boolean; error_code?: string; free_enrichment?: boolean; person?: Record<string, Revealable> } | null;

    if (status === 429) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Rate limited by Prospeo" };
    }
    if (b?.error === true || status < 200 || status >= 300) {
      return errorResult(b?.error_code, status);
    }

    // Documented as true when the record was enriched before and is inside the
    // 90-day free re-enrichment window.
    const free = b?.free_enrichment === true;
    return field === "email" ? readEmail(b?.person?.email, free) : readMobile(b?.person?.mobile, free);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await vendorFetch(`${BASE}/account-information`, {
      headers: { "X-KEY": apiKey },
    });
    if (status < 200 || status >= 300) return { remaining: null };
    const n = (body as { response?: { remaining_credits?: unknown } } | null)?.response?.remaining_credits;
    return { remaining: typeof n === "number" ? n : null };
  },
};

/** Prospeo returns everything as a 400 plus an `error_code`; map that, not the status. */
function errorResult(code: string | undefined, status: number): EnrichResult {
  switch (code) {
    case "NO_MATCH":
      // Also what comes back when only_verified_* filtered the record out —
      // which is the point of setting those flags. Not charged either way.
      return miss("Prospeo matched no record with the requested contact data");
    case "INVALID_DATAPOINTS":
      return ineligible("Prospeo rejected the identifying datapoints");
    case "INSUFFICIENT_CREDITS":
      return { outcome: "no_credits", value: null, verified: false, creditsUsed: 0, detail: "Out of Prospeo credits" };
    case "INVALID_API_KEY":
      return { outcome: "unconfigured", value: null, verified: false, creditsUsed: 0, detail: "Prospeo rejected the API key" };
    default:
      return {
        outcome: "error",
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: code ? `Prospeo error ${code}` : `Prospeo returned HTTP ${status}`,
      };
  }
}

/** The `data` object, or null when we hold none of the documented minimums. */
function matchData(input: LeadInput): Record<string, string> | null {
  const d: Record<string, string> = {};
  if (input.linkedinUrl) d.linkedin_url = input.linkedinUrl;
  if (input.email) d.email = input.email;
  if (input.firstName && input.lastName) {
    d.first_name = input.firstName;
    d.last_name = input.lastName;
  } else if (input.fullName) {
    d.full_name = input.fullName;
  }
  // Their docs advise strongly against matching on company name alone, and to
  // send both when we have both — more datapoints, better accuracy, same price.
  if (input.domain) d.company_website = input.domain;
  if (input.company) d.company_name = input.company;

  const hasName = Boolean(d.full_name || (d.first_name && d.last_name));
  const hasCompany = Boolean(d.company_website || d.company_name);
  if (d.linkedin_url || d.email || (hasName && hasCompany)) return d;
  return null;
}

function readEmail(email: Revealable | undefined, free: boolean): EnrichResult {
  // `revealed: false` means the address in the payload is masked, not bought.
  if (!email?.email || email.revealed !== true) return miss("No verified email available");
  return {
    outcome: "hit",
    value: email.email,
    verified: email.status === "VERIFIED",
    creditsUsed: free ? 0 : 1,
    detail: free ? "Free re-enrichment (already bought within 90 days)" : undefined,
  };
}

function readMobile(mobile: Revealable | undefined, free: boolean): EnrichResult {
  if (!mobile?.mobile || mobile.revealed !== true) return miss("No mobile number available");
  return {
    outcome: "hit",
    value: mobile.mobile,
    verified: true,
    creditsUsed: free ? 0 : 10,
    detail: free ? "Free re-enrichment (already bought within 90 days)" : undefined,
  };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract captured from a LIVE response on 2026-09-03 (a real key, against
// `stripe.com`):
//   POST /enrich-company  { data: { company_website } }
//        -> { error: false, free_enrichment,
//             company: { name, industry, linkedin_url, employee_count,
//                        employee_range, founded,
//                        location: { country, country_code, state, city,
//                                    raw_address } } }
//   Auth: X-KEY: <key>   (same key as the person adapter)
//
// Trap 1 from the header applies unchanged: NO_MATCH and a rejected key are
// both HTTP 400, told apart only by `error_code`, so errorCompanyResult maps
// the code rather than the status. Sharing the person adapter's `errorResult`
// was not possible — it returns an EnrichResult — so the codes are mapped once
// more here, deliberately in the same order and with the same wording.
//
// No ticker and no postal code in the schema. The postal code IS present inside
// `location.raw_address` ("354 Oyster Point Blvd, South San Francisco,
// California 94080, US"), and is deliberately not scraped out of it: a regex
// over a free-text address is a guess, and a wrong zipcode in the LinkedIn
// upload is worse than an empty cell.
//
// Pricing, from the docs and confirmed by the live `free_enrichment` flag: one
// credit per matched company, nothing for a no-match, and nothing for
// re-enriching the same company inside 90 days.

interface CompanyBody {
  name?: string | null;
  industry?: string | null;
  linkedin_url?: string | null;
  employee_count?: number | null;
  founded?: number | null;
  location?: {
    country?: string | null;
    state?: string | null;
    city?: string | null;
  } | null;
}

/** The person adapter's status mapping, in CompanyResult shape. */
function errorCompanyResult(code: string | undefined, status: number): CompanyResult {
  switch (code) {
    case "NO_MATCH":
      return { outcome: "miss", data: null, creditsUsed: 0, detail: "Prospeo matched no company with this domain" };
    case "INVALID_DATAPOINTS":
      return { outcome: "ineligible", data: null, creditsUsed: 0, detail: "Prospeo rejected the identifying datapoints" };
    case "INSUFFICIENT_CREDITS":
      return { outcome: "no_credits", data: null, creditsUsed: 0, detail: "Out of Prospeo credits" };
    case "INVALID_API_KEY":
      return { outcome: "unconfigured", data: null, creditsUsed: 0, detail: "Prospeo rejected the API key" };
    default:
      return {
        outcome: "error",
        data: null,
        creditsUsed: 0,
        detail: code ? `Prospeo error ${code}` : `Prospeo returned HTTP ${status}`,
      };
  }
}

export const ProspeoCompanyProvider: CompanyProvider = {
  id: "prospeo-company",
  label: "Prospeo",
  secretName: "PROSPEO_API_KEY",
  signupUrl: "https://prospeo.io/pricing",
  // No stockSymbol and no postalCode — see the header on why the postal code in
  // `raw_address` is not claimed.
  covers: ["name", "linkedinUrl", "industry", "city", "state", "country", "employeeCount", "foundedYear"],

  async enrich(domain, apiKey): Promise<CompanyResult> {
    const { status, body } = await vendorFetch(`${BASE}/enrich-company`, {
      method: "POST",
      headers: { "X-KEY": apiKey },
      body: { data: { company_website: domain } },
    });

    const b = body as { error?: boolean; error_code?: string; free_enrichment?: boolean; company?: CompanyBody | null } | null;
    if (status < 200 || status >= 300 || b?.error) return errorCompanyResult(b?.error_code, status);

    const c = b?.company;
    if (!c) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };

    const loc = c.location ?? {};
    return {
      outcome: "hit",
      // The vendor's own word on whether this one was billed.
      creditsUsed: b?.free_enrichment ? 0 : 1,
      data: {
        name: c.name || undefined,
        industry: c.industry || undefined,
        linkedinUrl: absoluteLinkedIn(c.linkedin_url),
        employeeCount: c.employee_count ?? undefined,
        foundedYear: c.founded ?? undefined,
        city: loc.city || undefined,
        state: loc.state || undefined,
        country: loc.country || undefined,
      },
    };
  },
};
