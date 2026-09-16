// Apollo adapter. https://docs.apollo.io/reference/people-enrichment
//
// Email resolves in-band from people/match. Phone does not: Apollo verifies
// mobile and direct-dial numbers asynchronously and delivers them only to the
// `webhook_url` on the request, "several minutes" later — so the phone field
// is deferred, and the waterfall pauses until that webhook lands. The same
// match call is used, so a record Apollo has already revealed for this team
// comes back in-band and is used at once.
//
// Credits are charged only when data is found: one for the match, eight more
// when a mobile is delivered.

import type {
  CompanyProvider,
  CompanyResult,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";

interface PhoneNumber {
  sanitized_number?: string | null;
  raw_number?: string | null;
  type_cd?: string | null;
  status_cd?: string | null;
}

interface MatchBody {
  request_id?: string | number;
  person?: {
    email?: string | null;
    email_status?: string | null;
    contact?: { phone_numbers?: PhoneNumber[] | null } | null;
  } | null;
}

/** The webhook body: a batch wrapper around the people it enriched. */
interface PhoneWebhook {
  credits_consumed?: number;
  people?: { status?: string; phone_numbers?: PhoneNumber[] | null }[];
}
import { absoluteLinkedIn, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.apollo.io";

/**
 * Apollo documents people/match as taking its parameters on the query string of
 * a POST, not in a JSON body. Sending them as a body is the common way this
 * integration silently matches nothing: the request succeeds and Apollo simply
 * has no identifiers to match on, so every lead comes back as a miss.
 */
function matchQuery(input: LeadInput): URLSearchParams | null {
  const q = new URLSearchParams();
  if (input.linkedinUrl) q.set("linkedin_url", input.linkedinUrl);
  if (input.email) q.set("email", input.email);
  if (input.firstName && input.lastName) {
    q.set("first_name", input.firstName);
    q.set("last_name", input.lastName);
  } else if (input.fullName) {
    q.set("name", input.fullName);
  }
  if (input.domain) q.set("domain", input.domain);
  if (input.company) q.set("organization_name", input.company);

  const hasName = q.has("name") || (q.has("first_name") && q.has("last_name"));
  const hasCompany = q.has("domain") || q.has("organization_name");
  if (q.has("linkedin_url") || q.has("email") || (hasName && hasCompany)) return q;
  return null;
}

export const ApolloProvider: EnrichProvider = {
  id: "apollo",
  label: "Apollo",
  fields: ["email", "phone"],
  secretName: "APOLLO_API_KEY",
  signupUrl: "https://app.apollo.io/#/settings/integrations/api",
  deferred: ["phone"],

  requirements(_field: EnrichField): InputRequirement {
    // Apollo matches on a profile URL, an email, or a name plus a company handle.
    return [
      ["linkedinUrl", "email", "fullName"],
      ["linkedinUrl", "email", "domain", "company"],
    ];
  },

  async find(field, input, apiKey, ctx): Promise<EnrichResult> {
    const q = matchQuery(input);
    if (!q) return ineligible("Needs a profile URL, an email, or a name with a company or domain");
    if (field === "phone") {
      if (!ctx?.callbackUrl) {
        return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Apollo delivers phone numbers by webhook, and no callback URL was provided" };
      }
      q.set("reveal_phone_number", "true");
      q.set("webhook_url", ctx.callbackUrl);
    }

    const { status, body } = await vendorFetch(`${BASE}/api/v1/people/match?${q}`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Apollo");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const match = (body ?? {}) as MatchBody;
    const person = match.person;
    if (field === "phone") {
      if (!person) return miss();
      // Already revealed for this team: the numbers are in the match itself.
      const known = readPhones(person.contact?.phone_numbers ?? [], 0);
      if (known.outcome === "hit") return known;
      return { outcome: "pending", value: null, verified: false, creditsUsed: 0, requestId: match.request_id === undefined ? "" : String(match.request_id) };
    }

    // A 200 with no person, or a person Apollo holds no address for, is a
    // search that found nothing — Apollo charges no credit for it.
    if (!person?.email) return miss();

    // Apollo grades its own addresses. Only "verified" means it has confirmed
    // deliverability; "guessed" is a pattern inference, and "unavailable" /
    // "bounced" are values we must not present as contactable. Treating the
    // whole set as verified is what puts a bounced address into a send list.
    const emailStatus = String(person.email_status ?? "").toLowerCase();
    if (emailStatus === "bounced" || emailStatus === "unavailable") {
      return miss(`Apollo holds this address as ${emailStatus}`);
    }
    return {
      outcome: "hit",
      value: person.email,
      verified: emailStatus === "verified",
      creditsUsed: 1,
      detail: emailStatus === "verified" ? undefined : `Apollo email_status: ${emailStatus || "unknown"}`,
    };
  },

  parseCallback(field, body): EnrichResult {
    if (field !== "phone") return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Apollo only delivers phone numbers by webhook" };
    const hook = (body ?? {}) as PhoneWebhook;
    const person = hook.people?.[0];
    if (!person) return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Apollo webhook carried no person" };
    // The webhook's own count is documented as illustrative, so the list
    // price for a mobile is the fallback when it is absent.
    const credits = typeof hook.credits_consumed === "number" ? hook.credits_consumed : 8;
    return readPhones(person.phone_numbers ?? [], credits);
  },
};

/** A validated mobile first, then a direct dial; never a switchboard. */
function readPhones(numbers: PhoneNumber[], credits: number): EnrichResult {
  const usable = numbers.filter((n) => (n.sanitized_number || n.raw_number) && n.status_cd !== "invalid_number");
  const pick =
    usable.find((n) => n.type_cd === "mobile" && n.status_cd === "valid_number") ??
    usable.find((n) => n.type_cd === "mobile") ??
    usable.find((n) => n.type_cd === "work_direct");
  const value = pick?.sanitized_number || pick?.raw_number;
  if (!value) return miss("No mobile or direct dial delivered", 0);
  return { outcome: "hit", value, verified: true, creditsUsed: credits, detail: `Apollo type: ${pick?.type_cd}` };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract verified against https://docs.apollo.io/reference/organization-enrichment
// on 2026-09-03, and the endpoint probed live (401 on a bad key):
//   GET /api/v1/organizations/enrich?domain=
//        -> { organization: { name, website_url, linkedin_url, industry, city,
//                             state, postal_code, country,
//                             estimated_num_employees, founded_year,
//                             publicly_traded_symbol } }
//   Auth: x-api-key   (the same key as the person adapter above)
//
// One credit per organization, charged on a match. Works on Apollo's free plan,
// which is why this sits first in the default company order: it is the one
// vendor here a user can try without buying anything.
//
// Apollo's docs do not state the no-match response shape, and it cannot be
// probed without a valid key. A missing or null `organization` is therefore
// treated as a miss costing nothing — the safe reading in both directions: if
// Apollo does bill for it the ledger understates by one credit, whereas
// treating it as a hit would write an empty row into the six-month cache and
// stop every vendor behind it from ever being asked.

interface OrganizationBody {
  name?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  estimated_num_employees?: number | null;
  founded_year?: number | null;
  publicly_traded_symbol?: string | null;
}

export const ApolloCompanyProvider: CompanyProvider = {
  id: "apollo-company",
  label: "Apollo",
  secretName: "APOLLO_API_KEY",
  signupUrl: "https://www.apollo.io/pricing",
  // Every CompanyRecord field: `organizations/enrich` returns all ten,
  // ticker (`publicly_traded_symbol`) and postal code included.
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
    const { status, body } = await vendorFetch(
      `${BASE}/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
      { headers: { "x-api-key": apiKey } },
    );

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Apollo");
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const org = (body as { organization?: OrganizationBody | null } | null)?.organization;
    if (!org) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No organization matched this domain" };

    return {
      outcome: "hit",
      creditsUsed: 1,
      data: {
        name: org.name || undefined,
        industry: org.industry || undefined,
        linkedinUrl: absoluteLinkedIn(org.linkedin_url),
        stockSymbol: org.publicly_traded_symbol || undefined,
        employeeCount: org.estimated_num_employees ?? undefined,
        foundedYear: org.founded_year ?? undefined,
        city: org.city || undefined,
        state: org.state || undefined,
        country: org.country || undefined,
        postalCode: org.postal_code || undefined,
      },
    };
  },
};
