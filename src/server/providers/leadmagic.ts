// LeadMagic adapter — email and mobile.
//
// Contract verified against https://leadmagic.io/docs/api-reference/ :
//   POST /v1/people/email-finder   { first_name, last_name | full_name, domain | company_name }
//                                  -> { email, status: "valid"|null, credits_consumed, employment_verified }
//   POST /v1/people/mobile-finder  { profile_url | work_email | personal_email }
//                                  -> { mobile_number, credits_consumed }
//   GET  /v1/credits               -> { credits }
//   Auth: X-API-Key: <key>
//
// Pricing, from the same docs: 1 credit per valid email, 5 per mobile found,
// and nothing at all for a no-result. `credits_consumed` is echoed on every
// response, so the ledger records what the vendor actually charged rather than
// what we assumed it would.
//
// The mobile endpoint takes no name/domain at all — only a profile URL or an
// email — which is why the phone waterfall is fed the email the email waterfall
// just resolved. Without that, this adapter could never run for a fresh lead.

import type {
  CreditBalance,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.leadmagic.io/v1";

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-API-Key": apiKey },
    body,
  });
}

/** Credits the vendor says it charged, defaulting to the documented price. */
function charged(body: unknown, fallback: number): number {
  const n = (body as { credits_consumed?: unknown } | null)?.credits_consumed;
  return typeof n === "number" ? n : fallback;
}

export const LeadMagicProvider: EnrichProvider = {
  id: "leadmagic",
  label: "LeadMagic",
  fields: ["email", "phone"],
  secretName: "LEADMAGIC_API_KEY",
  signupUrl: "https://leadmagic.io/pricing",

  requirements(field): InputRequirement {
    // Email takes a name plus a company handle; mobile takes neither, only a
    // profile URL or an email. Stating them separately is what stops the runner
    // spending a mobile call on a lead that has just a name and a domain.
    return field === "email"
      ? ["fullName", ["domain", "company"]]
      : [["linkedinUrl", "email"]];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    return field === "email" ? findEmail(input, apiKey) : findMobile(input, apiKey);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/credits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    const n = (body as { credits?: unknown } | null)?.credits;
    return { remaining: typeof n === "number" ? n : null };
  },
};

async function findEmail(input: LeadInput, apiKey: string): Promise<EnrichResult> {
  if (!input.fullName) return ineligible("Needs a full name");
  if (!input.domain && !input.company) return ineligible("Needs a domain or company name");

  const { status, body } = await call("/people/email-finder", apiKey, {
    ...(input.firstName && input.lastName
      ? { first_name: input.firstName, last_name: input.lastName }
      : { full_name: input.fullName }),
    // Domain wins where we have it: the docs are explicit that a company name
    // can match the wrong company, and a wrong-company hit still costs a credit.
    ...(input.domain ? { domain: input.domain } : { company_name: input.company }),
  });

  if (status < 200 || status >= 300) {
    const { outcome, detail } = statusOutcome(status, "LeadMagic");
    return { outcome, value: null, verified: false, creditsUsed: 0, detail };
  }

  const b = body as { email?: string | null; status?: string | null; message?: string } | null;
  if (b?.status !== "valid" || !b.email) {
    return miss(b?.message || "No email found for this person at this company", charged(body, 0));
  }
  // LeadMagic validates deliverability before returning `valid`, so this is a
  // verified hit and the waterfall can stop here.
  return { outcome: "hit", value: b.email, verified: true, creditsUsed: charged(body, 1) };
}

async function findMobile(input: LeadInput, apiKey: string): Promise<EnrichResult> {
  if (!input.linkedinUrl && !input.email) return ineligible("Needs a profile URL or an email");

  const { status, body } = await call("/people/mobile-finder", apiKey, {
    ...(input.linkedinUrl ? { profile_url: input.linkedinUrl } : {}),
    // Documented to improve the match rate when sent alongside the profile URL,
    // so it is sent whenever we have it, not only as a fallback identifier.
    ...(input.email ? { work_email: input.email } : {}),
  });

  if (status < 200 || status >= 300) {
    const { outcome, detail } = statusOutcome(status, "LeadMagic");
    return { outcome, value: null, verified: false, creditsUsed: 0, detail };
  }

  const b = body as { mobile_number?: string | null; message?: string } | null;
  if (!b?.mobile_number) return miss(b?.message || "No mobile number found", charged(body, 0));

  // A phone finder returning a number *is* the vendor's assertion that it holds
  // it — there is no deliverability check to run, unlike an email. Treating it
  // as unverified would make the waterfall pay every remaining phone vendor for
  // a number it already has.
  return { outcome: "hit", value: b.mobile_number, verified: true, creditsUsed: charged(body, 5) };
}
