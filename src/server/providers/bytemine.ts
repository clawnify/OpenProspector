// Bytemine adapter — mobile, plus email from a LinkedIn URL.
//
// Contract verified against Bytemine's own OpenAPI 3.1 document
// (https://www.bytemine.ai/openapi.json):
//   servers: https://api.bytemine.ai/v1
//   auth:    apiKey in header, name `x-api-key`
//   POST /enrich/linkedin { linkedin_url }                      -> Contact
//   POST /enrich/mobile   { email | linkedin_url |
//                           first_name + last_name + company_domain }
//                                                               -> Contact
//   Contact: { work_email, personal_email, mobile, direct_dial, verified_at }
//   401 Unauthorized · 402 InsufficientCredits · 404 NotFound
//
// The spec is the source here for a reason: their marketing pages advertise a
// different base host (`api.bytemine.io`, which does not resolve) and a
// `Authorization: Bearer` snippet, neither of which matches the specification
// they publish. Both would have failed on the first live call.
//
// There is no name-and-domain email finder in the spec — `/enrich/email` takes
// an email and returns the rest of the record, which is the opposite direction.
// So this adapter resolves an email only from a LinkedIn URL, and that is why
// it is not in the default email waterfall.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.bytemine.ai/v1";

interface Contact {
  work_email?: string | null;
  personal_email?: string | null;
  mobile?: string | null;
  direct_dial?: string | null;
  verified_at?: string | null;
}

export const BytemineProvider: EnrichProvider = {
  id: "bytemine",
  label: "Bytemine",
  fields: ["email", "phone"],
  secretName: "BYTEMINE_API_KEY",
  signupUrl: "https://www.bytemine.ai/pricing",

  requirements(field: EnrichField): InputRequirement {
    // Email has exactly one route in: the LinkedIn endpoint. Mobile accepts any
    // of the ContactIdentifier shapes.
    return field === "email"
      ? ["linkedinUrl"]
      : [
          ["linkedinUrl", "email", "fullName"],
          ["linkedinUrl", "email", "domain"],
        ];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const req = field === "email" ? emailRequest(input) : mobileRequest(input);
    if (!req) {
      return ineligible(
        field === "email"
          ? "Needs a LinkedIn profile URL"
          : "Needs a profile URL, an email, or a name with a domain",
      );
    }

    const { status, body } = await vendorFetch(`${BASE}${req.path}`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      body: req.body,
    });

    if (status === 404) return miss("Bytemine holds no record for this person");
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Bytemine");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const contact = (body ?? {}) as Contact;
    return field === "email" ? readEmail(contact) : readPhone(contact);
  },
};

function emailRequest(input: LeadInput) {
  if (!input.linkedinUrl) return null;
  return { path: "/enrich/linkedin", body: { linkedin_url: input.linkedinUrl } };
}

function mobileRequest(input: LeadInput) {
  const body: Record<string, string> = {};
  if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
  if (input.email) body.email = input.email;
  // ContactIdentifier has no `full_name` field, only the two parts — and our
  // leads carry one sourced string. Split locally rather than in the shared
  // normalizer: the vendors that *do* accept `full_name` match better on it
  // than on a guessed split, so this loss is Bytemine's alone to take.
  const first = input.firstName ?? input.fullName?.trim().split(/\s+/)[0];
  const last = input.lastName ?? input.fullName?.trim().split(/\s+/).slice(1).join(" ");
  if (first && last) {
    body.first_name = first;
    body.last_name = last;
  }
  if (input.domain) body.company_domain = input.domain;

  const hasStrongId = Boolean(body.linkedin_url || body.email);
  const hasNameAndDomain = Boolean(body.first_name && body.last_name && body.company_domain);
  if (!hasStrongId && !hasNameAndDomain) return null;
  return { path: "/enrich/mobile", body };
}

function readEmail(contact: Contact): EnrichResult {
  // Work address only — a personal address is a worse outreach target and a
  // materially more sensitive thing to store for someone never contacted.
  const value = contact.work_email;
  if (!value) return miss("Record found but carries no work email", 1);
  // `verified_at` is the only verification signal the schema carries.
  return {
    outcome: "hit",
    value,
    verified: Boolean(contact.verified_at),
    creditsUsed: 1,
    detail: contact.verified_at ? undefined : "Bytemine returned no verification date for this record",
  };
}

function readPhone(contact: Contact): EnrichResult {
  // Mobile before direct dial: a direct dial reaches a desk, which for the
  // outreach this app feeds is the weaker of the two numbers.
  const value = contact.mobile || contact.direct_dial;
  if (!value) return miss("Record found but carries no mobile or direct dial", 1);
  return { outcome: "hit", value, verified: true, creditsUsed: 1 };
}
