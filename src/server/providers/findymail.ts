// Findymail adapter — the reference implementation of EnrichProvider.
//
// Contract verified against https://app.findymail.com/docs/ :
//   POST /api/search/name  { name, domain }  -> { contact: { name, domain, email } }
//   POST /api/verify       { email }         -> { email, verified, provider }
//   GET  /api/credits                        -> { credits, verifier_credits }
//   Auth: Authorization: Bearer <key>
//
// Findymail's finder only returns addresses it has already validated, so a hit
// here is `verified: true` without a second /api/verify round-trip (which would
// spend a verifier credit for no new information). `verify()` exists for the
// CSV-import path, where the user brings addresses we did not source.

import type {
  CreditBalance,
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";

const BASE = "https://app.findymail.com";

async function call(
  path: string,
  apiKey: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  // Vendors return HTML on some error paths; never let a parse failure throw.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

/** Map a non-2xx status onto an outcome the runner knows how to act on. */
function outcomeForStatus(status: number): { outcome: EnrichResult["outcome"]; detail: string } {
  if (status === 401 || status === 403) return { outcome: "unconfigured", detail: "API key rejected" };
  if (status === 402) return { outcome: "no_credits", detail: "Out of Findymail credits" };
  if (status === 404) return { outcome: "miss", detail: "No record found" };
  if (status === 429) return { outcome: "error", detail: "Rate limited by Findymail" };
  return { outcome: "error", detail: `Findymail returned HTTP ${status}` };
}

export const FindymailProvider: EnrichProvider = {
  id: "findymail",
  label: "Findymail",
  fields: ["email"],
  secretName: "FINDYMAIL_API_KEY",
  signupUrl: "https://app.findymail.com/user/api-tokens",

  requirements(_field: EnrichField): InputRequirement {
    // The name endpoint needs both; `domain` also accepts a company name, but we
    // require a real domain because company-name lookups are markedly less exact.
    return ["fullName", "domain"];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") {
      return { outcome: "ineligible", value: null, verified: false, creditsUsed: 0, detail: "Findymail resolves email only" };
    }
    if (!input.fullName || !input.domain) {
      return { outcome: "ineligible", value: null, verified: false, creditsUsed: 0, detail: "Needs full name and domain" };
    }

    const { status, body } = await call("/api/search/name", apiKey, {
      method: "POST",
      body: { name: input.fullName, domain: input.domain },
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const email = (body as { contact?: { email?: string } } | null)?.contact?.email ?? null;
    if (!email) {
      // 200 with no contact is Findymail's "searched, found nothing" — no credit spent.
      return { outcome: "miss", value: null, verified: false, creditsUsed: 0, detail: "No record found" };
    }
    // Documented: a successful find consumes exactly one credit.
    return { outcome: "hit", value: email, verified: true, creditsUsed: 1 };
  },

  async verify(value, apiKey): Promise<EnrichResult> {
    const { status, body } = await call("/api/verify", apiKey, { method: "POST", body: { email: value } });
    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const verified = (body as { verified?: boolean } | null)?.verified === true;
    return {
      outcome: verified ? "hit" : "miss",
      value: verified ? value : null,
      verified,
      creditsUsed: 1,
      detail: verified ? undefined : "Address did not pass verification",
    };
  },

  async credits(apiKey): Promise<CreditBalance> {
    const { status, body } = await call("/api/credits", apiKey);
    if (status < 200 || status >= 300) return { remaining: null, verifierRemaining: null };
    const b = body as { credits?: number; verifier_credits?: number } | null;
    return {
      remaining: typeof b?.credits === "number" ? b.credits : null,
      verifierRemaining: typeof b?.verifier_credits === "number" ? b.verifier_credits : null,
    };
  },
};
