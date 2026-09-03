// RocketReach adapter. https://docs.rocketreach.co/reference/people-lookup-api
//
// A lookup is a GET that answers at once with a profile whose `status` may
// still be `searching` or `progress`; the finished profile is fetched from
// checkStatus a few seconds later. Polled in-band like Wiza.
//
// One credit per profile, not per field: a standard credit unlocks an email,
// a premium one an email or a phone. Nothing is charged when nothing is found,
// and a re-lookup of the same person is free — so a phone lookup after an
// email hit on the same profile costs the premium credit only.

import type {
  CompanyProvider,
  CompanyResult, CreditBalance, EnrichField, EnrichProvider, EnrichResult, InputRequirement, LeadInput } from "./types";
import { IDENTIFIED_PERSON, absoluteLinkedIn, ineligible, miss, pollUntil, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.rocketreach.co/api/v2";

interface Profile {
  id?: number | string;
  status?: string;
  recommended_professional_email?: string | null;
  current_work_email?: string | null;
  emails?: { email?: string; smtp_valid?: string; type?: string; grade?: string }[] | null;
  phones?: { number?: string; e164?: string; type?: string; grade?: string; recommended?: boolean }[] | null;
}

const FINISHED = new Set(["complete", "failed"]);

function call(path: string, apiKey: string) {
  return vendorFetch(`${BASE}${path}`, { headers: { "Api-Key": apiKey } });
}

export const RocketReachProvider: EnrichProvider = {
  id: "rocketreach",
  label: "RocketReach",
  fields: ["email", "phone"],
  secretName: "ROCKETREACH_API_KEY",
  signupUrl: "https://rocketreach.co/pricing",

  requirements(_field: EnrichField): InputRequirement {
    return IDENTIFIED_PERSON;
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const q = lookupQuery(input);
    if (!q) return ineligible("Needs a profile URL, an email, or a name with a company or domain");
    // Standard credits unlock email only; a phone needs a premium lookup.
    q.set("lookup_type", field === "email" ? "standard" : "premium");

    const started = await call(`/person/lookup?${q}`, apiKey);
    if (started.status < 200 || started.status >= 300) {
      const { outcome, detail } = statusOutcome(started.status, "RocketReach");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    let profile = (started.body ?? {}) as Profile;
    if (profile.id === undefined || profile.id === null) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "RocketReach returned no profile id" };
    }

    if (!FINISHED.has(String(profile.status))) {
      const id = String(profile.id);
      const finished = await pollUntil<{ status: number; profile: Profile | null }>(async () => {
        const r = await call(`/person/checkStatus?ids=${encodeURIComponent(id)}`, apiKey);
        if (r.status < 200 || r.status >= 300) return { done: true, value: { status: r.status, profile: null } };
        const p = (Array.isArray(r.body) ? (r.body as Profile[])[0] : (r.body as Profile)) ?? {};
        if (FINISHED.has(String(p.status))) return { done: true, value: { status: r.status, profile: p } };
        return { done: false };
      });
      if (!finished) {
        return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `RocketReach lookup ${id} still running after 25s — retrieve it with /person/checkStatus?ids=${id}` };
      }
      if (finished.status < 200 || finished.status >= 300 || !finished.profile) {
        const { outcome, detail } = statusOutcome(finished.status, "RocketReach");
        return { outcome, value: null, verified: false, creditsUsed: 0, detail };
      }
      profile = finished.profile;
    }

    if (profile.status === "failed") return miss("RocketReach could not complete the lookup");
    return field === "email" ? readEmail(profile) : readPhone(profile);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/account/", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    const usage = (body as { credit_usage?: { credit_type?: string; remaining?: number | string }[] } | null)?.credit_usage;
    const lookup = usage?.find((u) => /lookup/i.test(String(u.credit_type ?? ""))) ?? usage?.[0];
    return { remaining: typeof lookup?.remaining === "number" ? lookup.remaining : null };
  },
};

function lookupQuery(input: LeadInput): URLSearchParams | null {
  const q = new URLSearchParams();
  if (input.linkedinUrl) q.set("linkedin_url", input.linkedinUrl);
  if (input.email) q.set("email", input.email);
  // Employer is free text; a bare domain still matches when that is all we have.
  if (input.fullName && (input.company || input.domain)) {
    q.set("name", input.fullName);
    q.set("current_employer", input.company || (input.domain as string));
  }
  return q.has("linkedin_url") || q.has("email") || q.has("name") ? q : null;
}

/**
 * Professional addresses only; `valid` is the vendor's SMTP assertion. A B or
 * F grade is not charged for and is not worth handing on, so it is a miss.
 */
function readEmail(p: Profile): EnrichResult {
  const emails = (p.emails ?? []).filter((e) => e.email && e.type !== "personal" && e.type !== "disposable");
  const preferred = p.recommended_professional_email || p.current_work_email;
  const pick =
    emails.find((e) => e.email === preferred) ??
    emails.find((e) => e.smtp_valid === "valid") ??
    emails.find((e) => e.grade === "A" || e.grade === "A-");
  if (!pick?.email) return miss("No professional email on the profile");
  const verified = pick.smtp_valid === "valid";
  return {
    outcome: "hit",
    value: pick.email,
    verified,
    creditsUsed: 1,
    detail: verified ? undefined : `RocketReach graded this address ${pick.grade ?? "unknown"} (${pick.smtp_valid ?? "unchecked"})`,
  };
}

function readPhone(p: Profile): EnrichResult {
  const phones = (p.phones ?? []).filter((x) => x.e164 || x.number);
  const pick =
    phones.find((x) => x.type === "mobile" && x.recommended) ??
    phones.find((x) => x.type === "mobile") ??
    phones.find((x) => x.type === "direct dial") ??
    phones.find((x) => x.recommended) ??
    phones[0];
  const value = pick?.e164 || pick?.number;
  if (!value) return miss("No phone number on the profile");
  return { outcome: "hit", value, verified: true, creditsUsed: 1, detail: pick?.type ? `RocketReach type: ${pick.type}` : undefined };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract verified against https://docs.rocketreach.co/reference/company-lookup-api
// on 2026-09-03 — including the two nestings, read off the OpenAPI definition
// rather than a prose example, because both are exactly the kind of detail a
// plausible-looking guess gets wrong:
//   GET /company/lookup/?domain=
//        -> { name, domain, industry, num_employees, year_founded,
//             ticker_symbol,
//             links:   { linkedin },
//             address: { city, region, postal_code, country } }
//   404 -> no match.
//   Auth: Api-Key: <key>   (same key and same header as the person adapter)
//
// `city`, `region`, `postal_code` and `country` are NOT top-level, and the
// LinkedIn URL is NOT `linkedin_url`. Reading either flat would compile,
// typecheck, and hand back a row of undefineds for every company.
//
// The endpoint was probed live on 2026-09-03 and answers a bad key with 401.

interface CompanyBody {
  name?: string | null;
  industry?: string | null;
  num_employees?: number | null;
  year_founded?: number | null;
  ticker_symbol?: string | null;
  links?: { linkedin?: string | null } | null;
  address?: {
    city?: string | null;
    region?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
}

export const RocketReachCompanyProvider: CompanyProvider = {
  id: "rocketreach-company",
  label: "RocketReach",
  secretName: "ROCKETREACH_API_KEY",
  signupUrl: "https://rocketreach.co/pricing",
  covers: [
    "name",
    "linkedinUrl",
    "industry",
    "city",
    "state",
    "country",
    "postalCode",
    "stockSymbol",
    "employeeCount",
    "foundedYear",
  ],

  async enrich(domain, apiKey): Promise<CompanyResult> {
    const { status, body } = await call(`/company/lookup/?domain=${encodeURIComponent(domain)}`, apiKey);

    if (status === 404) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "RocketReach");
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const c = (body ?? {}) as CompanyBody;
    // A 200 carrying no name is not a match. Without this the adapter builds a
    // record of undefineds, reports `hit`, and bills a credit for it — the
    // runner would discard the empty record but the ledger would already be
    // wrong. Every other adapter here guards the same way.
    if (!c.name) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };
    const addr = c.address ?? {};
    return {
      outcome: "hit",
      // RocketReach does not document a per-company price and returns no
      // consumption field, so this records the one credit a lookup costs
      // everywhere else in its API rather than claiming the call was free.
      creditsUsed: 1,
      data: {
        name: c.name || undefined,
        industry: c.industry || undefined,
        linkedinUrl: absoluteLinkedIn(c.links?.linkedin),
        stockSymbol: c.ticker_symbol || undefined,
        employeeCount: c.num_employees ?? undefined,
        foundedYear: c.year_founded ?? undefined,
        city: addr.city || undefined,
        state: addr.region || undefined,
        country: addr.country || undefined,
        postalCode: addr.postal_code || undefined,
      },
    };
  },
};
