// Skrapp adapter — email, verified against the company mail server.
//
// Contract verified against https://skrapp.io/api :
//   GET /api/v2/find?firstName=&lastName=&domain=&company=
//       -> { email, accuracy, quality: { status, result } }
//   GET /api/v2/account -> plan, expiry, remaining/total credits
//   Auth: X-Access-Key: <key>
//
// Note the version split in Skrapp's own API: the finder is `/api/v2/find`
// while the verifier is `/v3/verify` — different prefixes, not a typo. Assuming
// one version across both is how this integration 404s.
//
// **Skrapp takes first and last name as separate parameters and has no
// full-name form.** A lead sourced as a single "Ada Lovelace" string must
// therefore be split before the call, and a name that cannot be split into two
// parts is `ineligible` rather than a guess — sending a bare first name returns
// a confident wrong address rather than nothing.
//
// Pricing: 1 credit per address found, misses are free (404).

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
  LeadInput,
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.skrapp.io";

/** First and last name, from either the split fields or a full-name string. */
function nameParts(input: LeadInput): { firstName: string; lastName: string } | null {
  if (input.firstName && input.lastName) {
    return { firstName: input.firstName, lastName: input.lastName };
  }
  const parts = (input.fullName ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export const SkrappProvider: EnrichProvider = {
  id: "skrapp",
  label: "Skrapp",
  fields: ["email"],
  secretName: "SKRAPP_API_KEY",
  signupUrl: "https://skrapp.io/dashboard/api",

  requirements(_field: EnrichField): InputRequirement {
    return ["fullName", ["domain", "company"]];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Skrapp resolves email only");

    const name = nameParts(input);
    if (!name) return ineligible("Needs a first and last name Skrapp can take separately");
    if (!input.domain && !input.company) return ineligible("Needs a domain or company");

    const q = new URLSearchParams({ firstName: name.firstName, lastName: name.lastName });
    if (input.domain) q.set("domain", input.domain);
    else if (input.company) q.set("company", input.company);

    const { status, body } = await vendorFetch(`${BASE}/api/v2/find?${q}`, {
      headers: { "X-Access-Key": apiKey },
    });

    // Skrapp's documented "no address found", and explicitly not charged.
    if (status === 404) return miss();
    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Skrapp");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const b = body as { email?: string | null; quality?: { status?: string; result?: string } } | null;
    if (!b?.email) return miss();

    // Skrapp reports two grades. `result: "deliverable"` is the mail server
    // accepting the address; `status: "valid"` alone can still be a catch-all,
    // so deliverability is what we treat as verified.
    const result = String(b.quality?.result ?? "").toLowerCase();
    return {
      outcome: "hit",
      value: b.email,
      verified: result === "deliverable",
      creditsUsed: 1,
      detail: result === "deliverable" ? undefined : `Skrapp quality: ${result || b.quality?.status || "unknown"}`,
    };
  },

  // No credits(): /api/v2/account is documented as returning a balance, but its
  // exact field names are not published, and a guessed path would report every
  // balance as unknown while appearing to work.
};
