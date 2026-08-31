// Forager adapter — phone and work email, via the person contacts lookup.
//
// Contract verified against Forager's own OpenAPI bundle
// (https://docs.forager.ai/_bundle/openapi.yaml):
//   POST /api/{account_id}/datastorage/person_contacts_lookup/phone_numbers/
//        { person_id | linkedin_public_identifier }        -> [ { phone_number } ]
//   POST /api/{account_id}/datastorage/person_contacts_lookup/work_emails/
//        { person_id | linkedin_public_identifier, do_contacts_enrichment }
//        -> [ { email, email_type, validation_status } ]
//   Auth: X-API-KEY: <key>
//
// Two things make this adapter unlike the others:
//
//  1. The account id is part of the URL path, so the key alone is not enough to
//     call the API. It is stored as a single compound secret, `accountId:key`,
//     matching how the platform already stores Twilio's `SID:AUTH_TOKEN` —
//     rather than adding a second secret name to the provider contract for the
//     one vendor that needs it.
//  2. It keys on the LinkedIn *public identifier* (the `/in/<slug>` part), not
//     a URL and not a name. A lead the agent sourced without a profile URL is
//     simply unreachable here, and is skipped without spending.

import type {
  EnrichField,
  EnrichProvider,
  EnrichResult,
  InputRequirement,
} from "./types";
import { ineligible, linkedinSlug, miss, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api-v2.forager.ai";

/** Split the compound secret. Returns null when it isn't in `accountId:key` form. */
function parseKey(secret: string): { accountId: string; apiKey: string } | null {
  const idx = secret.indexOf(":");
  if (idx <= 0) return null;
  const accountId = secret.slice(0, idx).trim();
  const apiKey = secret.slice(idx + 1).trim();
  if (!accountId || !apiKey || !/^\d+$/.test(accountId)) return null;
  return { accountId, apiKey };
}

export const ForagerProvider: EnrichProvider = {
  id: "forager",
  label: "Forager",
  fields: ["email", "phone"],
  secretName: "FORAGER_API_KEY",
  signupUrl: "https://www.forager.ai/pricing",
  keyFormat: "accountId:apiKey",

  requirements(_field: EnrichField): InputRequirement {
    return ["linkedinUrl"];
  },

  async find(field, input, secret): Promise<EnrichResult> {
    const parsed = parseKey(secret);
    if (!parsed) {
      // Not an "error": a malformed secret is a configuration problem, and
      // reporting it as unconfigured puts it in front of the user in settings
      // instead of burying it as a transient vendor failure.
      return {
        outcome: "unconfigured",
        value: null,
        verified: false,
        creditsUsed: 0,
        detail: "FORAGER_API_KEY must be in the form accountId:apiKey",
      };
    }

    const slug = linkedinSlug(input.linkedinUrl);
    if (!slug) return ineligible("Needs a linkedin.com/in/<slug> profile URL");

    const path = field === "email" ? "work_emails" : "phone_numbers";
    const { status, body } = await vendorFetch(
      `${BASE}/api/${parsed.accountId}/datastorage/person_contacts_lookup/${path}/`,
      {
        method: "POST",
        headers: { "X-API-KEY": parsed.apiKey },
        body: {
          linkedin_public_identifier: slug,
          // Only the email endpoint takes it: it asks Forager to go and resolve
          // an address it does not already hold, which is the whole reason to
          // call a finder rather than read a dataset.
          ...(field === "email" ? { do_contacts_enrichment: true } : {}),
        },
      },
    );

    if (status < 200 || status >= 300) {
      const { outcome, detail } = statusOutcome(status, "Forager");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }

    const rows = Array.isArray(body) ? body : [];
    return field === "email" ? readEmail(rows) : readPhone(rows);
  },
};

function readEmail(rows: unknown[]): EnrichResult {
  const emails = rows as { email?: string; email_type?: string; validation_status?: string }[];
  // Forager grades each address valid | risky | invalid | unknown. A graded
  // `invalid` is a known-bad address, not a weak signal — keeping it as the
  // waterfall's fallback would mean returning an address the vendor has already
  // told us will bounce, so it is dropped outright.
  const usable = emails.filter((e) => e.email && e.validation_status !== "invalid");
  const best = usable.find((e) => e.email_type !== "personal") ?? usable[0];
  if (!best?.email) return miss("No usable work email held for this profile");
  const verified = best.validation_status === "valid";
  return {
    outcome: "hit",
    value: best.email,
    verified,
    creditsUsed: 1,
    detail: verified ? undefined : `Forager graded this address "${best.validation_status ?? "unknown"}"`,
  };
}

function readPhone(rows: unknown[]): EnrichResult {
  const value = (rows as { phone_number?: string }[]).find((p) => p.phone_number)?.phone_number;
  if (!value) return miss("No phone number held for this profile");
  return { outcome: "hit", value, verified: true, creditsUsed: 1 };
}
