// Anymail Finder adapter — email, billed only on a verified find.
//
// Contract verified against
// https://anymailfinder.com/email-finder-api/docs/find-person-email :
//   POST /v5.1/find-email/person
//        { full_name | first_name+last_name, domain | company_name, linkedin_url }
//        -> { email, valid_email, email_status, credits_charged, mx_domain, ... }
//   Auth: Authorization: <key>
//
// **Two traps, both of which produce a silently broken adapter rather than a
// loud one:**
//
//  1. **The Authorization header carries the bare key, with no `Bearer` prefix.**
//     Every other vendor in this registry that uses Authorization uses Bearer,
//     so copying a sibling adapter here yields a 401 on every call — which this
//     runner maps to `unconfigured`, so the user is told their key is wrong
//     when it is fine.
//  2. **The result is graded, and only `valid` is billed.** `risky` means
//     verification was inconclusive, `blacklisted` means the address or domain
//     is suppressed. Reading `email` without reading `email_status` would ship
//     an unverified address as a verified one, and would also over-report cost,
//     because Anymail Finder charges only when it finds a valid address.
//
// The response reports its own price as `credits_charged`, so the ledger records
// the true cost rather than an assumed one — including the vendor's free
// 30-day re-search window, which comes back as 0.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.anymailfinder.com";

function searchBody(input: LeadInput): Record<string, string> | null {
  const b: Record<string, string> = {};
  if (input.linkedinUrl) b.linkedin_url = input.linkedinUrl;
  if (input.firstName && input.lastName) {
    b.first_name = input.firstName;
    b.last_name = input.lastName;
  } else if (input.fullName) {
    b.full_name = input.fullName;
  }
  if (input.domain) b.domain = input.domain;
  if (input.company) b.company_name = input.company;

  const hasName = Boolean(b.full_name || (b.first_name && b.last_name));
  const hasCompany = Boolean(b.domain || b.company_name);
  // Documented minimum: a LinkedIn URL on its own, or a name with a company.
  if (b.linkedin_url || (hasName && hasCompany)) return b;
  return null;
}

export const AnymailFinderProvider: EnrichProvider = {
  id: "anymailfinder",
  label: "Anymail Finder",
  fields: ["email"],
  secretName: "ANYMAILFINDER_API_KEY",
  signupUrl: "https://anymailfinder.com/settings/api",

  requirements(_field: EnrichField): InputRequirement {
    return [
      ["linkedinUrl", "fullName"],
      ["linkedinUrl", "domain", "company"],
    ];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Anymail Finder resolves email only");

    const body = searchBody(input);
    if (!body) return ineligible("Needs a profile URL, or a name with a company or domain");

    const res = await vendorFetch(`${BASE}/v5.1/find-email/person`, {
      method: "POST",
      // Bare key, no "Bearer" — see the header comment.
      headers: { Authorization: apiKey },
      body,
    });

    // 404 is this vendor's "searched, found nothing", and is not charged.
    if (res.status === 404) return miss();
    if (res.status < 200 || res.status >= 300) {
      const { outcome, detail } = statusOutcome(res.status, "Anymail Finder");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const b = res.body as { email?: string | null; email_status?: string | null; credits_charged?: number } | null;
    const charged = typeof b?.credits_charged === "number" ? b.credits_charged : 0;
    const emailStatus = String(b?.email_status ?? "").toLowerCase();

    if (!b?.email || emailStatus === "not_found") return miss("No address found", charged);
    // A suppressed address must never enter the pipeline as contactable.
    if (emailStatus === "blacklisted") return miss("Address or domain is suppressed by Anymail Finder", charged);

    return {
      outcome: "hit",
      value: b.email,
      // Only `valid` is asserted deliverable; `risky` is inconclusive and is
      // kept as an unverified fallback so a later vendor can still improve on it.
      verified: emailStatus === "valid",
      creditsUsed: charged,
      detail: emailStatus === "valid" ? undefined : `Anymail Finder email_status: ${emailStatus || "unknown"}`,
    };
  },
};
