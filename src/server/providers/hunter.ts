// Hunter adapter — email, with Hunter's own SMTP verification attached.
//
// Contract verified against https://hunter.io/api-documentation/v2 :
//   GET /v2/email-finder?domain=&company=&full_name=&first_name=&last_name=
//       -> { data: { email, score, accept_all, verification: { status, date } } }
//   Auth: X-API-KEY: <key>   (also accepts ?api_key=, which we avoid — a key on
//                             the query string ends up in logs and referrers)
//
// **The trap this adapter exists to handle: Hunter returns 429 for an exhausted
// monthly quota, not for rate limiting alone.** The shared statusOutcome maps
// 429 onto `error` ("rate limited"), which for Hunter would report a user who
// has spent their whole plan as suffering a transient failure — so they would
// retry the batch, spend nothing, and never learn why coverage collapsed. It is
// mapped to `no_credits` here instead, which is what the settings screen and
// the ledger need to show.
//
// Two more Hunter-specific statuses:
//   451 claimed_email — the person exercised a data-subject request. That is a
//       permanent, lawful "no", so it is a miss, never an error to retry.
//   400 invalid_domain — includes domains with no MX records. Also a miss: the
//       waterfall should move on, not treat it as a broken vendor.
//
// Pricing: one request per call, and Hunter does not charge when no address is
// found — so creditsUsed is 0 on a miss.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
} from "./types";
import { ineligible, miss, vendorFetch } from "./vendor";

const BASE = "https://api.hunter.io";

export const HunterProvider: EnrichProvider = {
  id: "hunter",
  label: "Hunter",
  fields: ["email"],
  secretName: "HUNTER_API_KEY",
  signupUrl: "https://hunter.io/api-keys",

  requirements(_field: EnrichField): InputRequirement {
    // A name, plus something that identifies the company. Hunter also accepts a
    // `linkedin_handle`, but only on plans that enable it, so we do not rely on
    // it as the sole identifier.
    return ["fullName", ["domain", "company"]];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Hunter resolves email only");
    if (!input.fullName || !(input.domain || input.company)) {
      return ineligible("Needs a full name and a domain or company");
    }

    const q = new URLSearchParams({ full_name: input.fullName });
    // Domain is the far stronger signal; company is the documented fallback.
    if (input.domain) q.set("domain", input.domain);
    else if (input.company) q.set("company", input.company);

    const { status, body } = await vendorFetch(`${BASE}/v2/email-finder?${q}`, {
      headers: { "X-API-KEY": apiKey },
    });

    if (status < 200 || status >= 300) return errorResult(status, body);

    const data = (body as { data?: { email?: string | null; score?: number; verification?: { status?: string } } } | null)?.data;
    if (!data?.email) return miss();

    // Hunter grades every address it returns. "valid" is an SMTP-confirmed
    // mailbox; "accept_all" means the domain accepts everything, so the address
    // is a pattern guess the server cannot refute — kept as an unverified
    // fallback, never as a stop, because a catch-all is exactly the case a
    // later, stricter vendor should get the chance to disprove.
    const verification = String(data.verification?.status ?? "").toLowerCase();
    return {
      outcome: "hit",
      value: data.email,
      verified: verification === "valid",
      creditsUsed: 1,
      detail: verification === "valid" ? undefined : `Hunter verification: ${verification || "unknown"}`,
    };
  },

  // No credits(): Hunter's /v2/account response shape is not documented in its
  // public API reference, and inventing a field name here would silently render
  // every balance as "unknown" while looking implemented. Left off deliberately;
  // the settings screen already handles a provider that reports no balance.
};

function errorResult(status: number, body: unknown): EnrichResult {
  const errorId = String(
    (body as { errors?: { id?: string }[] } | null)?.errors?.[0]?.id ?? "",
  ).toLowerCase();

  // See the header comment: for Hunter a 429 is the monthly quota, not a
  // transient rate limit, and must be surfaced as such.
  if (status === 429) {
    return { outcome: "no_credits", value: null, verified: false, creditsUsed: 0, detail: "Hunter monthly search quota exhausted" };
  }
  if (status === 401) {
    return { outcome: "unconfigured", value: null, verified: false, creditsUsed: 0, detail: "Hunter rejected the API key" };
  }
  if (status === 451 || errorId === "claimed_email") {
    return miss("Hunter withheld this address at the data subject's request");
  }
  if (errorId === "invalid_domain") return miss("Hunter rejected the domain (no MX records or not resolvable)");
  if (status === 400) return ineligible(`Hunter rejected the request${errorId ? ` (${errorId})` : ""}`);
  return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `Hunter returned HTTP ${status}` };
}
