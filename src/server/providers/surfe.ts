// Surfe adapter. https://developers.surfe.com
//
// Every enrichment is accepted with a 202 and an enrichmentID, and finishes a
// couple of seconds later ("estimated time: 2 seconds"); the result is polled
// from the same id. Polled in-band like Wiza.
//
// Email and mobile are separate credit pools, each charged only on a find:
// one email credit per address, one mobile credit per valid mobile. The two
// fields are asked for separately so a phone lookup never spends an email
// credit on an address the waterfall already has.

import type { CreditBalance, EnrichField, EnrichProvider, EnrichResult, InputRequirement, LeadInput } from "./types";
import { ineligible, miss, nameParts, pollUntil, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.surfe.com";

interface Person {
  status?: string;
  emails?: { email?: string; emailType?: string; validationStatus?: string }[] | null;
  mobilePhones?: { mobilePhone?: string; confidenceScore?: number }[] | null;
}

interface Enrichment {
  enrichmentID?: string;
  status?: string;
  people?: Person[];
}

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
}

/** Surfe answers a spent quota with 403 as well as 402. */
function outcomeFor(status: number) {
  if (status === 403) return { outcome: "no_credits" as const, detail: "Out of Surfe credits or quota" };
  return statusOutcome(status, "Surfe");
}

export const SurfeProvider: EnrichProvider = {
  id: "surfe",
  label: "Surfe",
  fields: ["email", "phone"],
  secretName: "SURFE_API_KEY",
  signupUrl: "https://www.surfe.com/pricing",

  requirements(_field: EnrichField): InputRequirement {
    return [
      ["linkedinUrl", "fullName"],
      ["linkedinUrl", "domain", "company"],
    ];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const person = buildPerson(input);
    if (!person) return ineligible("Needs a profile URL, or a name with a domain or company");

    const started = await call("/v2/people/enrich", apiKey, {
      include: field === "email" ? { email: true } : { mobile: true },
      ...(field === "email" ? { enrichmentOptions: { acceptedEmailType: "professional" } } : {}),
      people: [person],
    });
    if (started.status < 200 || started.status >= 300) {
      const { outcome, detail } = outcomeFor(started.status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const id = (started.body as Enrichment | null)?.enrichmentID;
    if (!id) return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Surfe accepted the enrichment but returned no enrichmentID" };

    const finished = await pollUntil<{ status: number; body: Enrichment | null }>(async () => {
      const r = await call(`/v2/people/enrich/${encodeURIComponent(id)}`, apiKey);
      const e = r.body as Enrichment | null;
      if (r.status < 200 || r.status >= 300) return { done: true, value: { status: r.status, body: e } };
      const personStatus = e?.people?.[0]?.status;
      const done = (personStatus && personStatus !== "IN_PROGRESS") || (e?.status && e.status !== "IN_PROGRESS");
      return done ? { done: true, value: { status: r.status, body: e } } : { done: false };
    });
    if (!finished) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `Surfe enrichment ${id} still running after 25s — retrieve it at /v2/people/enrich/${id}` };
    }
    if (finished.status < 200 || finished.status >= 300) {
      const { outcome, detail } = outcomeFor(finished.status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const result = finished.body?.people?.[0] ?? {};
    if (result.status === "NOT_FOUND") return miss("Surfe holds no record for this person");
    return field === "email" ? readEmail(result) : readPhone(result);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/v1/credits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    const c = body as { totalEmail?: number; totalMobile?: number } | null;
    return {
      remaining: typeof c?.totalEmail === "number" ? c.totalEmail : null,
      verifierRemaining: typeof c?.totalMobile === "number" ? c.totalMobile : null,
    };
  },
};

function buildPerson(input: LeadInput): Record<string, string> | null {
  const person: Record<string, string> = { externalID: "lead" };
  if (input.linkedinUrl) person.linkedinUrl = input.linkedinUrl;
  const name = nameParts(input);
  if (name) {
    person.firstName = name.first;
    person.lastName = name.last;
  }
  if (input.domain) person.companyDomain = input.domain;
  if (input.company) person.companyName = input.company;
  if (person.linkedinUrl) return person;
  if (name && (person.companyDomain || person.companyName)) return person;
  return null;
}

function readEmail(p: Person): EnrichResult {
  const emails = (p.emails ?? []).filter((e) => e.email && e.emailType !== "personal");
  const pick = emails.find((e) => e.validationStatus === "VALID") ?? emails[0];
  if (!pick?.email) return miss("No email found");
  const verified = pick.validationStatus === "VALID";
  return {
    outcome: "hit",
    value: pick.email,
    verified,
    creditsUsed: 1,
    detail: verified ? undefined : `Surfe validation status: ${pick.validationStatus ?? "unknown"}`,
  };
}

function readPhone(p: Person): EnrichResult {
  const phones = (p.mobilePhones ?? []).filter((m) => m.mobilePhone);
  const pick = [...phones].sort((a, b) => (b.confidenceScore ?? 0) - (a.confidenceScore ?? 0))[0];
  if (!pick?.mobilePhone) return miss("No mobile found");
  return {
    outcome: "hit",
    value: pick.mobilePhone,
    verified: true,
    creditsUsed: 1,
    detail: typeof pick.confidenceScore === "number" ? `Surfe confidence ${pick.confidenceScore}` : undefined,
  };
}
