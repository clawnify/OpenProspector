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
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://app.findymail.com";

function call(path: string, apiKey: string, init?: { method?: string; body?: unknown }) {
  return vendorFetch(`${BASE}${path}`, {
    method: init?.method,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: init?.body,
  });
}

/** Map a non-2xx status onto an outcome the runner knows how to act on. */
function outcomeForStatus(status: number): { outcome: EnrichResult["outcome"]; detail: string } {
  return statusOutcome(status, "Findymail");
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
    if (field !== "email") return ineligible("Findymail resolves email only");
    if (!input.fullName || !input.domain) return ineligible("Needs full name and domain");

    const { status, body } = await call("/api/search/name", apiKey, {
      method: "POST",
      body: { name: input.fullName, domain: input.domain },
    });

    if (status < 200 || status >= 300) {
      const { outcome, detail } = outcomeForStatus(status);
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const email = (body as { contact?: { email?: string } } | null)?.contact?.email ?? null;
    // 200 with no contact is Findymail's "searched, found nothing" — no credit spent.
    if (!email) return miss();
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
