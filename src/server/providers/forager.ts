// Forager adapter — phone and work email, via the person contacts lookup.
//
// Contract verified against Forager's own OpenAPI bundle
// (https://docs.forager.ai/_bundle/openapi.yaml):
//   POST /api/{account_id}/datastorage/person_contacts_lookup/phone_numbers/
//        { person_id | linkedin_public_identifier }        -> [ { phone_number } ]
//   POST /api/{account_id}/datastorage/person_contacts_lookup/work_emails/
//        { person_id | linkedin_public_identifier, do_contacts_enrichment }
//        -> [ { email, email_type, validation_status } ]
//   Auth: X-API-KEY: <key>
//
// Two things make this adapter unlike the others:
//
//  1. The account id is part of the URL path, so the key alone is not enough to
//     call the API. It is stored as a single compound secret, `accountId:key`,
//     matching how the platform already stores Twilio's `SID:AUTH_TOKEN` —
//     rather than adding a second secret name to the provider contract for the
//     one vendor that needs it.
//  2. It keys on the LinkedIn *public identifier* (the `/in/<slug>` part), not
//     a URL and not a name. A lead the agent sourced without a profile URL is
//     simply unreachable here, and is skipped without spending.

import type {
  CompanyProvider,
  CompanyResult,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
} from "./types";
import { absoluteLinkedIn, ineligible, linkedinSlug, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api-v2.forager.ai";

/** Split the compound secret. Returns null when it isn't in `accountId:key` form. */
function parseKey(secret: string): { accountId: string; apiKey: string } | null {
  const idx = secret.indexOf(":");
  if (idx <= 0) return null;
  const accountId = secret.slice(0, idx).trim();
  const apiKey = secret.slice(idx + 1).trim();
  if (!accountId || !apiKey || !/^\d+$/.test(accountId)) return null;
  return { accountId, apiKey };
}

export const ForagerProvider: EnrichProvider = {
  id: "forager",
  label: "Forager",
  fields: ["email", "phone"],
  secretName: "FORAGER_API_KEY",
  signupUrl: "https://www.forager.ai/pricing",
  keyFormat: "accountId:apiKey",

  requirements(_field: EnrichField): InputRequirement {
    return ["linkedinUrl"];
  },

  async find(field, input, secret): Promise<EnrichResult> {
    const parsed = parseKey(secret);
    if (!parsed) {
      // Not an "error": a malformed secret is a configuration problem, and
      // reporting it as unconfigured puts it in front of the user in settings
      // instead of burying it as a transient vendor failure.
      return {
        outcome: "unconfigured",
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: "FORAGER_API_KEY must be in the form accountId:apiKey",
      };
    }

    const slug = linkedinSlug(input.linkedinUrl);
    if (!slug) return ineligible("Needs a linkedin.com/in/<slug> profile URL");

    const path = field === "email" ? "work_emails" : "phone_numbers";
    const { status, body } = await vendorFetch(
      `${BASE}/api/${parsed.accountId}/datastorage/person_contacts_lookup/${path}/`,
      {
        method: "POST",
        headers: { "X-API-KEY": parsed.apiKey },
        body: {
          linkedin_public_identifier: slug,
          // Only the email endpoint takes it: it asks Forager to go and resolve
          // an address it does not already hold, which is the whole reason to
          // call a finder rather than read a dataset.
          ...(field === "email" ? { do_contacts_enrichment: true } : {}),
        },
      },
    );

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Forager");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const rows = Array.isArray(body) ? body : [];
    return field === "email" ? readEmail(rows) : readPhone(rows);
  },
};

function readEmail(rows: unknown[]): EnrichResult {
  const emails = rows as { email?: string; email_type?: string; validation_status?: string }[];
  // Forager grades each address valid | risky | invalid | unknown. A graded
  // `invalid` is a known-bad address, not a weak signal — keeping it as the
  // waterfall's fallback would mean returning an address the vendor has already
  // told us will bounce, so it is dropped outright.
  const usable = emails.filter((e) => e.email && e.validation_status !== "invalid");
  const best = usable.find((e) => e.email_type !== "personal") ?? usable[0];
  if (!best?.email) return miss("No usable work email held for this profile");
  const verified = best.validation_status === "valid";
  return {
    outcome: "hit",
    value: best.email,
    verified,
    creditsUsed: 1,
    detail: verified ? undefined : `Forager graded this address "${best.validation_status ?? "unknown"}"`,
  };
}

function readPhone(rows: unknown[]): EnrichResult {
  const value = (rows as { phone_number?: string }[]).find((p) => p.phone_number)?.phone_number;
  if (!value) return miss("No phone number held for this profile");
  return { outcome: "hit", value, verified: true, creditsUsed: 1 };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract read off Forager's own OpenAPI document
// (https://docs.forager.ai/_bundle/openapi.yaml) on 2026-09-03 — the schema
// itself, not a prose page, so the nestings below are the vendor's own:
//   POST /api/{account_id}/datastorage/organization_search/  { domains: [d] }
//        -> { search_results: [{ name, legal_name, website, domain,
//                                founded_date, employees_amount,
//                                employees_range,
//                                linkedin_info: { public_profile_url,
//                                                 industry: { name } },
//                                addresses: [{ city, state, postcode,
//                                              country }] }],
//             total_search_results }
//   Auth: X-API-KEY (the key half of the compound secret), account id in the path
//
// **It is a search endpoint, filtered to one domain — not a lookup.** The
// results are therefore an array under `search_results` (not `results`), and
// the first element is taken. `website_detail_lookup`, the endpoint that *is*
// named like a company lookup, returns only traffic ranks and a tech stack and
// fills no CompanyRecord field at all, so this is the right one despite the
// name.
//
// Two nestings that a plausible guess gets wrong: the industry is
// `linkedin_info.industry.name`, an object with a name and not a string, and
// the LinkedIn page is `linkedin_info.public_profile_url` rather than anything
// called `linkedin_url`. HQ lives in an `addresses` ARRAY, and the postal code
// is spelled `postcode`.
//
// `founded_date` is a full date ("2010-09-01"), so the year is sliced out.
// No ticker in the schema.

interface OrganizationResult {
  name?: string | null;
  legal_name?: string | null;
  founded_date?: string | null;
  employees_amount?: number | null;
  linkedin_info?: { public_profile_url?: string | null; industry?: { name?: string | null } | null } | null;
  addresses?: { city?: string | null; state?: string | null; postcode?: string | null; country?: string | null }[] | null;
}

export const ForagerCompanyProvider: CompanyProvider = {
  id: "forager-company",
  label: "Forager",
  secretName: "FORAGER_API_KEY",
  signupUrl: "https://www.forager.ai/pricing",
  keyFormat: "accountId:apiKey",
  covers: ["name", "linkedinUrl", "industry", "city", "state", "country", "postalCode", "employeeCount", "foundedYear"],

  async enrich(domain, secret): Promise<CompanyResult> {
    const parsed = parseKey(secret);
    if (!parsed) {
      return { outcome: "unconfigured", data: null, creditsUsed: 0, detail: "FORAGER_API_KEY must be in the form accountId:apiKey" };
    }

    const { status, body } = await vendorFetch(
      `${BASE}/api/${parsed.accountId}/datastorage/organization_search/`,
      { method: "POST", headers: { "X-API-KEY": parsed.apiKey }, body: { domains: [domain] } },
    );

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Forager");
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const org = (body as { search_results?: OrganizationResult[] } | null)?.search_results?.[0];
    if (!org) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No organization matched this domain" };

    const addr = org.addresses?.[0] ?? {};
    const year = Number(String(org.founded_date ?? "").slice(0, 4));
    return {
      outcome: "hit",
      creditsUsed: 1,
      data: {
        name: org.name || org.legal_name || undefined,
        industry: org.linkedin_info?.industry?.name || undefined,
        linkedinUrl: absoluteLinkedIn(org.linkedin_info?.public_profile_url),
        employeeCount: org.employees_amount ?? undefined,
        foundedYear: Number.isInteger(year) && year > 1600 && year < 2200 ? year : undefined,
        city: addr.city || undefined,
        state: addr.state || undefined,
        country: addr.country || undefined,
        postalCode: addr.postcode || undefined,
      },
    };
  },
};
