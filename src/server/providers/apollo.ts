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
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

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
