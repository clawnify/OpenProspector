// ContactOut adapter — email and phone, via People Enrich.
//
// Contract verified against https://api.contactout.com/ :
//   POST /v1/people/enrich  { linkedin_url | email | full_name + company[]/company_domain[],
//                             include: ["work_email" | "phone"] }
//        -> { status_code, profile: { work_email[], email[], personal_email[],
//                                     work_email_status: { "<addr>": "Verified"|"Unverified" },
//                                     phone[] } }
//   Auth: token: <key>
//
// Billing, from their credit rules: one search credit when a profile is found,
// plus an email or phone credit only when that data is actually returned. The
// `include` array is therefore the cost control — asking for both fields on
// every call would bill both pools on every lead, so this adapter asks only for
// the field the waterfall is currently resolving.
//
// Note `company` and `company_domain` are arrays here, not strings.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { IDENTIFIED_PERSON, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.contactout.com/v1";

interface Profile {
  work_email?: string[] | null;
  email?: string[] | null;
  work_email_status?: Record<string, string> | null;
  phone?: string[] | null;
}

export const ContactOutProvider: EnrichProvider = {
  id: "contactout",
  label: "ContactOut",
  fields: ["email", "phone"],
  secretName: "CONTACTOUT_API_KEY",
  signupUrl: "https://contactout.com/pricing",

  requirements(_field: EnrichField): InputRequirement {
    return IDENTIFIED_PERSON;
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const body = requestBody(field, input);
    if (!body) return ineligible("Needs a profile URL, an email, or a name with a company or domain");

    const { status, body: res } = await vendorFetch(`${BASE}/people/enrich`, {
      method: "POST",
      headers: { token: apiKey },
      body,
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "ContactOut");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const profile = (res as { profile?: Profile } | null)?.profile;
    // A 200 with no profile is "searched, matched nothing" — their credit rules
    // charge the search credit only when a profile is found.
    if (!profile) return miss("No profile matched");

    return field === "email" ? readEmail(profile) : readPhone(profile);
  },
};

function requestBody(field: EnrichField, input: LeadInput): Record<string, unknown> | null {
  const include = [field === "email" ? "work_email" : "phone"];
  if (input.linkedinUrl) return { linkedin_url: input.linkedinUrl, include };
  if (input.email) return { email: input.email, include };
  if (input.fullName && (input.domain || input.company)) {
    return {
      full_name: input.fullName,
      ...(input.domain ? { company_domain: [input.domain] } : { company: [input.company] }),
      include,
    };
  }
  return null;
}

function readEmail(profile: Profile): EnrichResult {
  // Work addresses only. `email[]` mixes in personal addresses, and a personal
  // address is both a worse outreach target and a materially more sensitive
  // piece of data to be storing for someone we have never contacted.
  const value = profile.work_email?.find(Boolean);
  if (!value) return miss("Profile matched but carries no work email", 1);

  // ContactOut grades each address it returns. Only a graded-verified address
  // stops the waterfall; anything else is kept as a fallback.
  const verified = profile.work_email_status?.[value] === "Verified";
  return {
    outcome: "hit",
    value,
    verified,
    // Search credit plus the email credit their rules bill when data is returned.
    creditsUsed: 2,
    detail: verified ? undefined : "ContactOut did not mark this address verified",
  };
}

function readPhone(profile: Profile): EnrichResult {
  const value = profile.phone?.find(Boolean);
  if (!value) return miss("Profile matched but carries no phone number", 1);
  return { outcome: "hit", value, verified: true, creditsUsed: 2 };
}
