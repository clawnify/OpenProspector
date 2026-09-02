// Kaspr adapter. https://kaspr.stoplight.io/docs/kaspr-api
//
// Synchronous, and keyed on a LinkedIn profile alone: the public identifier
// (`linkedin.com/in/<slug>`) plus the person's name. The bare slug is sent, not
// the URL — the vendor 500s on a full URL. `requiredData` makes the call
// conditional on the field being paid for, so a profile without it is not
// charged as a success.
//
// Kaspr publishes no deliverability grade for its addresses, so an email is a
// hit but never a verified one; a phone is taken as-is, like every vendor's.
// Credits are per field, one each per successful call, in separate pools.

import type { CreditBalance, EnrichField, EnrichProvider, EnrichResult, InputRequirement } from "./types";
import { ineligible, linkedinSlug, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.developers.kaspr.io";

interface Profile {
  professionalEmails?: string[] | null;
  starryProfessionalEmail?: string | null;
  phones?: string[] | null;
  starryPhone?: string | null;
}

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "accept-version": "v2.0" },
    body,
  });
}

export const KasprProvider: EnrichProvider = {
  id: "kaspr",
  label: "Kaspr",
  fields: ["email", "phone"],
  secretName: "KASPR_API_KEY",
  signupUrl: "https://www.kaspr.io/pricing",

  requirements(_field: EnrichField): InputRequirement {
    return ["linkedinUrl", "fullName"];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const slug = linkedinSlug(input.linkedinUrl);
    if (!slug || !input.fullName) return ineligible("Needs a LinkedIn profile URL and the person's name");

    const want = field === "email" ? "workEmail" : "phone";
    const { status, body } = await call("/profile/linkedin", apiKey, {
      id: slug,
      name: input.fullName,
      dataToGet: [want],
      requiredData: [want],
    });
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Kaspr");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const profile = (body as { profile?: Profile } | null)?.profile;
    if (!profile) return miss("Kaspr holds no record for this profile");
    return field === "email" ? readEmail(profile) : readPhone(profile);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/keys/remainingCredits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    const c = body as { workEmailCredits?: number; phoneCredits?: number } | null;
    // -1 is Kaspr's "unlimited".
    const n = (v: number | undefined) => (typeof v === "number" && v >= 0 ? v : null);
    return { remaining: n(c?.workEmailCredits), verifierRemaining: n(c?.phoneCredits) };
  },
};

function readEmail(p: Profile): EnrichResult {
  const value = p.starryProfessionalEmail || p.professionalEmails?.find(Boolean);
  if (!value) return miss("No work email on the profile");
  return { outcome: "hit", value, verified: false, creditsUsed: 1, detail: "Kaspr does not grade deliverability" };
}

function readPhone(p: Profile): EnrichResult {
  const raw = p.starryPhone || p.phones?.find(Boolean);
  if (!raw) return miss("No phone on the profile");
  // Kaspr returns numbers with spaces ("+1 202 007 0123"); every other vendor
  // hands back a compact form, so match it.
  return { outcome: "hit", value: raw.replace(/\s+/g, ""), verified: true, creditsUsed: 1 };
}
