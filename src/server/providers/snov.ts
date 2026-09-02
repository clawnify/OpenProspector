// Snov.io adapter. https://snov.io/api
//
// Email only, from a first name, last name and domain. Snov has no phone
// lookup on its API, and its LinkedIn endpoint returns a profile without an
// address, so a profile URL is no shortcut here.
//
// Two things make it unlike the opaque-key vendors. It authenticates with
// OAuth client credentials, so the secret is `clientId:clientSecret` and a
// short-lived bearer token is minted from it (and cached here for its
// lifetime). And every finder is a task: POST to `/start` returns a task hash,
// and the result is fetched from `/result` once its status is `completed`.
// The task finishes in seconds, so it is polled in-band like Wiza.
//
// Billing: one credit per address returned with a `valid` or `unknown` status;
// nothing when nothing is found.

import type { CreditBalance, EnrichField, EnrichProvider, EnrichResult, InputRequirement } from "./types";
import { ineligible, miss, nameParts, pollUntil, statusOutcome, vendorFetch } from "./vendor";

const BASE = "https://api.snov.io";

interface Found {
  email?: string;
  smtp_status?: string;
  unknown_status_reason?: string;
}

interface TaskResult {
  status?: string;
  data?: { people?: string; result?: Found[] }[];
}

/** Bearer tokens by client id, so a batch does not mint one per lead. */
const tokens = new Map<string, { token: string; expiresAt: number }>();

type Auth = { ok: true; token: string } | { ok: false; result: EnrichResult };

async function authenticate(apiKey: string): Promise<Auth> {
  const sep = apiKey.indexOf(":");
  if (sep <= 0) {
    return { ok: false, result: { outcome: "unconfigured", value: null, verified: false, creditsUsed: 0, detail: "SNOV_API_KEY must be clientId:clientSecret" } };
  }
  const clientId = apiKey.slice(0, sep);
  const cached = tokens.get(clientId);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, token: cached.token };

  const form = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: apiKey.slice(sep + 1) });
  const res = await fetch(`${BASE}/v1/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form.toString(),
  });
  let body: { access_token?: string; expires_in?: number } | null = null;
  try {
    body = (await res.json()) as { access_token?: string; expires_in?: number };
  } catch {
    body = null;
  }
  if (res.status < 200 || res.status >= 300 || !body?.access_token) {
    return { ok: false, result: { outcome: "unconfigured", value: null, verified: false, creditsUsed: 0, detail: "Snov.io rejected the client credentials" } };
  }
  // A minute of slack so a token never expires mid-lookup.
  const ttl = Math.max(60, (body.expires_in ?? 3600) - 60) * 1000;
  tokens.set(clientId, { token: body.access_token, expiresAt: Date.now() + ttl });
  return { ok: true, token: body.access_token };
}

export const SnovProvider: EnrichProvider = {
  id: "snov",
  label: "Snov.io",
  fields: ["email"],
  secretName: "SNOV_API_KEY",
  signupUrl: "https://snov.io/pricing",
  keyFormat: "clientId:clientSecret",

  requirements(_field: EnrichField): InputRequirement {
    return ["fullName", "domain"];
  },

  async find(_field, input, apiKey): Promise<EnrichResult> {
    const name = nameParts(input);
    if (!name || !input.domain) return ineligible("Needs a first and last name plus a domain");

    const auth = await authenticate(apiKey);
    if (!auth.ok) return auth.result;
    const headers = { Authorization: `Bearer ${auth.token}` };

    const started = await vendorFetch(`${BASE}/v2/emails-by-domain-by-name/start`, {
      method: "POST",
      headers,
      body: { rows: [{ first_name: name.first, last_name: name.last, domain: input.domain }] },
    });
    if (started.status < 200 || started.status >= 300) {
      const { outcome, detail } = statusOutcome(started.status, "Snov.io");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    const hash = (started.body as { data?: { task_hash?: string } } | null)?.data?.task_hash;
    if (!hash) return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: "Snov.io accepted the task but returned no task_hash" };

    const finished = await pollUntil<{ status: number; body: TaskResult | null }>(async () => {
      const r = await vendorFetch(`${BASE}/v2/emails-by-domain-by-name/result?task_hash=${encodeURIComponent(hash)}`, { headers });
      const res = r.body as TaskResult | null;
      if (r.status < 200 || r.status >= 300) return { done: true, value: { status: r.status, body: res } };
      if (res?.status && res.status !== "in_progress") return { done: true, value: { status: r.status, body: res } };
      return { done: false };
    });
    if (!finished) {
      return { outcome: "error", value: null, verified: false, creditsUsed: 0, detail: `Snov.io task ${hash} still running after ${Math.round(25)}s — it may complete and be charged for; retrieve it with /v2/emails-by-domain-by-name/result` };
    }
    if (finished.status < 200 || finished.status >= 300) {
      const { outcome, detail } = statusOutcome(finished.status, "Snov.io");
      return { outcome, value: null, verified: false, creditsUsed: 0, detail };
    }
    if (finished.body?.status === "not_enough_credits") {
      return { outcome: "no_credits", value: null, verified: false, creditsUsed: 0, detail: "Out of Snov.io credits" };
    }
    return readEmail(finished.body?.data?.[0]?.result ?? []);
  },

  async credits(apiKey): Promise<CreditBalance> {
    const auth = await authenticate(apiKey);
    if (!auth.ok) return { remaining: null };
    const { status, body } = await vendorFetch(`${BASE}/v1/get-balance`, { headers: { Authorization: `Bearer ${auth.token}` } });
    if (status < 200 || status >= 300) return { remaining: null };
    const balance = Number((body as { data?: { balance?: string | number } } | null)?.data?.balance);
    return { remaining: Number.isFinite(balance) ? Math.floor(balance) : null };
  },
};

function readEmail(found: Found[]): EnrichResult {
  const valid = found.find((f) => f.email && f.smtp_status === "valid");
  if (valid?.email) return { outcome: "hit", value: valid.email, verified: true, creditsUsed: 1 };
  const unknown = found.find((f) => f.email && f.smtp_status === "unknown");
  if (unknown?.email) {
    return { outcome: "hit", value: unknown.email, verified: false, creditsUsed: 1, detail: `Snov.io could not verify this address (${unknown.unknown_status_reason ?? "unknown"})` };
  }
  return miss();
}
