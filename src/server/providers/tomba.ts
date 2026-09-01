// Tomba adapter — email, with Tomba's own verification attached.
//
// Contract verified against https://docs.tomba.io/api/finder :
//   GET /v1/email-finder?domain=&company=&full_name=&first_name=&last_name=
//       -> { data: { email, score, accept_all, verification: { status, date } } }
//   Auth: TWO headers — X-Tomba-Key: <key> and X-Tomba-Secret: <secret>
//
// **Tomba answers a bad key with HTTP 400, not 401.** Verified live:
//   { "errors": { "type": "authentication_failed", "message": "Please enter a
//     valid KEY.", "code": 400 } }
// The shared statusOutcome maps 400 onto a generic `error`, so a user with a
// wrong or mistyped key would be told Tomba was broken rather than that their
// key was rejected — and the settings screen would show the vendor as healthy.
// The discriminator is `errors.type`, not the status, so that is what is read.
//
// **Tomba is also the second vendor here whose secret is not a single opaque token.**
// Like Forager (which needs an account id in the URL path), it needs a key and
// a secret together, so it is stored compound as `TOMBA_API_KEY=key:secret` and
// declares `keyFormat` so the settings screen can say so. Without that, a user
// pastes the key alone, every call 401s, and the app reports "Tomba rejected
// the API key" — technically true, uselessly so.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
} from "./types";
import { ineligible, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.tomba.io";

/** Split `key:secret`. Both halves are required; neither may be empty. */
function splitKey(apiKey: string): { key: string; secret: string } | null {
  const i = apiKey.indexOf(":");
  if (i <= 0) return null;
  const key = apiKey.slice(0, i).trim();
  const secret = apiKey.slice(i + 1).trim();
  return key && secret ? { key, secret } : null;
}

export const TombaProvider: EnrichProvider = {
  id: "tomba",
  label: "Tomba",
  fields: ["email"],
  secretName: "TOMBA_API_KEY",
  signupUrl: "https://app.tomba.io/auth/api",
  keyFormat: "key:secret (both from the Tomba API page, joined by a colon)",

  requirements(_field: EnrichField): InputRequirement {
    return ["fullName", ["domain", "company"]];
  },

  async find(field, input, apiKey): Promise<EnrichResult> {
    if (field !== "email") return ineligible("Tomba resolves email only");
    if (!input.fullName || !(input.domain || input.company)) {
      return ineligible("Needs a full name and a domain or company");
    }

    const creds = splitKey(apiKey);
    // A malformed secret is a configuration problem, not a vendor failure, so
    // it is reported as `unconfigured` without spending a call to discover it.
    if (!creds) {
      return {
        outcome: "unconfigured",
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: "TOMBA_API_KEY must be in the form key:secret",
      };
    }

    const q = new URLSearchParams({ full_name: input.fullName });
    if (input.domain) q.set("domain", input.domain);
    else if (input.company) q.set("company", input.company);

    const { status, body } = await vendorFetch(`${BASE}/v1/email-finder?${q}`, {
      headers: { "X-Tomba-Key": creds.key, "X-Tomba-Secret": creds.secret },
    });

    if (status < 200 || status >= 300) {
      // See the header comment: Tomba reports a rejected key as a 400, so the
      // body's error type decides, and the status is only the fallback.
      const errorType = String(
        (body as { errors?: { type?: string } } | null)?.errors?.type ?? "",
      ).toLowerCase();
      if (errorType === "authentication_failed") {
        return { outcome: "unconfigured", value: null, verified: false, creditsUsed: 0, detail: "Tomba rejected the API key" };
      }
      const { outcome, detail } = statusOutcome(status, "Tomba");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const data = (body as { data?: { email?: string | null; verification?: { status?: string } } } | null)?.data;
    // Tomba answers a fruitless search with a 200 and an empty data object.
    if (!data?.email) return miss();

    const verification = String(data.verification?.status ?? "").toLowerCase();
    return {
      outcome: "hit",
      value: data.email,
      verified: verification === "valid",
      // Tomba documents that a failed lookup is free, so a miss above costs
      // nothing. What is *not* documented precisely is whether "pay only for
      // valid emails" excludes a catch-all hit as well, the way Datagma's does.
      // Charging 1 here is therefore the pessimistic reading: over-reporting
      // spend is safe against the ledger, where under-reporting would let a run
      // quietly outspend its budget. Pin it against a real key before changing.
      creditsUsed: 1,
      detail: verification === "valid" ? undefined : `Tomba verification: ${verification || "unknown"}`,
    };
  },
};
