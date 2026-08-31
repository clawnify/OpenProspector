// People Data Labs adapter — email and phone, via Person Enrichment.
//
// Contract verified against https://docs.peopledatalabs.com/docs/ :
//   GET /v5/person/enrich?name=&company=&profile=&email=&min_likelihood=&required=
//        200 -> { status, likelihood, data: { work_email, mobile_phone, phone_numbers[] } }
//        404 -> { status: 404, error: { type: "not_found" } }   (no charge)
//        402 -> account maximum reached
//   Auth: X-Api-Key: <key>
//
// PDL is a database match, not a finder: it charges **per match**, whether or
// not the matched profile carries the field we came for. `required` is the
// documented lever against that — it makes a profile without the field count as
// a non-match, so a 404 costs nothing. It is set on every call, which is the
// single biggest difference between this adapter and a naive one.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { IDENTIFIED_PERSON, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.peopledatalabs.com/v5/person/enrich";

/**
 * Minimum match confidence, on PDL's 1–10 logarithmic scale.
 *
 * Their own guidance is "≥6 for use cases which rely on a high degree of data
 * accuracy". The default of 2 is roughly a 10–30% chance of being the right
 * person — which for outreach means emailing a stranger under someone else's
 * name, and paying for the privilege. 6 is the honest floor here.
 */
const MIN_LIKELIHOOD = 6;

interface PersonData {
  work_email?: string | null;
  mobile_phone?: string | null;
  phone_numbers?: string[] | null;
}

export const PeopleDataLabsProvider: EnrichProvider = {
  id: "peopledatalabs",
  label: "People Data Labs",
  fields: ["email", "phone"],
  secretName: "PEOPLEDATALABS_API_KEY",
  signupUrl: "https://www.peopledatalabs.com/pricing",

  requirements(_field: EnrichField): InputRequirement {
    return IDENTIFIED_PERSON;
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const params = queryFor(field, input);
    if (!params) return ineligible("Needs a profile URL, an email, or a name with a company or domain");

    const { status, body } = await vendorFetch(`${BASE}?${params}`, {
      headers: { "X-Api-Key": apiKey },
    });

    if (status === 404) {
      // Documented as "no profile matched", and explicitly not charged for.
      return miss("No profile matched above the likelihood threshold");
    }
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "People Data Labs");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const data = (body as { data?: PersonData } | null)?.data ?? {};
    // A 200 is a match, and a match is what PDL bills for.
    return field === "email" ? readEmail(data) : readPhone(data);
  },
};

/** Query string for one field, or null when we hold no usable identifier. */
function queryFor(field: EnrichField, input: LeadInput): string | null {
  const p = new URLSearchParams();
  if (input.linkedinUrl) p.set("profile", input.linkedinUrl);
  if (input.email) p.set("email", input.email);
  if (input.fullName) p.set("name", input.fullName);
  if (input.domain || input.company) p.set("company", input.domain || (input.company as string));

  const hasStrongId = Boolean(input.linkedinUrl || input.email);
  const hasNameAndCompany = Boolean(input.fullName && (input.domain || input.company));
  if (!hasStrongId && !hasNameAndCompany) return null;

  p.set("min_likelihood", String(MIN_LIKELIHOOD));
  // Only pay for a profile that actually carries what we came for. `required`
  // may not name a field we also passed as input — doing so silently disables
  // it — so an email-input lookup requires the phone side and vice versa.
  if (field === "email") {
    if (!input.email) p.set("required", "work_email");
  } else {
    p.set("required", "mobile_phone OR phone_numbers");
  }
  return p.toString();
}

function readEmail(data: PersonData): EnrichResult {
  // Only `work_email`. PDL's `emails[]` is documented as a *historical* list
  // carrying addresses from previous roles, with an explicit warning not to use
  // it for outreach — mailing one is how you send to an address the person lost
  // two jobs ago and take the bounce.
  const value = data.work_email;
  if (!value) return miss("Profile matched but carries no current work email", 1);
  // PDL is a dataset, not a verifier: it never asserts deliverability, so this
  // is a fallback the waterfall keeps looking past rather than a stopping hit.
  return {
    outcome: "hit",
    value,
    verified: false,
    creditsUsed: 1,
    detail: "People Data Labs does not verify deliverability",
  };
}

function readPhone(data: PersonData): EnrichResult {
  // `mobile_phone` is documented as coming from a hand-validated, >90%-accurate
  // source. `phone_numbers` is everything PDL holds — sorted mobile-first, but
  // with no confidence attached — so it only ever lands as an unverified
  // fallback the waterfall keeps looking past.
  if (data.mobile_phone) {
    return { outcome: "hit", value: data.mobile_phone, verified: true, creditsUsed: 1 };
  }
  const any = data.phone_numbers?.find(Boolean);
  if (!any) return miss("Profile matched but carries no phone number", 1);
  return {
    outcome: "hit",
    value: any,
    verified: false,
    creditsUsed: 1,
    detail: "Not from People Data Labs' validated mobile source",
  };
}
