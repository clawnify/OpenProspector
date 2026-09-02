// Zeliq adapter. https://docs.zeliq.com/reference/enrich-email
//
// Deferred: both enrich endpoints require a `callback_url` and deliver the
// result to it as a POST whose body is the same JSON as the endpoint's own
// 200 response. Whether that 200 already carries the result or only an
// acknowledgement is not documented, so the adapter accepts either — a body
// that already holds the value is a hit, anything else is a pause.
//
// Only successful requests consume credit, and the response reports what it
// charged (`credit_used`), so the ledger records the vendor's number rather
// than the price list's.

import type { EnrichField, EnrichProvider, EnrichResult, InputRequirement, LeadInput, CreditBalance } from "./types";
import { ineligible, miss, nameParts, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.zeliq.com/api";

interface Payload {
  credit_used?: string | number;
  contact?: {
    most_probable_email?: string | null;
    most_probable_email_status?: string | null;
    emails?: { email?: string; status?: string }[] | null;
    most_probable_phone?: string | null;
    phones?: { phone?: string }[] | null;
  } | null;
}

function call(path: string, apiKey: string, body?: unknown) {
  return vendorFetch(`${BASE}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "x-api-key": apiKey },
    body,
  });
}

export const ZeliqProvider: EnrichProvider = {
  id: "zeliq",
  label: "Zeliq",
  fields: ["email", "phone"],
  secretName: "ZELIQ_API_KEY",
  signupUrl: "https://www.zeliq.com/pricing",
  deferred: ["email", "phone"],

  requirements(field: EnrichField): InputRequirement {
    return field === "email"
      ? [
          ["linkedinUrl", "fullName"],
          ["linkedinUrl", "domain", "company"],
        ]
      : [["linkedinUrl", "email"]];
  },

  async find(field, input, apiKey, ctx): Promise<EnrichResult> {
    const req = field === "email" ? emailRequest(input) : phoneRequest(input);
    if (!req) return ineligible(field === "email" ? "Needs a profile URL, or a name with a domain or company" : "Needs a profile URL or an email");
    if (!ctx?.callbackUrl) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Zeliq answers by callback, and no callback URL was provided" };
    }

    const { status, body } = await call(req.path, apiKey, { ...req.body, callback_url: ctx.callbackUrl });
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Zeliq");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    // A result already in the response is used as-is; otherwise wait for it.
    const inBand = read(field, body as Payload | null);
    if (inBand.outcome === "hit") return inBand;
    return { outcome: "pending", value: null, verified: false, creditsUsed: 0, requestId: "" };
  },

  parseCallback(field, body): EnrichResult {
    return read(field, (body ?? null) as Payload | null);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/credits/balance", apiKey);
    if (status < 200 || status >= 300) return { remaining: null };
    const n = (body as { credit_balance?: number } | null)?.credit_balance;
    return { remaining: typeof n === "number" ? n : null };
  },
};

function emailRequest(input: LeadInput) {
  const body: Record<string, string> = {};
  if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
  const name = nameParts(input);
  if (name) {
    body.first_name = name.first;
    body.last_name = name.last;
  }
  // "Company name or company domain" — one field for both.
  if (input.domain || input.company) body.company = input.domain || (input.company as string);
  if (body.linkedin_url || (name && body.company)) return { path: "/contact/enrich/email", body };
  return null;
}

function phoneRequest(input: LeadInput) {
  const body: Record<string, string> = {};
  if (input.linkedinUrl) body.linkedin_url = input.linkedinUrl;
  if (input.email) body.email = input.email;
  return Object.keys(body).length ? { path: "/contact/enrich/phone", body } : null;
}

function creditsIn(p: Payload | null): number {
  const n = Number(p?.credit_used);
  return Number.isFinite(n) ? n : 0;
}

function read(field: EnrichField, p: Payload | null): EnrichResult {
  const contact = p?.contact;
  if (field === "email") {
    const value = contact?.most_probable_email || contact?.emails?.find((e) => e.email)?.email;
    if (!value) return miss("No email found");
    const status = contact?.most_probable_email_status ?? contact?.emails?.find((e) => e.email === value)?.status ?? "";
    const verified = status.toLowerCase() === "safe to send";
    return { outcome: "hit", value, verified, creditsUsed: creditsIn(p) || 1, detail: verified ? undefined : `Zeliq status: ${status || "unknown"}` };
  }
  const value = contact?.most_probable_phone || contact?.phones?.find((x) => x.phone)?.phone;
  if (!value) return miss("No phone found");
  return { outcome: "hit", value, verified: true, creditsUsed: creditsIn(p) || 10 };
}
