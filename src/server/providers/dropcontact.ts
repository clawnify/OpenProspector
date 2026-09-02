// Dropcontact adapter. https://developer.dropcontact.com/
//
// Deferred: Dropcontact processes every request as a batch and answers by
// webhook (or a poll it suggests retrying every 30 seconds), so the lookup is
// started here with this lead's callback URL and the waterfall pauses until
// the result is POSTed back. Email only: its `phone` is the company
// switchboard, and asking again with the email on the row would be billed as
// a verification rather than a phone lookup.
//
// Billing is "pay on success": a credit is charged only when a verified email
// comes back, and refunded otherwise — which is why a miss costs nothing here.

import type { EnrichField, EnrichProvider, EnrichResult, InputRequirement, LeadInput, CreditBalance } from "./types";
import { ineligible, miss, nameParts, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.dropcontact.com/v1";

interface Email {
  email?: string;
  /** `<local>@<domain>` grading, e.g. `nominative@pro`, `catch_all@pro`, `generic@pro`. */
  qualification?: string;
}

interface Row {
  email?: Email[] | string;
  errors?: Record<string, boolean>;
}

/** The webhook body: an array of events, each wrapping a result batch. */
interface CallbackEvent {
  event_type?: string;
  data?: { data?: Row[]; request_id?: string };
}

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "X-Access-Token": apiKey },
    body,
  });
}

/** Dropcontact answers a spent quota with 403, not 402. */
function outcomeFor(status: number) {
  if (status === 403) return { outcome: "no_credits" as const, detail: "Out of Dropcontact credits" };
  return statusOutcome(status, "Dropcontact");
}

export const DropcontactProvider: EnrichProvider = {
  id: "dropcontact",
  label: "Dropcontact",
  fields: ["email"],
  secretName: "DROPCONTACT_API_KEY",
  signupUrl: "https://www.dropcontact.com/pricing",
  deferred: ["email"],

  requirements(_field: EnrichField): InputRequirement {
    return [
      ["linkedinUrl", "fullName"],
      ["linkedinUrl", "domain", "company"],
    ];
  },

  async find(_field, input, apiKey, ctx): Promise<EnrichResult> {
    const row = buildRow(input);
    if (!row) return ineligible("Needs a profile URL, or a name with a domain or company");
    if (!ctx?.callbackUrl) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Dropcontact answers by callback, and no callback URL was provided" };
    }

    const { status, body } = await call("/enrich/all", apiKey, {
      data: [row],
      language: "en",
      custom_callback_url: ctx.callbackUrl,
    });
    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeFor(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const res = (body ?? {}) as { request_id?: string; success?: boolean; data?: Row[]; reason?: string };
    const rowErrors = res.data?.[0]?.errors;
    if (rowErrors && Object.keys(rowErrors).length > 0) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `Dropcontact rejected the row: ${Object.keys(rowErrors).join(", ")}` };
    }
    if (!res.request_id) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: res.reason || "Dropcontact accepted the request but returned no request id" };
    }
    return { outcome: "pending", value: null, verified: false, creditsUsed: 0, requestId: res.request_id };
  },

  parseCallback(_field, body): EnrichResult {
    const events = Array.isArray(body) ? (body as CallbackEvent[]) : [body as CallbackEvent];
    const event = events.find((e) => e?.data?.data) ?? events[0];
    const rows = event?.data?.data;
    if (!Array.isArray(rows)) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Dropcontact callback carried no result rows" };
    }
    return readEmail(rows[0] ?? {});
  },

  async credits(apiKey): Promise<CreditBalance> {
    // Documented balance check: an empty row is not processed and not charged.
    const { status, body } = await call("/enrich/all", apiKey, { data: [{}] });
    if (status < 200 || status >= 300) return { remaining: null };
    const left = (body as { credits_left?: number } | null)?.credits_left;
    return { remaining: typeof left === "number" ? left : null };
  },
};

function buildRow(input: LeadInput): Record<string, string> | null {
  const row: Record<string, string> = {};
  if (input.linkedinUrl) row.linkedin = input.linkedinUrl;
  const name = nameParts(input);
  if (name) {
    row.first_name = name.first;
    row.last_name = name.last;
  }
  if (input.domain) row.website = input.domain;
  if (input.company) row.company = input.company;
  if (row.linkedin) return row;
  if (name && (row.website || row.company)) return row;
  return null;
}

/**
 * Only a nominative professional address is a hit. `generic@pro` is
 * contact@…, `random@…` is a guess, `@perso` is someone's personal mailbox —
 * none of which is what a work-email waterfall exists to find.
 */
function readEmail(row: Row): EnrichResult {
  const emails = Array.isArray(row.email) ? row.email : [];
  const nominative = emails.find((e) => e.email && e.qualification === "nominative@pro");
  if (nominative?.email) return { outcome: "hit", value: nominative.email, verified: true, creditsUsed: 1 };
  const catchAll = emails.find((e) => e.email && e.qualification === "catch_all@pro");
  if (catchAll?.email) {
    return { outcome: "hit", value: catchAll.email, verified: false, creditsUsed: 1, detail: "Dropcontact graded the domain catch-all, so the address could not be verified" };
  }
  return miss(emails.length ? "Dropcontact found only generic or personal addresses" : "No email found");
}
