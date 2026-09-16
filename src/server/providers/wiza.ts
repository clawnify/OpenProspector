// Wiza adapter — email and phone, via the Individual Reveal API.
//
// Contract verified against https://docs.wiza.co/api-reference/ :
//   POST /api/individual_reveals  { individual_reveal: {...}, enrichment_level }
//                                 -> { data: { id, status: "queued"|"resolving"|"finished"|"failed", is_complete } }
//   GET  /api/individual_reveals/{id}
//                                 -> { data: { ..., email, email_status, mobile_phone,
//                                              phone_number, phones[], credits } }
//   GET  /api/meta/credits        -> { credits: { email_credits, phone_credits, api_credits } }
//   Auth: Authorization: Bearer <key>
//
// Wiza is the only asynchronous vendor in the registry: the POST enqueues a
// reveal and the result arrives on a later GET. The waterfall runner is
// synchronous by design — it has to be, since it must know whether this vendor
// resolved the field before deciding whether to spend on the next one — so this
// adapter polls to completion inside `find()`.

import type {
  CompanyProvider,
  CompanyResult,
  CreditBalance,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { IDENTIFIED_PERSON, absoluteLinkedIn, ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://wiza.co/api";

/**
 * Polling schedule. Mutable so tests can exercise the real poll loop without
 * sleeping through it — nothing in the app changes these.
 *
 * How long to wait for a reveal before giving up on it:
 *
 * shortcut: a hard wall-clock cap, because the alternative — parking the reveal
 * id and resuming it on a later pass — needs durable state the runner does not
 * have. The cost of the cap is real and worth naming: Wiza has already charged
 * for a reveal that finishes after we stop waiting, so a timeout is a paid-for
 * result we drop. The reveal id goes in the attempt detail so it can be
 * retrieved by hand. If timeouts show up in the ledger, the fix is a resumable
 * pending-reveal table, not a longer wait.
 */
export const POLL = {
  maxWaitMs: 25_000,
  /** Wiza never finishes instantly; polling immediately just wastes a request. */
  firstPollMs: 1_500,
  intervalMs: 2_000,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body,
  });
}

interface RevealData {
  id?: number | string;
  status?: string;
  is_complete?: boolean;
  email?: string | null;
  email_status?: string | null;
  mobile_phone?: string | null;
  phone_number?: string | null;
  phones?: { number?: string; type?: string }[] | null;
  credits?: { api_credits?: { total?: number } } | null;
}

export const WizaProvider: EnrichProvider = {
  id: "wiza",
  label: "Wiza",
  fields: ["email", "phone"],
  secretName: "WIZA_API_KEY",
  signupUrl: "https://wiza.co/pricing",

  requirements(_field: EnrichField): InputRequirement {
    // Wiza accepts a profile URL, an email, or a name with a company/domain.
    return IDENTIFIED_PERSON;
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    const reveal = buildReveal(input);
    if (!reveal) return ineligible("Needs a profile URL, an email, or a name with a company or domain");

    const started = await call("/individual_reveals", apiKey, {
      individual_reveal: reveal,
      // "partial" finds email only, "phone" phones only. Asking for "full"
      // would resolve both and charge for both, on every field's turn — this
      // adapter is called once per field, so it buys exactly the field asked for.
      enrichment_level: field === "email" ? "partial" : "phone",
      ...(field === "email" ? { email_options: { accept_work: true, accept_personal: false } } : {}),
    });

    if (started.status < 200 || started.status >= 300) {
      const { outcome, detail } = statusOutcome(started.status, "Wiza");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const id = (started.body as { data?: RevealData } | null)?.data?.id;
    if (id === undefined || id === null) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Wiza accepted the reveal but returned no id" };
    }

    const finished = await poll(String(id), apiKey);
    if (!finished.ok) return finished.result;

    const data = finished.data;
    const creditsUsed = data.credits?.api_credits?.total ?? 0;
    if (data.status === "failed") return miss("Wiza could not resolve this person", creditsUsed);

    return field === "email" ? readEmail(data, creditsUsed) : readPhone(data, creditsUsed);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/meta/credits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    // email_credits is documented as either a number or the string "unlimited";
    // "unlimited" is not a number we can display, so it reports as unknown.
    const c = (body as { credits?: { api_credits?: unknown } } | null)?.credits?.api_credits;
    return { remaining: typeof c === "number" ? c : null };
  },
};

/** The `individual_reveal` body, or null when we hold no usable identifier. */
function buildReveal(input: LeadInput): Record<string, string> | null {
  if (input.linkedinUrl) {
    return {
      profile_url: input.linkedinUrl,
      ...(input.email ? { email: input.email } : {}),
    };
  }
  if (input.fullName && (input.domain || input.company)) {
    return {
      full_name: input.fullName,
      ...(input.domain ? { domain: input.domain } : { company: input.company as string }),
      ...(input.email ? { email: input.email } : {}),
    };
  }
  if (input.email) return { email: input.email };
  return null;
}

type PollOutcome = { ok: true; data: RevealData } | { ok: false; result: EnrichResult };

async function poll(id: string, apiKey: string): Promise<PollOutcome> {
  const deadline = Date.now() + POLL.maxWaitMs;
  await sleep(POLL.firstPollMs);

  for (;;) {
    const { status, body } = await call(`/individual_reveals/${id}`, apiKey);
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Wiza");
      return { ok: false, result: { outcome, value: null, verified: false, creditsUsed: 0, detail } };
    }
    const data = (body as { data?: RevealData } | null)?.data ?? {};
    if (data.is_complete || data.status === "finished" || data.status === "failed") {
      return { ok: true, data };
    }
    if (Date.now() + POLL.intervalMs > deadline) {
      return {
        ok: false,
        result: {
          outcome: "error",
          value: null,
          verified: false,
          // Unknown, not zero: Wiza may well charge for a reveal that finishes
          // after we stopped waiting. Claiming 0 would understate the ledger.
          creditsUsed: 0,
          detail: `Wiza reveal ${id} still running after ${POLL.maxWaitMs / 1000}s — it may complete and be charged for; retrieve it at /api/individual_reveals/${id}`,
        },
      };
    }
    await sleep(POLL.intervalMs);
  }
}

function readEmail(data: RevealData, creditsUsed: number): EnrichResult {
  if (!data.email) return miss("No email found", creditsUsed);
  // Wiza grades every address it returns. Only "valid" ends the waterfall; a
  // catch-all or risky address is kept as a fallback but does not stop the
  // search, which is the whole point of grading it.
  const verified = data.email_status === "valid";
  return {
    outcome: "hit",
    value: data.email,
    verified,
    creditsUsed,
    detail: verified ? undefined : `Wiza graded this address "${data.email_status ?? "unknown"}"`,
  };
}

function readPhone(data: RevealData, creditsUsed: number): EnrichResult {
  // Prefer an explicitly mobile number: a switchboard direct dial is a worse
  // outcome for the outreach this app feeds, and `phones[]` carries the type.
  const mobile = data.mobile_phone || data.phones?.find((p) => p.type === "mobile")?.number;
  const value = mobile || data.phone_number || data.phones?.[0]?.number;
  if (!value) return miss("No phone number found", creditsUsed);
  return { outcome: "hit", value, verified: true, creditsUsed };
}

// ── Company enrichment ──────────────────────────────────────────────
//
// Contract captured from a LIVE response on 2026-09-03 (a real key, against
// `stripe.com`), not transcribed from the docs — Wiza's reference lists the
// fields but not the envelope, and the envelope is where the mistakes are:
//   POST /api/company_enrichments   { company_domain }
//        -> { status: { code, message }, type: "company_enrichment",
//             data: { company_name, company_industry, company_size,
//                     company_size_range, company_founded, company_ticker,
//                     company_linkedin, company_locality, company_region,
//                     company_postal_code, company_country,
//                     credits: { api_credits: { company_credits, total } } } }
//   404 -> no match. Documented as billing on a match only, so that costs zero.
//   Auth: Authorization: Bearer <key>   (same key as the person adapter)
//
// The widest coverage in the registry: every CompanyRecord field, ticker and
// postal code included, which is why it leads the default company order for
// anyone holding the key.
//
// Two things the live response settled that the docs did not:
//   * `company_size` is an integer and `company_size_range` the bucketed
//     string. Reading the range into employeeCount would put "5001-10000" in an
//     INTEGER column.
//   * Wiza lower-cases the tail of its geography: "South san francisco",
//     "United states". Passed through as-is rather than title-cased here,
//     because a title-caser that has to know about "N.V." and "GmbH" is a
//     bigger liability than the casing, and LinkedIn matches an account on
//     name, website and email domain — never on the city string.

interface CompanyEnrichmentData {
  company_name?: string | null;
  company_industry?: string | null;
  company_linkedin?: string | null;
  company_ticker?: string | null;
  company_size?: number | null;
  company_founded?: number | null;
  company_locality?: string | null;
  company_region?: string | null;
  company_postal_code?: string | null;
  company_country?: string | null;
  credits?: { api_credits?: { total?: number } } | null;
}

export const WizaCompanyProvider: CompanyProvider = {
  id: "wiza-company",
  label: "Wiza",
  secretName: "WIZA_API_KEY",
  signupUrl: "https://wiza.co/pricing",
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
    const { status, body } = await call("/company_enrichments", apiKey, { company_domain: domain });

    if (status === 404) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Wiza");
      return { outcome, data: null, creditsUsed: 0, detail };
    }

    const d = (body as { data?: CompanyEnrichmentData } | null)?.data;
    if (!d) return { outcome: "miss", data: null, creditsUsed: 0, detail: "No company matched this domain" };

    return {
      outcome: "hit",
      // What Wiza says it charged, not what we assume — the same rule the
      // person adapter follows, and the reason the ledger stays true when a
      // vendor changes its price.
      creditsUsed: d.credits?.api_credits?.total ?? 2,
      data: {
        name: d.company_name || undefined,
        industry: d.company_industry || undefined,
        linkedinUrl: absoluteLinkedIn(d.company_linkedin),
        stockSymbol: d.company_ticker || undefined,
        employeeCount: typeof d.company_size === "number" ? d.company_size : undefined,
        foundedYear: d.company_founded ?? undefined,
        city: d.company_locality || undefined,
        state: d.company_region || undefined,
        country: d.company_country || undefined,
        postalCode: d.company_postal_code || undefined,
      },
    };
  },
};
