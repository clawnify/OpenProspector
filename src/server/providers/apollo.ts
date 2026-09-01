// Apollo adapter — work email only, deliberately.
//
// Contract verified against https://docs.apollo.io/reference/people-enrichment :
//   POST /api/v1/people/match?first_name=&last_name=&name=&email=&domain=
//                            &organization_name=&linkedin_url=
//        -> { person: { email, email_status, ... } }
//   Auth: x-api-key: <key>
//
// **Why this adapter does not offer phone, despite Apollo selling mobiles.**
// `reveal_phone_number=true` requires a `webhook_url`, and Apollo documents the
// behaviour explicitly: the main response returns synchronously, then the phone
// numbers are delivered to that webhook asynchronously. The same is true of
// `run_waterfall_email` / `run_waterfall_phone`. This waterfall runner decides
// whether to spend the next vendor's credit based on whether this one resolved
// the field, so it cannot proceed without an answer in-band. Declaring `phone`
// here would therefore produce a provider that is always called, always
// charged, and never resolves. That is the same structural blocker recorded for
// Zeliq in planned.ts — see PLANNED for the deferred path it would need.
//
// So: `fields` is ["email"], and the request never sets a parameter that would
// require a webhook. A key that is out of phone credits changes nothing here.
//
// Pricing, per their docs: 1 credit when credit-consuming data (an email) is
// returned, and zero when the match carries none.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
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
  fields: ["email"],
  secretName: "APOLLO_API_KEY",
  signupUrl: "https://app.apollo.io/#/settings/integrations/api",

  requirements(_field: EnrichField): InputRequirement {
    // Apollo matches on a profile URL, an email, or a name plus a company handle.
    return [
      ["linkedinUrl", "email", "fullName"],
      ["linkedinUrl", "email", "domain", "company"],
    ];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Apollo phone numbers are webhook-only; email is the only in-band field");

    const q = matchQuery(input);
    if (!q) return ineligible("Needs a profile URL, an email, or a name with a company or domain");

    const { status, body } = await vendorFetch(`${BASE}/api/v1/people/match?${q}`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Apollo");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const person = (body as { person?: { email?: string | null; email_status?: string | null } } | null)?.person;
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
};
